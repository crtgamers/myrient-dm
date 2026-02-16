/**
 * @fileoverview Worker thread para descarga y ensamblaje de chunks
 * @module workers/downloadWorker
 */

import { parentPort } from 'worker_threads';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { BufferPool } from '../engines/BufferPool.js';

const BUFFER_SIZE = 16 * 1024 * 1024; // 16MB

// Pool de buffers reutilizables para el worker thread.
// Instancia local al thread (no compartida con main process).
const workerBufferPool = new BufferPool(BUFFER_SIZE, {
  maxPooled: 2,
  name: 'WorkerBufferPool',
});

interface ChunkInput {
  path: string;
  index: number;
  startByte?: number;
  endByte?: number;
}

async function calculateHash(filePath: string, reportProgress = false): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stats = await fs.stat(filePath);
  const fileHandle = await fs.open(filePath, 'r');
  // Adquirir buffer del pool en lugar de alocar por operación
  const buffer = workerBufferPool.acquire();
  let bytesRead = 0;

  try {
    while (bytesRead < stats.size) {
      const toRead = Math.min(buffer.length, stats.size - bytesRead);
      const { bytesRead: read } = await fileHandle.read(buffer, 0, toRead, bytesRead);

      if (read === 0) break;

      hash.update(buffer.subarray(0, read));
      bytesRead += read;

      if (reportProgress) {
        parentPort!.postMessage({
          type: 'PROGRESS',
          progress: bytesRead / stats.size,
          bytesProcessed: bytesRead,
        });
      }
    }

    return hash.digest('hex');
  } finally {
    // Devolver buffer al pool para reutilización
    workerBufferPool.release(buffer);
    await fileHandle.close();
  }
}

async function assembleFile(
  _downloadId: number,
  chunks: ChunkInput[],
  finalPath: string,
  expectedSize: number,
  forceOverwrite = false
): Promise<{
  success: boolean;
  finalPath?: string;
  bytesProcessed?: number;
  duration?: number;
  chunksDeleted?: number;
  error?: string;
}> {
  const stagingPath = `${finalPath}.staging`;
  let stagingHandle: fs.FileHandle | null = null;
  let bytesProcessed = 0;
  const startTime = Date.now();

  try {
    const finalDir = path.dirname(finalPath);
    await fs.mkdir(finalDir, { recursive: true });

    try {
      await fs.unlink(stagingPath);
    } catch (unlinkErr) {
      // Staging anterior no existía, continuar
      if ((unlinkErr as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn('[Worker] Error eliminando staging previo:', (unlinkErr as Error)?.message);
      }
    }

    stagingHandle = await fs.open(stagingPath, 'w');

    const sortedChunks = [...chunks].sort((a, b) => a.index - b.index);

    for (const chunk of sortedChunks) {
      await fs.access(chunk.path);
    }

    // Doble buffering: pre-lectura del siguiente bloque mientras se escribe el actual
    const bufA = workerBufferPool.acquire();
    const bufB = workerBufferPool.acquire();
    let lastReportedProgress = 0;
    const PROGRESS_STEP = 0.02;

    try {
      let chunkIndex = 0;
      let offsetInChunk = 0;
      let chunkHandle: fs.FileHandle | null = null;
      let chunkSize = 0;
      let writeBuf: Buffer = bufA;
      let writeLen = 0;
      let writeOffset = 0;
      let useBuf = 0;

      const openChunk = async (idx: number): Promise<number> => {
        if (idx >= sortedChunks.length) return 0;
        const ch = sortedChunks[idx];
        let size = 0;
        if (ch.startByte !== undefined && ch.endByte !== undefined) {
          size = ch.endByte - ch.startByte + 1;
        } else {
          const stats = await fs.stat(ch.path);
          size = stats.size;
        }
        if (chunkHandle) await chunkHandle.close();
        chunkHandle = await fs.open(ch.path, 'r');
        return size;
      };

      chunkSize = await openChunk(0);
      if (chunkSize > 0) {
        const toRead = Math.min(bufA.length, chunkSize);
        const { bytesRead } = await chunkHandle!.read(bufA, 0, toRead, 0);
        if (bytesRead === 0) throw new Error(`Chunk ${sortedChunks[0].index} no pudo leerse`);
        writeBuf = bufA;
        writeLen = bytesRead;
        writeOffset = 0;
        offsetInChunk = bytesRead;
        if (offsetInChunk >= chunkSize) {
          await chunkHandle!.close();
          chunkHandle = null;
          chunkIndex = 1;
        }
      }

      while (true) {
        if (chunkIndex >= sortedChunks.length) {
          if (writeLen > 0) {
            await stagingHandle.write(writeBuf, 0, writeLen, writeOffset);
            bytesProcessed += writeLen;
            const progress = bytesProcessed / expectedSize;
            if (progress - lastReportedProgress >= PROGRESS_STEP || progress >= 1) {
              lastReportedProgress = progress;
              parentPort!.postMessage({ type: 'PROGRESS', progress, bytesProcessed });
            }
          }
          break;
        }

        if (!chunkHandle) {
          chunkSize = await openChunk(chunkIndex);
          offsetInChunk = 0;
        }

        const toRead = Math.min((useBuf === 0 ? bufB : bufA).length, chunkSize - offsetInChunk);
        if (toRead <= 0) {
          if (chunkHandle) {
            await (chunkHandle as unknown as { close(): Promise<void> }).close();
            chunkHandle = null;
          }
          chunkIndex++;
          continue;
        }

        const fillBuf = useBuf === 0 ? bufB : bufA;
        const [, readResult] = await Promise.all([
          stagingHandle.write(writeBuf, 0, writeLen, writeOffset),
          chunkHandle!.read(fillBuf, 0, toRead, offsetInChunk),
        ]);
        const bytesRead = readResult.bytesRead;
        bytesProcessed += writeLen;
        const progress = bytesProcessed / expectedSize;
        if (progress - lastReportedProgress >= PROGRESS_STEP || progress >= 1) {
          lastReportedProgress = progress;
          parentPort!.postMessage({ type: 'PROGRESS', progress, bytesProcessed });
        }
        if (bytesRead === 0) break;

        writeBuf = fillBuf;
        writeLen = bytesRead;
        writeOffset = bytesProcessed;
        offsetInChunk += bytesRead;
        if (offsetInChunk >= chunkSize) {
          await (chunkHandle as unknown as { close(): Promise<void> }).close();
          chunkHandle = null;
          chunkIndex++;
        }
        useBuf = 1 - useBuf;
      }

      if (chunkHandle) await (chunkHandle as unknown as { close(): Promise<void> }).close();
    } finally {
      workerBufferPool.release(bufA);
      workerBufferPool.release(bufB);
    }

    await stagingHandle.close();
    stagingHandle = null;

    const stagingStats = await fs.stat(stagingPath);
    if (stagingStats.size !== expectedSize) {
      throw new Error(`Tamaño incorrecto: ${stagingStats.size}/${expectedSize}`);
    }

    if (forceOverwrite) {
      try {
        await fs.unlink(finalPath);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') {
          throw err;
        }
      }
    }
    await fs.rename(stagingPath, finalPath);

    let chunksDeleted = 0;
    for (const chunk of sortedChunks) {
      try {
        await fs.unlink(chunk.path);
        chunksDeleted++;
      } catch (delErr) {
        console.warn(`[Worker] Error eliminando chunk ${chunk.index}:`, (delErr as Error)?.message);
      }
    }

    try {
      const chunkDir = path.dirname(sortedChunks[0].path);
      await fs.rmdir(chunkDir);
    } catch (rmdirErr) {
      console.debug?.(
        '[Worker] No se pudo eliminar directorio de chunks:',
        (rmdirErr as Error)?.message
      );
    }

    return {
      success: true,
      finalPath,
      bytesProcessed,
      duration: (Date.now() - startTime) / 1000,
      chunksDeleted,
    };
  } catch (error) {
    if (stagingHandle)
      await stagingHandle.close().catch((e: Error) => {
        console.debug?.('[Worker] Error cerrando handle staging:', e?.message);
      });
    await fs.unlink(stagingPath).catch((e: Error) => {
      console.debug?.('[Worker] Error eliminando staging en cleanup:', e?.message);
    });
    throw error;
  }
}

interface TaskMessage {
  type: string;
  taskId?: string | number;
  filePath?: string;
  downloadId?: number;
  chunks?: ChunkInput[];
  finalPath?: string;
  expectedSize?: number;
  forceOverwrite?: boolean;
}

parentPort!.on('message', async (task: TaskMessage) => {
  // Health check: responder PING con PONG inmediatamente
  if (task.type === 'PING') {
    parentPort!.postMessage({ type: 'PONG', taskId: task.taskId });
    return;
  }

  try {
    let result: Record<string, unknown>;

    switch (task.type) {
      case 'VERIFY_HASH': {
        const hash = await calculateHash(task.filePath!, true);
        result = { hash };
        break;
      }

      case 'ASSEMBLE':
        result = await assembleFile(
          task.downloadId!,
          task.chunks!,
          task.finalPath!,
          task.expectedSize!,
          task.forceOverwrite ?? false
        );
        break;

      default:
        throw new Error(`Tipo de tarea desconocido: ${task.type}`);
    }

    parentPort!.postMessage({
      type: 'SUCCESS',
      taskId: task.taskId,
      result,
    });
  } catch (error) {
    parentPort!.postMessage({
      type: 'ERROR',
      taskId: task.taskId,
      error: (error as Error).message,
    });
  }
});
