/**
 * Descarga fragmentada por HTTP Range (varios chunks en paralelo).
 *
 * calculateChunks: determina número y tamaño de rangos según config (bandas 50–500 MB, >500 MB).
 * startChunkedDownload: crea chunks en StateStore y ChunkStore, descarga en paralelo con
 * límite maxConcurrentChunks, emite progreso por chunk; al completar todos, el engine
 * ejecuta merge (FileAssembler) y verificación. Recibe ChunkEngineRef (chunkStore, chunkManager,
 * sessionManager, _runWorker para merge).
 *
 * electron net.request usa la pila de Chromium; HTTP/2 se negocia por ALPN y las peticiones
 * al mismo host pueden multiplexarse sobre una sola conexión TCP sin cambios en este módulo.
 *
 * @module ChunkDownloader
 */

import { net } from 'electron';
import { promises as fs, createReadStream } from 'fs';
import crypto from 'crypto';
import config from '../config';
import { logger } from '../utils';
import { isValidUrl } from '../utils/validation';
import { DownloadState, ChunkState } from './types';
import { classifyTransientError, calculateAdaptiveRetryDelay } from './DownloadValidator';
import chunkProgressCache from './ChunkProgressAggregator';
import { calculateAdaptiveChunks } from './AdaptiveChunkSizer';
import type { AdaptiveChunkSizerConfig } from './AdaptiveChunkSizer';
import downloadMetrics from './DownloadMetrics';
import { chunkedConfig, networkConfig, formatBytes, cleanupActiveChunk } from './ChunkHelpers';
import { verifyPartialTail, hashLastNBytes } from '../utils/partialIntegrity';
import type { ChunkRange } from './ChunkHelpers';
import type { ChunkEngineRef } from './types';
import type { Download } from './StateStore';

// Import + re-export desde módulos extraídos para compatibilidad con código que los importaba desde aquí
import { handleChunkResponse } from './ChunkResponseHandler';
import type { ChunkResponseLike } from './ChunkResponseHandler';
export type { ChunkRange, RecordChunkFailureOptions } from './ChunkHelpers';
export { recordChunkFailure, cleanupActiveChunk } from './ChunkHelpers';
export type { ChunkResponseLike } from './ChunkResponseHandler';
export { handleChunkResponse } from './ChunkResponseHandler';

const log = logger.child('DownloadEngine');

/**
 * Opciones opcionales para sizing adaptativo de chunks.
 * Si se proveen `measuredSpeedBps` y `completedSamples`, se usa sizing según velocidad de red medida.
 */
export interface CalculateChunksOptions {
  /** Velocidad promedio medida para el host (bytes/s). null = sin datos. */
  measuredSpeedBps?: number | null;
  /** Descargas completadas para el host (usado para validar muestras mínimas). */
  completedSamples?: number;
}

/**
 * Calcula los rangos byte start/end para descarga fragmentada.
 * Si hay datos de velocidad (options.measuredSpeedBps), usa sizing adaptativo; si no, sizing estático por tamaño de archivo.
 *
 * @param totalBytes - Tamaño total del archivo en bytes.
 * @param options - Datos opcionales de velocidad para sizing adaptativo.
 * @returns Lista de { start, end } para cada chunk.
 * @throws Error si totalBytes no es un número positivo finito.
 */
export function calculateChunks(
  totalBytes: number,
  options?: CalculateChunksOptions
): ChunkRange[] {
  const cfg = chunkedConfig();
  const maxChunks = (cfg.maxChunks as number) ?? 16;
  const minChunks = (cfg.minChunks as number) ?? 2;
  const threshold = (cfg.sizeThreshold as number) ?? 50 * 1024 * 1024;

  if (totalBytes <= 0 || !Number.isFinite(totalBytes)) {
    throw new Error(
      `calculateChunks: totalBytes debe ser un número positivo (recibido: ${totalBytes})`
    );
  }

  if (totalBytes < threshold) {
    log.debug(
      `[calculateChunks] Archivo < 50 MB (${formatBytes(totalBytes)}), usando 1 chunk (descarga directa)`
    );
    return [{ start: 0, end: totalBytes - 1 }];
  }

  // Sizing adaptativo de chunks según velocidad de red si hay datos disponibles
  if (options?.measuredSpeedBps != null) {
    const adaptiveCfg = cfg.adaptiveChunkSizing as AdaptiveChunkSizerConfig | undefined;
    const adaptiveResult = calculateAdaptiveChunks(
      totalBytes,
      options.measuredSpeedBps,
      options.completedSamples ?? 0,
      maxChunks,
      minChunks,
      adaptiveCfg ?? undefined
    );
    if (adaptiveResult) {
      return adaptiveResult.ranges;
    }
    // Si retorna null, caer al sizing estático
  }

  // ----- Sizing estático (comportamiento original) -----

  const mediumMax = (cfg.mediumRangeMaxBytes as number) ?? 500 * 1024 * 1024;
  const useBandStrategy =
    mediumMax > 0 &&
    ((cfg.chunkSizeMediumTarget as number) != null || (cfg.chunkCountMediumMin as number) != null);

  let numChunks: number;
  let chunkSize: number;
  let bandLabel: string;

  if (useBandStrategy) {
    const sizeMediumTarget = (cfg.chunkSizeMediumTarget as number) ?? 8 * 1024 * 1024;
    const countMediumMin = (cfg.chunkCountMediumMin as number) ?? 4;
    const countMediumMax = (cfg.chunkCountMediumMax as number) ?? 8;
    const sizeLargeBase = (cfg.chunkSizeLargeBase as number) ?? 32 * 1024 * 1024;
    const countLargeMin = (cfg.chunkCountLargeMin as number) ?? 8;
    const countLargeMax = Math.min((cfg.chunkCountLargeMax as number) ?? 16, maxChunks);

    if (totalBytes < mediumMax) {
      bandLabel = '50–500 MB';
      numChunks = Math.ceil(totalBytes / sizeMediumTarget);
      numChunks = Math.max(countMediumMin, Math.min(countMediumMax, numChunks));
      numChunks = Math.min(numChunks, maxChunks);
    } else {
      bandLabel = '> 500 MB';
      numChunks = Math.ceil(totalBytes / sizeLargeBase);
      numChunks = Math.max(countLargeMin, Math.min(countLargeMax, numChunks));
      numChunks = Math.min(numChunks, maxChunks);
    }
    chunkSize = Math.ceil(totalBytes / numChunks);
  } else {
    const ranges = (cfg.chunkRanges as { maxSize: number; chunkSize: number }[]) ?? [
      { maxSize: 125 * 1024 * 1024, chunkSize: 12 * 1024 * 1024 },
      { maxSize: 250 * 1024 * 1024, chunkSize: 25 * 1024 * 1024 },
      { maxSize: 1024 * 1024 * 1024, chunkSize: 32 * 1024 * 1024 },
      { maxSize: 5 * 1024 * 1024 * 1024, chunkSize: 32 * 1024 * 1024 },
      { maxSize: Infinity, chunkSize: 64 * 1024 * 1024 },
    ];
    const range = ranges.find(r => totalBytes <= r.maxSize) ?? ranges[ranges.length - 1];
    const baseChunkSize = range.chunkSize;
    numChunks = Math.ceil(totalBytes / baseChunkSize);
    numChunks = Math.max(2, Math.min(numChunks, maxChunks));
    chunkSize = Math.ceil(totalBytes / numChunks);
    bandLabel = `rango ${formatBytes(range.maxSize)}`;
  }

  log.debug(
    `[calculateChunks] ${formatBytes(totalBytes)} → ${numChunks} chunks de ~${formatBytes(chunkSize)} (${bandLabel})`
  );

  const chunks: ChunkRange[] = [];
  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkSize;
    const end =
      i === numChunks - 1 ? totalBytes - 1 : Math.min((i + 1) * chunkSize - 1, totalBytes - 1);
    chunks.push({ start, end });
  }
  return chunks;
}

// formatBytes en ChunkHelpers.ts

// RecordChunkFailureOptions, recordChunkFailure, cleanupActiveChunk en ChunkHelpers.ts

export function abortAllChunksForDownload(engine: ChunkEngineRef, downloadId: number): void {
  engine.chunkManager.cleanupForDownload(downloadId);
}

export async function mergeChunks(
  engine: ChunkEngineRef,
  downloadId: number,
  isRetry = false
): Promise<void> {
  const stateStore = engine.stateStore;
  const eventBus = engine.eventBus; // Inyectado vía engine para desacoplar del singleton

  if (engine.mergeInProgress.has(downloadId)) return;

  const download = stateStore.getDownload(downloadId) as Download | null;
  const allowedStates =
    download?.state === DownloadState.DOWNLOADING || download?.state === DownloadState.MERGING;
  if (!download || !allowedStates) {
    log.warn(
      `[_mergeChunks] Descarga ${downloadId} no está en DOWNLOADING/MERGING (estado: ${download?.state}), abortando merge`
    );
    return;
  }

  engine.mergeInProgress.add(downloadId);

  // Solo transicionar a MERGING si venimos de DOWNLOADING; si ya estamos en MERGING es un reintento
  if (download.state === DownloadState.DOWNLOADING) {
    const transitioned = stateStore.transitionState(downloadId, DownloadState.MERGING);
    if (!transitioned) {
      log.warn(
        `[_mergeChunks] No se pudo transicionar descarga ${downloadId} a MERGING, abortando`
      );
      engine.mergeInProgress.delete(downloadId);
      return;
    }
    eventBus.emitStateChanged(stateStore.getStateVersion());
  }
  eventBus.emitMergeStarted(downloadId);

  try {
    const dbChunks = stateStore.getChunks!(downloadId);
    const chunks: {
      index: number;
      path: string;
      startByte: number;
      endByte: number;
      size: number;
    }[] = [];
    for (const c of dbChunks) {
      if (c.state !== ChunkState.COMPLETED) {
        throw new Error(`Chunk ${c.chunkIndex} no está completado (estado: ${c.state})`);
      }
      const tempFile = c.tempFile ?? '';
      try {
        await fs.access(tempFile);
      } catch (error) {
        log.error(
          `[Chunk failure] descarga ${downloadId}, chunk ${c.chunkIndex}: archivo no encontrado en disco - ${tempFile}`,
          error
        );
        throw new Error(`Chunk ${c.chunkIndex} no encontrado: ${tempFile}`);
      }
      const stats = await fs.stat(tempFile);
      const expectedSize = c.endByte - c.startByte + 1;
      if (stats.size !== expectedSize) {
        log.warn(
          `[Chunk failure] descarga ${downloadId}, chunk ${c.chunkIndex}: tamaño incorrecto en disco ${stats.size}/${expectedSize} bytes`
        );
        let reasonSuffix = '';
        try {
          const attempts = stateStore.getAttempts!(downloadId);
          const lastChunkAttempt = attempts.find(
            (a: { chunkId: number | null }) => a.chunkId === c.id
          );
          if (lastChunkAttempt && (lastChunkAttempt as { error?: string }).error) {
            reasonSuffix = ` Razón: ${(lastChunkAttempt as { error: string }).error}`;
          }
        } catch (attemptErr) {
          log.debug?.(
            `[mergeChunks] No se pudo obtener historial de intentos del chunk ${c.chunkIndex}:`,
            (attemptErr as Error)?.message
          );
        }
        throw new Error(
          `Chunk ${c.chunkIndex} incompleto: ${stats.size}/${expectedSize} bytes. Reintenta la descarga para volver a bajar ese fragmento.${reasonSuffix}`
        );
      }
      chunks.push({
        index: c.chunkIndex,
        path: tempFile,
        startByte: c.startByte,
        endByte: c.endByte,
        size: c.endByte - c.startByte + 1,
      });
    }

    chunks.sort((a, b) => a.index - b.index);

    // Si existe un staging file de un merge previo interrumpido, eliminarlo antes de re-merge
    // antes de iniciar el merge para evitar archivos residuales y un merge sobre datos viejos.
    const stagingPath = `${download.savePath}.staging`;
    try {
      const stagingStats = await fs.stat(stagingPath);
      log.info(
        `[_mergeChunks] Descarga ${downloadId}: staging file previo encontrado (${stagingStats.size} bytes), eliminando antes de re-merge`
      );
      await fs.unlink(stagingPath);
    } catch (stagingErr) {
      const e = stagingErr as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        log.warn(
          `[_mergeChunks] Descarga ${downloadId}: error eliminando staging file previo: ${e.message}`
        );
      }
      // ENOENT = no existe, lo esperado; continuamos
    }

    // Verificación de integridad pre-merge usando hash SHA-256 por chunk
    // Solo verifica chunks que tengan hash almacenado en el aggregator (descargados en esta sesión).
    for (const c of chunks) {
      const expectedHash = chunkProgressCache.getChunkHash(downloadId, c.index);
      if (!expectedHash) continue; // sin hash almacenado (resume de sesión anterior); se omite
      try {
        const fileHash = await new Promise<string>((resolve, reject) => {
          const hasher = crypto.createHash('sha256');
          const stream = createReadStream(c.path);
          stream.on('data', (d: Buffer | string) => hasher.update(d));
          stream.on('end', () => resolve(hasher.digest('hex')));
          stream.on('error', reject);
        });
        if (fileHash !== expectedHash) {
          log.error(
            `[_mergeChunks] Descarga ${downloadId}: chunk ${c.index} corrompido! ` +
              `Hash esperado: ${expectedHash.substring(0, 16)}..., hash actual: ${fileHash.substring(0, 16)}...`
          );
          throw new Error(
            `Chunk ${c.index} falló verificación de integridad (hash mismatch). ` +
              `Esperado: ${expectedHash.substring(0, 16)}..., Actual: ${fileHash.substring(0, 16)}...`
          );
        }
        log.debug(
          `[_mergeChunks] Descarga ${downloadId}: chunk ${c.index} hash OK (${expectedHash.substring(0, 16)}...)`
        );
      } catch (hashErr) {
        if ((hashErr as Error).message.includes('hash mismatch')) throw hashErr;
        log.warn(
          `[_mergeChunks] Descarga ${downloadId}: no se pudo verificar hash de chunk ${c.index}: ${(hashErr as Error).message}`
        );
      }
    }

    await engine._runWorker(
      'ASSEMBLE',
      {
        downloadId,
        chunks,
        finalPath: download.savePath,
        expectedSize: download.totalBytes,
        forceOverwrite: download.forceOverwrite || false,
      },
      (progress: number, bytesProcessed: number) => {
        stateStore.updateDownload(downloadId, {
          progress,
          downloadedBytes: bytesProcessed,
        });
        const mergeStartTime = download.startedAt || Date.now();
        const mergeElapsedSeconds = (Date.now() - mergeStartTime) / 1000;
        const mergeSpeedBytesPerSec =
          mergeElapsedSeconds > 0 ? bytesProcessed / mergeElapsedSeconds : 0;
        const mergeSpeedMBPerSec = mergeSpeedBytesPerSec / (1024 * 1024);
        const remainingBytes = download.totalBytes - bytesProcessed;
        const mergeRemainingTime =
          mergeSpeedBytesPerSec > 0 ? remainingBytes / mergeSpeedBytesPerSec : null;

        eventBus.emitDownloadProgress(downloadId, {
          progress,
          downloadedBytes: bytesProcessed,
          totalBytes: download.totalBytes,
          speed: mergeSpeedMBPerSec,
          speedBytesPerSec: mergeSpeedBytesPerSec,
          remainingTime: mergeRemainingTime,
          merging: true,
          mergeProgress: progress,
          mergeSpeed: mergeSpeedMBPerSec,
          chunked: true,
        });
      }
    );

    eventBus.emitDownloadProgress(downloadId, {
      progress: 1.0,
      downloadedBytes: download.totalBytes,
      totalBytes: download.totalBytes,
      speed: 0,
      speedBytesPerSec: 0,
      remainingTime: 0,
      merging: false,
      mergeProgress: undefined,
      mergeSpeed: undefined,
      chunked: true,
    });

    // Si el usuario canceló durante el merge, no verificar; limpiar y salir
    const stateAfterMerge = stateStore.getDownload(downloadId);
    if (stateAfterMerge?.state === DownloadState.CANCELLED) {
      stateStore.deleteChunks(downloadId);
      await engine.chunkStore
        .deleteAllChunks(downloadId)
        .catch((e: Error) => log.debug?.(`Cleanup chunks ${downloadId}:`, e?.message));
      const stagingPath = `${download.savePath}.staging`;
      await fs
        .unlink(stagingPath)
        .catch((e: Error) => log.debug?.(`Cleanup staging ${downloadId}:`, e?.message));
      await fs
        .unlink(download.savePath ?? '')
        .catch((e: Error) => log.debug?.(`Cleanup savePath ${downloadId}:`, e?.message));
      eventBus.emitStateChanged(stateStore.getStateVersion());
      return;
    }

    stateStore.transitionState(downloadId, DownloadState.VERIFYING, DownloadState.MERGING);
    eventBus.emitStateChanged(stateStore.getStateVersion());
    await engine._verifyDownload(downloadId);
  } catch (error) {
    log.error(`Error en merge de descarga ${downloadId}:`, error);

    // Primer intento: reintentar silenciosamente sin emitir FAILED para evitar flash de error en UI.
    // El estado se mantiene en MERGING (no transitamos a FAILED), así el retry puede reutilizarlo.
    if (!isRetry) {
      log.info(
        `[_mergeChunks] Reintentando merge de descarga ${downloadId} (primer fallo silencioso)`
      );
      engine.mergeInProgress.delete(downloadId);
      try {
        await mergeChunks(engine, downloadId, true);
        return; // Retry exitoso
      } catch (retryErr) {
        // El retry ya emitió FAILED; solo propagamos
        log.warn(
          `[_mergeChunks] Segundo intento de merge falló para descarga ${downloadId}:`,
          (retryErr as Error)?.message
        );
        throw retryErr;
      }
    }

    // Reintento final fallido (isRetry=true): ahora sí emitir FAILED
    stateStore.transitionState(downloadId, DownloadState.FAILED);
    stateStore.updateDownload(downloadId, {
      lastError: (error as Error).message,
    });
    eventBus.emitDownloadFailed(downloadId, error as Error, { failedDuringMerge: true });
    eventBus.emitStateChanged(stateStore.getStateVersion());
    throw error;
  } finally {
    engine.mergeInProgress.delete(downloadId);
    chunkProgressCache.clear(downloadId);
  }
}

export interface ChunkedDownloadInput {
  id: number;
  totalBytes: number;
  savePath: string | null;
  url: string | null;
  forceOverwrite?: boolean;
  startedAt?: number | null;
}

/**
 * Guarda checkpoint de integridad (últimos N bytes) para cada chunk en DOWNLOADING (reanudar después).
 * Debe llamarse antes de pausar una descarga fragmentada.
 */
export async function saveChunkCheckpointsForPause(
  engine: ChunkEngineRef,
  downloadId: number
): Promise<void> {
  const chunks = engine.stateStore.getChunks!(downloadId);
  const downloading = chunks.filter((c: { state: string }) => c.state === ChunkState.DOWNLOADING);
  for (const c of downloading) {
    const chunkPath = engine.chunkStore.getChunkPath(downloadId, c.chunkIndex);
    try {
      const stat = await fs.stat(chunkPath);
      if (stat.size > 0) {
        const tailHash = await hashLastNBytes(chunkPath, stat.size);
        engine.stateStore.updateChunkProgress!(downloadId, c.chunkIndex, {
          tailCheckpointHash: tailHash,
          tailCheckpointSize: stat.size,
        });
      }
    } catch (e) {
      log.debug?.(
        `[O15] No se pudo guardar checkpoint chunk ${c.chunkIndex} descarga ${downloadId}:`,
        (e as Error)?.message
      );
    }
  }
}

export async function startChunkedDownload(
  engine: ChunkEngineRef,
  download: ChunkedDownloadInput
): Promise<void> {
  const stateStore = engine.stateStore;
  const chunkStore = engine.chunkStore;
  const eventBus = engine.eventBus; // Inyectado vía engine para desacoplar del singleton

  stateStore.transitionState(download.id, DownloadState.DOWNLOADING);
  stateStore.updateDownload(download.id, { startedAt: Date.now() });
  eventBus.emitStateChanged(stateStore.getStateVersion());

  const existingChunks = stateStore.getChunks!(download.id);
  let chunks: ChunkRange[];
  let isResume = false;

  if (existingChunks.length > 0) {
    isResume = true;
    log.info(
      `[_startChunkedDownload] Reanudando descarga ${download.id} con ${existingChunks.length} chunks existentes`
    );

    try {
      const reconciliation = await chunkStore.reconcileChunks(download.id, existingChunks);

      if (reconciliation.missing.length > 0) {
        log.warn(
          `[_startChunkedDownload] Descarga ${download.id}: ${reconciliation.missing.length} chunk(s) marcados como COMPLETED pero sin archivo en disco, reseteando a PENDING`
        );
        for (const missingChunk of reconciliation.missing) {
          stateStore.updateChunkProgress!(download.id, missingChunk.chunkIndex, {
            state: ChunkState.PENDING,
            downloadedBytes: 0,
            tempFile: null,
          });
        }
      }

      if (reconciliation.mismatched.length > 0) {
        log.warn(
          `[_startChunkedDownload] Descarga ${download.id}: ${reconciliation.mismatched.length} chunk(s) con tamaño incorrecto, borrando y reseteando a PENDING`
        );
        for (const mismatchedChunk of reconciliation.mismatched) {
          await chunkStore.deleteChunk(download.id, mismatchedChunk.index).catch((e: Error) => {
            log.debug?.(
              `No se pudo borrar chunk mismatched ${mismatchedChunk.index} de descarga ${download.id}:`,
              e?.message
            );
          });
          stateStore.updateChunkProgress!(download.id, mismatchedChunk.index, {
            state: ChunkState.PENDING,
            downloadedBytes: 0,
            tempFile: null,
          });
        }
      }

      if (reconciliation.orphaned.length > 0) {
        log.debug(
          `[_startChunkedDownload] Descarga ${download.id}: ${reconciliation.orphaned.length} chunk(s) huérfanos en disco (serán ignorados)`
        );
      }

      // Audit fix I5: actualizar tempFile en DB para que apunte a la ruta actual
      // (cubre el caso de que baseTempDir haya cambiado desde la última sesión).
      let pathsUpdated = 0;
      for (const dbChunk of existingChunks) {
        if (dbChunk.state === ChunkState.COMPLETED) {
          const currentPath = chunkStore.getChunkPath(download.id, dbChunk.chunkIndex);
          if (dbChunk.tempFile !== currentPath) {
            stateStore.updateChunkProgress!(download.id, dbChunk.chunkIndex, {
              tempFile: currentPath,
            });
            pathsUpdated++;
          }
        }
      }
      if (pathsUpdated > 0) {
        log.info(
          `[_startChunkedDownload] Descarga ${download.id}: actualizadas ${pathsUpdated} rutas de chunks a baseTempDir actual`
        );
      }
    } catch (reconcileError) {
      const msg = reconcileError instanceof Error ? reconcileError.message : String(reconcileError);
      log.warn(
        `[_startChunkedDownload] Error reconciliando chunks para descarga ${download.id}:`,
        msg
      );
    }

    const refreshedChunks = stateStore.getChunks!(download.id);
    chunks = refreshedChunks.map((c: { startByte: number; endByte: number }) => ({
      start: c.startByte,
      end: c.endByte,
    }));

    for (const chunk of refreshedChunks) {
      if (chunk.state === ChunkState.DOWNLOADING) {
        stateStore.updateChunkProgress!(download.id, chunk.chunkIndex, {
          state: ChunkState.PENDING,
        });
      }
    }
  } else {
    // Obtener velocidad medida del host para sizing adaptativo de chunks
    let hostSpeedBps: number | null = null;
    let hostCompletedSamples = 0;
    try {
      if (download.url) {
        const host = new URL(download.url).hostname;
        const hostMetrics = downloadMetrics.getHostMetrics(host);
        if (hostMetrics) {
          hostSpeedBps = hostMetrics.avgSpeedBps;
          hostCompletedSamples = hostMetrics.completedCount;
        }
      }
    } catch {
      /* URL inválida; usar sizing estático */
    }

    chunks = calculateChunks(download.totalBytes, {
      measuredSpeedBps: hostSpeedBps,
      completedSamples: hostCompletedSamples,
    });
    await chunkStore.createChunkDir(download.id);
    const chunkRecords = chunks.map((chunk, index) => ({
      chunkIndex: index,
      startByte: chunk.start,
      endByte: chunk.end,
      tempFile: chunkStore.getChunkPath(download.id, index),
    }));
    stateStore.createChunks!(download.id, chunkRecords);
  }

  const sessionId = engine.sessionManager.createSession(download.id);
  log.debug(`[_startChunkedDownload] Nueva sesión para descarga ${download.id}: ${sessionId}`);

  downloadChunks(engine, download.id, chunks, sessionId).catch(error => {
    log.error(`[sid:${sessionId}] Error en descarga fragmentada ${download.id}:`, error);
    engine._unregisterDownloadHost(download.id);
  });

  log.info(
    `[sid:${sessionId}] Descarga fragmentada ${isResume ? 'reanudada' : 'iniciada'}: ${download.id} (${chunks.length} chunks)`
  );
}

export async function downloadChunks(
  engine: ChunkEngineRef,
  downloadId: number,
  chunks: ChunkRange[],
  sessionId: string
): Promise<void> {
  const stateStore = engine.stateStore;
  const chunkStore = engine.chunkStore;
  const eventBus = engine.eventBus; // Inyectado vía engine para desacoplar del singleton

  log.debug(
    `[_downloadChunks] Iniciando descarga de ${chunks.length} chunks para descarga ${downloadId} (sesión: ${sessionId})`
  );

  const isSessionValid = (): boolean => {
    if (!engine.sessionManager.isCurrent(downloadId, sessionId)) {
      log.debug(
        `[_downloadChunks] Sesión ${sessionId} invalidada (actual: ${engine.sessionManager.getSessionId(downloadId)}), abortando`
      );
      return false;
    }
    return true;
  };

  if (!isSessionValid()) return;

  const _download = stateStore.getDownload(downloadId);
  if (!_download) {
    log.error(`[_downloadChunks] Descarga ${downloadId} no encontrada`);
    return;
  }

  // Límite de chunks en vuelo aplicado por ConcurrencyController (engine.concurrencyController)
  const maxChunkRetries =
    engine.downloadConfigOverrides.maxChunkRetries ??
    (config.downloads as { chunked?: { chunkRetries?: number } })?.chunked?.chunkRetries ??
    3;

  // Caché de progreso in-memory para reducir queries a DB en el hot-path.
  const dbChunksForCache = stateStore.getChunks!(downloadId);
  chunkProgressCache.init(downloadId, dbChunksForCache);

  const chunkRetryCount = new Map<number, number>();
  const pending: { chunkIndex: number; chunk: ChunkRange }[] = chunks.map((chunk, index) => ({
    chunkIndex: index,
    chunk,
  }));
  const active = new Map<
    number,
    Promise<{ chunkIndex: number; status: string; value?: void; reason?: unknown }>
  >();
  let retryQueue: { chunkIndex: number; chunk: ChunkRange }[] = [];
  let lastRetryErrors: string[] = [];
  let lastRetryReasons: unknown[] = [];

  const timeoutMinutes =
    engine.downloadConfigOverrides.chunkOperationTimeoutMinutes ??
    (config.downloads as { chunked?: { chunkOperationTimeoutMinutes?: number } })?.chunked
      ?.chunkOperationTimeoutMinutes ??
    5;
  const chunkOperationTimeoutMs = Math.max(1, timeoutMinutes) * 60 * 1000;

  const withChunkTimeout = (promise: Promise<void>, chunkIndex: number): Promise<void> => {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<void>((_, reject) => {
      timeoutId = setTimeout(() => {
        cleanupActiveChunk(engine, downloadId, chunkIndex);
        const timeoutSec = chunkOperationTimeoutMs / 1000;
        reject(
          new Error(
            `Chunk ${chunkIndex} de descarga ${downloadId} sin respuesta en ${timeoutSec}s (timeout de operación)`
          )
        );
      }, chunkOperationTimeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId!);
    });
  };

  const checkAndMerge = async (): Promise<void> => {
    if (!isSessionValid()) return;
    if (engine.mergeInProgress.has(downloadId)) return;

    const currentDownload = stateStore.getDownload(downloadId);
    if (!currentDownload || currentDownload.state !== DownloadState.DOWNLOADING) return;

    // Usar caché in-memory en lugar de query a DB
    if (!chunkProgressCache.has(downloadId) || chunkProgressCache.getChunkCount(downloadId) === 0)
      return;
    if (chunkProgressCache.allCompleted(downloadId)) {
      if (!isSessionValid()) return;
      if (engine.mergeInProgress.has(downloadId)) return;
      await mergeChunks(engine, downloadId);
    }
  };

  /** true si el merge se completó vía incremental (no llamar checkAndMerge al salir). */
  let incrementalCompleted = false;

  const startOne = (chunkIndex: number, chunk: ChunkRange): void => {
    const promise = withChunkTimeout(
      downloadSingleChunk(engine, downloadId, chunkIndex, chunk, sessionId),
      chunkIndex
    ).then(
      value => ({ chunkIndex, status: 'fulfilled', value }),
      reason => ({ chunkIndex, status: 'rejected', reason })
    );
    active.set(chunkIndex, promise);
  };

  const applyRetryDelay = (
    retryItems: { chunkIndex: number }[],
    _isConnErr: boolean,
    retryReasons: unknown[] = []
  ): number => {
    const maxRetriesInBatch = Math.max(
      ...retryItems.map(({ chunkIndex }) => chunkRetryCount.get(chunkIndex) ?? 1),
      1
    );

    // Clasificación adaptativa del error más representativo del batch para retry
    const representativeError = retryReasons.find(r => r && r instanceof Error) as
      | (Error & { code?: string; retryAfterMs?: number })
      | undefined;

    // Si hay un Retry-After explícito (429/503), respetar ese valor
    const hasRetryableCode = retryReasons.some(
      r =>
        r &&
        typeof r === 'object' &&
        ((r as { code?: string }).code === 'HTTP_429' ||
          (r as { code?: string }).code === 'HTTP_503')
    );
    if (hasRetryableCode) {
      const retryAfterValues = retryReasons
        .filter(
          r => r && typeof r === 'object' && (r as { retryAfterMs?: number }).retryAfterMs != null
        )
        .map(r => (r as { retryAfterMs: number }).retryAfterMs);
      const minRetryMs = (networkConfig()?.retryAfter429DefaultMs as number) ?? 60000;
      const resolvedRetryMs =
        retryAfterValues.length > 0 ? Math.max(...retryAfterValues, minRetryMs) : minRetryMs;
      return resolvedRetryMs;
    }

    // Calcular delay de retry según el tipo de error (perfiles en config)
    const adaptiveDelay = calculateAdaptiveRetryDelay(maxRetriesInBatch - 1, representativeError);
    return adaptiveDelay;
  };

  const isConnectionError = (errList: string[]): boolean =>
    errList.some(err => {
      const errLower = String(err).toLowerCase();
      return (
        errLower.includes('destroyed') ||
        errLower.includes('incompleto') ||
        errLower.includes('stream') ||
        errLower.includes('socket') ||
        errLower.includes('econnreset') ||
        errLower.includes('econnrefused') ||
        errLower.includes('etimedout') ||
        errLower.includes('timeout') ||
        errLower.includes('aborted') ||
        errLower.includes('connection closed')
      );
    });

  while (true) {
    if (!isSessionValid()) return;
    if (stateStore.getDownload(downloadId)?.state !== DownloadState.DOWNLOADING) return;

    while (pending.length > 0 && engine.concurrencyController.acquireChunkSlot(downloadId)) {
      const item = pending.shift()!;
      startOne(item.chunkIndex, item.chunk);
    }

    if (active.size === 0) {
      if (retryQueue.length > 0) {
        const delayMs = applyRetryDelay(
          retryQueue,
          isConnectionError(lastRetryErrors),
          lastRetryReasons
        );
        if (delayMs > 0) {
          const reasonRetryable = lastRetryReasons.some(
            r =>
              r &&
              typeof r === 'object' &&
              ((r as { code?: string }).code === 'HTTP_429' ||
                (r as { code?: string }).code === 'HTTP_503')
          );
          // Incluir tipo de error clasificado en el label para diagnóstico
          const representativeErr = lastRetryReasons.find(r => r && r instanceof Error) as
            | (Error & { code?: string })
            | undefined;
          const classifiedType = representativeErr
            ? classifyTransientError(representativeErr)
            : 'unknown';
          const retryLabel = reasonRetryable
            ? lastRetryReasons.some(
                r => r && typeof r === 'object' && (r as { code?: string }).code === 'HTTP_429'
              )
              ? ' [429 Too Many Requests]'
              : ' [503 Service Unavailable]'
            : ` [${classifiedType}]`;
          log.info(
            `[_downloadChunks] Esperando ${Math.round(delayMs / 1000)}s antes de reintentar ${retryQueue.length} chunk(s)${retryLabel}`
          );
          await new Promise(r => setTimeout(r, delayMs));
        }
        for (const { chunkIndex } of retryQueue) {
          stateStore.updateChunkProgress!(downloadId, chunkIndex, {
            state: ChunkState.PENDING,
            downloadedBytes: 0,
            tempFile: null,
          });
          chunkProgressCache.resetChunk(downloadId, chunkIndex);
          await chunkStore.deleteChunk(downloadId, chunkIndex).catch((e: Error) => {
            log.debug?.(
              `No se pudo borrar chunk ${chunkIndex} para retry de descarga ${downloadId}:`,
              e?.message
            );
          });
        }
        eventBus.emitStateChanged(stateStore.getStateVersion());
        pending.push(...retryQueue);
        retryQueue = [];
        lastRetryErrors = [];
        lastRetryReasons = [];
        continue;
      }
      break;
    }

    const raceResult = await Promise.race(active.values());
    const { chunkIndex, status, reason } = raceResult;
    active.delete(chunkIndex);
    engine.concurrencyController.releaseChunkSlot(downloadId);

    if (status === 'fulfilled') {
      // Merge incremental: escribir al staging a medida que los chunks completan en orden
      const download = stateStore.getDownload(downloadId);
      if (
        download?.savePath != null &&
        download.totalBytes != null &&
        typeof download.totalBytes === 'number'
      ) {
        let session = engine.getIncrementalMergeSession(downloadId);
        if (!session) {
          session = engine.createIncrementalMergeSession(
            downloadId,
            download.savePath,
            download.totalBytes,
            chunks.length
          );
        }
        const chunkPath = chunkStore.getChunkPath(downloadId, chunkIndex);
        const chunk = chunks[chunkIndex];
        const chunkSize = chunk.end - chunk.start + 1;
        try {
          const result = await session.appendChunk(chunkIndex, chunkPath, chunkSize);
          if (result.complete) {
            incrementalCompleted = true;
            engine.mergeInProgress.add(downloadId);
            stateStore.transitionState(
              downloadId,
              DownloadState.MERGING,
              DownloadState.DOWNLOADING
            );
            eventBus.emitStateChanged(stateStore.getStateVersion());
            await session.finalize(download.forceOverwrite ?? false);
            engine.removeIncrementalMergeSession(downloadId);
            engine.mergeInProgress.delete(downloadId);
            stateStore.transitionState(downloadId, DownloadState.VERIFYING, DownloadState.MERGING);
            eventBus.emitStateChanged(stateStore.getStateVersion());
            await engine._verifyDownload(downloadId);
            chunkProgressCache.clear(downloadId);
            return;
          }
        } catch (incErr) {
          log.error(`[O13] Error en merge incremental descarga ${downloadId}:`, incErr);
          engine.removeIncrementalMergeSession(downloadId);
          try {
            await fs.unlink(chunkStore.getStagingPath(downloadId, download.savePath));
          } catch {
            /* ignore */
          }
        }
      }
      await checkAndMerge();
      continue;
    }

    const error = (reason as Error) || new Error('Unknown chunk error');
    const chunk = chunks[chunkIndex];
    const retries = (chunkRetryCount.get(chunkIndex) ?? 0) + 1;
    chunkRetryCount.set(chunkIndex, retries);
    const errorMessage = error instanceof Error ? error.message : String(error);
    lastRetryErrors.push(errorMessage);
    lastRetryReasons.push(error);
    eventBus.emitChunkFailed(downloadId, chunkIndex, errorMessage, retries <= maxChunkRetries);
    eventBus.emitStateChanged(stateStore.getStateVersion());

    if (retries > maxChunkRetries) {
      log.error(
        `[sid:${sessionId}] [Chunk failure] descarga ${downloadId}, chunk ${chunkIndex} falló tras ${retries} intentos (máx: ${maxChunkRetries}). Abortando. Último error: ${errorMessage}`,
        error
      );
      abortAllChunksForDownload(engine, downloadId);
      stateStore.transitionState(downloadId, DownloadState.FAILED);
      stateStore.updateDownload(downloadId, { lastError: error.message });
      eventBus.emitDownloadFailed(downloadId, error);
      eventBus.emitStateChanged(stateStore.getStateVersion());
      chunkProgressCache.clear(downloadId);
      throw error;
    }

    log.info(
      `[sid:${sessionId}] [_downloadChunks] descarga ${downloadId}, chunk ${chunkIndex} falló (intento ${retries}/${maxChunkRetries}): ${errorMessage}. Reintentando...`
    );
    retryQueue.push({ chunkIndex, chunk });
  }

  if (!incrementalCompleted) await checkAndMerge();
}

export async function downloadSingleChunk(
  engine: ChunkEngineRef,
  downloadId: number,
  chunkIndex: number,
  chunk: ChunkRange | null = null,
  sessionId: string | null = null
): Promise<void> {
  const stateStore = engine.stateStore;
  const chunkStore = engine.chunkStore;
  const eventBus = engine.eventBus; // Inyectado vía engine para desacoplar del singleton
  const download = stateStore.getDownload(downloadId) as Download | null;

  if (sessionId) {
    const currentSession = engine.sessionManager.getSessionId(downloadId);
    if (currentSession !== sessionId) {
      log.debug(
        `[_downloadSingleChunk] Sesión invalidada antes de iniciar chunk ${chunkIndex} (sesión actual: ${currentSession}, iniciada con: ${sessionId})`
      );
      return;
    }
  }

  if (!download || download.state !== DownloadState.DOWNLOADING) {
    log.debug(
      `[_downloadSingleChunk] Descarga ${downloadId} no está en DOWNLOADING (estado: ${download?.state}), abortando chunk ${chunkIndex}`
    );
    return;
  }

  if (!download.url || !isValidUrl(download.url)) {
    throw new Error(`URL inválida o no permitida para descarga ${downloadId}`);
  }

  let chunkRange: ChunkRange;
  if (!chunk) {
    const chunks = stateStore.getChunks!(downloadId);
    const dbChunkFound = chunks.find((c: { chunkIndex: number }) => c.chunkIndex === chunkIndex);
    if (dbChunkFound) {
      chunkRange = {
        start: dbChunkFound.startByte,
        end: dbChunkFound.endByte,
      };
    } else {
      throw new Error(`Chunk ${chunkIndex} no encontrado para retry`);
    }
  } else {
    chunkRange = chunk;
  }

  const chunkPath = chunkStore.getChunkPath(downloadId, chunkIndex);
  const dbChunk = stateStore.getChunks!(downloadId).find(
    (c: { chunkIndex: number }) => c.chunkIndex === chunkIndex
  );
  let downloadedBytes = dbChunk?.downloadedBytes ?? 0;
  const chunkSize = chunkRange.end - chunkRange.start + 1;

  // Unificar verificación de stat para evitar doble fs.stat en el flujo.
  // Si el chunk está COMPLETED, verificamos tamaño y reutilizamos el resultado.
  let alreadyStatted = false;

  if (dbChunk?.state === ChunkState.COMPLETED) {
    try {
      const stats = await fs.stat(chunkPath);
      alreadyStatted = true;
      if (stats.size === chunkSize) {
        log.debug(
          `[_downloadSingleChunk] Chunk ${chunkIndex} ya está COMPLETED y verificado (${stats.size} bytes), saltando`
        );
        eventBus.emitChunkCompleted(downloadId, chunkIndex);
        return;
      }
      log.warn(
        `[_downloadSingleChunk] Chunk ${chunkIndex} marcado como COMPLETED pero tamaño incorrecto (${stats.size}/${chunkSize} bytes), re-descargando`
      );
      await chunkStore.deleteChunk(downloadId, chunkIndex).catch((e: Error) => {
        log.debug?.(
          `No se pudo borrar chunk ${chunkIndex} con tamaño incorrecto de descarga ${downloadId}:`,
          e?.message
        );
      });
      stateStore.updateChunkProgress!(downloadId, chunkIndex, {
        state: ChunkState.PENDING,
        downloadedBytes: 0,
        tempFile: null,
      });
      downloadedBytes = 0;
    } catch (e) {
      alreadyStatted = true; // archivo no existe o error; no necesitamos re-stat
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        log.warn(
          `[_downloadSingleChunk] Chunk ${chunkIndex} marcado como COMPLETED pero archivo no encontrado en disco, re-descargando`
        );
      } else {
        log.warn(
          `[_downloadSingleChunk] Error verificando chunk ${chunkIndex} COMPLETED:`,
          err.message
        );
      }
      stateStore.updateChunkProgress!(downloadId, chunkIndex, {
        state: ChunkState.PENDING,
        downloadedBytes: 0,
        tempFile: null,
      });
      downloadedBytes = 0;
    }
  }

  // Solo hacer stat si no se hizo arriba (evitar doble I/O)
  if (!alreadyStatted) {
    try {
      const stats = await fs.stat(chunkPath);
      if (stats.size > chunkSize) {
        log.warn(
          `Chunk ${chunkIndex} tiene ${stats.size} bytes (esperado máx ${chunkSize}), re-descargando desde cero`
        );
        await chunkStore.deleteChunk(downloadId, chunkIndex).catch((e: Error) => {
          log.debug?.(
            `No se pudo borrar chunk ${chunkIndex} oversized de descarga ${downloadId}:`,
            e?.message
          );
        });
        stateStore.updateChunkProgress!(downloadId, chunkIndex, {
          state: ChunkState.PENDING,
          downloadedBytes: 0,
          tempFile: null,
        });
        downloadedBytes = 0;
      } else if (stats.size > downloadedBytes) {
        downloadedBytes = stats.size;
        stateStore.updateChunkProgress!(downloadId, chunkIndex, { downloadedBytes });
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        log.warn(`No se pudo leer tamaño de chunk ${chunkIndex}:`, err.message);
      }
    }
  }

  // Verificación de integridad parcial del chunk al reanudar
  if (
    downloadedBytes > 0 &&
    dbChunk?.tailCheckpointHash != null &&
    dbChunk?.tailCheckpointSize != null
  ) {
    try {
      const stats = await fs.stat(chunkPath);
      if (stats.size === dbChunk.tailCheckpointSize) {
        const ok = await verifyPartialTail(
          chunkPath,
          dbChunk.tailCheckpointSize,
          dbChunk.tailCheckpointHash
        );
        if (!ok) {
          log.warn(
            `[O15] Integridad parcial chunk ${chunkIndex} descarga ${downloadId} fallida, re-descargando`
          );
          await chunkStore.deleteChunk(downloadId, chunkIndex).catch(() => {});
          stateStore.updateChunkProgress!(downloadId, chunkIndex, {
            state: ChunkState.PENDING,
            downloadedBytes: 0,
            tempFile: null,
            tailCheckpointHash: null,
            tailCheckpointSize: null,
          });
          downloadedBytes = 0;
        }
      }
    } catch {
      /* ignore; seguir con downloadedBytes actual */
    }
  }

  if (downloadedBytes >= chunkSize) {
    stateStore.updateChunkProgress!(downloadId, chunkIndex, { state: ChunkState.COMPLETED });
    chunkProgressCache.markCompleted(downloadId, chunkIndex, downloadedBytes);
    eventBus.emitChunkCompleted(downloadId, chunkIndex);
    return;
  }

  stateStore.updateChunkProgress!(downloadId, chunkIndex, {
    state: ChunkState.DOWNLOADING,
    tempFile: chunkPath,
  });
  chunkProgressCache.updateState(downloadId, chunkIndex, ChunkState.DOWNLOADING);

  const actualStartByte = chunkRange.start + downloadedBytes;
  const bytesToDownload = chunkRange.end - actualStartByte + 1;

  if (bytesToDownload <= 0) {
    stateStore.updateChunkProgress!(downloadId, chunkIndex, {
      state: ChunkState.COMPLETED,
      downloadedBytes: chunkSize,
    });
    chunkProgressCache.markCompleted(downloadId, chunkIndex, chunkSize);
    eventBus.emitChunkCompleted(downloadId, chunkIndex);
    return;
  }

  log.debug(
    `[_downloadSingleChunk] Chunk ${chunkIndex}: iniciando descarga de ${bytesToDownload} bytes (desde byte ${actualStartByte})`
  );

  const timeout =
    (config.downloads as { chunked?: { chunkResponseTimeout?: number } })?.chunked
      ?.chunkResponseTimeout ??
    (config.network as { timeout?: number })?.timeout ??
    (config.network as { responseTimeout?: number })?.responseTimeout ??
    30000;

  const circuitBreaker = engine._getHostCircuitBreaker(download.url!);
  type ReqLike = {
    setHeader: (_k: string, _v: string) => void;
    on: (_ev: string, _fn: (..._a: unknown[]) => void) => void;
    end: () => void;
    destroyed?: boolean;
    abort?: () => void;
  };

  const urlOrigin = (() => {
    try {
      return new URL(download.url!).origin + '/';
    } catch {
      return 'https://myrient.erista.me/';
    }
  })();
  const setupHeaders = (req: ReqLike): void => {
    req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    req.setHeader('Referer', urlOrigin);
    req.setHeader('Accept', '*/*');
    req.setHeader('Connection', 'keep-alive');
    req.setHeader('Cache-Control', 'no-store');
    req.setHeader('Range', `bytes=${actualStartByte}-${chunkRange.end}`);
  };

  let request: ReqLike;
  if (circuitBreaker && (config.circuitBreaker as { enabled?: boolean })?.enabled) {
    request = (await circuitBreaker.execute(
      async () => {
        const req = net.request({ url: download.url! }) as ReqLike;
        setupHeaders(req);
        return req;
      },
      () => {
        throw new Error('Circuit breaker abierto para chunks');
      }
    )) as ReqLike;
  } else {
    request = net.request({ url: download.url! }) as ReqLike;
    setupHeaders(request);
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  timeoutId = setTimeout(() => {
    if (request && !request.destroyed) {
      log.warn(
        `[Chunk failure] descarga ${downloadId}, chunk ${chunkIndex}: timeout sin respuesta en ${timeout}ms (primera respuesta del servidor)`
      );
      if (request.abort) request.abort();
    }
  }, timeout);

  const chunkKey = `${downloadId}-${chunkIndex}`;
  engine.activeChunks.set(chunkKey, {
    request,
    response: null,
    fileStream: null,
    timeoutId,
    downloadId,
    chunkIndex,
  });

  return new Promise<void>((resolve, reject) => {
    request.on('response', (response: unknown) => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
      handleChunkResponse(
        engine,
        downloadId,
        chunkIndex,
        chunkRange,
        response as ChunkResponseLike,
        request,
        actualStartByte,
        downloadedBytes,
        resolve,
        reject,
        sessionId
      );
    });

    log.debug(`[_downloadSingleChunk] Chunk ${chunkIndex}: request creada, enviando...`);

    request.on('error', (error: unknown) => {
      if (timeoutId) clearTimeout(timeoutId);
      const err = error instanceof Error ? error : new Error(String(error));

      if (sessionId) {
        const currentSession = engine.sessionManager.getSessionId(downloadId);
        if (currentSession !== sessionId) {
          log.debug(
            `[_downloadSingleChunk] Sesión invalidada en error de chunk ${chunkIndex}, abortando`
          );
          resolve();
          return;
        }
      }

      const errCode = (err as NodeJS.ErrnoException).code || (err as Error).name || 'UNKNOWN';
      log.error(
        `[Chunk failure] descarga ${downloadId}, chunk ${chunkIndex}: error en request - ${errCode}: ${err.message}`,
        err
      );

      const attempts = stateStore.getAttempts!(downloadId);
      const chunkAttempts = attempts
        ? attempts.filter((a: { chunkId: number | null }) => a.chunkId === dbChunk?.id)
        : [];
      const attemptNumber = chunkAttempts.length + 1;

      stateStore.recordAttempt!({
        downloadId,
        chunkId: dbChunk?.id ?? null,
        attemptNumber,
        error: err.message,
        errorCode: (err as NodeJS.ErrnoException).code ?? null,
      });
      stateStore.updateChunkProgress!(downloadId, chunkIndex, { state: ChunkState.PENDING });
      cleanupActiveChunk(engine, downloadId, chunkIndex);
      reject(err);
    });

    request.end();
  });
}

// ChunkResponseLike y handleChunkResponse en ChunkResponseHandler.ts
