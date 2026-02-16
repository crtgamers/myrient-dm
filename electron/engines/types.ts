/**
 * Tipos y constantes compartidos por el motor de descargas.
 *
 * Define estados de descarga y chunk, las referencias mínimas (DownloadEngineRef,
 * ChunkEngineRef) que SimpleDownloader y ChunkDownloader necesitan del orquestador,
 * y los contratos ICatalogProvider e ISavePathResolver para desacoplar el motor de
 * la base de datos y del FileService.
 *
 * @module engines/types
 */

/** Contrato para obtener información de archivos y rutas del catálogo (permite inyectar mocks en tests). */
export interface ICatalogProvider {
  getFileDownloadInfo: (
    _id: number
  ) => { url?: string | null; title?: string; name?: string } | null;
  getFileAncestorPath: (_id: number) => Array<{ name?: string; title?: string }>;
}

/** Contrato para validar nombres y construir rutas de guardado (permite inyectar mocks en tests). */
export interface ISavePathResolver {
  validateFilename: (_name: string) => { valid: boolean; data?: string };
  buildSavePath: (
    _basePath: string,
    _filename: string,
    _preserveStructure: boolean,
    _relativePath: string
  ) => { success: boolean; savePath?: string; error?: string };
}

/** Estados posibles de una descarga en el motor transaccional. */
export const DownloadState = Object.freeze({
  QUEUED: 'queued',
  STARTING: 'starting',
  DOWNLOADING: 'downloading',
  PAUSED: 'paused',
  MERGING: 'merging',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const);

export type DownloadStateType = (typeof DownloadState)[keyof typeof DownloadState];

/** Estados posibles de un chunk (fragmento) de descarga. */
export const ChunkState = Object.freeze({
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  COMPLETED: 'completed',
  FAILED: 'failed',
  PAUSED: 'paused',
} as const);

export type ChunkStateType = (typeof ChunkState)[keyof typeof ChunkState];

/** Referencia mínima al DownloadEngine usada por SimpleDownloader y ChunkDownloader. */
export interface DownloadEngineRef {
  stateStore: {
    getDownload: (_id: number) => {
      id: number;
      savePath: string | null;
      totalBytes: number;
      forceOverwrite: boolean;
      state: string;
      retryCount: number;
      url?: string | null;
      startedAt?: number | null;
      partialTailHash?: string | null;
      partialTailSize?: number | null;
      [k: string]: unknown;
    } | null;
    updateDownload: (_id: number, _updates: Record<string, unknown>) => boolean;
    transitionState: (_id: number, _newState: string, _oldState?: string | null) => boolean;
    getStateVersion: () => number;
    getChunks?: (_downloadId: number) => {
      id: number;
      chunkIndex: number;
      startByte: number;
      endByte: number;
      state: string;
      tempFile: string | null;
      downloadedBytes: number;
      tailCheckpointHash?: string | null;
      tailCheckpointSize?: number | null;
    }[];
    createChunks?: (
      _downloadId: number,
      _chunks: {
        chunkIndex: number;
        startByte: number;
        endByte: number;
        tempFile?: string | null;
      }[]
    ) => unknown[];
    updateChunkProgress?: (
      _downloadId: number,
      _chunkIndex: number,
      _updates: Record<string, unknown>
    ) => boolean;
    getAttempts?: (_downloadId: number) => { chunkId: number | null; error?: string | null }[];
    recordAttempt?: (_attempt: Record<string, unknown>) => boolean;
    deleteChunks: (_downloadId: number) => number;
  };
  speedTracker: {
    ensureTracking: (_id: number, _sessionStart: number, _initialDownloaded?: number) => void;
    update: (
      _id: number,
      _downloaded: number,
      _total: number
    ) => { speedBytesPerSec: number; remainingTime: number | null } | null;
  };
  activeDownloads: Map<number, unknown>;
  _getHostCircuitBreaker: (
    _url: string
  ) => { execute: <T>(_fn: () => Promise<T>, _fallback: () => never) => Promise<T> } | null;
  _cleanupActiveDownload: (_id: number) => void;
  /** Desregistra la descarga del scheduler per-host (libera slot y rate limiter). Idempotente. */
  _unregisterDownloadHost: (_downloadId: number) => void;
  /** Reporta un evento al controlador de concurrencia adaptativa. Opcional; no-op si no está habilitado. */
  _recordAdaptiveEvent?: (_type: 'transient_retry', _host: string) => void;
  processQueue: () => Promise<void>;
  _isTransientNetworkError: (_error: Error) => boolean;
  _calculateBackoffDelay: (_retryCount: number) => number;
  _verifyDownload: (_downloadId: number) => Promise<void>;
  /** Opcional: para logging de session id en SimpleDownloader. */
  sessionManager?: { getSessionId: (_id: number) => string | null };
}

/** Referencia al engine para ChunkDownloader (incluye chunkStore, chunkManager, sessionManager, mergeInProgress, _runWorker, eventBus). */
export interface ChunkEngineRef extends DownloadEngineRef {
  /** EventBus inyectado para desacoplar ChunkDownloader del singleton. */
  eventBus: {
    emitStateChanged: (_stateVersion: number) => void;
    emitDownloadProgress: (_downloadId: number, _progress: Record<string, unknown>) => void;
    emitDownloadFailed: (
      _downloadId: number,
      _error: Error | string,
      _meta?: { failedDuringMerge?: boolean }
    ) => void;
    emitChunkCompleted: (_downloadId: number, _chunkIndex: number) => void;
    emitChunkFailed: (
      _downloadId: number,
      _chunkIndex: number,
      _errorMessage: string,
      _willRetry: boolean
    ) => void;
    emitMergeStarted: (_downloadId: number) => void;
  };
  chunkStore: {
    createChunkDir: (_downloadId: number) => Promise<void | string>;
    getChunkPath: (_downloadId: number, _chunkIndex: number) => string;
    getStagingPath: (_downloadId: number, _finalPath: string) => string;
    reconcileChunks: (
      _downloadId: number,
      _existingChunks: {
        chunkIndex: number;
        startByte: number;
        endByte: number;
        state: string;
        tempFile: string | null;
        id: number;
      }[]
    ) => Promise<{
      missing: { chunkIndex: number }[];
      mismatched: { index: number }[];
      orphaned: unknown[];
    }>;
    deleteChunk: (_downloadId: number, _chunkIndex: number) => Promise<void | boolean>;
    deleteAllChunks: (_downloadId: number) => Promise<number>;
  };
  chunkManager: {
    cleanupChunk: (_chunkKey: string) => void;
    cleanupForDownload: (_downloadId: number) => void;
  };
  sessionManager: {
    createSession: (_downloadId: number) => string;
    isCurrent: (_downloadId: number, _sessionId: string) => boolean;
    getSessionId: (_downloadId: number) => string | null;
  };
  mergeInProgress: Set<number>;
  downloadConfigOverrides: {
    maxConcurrentChunks: number | null;
    maxChunkRetries: number | null;
    chunkOperationTimeoutMinutes: number | null;
  };
  activeChunks: Map<string, unknown>;
  /** Controlador de concurrencia para slots de chunks por descarga. */
  concurrencyController: {
    acquireChunkSlot: (_downloadId: number) => boolean;
    releaseChunkSlot: (_downloadId: number) => void;
    maxChunkSlotsPerDownload: number;
  };
  /** Merge incremental: sesión por downloadId (append en orden, finalize al completar). */
  getIncrementalMergeSession: (_downloadId: number) =>
    | {
        appendChunk: (
          _chunkIndex: number,
          _chunkPath: string,
          _chunkSize: number
        ) => Promise<{ complete: boolean }>;
        finalize: (_forceOverwrite?: boolean) => Promise<void>;
      }
    | undefined;
  createIncrementalMergeSession: (
    _downloadId: number,
    _finalPath: string,
    _expectedSize: number,
    _chunkCount: number
  ) => {
    appendChunk: (
      _chunkIndex: number,
      _chunkPath: string,
      _chunkSize: number
    ) => Promise<{ complete: boolean }>;
    finalize: (_forceOverwrite?: boolean) => Promise<void>;
  };
  removeIncrementalMergeSession: (_downloadId: number) => void;
  _runWorker: (
    _task: string,
    _payload: Record<string, unknown>,
    _onProgress?: (_progress: number, _bytesProcessed: number) => void
  ) => Promise<unknown>;
}
