/**
 * Script de preload de Electron: puente seguro entre main y renderer.
 *
 * Se ejecuta en el contexto aislado de la ventana (preload) y expone solo
 * una API explícita vía contextBridge. Todas las comunicaciones con el main
 * pasan por listas blancas de canales (validInvokeChannels / validEventChannels)
 * para evitar que el renderer invoque o escuche canales no permitidos.
 *
 * El frontend accede a esta API como window.api (tipado en src/types/preload.d.ts).
 *
 * @module preload
 */

import { contextBridge, ipcRenderer } from 'electron';

/** Canales por los que el main puede enviar eventos al renderer (one-way). */
const validEventChannels = [
  'download-progress',
  'download-progress-batch',
  'history-cleaned',
  'downloads-restored',
  'error-notification',
  'backend-log',
  'download-state-changed',
  'download-completed',
  'download-failed',
  'chunk-completed',
  'chunk-failed',
  'needs-confirmation',
  'folder-add-progress',
  'folder-add-complete',
  'update-checking',
  'update-available',
  'update-not-available',
  'update-downloaded',
  'update-download-progress',
  'update-error',
] as const;

/** Canales que el renderer puede invocar (IPC request/response). */
const validInvokeChannels = [
  'close-database',
  'load-database',
  'get-current-source',
  'search-db',
  'get-children',
  'get-ancestors',
  'get-node-info',
  'get-db-update-date',
  'get-app-locale',
  'get-search-metrics',
  'download-folder',
  'get-download-state',
  'add-download',
  'pause-download-state',
  'resume-download-state',
  'cancel-download-state',
  'delete-download-state',
  'confirm-overwrite-state',
  'get-download-debug',
  'get-session-metrics',
  'clear-downloads-state',
  'restart-stopped-with-overwrite',
  'pause-all-downloads',
  'cancel-all-downloads',
  'resume-all-downloads',
  'apply-download-settings',
  'get-suggested-test-file',
  'run-connection-test',
  'read-config-file',
  'write-config-file',
  'window-minimize',
  'window-maximize',
  'window-is-maximized',
  'window-close',
  'select-folder',
  'open-folder',
  'get-user-data-path',
  'open-user-data-folder',
  'open-external-url',
  'frontend-log',
  'save-logs-to-file',
  'get-app-version',
  'check-for-updates',
  'quit-and-install',
] as const;

/**
 * Invoca un canal IPC solo si está en la lista permitida.
 *
 * @param channel - Nombre del canal (debe estar en validInvokeChannels).
 * @param args - Argumentos serializables enviados al main.
 * @returns Promesa con la respuesta del handler en main.
 * @throws Error si el canal no está autorizado.
 */
const safeInvoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  if (!validInvokeChannels.includes(channel as (typeof validInvokeChannels)[number])) {
    console.error(`[Preload] ⛔ Canal IPC no autorizado: ${channel}`);
    return Promise.reject(new Error(`Canal IPC no autorizado: ${channel}`));
  }
  return ipcRenderer.invoke(channel, ...args);
};

/**
 * Suscribe un listener a un canal de eventos solo si está permitido.
 *
 * @param channel - Nombre del canal (debe estar en validEventChannels).
 * @param callback - Función a llamar con los argumentos enviados por main.
 * @returns Función para cancelar la suscripción (removeListener).
 */
const safeOn = (channel: string, callback: (..._args: unknown[]) => void): (() => void) => {
  if (!validEventChannels.includes(channel as (typeof validEventChannels)[number])) {
    console.warn(`[Preload] ⚠️ Canal de eventos no válido: ${channel}`);
    return () => {};
  }

  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
    try {
      callback(...args);
    } catch (error) {
      console.error(`[Preload] Error en listener de ${channel}:`, error);
    }
  };

  ipcRenderer.on(channel, listener);

  return () => {
    try {
      ipcRenderer.removeListener(channel, listener);
      console.log(`[Preload] Listener removido: ${channel}`);
    } catch (error) {
      console.error(`[Preload] Error removiendo listener de ${channel}:`, error);
    }
  };
};

/**
 * API expuesta al renderer como window.api.
 * Cada método se corresponde con un canal IPC; los tipos detallados están en src/types/preload.d.ts.
 */
export interface PreloadAPI {
  on: typeof safeOn;
  closeDatabase: () => Promise<unknown>;
  loadDatabase: (_source: 'myrient' | 'lolroms') => Promise<unknown>;
  getCurrentSource: () => Promise<unknown>;
  search: (_term: string, _options?: Record<string, unknown>) => Promise<unknown>;
  getChildren: (_parentId: number, _options?: Record<string, unknown>) => Promise<unknown>;
  getAncestors: (_nodeId: number) => Promise<unknown>;
  getNodeInfo: (_nodeId: number) => Promise<unknown>;
  getDbUpdateDate: () => Promise<unknown>;
  getAppLocale: () => Promise<unknown>;
  getSearchMetrics: () => Promise<unknown>;
  downloadFolder: (_params: Record<string, unknown>) => Promise<unknown>;
  getDownloadState: (_minVersion?: number | null) => Promise<unknown>;
  addDownload: (_params: Record<string, unknown>) => Promise<unknown>;
  pauseDownloadState: (_downloadId: number) => Promise<unknown>;
  resumeDownloadState: (_downloadId: number) => Promise<unknown>;
  cancelDownloadState: (_downloadId: number) => Promise<unknown>;
  deleteDownloadState: (_downloadId: number) => Promise<unknown>;
  confirmOverwriteState: (_downloadId: number) => Promise<unknown>;
  getDownloadDebug: (_downloadId: number) => Promise<unknown>;
  getSessionMetrics: () => Promise<unknown>;
  clearDownloadsState: () => Promise<unknown>;
  restartStoppedWithOverwrite: (_ids?: number[]) => Promise<unknown>;
  pauseAllDownloads: () => Promise<unknown>;
  cancelAllDownloads: () => Promise<unknown>;
  resumeAllDownloads: () => Promise<unknown>;
  applyDownloadSettings: (_settings: Record<string, unknown>) => Promise<unknown>;
  getSuggestedTestFile: () => Promise<unknown>;
  runConnectionTest: (_params: { url: string; totalBytes: number }) => Promise<unknown>;
  readConfigFile: (_filename: string) => Promise<unknown>;
  writeConfigFile: (_filename: string, _data: unknown) => Promise<unknown>;
  minimizeWindow: () => Promise<unknown>;
  maximizeWindow: () => Promise<unknown>;
  getWindowIsMaximized: () => Promise<unknown>;
  closeWindow: () => Promise<unknown>;
  selectFolder: () => Promise<unknown>;
  openFolder: (_filePath: string) => Promise<unknown>;
  getUserDataPath: () => Promise<unknown>;
  openUserDataFolder: () => Promise<unknown>;
  openExternalUrl: (_url: string) => Promise<unknown>;
  getAppVersion: () => Promise<unknown>;
  checkForUpdates: () => Promise<unknown>;
  quitAndInstall: () => Promise<unknown>;
  log: (_logEntry: unknown) => Promise<unknown>;
  saveLogsToFile: (
    _logText: string,
    _dialogOptions?: {
      title: string;
      filterText: string;
      filterAll: string;
      canceledMessage: string;
    }
  ) => Promise<unknown>;
}

const api: PreloadAPI = {
  on: safeOn,

  closeDatabase: () => safeInvoke('close-database'),
  loadDatabase: source => safeInvoke('load-database', source),
  getCurrentSource: () => safeInvoke('get-current-source'),
  search: (term, options) => safeInvoke('search-db', term, options),
  getChildren: (parentId, options) => safeInvoke('get-children', parentId, options ?? {}),
  getAncestors: nodeId => safeInvoke('get-ancestors', nodeId),
  getNodeInfo: nodeId => safeInvoke('get-node-info', nodeId),
  getDbUpdateDate: () => safeInvoke('get-db-update-date'),
  getAppLocale: () => safeInvoke('get-app-locale'),
  getSearchMetrics: () => safeInvoke('get-search-metrics'),

  downloadFolder: params => safeInvoke('download-folder', params),
  getDownloadState: (minVersion = null) => safeInvoke('get-download-state', minVersion),
  addDownload: params => safeInvoke('add-download', params),
  pauseDownloadState: downloadId => safeInvoke('pause-download-state', downloadId),
  resumeDownloadState: downloadId => safeInvoke('resume-download-state', downloadId),
  cancelDownloadState: downloadId => safeInvoke('cancel-download-state', downloadId),
  deleteDownloadState: downloadId => safeInvoke('delete-download-state', downloadId),
  confirmOverwriteState: downloadId => safeInvoke('confirm-overwrite-state', downloadId),
  getDownloadDebug: downloadId => safeInvoke('get-download-debug', downloadId),
  getSessionMetrics: () => safeInvoke('get-session-metrics'),
  clearDownloadsState: () => safeInvoke('clear-downloads-state'),
  restartStoppedWithOverwrite: (ids?: number[]) =>
    safeInvoke('restart-stopped-with-overwrite', ids),
  pauseAllDownloads: () => safeInvoke('pause-all-downloads'),
  cancelAllDownloads: () => safeInvoke('cancel-all-downloads'),
  resumeAllDownloads: () => safeInvoke('resume-all-downloads'),
  applyDownloadSettings: settings => safeInvoke('apply-download-settings', settings),
  getSuggestedTestFile: () => safeInvoke('get-suggested-test-file'),
  runConnectionTest: params => safeInvoke('run-connection-test', params),

  readConfigFile: filename => safeInvoke('read-config-file', filename),
  writeConfigFile: (filename, data) => safeInvoke('write-config-file', filename, data),

  minimizeWindow: () => safeInvoke('window-minimize'),
  maximizeWindow: () => safeInvoke('window-maximize'),
  getWindowIsMaximized: () => safeInvoke('window-is-maximized'),
  closeWindow: () => safeInvoke('window-close'),

  selectFolder: () => safeInvoke('select-folder'),
  openFolder: filePath => safeInvoke('open-folder', filePath),
  getUserDataPath: () => safeInvoke('get-user-data-path'),
  openUserDataFolder: () => safeInvoke('open-user-data-folder'),
  openExternalUrl: url => safeInvoke('open-external-url', url),

  getAppVersion: () => safeInvoke('get-app-version'),
  checkForUpdates: () => safeInvoke('check-for-updates'),
  quitAndInstall: () => safeInvoke('quit-and-install'),

  log: logEntry => safeInvoke('frontend-log', logEntry),
  saveLogsToFile: (logText, dialogOptions) =>
    safeInvoke('save-logs-to-file', logText, dialogOptions),
};

contextBridge.exposeInMainWorld('api', api);

console.log('[Preload] ✅ API expuesta correctamente');
console.log('[Preload] Canales de eventos:', validEventChannels.length);
console.log('[Preload] Canales de invocación:', validInvokeChannels.length);
