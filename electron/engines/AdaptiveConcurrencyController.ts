/**
 * Controlador de concurrencia adaptativa (ajusta slots según throughput y errores).
 *
 * Ajusta dinámicamente los slots de descarga simultánea basándose en:
 * - Throughput reciente (ventana deslizante)
 * - Tasa de errores reciente (errores permanentes + reintentos transient)
 * - Response times por host
 *
 * Escala hacia arriba cuando el rendimiento es estable y los errores bajos;
 * escala hacia abajo cuando los errores/timeouts aumentan.
 *
 * El techo de concurrencia siempre es el valor configurado por el usuario
 * (maxParallelDownloads); el controlador solo opera dentro del rango [1, techo].
 *
 * @module AdaptiveConcurrencyController
 */

import { logger } from '../utils';
import config from '../config';

const log = logger.child('AdaptiveConcurrency');

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Tipo de evento registrado en la ventana deslizante. */
interface ConcurrencyEvent {
  type: 'success' | 'error' | 'transient_retry';
  host: string;
  timestamp: number;
  /** Bytes descargados (solo para type='success'). */
  bytes?: number;
  /** Duración de la descarga en ms (solo para type='success'). */
  durationMs?: number;
}

/** Muestra de throughput agregado (bytes/s). */
interface ThroughputSample {
  timestamp: number;
  bps: number;
}

/** Configuración del controlador adaptativo. */
export interface AdaptiveConcurrencyConfig {
  /** Habilita la concurrencia adaptativa. */
  enabled: boolean;
  /** Intervalo de evaluación en ms (cada cuánto se re-evalúa la concurrencia). */
  evaluationIntervalMs: number;
  /** Cooldown mínimo entre ajustes (ms). Evita oscilaciones rápidas. */
  cooldownMs: number;
  /** Tamaño de la ventana deslizante de eventos (ms). */
  windowSizeMs: number;
  /** Tasa de error máxima para permitir scale-up (0-1). */
  scaleUpErrorRateMax: number;
  /** Tasa de error mínima para forzar scale-down (0-1). */
  scaleDownErrorRateMin: number;
  /** Throughput mínimo (bytes/s) requerido para scale-up. */
  scaleUpMinThroughputBps: number;
  /** Porcentaje de caída de throughput vs pico para triggear scale-down (0-1). */
  throughputDropThreshold: number;
  /** Cantidad mínima de descargas exitosas en la ventana para permitir scale-up. */
  scaleUpMinSamples: number;
  /** Cantidad mínima de reintentos transient en la ventana para triggear scale-down. */
  scaleDownTransientRetryThreshold: number;
}

/** Callback invocado cuando el controlador ajusta la concurrencia. */
export interface AdjustmentCallback {
  (_concurrent: number, _perHost: number): void;
}

/** Snapshot del estado actual del controlador (para depuración/UI). */
export interface AdaptiveConcurrencyStatus {
  enabled: boolean;
  started: boolean;
  currentConcurrent: number;
  currentPerHost: number;
  userMaxConcurrent: number;
  peakThroughputBps: number;
  recentErrorRate: number;
  recentSuccessCount: number;
  recentErrorCount: number;
  recentTransientCount: number;
  recentAvgThroughputBps: number;
  lastAdjustmentTime: number;
  lastAdjustmentDirection: 'up' | 'down' | 'none';
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: AdaptiveConcurrencyConfig = {
  enabled: false,
  evaluationIntervalMs: 15_000,
  cooldownMs: 30_000,
  windowSizeMs: 90_000,
  scaleUpErrorRateMax: 0.05,
  scaleDownErrorRateMin: 0.2,
  scaleUpMinThroughputBps: 256 * 1024, // 256 KB/s
  throughputDropThreshold: 0.4,
  scaleUpMinSamples: 2,
  scaleDownTransientRetryThreshold: 4,
};

// ---------------------------------------------------------------------------
// Clase principal
// ---------------------------------------------------------------------------

export class AdaptiveConcurrencyController {
  private _config: AdaptiveConcurrencyConfig;

  /** Ventana deslizante de eventos (éxitos, errores, retries). */
  private _events: ConcurrencyEvent[] = [];

  /** Muestras de throughput agregado. */
  private _throughputSamples: ThroughputSample[] = [];

  /** Throughput pico observado (bytes/s). Se resetea tras scale-down. */
  private _peakThroughputBps = 0;

  /** Concurrencia global actual (ajustada dinámicamente). */
  private _currentConcurrent: number;

  /** Concurrencia por host actual (ajustada dinámicamente). */
  private _currentPerHost: number;

  /** Techo de concurrencia global fijado por el usuario. */
  private _userMaxConcurrent: number;

  /** Techo de concurrencia por host fijado por config. */
  private _configMaxPerHost: number;

  /** Timestamp del último ajuste. */
  private _lastAdjustmentTime = 0;

  /** Dirección del último ajuste. */
  private _lastAdjustmentDirection: 'up' | 'down' | 'none' = 'none';

  /** Timer de evaluación periódica. */
  private _evaluationTimer: ReturnType<typeof setInterval> | null = null;

  /** Callback al ajustar concurrencia. */
  private _onAdjust: AdjustmentCallback;

  /** Indica si el controlador está activo. */
  private _started = false;

  constructor(onAdjust: AdjustmentCallback, overrides?: Partial<AdaptiveConcurrencyConfig>) {
    // Leer configuración desde config.downloads.chunked.adaptiveConcurrencyConfig
    const chunkedCfg = (config.downloads as Record<string, unknown>)?.chunked as
      | Record<string, unknown>
      | undefined;
    const fileCfg = (chunkedCfg?.adaptiveConcurrencyConfig ??
      {}) as Partial<AdaptiveConcurrencyConfig>;

    this._config = { ...DEFAULTS, ...fileCfg, ...(overrides ?? {}) };

    // El techo inicial es maxConcurrent del scheduler (user setting o default)
    const downloadsCfg = config.downloads as {
      maxConcurrent?: number;
      maxConcurrentPerHost?: number;
    };
    this._userMaxConcurrent = downloadsCfg?.maxConcurrent ?? 3;
    this._configMaxPerHost = downloadsCfg?.maxConcurrentPerHost ?? 2;

    // Empezar conservador: 1 descarga simultánea
    this._currentConcurrent = Math.min(1, this._userMaxConcurrent);
    this._currentPerHost = Math.min(1, this._configMaxPerHost);

    this._onAdjust = onAdjust;
  }

  // -----------------------------------------------------------------------
  // Propiedades públicas
  // -----------------------------------------------------------------------

  get enabled(): boolean {
    return this._config.enabled;
  }

  get currentConcurrent(): number {
    return this._currentConcurrent;
  }

  get currentPerHost(): number {
    return this._currentPerHost;
  }

  get started(): boolean {
    return this._started;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Inicia el controlador adaptativo. Aplica los valores iniciales y comienza
   * la evaluación periódica. Idempotente.
   */
  start(): void {
    if (!this._config.enabled || this._started) return;
    this._started = true;
    this._lastAdjustmentTime = Date.now();
    this._lastAdjustmentDirection = 'none';

    // Aplicar valores iniciales
    this._onAdjust(this._currentConcurrent, this._currentPerHost);

    this._evaluationTimer = setInterval(() => {
      try {
        this._evaluate();
      } catch (err) {
        log.error('Error en evaluación de concurrencia adaptativa:', err);
      }
    }, this._config.evaluationIntervalMs);

    log.info(
      `Concurrencia adaptativa iniciada: concurrent=${this._currentConcurrent}/${this._userMaxConcurrent}, ` +
        `perHost=${this._currentPerHost}/${this._configMaxPerHost}, ` +
        `evaluación cada ${this._config.evaluationIntervalMs}ms, ` +
        `cooldown ${this._config.cooldownMs}ms, ventana ${this._config.windowSizeMs}ms`
    );
  }

  /**
   * Detiene el controlador adaptativo y limpia el timer. Idempotente.
   */
  stop(): void {
    if (this._evaluationTimer) {
      clearInterval(this._evaluationTimer);
      this._evaluationTimer = null;
    }
    if (this._started) {
      log.info(
        `Concurrencia adaptativa detenida. Último estado: ` +
          `concurrent=${this._currentConcurrent}, perHost=${this._currentPerHost}`
      );
    }
    this._started = false;
  }

  /**
   * Actualiza el techo de concurrencia cuando el usuario cambia settings.
   * Si la concurrencia actual excede el nuevo techo, se reduce inmediatamente.
   */
  updateUserMaxConcurrent(newMax: number): void {
    const clamped = Math.min(3, Math.max(1, newMax));
    this._userMaxConcurrent = clamped;

    if (this._currentConcurrent > clamped) {
      this._currentConcurrent = clamped;
      this._currentPerHost = Math.min(this._currentPerHost, clamped);
      if (this._started) {
        this._onAdjust(this._currentConcurrent, this._currentPerHost);
        log.info(
          `Techo de usuario actualizado a ${clamped}; concurrencia reducida a ${this._currentConcurrent}`
        );
      }
    } else {
      log.info(
        `Techo de usuario actualizado a ${clamped}; concurrencia actual ${this._currentConcurrent} no excede`
      );
    }
  }

  // -----------------------------------------------------------------------
  // Registro de eventos (invocado por DownloadEngine)
  // -----------------------------------------------------------------------

  /**
   * Registra la finalización exitosa de una descarga.
   */
  recordSuccess(host: string, bytesDownloaded: number, durationMs: number): void {
    if (!this._config.enabled) return;
    this._events.push({
      type: 'success',
      host,
      timestamp: Date.now(),
      bytes: bytesDownloaded,
      durationMs,
    });
  }

  /**
   * Registra un error (permanente o transient).
   */
  recordError(host: string, isTransient: boolean): void {
    if (!this._config.enabled) return;
    this._events.push({
      type: isTransient ? 'transient_retry' : 'error',
      host,
      timestamp: Date.now(),
    });
  }

  /**
   * Registra una muestra de throughput agregado (sum de todas las descargas activas).
   * Llamado periódicamente desde el progress handler.
   */
  recordThroughputSample(totalBps: number): void {
    if (!this._config.enabled || totalBps <= 0) return;
    this._throughputSamples.push({ timestamp: Date.now(), bps: totalBps });
    if (totalBps > this._peakThroughputBps) {
      this._peakThroughputBps = totalBps;
    }
  }

  // -----------------------------------------------------------------------
  // Evaluación principal
  // -----------------------------------------------------------------------

  /** Evalúa la ventana deslizante y decide si ajustar la concurrencia. */
  private _evaluate(): void {
    const now = Date.now();
    const windowStart = now - this._config.windowSizeMs;

    // Podar eventos antiguos
    this._pruneOldEvents(windowStart);

    // Clasificar eventos recientes
    const recentEvents = this._events;
    const successes = recentEvents.filter(e => e.type === 'success');
    const errors = recentEvents.filter(e => e.type === 'error');
    const transientRetries = recentEvents.filter(e => e.type === 'transient_retry');

    const totalDecisive = successes.length + errors.length;
    const totalErrors = errors.length + transientRetries.length;
    const errorRate =
      totalDecisive + transientRetries.length > 0
        ? totalErrors / (totalDecisive + transientRetries.length)
        : 0;

    // Throughput promedio en la ventana
    const recentSamples = this._throughputSamples;
    const avgThroughput =
      recentSamples.length > 0
        ? recentSamples.reduce((sum, s) => sum + s.bps, 0) / recentSamples.length
        : 0;

    // Verificar cooldown
    const timeSinceLastAdjustment = now - this._lastAdjustmentTime;
    if (timeSinceLastAdjustment < this._config.cooldownMs) {
      return;
    }

    // Evaluar scale-DOWN primero (seguridad tiene prioridad)
    if (this._shouldScaleDown(errorRate, avgThroughput, transientRetries.length)) {
      this._scaleDown(errorRate, avgThroughput);
      return;
    }

    // Evaluar scale-UP
    if (this._shouldScaleUp(errorRate, avgThroughput, successes.length)) {
      this._scaleUp(errorRate, avgThroughput);
    }
  }

  private _shouldScaleDown(
    errorRate: number,
    avgThroughput: number,
    transientCount: number
  ): boolean {
    // Ya estamos en el mínimo
    if (this._currentConcurrent <= 1) return false;

    // Alta tasa de errores → scale down
    if (errorRate >= this._config.scaleDownErrorRateMin) return true;

    // Muchos reintentos transient en la ventana → scale down
    if (transientCount >= this._config.scaleDownTransientRetryThreshold) return true;

    // Throughput cayó significativamente desde el pico
    if (this._peakThroughputBps > 0 && avgThroughput > 0 && this._currentConcurrent > 1) {
      const dropRatio = avgThroughput / this._peakThroughputBps;
      if (dropRatio < this._config.throughputDropThreshold) return true;
    }

    return false;
  }

  private _shouldScaleUp(errorRate: number, avgThroughput: number, successCount: number): boolean {
    // Ya estamos en el techo
    if (this._currentConcurrent >= this._userMaxConcurrent) return false;

    // Necesitamos un mínimo de muestras para decidir
    if (successCount < this._config.scaleUpMinSamples) return false;

    // La tasa de error debe ser baja
    if (errorRate >= this._config.scaleUpErrorRateMax) return false;

    // El throughput debe ser aceptable
    if (avgThroughput < this._config.scaleUpMinThroughputBps) return false;

    return true;
  }

  private _scaleDown(errorRate: number, avgThroughput: number): void {
    const prev = this._currentConcurrent;
    this._currentConcurrent = Math.max(1, this._currentConcurrent - 1);
    this._currentPerHost = Math.min(this._currentPerHost, this._currentConcurrent);
    this._lastAdjustmentTime = Date.now();
    this._lastAdjustmentDirection = 'down';

    // Resetear pico tras scale-down para permitir re-evaluación
    this._peakThroughputBps = avgThroughput;

    const throughputMBs = (avgThroughput / (1024 * 1024)).toFixed(2);
    log.info(
      `Concurrencia reducida: ${prev} → ${this._currentConcurrent} ` +
        `(perHost: ${this._currentPerHost}, errorRate: ${(errorRate * 100).toFixed(1)}%, ` +
        `throughput: ${throughputMBs} MB/s)`
    );

    this._onAdjust(this._currentConcurrent, this._currentPerHost);
  }

  private _scaleUp(errorRate: number, avgThroughput: number): void {
    const prev = this._currentConcurrent;
    this._currentConcurrent = Math.min(this._userMaxConcurrent, this._currentConcurrent + 1);
    // Per-host puede escalar también, pero siempre limitado por el config
    this._currentPerHost = Math.min(this._configMaxPerHost, this._currentConcurrent);
    this._lastAdjustmentTime = Date.now();
    this._lastAdjustmentDirection = 'up';

    const throughputMBs = (avgThroughput / (1024 * 1024)).toFixed(2);
    log.info(
      `Concurrencia aumentada: ${prev} → ${this._currentConcurrent} ` +
        `(perHost: ${this._currentPerHost}, errorRate: ${(errorRate * 100).toFixed(1)}%, ` +
        `throughput: ${throughputMBs} MB/s)`
    );

    this._onAdjust(this._currentConcurrent, this._currentPerHost);
  }

  /** Elimina eventos fuera de la ventana deslizante. */
  private _pruneOldEvents(windowStart: number): void {
    this._events = this._events.filter(e => e.timestamp >= windowStart);
    this._throughputSamples = this._throughputSamples.filter(s => s.timestamp >= windowStart);
  }

  // -----------------------------------------------------------------------
  // Consultas (para depuración, logs, IPC)
  // -----------------------------------------------------------------------

  /** Devuelve un snapshot del estado actual del controlador. */
  getStatus(): AdaptiveConcurrencyStatus {
    const now = Date.now();
    const windowStart = now - this._config.windowSizeMs;

    const recentEvents = this._events.filter(e => e.timestamp >= windowStart);
    const successes = recentEvents.filter(e => e.type === 'success');
    const errors = recentEvents.filter(e => e.type === 'error');
    const transients = recentEvents.filter(e => e.type === 'transient_retry');
    const totalForRate = successes.length + errors.length + transients.length;

    const recentSamples = this._throughputSamples.filter(s => s.timestamp >= windowStart);
    const avgThroughput =
      recentSamples.length > 0
        ? recentSamples.reduce((sum, s) => sum + s.bps, 0) / recentSamples.length
        : 0;

    return {
      enabled: this._config.enabled,
      started: this._started,
      currentConcurrent: this._currentConcurrent,
      currentPerHost: this._currentPerHost,
      userMaxConcurrent: this._userMaxConcurrent,
      peakThroughputBps: this._peakThroughputBps,
      recentErrorRate: totalForRate > 0 ? (errors.length + transients.length) / totalForRate : 0,
      recentSuccessCount: successes.length,
      recentErrorCount: errors.length,
      recentTransientCount: transients.length,
      recentAvgThroughputBps: avgThroughput,
      lastAdjustmentTime: this._lastAdjustmentTime,
      lastAdjustmentDirection: this._lastAdjustmentDirection,
    };
  }

  /** Resetea todos los datos del controlador (mantiene configuración). */
  reset(): void {
    this._events = [];
    this._throughputSamples = [];
    this._peakThroughputBps = 0;
    this._lastAdjustmentTime = Date.now();
    this._lastAdjustmentDirection = 'none';
  }
}
