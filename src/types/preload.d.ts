/**
 * @fileoverview Tipos para la API expuesta al renderer vía preload (contextBridge).
 * @module types/preload
 *
 * Refleja electron/preload.ts para autocompletado y typecheck en Vue/TS.
 * Incluye: IpcResponse, canales de eventos, payloads de descarga/actualización y PreloadApi.
 */

import type { SearchOptions } from '../../shared/types/search';

export type { SearchOptions } from '../../shared/types/search';

/** Respuesta estándar IPC: { success, data?, error? } */
export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

/** Canales de eventos (main → renderer) permitidos por el preload */
export type PreloadEventChannel =
  | 'download-progress'
  | 'download-progress-batch'
  | 'history-cleaned'
  | 'downloads-restored'
  | 'error-notification'
  | 'backend-log'
  | 'download-state-changed'
  | 'download-completed'
  | 'download-failed'
  | 'chunk-completed'
  | 'chunk-failed'
  | 'needs-confirmation'
  | 'folder-add-progress'
  | 'folder-add-complete'
  | 'update-checking'
  | 'update-available'
  | 'update-not-available'
  | 'update-downloaded'
  | 'update-download-progress'
  | 'update-error';

/** Payload de actualización disponible (update-available) */
export interface UpdateAvailablePayload {
  version?: string;
  releaseDate?: string;
  releaseNotes?: string | string[] | null;
}

/** Payload de progreso de descarga de actualización */
export interface UpdateDownloadProgressPayload {
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
}

/** Payloads tipados por canal (main → renderer) */
export interface DownloadStateChangedPayload {
  stateVersion: number;
}

export interface DownloadProgressPayload {
  id?: number;
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  speed?: number;
  speedBytesPerSec?: number;
  remainingTime?: number | null;
  state?: string;
  chunked?: boolean;
  totalChunks?: number;
  completedChunks?: number;
  activeChunks?: number;
  chunkProgress?: number[];
  merging?: boolean;
  mergeProgress?: number;
  mergeSpeed?: number;
  verificationProgress?: number;
  timestamp?: number;
  [key: string]: unknown;
}

/** Batch de eventos de progreso (un solo IPC por ventana, throttle). */
export interface DownloadProgressBatchPayload {
  updates: DownloadProgressPayload[];
}

export interface DownloadCompletedPayload {
  id?: number;
  title?: string;
  savePath?: string;
}

export interface DownloadFailedPayload {
  id?: number;
  error?: string;
  failedDuringMerge?: boolean;
}

export interface ChunkCompletedPayload {
  downloadId?: number;
  chunkIndex?: number;
}

export interface ChunkFailedPayload {
  downloadId?: number;
  chunkIndex?: number;
  error?: string;
  willRetry?: boolean;
}

export interface NeedsConfirmationPayload {
  id?: number;
  existingSize?: number;
  expectedSize?: number;
}

/** Progreso al añadir carpeta en segundo plano (folder-add-progress). */
export interface FolderAddProgressPayload {
  added: number;
  total: number;
  errorsCount?: number;
}

/** Resultado al terminar de añadir carpeta (folder-add-complete). */
export interface FolderAddCompletePayload {
  totalFiles: number;
  added: number;
  skipped: number;
  folderTitle?: string;
  errors?: Array<{ fileId: number; fileName?: string; error: string }>;
  error?: string;
}

/** Resumen de conteos por estado (snapshots incrementales). */
export interface SnapshotSummary {
  queued?: number;
  downloading?: number;
  paused?: number;
  completed?: number;
  failed?: number;
  total?: number;
}

/** Snapshot de estado de descargas (getDownloadState). */
export interface DownloadStateSnapshot {
  downloads: Array<Record<string, unknown>>;
  stateVersion?: number;
  /** true cuando hay más descargas que el límite; solo se devuelve una página. */
  truncated?: boolean;
  /** Total de descargas cuando truncated es true. */
  totalCount?: number;
  /** Lista completa de IDs (presente solo en snapshots incrementales, para detectar eliminaciones). */
  allIds?: number[];
  /** true si el snapshot es incremental (downloads contiene solo los cambios, no la lista completa). */
  isIncremental?: boolean;
  /** Conteos por estado (presente en snapshots incrementales). */
  summary?: SnapshotSummary;
}

/** Parámetros para descarga de carpeta */
export interface DownloadFolderParams {
  folderId: number;
  downloadPath?: string;
  preserveStructure?: boolean;
  forceOverwrite?: boolean;
  /** Si true, agrega los archivos en pausa (modo preparación de cola) sin iniciar descargas */
  deferStart?: boolean;
}

/** Parámetros para añadir una descarga (add-download) */
export interface AddDownloadParams {
  id: number;
  title: string;
  url?: string;
  savePath?: string;
  downloadPath?: string;
  preserveStructure?: boolean;
  priority?: 'low' | 'normal' | 'high';
  forceOverwrite?: boolean;
  totalBytes?: number;
}

/** Parámetros para test de conexión */
export interface RunConnectionTestParams {
  url: string;
  totalBytes: number;
}

/** API expuesta en window.api por el preload */
export interface PreloadApi {
  /** Suscripción a eventos del proceso principal. Retorna función de cleanup. */
  on(
    _channel: 'download-state-changed',
    _callback: (_payload: DownloadStateChangedPayload) => void
  ): () => void;
  on(
    _channel: 'download-progress',
    _callback: (_payload: DownloadProgressPayload) => void
  ): () => void;
  on(
    _channel: 'download-progress-batch',
    _callback: (_payload: DownloadProgressBatchPayload) => void
  ): () => void;
  on(
    _channel: 'download-completed',
    _callback: (_payload: DownloadCompletedPayload) => void
  ): () => void;
  on(_channel: 'download-failed', _callback: (_payload: DownloadFailedPayload) => void): () => void;
  on(_channel: 'chunk-completed', _callback: (_payload: ChunkCompletedPayload) => void): () => void;
  on(_channel: 'chunk-failed', _callback: (_payload: ChunkFailedPayload) => void): () => void;
  on(
    _channel: 'needs-confirmation',
    _callback: (_payload: NeedsConfirmationPayload) => void
  ): () => void;
  on(
    _channel: 'folder-add-progress',
    _callback: (_payload: FolderAddProgressPayload) => void
  ): () => void;
  on(
    _channel: 'folder-add-complete',
    _callback: (_payload: FolderAddCompletePayload) => void
  ): () => void;
  on(_channel: 'update-checking', _callback: () => void): () => void;
  on(
    _channel: 'update-available',
    _callback: (_payload: UpdateAvailablePayload) => void
  ): () => void;
  on(_channel: 'update-not-available', _callback: () => void): () => void;
  on(
    _channel: 'update-downloaded',
    _callback: (_payload: { version?: string }) => void
  ): () => void;
  on(
    _channel: 'update-download-progress',
    _callback: (_payload: UpdateDownloadProgressPayload) => void
  ): () => void;
  on(_channel: 'update-error', _callback: (_payload: { message?: string }) => void): () => void;
  on(_channel: PreloadEventChannel, _callback: (..._args: unknown[]) => void): () => void;

  loadDatabase(_source: 'myrient' | 'lolroms'): Promise<IpcResponse<unknown>>;
  closeDatabase(): Promise<IpcResponse<unknown>>;
  getCurrentSource(): Promise<IpcResponse<'myrient' | 'lolroms' | null>>;
  search(_term: string, _options?: SearchOptions): Promise<IpcResponse<unknown>>;
  getChildren(
    _parentId: number,
    _options?: { limit?: number; offset?: number }
  ): Promise<IpcResponse<unknown>>;
  getAncestors(_nodeId: number): Promise<IpcResponse<unknown>>;
  getNodeInfo(_nodeId: number): Promise<IpcResponse<unknown>>;
  getDbUpdateDate(): Promise<IpcResponse<unknown>>;
  getAppLocale(): Promise<IpcResponse<string>>;

  downloadFolder(_params: DownloadFolderParams): Promise<IpcResponse<unknown>>;
  getDownloadState(_minVersion?: number | null): Promise<IpcResponse<DownloadStateSnapshot>>;
  addDownload(_params: AddDownloadParams): Promise<IpcResponse<unknown>>;
  pauseDownloadState(_downloadId: number): Promise<IpcResponse<unknown>>;
  resumeDownloadState(_downloadId: number): Promise<IpcResponse<unknown>>;
  cancelDownloadState(_downloadId: number): Promise<IpcResponse<unknown>>;
  deleteDownloadState(_downloadId: number): Promise<IpcResponse<unknown>>;
  confirmOverwriteState(_downloadId: number): Promise<IpcResponse<unknown>>;
  getDownloadDebug(_downloadId: number): Promise<IpcResponse<unknown>>;
  getSessionMetrics(): Promise<IpcResponse<Record<string, unknown> | null>>;
  clearDownloadsState(): Promise<IpcResponse<unknown>>;
  restartStoppedWithOverwrite(_ids?: number[]): Promise<IpcResponse<DownloadStateSnapshot>>;
  pauseAllDownloads(): Promise<IpcResponse<DownloadStateSnapshot>>;
  cancelAllDownloads(): Promise<IpcResponse<DownloadStateSnapshot>>;
  resumeAllDownloads(): Promise<IpcResponse<DownloadStateSnapshot>>;
  applyDownloadSettings(_settings: Record<string, unknown>): Promise<IpcResponse<unknown>>;
  getSuggestedTestFile(): Promise<IpcResponse<unknown>>;
  runConnectionTest(_params: RunConnectionTestParams): Promise<IpcResponse<unknown>>;

  readConfigFile(_filename: string): Promise<IpcResponse<unknown>>;
  writeConfigFile(_filename: string, _data: unknown): Promise<IpcResponse<unknown>>;

  minimizeWindow(): Promise<IpcResponse<unknown>>;
  maximizeWindow(): Promise<IpcResponse<unknown>>;
  getWindowIsMaximized(): Promise<IpcResponse<boolean>>;
  closeWindow(): Promise<IpcResponse<unknown>>;
  selectFolder(): Promise<IpcResponse<string | null>>;
  openFolder(_filePath: string): Promise<IpcResponse<unknown>>;
  getUserDataPath(): Promise<IpcResponse<{ path: string }>>;
  openUserDataFolder(): Promise<IpcResponse<{ path?: string }>>;
  openExternalUrl(_url: string): Promise<IpcResponse<unknown>>;
  getAppVersion(): Promise<IpcResponse<string>>;
  checkForUpdates(): Promise<IpcResponse<unknown>>;
  quitAndInstall(): Promise<IpcResponse<unknown>>;

  log(_logEntry: Record<string, unknown>): Promise<IpcResponse<unknown>>;
  saveLogsToFile(
    _logText: string,
    _dialogOptions?: {
      title: string;
      filterText: string;
      filterAll: string;
      canceledMessage: string;
    }
  ): Promise<IpcResponse<unknown>>;
}

declare global {
  // eslint-disable-next-line no-unused-vars -- Window es la interfaz global del DOM
  interface Window {
    api: PreloadApi;
  }
}

export {};
