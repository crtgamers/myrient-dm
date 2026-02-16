/**
 * Validaciones y utilidades de red para el motor de descargas.
 *
 * validateSavePath: path dentro del directorio de descargas permitido y sanitizado.
 * isTransientNetworkError: detecta errores que merecen reintento (ECONNRESET, ETIMEDOUT, etc.).
 * parseRetryAfter: interpreta cabecera Retry-After (segundos o fecha).
 * calculateBackoffDelay: delay exponencial según retryCount y config.
 *
 * @module engines/DownloadValidator
 */

import path from 'path';
import config from '../config';
import { logger } from '../utils';
import { validateAndSanitizeDownloadPath } from '../utils/validation';

const log = logger.child('DownloadValidator');

export interface ValidateSavePathResult {
  valid: boolean;
  error?: string;
  sanitizedPath?: string;
}

/** Comprueba que savePath esté dentro de downloadPath (si se da) y pase validateAndSanitizeDownloadPath. */
export function validateSavePath(savePath: string, downloadPath?: string): ValidateSavePathResult {
  if (!savePath || typeof savePath !== 'string') {
    return { valid: false, error: 'Ruta de guardado no proporcionada' };
  }

  try {
    if (downloadPath) {
      const resolvedDownloadPath = path.resolve(downloadPath);
      const resolvedSavePath = path.resolve(savePath);

      if (!resolvedSavePath.startsWith(resolvedDownloadPath)) {
        log.warn(`Intento de path traversal detectado: ${savePath} fuera de ${downloadPath}`);
        return {
          valid: false,
          error: 'La ruta de guardado debe estar dentro del directorio de descargas permitido',
        };
      }
    }

    const validation = validateAndSanitizeDownloadPath(savePath);
    if (!validation.valid) {
      return { valid: false, error: validation.error ?? 'Ruta de guardado inválida' };
    }

    return {
      valid: true,
      sanitizedPath: validation.path ?? savePath,
    };
  } catch (error) {
    log.error('Error validando savePath:', error);
    return { valid: false, error: 'Error validando ruta de guardado' };
  }
}

/** Indica si el error es de red transitorio (reintento razonable). */
export function isTransientNetworkError(error: Error & { code?: string }): boolean {
  if (!error) return false;

  const errorMessage = error.message ?? '';
  const errorCode = error.code;

  const transientErrorCodes = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'EPIPE',
    'ENETUNREACH',
    'EHOSTUNREACH',
  ];

  if (errorCode && transientErrorCodes.includes(errorCode)) {
    return true;
  }

  const transientErrorStrings = [
    'net::ERR_CONNECTION_RESET',
    'net::ERR_TIMED_OUT',
    'net::ERR_CONNECTION_TIMED_OUT',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_NETWORK_CHANGED',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_HTTP2_PING_FAILED',
    'net::ERR_HTTP2_PROTOCOL_ERROR',
  ];

  return transientErrorStrings.some(str => errorMessage.includes(str));
}

export interface ParseRetryAfterOptions {
  retryAfter429DefaultMs?: number;
  retryAfter429MaxMs?: number;
}

/** Parsea cabecera Retry-After (entero segundos o fecha HTTP); devuelve ms o null. */
export function parseRetryAfter(
  retryAfter: string | undefined,
  opts: ParseRetryAfterOptions = {}
): number | null {
  if (!retryAfter || typeof retryAfter !== 'string') return null;
  const networkConfig = config.network as
    | { retryAfter429DefaultMs?: number; retryAfter429MaxMs?: number }
    | undefined;
  void (opts.retryAfter429DefaultMs ?? networkConfig?.retryAfter429DefaultMs ?? 60000);
  const max = opts.retryAfter429MaxMs ?? networkConfig?.retryAfter429MaxMs ?? 300000;
  const s = retryAfter.trim();
  const sec = parseInt(s, 10);
  if (Number.isInteger(sec) && sec >= 0) {
    return Math.min(sec * 1000, max);
  }
  const date = new Date(s);
  if (!Number.isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    return ms > 0 ? Math.min(ms, max) : null;
  }
  return null;
}

/** Calcula delay de reintento en ms (backoff exponencial acotado por config). */
export function calculateBackoffDelay(retryCount: number): number {
  const networkConfig = config.network as
    | { retryDelay?: number; maxRetryDelay?: number }
    | undefined;
  const baseDelay = networkConfig?.retryDelay ?? 1000;
  const maxDelay = networkConfig?.maxRetryDelay ?? 30000;
  const exponentialDelay = baseDelay * Math.pow(2, retryCount);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, maxDelay);
}

// ---------------------------------------------------------------------------
// Estrategia de retry adaptativa por tipo de error
// ---------------------------------------------------------------------------

/**
 * Clasificación del error de red para determinar la estrategia de retry.
 *
 * - `timeout`: el servidor no respondió a tiempo (vivo pero lento).
 * - `connection_reset`: conexión interrumpida (ECONNRESET, connection closed).
 * - `connection_refused`: servidor rechaza conexiones (ECONNREFUSED).
 * - `dns`: resolución DNS falló (ENOTFOUND, EAI_AGAIN).
 * - `network_change`: cambio de red detectado (ERR_NETWORK_CHANGED).
 * - `server_overload`: servidor pide esperar (429/503, manejado por Retry-After).
 * - `pipe_broken`: escritura en socket cerrado (EPIPE).
 * - `unknown`: error no clasificado; fallback a backoff genérico.
 */
export type TransientErrorType =
  | 'timeout'
  | 'connection_reset'
  | 'connection_refused'
  | 'dns'
  | 'network_change'
  | 'server_overload'
  | 'pipe_broken'
  | 'unknown';

/**
 * Clasifica un error de red transitorio en una categoría específica.
 * Útil para adaptar la estrategia de retry según el tipo de fallo.
 */
export function classifyTransientError(error: Error & { code?: string }): TransientErrorType {
  if (!error) return 'unknown';

  const code = error.code ?? '';
  const msg = error.message ?? '';

  // Timeout: servidor lento pero alcanzable
  if (
    code === 'ETIMEDOUT' ||
    msg.includes('net::ERR_TIMED_OUT') ||
    msg.includes('net::ERR_CONNECTION_TIMED_OUT') ||
    msg.includes('timeout') ||
    msg.includes('Timeout')
  ) {
    return 'timeout';
  }

  // Cambio de red: el OS detectó cambio de interfaz/red
  if (msg.includes('net::ERR_NETWORK_CHANGED') || msg.includes('net::ERR_INTERNET_DISCONNECTED')) {
    return 'network_change';
  }

  // Reset de conexión: el servidor o un proxy cortó la conexión
  if (
    code === 'ECONNRESET' ||
    msg.includes('net::ERR_CONNECTION_RESET') ||
    msg.includes('net::ERR_CONNECTION_CLOSED') ||
    msg.includes('net::ERR_HTTP2_PING_FAILED') ||
    msg.includes('net::ERR_HTTP2_PROTOCOL_ERROR') ||
    msg.includes('connection closed') ||
    msg.includes('Connection closed unexpectedly')
  ) {
    return 'connection_reset';
  }

  // Conexión rechazada: servidor caído o firewall
  if (code === 'ECONNREFUSED') {
    return 'connection_refused';
  }

  // DNS: no se puede resolver el hostname
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || msg.includes('net::ERR_NAME_NOT_RESOLVED')) {
    return 'dns';
  }

  // Pipe roto: escribiendo en socket ya cerrado
  if (code === 'EPIPE') {
    return 'pipe_broken';
  }

  // Host inalcanzable
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return 'connection_refused';
  }

  // 429/503 → normalmente manejados por Retry-After, pero clasificamos por si acaso
  if (code === 'HTTP_429' || code === 'HTTP_503') {
    return 'server_overload';
  }

  return 'unknown';
}

/**
 * Configuración de retry por tipo de error.
 * Cada tipo tiene un delay base, delay máximo y factor de crecimiento propios.
 */
interface RetryProfile {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Factor de crecimiento exponencial por intento (default 2). */
  growthFactor: number;
  /** Jitter relativo (0.0-1.0) aplicado al delay calculado (default 0.3). */
  jitterFactor: number;
}

/** Perfiles de retry por tipo de error. Valores ajustables vía config.retryProfiles. */
function getRetryProfiles(): Record<TransientErrorType, RetryProfile> {
  const cfgProfiles = config.retryProfiles as
    | Partial<Record<TransientErrorType, Partial<RetryProfile>>>
    | undefined;

  const defaults: Record<TransientErrorType, RetryProfile> = {
    // Timeout: servidor lento pero vivo → retry rápido
    timeout: { baseDelayMs: 5_000, maxDelayMs: 20_000, growthFactor: 1.5, jitterFactor: 0.2 },
    // Connection reset: disrupción de red → backoff moderado
    connection_reset: {
      baseDelayMs: 10_000,
      maxDelayMs: 60_000,
      growthFactor: 2,
      jitterFactor: 0.3,
    },
    // Conexión rechazada: servidor caído → backoff agresivo
    connection_refused: {
      baseDelayMs: 15_000,
      maxDelayMs: 120_000,
      growthFactor: 2.5,
      jitterFactor: 0.3,
    },
    // DNS: resolución fallida → backoff moderado
    dns: { baseDelayMs: 10_000, maxDelayMs: 60_000, growthFactor: 2, jitterFactor: 0.2 },
    // Cambio de red: OS reconectándose → retry rápido
    network_change: {
      baseDelayMs: 3_000,
      maxDelayMs: 15_000,
      growthFactor: 1.5,
      jitterFactor: 0.2,
    },
    // Server overload: normalmente usa Retry-After; este es fallback
    server_overload: {
      baseDelayMs: 30_000,
      maxDelayMs: 300_000,
      growthFactor: 2,
      jitterFactor: 0.1,
    },
    // Pipe roto: similar a connection reset
    pipe_broken: { baseDelayMs: 5_000, maxDelayMs: 30_000, growthFactor: 2, jitterFactor: 0.3 },
    // Desconocido: fallback al backoff genérico actual
    unknown: { baseDelayMs: 1_000, maxDelayMs: 30_000, growthFactor: 2, jitterFactor: 0.3 },
  };

  // Merge con config del usuario (si existe)
  if (cfgProfiles) {
    for (const [key, overrides] of Object.entries(cfgProfiles)) {
      const errorType = key as TransientErrorType;
      if (defaults[errorType] && overrides) {
        defaults[errorType] = { ...defaults[errorType], ...overrides };
      }
    }
  }

  return defaults;
}

/**
 * Calcula el delay de retry adaptado al tipo de error.
 *
 * Clasifica el error y aplica un perfil de retry específico: los timeouts
 * se reintentan rápido (5s), los resets de conexión con backoff moderado (10-60s),
 * los DNS con backoff lento (10-60s), y los cambios de red casi inmediatamente (3s).
 *
 * Si el error incluye `retryAfterMs` (429/503), ese valor tiene prioridad.
 *
 * @param retryCount — Número de reintentos previos (0-based).
 * @param error — El error original con code y message.
 * @returns Delay en ms antes del próximo reintento.
 */
export function calculateAdaptiveRetryDelay(
  retryCount: number,
  error?: Error & { code?: string; retryAfterMs?: number }
): number {
  // Si no hay error, fallback al genérico
  if (!error) return calculateBackoffDelay(retryCount);

  // Si el error trae Retry-After explícito (429/503), priorizar
  if (error.retryAfterMs != null && error.retryAfterMs > 0) {
    return error.retryAfterMs;
  }

  const errorType = classifyTransientError(error);
  const profiles = getRetryProfiles();
  const profile = profiles[errorType];

  const exponentialDelay = profile.baseDelayMs * Math.pow(profile.growthFactor, retryCount);
  const jitter = Math.random() * profile.jitterFactor * exponentialDelay;
  const delay = Math.min(exponentialDelay + jitter, profile.maxDelayMs);

  log.debug?.(
    `[AdaptiveRetry] error=${errorType}, retryCount=${retryCount}, delay=${Math.round(delay)}ms ` +
      `(base=${profile.baseDelayMs}, max=${profile.maxDelayMs}, growth=${profile.growthFactor})`
  );

  return Math.round(delay);
}
