/**
 * Handlers IPC del motor de descargas y puente con el renderer.
 *
 * - Inicializa una única instancia de DownloadEngine y la conecta al EventBus para reenviar
 *   eventos (stateChanged, downloadProgress, downloadCompleted, etc.) al renderer vía webContents.send.
 * - Registra canales: get-download-state, add-download, download-folder, pause/resume/cancel/delete,
 *   clear, pause-all/cancel-all/resume-all, apply-download-settings, confirm-overwrite, get-download-debug,
 *   get-suggested-test-file, run-connection-test. add-download enriquece parámetros con URL y savePath
 * desde la DB de catálogo antes de pasar al motor.
 * - Rate limit en get-download-state y en operaciones que modifican la cola para evitar abusos.
 *
 * @module ipcStateHandlers
 */

import { ipcMain, app } from 'electron';
import { DownloadEngine } from './engines/DownloadEngine';
import eventBus from './engines/EventBus';
import { getMainWindow } from './window';
import { DownloadState } from './engines/StateStore';
import type { Snapshot } from './engines/StateStore';
import { logger } from './utils';
import { createHandler as createHandlerBase } from './utils/ipcHelpers';
import path from 'path';
import { promises as fs } from 'fs';
import {
  validateDownloadParams,
  validateDownloadId,
  validateDownloadFolderParams,
  sanitizeFileName,
  validateAndSanitizeDownloadPath,
  isValidUrl,
} from './utils';
import { validateDownloadSettings } from './utils/schemas';
import { RateLimiter } from './utils/rateLimiter';
import config from './config';
import database from './database';
import { serviceManager } from './services';
import { ERRORS } from './constants/errors';
import { runConnectionTest } from './utils/connectionTest';

const log = logger.child('IPCState');

let downloadEngine: DownloadEngine | null = null;

type EventHandler = (..._args: unknown[]) => void;
/** Referencias a los listeners del EventBus para poder quitarlos en close/cleanup. */
const eventHandlers: Record<string, EventHandler | null> = {
  stateChanged: null,
  downloadProgress: null,
  downloadCompleted: null,
  downloadFailed: null,
  chunkCompleted: null,
  chunkFailed: null,
  needsConfirmation: null,
};

/** Quita todos los listeners registrados en el EventBus y timers O9. */
function cleanupEventListeners(): void {
  for (const eventName of Object.keys(eventHandlers)) {
    const handler = eventHandlers[eventName];
    if (handler) {
      eventBus.removeListener(eventName, handler as (..._args: unknown[]) => void);
      eventHandlers[eventName] = null;
    }
  }
  if (progressBatchTimer != null) {
    clearTimeout(progressBatchTimer);
    progressBatchTimer = null;
  }
  progressBatchBuffer.clear();
  if (log.debug) log.debug('Listeners del EventBus limpiados');
}

const rateLimitingDownload = config.rateLimiting as
  | { download?: { maxRequests?: number; windowMs?: number } }
  | undefined;
const downloadRateLimiter = new RateLimiter(
  rateLimitingDownload?.download?.maxRequests ?? 20,
  rateLimitingDownload?.download?.windowMs ?? 1000
);

/** E1: rate limit explícito para get-download-state (máx. 2–3 req/s por ventana) para evitar picos de CPU en main. */
const rateLimitingGetState = config.rateLimiting as
  | { getDownloadState?: { maxRequests?: number; windowMs?: number } }
  | undefined;
const getStateRateLimiter = new RateLimiter(
  rateLimitingGetState?.getDownloadState?.maxRequests ?? 3,
  rateLimitingGetState?.getDownloadState?.windowMs ?? 1000
);

/** Envía un payload al renderer por el canal indicado si la ventana principal existe. */
function sendToRenderer(channel: string, payload: unknown): void {
  const w = getMainWindow();
  if (w && !w.isDestroyed()) {
    w.webContents.send(channel, payload);
  }
}

/** Mínimo ms entre envíos de download-progress por descarga (throttle para no saturar IPC/UI). */
const PROGRESS_THROTTLE_MS = 150;
const lastProgressSentByDownload = new Map<number, number>();

/** Buffer de progreso para enviar un solo IPC por ventana (batch y throttle). */
const progressBatchBuffer = new Map<number, Record<string, unknown>>();
let progressBatchTimer: ReturnType<typeof setTimeout> | null = null;

const progressBatchIntervalMs =
  (config.ui as { progressBatchIntervalMs?: number })?.progressBatchIntervalMs ?? 50;

function flushProgressBatch(): void {
  progressBatchTimer = null;
  if (progressBatchBuffer.size === 0) return;
  const updates = Array.from(progressBatchBuffer.values());
  progressBatchBuffer.clear();
  sendToRenderer('download-progress-batch', { updates });
}

function scheduleProgressBatchFlush(): void {
  if (progressBatchTimer != null) return;
  progressBatchTimer = setTimeout(flushProgressBatch, progressBatchIntervalMs);
}

/** Timestamp de la última vez que se envió un snapshot al renderer (para snapshots incrementales). */
let lastSnapshotServedTimestamp = 0;

function sendDownloadProgressThrottled(payload: Record<string, unknown>): void {
  const downloadId = payload.id as number;
  if (downloadId == null || typeof downloadId !== 'number') {
    sendToRenderer('download-progress', payload);
    return;
  }
  const now = Date.now();
  const last = lastProgressSentByDownload.get(downloadId);
  if (last != null && now - last < PROGRESS_THROTTLE_MS) {
    return;
  }
  lastProgressSentByDownload.set(downloadId, now);
  progressBatchBuffer.set(downloadId, payload);
  scheduleProgressBatchFlush();
}

function clearProgressThrottleForDownload(downloadId: number): void {
  lastProgressSentByDownload.delete(downloadId);
  progressBatchBuffer.delete(downloadId);
}

/** Parámetros mínimos para añadir una descarga; se enriquecen con URL y savePath desde la DB. */
interface EnrichParams {
  id: number;
  title: string;
  downloadPath?: string | null;
  preserveStructure?: boolean;
  forceOverwrite?: boolean;
  url?: string | null;
  skipQueueLimit?: boolean;
  startPaused?: boolean;
}

/**
 * Valida parámetros, obtiene URL y metadatos del catálogo, construye savePath (con preserveStructure
 * si FileService está disponible) y añade la descarga al DownloadEngine.
 *
 * @throws Error si validación falla, no hay info del archivo en la DB, URL inválida o falta downloadPath.
 */
async function enrichAndAddDownload(
  params: EnrichParams & Record<string, unknown>
): Promise<Snapshot> {
  const validation = validateDownloadParams(params);
  if (!validation.valid) {
    throw new Error((validation as { error?: string }).error || 'Parámetros inválidos');
  }

  const data = validation.data as {
    id: number;
    title: string;
    downloadPath?: string;
    savePath?: string;
    preserveStructure?: boolean;
    totalBytes?: number;
    url?: string;
  };
  const fileInfo = database.getFileDownloadInfo(data.id);
  if (!fileInfo || !fileInfo.url) {
    throw new Error('No se pudo obtener información del archivo en el catálogo');
  }

  let url = data.url || fileInfo.url;
  if (url && !url.startsWith('http')) {
    const parts = url.split('/').map((part: string) => encodeURIComponent(part));
    url = `https://myrient.erista.me/files/${parts.join('/')}`;
  }

  if (!isValidUrl(url)) {
    throw new Error('URL inválida o no permitida');
  }

  const totalBytes = data.totalBytes ?? fileInfo.size_bytes ?? 0;

  if (
    !data.downloadPath ||
    typeof data.downloadPath !== 'string' ||
    data.downloadPath.trim().length === 0
  ) {
    throw new Error(
      'Ruta de descarga requerida. Por favor, configura una carpeta de descarga en Configuración.'
    );
  }

  let savePath = data.savePath || null;
  const fileService = serviceManager.initialized ? serviceManager.getFileService() : null;
  if (!savePath && data.downloadPath && fileService) {
    const ancestors = database.getFileAncestorPath(data.id);
    const relativePath = ancestors
      .map((a: { name?: string; title?: string }) => {
        const name = (a.name || a.title || '').replace(/\/$/, '');
        if (!name) return '';
        const v = fileService.validateFilename(name);
        return v && 'valid' in v && v.valid && v.data ? v.data : '';
      })
      .filter(Boolean)
      .join(path.sep);
    const built = fileService.buildSavePath(
      data.downloadPath,
      data.title,
      data.preserveStructure !== false,
      relativePath
    );
    if ('success' in built && built.success && 'savePath' in built && built.savePath) {
      savePath = built.savePath;
    }
  }

  const enrichedParams = {
    ...data,
    url,
    savePath,
    totalBytes,
    downloadPath: data.downloadPath,
  } as Parameters<DownloadEngine['addDownload']>[0] & {
    skipQueueLimit?: boolean;
    startPaused?: boolean;
  };

  if ((params as { skipQueueLimit?: boolean }).skipQueueLimit === true) {
    enrichedParams.skipQueueLimit = true;
  }
  if ((params as { startPaused?: boolean }).startPaused === true) {
    enrichedParams.startPaused = true;
  }

  return await downloadEngine!.addDownload(enrichedParams);
}

/**
 * Crea la instancia única de DownloadEngine, registra listeners en el EventBus que reenvían
 * eventos al renderer (download-state-changed, download-progress, etc.) e inicializa el motor.
 * Idempotente: si ya existe instancia, no hace nada.
 */
export async function initializeDownloadEngine(
  _mainWindow?: Electron.BrowserWindow
): Promise<void> {
  if (downloadEngine) {
    log.warn('DownloadEngine ya inicializado');
    return;
  }
  cleanupEventListeners();

  downloadEngine = new DownloadEngine();

  eventHandlers.stateChanged = (...args: unknown[]) => {
    const payload = args[0] as { stateVersion: number };
    sendToRenderer('download-state-changed', { stateVersion: payload?.stateVersion });
  };
  eventBus.on('stateChanged', eventHandlers.stateChanged!);

  eventHandlers.downloadProgress = (...args: unknown[]) => {
    const event = args[0] as Record<string, unknown>;
    const payload = {
      id: event.downloadId,
      progress: event.progress,
      downloadedBytes: event.downloadedBytes,
      totalBytes: event.totalBytes,
      speed: event.speed,
      speedBytesPerSec: event.speedBytesPerSec,
      remainingTime: event.remainingTime,
      chunked: event.chunked,
      totalChunks: event.totalChunks,
      completedChunks: event.completedChunks,
      activeChunks: event.activeChunks,
      chunkProgress: event.chunkProgress,
      merging: event.merging,
      mergeProgress: event.mergeProgress,
      mergeSpeed: event.mergeSpeed,
      verificationProgress: event.verificationProgress,
      timestamp: event.timestamp,
    };
    sendDownloadProgressThrottled(payload);
  };
  eventBus.on('downloadProgress', eventHandlers.downloadProgress!);

  eventHandlers.downloadCompleted = (...args: unknown[]) => {
    const event = args[0] as Record<string, unknown>;
    clearProgressThrottleForDownload(event.downloadId as number);
    sendToRenderer('download-completed', {
      id: event.downloadId,
      title: event.title,
      savePath: event.savePath,
    });
  };
  eventBus.on('downloadCompleted', eventHandlers.downloadCompleted!);

  eventHandlers.downloadFailed = (...args: unknown[]) => {
    const event = args[0] as Record<string, unknown>;
    clearProgressThrottleForDownload(event.downloadId as number);
    sendToRenderer('download-failed', {
      id: event.downloadId,
      error: event.error || 'Error desconocido',
      failedDuringMerge: event.failedDuringMerge === true,
    });
  };
  eventBus.on('downloadFailed', eventHandlers.downloadFailed!);

  eventHandlers.chunkCompleted = (...args: unknown[]) => {
    const event = args[0] as Record<string, unknown>;
    sendToRenderer('chunk-completed', {
      downloadId: event.downloadId,
      chunkIndex: event.chunkIndex,
    });
  };
  eventBus.on('chunkCompleted', eventHandlers.chunkCompleted!);

  eventHandlers.chunkFailed = (...args: unknown[]) => {
    const event = args[0] as Record<string, unknown>;
    sendToRenderer('chunk-failed', {
      downloadId: event.downloadId,
      chunkIndex: event.chunkIndex,
      error: event.error || 'Error desconocido',
      willRetry: event.willRetry,
    });
  };
  eventBus.on('chunkFailed', eventHandlers.chunkFailed!);

  eventHandlers.needsConfirmation = (...args: unknown[]) => {
    const ev = args[0] as Record<string, unknown>;
    sendToRenderer('needs-confirmation', { id: ev.downloadId, ...(ev.fileInfo as object) });
  };
  eventBus.on('needsConfirmation', eventHandlers.needsConfirmation!);

  await downloadEngine.initialize();
  log.info('DownloadEngine inicializado');
}

type StateHandlerFn = (
  _event: Electron.IpcMainInvokeEvent,
  ..._args: unknown[]
) => Promise<unknown> | unknown;

/** Wrapper con wrapSuccess y checkEngine para que las respuestas sean { success, data } y se compruebe motor inicializado. */
function createHandler(
  channel: string,
  handler: StateHandlerFn
): (_event: Electron.IpcMainInvokeEvent, ..._args: unknown[]) => Promise<unknown> {
  return createHandlerBase(
    channel,
    handler as (_event: Electron.IpcMainInvokeEvent, ..._args: unknown[]) => Promise<unknown>,
    {
      wrapSuccess: true,
      checkEngine: () => downloadEngine,
      log,
      defaultErrorMessage: 'Error desconocido',
      app,
    }
  );
}

/**
 * Registra todos los handlers IPC del motor de descargas (estado, cola, add/pause/resume/cancel,
 * download-folder, test de conexión, apply-settings, etc.). Requiere mainWindow para contexto;
 * get-download-state no usa la ventana pero el resto del flujo sí depende de que el motor esté listo.
 */
export function registerStateHandlers(mainWindow: Electron.BrowserWindow): void {
  if (!mainWindow) {
    log.error('mainWindow no proporcionado, no se pueden registrar handlers');
    return;
  }

  const MAX_SNAPSHOT_DOWNLOADS = 500;

  ipcMain.handle('get-download-state', async (_event, minVersion: number | null = null) => {
    try {
      if (!downloadEngine || !downloadEngine.isInitialized) {
        return { success: true, data: { stateVersion: 0, downloads: [] } };
      }
      if (!getStateRateLimiter.isAllowed('get-download-state')) {
        return { success: false, error: 'Demasiadas solicitudes de estado, intente más tarde' };
      }

      // Snapshot incremental: si el frontend ya tiene datos (minVersion > 0),
      // Enviar solo las descargas que cambiaron desde el último snapshot (incremental).
      if (minVersion != null && minVersion > 0 && lastSnapshotServedTimestamp > 0) {
        const stateStore = downloadEngine.stateStore;
        if (stateStore) {
          const incremental = stateStore.getIncrementalSnapshot(
            lastSnapshotServedTimestamp,
            minVersion
          );
          lastSnapshotServedTimestamp = Date.now();

          if (incremental.downloads.length <= MAX_SNAPSHOT_DOWNLOADS) {
            return { success: true, data: incremental };
          }
          // Si hay demasiados cambios, fallback a snapshot completo
        }
      }

      // Snapshot completo (inicial o fallback)
      const snapshot = downloadEngine.getSnapshot(minVersion ?? undefined);
      lastSnapshotServedTimestamp = Date.now();

      if (snapshot.downloads.length <= MAX_SNAPSHOT_DOWNLOADS) {
        return { success: true, data: snapshot };
      }
      const truncated = {
        ...snapshot,
        downloads: snapshot.downloads.slice(0, MAX_SNAPSHOT_DOWNLOADS),
        truncated: true as const,
        totalCount: snapshot.downloads.length,
      };
      return { success: true, data: truncated };
    } catch (error) {
      log.error('Error en handler get-download-state:', error);
      return { success: false, error: (error as Error).message || 'Error desconocido' };
    }
  });

  ipcMain.handle(
    'add-download',
    createHandler('add-download', async (_event, ...args) => {
      const params = args[0] as EnrichParams & Record<string, unknown>;
      if (!downloadRateLimiter.isAllowed('ipc-handler')) {
        throw new Error('Demasiadas solicitudes, intente más tarde');
      }
      return await enrichAndAddDownload(params);
    })
  );

  ipcMain.handle('download-folder', async (_event, ...args) => {
    const params = args[0] as Record<string, unknown>;
    if (!downloadEngine || !downloadEngine.isInitialized) {
      return {
        success: false,
        error: 'DownloadEngine no está disponible. Reinicia la aplicación.',
      };
    }

    const validation = validateDownloadFolderParams(params);
    if (!validation.valid) {
      log.error(
        'Parámetros de descarga de carpeta inválidos:',
        (validation as { error?: string }).error
      );
      return { success: false, error: (validation as { error?: string }).error };
    }

    const validatedParams = validation.data as {
      folderId: number;
      downloadPath?: string | null;
      preserveStructure?: boolean;
      forceOverwrite?: boolean;
      deferStart?: boolean;
    };
    if (validatedParams.downloadPath === '') {
      validatedParams.downloadPath = null;
    }

    if (
      !validatedParams.downloadPath ||
      (typeof validatedParams.downloadPath === 'string' &&
        validatedParams.downloadPath.trim().length === 0)
    ) {
      return {
        success: false,
        error:
          'Ruta de descarga requerida. Por favor, configura una carpeta de descarga en Configuración.',
      };
    }

    const downloadPathStr = validatedParams.downloadPath ?? '';
    const pathValidation = validateAndSanitizeDownloadPath(downloadPathStr);
    if (!pathValidation.valid) {
      return { success: false, error: pathValidation.error };
    }
    validatedParams.downloadPath = pathValidation.path ?? undefined;

    try {
      const filesResult = await database.getAllFilesInFolder(validatedParams.folderId);
      if (!filesResult.success) {
        return { success: false, error: filesResult.error || ERRORS.DOWNLOAD.GET_FILES_FAILED };
      }

      const files = filesResult.data || [];
      if (files.length === 0) {
        return { success: false, error: 'La carpeta no contiene archivos' };
      }

      const folderInfo = database.getNodeInfo(validatedParams.folderId);
      const folderTitle =
        folderInfo.success && folderInfo.data
          ? (folderInfo.data as { name?: string }).name
          : `Carpeta ${validatedParams.folderId}`;

      const deferStart = validatedParams.deferStart === true;
      const FOLDER_ASYNC_THRESHOLD = 25;
      const PROGRESS_BATCH_SIZE = 10;

      const runFolderAddLoop = async (): Promise<{
        addedCount: number;
        errors: { fileId: number; fileName?: string; error: string }[];
      }> => {
        let addedCount = 0;
        const errors: { fileId: number; fileName?: string; error: string }[] = [];
        for (let i = 0; i < files.length; i++) {
          const file = files[i] as { id: number; title?: string };
          try {
            const downloadParams = {
              id: file.id,
              title: sanitizeFileName(file.title ?? ''),
              downloadPath: validatedParams.downloadPath,
              preserveStructure: validatedParams.preserveStructure !== false,
              forceOverwrite: validatedParams.forceOverwrite || false,
              skipQueueLimit: true,
              startPaused: deferStart,
            };
            await enrichAndAddDownload(downloadParams);
            addedCount++;
          } catch (err) {
            const msg = (err as Error).message;
            log.warn(`No se pudo agregar archivo ${file.id} (${file.title}):`, msg);
            errors.push({ fileId: file.id, fileName: file.title, error: msg });
          }
          if (files.length > FOLDER_ASYNC_THRESHOLD && (i + 1) % PROGRESS_BATCH_SIZE === 0) {
            sendToRenderer('folder-add-progress', {
              added: addedCount,
              total: files.length,
              errorsCount: errors.length,
            });
          }
        }
        return { addedCount, errors };
      };

      if (files.length <= FOLDER_ASYNC_THRESHOLD) {
        const { addedCount, errors } = await runFolderAddLoop();
        log.info(
          `Descarga de carpeta: ${addedCount} archivos agregados de ${files.length} en "${folderTitle}"`
        );
        return {
          success: true,
          totalFiles: files.length,
          added: addedCount,
          skipped: files.length - addedCount,
          folderTitle: String(folderTitle).replace(/\/$/, ''),
          errors: errors.length > 0 ? errors : undefined,
        };
      }

      setImmediate(() => {
        runFolderAddLoop()
          .then(({ addedCount, errors }) => {
            log.info(
              `Descarga de carpeta (background): ${addedCount} archivos agregados de ${files.length} en "${folderTitle}"`
            );
            sendToRenderer('folder-add-complete', {
              totalFiles: files.length,
              added: addedCount,
              skipped: files.length - addedCount,
              folderTitle: String(folderTitle).replace(/\/$/, ''),
              errors: errors.length > 0 ? errors : undefined,
            });
          })
          .catch(err => {
            log.error('Error en descarga de carpeta en segundo plano:', err);
            sendToRenderer('folder-add-complete', {
              totalFiles: files.length,
              added: 0,
              skipped: files.length,
              folderTitle: String(folderTitle).replace(/\/$/, ''),
              error: (err as Error).message,
            });
          });
      });

      return {
        success: true,
        accepted: true,
        processingInBackground: true,
        total: files.length,
        folderTitle: String(folderTitle).replace(/\/$/, ''),
      };
    } catch (error) {
      log.error('Error al descargar carpeta:', error);
      return {
        success: false,
        error: (error as Error).message || ERRORS.DOWNLOAD.FOLDER_PROCESSING_FAILED,
      };
    }
  });

  ipcMain.handle(
    'pause-download-state',
    createHandler('pause-download-state', async (_event, ...args) => {
      const downloadId = args[0];
      const validation = validateDownloadId(downloadId);
      if (!validation.valid) {
        throw new Error((validation as { error?: string }).error || 'ID inválido');
      }
      if (!downloadRateLimiter.isAllowed('ipc-handler')) {
        throw new Error('Demasiadas solicitudes, intente más tarde');
      }
      return await downloadEngine!.pauseDownload(validation.data as number);
    })
  );

  ipcMain.handle(
    'resume-download-state',
    createHandler('resume-download-state', async (_event, ...args) => {
      const downloadId = args[0];
      const validation = validateDownloadId(downloadId);
      if (!validation.valid) {
        throw new Error((validation as { error?: string }).error || 'ID inválido');
      }
      if (!downloadRateLimiter.isAllowed('ipc-handler')) {
        throw new Error('Demasiadas solicitudes, intente más tarde');
      }
      return await downloadEngine!.resumeDownload(validation.data as number);
    })
  );

  ipcMain.handle(
    'cancel-download-state',
    createHandler('cancel-download-state', async (_event, ...args) => {
      const downloadId = args[0];
      const validation = validateDownloadId(downloadId);
      if (!validation.valid) {
        throw new Error((validation as { error?: string }).error || 'ID inválido');
      }
      if (!downloadRateLimiter.isAllowed('ipc-handler')) {
        throw new Error('Demasiadas solicitudes, intente más tarde');
      }
      return await downloadEngine!.cancelDownload(validation.data as number);
    })
  );

  ipcMain.handle(
    'delete-download-state',
    createHandler('delete-download-state', async (_event, ...args) => {
      const downloadId = args[0];
      const validation = validateDownloadId(downloadId);
      if (!validation.valid) {
        throw new Error((validation as { error?: string }).error || 'ID inválido');
      }
      if (!downloadRateLimiter.isAllowed('ipc-handler')) {
        throw new Error('Demasiadas solicitudes, intente más tarde');
      }
      if (!downloadEngine) {
        throw new Error('DownloadEngine no está inicializado');
      }
      const stateStore = downloadEngine.stateStore;
      if (!stateStore) {
        throw new Error('StateStore no está disponible');
      }
      const id = validation.data as number;
      const download = stateStore.getDownload(id);
      // Si no existe en memoria puede estar solo en DB; intentar borrar y emitir refresco de todas formas.
      if (!download) {
        const deleted = stateStore.deleteDownload(id);
        const snapshot = stateStore.getSnapshot();
        eventBus.emitStateChanged(snapshot.stateVersion);
        if (deleted && log.debug) {
          log.debug(
            `[delete-download-state] Descarga ${id} eliminada por DELETE directo (getDownload había devuelto null)`
          );
        } else if (log.debug) {
          log.debug(
            `[delete-download-state] Descarga ${id} no encontrada (ya eliminada o ID inexistente), emitiendo refresco`
          );
        }
        return { success: true, snapshot };
      }

      const savePath = download.savePath ?? null;
      // Solo borrar archivo en disco (.staging o savePath) si la descarga estaba incompleta; nunca borrar el archivo final completado.
      const wasChunkedOrIncomplete =
        download.state !== DownloadState.COMPLETED &&
        (download.state === DownloadState.MERGING ||
          download.state === DownloadState.CANCELLED ||
          download.state === DownloadState.FAILED);

      const activeStates: Set<string> = new Set([
        DownloadState.DOWNLOADING,
        DownloadState.STARTING,
        DownloadState.MERGING,
        DownloadState.VERIFYING,
      ]);
      if (activeStates.has(download.state)) {
        await downloadEngine.cancelDownload(id);
      }

      const deleted = stateStore.deleteDownload(id);
      if (!deleted) {
        throw new Error('No se pudo eliminar la descarga');
      }
      // Limpiar throttle de progreso para esta descarga
      clearProgressThrottleForDownload(id);

      // Si estaba incompleta: borrar chunks y .staging/savePath (temporales). Si estaba listo (completed), los chunks ya se borraron al completar; no tocar nada en disco.
      if (download.state !== DownloadState.COMPLETED) {
        try {
          await downloadEngine.chunkStore
            .deleteAllChunks(id)
            .catch((e: Error) => log.debug?.(`Cleanup chunks ${id}:`, e?.message));
          if (savePath && wasChunkedOrIncomplete) {
            const stagingPath = `${savePath}.staging`;
            await fs
              .unlink(stagingPath)
              .catch((e: Error) => log.debug?.(`Cleanup staging ${id}:`, e?.message));
            await fs
              .unlink(savePath)
              .catch((e: Error) => log.debug?.(`Cleanup savePath ${id}:`, e?.message));
          }
        } catch (e) {
          if (log.debug) log.debug(`[delete-download-state] Error limpiando archivos de ${id}:`, e);
        }
      }

      const snapshot = stateStore.getSnapshot();
      eventBus.emitStateChanged(snapshot.stateVersion);
      return { success: true, snapshot };
    })
  );

  ipcMain.handle(
    'restart-stopped-with-overwrite',
    createHandler('restart-stopped-with-overwrite', async (_event, ...args) => {
      if (!downloadRateLimiter.isAllowed('ipc-handler')) {
        throw new Error('Demasiadas solicitudes, intente más tarde');
      }
      if (!downloadEngine) {
        throw new Error('DownloadEngine no está inicializado');
      }
      const ids = args[0] as number[] | undefined;
      const snapshot = await downloadEngine.restartStoppedWithOverwrite(ids);
      return { success: true, snapshot };
    })
  );

  ipcMain.handle(
    'clear-downloads-state',
    createHandler('clear-downloads-state', async () => {
      if (!downloadRateLimiter.isAllowed('ipc-handler')) {
        throw new Error('Demasiadas solicitudes, intente más tarde');
      }
      if (!downloadEngine) {
        throw new Error('DownloadEngine no está inicializado');
      }
      const stateStore = downloadEngine.stateStore;
      if (!stateStore) {
        throw new Error('StateStore no está disponible');
      }
      // Solo quitar de la lista las descargas en estado listo (completed). No borrar nada en disco: los chunks ya se eliminaron al completar; el archivo final se conserva.
      const count = stateStore.clearDownloads();
      // Limpiar todos los throttles de progreso de descargas eliminadas
      lastProgressSentByDownload.clear();
      const snapshot = stateStore.getSnapshot();
      eventBus.emitStateChanged(snapshot.stateVersion);
      return { success: true, count, snapshot };
    })
  );

  ipcMain.handle(
    'pause-all-downloads',
    createHandler('pause-all-downloads', async () => {
      if (!downloadEngine) {
        throw new Error('DownloadEngine no está inicializado');
      }
      if (!downloadRateLimiter.isAllowed('ipc-handler')) {
        throw new Error('Demasiadas solicitudes, intente más tarde');
      }
      return await downloadEngine.pauseAll();
    })
  );

  ipcMain.handle(
    'cancel-all-downloads',
    createHandler('cancel-all-downloads', async () => {
      if (!downloadEngine) {
        throw new Error('DownloadEngine no está inicializado');
      }
      if (!downloadRateLimiter.isAllowed('ipc-handler')) {
        throw new Error('Demasiadas solicitudes, intente más tarde');
      }
      return await downloadEngine.cancelAll();
    })
  );

  ipcMain.handle(
    'resume-all-downloads',
    createHandler('resume-all-downloads', async () => {
      if (!downloadEngine) {
        throw new Error('DownloadEngine no está inicializado');
      }
      if (!downloadRateLimiter.isAllowed('ipc-handler')) {
        throw new Error('Demasiadas solicitudes, intente más tarde');
      }
      return await downloadEngine.resumeAll();
    })
  );

  ipcMain.handle('get-suggested-test-file', async () => {
    try {
      const file = database.getSuggestedTestFile();
      if (!file || !file.url) {
        return {
          success: false,
          error:
            'No hay archivos de al menos 1 KB en el catálogo para probar. Navega a una carpeta con archivos (p. ej. ROMs) y vuelve a intentar.',
        };
      }
      let url = file.url;
      if (url && !url.startsWith('http')) {
        const parts = url.split('/').map((part: string) => encodeURIComponent(part));
        url = `https://myrient.erista.me/files/${parts.join('/')}`;
      }
      if (!isValidUrl(url)) {
        return { success: false, error: 'URL del archivo de prueba no válida.' };
      }
      const totalBytes = file.size_bytes || 0;
      if (totalBytes < 1024) {
        return { success: false, error: 'El archivo de prueba es demasiado pequeño (mín. 1 KB).' };
      }
      return {
        success: true,
        fileId: file.id,
        url,
        title: file.name,
        totalBytes,
      };
    } catch (error) {
      log.error('Error obteniendo archivo de prueba:', error);
      return { success: false, error: (error as Error).message || 'Error desconocido' };
    }
  });

  ipcMain.handle(
    'run-connection-test',
    createHandler('run-connection-test', async (_event, ...args) => {
      const params = (args[0] ?? {}) as { url?: string; totalBytes?: number };
      const { url, totalBytes } = params;
      if (!url || typeof totalBytes !== 'number' || totalBytes < 1024) {
        return {
          success: false,
          error: 'URL o tamaño inválido.',
          recommendedMaxChunks: 1,
          recommendedMaxParallel: 1,
          message: 'Se necesita URL absoluta y tamaño >= 1 KB.',
          details: [],
        };
      }
      const result = await runConnectionTest({ url, totalBytes });
      return { ...result, success: result.success };
    })
  );

  ipcMain.handle(
    'apply-download-settings',
    createHandler('apply-download-settings', async (_event, ...args) => {
      const rawSettings = args[0] ?? {};

      // Validar payload con Zod
      const zodValidation = validateDownloadSettings(rawSettings);
      if (!zodValidation.success) {
        log.warn('Payload apply-download-settings inválido:', zodValidation.error);
        throw new Error(`Configuración de descarga inválida: ${zodValidation.error}`);
      }

      const settings = zodValidation.data!;
      if (downloadEngine) {
        const turbo = settings.turboDownload === true;
        const scheduler = downloadEngine.scheduler;
        if (scheduler) {
          scheduler.setTurboMode(turbo);
          if (turbo) {
            scheduler.setMaxConcurrent(1);
            scheduler.setMaxConcurrentPerHost(1);
            downloadEngine.updateAdaptiveConcurrencyMax(1);
          } else {
            const n = settings.maxParallelDownloads;
            if (typeof n === 'number' && n >= 1) {
              const maxP = Math.min(3, Math.max(1, n));
              scheduler.setMaxConcurrent(maxP);
              scheduler.setMaxConcurrentPerHost(Math.min(maxP, 2));
              downloadEngine.updateAdaptiveConcurrencyMax(maxP);
            }
          }
        }
        const chunks = turbo
          ? 4
          : typeof settings.maxConcurrentChunks === 'number'
            ? Math.min(4, Math.max(1, settings.maxConcurrentChunks))
            : undefined;
        downloadEngine.setDownloadConfigOverrides({
          maxConcurrentChunks: chunks,
          maxChunkRetries: settings.maxChunkRetries,
          chunkOperationTimeoutMinutes: settings.chunkOperationTimeoutMinutes,
          skipVerification: settings.skipVerification,
          disableChunkedDownloads: settings.disableChunkedDownloads,
        });
        downloadEngine.processQueue().catch((err: Error) => {
          log.warn('Error al reprocesar cola tras aplicar ajustes:', err);
        });
      }
      return { success: true };
    })
  );

  ipcMain.handle(
    'confirm-overwrite-state',
    createHandler('confirm-overwrite-state', async (_event, ...args) => {
      const downloadId = args[0];
      const validation = validateDownloadId(downloadId);
      if (!validation.valid) {
        throw new Error((validation as { error?: string }).error || 'ID inválido');
      }
      if (!downloadRateLimiter.isAllowed('ipc-handler')) {
        throw new Error('Demasiadas solicitudes, intente más tarde');
      }
      return await downloadEngine!.confirmOverwrite(validation.data as number);
    })
  );

  ipcMain.handle(
    'get-download-debug',
    createHandler('get-download-debug', async (_event, ...args) => {
      const downloadId = args[0];
      const validation = validateDownloadId(downloadId);
      if (!validation.valid) {
        throw new Error((validation as { error?: string }).error || 'ID inválido');
      }
      return await downloadEngine!.getDownloadDebug(validation.data as number);
    })
  );

  ipcMain.handle('get-session-metrics', async () => {
    try {
      if (!downloadEngine?.isInitialized) {
        return { success: true, data: null };
      }
      const metrics = downloadEngine.getSessionMetrics();
      return { success: true, data: metrics };
    } catch (error) {
      log.error('Error en handler get-session-metrics:', error);
      return { success: false, error: (error as Error).message || 'Error desconocido' };
    }
  });

  log.info('IPC State Handlers registrados');
}

const STATE_CHANNELS = [
  'get-download-state',
  'add-download',
  'download-folder',
  'pause-download-state',
  'resume-download-state',
  'cancel-download-state',
  'delete-download-state',
  'clear-downloads-state',
  'restart-stopped-with-overwrite',
  'pause-all-downloads',
  'cancel-all-downloads',
  'resume-all-downloads',
  'apply-download-settings',
  'confirm-overwrite-state',
  'get-download-debug',
  'get-session-metrics',
];

/** Quita todos los handlers IPC registrados por registerStateHandlers. No cierra el motor; usar closeDownloadEngine. */
export function removeStateHandlers(): void {
  for (const channel of STATE_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
  log.info('IPC State Handlers removidos');
}

/** Cierra el DownloadEngine, libera la referencia y quita los listeners del EventBus. */
export async function closeDownloadEngine(): Promise<void> {
  if (downloadEngine) {
    await downloadEngine.close();
    downloadEngine = null;
    log.info('DownloadEngine cerrado');
  }
  cleanupEventListeners();
}

/** Devuelve la instancia actual del motor de descargas o null si no está inicializado o ya se cerró. */
export function getDownloadEngine(): DownloadEngine | null {
  return downloadEngine;
}
