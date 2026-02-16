/**
 * @fileoverview Worker thread para fusión de chunks
 * @module workers/chunkMerger
 */

import { parentPort } from 'worker_threads';
import { promises as fs } from 'fs';

const BUFFER_SIZE = 16 * 1024 * 1024; // 16MB
const BATCH_SIZE = 8 * 1024 * 1024; // 8MB
const PROGRESS_INTERVAL = 0.05;

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

interface ChunkInput {
  tempFile: string;
  startByte: number;
  endByte: number;
}

async function mergeChunks(
  chunks: ChunkInput[],
  savePath: string,
  totalBytes: number,
  downloadId: number
): Promise<void> {
  let finalHandle: fs.FileHandle | null = null;
  let position = 0;
  let totalProcessed = 0;
  const startTime = Date.now();

  try {
    finalHandle = await fs.open(savePath, 'w');

    parentPort!.postMessage({
      type: 'progress',
      progress: 0,
      currentChunk: 0,
      totalChunks: chunks.length,
      bytesProcessed: 0,
      totalBytes,
    });

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkSize = chunk.endByte - chunk.startByte + 1;
      const chunkFile = chunk.tempFile;

      try {
        await fs.access(chunkFile);
      } catch (e) {
        throw new Error(`Chunk ${i} no encontrado: ${chunkFile}`);
      }

      const chunkHandle = await fs.open(chunkFile, 'r');
      const buffer = Buffer.allocUnsafe(Math.min(BUFFER_SIZE, chunkSize));

      try {
        let bytesProcessed = 0;
        let lastProgressUpdate = 0;

        while (bytesProcessed < chunkSize) {
          const toRead = Math.min(Math.min(buffer.length, BATCH_SIZE), chunkSize - bytesProcessed);

          const { bytesRead } = await chunkHandle.read(buffer, 0, toRead, bytesProcessed);

          if (bytesRead === 0) break;

          await finalHandle.write(buffer, 0, bytesRead, position);

          position += bytesRead;
          bytesProcessed += bytesRead;
          totalProcessed += bytesRead;

          const chunkProgress = bytesProcessed / chunkSize;
          const overallProgress = (i + chunkProgress) / chunks.length;

          if (overallProgress - lastProgressUpdate >= PROGRESS_INTERVAL) {
            lastProgressUpdate = overallProgress;

            parentPort!.postMessage({
              type: 'progress',
              progress: overallProgress,
              currentChunk: i + 1,
              totalChunks: chunks.length,
              bytesProcessed: totalProcessed,
              totalBytes,
              chunkProgress,
              speed: totalProcessed / ((Date.now() - startTime) / 1000),
            });
          }
        }

        if (bytesProcessed < chunkSize) {
          throw new Error(`Chunk ${i} incompleto: ${bytesProcessed}/${chunkSize} bytes`);
        }
      } finally {
        await chunkHandle.close();
      }

      try {
        await fs.unlink(chunkFile);
      } catch (e) {
        parentPort!.postMessage({
          type: 'warning',
          message: `No se pudo eliminar chunk ${i}: ${(e as Error).message}`,
        });
      }

      const chunkProgress = Math.min(1.0, totalProcessed / totalBytes);
      parentPort!.postMessage({
        type: 'progress',
        progress: chunkProgress,
        currentChunk: i + 1,
        totalChunks: chunks.length,
        bytesProcessed: totalProcessed,
        totalBytes,
        speed: totalProcessed / ((Date.now() - startTime) / 1000),
      });
    }

    await finalHandle.close();
    finalHandle = null;

    const stats = await fs.stat(savePath);
    if (stats.size !== totalBytes) {
      throw new Error(`Tamaño final incorrecto: ${stats.size}/${totalBytes} bytes`);
    }

    const duration = (Date.now() - startTime) / 1000;
    const speed = totalBytes / duration;

    parentPort!.postMessage({
      type: 'progress',
      progress: 1.0,
      currentChunk: chunks.length,
      totalChunks: chunks.length,
      bytesProcessed: totalBytes,
      totalBytes,
      speed,
    });

    await new Promise(resolve => setTimeout(resolve, 150));

    parentPort!.postMessage({
      type: 'complete',
      savePath,
      totalBytes,
      duration,
      speed,
      formatBytes: formatBytes(totalBytes),
      formatSpeed: formatBytes(speed) + '/s',
      totalChunks: chunks.length,
    });
  } catch (error) {
    if (finalHandle) {
      try {
        await finalHandle.close();
      } catch (e) {
        parentPort!.postMessage({
          type: 'warning',
          message: `Error al cerrar handle después de error: ${(e as Error).message}`,
        });
      }
    }

    parentPort!.postMessage({
      type: 'error',
      error: {
        message: (error as Error).message || 'Error desconocido en merge de chunks',
        stack: (error as Error).stack,
        code: (error as NodeJS.ErrnoException).code || 'MERGE_ERROR',
        name: (error as Error).name || 'Error',
        downloadId,
        savePath,
        totalBytes,
        chunksCount: chunks ? chunks.length : 0,
        timestamp: Date.now(),
      },
    });
  }
}

interface MergeMessage {
  type: string;
  chunks?: ChunkInput[];
  savePath?: string;
  totalBytes?: number;
  downloadId?: number;
}

parentPort!.on('message', async (message: MergeMessage) => {
  if (message.type === 'merge') {
    const { chunks, savePath, totalBytes, downloadId } = message;

    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      parentPort!.postMessage({
        type: 'error',
        error: { message: 'Chunks inválidos o vacíos' },
      });
      return;
    }

    if (!savePath || !totalBytes) {
      parentPort!.postMessage({
        type: 'error',
        error: { message: 'savePath o totalBytes no proporcionados' },
      });
      return;
    }

    await mergeChunks(chunks, savePath, totalBytes, downloadId ?? 0);
  } else if (message.type === 'cancel') {
    parentPort!.postMessage({
      type: 'cancelled',
      message: 'Merge cancelado',
    });
  }
});

process.on('uncaughtException', (error: Error) => {
  parentPort!.postMessage({
    type: 'error',
    error: {
      message: error.message,
      stack: error.stack,
      code: 'UNCAUGHT_EXCEPTION',
      name: error.name || 'Error',
      timestamp: Date.now(),
    },
  });

  setTimeout(() => {
    process.exit(1);
  }, 100);
});

process.on('unhandledRejection', (reason: unknown) => {
  const errorMessage =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'Rejection no manejado en worker de merge';

  const errorStack = reason instanceof Error ? reason.stack : undefined;

  parentPort!.postMessage({
    type: 'error',
    error: {
      message: errorMessage,
      stack: errorStack,
      code: 'UNHANDLED_REJECTION',
      name: reason instanceof Error ? reason.name : 'Rejection',
      reason: reason instanceof Error ? undefined : String(reason),
      timestamp: Date.now(),
    },
  });

  setTimeout(() => {
    process.exit(1);
  }, 100);
});
