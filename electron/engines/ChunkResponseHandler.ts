/**
 * Manejo de respuestas HTTP para chunks individuales.
 *
 * Extraído de ChunkDownloader.ts para mejorar mantenibilidad.
 * Contiene handleChunkResponse (~640 líneas): gestión del flujo de datos,
 * backpressure, idle timeout, validación de completitud, y cleanup de recursos.
 *
 * @module ChunkResponseHandler
 */

import { promises as fs } from 'fs';
import fsSync from 'fs';
import crypto from 'crypto';
import config from '../config';
import { logger } from '../utils';
import { DownloadState, ChunkState } from './types';
import { parseRetryAfter } from './DownloadValidator';
import chunkProgressCache from './ChunkProgressAggregator';
import { recordChunkFailure, cleanupActiveChunk, networkConfig } from './ChunkHelpers';
import downloadMetrics from './DownloadMetrics';
import { getRecommendedWriteBufferSize } from './AdaptiveWriteBuffer';
import type { ChunkEngineRef } from './types';

/** Último total de bytes reportado a métricas por descarga (para calcular delta en recordBytes). */
const lastRecordedBytesForMetrics = new Map<number, number>();
import type { Download } from './StateStore';
import type { ChunkRange } from './ChunkHelpers';

const log = logger.child('DownloadEngine');

export interface ChunkResponseLike {
  statusCode: number;
  statusMessage?: string;
  headers: Record<string, string | string[] | undefined>;
  on: (_event: string, _fn: (..._args: unknown[]) => void) => void;
  destroy: () => void;
  pause: () => void;
  resume: () => void;
  destroyed: boolean;
  setMaxListeners: (_n: number) => void;
  complete?: boolean;
}

export async function handleChunkResponse(
  engine: ChunkEngineRef,
  downloadId: number,
  chunkIndex: number,
  chunk: ChunkRange,
  response: ChunkResponseLike,
  request: unknown,
  actualStartByte: number,
  downloadedBytes: number,
  resolve: () => void,
  reject: (_err: Error) => void,
  sessionId: string | null = null
): Promise<void> {
  const stateStore = engine.stateStore;
  const chunkStore = engine.chunkStore;
  const eventBus = engine.eventBus; // Inyectado vía engine para desacoplar del singleton

  let settled = false;
  const safeResolve = (): void => {
    if (settled) return;
    settled = true;
    resolve();
  };
  const safeReject = (err: Error): void => {
    if (settled) return;
    settled = true;
    reject(err);
  };

  const download = stateStore.getDownload(downloadId) as Download | null;
  if (!download) {
    safeReject(new Error('Download not found'));
    response.destroy();
    return;
  }

  const currentSession = sessionId ? engine.sessionManager.getSessionId(downloadId) : null;
  const isSessionInvalid = sessionId != null && currentSession !== sessionId;

  if (isSessionInvalid || download.state !== DownloadState.DOWNLOADING) {
    log.debug(
      `[_handleChunkResponse] Abortando chunk ${chunkIndex}: sesión ${isSessionInvalid ? 'inválida' : 'válida'}, estado: ${download.state}`
    );
    cleanupActiveChunk(engine, downloadId, chunkIndex);
    response.destroy();
    const req = request as { destroyed?: boolean; abort?: () => void };
    if (req && !req.destroyed && req.abort) req.abort();
    safeResolve();
    return;
  }

  if (response.statusCode !== 206 && response.statusCode !== 200) {
    const statusMsg = response.statusMessage || '';
    const hints: Record<number, string> = {
      403: 'acceso denegado',
      404: 'no encontrado',
      429: 'demasiadas peticiones (throttling)',
      503: 'servidor no disponible',
    };
    const hint = hints[response.statusCode] ? ` - ${hints[response.statusCode]}` : '';
    log.error(
      `[Chunk failure] descarga ${downloadId}, chunk ${chunkIndex}: HTTP ${response.statusCode} ${statusMsg}${hint}`
    );
    recordChunkFailure(
      engine,
      downloadId,
      chunkIndex,
      `HTTP ${response.statusCode} ${statusMsg}${hint}`.trim(),
      { errorCode: 'HTTP_ERROR' }
    );
    const err = new Error(`HTTP ${response.statusCode}`) as Error & {
      code?: string;
      retryAfterMs?: number;
    };
    // Manejo unificado de 429 y 503: ambos son retryable con Retry-After.
    if (response.statusCode === 429 || response.statusCode === 503) {
      const retryAfterRaw =
        response.headers && (response.headers['retry-after'] ?? response.headers['Retry-After']);
      const raw = Array.isArray(retryAfterRaw) ? retryAfterRaw[0] : retryAfterRaw;
      const defaultRetryMs = response.statusCode === 503 ? 30000 : 60000;
      const retryAfterMs =
        parseRetryAfter(raw as string | undefined) ??
        (networkConfig()?.retryAfter429DefaultMs as number) ??
        defaultRetryMs;
      err.code = response.statusCode === 429 ? 'HTTP_429' : 'HTTP_503';
      err.retryAfterMs = retryAfterMs;
      // Registrar reintento transient en métricas
      try {
        const host = new URL(download?.url ?? '').hostname;
        downloadMetrics.recordTransientRetry(host);
        // Reportar reintento transient al controlador de concurrencia adaptativa
        engine._recordAdaptiveEvent?.('transient_retry', host);
      } catch {
        /* URL inválida; no bloquear flujo */
      }
      stateStore.updateChunkProgress!(downloadId, chunkIndex, { state: ChunkState.PENDING });
      const label =
        response.statusCode === 429 ? '429 Too Many Requests' : '503 Service Unavailable';
      log.info(
        `[Chunk] descarga ${downloadId}, chunk ${chunkIndex}: ${label}, reintento en ${Math.round(retryAfterMs / 1000)}s${raw ? ` (Retry-After: ${raw})` : ''}`
      );
    } else {
      stateStore.updateChunkProgress!(downloadId, chunkIndex, { state: ChunkState.FAILED });
    }
    safeReject(err);
    return;
  }

  let currentDownloadedBytes = downloadedBytes;
  if (response.statusCode === 200 && actualStartByte > chunk.start) {
    log.warn(
      `[Chunk] descarga ${downloadId}, chunk ${chunkIndex}: servidor no soporta reanudación (Range), reiniciando desde cero`
    );
    currentDownloadedBytes = 0;
    stateStore.updateChunkProgress!(downloadId, chunkIndex, { downloadedBytes: 0 });
  }

  const chunkPath = chunkStore.getChunkPath(downloadId, chunkIndex);
  const chunkSize = chunk.end - chunk.start + 1;
  let writeMode: 'a' | 'w' = currentDownloadedBytes > 0 && response.statusCode === 206 ? 'a' : 'w';

  // Validar integridad del archivo en disco antes de hacer append.
  if (writeMode === 'a') {
    try {
      const diskStats = await fs.stat(chunkPath);
      if (diskStats.size !== currentDownloadedBytes) {
        log.warn(
          `[Chunk] descarga ${downloadId}, chunk ${chunkIndex}: tamaño en disco (${diskStats.size}) difiere del registrado (${currentDownloadedBytes}), reiniciando chunk`
        );
        writeMode = 'w';
        currentDownloadedBytes = 0;
        stateStore.updateChunkProgress!(downloadId, chunkIndex, { downloadedBytes: 0 });
      }
    } catch (statErr) {
      const e = statErr as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        writeMode = 'w';
        currentDownloadedBytes = 0;
        stateStore.updateChunkProgress!(downloadId, chunkIndex, { downloadedBytes: 0 });
      } else {
        log.warn(
          `[Chunk] descarga ${downloadId}, chunk ${chunkIndex}: error verificando archivo previo, reiniciando: ${e.message}`
        );
        writeMode = 'w';
        currentDownloadedBytes = 0;
        stateStore.updateChunkProgress!(downloadId, chunkIndex, { downloadedBytes: 0 });
      }
    }
  }

  try {
    await chunkStore.createChunkDir(downloadId);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    log.error(
      `[Chunk failure] descarga ${downloadId}, chunk ${chunkIndex}: error creando directorio - ${err.code ?? 'DIR_ERROR'}: ${err.message}`,
      error
    );
    recordChunkFailure(engine, downloadId, chunkIndex, (error as Error).message, {
      errorCode: err.code ?? 'DIR_ERROR',
    });
    stateStore.updateChunkProgress!(downloadId, chunkIndex, { state: ChunkState.FAILED });
    safeReject(error as Error);
    return;
  }

  const host = download?.url ? new URL(download.url).hostname : null;
  const chunkWriteBufferSize = getRecommendedWriteBufferSize(host, { forChunk: true });
  const fileStream = fsSync.createWriteStream(chunkPath, {
    flags: writeMode,
    highWaterMark: chunkWriteBufferSize,
  });

  fileStream.setMaxListeners(15);
  response.setMaxListeners(15);

  // Hash SHA-256 incremental para verificación de integridad por chunk.
  // Se inicializa en modo 'w' (nuevo) y se omite en modo 'a' (resume parcial, hash no sería válido).
  const chunkHasher = writeMode === 'w' ? crypto.createHash('sha256') : null;

  let _sessionDownloaded = 0;
  let lastProgressUpdate = Date.now();
  let lastDbUpdate = Date.now();
  const progressInterval =
    (config.downloads as { chunked?: { chunkProgressInterval?: number } })?.chunked
      ?.chunkProgressInterval ?? 500;
  let isPaused = false;

  const chunkKey = `${downloadId}-${chunkIndex}`;
  type ChunkActiveEntry = {
    request: unknown;
    response: unknown;
    fileStream: fsSync.WriteStream;
    timeoutId: ReturnType<typeof setInterval> | null;
    handlers: Record<
      string,
      (() => void) | ((_err: Error) => void) | ((_data: Buffer) => void) | undefined
    >;
    progressCheckInterval?: ReturnType<typeof setInterval>;
    isChunkCompleted?: () => void;
  };
  const chunkActive: ChunkActiveEntry = {
    request,
    response,
    fileStream,
    timeoutId: null,
    handlers: {},
  };
  engine.activeChunks.set(chunkKey, chunkActive);

  /** Teardown centralizado: limpia interval, remueve listeners, marca completado y quita del store. Idempotente. */
  const teardownChunk = (): void => {
    const active = engine.activeChunks.get(chunkKey) as ChunkActiveEntry | undefined;
    if (!active) return;
    if (active.progressCheckInterval) {
      clearInterval(active.progressCheckInterval);
      active.progressCheckInterval = undefined;
    }
    if (active.isChunkCompleted) {
      active.isChunkCompleted();
      active.isChunkCompleted = undefined;
    }
    try {
      const resp = active.response as {
        removeListener?: (_ev: string, _fn: unknown) => void;
        destroyed?: boolean;
      } | null;
      const fStream = active.fileStream;
      if (resp && typeof resp.removeListener === 'function' && active.handlers) {
        if (active.handlers.data) resp.removeListener('data', active.handlers.data);
        if (active.handlers.end) resp.removeListener('end', active.handlers.end);
        if (active.handlers.responseError)
          resp.removeListener('error', active.handlers.responseError);
        if (active.handlers.close) resp.removeListener('close', active.handlers.close);
      }
      if (fStream && !fStream.destroyed && active.handlers) {
        if (active.handlers.fileStreamError)
          fStream.removeListener('error', active.handlers.fileStreamError);
      }
      if (active.handlers) {
        active.handlers.data = undefined;
        active.handlers.end = undefined;
        active.handlers.fileStreamError = undefined;
        active.handlers.responseError = undefined;
        active.handlers.close = undefined;
      }
    } catch (cleanupErr) {
      log.debug?.(
        'Error en teardownChunk (streams ya destruidos):',
        (cleanupErr as Error)?.message
      );
    }
    cleanupActiveChunk(engine, downloadId, chunkIndex);
  };

  let lastProgressBytes = currentDownloadedBytes;
  let lastProgressTime = Date.now();
  const progressTimeout =
    (config.downloads as { chunked?: { chunkIdleTimeout?: number } })?.chunked?.chunkIdleTimeout ??
    (config.network as { idleTimeout?: number })?.idleTimeout ??
    60000;
  let isChunkCompleted = false;

  const progressCheckInterval = setInterval(() => {
    if (isChunkCompleted) {
      clearInterval(progressCheckInterval);
      return;
    }
    const activeChunk = engine.activeChunks.get(chunkKey) as ChunkActiveEntry | undefined;
    if (!activeChunk) {
      clearInterval(progressCheckInterval);
      return;
    }
    const currentBytes =
      chunkProgressCache.getChunkBytes(downloadId, chunkIndex) ?? currentDownloadedBytes;
    const now = Date.now();

    if (currentBytes > lastProgressBytes) {
      lastProgressBytes = currentBytes;
      lastProgressTime = now;
    } else if (now - lastProgressTime > progressTimeout) {
      const progressTimeoutSec = Math.round(progressTimeout / 1000);
      log.warn(
        `[Chunk failure] descarga ${downloadId}, chunk ${chunkIndex}: sin progreso por ${progressTimeoutSec}s (timeout de inactividad), abortando`
      );
      isChunkCompleted = true;
      const req = request as { destroyed?: boolean; abort?: () => void };
      if (req && !req.destroyed && req.abort) req.abort();
      if (response && !response.destroyed) response.destroy();
      if (activeChunk.fileStream && !activeChunk.fileStream.destroyed) {
        activeChunk.fileStream.destroy();
      }
      teardownChunk();
      stateStore.updateChunkProgress!(downloadId, chunkIndex, { state: ChunkState.FAILED });
      const error = new Error(
        `Chunk ${chunkIndex} sin progreso por ${progressTimeoutSec}s (timeout de inactividad)`
      );
      recordChunkFailure(engine, downloadId, chunkIndex, error.message, {
        errorCode: 'PROGRESS_TIMEOUT',
        bytesTransferred: currentBytes,
      });
      safeReject(error);
    }
  }, 5000);

  chunkActive.progressCheckInterval = progressCheckInterval;
  chunkActive.isChunkCompleted = () => {
    isChunkCompleted = true;
    clearInterval(progressCheckInterval);
  };

  const dataHandler = (data: Buffer | string): void => {
    if (
      !fileStream ||
      fileStream.destroyed ||
      (fileStream as { closed?: boolean }).closed ||
      !(fileStream as { writable?: boolean }).writable
    ) {
      if (response && !response.destroyed) response.destroy();
      return;
    }
    const currentDownload = stateStore.getDownload(downloadId) as Download | null;
    const currentSession = sessionId ? engine.sessionManager.getSessionId(downloadId) : null;
    const isSessionInvalid = sessionId != null && currentSession !== sessionId;

    if (
      isSessionInvalid ||
      !currentDownload ||
      currentDownload.state !== DownloadState.DOWNLOADING
    ) {
      log.debug(
        `[dataHandler] Abortando chunk ${chunkIndex}: sesión ${isSessionInvalid ? 'inválida' : 'válida'}, estado: ${currentDownload?.state}`
      );
      isChunkCompleted = true;
      if (response && !response.destroyed) response.destroy();
      const req = request as { destroyed?: boolean; abort?: () => void };
      if (req && !req.destroyed && req.abort) req.abort();
      if (fileStream && !fileStream.destroyed) fileStream.destroy();
      teardownChunk();
      safeResolve();
      return;
    }

    try {
      if (!(fileStream as { writable?: boolean }).writable) {
        if (response && !response.destroyed) response.destroy();
        return;
      }
      const canContinue = fileStream.write(data);
      if (!canContinue && !isPaused && !fileStream.destroyed) {
        isPaused = true;
        response.pause();
        fileStream.once('drain', () => {
          isPaused = false;
          if (!response.destroyed && !fileStream.destroyed) response.resume();
        });
        fileStream.once('close', () => {
          if (isPaused && !response.destroyed) {
            log.debug(
              `[Chunk] descarga ${downloadId}, chunk ${chunkIndex}: fileStream cerrado durante backpressure, destruyendo response`
            );
            response.destroy();
          }
        });
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      log.warn(
        `[Chunk failure] descarga ${downloadId}, chunk ${chunkIndex}: error escribiendo en disco - ${e.code ?? 'WRITE_ERROR'}: ${e.message}`
      );
      isChunkCompleted = true;
      if (response && !response.destroyed) response.destroy();
      const reqAbort = request as { destroyed?: boolean; abort?: () => void };
      if (reqAbort && !reqAbort.destroyed && reqAbort.abort) reqAbort.abort();
      teardownChunk();
      recordChunkFailure(engine, downloadId, chunkIndex, e.message, {
        errorCode: e.code ?? 'WRITE_ERROR',
      });
      stateStore.updateChunkProgress!(downloadId, chunkIndex, { state: ChunkState.FAILED });
      eventBus.emitStateChanged(stateStore.getStateVersion());
      safeReject(e);
      return;
    }

    const dataLen = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    _sessionDownloaded += dataLen;
    currentDownloadedBytes += dataLen;
    if (chunkHasher) chunkHasher.update(data); // Alimentar hash incremental

    const now = Date.now();

    if (now - lastProgressUpdate >= progressInterval) {
      chunkProgressCache.updateBytes(downloadId, chunkIndex, currentDownloadedBytes);
      const totalDownloaded = chunkProgressCache.getTotalDownloaded(downloadId);
      const totalProgress = download.totalBytes > 0 ? totalDownloaded / download.totalBytes : 0;
      const totalChunks = chunkProgressCache.getChunkCount(downloadId);
      const completedChunks = chunkProgressCache.getCompletedCount(downloadId);
      const activeChunksCount = chunkProgressCache.getActiveCount(downloadId);
      const chunkProgressArray = chunkProgressCache.getChunkProgressArray(downloadId);

      engine.speedTracker.ensureTracking(downloadId, download.startedAt ?? now, totalDownloaded);
      const speedResult = engine.speedTracker.update(
        downloadId,
        totalDownloaded,
        download.totalBytes
      );
      const speedBytesPerSec = speedResult ? speedResult.speedBytesPerSec : 0;
      const remainingTime = speedResult ? speedResult.remainingTime : null;
      const speedMBPerSec = speedBytesPerSec / (1024 * 1024);

      if (now - lastDbUpdate >= 1000) {
        stateStore.updateDownload(downloadId, {
          progress: Math.min(totalProgress, 1.0),
          downloadedBytes: totalDownloaded,
        });
        stateStore.updateChunkProgress!(downloadId, chunkIndex, {
          downloadedBytes: currentDownloadedBytes,
        });
        lastDbUpdate = now;
      }

      const prevRecorded = lastRecordedBytesForMetrics.get(downloadId) ?? 0;
      const deltaBytes = totalDownloaded - prevRecorded;
      if (deltaBytes > 0) {
        downloadMetrics.recordBytes(downloadId, deltaBytes);
        lastRecordedBytesForMetrics.set(downloadId, totalDownloaded);
      }

      eventBus.emitDownloadProgress(downloadId, {
        progress: Math.min(totalProgress, 1.0),
        downloadedBytes: totalDownloaded,
        totalBytes: download.totalBytes,
        speed: speedMBPerSec,
        speedBytesPerSec,
        remainingTime,
        chunked: true,
        totalChunks,
        completedChunks,
        activeChunks: activeChunksCount,
        chunkProgress: chunkProgressArray,
      });

      lastProgressUpdate = now;
    }
  };

  response.on('data', dataHandler as (..._args: unknown[]) => void);
  chunkActive.handlers.data = dataHandler as (_data: Buffer) => void;

  let streamDestroyedOnClose = false;
  const endHandler = (): void => {
    const currentDownload = stateStore.getDownload(downloadId) as Download | null;
    const currentSession = sessionId ? engine.sessionManager.getSessionId(downloadId) : null;
    const isSessionInvalid = sessionId != null && currentSession !== sessionId;

    if (
      isSessionInvalid ||
      !currentDownload ||
      currentDownload.state !== DownloadState.DOWNLOADING
    ) {
      log.debug(
        `[endHandler] Ignorando fin de chunk ${chunkIndex}: sesión ${isSessionInvalid ? 'inválida' : 'válida'}, estado: ${currentDownload?.state}`
      );
      teardownChunk();
      safeResolve();
      return;
    }

    const validateAndFinish = (sizeFromDisk: number | null = null): void => {
      const expectedBytes = chunkSize;
      const sizeToCheck = sizeFromDisk !== null ? sizeFromDisk : currentDownloadedBytes;

      if (sizeToCheck >= expectedBytes) {
        const finalBytes = Math.min(sizeToCheck, expectedBytes);
        stateStore.updateChunkProgress!(downloadId, chunkIndex, {
          state: ChunkState.COMPLETED,
          downloadedBytes: finalBytes,
        });
        chunkProgressCache.markCompleted(downloadId, chunkIndex, finalBytes);
        // Almacenar hash SHA-256 para verificación pre-merge
        if (chunkHasher) {
          const hash = chunkHasher.digest('hex');
          chunkProgressCache.setChunkHash(downloadId, chunkIndex, hash);
          log.debug(
            `[Chunk] descarga ${downloadId}, chunk ${chunkIndex}: hash SHA-256 = ${hash.substring(0, 16)}...`
          );
        }
        eventBus.emitChunkCompleted(downloadId, chunkIndex);
        teardownChunk();
        safeResolve();
      } else {
        const causa = streamDestroyedOnClose
          ? ' (causa probable: stream cerrado antes de tiempo)'
          : '';
        log.warn(
          `[Chunk failure] descarga ${downloadId}, chunk ${chunkIndex}: incompleto ${sizeToCheck}/${expectedBytes} bytes${causa}`
        );
        const reason =
          `Incompleto: ${sizeToCheck}/${expectedBytes} bytes` +
          (streamDestroyedOnClose ? ' (stream cerrado antes de tiempo)' : '');
        recordChunkFailure(engine, downloadId, chunkIndex, reason, {
          bytesTransferred: sizeToCheck,
          errorCode: 'CHUNK_INCOMPLETE',
        });
        stateStore.updateChunkProgress!(downloadId, chunkIndex, { state: ChunkState.FAILED });
        teardownChunk();
        eventBus.emitStateChanged(stateStore.getStateVersion());
        safeReject(new Error('Chunk incompleto'));
      }
    };

    const runValidation = (): void => {
      if (streamDestroyedOnClose && chunkPath) {
        fs.stat(chunkPath)
          .then(stats => validateAndFinish(stats.size))
          .catch(err => {
            const e = err as NodeJS.ErrnoException;
            log.warn(
              `[Chunk failure] descarga ${downloadId}, chunk ${chunkIndex}: no se pudo verificar tamaño en disco - ${e.code ?? 'FS_ERROR'}: ${e.message}`
            );
            stateStore.updateChunkProgress!(downloadId, chunkIndex, { state: ChunkState.FAILED });
            teardownChunk();
            eventBus.emitStateChanged(stateStore.getStateVersion());
            safeReject(err as Error);
          });
      } else {
        validateAndFinish();
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
            log.error(
              `[Chunk failure] descarga ${downloadId}, chunk ${chunkIndex}: error cerrando archivo - ${(endError as NodeJS.ErrnoException).code ?? 'STREAM_ERROR'}: ${endError.message}`,
              endError
            );
            recordChunkFailure(engine, downloadId, chunkIndex, endError.message, {
              errorCode: (endError as NodeJS.ErrnoException).code ?? 'STREAM_ERROR',
            });
            stateStore.updateChunkProgress!(downloadId, chunkIndex, { state: ChunkState.FAILED });
            teardownChunk();
            safeReject(endError);
            return;
          }
          streamDestroyedOnClose = true;
          log.warn(
            `[Chunk] descarga ${downloadId}, chunk ${chunkIndex}: stream cerrado con error "destroyed", validando tamaño en disco...`
          );
        }
        runValidation();
      });
    } else {
      log.debug(
        `Stream ya cerrado/no-writable en endHandler de chunk ${chunkIndex}, procediendo a validación`
      );
      runValidation();
    }
  };

  response.on('end', endHandler);
  chunkActive.handlers.end = endHandler;

  const fileStreamErrorHandler = (error: Error): void => {
    const currentSession = sessionId ? engine.sessionManager.getSessionId(downloadId) : null;
    const isSessionInvalid = sessionId != null && currentSession !== sessionId;
    const currentDownload = stateStore.getDownload(downloadId);

    if (
      isSessionInvalid ||
      !currentDownload ||
      currentDownload.state !== DownloadState.DOWNLOADING
    ) {
      log.debug(
        `[fileStreamErrorHandler] Ignorando error en chunk ${chunkIndex}: sesión ${isSessionInvalid ? 'inválida' : 'válida'}, estado: ${currentDownload?.state}`
      );
      teardownChunk();
      safeResolve();
      return;
    }
    const e = error as NodeJS.ErrnoException;
    log.error(
      `[Chunk failure] descarga ${downloadId}, chunk ${chunkIndex}: error en stream de archivo - ${e.code ?? 'STREAM_ERROR'}: ${error.message}`,
      error
    );
    recordChunkFailure(engine, downloadId, chunkIndex, error.message, {
      errorCode: e.code ?? 'STREAM_ERROR',
    });
    if (response && !response.destroyed) response.destroy();
    teardownChunk();
    stateStore.updateChunkProgress!(downloadId, chunkIndex, { state: ChunkState.PENDING });
    eventBus.emitStateChanged(stateStore.getStateVersion());
    safeReject(error);
  };

  fileStream.on('error', fileStreamErrorHandler);
  chunkActive.handlers.fileStreamError = fileStreamErrorHandler;

  const responseErrorHandler = (error: Error): void => {
    const currentSession = sessionId ? engine.sessionManager.getSessionId(downloadId) : null;
    const isSessionInvalid = sessionId != null && currentSession !== sessionId;
    const currentDownload = stateStore.getDownload(downloadId);

    if (
      isSessionInvalid ||
      !currentDownload ||
      currentDownload.state !== DownloadState.DOWNLOADING
    ) {
      log.debug(
        `[responseErrorHandler] Ignorando error en chunk ${chunkIndex}: sesión ${isSessionInvalid ? 'inválida' : 'válida'}, estado: ${currentDownload?.state}`
      );
      teardownChunk();
      safeResolve();
      return;
    }

    if (!error.message.includes('aborted')) {
      const e = error as NodeJS.ErrnoException;
      log.error(
        `[Chunk failure] descarga ${downloadId}, chunk ${chunkIndex}: error en respuesta HTTP - ${e.code ?? 'RESPONSE_ERROR'}: ${error.message}`,
        error
      );
      recordChunkFailure(engine, downloadId, chunkIndex, error.message, {
        errorCode: e.code ?? 'RESPONSE_ERROR',
      });
      if (fileStream && !fileStream.destroyed) fileStream.destroy();
      teardownChunk();
      stateStore.updateChunkProgress!(downloadId, chunkIndex, { state: ChunkState.PENDING });
      eventBus.emitStateChanged(stateStore.getStateVersion());
      safeReject(error);
    } else {
      teardownChunk();
      safeResolve();
    }
  };

  response.on('error', responseErrorHandler as (..._args: unknown[]) => void);
  chunkActive.handlers.responseError = responseErrorHandler;

  const closeHandler = (): void => {
    teardownChunk();
    const responseComplete =
      response && typeof response.complete === 'boolean' && response.complete;
    if (settled || responseComplete) return;
    setImmediate(() => {
      if (settled) return;
      log.warn(
        `[Chunk] descarga ${downloadId}, chunk ${chunkIndex}: conexión cerrada inesperadamente (sin end/error), se reintentará`
      );
      stateStore.updateChunkProgress!(downloadId, chunkIndex, { state: ChunkState.PENDING });
      eventBus.emitStateChanged(stateStore.getStateVersion());
      safeReject(new Error('Connection closed unexpectedly'));
    });
  };

  response.on('close', closeHandler);
  const req = request as { on?: (_ev: string, _fn: () => void) => void };
  if (req && req.on) req.on('close', closeHandler);
  chunkActive.handlers.close = closeHandler;
}
