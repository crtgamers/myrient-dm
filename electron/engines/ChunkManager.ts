/**
 * Registro en memoria de chunks en descarga: request, response, fileStream, timeouts.
 *
 * Clave: `${downloadId}-${chunkIndex}`. cleanupChunk libera recursos (abort, destroy,
 * clearInterval) y quita la entrada; cleanupForDownload hace cleanup de todos los chunks
 * de una descarga. Usado por ChunkDownloader para cancelar/pausar de forma limpia.
 *
 * @module engines/ChunkManager
 */

import { logger } from '../utils';

const log = logger.child('ChunkManager');

export interface ActiveChunkEntry {
  request?: {
    destroyed?: boolean;
    abort: () => void;
    removeAllListeners: () => void;
    on: (_ev: string, _fn: () => void) => void;
  } | null;
  response?: {
    destroyed?: boolean;
    removeAllListeners: () => void;
    on: (_ev: string, _fn: () => void) => void;
    destroy: () => void;
  } | null;
  fileStream?: {
    destroyed?: boolean;
    closed?: boolean;
    writable?: boolean;
    removeAllListeners: () => void;
    on: (_ev: string, _fn: () => void) => void;
    end: (_cb: () => void) => void;
    destroy: () => void;
  } | null;
  timeoutId?: ReturnType<typeof setTimeout> | null;
  progressCheckInterval?: ReturnType<typeof setInterval> | null;
  handlers?: unknown;
}

/**
 * Gestiona los chunks actualmente en descarga: clave → { request, response, fileStream, timeoutId, handlers }.
 */
export class ChunkManager {
  private _store = new Map<string, ActiveChunkEntry>();

  get store(): Map<string, ActiveChunkEntry> {
    return this._store;
  }

  static key(downloadId: number, chunkIndex: number): string {
    return `${downloadId}-${chunkIndex}`;
  }

  cleanupChunk(chunkKey: string): void {
    const chunkActive = this._store.get(chunkKey);
    if (!chunkActive) return;

    try {
      if (chunkActive.timeoutId) {
        clearTimeout(chunkActive.timeoutId);
        chunkActive.timeoutId = null;
      }

      if (chunkActive.request) {
        if (!chunkActive.request.destroyed) {
          chunkActive.request.abort();
        }
        chunkActive.request.removeAllListeners();
        chunkActive.request.on('error', () => {});
        chunkActive.request.on('close', () => {});
        chunkActive.request = null;
      }

      if (chunkActive.response) {
        chunkActive.response.removeAllListeners();
        chunkActive.response.on('error', () => {});
        chunkActive.response.on('close', () => {});
        if (!chunkActive.response.destroyed) {
          chunkActive.response.destroy();
        }
        chunkActive.response = null;
      }

      if (chunkActive.fileStream) {
        chunkActive.fileStream.removeAllListeners();
        chunkActive.fileStream.on('error', () => {});
        if (!chunkActive.fileStream.destroyed && !chunkActive.fileStream.closed) {
          if (chunkActive.fileStream.writable) {
            chunkActive.fileStream.end(() => {});
          } else {
            chunkActive.fileStream.destroy();
          }
        }
        chunkActive.fileStream = null;
      }

      if (chunkActive.progressCheckInterval) {
        clearInterval(chunkActive.progressCheckInterval);
      }
      chunkActive.handlers = null;
    } catch (error) {
      log.warn(`[ChunkManager] Error limpiando chunk ${chunkKey}:`, (error as Error).message);
    }

    this._store.delete(chunkKey);
  }

  cleanupAll(): void {
    for (const chunkKey of this._store.keys()) {
      const chunkActive = this._store.get(chunkKey);
      if (chunkActive) {
        if (chunkActive.timeoutId) clearTimeout(chunkActive.timeoutId);
        if (chunkActive.request && !chunkActive.request.destroyed) {
          chunkActive.request.abort();
        }
        if (chunkActive.response && !chunkActive.response.destroyed) {
          chunkActive.response.destroy();
        }
        if (chunkActive.fileStream && !chunkActive.fileStream.destroyed) {
          chunkActive.fileStream.destroy();
        }
      }
    }
    this._store.clear();
  }

  cleanupForDownload(downloadId: number): void {
    const prefix = `${downloadId}-`;
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) {
        this.cleanupChunk(key);
      }
    }
  }

  get(chunkKey: string): ActiveChunkEntry | undefined {
    return this._store.get(chunkKey);
  }

  set(chunkKey: string, entry: ActiveChunkEntry): void {
    this._store.set(chunkKey, entry);
  }
}

const chunkManager = new ChunkManager();
export default chunkManager;
