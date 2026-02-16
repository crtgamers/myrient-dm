/**
 * Bus de eventos entre el motor de descargas y el renderer (vía ipcStateHandlers).
 *
 * Emite: stateChanged, downloadProgress, downloadCompleted, downloadFailed,
 * chunkCompleted, chunkFailed, mergeStarted, verificationStarted, needsConfirmation.
 * emitStateChanged va debounced para coalescer cambios rápidos.
 *
 * @module EventBus
 */

import EventEmitter from 'events';
import config from '../config';

export interface DownloadCompletedMetadata {
  title?: string;
  savePath?: string;
}

export interface DownloadProgressPayload {
  [key: string]: unknown;
}

export interface FileInfoPayload {
  [key: string]: unknown;
}

const stateChangeDebounceMs =
  (config.ui as { stateChangeDebounceMs?: number })?.stateChangeDebounceMs ?? 50;

/**
 * Singleton de EventEmitter con setMaxListeners(100) para el motor de descargas.
 */
class EventBus extends EventEmitter {
  private _stateChangePending: number | null = null;
  private _stateChangeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  /** Notifica que el estado de la cola cambió; el frontend puede pedir getSnapshot(minVersion). Va debounced. */
  emitStateChanged(stateVersion: number): void {
    this._stateChangePending = stateVersion;
    if (this._stateChangeTimer != null) return;
    this._stateChangeTimer = setTimeout(() => {
      this._stateChangeTimer = null;
      const v = this._stateChangePending;
      this._stateChangePending = null;
      if (v != null) {
        this.emit('stateChanged', { stateVersion: v, timestamp: Date.now() });
      }
    }, stateChangeDebounceMs);
  }

  emitDownloadCompleted(downloadId: number, metadata: DownloadCompletedMetadata = {}): void {
    this.emit('downloadCompleted', {
      downloadId,
      title: metadata.title,
      savePath: metadata.savePath,
      timestamp: Date.now(),
    });
  }

  emitDownloadFailed(
    downloadId: number,
    error: Error | string,
    meta?: { failedDuringMerge?: boolean }
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.emit('downloadFailed', {
      downloadId,
      error: errorMessage,
      failedDuringMerge: meta?.failedDuringMerge ?? false,
      timestamp: Date.now(),
    });
  }

  emitDownloadProgress(downloadId: number, progress: DownloadProgressPayload): void {
    this.emit('downloadProgress', {
      downloadId,
      ...progress,
      timestamp: Date.now(),
    });
  }

  emitChunkCompleted(downloadId: number, chunkIndex: number): void {
    this.emit('chunkCompleted', {
      downloadId,
      chunkIndex,
      timestamp: Date.now(),
    });
  }

  emitChunkFailed(
    downloadId: number,
    chunkIndex: number,
    errorMessage: string,
    willRetry: boolean
  ): void {
    this.emit('chunkFailed', {
      downloadId,
      chunkIndex,
      error: errorMessage,
      willRetry: !!willRetry,
      timestamp: Date.now(),
    });
  }

  emitMergeStarted(downloadId: number): void {
    this.emit('mergeStarted', { downloadId, timestamp: Date.now() });
  }

  emitVerificationStarted(downloadId: number): void {
    this.emit('verificationStarted', { downloadId, timestamp: Date.now() });
  }

  emitNeedsConfirmation(downloadId: number, fileInfo: FileInfoPayload): void {
    this.emit('needsConfirmation', {
      downloadId,
      fileInfo,
      timestamp: Date.now(),
    });
  }

  /** Quita todos los listeners y timers (usado en cleanup del motor). */
  clear(): void {
    if (this._stateChangeTimer != null) {
      clearTimeout(this._stateChangeTimer);
      this._stateChangeTimer = null;
    }
    this._stateChangePending = null;
    this.removeAllListeners();
  }
}

const eventBus = new EventBus();
export default eventBus;
export { EventBus };
