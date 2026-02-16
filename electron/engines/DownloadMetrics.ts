/**
 * Métricas agregadas del motor de descargas.
 *
 * Recopila estadísticas en memoria durante la sesión:
 * - Velocidad promedio por host
 * - Tasa de errores (global y por host)
 * - Distribución de tiempos de descarga
 * - Contadores de descargas completadas/fallidas
 *
 * Diseñado para ser ligero: no persiste en DB, solo vive en memoria.
 * Se puede consultar bajo demanda (debug panel, logs periódicos, IPC).
 *
 * @module DownloadMetrics
 */

import { logger } from '../utils';

const log = logger.child('DownloadMetrics');

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface HostMetrics {
  /** Cantidad de descargas completadas para este host */
  completedCount: number;
  /** Cantidad de errores (transient retries incluidos) */
  errorCount: number;
  /** Bytes totales descargados desde este host */
  totalBytes: number;
  /** Tiempo total de transferencia activa (ms) */
  totalTransferMs: number;
  /** Velocidad promedio (bytes/s) derivada de totalBytes/totalTransferMs */
  avgSpeedBps: number;
  /** Tiempo mínimo de descarga registrado (ms) */
  minDurationMs: number;
  /** Tiempo máximo de descarga registrado (ms) */
  maxDurationMs: number;
}

export interface GlobalMetrics {
  /** Descargas totales iniciadas en esta sesión */
  totalStarted: number;
  /** Descargas completadas */
  totalCompleted: number;
  /** Descargas fallidas (estado final FAILED) */
  totalFailed: number;
  /** Total de reintentos transient (429, 503, timeout, etc.) */
  totalTransientRetries: number;
  /** Bytes totales descargados en la sesión */
  totalBytesDownloaded: number;
  /** Distribución de duración de descargas completadas (buckets en ms) */
  durationBuckets: Record<string, number>;
  /** Métricas por host */
  hosts: Record<string, HostMetrics>;
  /** Descargas actualmente en curso (gauge). */
  activeDownloadsCount: number;
}

/** Percentiles de latencia (duración de descargas completadas, ms). */
export interface LatencyPercentiles {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Máximo de duraciones recientes para calcular percentiles. */
const MAX_RECENT_DURATIONS = 200;

/** Buckets de duración para el histograma (en ms) */
const DURATION_BUCKETS = [
  { label: '<5s', max: 5_000 },
  { label: '5-30s', max: 30_000 },
  { label: '30s-2m', max: 120_000 },
  { label: '2-10m', max: 600_000 },
  { label: '10-30m', max: 1_800_000 },
  { label: '>30m', max: Infinity },
] as const;

// ---------------------------------------------------------------------------
// Tracking de descargas activas
// ---------------------------------------------------------------------------

interface ActiveTracker {
  host: string | null;
  startedAt: number;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Clase principal
// ---------------------------------------------------------------------------

class DownloadMetrics {
  private _global: GlobalMetrics;
  /** Descargas actualmente en curso: downloadId → tracker */
  private _active = new Map<number, ActiveTracker>();
  /** Últimas duraciones (ms) para percentiles p50/p95/p99 */
  private _recentDurations: number[] = [];

  constructor() {
    this._global = this._emptyGlobal();
  }

  // -----------------------------------------------------------------------
  // Eventos de ciclo de vida
  // -----------------------------------------------------------------------

  /**
   * Registra el inicio de una descarga.
   */
  recordStart(downloadId: number, host: string | null): void {
    this._global.totalStarted++;
    this._active.set(downloadId, {
      host,
      startedAt: Date.now(),
      bytes: 0,
    });
  }

  /**
   * Registra bytes recibidos durante la descarga (llamar periódicamente, no por cada chunk de datos).
   */
  recordBytes(downloadId: number, deltaBytes: number): void {
    const tracker = this._active.get(downloadId);
    if (tracker) {
      tracker.bytes += deltaBytes;
    }
    this._global.totalBytesDownloaded += deltaBytes;
  }

  /**
   * Registra la finalización exitosa de una descarga.
   */
  recordCompleted(downloadId: number, totalBytes?: number): void {
    const tracker = this._active.get(downloadId);
    const durationMs = tracker ? Date.now() - tracker.startedAt : 0;
    const host = tracker?.host ?? 'unknown';
    const bytes = totalBytes ?? tracker?.bytes ?? 0;

    this._global.totalCompleted++;
    this._addDurationBucket(durationMs);
    if (durationMs > 0) {
      this._recentDurations.push(durationMs);
      if (this._recentDurations.length > MAX_RECENT_DURATIONS) {
        this._recentDurations.splice(0, this._recentDurations.length - MAX_RECENT_DURATIONS);
      }
    }

    // Métricas por host
    const hm = this._getOrCreateHost(host);
    hm.completedCount++;
    hm.totalBytes += bytes;
    hm.totalTransferMs += durationMs;
    hm.avgSpeedBps = hm.totalTransferMs > 0 ? (hm.totalBytes / hm.totalTransferMs) * 1000 : 0;
    if (durationMs > 0) {
      hm.minDurationMs = Math.min(hm.minDurationMs, durationMs);
      hm.maxDurationMs = Math.max(hm.maxDurationMs, durationMs);
    }

    this._active.delete(downloadId);
  }

  /**
   * Registra una descarga fallida (estado final FAILED).
   */
  recordFailed(downloadId: number): void {
    const tracker = this._active.get(downloadId);
    const host = tracker?.host ?? 'unknown';

    this._global.totalFailed++;
    const hm = this._getOrCreateHost(host);
    hm.errorCount++;

    this._active.delete(downloadId);
  }

  /**
   * Registra un reintento transient (429, 503, timeout, error de red temporal).
   */
  recordTransientRetry(host: string | null): void {
    this._global.totalTransientRetries++;
    const hm = this._getOrCreateHost(host ?? 'unknown');
    hm.errorCount++;
  }

  /**
   * Limpia el tracker cuando una descarga es cancelada o pausada.
   */
  recordCancelledOrPaused(downloadId: number): void {
    this._active.delete(downloadId);
  }

  // -----------------------------------------------------------------------
  // Consultas
  // -----------------------------------------------------------------------

  /**
   * Devuelve snapshot de métricas globales (copia defensiva). Incluye activeDownloadsCount.
   */
  getGlobalMetrics(): GlobalMetrics {
    const out = structuredClone(this._global);
    out.activeDownloadsCount = this._active.size;
    return out;
  }

  /**
   * Percentiles de latencia (p50/p95/p99) en ms a partir de las últimas duraciones.
   */
  getLatencyPercentiles(): LatencyPercentiles {
    if (this._recentDurations.length === 0) {
      return { p50Ms: 0, p95Ms: 0, p99Ms: 0 };
    }
    const sorted = [...this._recentDurations].sort((a, b) => a - b);
    const n = sorted.length;
    const idx = (p: number) => Math.min(n - 1, Math.floor(n * p));
    return {
      p50Ms: sorted[idx(0.5)] ?? 0,
      p95Ms: sorted[idx(0.95)] ?? 0,
      p99Ms: sorted[idx(0.99)] ?? 0,
    };
  }

  /**
   * Devuelve métricas de un host específico, o null si no hay datos.
   */
  getHostMetrics(host: string): HostMetrics | null {
    const hm = this._global.hosts[host];
    return hm ? structuredClone(hm) : null;
  }

  /**
   * Devuelve tasa de error global: errores / (completadas + fallidas).
   */
  getErrorRate(): number {
    const total = this._global.totalCompleted + this._global.totalFailed;
    return total > 0 ? this._global.totalFailed / total : 0;
  }

  /**
   * Devuelve tasa de error de un host específico.
   */
  getHostErrorRate(host: string): number {
    const hm = this._global.hosts[host];
    if (!hm) return 0;
    const total = hm.completedCount + hm.errorCount;
    return total > 0 ? hm.errorCount / total : 0;
  }

  /**
   * Log periódico de métricas resumidas (invocar desde un intervalo).
   */
  logSummary(): void {
    const g = this._global;
    if (g.totalStarted === 0) return;

    const errorRate = (this.getErrorRate() * 100).toFixed(1);
    const mbDownloaded = (g.totalBytesDownloaded / (1024 * 1024)).toFixed(1);

    log.info(
      `[Métricas] Sesión: ${g.totalStarted} iniciadas, ${g.totalCompleted} completadas, ` +
        `${g.totalFailed} fallidas (${errorRate}% error rate), ${mbDownloaded} MB descargados, ` +
        `${g.totalTransientRetries} reintentos transient`
    );

    // Top hosts por velocidad
    const hostEntries = Object.entries(g.hosts)
      .filter(([, h]) => h.completedCount > 0)
      .sort(([, a], [, b]) => b.avgSpeedBps - a.avgSpeedBps)
      .slice(0, 5);

    for (const [host, hm] of hostEntries) {
      const speedMBs = (hm.avgSpeedBps / (1024 * 1024)).toFixed(2);
      log.info(
        `  Host ${host}: ${speedMBs} MB/s promedio, ${hm.completedCount} completadas, ${hm.errorCount} errores`
      );
    }
  }

  /**
   * Resetea todas las métricas.
   */
  reset(): void {
    this._global = this._emptyGlobal();
    this._active.clear();
    this._recentDurations = [];
  }

  // -----------------------------------------------------------------------
  // Helpers internos
  // -----------------------------------------------------------------------

  private _emptyGlobal(): GlobalMetrics {
    const buckets: Record<string, number> = {};
    for (const b of DURATION_BUCKETS) {
      buckets[b.label] = 0;
    }
    return {
      totalStarted: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalTransientRetries: 0,
      totalBytesDownloaded: 0,
      durationBuckets: buckets,
      hosts: {},
      activeDownloadsCount: 0,
    };
  }

  private _getOrCreateHost(host: string): HostMetrics {
    if (!this._global.hosts[host]) {
      this._global.hosts[host] = {
        completedCount: 0,
        errorCount: 0,
        totalBytes: 0,
        totalTransferMs: 0,
        avgSpeedBps: 0,
        minDurationMs: Infinity,
        maxDurationMs: 0,
      };
    }
    return this._global.hosts[host];
  }

  private _addDurationBucket(durationMs: number): void {
    for (const b of DURATION_BUCKETS) {
      if (durationMs <= b.max) {
        this._global.durationBuckets[b.label]++;
        break;
      }
    }
  }
}

// Singleton
const downloadMetrics = new DownloadMetrics();
export default downloadMetrics;
export { DownloadMetrics };
