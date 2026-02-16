/**
 * Descarga en un solo stream (sin HTTP Range). Para archivos bajo el umbral configurado (p. ej. 50 MB).
 *
 * startSimpleDownload: valida URL, espacio, reanudación desde .part o archivo existente;
 * usa circuit breaker por host, escribe a disco y actualiza progreso/estado vía engine.stateStore
 * y EventBus. Soporta Range header para reanudar. El engine pasa DownloadEngineRef para no
 * acoplar este módulo al DownloadEngine completo.
 *
 * electron net.request usa la pila nativa de Chromium; HTTP/2 se negocia vía ALPN cuando
 * el servidor lo soporta; la reutilización de conexiones y multiplexado son automáticos.
 *
 * @module SimpleDownloader
 */

import { net } from 'electron';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import config from '../config';
import { logger, validateDiskSpace } from '../utils';
import { isValidUrl } from '../utils/validation';
import { DownloadState } from './types';
import eventBus from './EventBus';
import {
  parseRetryAfter,
  calculateAdaptiveRetryDelay,
  classifyTransientError,
} from './DownloadValidator';
import downloadMetrics from './DownloadMetrics';
import { getRecommendedWriteBufferSize } from './AdaptiveWriteBuffer';
import { hashLastNBytes, verifyPartialTail } from '../utils/partialIntegrity';
import type { DownloadEngineRef } from './types';
import type { Download } from './StateStore';

const log = logger.child('DownloadEngine');

export interface SimpleDownloadInput {
  id: number;
  url: string | null;
  savePath: string | null;
  totalBytes: number;
  forceOverwrite: boolean;
}

interface ActiveSimpleEntry {
  request: unknown;
  response: unknown;
  fileStream: fsSync.WriteStream | null;
  timeoutId: ReturnType<typeof setTimeout>;
  /** Interval de detección de inactividad (idle timeout). */
  idleCheckInterval?: ReturnType<typeof setInterval> | null;
  partialFilePath: string;
  resumeFromByte: number;
  isResuming: boolean;
  handlers?: {
    data: ((_chunk: Buffer | string) => void) | null;
    end: (() => void) | null;
    fileStreamError: ((_err: Error) => void) | null;
    responseError: ((_err: Error) => void) | null;
  };
}

interface SimpleResponseLike {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  on: (_event: string, _fn: (..._args: unknown[]) => void) => void;
  destroy: () => void;
  pause: () => void;
  resume: () => void;
  destroyed: boolean;
}

/**
 * Guarda checkpoint de integridad parcial (hash de últimos N bytes) para reanudar después.
 * Debe llamarse antes de pausar una descarga simple (cierre del stream).
 */
export async function savePartialCheckpointForPause(
  engine: DownloadEngineRef,
  downloadId: number
): Promise<void> {
  const active = engine.activeDownloads.get(downloadId) as
    | {
        partialFilePath?: string;
        fileStream?: { end: (_cb: () => void) => void; destroyed?: boolean };
      }
    | undefined;
  if (!active?.partialFilePath) return;
  await new Promise<void>(resolve => {
    if (active.fileStream && !(active.fileStream as { destroyed?: boolean }).destroyed) {
      (active.fileStream as { end: (_cb: () => void) => void }).end(() => resolve());
    } else {
      resolve();
    }
  });
  try {
    const stat = await fs.stat(active.partialFilePath);
    if (stat.size > 0) {
      const tailHash = await hashLastNBytes(active.partialFilePath, stat.size);
      engine.stateStore.updateDownload(downloadId, {
        partialTailHash: tailHash,
        partialTailSize: stat.size,
      });
    }
  } catch (e) {
    log.debug?.(
      `[O15] No se pudo guardar checkpoint al pausar ${downloadId}:`,
      (e as Error)?.message
    );
  }
}

/**
 * Inicia una descarga simple: un request/stream, opcional reanudación desde .part.
 * Actualiza stateStore y EventBus; en error transitorio aplica backoff y reintento según config.
 *
 * @param engine - Referencia al motor (stateStore, circuit breaker, cleanup, etc.).
 * @param download - id, url, savePath, totalBytes, forceOverwrite.
 */
export async function startSimpleDownload(
  engine: DownloadEngineRef,
  download: SimpleDownloadInput
): Promise<void> {
  if (!download.url || !isValidUrl(download.url)) {
    throw new Error(`URL inválida o no permitida para descarga ${download.id}`);
  }

  const stateStore = engine.stateStore;
  const partialFilePath = (download.savePath ?? '') + '.part';
  let resumeFromByte = 0;
  let isResuming = false;

  try {
    if (fsSync.existsSync(partialFilePath)) {
      const partialStats = fsSync.statSync(partialFilePath);
      if (partialStats.size > 0 && partialStats.size < download.totalBytes) {
        resumeFromByte = partialStats.size;
        isResuming = true;
        log.info(`Reanudando descarga ${download.id} desde byte ${resumeFromByte}`);
      }
    } else if (
      download.savePath &&
      fsSync.existsSync(download.savePath) &&
      !download.forceOverwrite
    ) {
      const existingStats = fsSync.statSync(download.savePath);
      if (existingStats.size > 0 && existingStats.size < download.totalBytes) {
        await fs.rename(download.savePath, partialFilePath);
        resumeFromByte = existingStats.size;
        isResuming = true;
        log.info(
          `Reanudando descarga ${download.id} desde byte ${resumeFromByte} (archivo convertido a .part)`
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Error verificando archivo para reanudación ${download.id}:`, message);
  }

  // Verificación de integridad parcial al reanudar
  if (isResuming && fsSync.existsSync(partialFilePath)) {
    const current = stateStore.getDownload(download.id);
    if (
      current?.partialTailHash != null &&
      current?.partialTailSize != null &&
      current.partialTailSize > 0
    ) {
      const size = fsSync.statSync(partialFilePath).size;
      if (size === current.partialTailSize) {
        const ok = await verifyPartialTail(
          partialFilePath,
          current.partialTailSize,
          current.partialTailHash
        );
        if (!ok) {
          log.warn(
            `[O15] Integridad parcial fallida para descarga ${download.id}, reiniciando desde cero`
          );
          try {
            fsSync.unlinkSync(partialFilePath);
          } catch {
            /* ignore */
          }
          resumeFromByte = 0;
          isResuming = false;
          stateStore.updateDownload(download.id, {
            downloadedBytes: 0,
            partialTailHash: null,
            partialTailSize: null,
          });
        }
      }
    }
  }

  if (!download.savePath) {
    throw new Error(`Descarga ${download.id} no tiene savePath`);
  }

  if (download.totalBytes > 0) {
    const spaceCheck = await validateDiskSpace(download.savePath, download.totalBytes);
    if (!spaceCheck.valid) {
      throw new Error(spaceCheck.error || 'Espacio insuficiente en disco');
    }
  } else {
    log.warn(`Tamaño desconocido para descarga ${download.id}, no se puede validar espacio`);
  }

  stateStore.updateDownload(download.id, {
    downloadedBytes: resumeFromByte,
  });

  const circuitBreaker = engine._getHostCircuitBreaker(download.url);
  let request: unknown;

  if (circuitBreaker && (config.circuitBreaker as { enabled?: boolean } | undefined)?.enabled) {
    try {
      request = await circuitBreaker.execute(
        async () => net.request({ url: download.url! }),
        () => {
          throw new Error('Circuit breaker abierto: demasiados errores en este host');
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`[CircuitBreaker] Error al crear request para ${download.url}:`, message);
      stateStore.transitionState(download.id, DownloadState.FAILED);
      stateStore.updateDownload(download.id, {
        lastError: message,
      });
      eventBus.emitDownloadFailed(download.id, error as Error);
      throw error;
    }
  } else {
    request = net.request({ url: download.url! });
  }

  const timeout =
    (config.network as { timeout?: number; responseTimeout?: number } | undefined)?.timeout ??
    (config.network as { responseTimeout?: number } | undefined)?.responseTimeout ??
    30000;
  const timeoutId = setTimeout(() => {
    const req = request as { destroyed?: boolean; abort?: () => void };
    if (req && !req.destroyed) {
      log.warn(`Descarga ${download.id}: timeout después de ${timeout}ms`);
      try {
        if (typeof req.abort === 'function') req.abort();
      } catch (abortErr) {
        log.debug?.(
          `Descarga ${download.id}: error al abortar request (esperado):`,
          (abortErr as Error)?.message
        );
      }
      stateStore.transitionState(download.id, DownloadState.FAILED);
      stateStore.updateDownload(download.id, {
        lastError: `Timeout: no se recibió respuesta del servidor en ${timeout}ms`,
      });
      eventBus.emitDownloadFailed(download.id, new Error('Timeout'));
      engine._cleanupActiveDownload(download.id);
    }
  }, timeout);

  const active: ActiveSimpleEntry = {
    request,
    response: null,
    fileStream: null,
    timeoutId,
    partialFilePath,
    resumeFromByte,
    isResuming,
  };
  engine.activeDownloads.set(download.id, active);

  const req = request as {
    setHeader: (_name: string, _value: string) => void;
    on: (_ev: string, _fn: (..._a: unknown[]) => void) => void;
    end: () => void;
  };
  const urlOrigin = (() => {
    try {
      return new URL(download.url!).origin + '/';
    } catch {
      return 'https://myrient.erista.me/';
    }
  })();
  req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  req.setHeader('Referer', urlOrigin);
  req.setHeader('Accept', '*/*');
  req.setHeader('Connection', 'keep-alive');

  if (isResuming && resumeFromByte > 0) {
    req.setHeader('Range', `bytes=${resumeFromByte}-`);
  }

  req.on('response', (response: unknown) => {
    clearTimeout(timeoutId);
    handleSimpleResponse(engine, download.id, response as SimpleResponseLike, request);
  });

  req.on('error', (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    clearTimeout(timeoutId);
    log.error(`Error en request de descarga ${download.id}:`, err);

    const isTransientError = engine._isTransientNetworkError(err);
    const currentDownload = stateStore.getDownload(download.id);
    const retryCount = (currentDownload as { retryCount?: number } | null)?.retryCount ?? 0;
    const maxRetries = (config.downloads as { maxRetries?: number } | undefined)?.maxRetries ?? 3;

    if (isTransientError && retryCount < maxRetries) {
      // Retry adaptativo según tipo de error (perfiles en config)
      const errorType = classifyTransientError(err as Error & { code?: string });
      const adaptiveDelay = calculateAdaptiveRetryDelay(
        retryCount,
        err as Error & { code?: string }
      );
      log.info(
        `Error transitorio [${errorType}] para descarga ${download.id}, reintentando en ${Math.round(adaptiveDelay / 1000)}s (${retryCount + 1}/${maxRetries})`
      );
      stateStore.updateDownload(download.id, {
        retryCount: retryCount + 1,
      });
      setTimeout(() => {
        stateStore.transitionState(download.id, DownloadState.QUEUED);
        engine.processQueue().catch(e => {
          log.error(`Error reintentando descarga ${download.id}:`, e);
        });
      }, adaptiveDelay);
      engine._cleanupActiveDownload(download.id);
      return;
    }

    stateStore.transitionState(download.id, DownloadState.FAILED);
    stateStore.updateDownload(download.id, {
      lastError: err.message,
      retryCount: retryCount + 1,
    });
    eventBus.emitDownloadFailed(download.id, err);
    engine._cleanupActiveDownload(download.id);
  });

  req.end();

  const sid = engine.sessionManager?.getSessionId(download.id) ?? '';
  log.info(
    `[sid:${sid}] Descarga simple iniciada: ${download.id} (${isResuming ? 'reanudando' : 'nueva'})`
  );
}

/**
 * Maneja la respuesta HTTP de una descarga simple.
 */
export async function handleSimpleResponse(
  engine: DownloadEngineRef,
  downloadId: number,
  response: SimpleResponseLike,
  _request: unknown
): Promise<void> {
  const stateStore = engine.stateStore;
  const download = stateStore.getDownload(downloadId) as Download | null;
  if (!download) {
    response.destroy();
    return;
  }

  const active = engine.activeDownloads.get(downloadId) as ActiveSimpleEntry | undefined;
  if (!active) {
    response.destroy();
    return;
  }

  (active as { response: unknown }).response = response;

  if (response.statusCode === 416) {
    log.warn(`Range not satisfiable para descarga ${downloadId}, reiniciando desde inicio`);
    try {
      if (active.partialFilePath && fsSync.existsSync(active.partialFilePath)) {
        await fs.unlink(active.partialFilePath);
      }
    } catch (unlinkErr) {
      log.debug?.(
        `Error al eliminar archivo parcial (descarga ${downloadId}):`,
        (unlinkErr as Error)?.message
      );
    }
    stateStore.updateDownload(downloadId, { downloadedBytes: 0 });
    stateStore.transitionState(downloadId, DownloadState.QUEUED);
    engine._cleanupActiveDownload(downloadId);
    engine.processQueue().catch(error => {
      log.error('Error procesando cola después de 416:', error);
    });
    return;
  }

  // Manejo unificado de 429 Too Many Requests y 503 Service Unavailable:
  // ambos indican que el servidor pide esperar; reencolamos con Retry-After o backoff por defecto.
  if (response.statusCode === 429 || response.statusCode === 503) {
    const retryAfterRaw =
      response.headers && (response.headers['retry-after'] ?? response.headers['Retry-After']);
    const raw = Array.isArray(retryAfterRaw) ? retryAfterRaw[0] : retryAfterRaw;
    const defaultRetryMs = response.statusCode === 503 ? 30000 : 60000;
    const retryAfterMs =
      parseRetryAfter(raw as string | undefined) ??
      (config.network as { retryAfter429DefaultMs?: number } | undefined)?.retryAfter429DefaultMs ??
      defaultRetryMs;
    const label = response.statusCode === 429 ? '429 Too Many Requests' : '503 Service Unavailable';
    log.info(
      `Descarga ${downloadId}: ${label}, reencolando en ${Math.round(retryAfterMs / 1000)}s${raw ? ` (Retry-After: ${raw})` : ''}`
    );
    // Registrar reintento transient en métricas
    try {
      const host = new URL(stateStore.getDownload(downloadId)?.url ?? '').hostname;
      downloadMetrics.recordTransientRetry(host);
      // Reportar reintento transient al controlador de concurrencia adaptativa
      engine._recordAdaptiveEvent?.('transient_retry', host);
    } catch {
      /* URL inválida; no bloquear flujo */
    }
    await savePartialCheckpointForPause(engine, downloadId);
    stateStore.transitionState(downloadId, DownloadState.QUEUED);
    eventBus.emitStateChanged(stateStore.getStateVersion());
    engine._cleanupActiveDownload(downloadId);
    setTimeout(() => {
      engine.processQueue().catch(error => {
        log.error(`Error procesando cola después de ${response.statusCode}:`, error);
      });
    }, retryAfterMs);
    return;
  }

  if (response.statusCode !== 200 && response.statusCode !== 206) {
    const sid = engine.sessionManager?.getSessionId(downloadId) ?? '';
    log.error(`[sid:${sid}] Error HTTP ${response.statusCode} en descarga ${downloadId}`);
    stateStore.transitionState(downloadId, DownloadState.FAILED);
    stateStore.updateDownload(downloadId, {
      lastError: `Error HTTP ${response.statusCode}`,
    });
    eventBus.emitDownloadFailed(downloadId, new Error(`HTTP ${response.statusCode}`));
    engine._cleanupActiveDownload(downloadId);
    return;
  }

  const currentState = download.state;
  if (currentState === DownloadState.STARTING) {
    stateStore.transitionState(downloadId, DownloadState.DOWNLOADING, DownloadState.STARTING);
    stateStore.updateDownload(downloadId, { startedAt: Date.now() });
    eventBus.emitStateChanged(stateStore.getStateVersion());
  }

  const serverSupportsResume = response.statusCode === 206;
  const writeMode = serverSupportsResume && active.resumeFromByte > 0 ? 'a' : 'w';

  try {
    const dirPath = path.dirname(active.partialFilePath);
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Error creando directorio para descarga ${downloadId}:`, error);
    stateStore.transitionState(downloadId, DownloadState.FAILED);
    stateStore.updateDownload(downloadId, {
      lastError: `Error creando directorio: ${message}`,
    });
    eventBus.emitDownloadFailed(downloadId, error as Error);
    engine._cleanupActiveDownload(downloadId);
    return;
  }

  const host = download.url ? new URL(download.url).hostname : null;
  const writeBufferSize = getRecommendedWriteBufferSize(host, { forChunk: false });
  const fileStream = fsSync.createWriteStream(active.partialFilePath, {
    flags: writeMode,
    highWaterMark: writeBufferSize,
  });

  fileStream.setMaxListeners(15);
  (response as unknown as { setMaxListeners: (_n: number) => void }).setMaxListeners(15);

  active.fileStream = fileStream;
  engine.activeDownloads.set(downloadId, active);

  const contentLength = parseInt(
    (Array.isArray(response.headers['content-length'])
      ? response.headers['content-length'][0]
      : response.headers['content-length']) || '0',
    10
  );
  let totalBytes = download.totalBytes;

  if (totalBytes === 0 && contentLength > 0) {
    totalBytes = active.resumeFromByte + contentLength;
    stateStore.updateDownload(downloadId, { totalBytes });
    (download as Download & { totalBytes: number }).totalBytes = totalBytes;
  }

  let downloadedBytes = active.resumeFromByte;
  let lastProgressUpdate = Date.now();
  let lastDbUpdate = Date.now();
  let sessionStartTime = Date.now();
  let _sessionDownloaded = 0;
  let lastRecordedBytesForMetrics = active.resumeFromByte;
  const progressInterval =
    (config.downloads as { progressUpdateInterval?: number } | undefined)?.progressUpdateInterval ??
    500;
  let isPaused = false;

  const handlers: NonNullable<ActiveSimpleEntry['handlers']> = {
    data: null,
    end: null,
    fileStreamError: null,
    responseError: null,
  };

  handlers.data = (chunk: Buffer | string) => {
    if (!fileStream || fileStream.destroyed || !(fileStream as { writable?: boolean }).writable) {
      if (!response.destroyed) response.destroy();
      return;
    }
    const canContinue = fileStream.write(chunk);
    if (!canContinue && !isPaused) {
      isPaused = true;
      response.pause();
      fileStream.once('drain', () => {
        isPaused = false;
        if (!response.destroyed) response.resume();
      });
    }
    downloadedBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    _sessionDownloaded += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    const now = Date.now();

    if (now - lastProgressUpdate >= progressInterval) {
      const progress = totalBytes > 0 ? downloadedBytes / totalBytes : 0;
      engine.speedTracker.ensureTracking(downloadId, sessionStartTime, downloadedBytes);
      const speedResult = engine.speedTracker.update(downloadId, downloadedBytes, totalBytes);
      const speedBytesPerSec = speedResult ? speedResult.speedBytesPerSec : 0;
      const remainingTime = speedResult ? speedResult.remainingTime : null;
      const speedMBPerSec = speedBytesPerSec / (1024 * 1024);

      if (now - lastDbUpdate >= 1000) {
        stateStore.updateDownload(downloadId, {
          progress: Math.min(progress, 1.0),
          downloadedBytes,
        });
        lastDbUpdate = now;
      }

      const deltaBytes = downloadedBytes - lastRecordedBytesForMetrics;
      if (deltaBytes > 0) {
        downloadMetrics.recordBytes(downloadId, deltaBytes);
        lastRecordedBytesForMetrics = downloadedBytes;
      }

      eventBus.emitDownloadProgress(downloadId, {
        progress: Math.min(progress, 1.0),
        downloadedBytes,
        totalBytes,
        speed: speedMBPerSec,
        speedBytesPerSec,
        remainingTime,
        chunked: false,
      });

      lastProgressUpdate = now;
    }
  };

  response.on('data', handlers.data as (..._args: unknown[]) => void);

  // Safety net backpressure: si el fileStream se cierra inesperadamente, detener la response.
  fileStream.once('close', () => {
    if (!response.destroyed) {
      log.warn(
        `[handleSimpleResponse] fileStream cerrado inesperadamente para descarga ${downloadId}, destruyendo response`
      );
      response.destroy();
    }
  });

  // Refactorizado de Promise chains a async/await para legibilidad
  handlers.end = () => {
    const validateAndFinish = async (): Promise<void> => {
      try {
        const stats = await fs.stat(active.partialFilePath);
        if (totalBytes > 0 && stats.size !== totalBytes) {
          throw new Error(`Tamaño incorrecto: ${stats.size}/${totalBytes} bytes`);
        }

        if (download.forceOverwrite && download.savePath) {
          try {
            await fs.unlink(download.savePath);
          } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
              log.warn(
                `Error eliminando archivo existente antes del rename: ${(unlinkError as Error).message}`
              );
            }
          }
        }

        await fs.rename(active.partialFilePath, download.savePath!);

        stateStore.updateDownload(downloadId, {
          progress: 1.0,
          downloadedBytes: totalBytes || downloadedBytes,
          partialTailHash: null,
          partialTailSize: null,
        });
        const currentDownload = stateStore.getDownload(downloadId);
        if (currentDownload) {
          stateStore.transitionState(downloadId, DownloadState.VERIFYING, currentDownload.state);
        } else {
          stateStore.transitionState(downloadId, DownloadState.VERIFYING);
        }

        try {
          await engine._verifyDownload(downloadId);
        } catch (verifyError) {
          // _verifyDownload ya transiciona a FAILED internamente; solo logueamos
          log.error(`Error verificando descarga ${downloadId}:`, verifyError);
        }
      } catch (error) {
        log.error(`Error procesando archivo final ${downloadId}:`, error);
        stateStore.transitionState(downloadId, DownloadState.FAILED);
        stateStore.updateDownload(downloadId, {
          lastError: (error as Error).message,
        });
        eventBus.emitDownloadFailed(downloadId, error as Error);
      } finally {
        engine._cleanupActiveDownload(downloadId);
      }
    };

    if (
      fileStream &&
      !fileStream.destroyed &&
      !(fileStream as { closed?: boolean }).closed &&
      fileStream.writable
    ) {
      fileStream.end((endError: Error | null | undefined) => {
        if (endError) {
          const isIgnorableError =
            (endError as NodeJS.ErrnoException).code === 'ERR_STREAM_DESTROYED' ||
            (endError.message && endError.message.includes('destroyed'));

          if (!isIgnorableError) {
            log.error(`Error cerrando fileStream de descarga ${downloadId}:`, endError);
            stateStore.transitionState(downloadId, DownloadState.FAILED);
            stateStore.updateDownload(downloadId, {
              lastError: `Error cerrando archivo: ${endError.message}`,
            });
            eventBus.emitDownloadFailed(downloadId, endError);
            engine._cleanupActiveDownload(downloadId);
            return;
          }
          log.warn(
            `Stream reportado como destruido al cerrar descarga ${downloadId}, intentando validar...`
          );
        }
        validateAndFinish();
      });
    } else {
      log.debug(
        `Stream ya cerrado en endHandler de descarga ${downloadId}, procediendo a validación`
      );
      validateAndFinish();
    }
  };

  response.on('end', handlers.end);

  handlers.fileStreamError = (error: Error) => {
    log.error(`Error en fileStream de descarga ${downloadId}:`, error);
    stateStore.transitionState(downloadId, DownloadState.FAILED);
    stateStore.updateDownload(downloadId, {
      lastError: `Error de escritura: ${error.message}`,
    });
    eventBus.emitDownloadFailed(downloadId, error);
    engine._cleanupActiveDownload(downloadId);
  };

  fileStream.on('error', handlers.fileStreamError);

  handlers.responseError = (error: Error) => {
    if (!error.message.includes('aborted')) {
      log.error(`Error en response de descarga ${downloadId}:`, error);
      stateStore.transitionState(downloadId, DownloadState.FAILED);
      stateStore.updateDownload(downloadId, {
        lastError: error.message,
      });
      eventBus.emitDownloadFailed(downloadId, error);
      engine._cleanupActiveDownload(downloadId);
    }
  };

  response.on('error', handlers.responseError as (..._args: unknown[]) => void);

  // Idle timeout: detecta descargas simples sin progreso (stalled).
  const idleTimeout =
    (config.network as { idleTimeout?: number } | undefined)?.idleTimeout ?? 60000;
  let lastIdleCheckBytes = downloadedBytes;
  let lastIdleCheckTime = Date.now();
  const idleCheckInterval = setInterval(() => {
    // Si la descarga ya no está activa, limpiar
    const currentDownload = stateStore.getDownload(downloadId);
    if (!currentDownload || currentDownload.state !== DownloadState.DOWNLOADING) {
      clearInterval(idleCheckInterval);
      return;
    }
    if (downloadedBytes > lastIdleCheckBytes) {
      lastIdleCheckBytes = downloadedBytes;
      lastIdleCheckTime = Date.now();
    } else if (Date.now() - lastIdleCheckTime > idleTimeout) {
      clearInterval(idleCheckInterval);
      const timeoutSec = Math.round(idleTimeout / 1000);
      log.warn(`Descarga ${downloadId}: sin progreso por ${timeoutSec}s (idle timeout), abortando`);
      const req = _request as { destroyed?: boolean; abort?: () => void };
      if (req && !req.destroyed && req.abort) req.abort();
      if (response && !response.destroyed) response.destroy();

      const isTransientError = true;
      const retryCount = (currentDownload as { retryCount?: number })?.retryCount ?? 0;
      const maxRetries = (config.downloads as { maxRetries?: number } | undefined)?.maxRetries ?? 3;

      if (isTransientError && retryCount < maxRetries) {
        // Idle timeout se clasifica como 'timeout' → retry rápido
        const idleError = new Error(`Idle timeout: sin progreso por ${timeoutSec}s`) as Error & {
          code?: string;
        };
        idleError.code = 'ETIMEDOUT';
        const adaptiveDelay = calculateAdaptiveRetryDelay(retryCount, idleError);
        log.info(
          `Descarga ${downloadId}: reintentando tras idle timeout en ${Math.round(adaptiveDelay / 1000)}s (${retryCount + 1}/${maxRetries})`
        );
        stateStore.updateDownload(downloadId, { retryCount: retryCount + 1 });
        setTimeout(() => {
          stateStore.transitionState(downloadId, DownloadState.QUEUED);
          engine.processQueue().catch(e => {
            log.error(`Error reintentando descarga ${downloadId} tras idle timeout:`, e);
          });
        }, adaptiveDelay);
        engine._cleanupActiveDownload(downloadId);
      } else {
        stateStore.transitionState(downloadId, DownloadState.FAILED);
        stateStore.updateDownload(downloadId, {
          lastError: `Sin progreso por ${timeoutSec}s (idle timeout)`,
        });
        eventBus.emitDownloadFailed(
          downloadId,
          new Error(`Sin progreso por ${timeoutSec}s (idle timeout)`)
        );
        engine._cleanupActiveDownload(downloadId);
      }
    }
  }, 5000);

  active.idleCheckInterval = idleCheckInterval;
  active.handlers = handlers;
  engine.activeDownloads.set(downloadId, active);
}
