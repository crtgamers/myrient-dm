/**
 * Servicio API - Punto de entrada único.
 * Reexporta tipos y funciones de catalog, downloads, window y config
 * para no romper imports existentes (p. ej. from '../services/api').
 * @module api
 */

export type { SearchOptions } from './types';
export type {
  APIResponse,
  DownloadParams,
  FolderDownloadParams,
  ConnectionTestData,
  SuggestedTestFileResponse,
  CleanHistoryResponse,
  ApplyDownloadSettingsParams,
  PathResponse,
} from './types';

export {
  loadDatabase,
  closeDatabase,
  getCurrentSource,
  search,
  getChildren,
  getAncestors,
  getNodeInfo,
  getDbUpdateDate,
} from './catalog';
export type { CatalogSource } from './catalog';

export {
  downloadFolder,
  cleanHistory,
  clearHistory,
  applyDownloadSettings,
  getSuggestedTestFile,
  runConnectionTest,
  getDownloadState,
  addDownload,
  pauseDownloadState,
  pauseAllDownloads,
  cancelAllDownloads,
  resumeAllDownloads,
  resumeDownloadState,
  cancelDownloadState,
  deleteDownloadState,
  confirmOverwriteState,
  getDownloadDebug,
  getSessionMetrics,
  onDownloadStateChanged,
  onDownloadCompleted,
  onDownloadFailed,
  onChunkFailed,
  onNeedsConfirmation,
  onDownloadProgress,
  onHistoryCleaned,
  onDownloadsRestored,
  onErrorNotification,
  onFolderAddProgress,
  onFolderAddComplete,
} from './downloads';

export {
  minimizeWindow,
  maximizeWindow,
  getWindowIsMaximized,
  closeWindow,
  selectFolder,
  getUserDataPath,
  openUserDataFolder,
  openExternalUrl,
} from './window';

export {
  getAppLocale,
  readConfigFile,
  writeConfigFile,
  getAppVersion,
  checkForUpdates,
  quitAndInstall,
} from './config';
