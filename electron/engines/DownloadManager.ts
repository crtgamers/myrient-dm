/**
 * Registro en memoria de descargas simples en curso: request, response, fileStream, timeoutId.
 *
 * Una entrada por downloadId. cleanup(downloadId) aborta request, destruye response/stream,
 * detiene SpeedTracker y quita la entrada. Usado por SimpleDownloader y DownloadEngine
 * para pausar/cancelar de forma limpia.
 *
 * @module engines/DownloadManager
 */

import { logger } from '../utils';
import speedTracker from './SpeedTracker';

const log = logger.child('DownloadManager');

export interface ActiveDownloadEntry {
  request?: { destroyed?: boolean; abort: () => void; removeAllListeners: () => void } | null;
  response?: { destroyed?: boolean; removeAllListeners: () => void; destroy: () => void } | null;
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
  /** Interval de detección de inactividad para descargas simples. */
  idleCheckInterval?: ReturnType<typeof setInterval> | null;
  handlers?: unknown;
}

/**
 * Gestiona las descargas actualmente en curso (una entrada por downloadId con request, response, fileStream).
 */
export class DownloadManager {
  private _store = new Map<number, ActiveDownloadEntry>();
  private speedTrackerRef = speedTracker;

  get store(): Map<number, ActiveDownloadEntry> {
    return this._store;
  }

  cleanup(downloadId: number): void {
    const active = this._store.get(downloadId);
    if (!active) return;

    try {
      if (active.timeoutId) {
        clearTimeout(active.timeoutId);
        active.timeoutId = null;
      }

      if (active.idleCheckInterval) {
        clearInterval(active.idleCheckInterval);
        active.idleCheckInterval = null;
      }

      if (active.request) {
        if (!active.request.destroyed) {
          active.request.abort();
        }
        active.request.removeAllListeners();
        active.request = null;
      }

      this.speedTrackerRef.stopTracking(downloadId);

      if (active.response) {
        active.response.removeAllListeners();
        if (!active.response.destroyed) {
          active.response.destroy();
        }
        active.response = null;
      }

      if (active.fileStream) {
        active.fileStream.removeAllListeners();
        active.fileStream.on('error', () => {});

        if (!active.fileStream.destroyed && !active.fileStream.closed) {
          if (active.fileStream.writable) {
            active.fileStream.end(() => {});
          } else {
            active.fileStream.destroy();
          }
        }
        active.fileStream = null;
      }

      active.handlers = null;
    } catch (error) {
      log.warn(`Error limpiando descarga activa ${downloadId}:`, (error as Error).message);
    }

    this._store.delete(downloadId);
  }

  /** Obtiene la entrada activa (para que el engine pueda registrar request/response/stream). */
  get(downloadId: number): ActiveDownloadEntry | undefined {
    return this._store.get(downloadId);
  }

  /** Registra una descarga activa. */
  set(downloadId: number, entry: ActiveDownloadEntry): void {
    this._store.set(downloadId, entry);
  }
}

const downloadManager = new DownloadManager();
export default downloadManager;
