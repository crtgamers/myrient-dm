/**
 * Gestión del directorio de chunks en disco (userData/temp/chunks/{downloadId}/).
 *
 * Proporciona rutas de chunk (.chunk.{index}), staging para merge, createChunkDir,
 * listChunks, deleteChunk, reconcileChunks (comparar FS vs DB) y cleanupOrphanedDirs.
 * No es transaccional con la DB; el StateStore es la fuente de verdad del estado.
 *
 * @module ChunkStore
 */

import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';
import { logger } from '../utils';

const log = logger.child('ChunkStore');

export interface ChunkInfo {
  index: number;
  path: string;
  size: number;
}

export interface DbChunkLike {
  chunkIndex: number;
  startByte: number;
  endByte: number;
  state: string;
}

export interface ReconcileResult {
  orphaned: ChunkInfo[];
  missing: DbChunkLike[];
  mismatched: { index: number; fsSize: number; expectedSize: number }[];
  total: number;
  inDb: number;
}

export default class ChunkStore {
  private readonly baseTempDir: string;

  constructor() {
    this.baseTempDir = path.join(app.getPath('userData'), 'temp', 'chunks');
  }

  /** Crea el directorio base y comprueba permisos de escritura. */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.baseTempDir, { recursive: true });
      try {
        const testFile = path.join(this.baseTempDir, '.test-write');
        await fs.writeFile(testFile, 'test');
        await fs.unlink(testFile);
      } catch (permError) {
        log.error('Sin permisos de escritura en ChunkStore:', permError);
        throw new Error(`Sin permisos de escritura en ${this.baseTempDir}`);
      }
    } catch (error) {
      log.error('Error inicializando ChunkStore:', error);
      throw error;
    }
  }

  async migrateChunkFromOldSystem(
    oldPath: string,
    downloadId: number,
    chunkIndex: number
  ): Promise<string> {
    const newPath = this.getChunkPath(downloadId, chunkIndex);
    const newDir = path.dirname(newPath);
    await fs.mkdir(newDir, { recursive: true });
    await fs.copyFile(oldPath, newPath);
    log.debug(`Chunk migrado: ${oldPath} → ${newPath}`);
    return newPath;
  }

  getChunkDir(downloadId: number): string {
    return path.join(this.baseTempDir, String(downloadId));
  }

  getChunkPath(downloadId: number, chunkIndex: number): string {
    const chunkDir = this.getChunkDir(downloadId);
    return path.join(chunkDir, `.chunk.${chunkIndex}`);
  }

  getStagingPath(downloadId: number, finalPath: string): string {
    const chunkDir = this.getChunkDir(downloadId);
    const finalName = path.basename(finalPath);
    return path.join(chunkDir, `${finalName}.staging`);
  }

  async createChunkDir(downloadId: number): Promise<string> {
    const chunkDir = this.getChunkDir(downloadId);
    await fs.mkdir(chunkDir, { recursive: true });
    return chunkDir;
  }

  async chunkExists(downloadId: number, chunkIndex: number): Promise<boolean> {
    try {
      const chunkPath = this.getChunkPath(downloadId, chunkIndex);
      await fs.access(chunkPath);
      return true;
    } catch {
      return false;
    }
  }

  async getChunkSize(downloadId: number, chunkIndex: number): Promise<number> {
    try {
      const chunkPath = this.getChunkPath(downloadId, chunkIndex);
      const stats = await fs.stat(chunkPath);
      return stats.size;
    } catch (error) {
      log.warn(
        `Error obteniendo tamaño de chunk ${chunkIndex}:`,
        (error as NodeJS.ErrnoException).message
      );
      return 0;
    }
  }

  async listChunks(downloadId: number): Promise<ChunkInfo[]> {
    try {
      const chunkDir = this.getChunkDir(downloadId);
      const files = await fs.readdir(chunkDir);
      const chunks: ChunkInfo[] = [];
      for (const file of files) {
        const match = file.match(/^\.chunk\.(\d+)$/);
        if (match) {
          const index = parseInt(match[1], 10);
          const chunkPath = path.join(chunkDir, file);
          const stats = await fs.stat(chunkPath);
          chunks.push({ index, path: chunkPath, size: stats.size });
        }
      }
      return chunks.sort((a, b) => a.index - b.index);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      log.error(`Error listando chunks de descarga ${downloadId}:`, error);
      return [];
    }
  }

  async deleteChunk(downloadId: number, chunkIndex: number): Promise<boolean> {
    try {
      const chunkPath = this.getChunkPath(downloadId, chunkIndex);
      await fs.unlink(chunkPath);
      log.debug(`Chunk ${chunkIndex} eliminado: ${chunkPath}`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Error eliminando chunk ${chunkIndex}:`, (error as NodeJS.ErrnoException).message);
      }
      return false;
    }
  }

  async deleteAllChunks(downloadId: number): Promise<number> {
    try {
      const chunks = await this.listChunks(downloadId);
      let deleted = 0;
      for (const chunk of chunks) {
        try {
          await fs.unlink(chunk.path);
          deleted++;
        } catch (error) {
          log.warn(`Error eliminando chunk ${chunk.index}:`, (error as Error).message);
        }
      }
      try {
        const chunkDir = this.getChunkDir(downloadId);
        await fs.rmdir(chunkDir);
      } catch (rmdirErr) {
        log.debug?.(
          `No se pudo eliminar directorio de chunks ${downloadId}:`,
          (rmdirErr as Error)?.message
        );
      }
      log.debug(`Eliminados ${deleted} chunks de descarga ${downloadId}`);
      return deleted;
    } catch (error) {
      log.error(`Error eliminando chunks de descarga ${downloadId}:`, error);
      return 0;
    }
  }

  async reconcileChunks(downloadId: number, dbChunks: DbChunkLike[]): Promise<ReconcileResult> {
    const fsChunks = await this.listChunks(downloadId);
    const dbChunkMap = new Map(dbChunks.map(c => [c.chunkIndex, c]));
    const fsChunkMap = new Map(fsChunks.map(c => [c.index, c]));

    const orphaned: ChunkInfo[] = [];
    const missing: DbChunkLike[] = [];
    const mismatched: { index: number; fsSize: number; expectedSize: number }[] = [];

    for (const fsChunk of fsChunks) {
      const dbChunk = dbChunkMap.get(fsChunk.index);
      if (!dbChunk) {
        orphaned.push(fsChunk);
      } else {
        const expectedSize = dbChunk.endByte - dbChunk.startByte + 1;
        if (fsChunk.size !== expectedSize && dbChunk.state === 'completed') {
          mismatched.push({
            index: fsChunk.index,
            fsSize: fsChunk.size,
            expectedSize,
          });
        }
      }
    }

    for (const dbChunk of dbChunks) {
      if (!fsChunkMap.has(dbChunk.chunkIndex) && dbChunk.state === 'completed') {
        missing.push(dbChunk);
      }
    }

    return {
      orphaned,
      missing,
      mismatched,
      total: fsChunks.length,
      inDb: dbChunks.length,
    };
  }

  async cleanupOrphanedDirs(activeDownloadIds: Set<number>): Promise<number> {
    try {
      try {
        await fs.access(this.baseTempDir);
      } catch {
        log.debug?.('Directorio base de chunks no existe aún, nada que limpiar');
        return 0;
      }
      const dirs = await fs.readdir(this.baseTempDir);
      let cleaned = 0;
      for (const dir of dirs) {
        const downloadId = parseInt(dir, 10);
        if (isNaN(downloadId)) continue;
        if (!activeDownloadIds.has(downloadId)) {
          const dirPath = path.join(this.baseTempDir, dir);
          try {
            await fs.rm(dirPath, { recursive: true, force: true });
            cleaned++;
            log.debug(`Directorio huérfano eliminado: ${dirPath}`);
          } catch (error) {
            log.warn(`Error eliminando directorio huérfano ${dir}:`, (error as Error).message);
          }
        }
      }
      if (cleaned > 0) log.info(`Limpiados ${cleaned} directorios huérfanos de chunks`);
      return cleaned;
    } catch (error) {
      log.error('Error limpiando directorios huérfanos:', error);
      return 0;
    }
  }
}
