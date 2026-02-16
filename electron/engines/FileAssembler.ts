/**
 * Fusión de chunks en un único archivo final de forma atómica (staging + rename).
 *
 * assemble: escribe en archivo .staging en el directorio de chunks del downloadId,
 * concatena los chunks en orden, llama onProgress, borra chunks al terminar y renombra
 * staging al path final. Valida espacio antes de empezar. Usado por el engine tras
 * completar todos los chunks de una descarga fragmentada.
 *
 * @module FileAssembler
 */

import { promises as fs } from 'fs';
import path from 'path';
import { logger, validateDiskSpace } from '../utils';
import config from '../config';
import { BufferPool } from './BufferPool';
import type ChunkStore from './ChunkStore';

const log = logger.child('FileAssembler');

// Pool de buffers reutilizables para operaciones de merge (main process).
const bufferPoolCfg = config.bufferPool;
const assemblerBufferPool = new BufferPool(bufferPoolCfg?.bufferSize ?? 16 * 1024 * 1024, {
  maxPooled: bufferPoolCfg?.maxPooled ?? 4,
  preAllocate: bufferPoolCfg?.preAllocate ?? false,
  name: 'FileAssembler',
});

export interface ChunkToAssemble {
  index: number;
  path: string;
  startByte?: number;
  endByte?: number;
  size?: number;
}

export interface AssembleResult {
  success: boolean;
  finalPath: string;
  bytesProcessed: number;
  duration: number;
  speed: number;
  chunksDeleted: number;
}

/** Sesión de merge incremental: escribe al staging a medida que los chunks completan en orden. */
export interface IncrementalMergeSession {
  appendChunk(
    _chunkIndex: number,
    _chunkPath: string,
    _chunkSize: number
  ): Promise<{ complete: boolean }>;
  finalize(_forceOverwrite?: boolean): Promise<void>;
}

/** Implementación de sesión de merge incremental (orden de chunks, buffer de llegada fuera de orden). */
class IncrementalMergeSessionImpl implements IncrementalMergeSession {
  private readonly downloadId: number;
  private readonly finalPath: string;
  private readonly expectedSize: number;
  private readonly chunkCount: number;
  private readonly chunkStore: ChunkStore;
  private readonly stagingPath: string;
  private stagingHandle: fs.FileHandle | null = null;
  private nextExpected = 0;
  private readonly pending = new Map<number, { path: string; size: number }>();
  private bytesWritten = 0;
  private finalized = false;

  constructor(
    downloadId: number,
    finalPath: string,
    expectedSize: number,
    chunkCount: number,
    chunkStore: ChunkStore
  ) {
    this.downloadId = downloadId;
    this.finalPath = finalPath;
    this.expectedSize = expectedSize;
    this.chunkCount = chunkCount;
    this.chunkStore = chunkStore;
    this.stagingPath = chunkStore.getStagingPath(downloadId, finalPath);
  }

  private async ensureStagingOpen(): Promise<void> {
    if (this.stagingHandle != null) return;
    const finalDir = path.dirname(this.finalPath);
    await fs.mkdir(finalDir, { recursive: true });
    await this.chunkStore.createChunkDir(this.downloadId);
    try {
      await fs.unlink(this.stagingPath);
    } catch {
      /* ENOENT ok */
    }
    const { validateDiskSpace } = await import('../utils');
    const requiredSpace = Math.ceil(this.expectedSize * 1.1);
    const spaceCheck = await validateDiskSpace(finalDir, requiredSpace);
    if (!spaceCheck.valid) {
      throw new Error(
        `Espacio insuficiente para merge incremental: ${spaceCheck.error ?? 'No hay espacio suficiente en disco'}`
      );
    }
    this.stagingHandle = await fs.open(this.stagingPath, 'w');
  }

  private async writeChunkToStaging(chunkPath: string, chunkSize: number): Promise<void> {
    const handle = await fs.open(chunkPath, 'r');
    const buffer = assemblerBufferPool.acquire();
    try {
      let offset = 0;
      while (offset < chunkSize) {
        const toRead = Math.min(buffer.length, chunkSize - offset);
        const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
        if (bytesRead === 0) break;
        await this.stagingHandle!.write(buffer, 0, bytesRead, this.bytesWritten);
        this.bytesWritten += bytesRead;
        offset += bytesRead;
      }
      if (offset < chunkSize) {
        throw new Error(`Chunk incompleto al leer para merge incremental: ${offset}/${chunkSize}`);
      }
    } finally {
      assemblerBufferPool.release(buffer);
      await handle.close();
    }
  }

  async appendChunk(
    chunkIndex: number,
    chunkPath: string,
    chunkSize: number
  ): Promise<{ complete: boolean }> {
    if (this.finalized) return { complete: false };
    if (chunkIndex !== this.nextExpected) {
      this.pending.set(chunkIndex, { path: chunkPath, size: chunkSize });
      return { complete: false };
    }
    await this.ensureStagingOpen();
    await this.writeChunkToStaging(chunkPath, chunkSize);
    this.nextExpected++;
    while (this.pending.has(this.nextExpected)) {
      const next = this.pending.get(this.nextExpected)!;
      this.pending.delete(this.nextExpected);
      await this.writeChunkToStaging(next.path, next.size);
      this.nextExpected++;
    }
    const complete = this.nextExpected >= this.chunkCount;
    return { complete };
  }

  async finalize(forceOverwrite = false): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.stagingHandle) {
      await this.stagingHandle.close();
      this.stagingHandle = null;
    }
    const stagingStats = await fs.stat(this.stagingPath);
    if (stagingStats.size !== this.expectedSize) {
      try {
        await fs.unlink(this.stagingPath);
      } catch {
        /* ignore */
      }
      throw new Error(
        `Tamaño incorrecto después de merge incremental: ${stagingStats.size}/${this.expectedSize} bytes`
      );
    }
    if (forceOverwrite) {
      try {
        await fs.unlink(this.finalPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(
            `Error eliminando archivo existente antes del rename: ${(err as Error).message}`
          );
        }
      }
    }
    await fs.rename(this.stagingPath, this.finalPath);
    log.info(`[O13] Merge incremental completado: ${this.finalPath}`);
    for (let i = 0; i < this.chunkCount; i++) {
      const chunkPath = this.chunkStore.getChunkPath(this.downloadId, i);
      try {
        await fs.unlink(chunkPath);
      } catch (error) {
        log.warn(
          `[Chunk] descarga ${this.downloadId}, error eliminando chunk ${i} tras merge incremental: ${(error as NodeJS.ErrnoException).code ?? 'FS_ERROR'}: ${(error as Error).message}`
        );
      }
    }
    try {
      const chunkDir = this.chunkStore.getChunkDir(this.downloadId);
      await fs.rmdir(chunkDir);
    } catch (rmdirErr) {
      log.debug?.(
        `No se pudo eliminar directorio de chunks ${this.downloadId}:`,
        (rmdirErr as Error)?.message
      );
    }
  }
}

export default class FileAssembler {
  private readonly chunkStore: ChunkStore;

  constructor(chunkStore: ChunkStore) {
    this.chunkStore = chunkStore;
  }

  /** Devuelve estadísticas del buffer pool del assembler. */
  static getBufferPoolStats(): Record<string, unknown> {
    return assemblerBufferPool.getStats() as unknown as Record<string, unknown>;
  }

  /** Libera todos los buffers retenidos en el pool. */
  static drainBufferPool(): void {
    assemblerBufferPool.drain();
  }

  /** Inicia una sesión de merge incremental (escribir al staging a medida que los chunks completan en orden). */
  startIncrementalMerge(
    downloadId: number,
    finalPath: string,
    expectedSize: number,
    chunkCount: number
  ): IncrementalMergeSession {
    return new IncrementalMergeSessionImpl(
      downloadId,
      finalPath,
      expectedSize,
      chunkCount,
      this.chunkStore
    );
  }

  /**
   * Concatena los chunks en orden en un archivo staging y lo renombra a finalPath.
   * Doble buffering: pre-lectura del siguiente bloque mientras se escribe el actual.
   *
   * @returns AssembleResult con success, finalPath, bytesProcessed, duration, speed, chunksDeleted.
   */
  async assemble(
    downloadId: number,
    chunks: ChunkToAssemble[],
    finalPath: string,
    expectedSize: number,
    onProgress: ((_progress: number, _bytesProcessed: number) => void) | null = null,
    forceOverwrite = false
  ): Promise<AssembleResult> {
    const stagingPath = this.chunkStore.getStagingPath(downloadId, finalPath);
    let stagingHandle: fs.FileHandle | null = null;
    let bytesProcessed = 0;
    const startTime = Date.now();

    try {
      const finalDir = path.dirname(finalPath);
      await fs.mkdir(finalDir, { recursive: true });
      await this.cleanStagingFiles(downloadId, finalPath);

      const requiredSpace = Math.ceil(expectedSize * 1.1);
      const spaceCheck = await validateDiskSpace(finalDir, requiredSpace);
      if (!spaceCheck.valid) {
        throw new Error(
          `Espacio insuficiente para merge: ${spaceCheck.error ?? 'No hay espacio suficiente en disco'}`
        );
      }

      stagingHandle = await fs.open(stagingPath, 'w');
      const sortedChunks = [...chunks].sort((a, b) => a.index - b.index);

      for (const chunk of sortedChunks) {
        try {
          await fs.access(chunk.path);
        } catch {
          throw new Error(`Chunk ${chunk.index} no encontrado: ${chunk.path}`);
        }
      }

      // Dos buffers para solapar lectura del siguiente bloque con escritura del actual
      const bufA = assemblerBufferPool.acquire();
      const bufB = assemblerBufferPool.acquire();

      try {
        let chunkIndex = 0;
        let offsetInChunk = 0;
        let chunkHandle: fs.FileHandle | null = null;
        let chunkSize = 0;
        let writeBuf: Buffer = bufA;
        let writeLen = 0;
        let writeOffset = 0;
        let useBuf = 0; // 0 = bufA, 1 = bufB

        const openChunk = async (idx: number): Promise<number> => {
          if (idx >= sortedChunks.length) return 0;
          const ch = sortedChunks[idx];
          let size = ch.size;
          if (size == null && ch.startByte !== undefined && ch.endByte !== undefined) {
            size = ch.endByte - ch.startByte + 1;
          }
          if (!size) {
            const stats = await fs.stat(ch.path);
            size = stats.size;
          }
          if (chunkHandle) await chunkHandle.close();
          chunkHandle = await fs.open(ch.path, 'r');
          return size;
        };

        // Primera lectura: chunk 0
        chunkSize = await openChunk(0);
        if (chunkSize === 0 && sortedChunks.length > 0) {
          const ch = sortedChunks[0];
          const stats = await fs.stat(ch.path);
          chunkSize = stats.size;
        }
        if (chunkSize > 0) {
          const toRead = Math.min(bufA.length, chunkSize);
          const { bytesRead } = await chunkHandle!.read(bufA, 0, toRead, 0);
          if (bytesRead === 0) {
            throw new Error(`Chunk ${sortedChunks[0].index} no pudo leerse`);
          }
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
              if (onProgress) onProgress(bytesProcessed / expectedSize, bytesProcessed);
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
          if (onProgress) onProgress(bytesProcessed / expectedSize, bytesProcessed);
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
        assemblerBufferPool.release(bufA);
        assemblerBufferPool.release(bufB);
      }

      await stagingHandle.close();
      stagingHandle = null;

      const stagingStats = await fs.stat(stagingPath);
      if (stagingStats.size !== expectedSize) {
        throw new Error(
          `Tamaño incorrecto después de merge: ${stagingStats.size}/${expectedSize} bytes`
        );
      }

      if (forceOverwrite) {
        try {
          await fs.unlink(finalPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.warn(
              `Error eliminando archivo existente antes del rename: ${(err as Error).message}`
            );
          }
        }
      }
      await fs.rename(stagingPath, finalPath);
      log.info(`Archivo final creado: ${finalPath}`);

      const duration = (Date.now() - startTime) / 1000;
      const speed = bytesProcessed / duration;

      let chunksDeleted = 0;
      for (const chunk of sortedChunks) {
        try {
          await fs.unlink(chunk.path);
          chunksDeleted++;
        } catch (error) {
          log.warn(
            `[Chunk] descarga ${downloadId}, error eliminando chunk ${chunk.index} tras merge: ${(error as NodeJS.ErrnoException).code ?? 'FS_ERROR'}: ${(error as Error).message}`
          );
        }
      }

      try {
        const chunkDir = this.chunkStore.getChunkDir(downloadId);
        await fs.rmdir(chunkDir);
      } catch (rmdirErr) {
        log.debug?.(
          `No se pudo eliminar directorio de chunks ${downloadId}:`,
          (rmdirErr as Error)?.message
        );
      }

      log.info(`Ensamblaje completado: ${chunksDeleted}/${sortedChunks.length} chunks eliminados`);

      return {
        success: true,
        finalPath,
        bytesProcessed,
        duration,
        speed,
        chunksDeleted,
      };
    } catch (error) {
      if (stagingHandle) {
        try {
          await stagingHandle.close();
        } catch (closeErr) {
          log.debug?.('Error cerrando handle staging:', (closeErr as Error)?.message);
        }
      }
      try {
        await fs.unlink(stagingPath);
      } catch (unlinkErr) {
        log.debug?.('Error eliminando archivo staging:', (unlinkErr as Error)?.message);
      }
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOSPC') {
        throw new Error('Disco lleno: No hay espacio suficiente para el archivo final');
      }
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        throw new Error(`Sin permisos: No se puede escribir en ${path.dirname(finalPath)}`);
      }
      log.error('Error en ensamblaje:', error);
      throw error;
    }
  }

  async cleanStagingFiles(downloadId: number, finalPath: string): Promise<void> {
    try {
      const stagingPath = this.chunkStore.getStagingPath(downloadId, finalPath);
      await fs.unlink(stagingPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Error limpiando staging para ${downloadId}: ${(error as Error).message}`);
      }
    }
  }

  async verifySize(filePath: string, expectedSize: number): Promise<boolean> {
    try {
      const stats = await fs.stat(filePath);
      return stats.size === expectedSize;
    } catch (statErr) {
      log.debug?.('No se pudo verificar tamaño de archivo:', (statErr as Error)?.message);
      return false;
    }
  }
}
