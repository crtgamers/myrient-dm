/**
 * Utilidades para handlers IPC del proceso main.
 *
 * - createHandler: envuelve un handler async capturando excepciones y devolviendo
 *   siempre { success, data? | error? }. Opcionalmente comprueba que el motor de
 *   descargas esté inicializado antes de ejecutar.
 * - sendDownloadProgress: envía progreso al renderer con límite de tamaño de payload
 *   para no saturar el canal IPC (trunca chunkProgress/metadata si excede MAX_PAYLOAD_SIZE).
 *
 * @module ipcHelpers
 */

import type { BrowserWindow } from 'electron';
import { logger } from './logger';

const log = logger.child('IPCHelpers');

export interface CreateHandlerOptions {
  /** Si true, la respuesta se envuelve en { success: true, data: result }; en error, { success: false, error, code? }. */
  wrapSuccess?: boolean;
  /** Función que debe devolver el motor; si es null/false isInitialized, se responde engineNotInitResponse. */
  checkEngine?: () => unknown;
  /** Respuesta cuando checkEngine indica que el motor no está disponible. */
  engineNotInitResponse?: { success: false; error: string; code?: string };
  /** Logger para errores del handler (opcional). */
  log?: { error: (..._args: unknown[]) => void };
  /** Mensaje por defecto cuando el handler lanza y error.message está vacío. */
  defaultErrorMessage?: string;
  /** Si se proporciona y !isPackaged, se incluye err.stack en la respuesta de error (solo con wrapSuccess). */
  app?: { isPackaged: boolean };
}

type IpcHandler = (
  _event: Electron.IpcMainInvokeEvent,
  ..._args: unknown[]
) => Promise<unknown> | unknown;

/**
 * Crea un wrapper para ipcMain.handle que captura excepciones y normaliza la respuesta.
 *
 * @param channel - Nombre del canal (solo para logging).
 * @param handler - Función async que realiza la lógica; puede lanzar Error.
 * @param options - wrapSuccess, checkEngine, logging y mensaje por defecto.
 * @returns Función compatible con ipcMain.handle.
 */
export function createHandler(
  channel: string,
  handler: IpcHandler,
  options: CreateHandlerOptions = {}
): (_event: Electron.IpcMainInvokeEvent, ..._args: unknown[]) => Promise<unknown> {
  const {
    wrapSuccess = false,
    checkEngine = null,
    engineNotInitResponse = null,
    log: handlerLog = null,
    defaultErrorMessage = 'Error desconocido',
    app: appForStack = null,
  } = options;

  const notInitResponse = engineNotInitResponse ?? {
    success: false,
    error: 'DownloadEngine no está disponible. Reinicia la aplicación.',
    code: 'ENGINE_NOT_INITIALIZED',
  };

  return async (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => {
    if (checkEngine) {
      const engine = checkEngine();
      if (!engine || (engine as { isInitialized?: boolean }).isInitialized === false) {
        if (handlerLog) handlerLog.error(`[${channel}] Motor no disponible`);
        return notInitResponse;
      }
    }

    try {
      const result = await handler(event, ...args);
      if (wrapSuccess) {
        return { success: true, data: result };
      }
      return result;
    } catch (error) {
      const err = error as Error & { code?: string };
      if (handlerLog) handlerLog.error(`[${channel}] Error en handler:`, error);
      if (wrapSuccess) {
        const response: { success: false; error: string; code: string; stack?: string } = {
          success: false,
          error: err.message || defaultErrorMessage,
          code: err.code || 'UNKNOWN_ERROR',
        };
        if (appForStack && !appForStack.isPackaged && err.stack) {
          response.stack = err.stack;
        }
        return response;
      }
      return {
        success: false,
        error: err.message || defaultErrorMessage,
      };
    }
  };
}

/** Límite en bytes del payload enviado por download-progress; por encima se trunca chunkProgress/metadata. */
export const MAX_PAYLOAD_SIZE = 100 * 1024;

interface DownloadProgressPayload {
  id: number;
  state?: string;
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  title?: string;
  savePath?: string;
  speed?: number;
  remainingTime?: number;
  chunkProgress?: Array<{ index: number; progress?: number; state?: string }>;
  activeChunks?: number;
  completedChunks?: number;
  totalChunks?: number;
}

/**
 * Envía un evento download-progress al renderer. Si el payload supera MAX_PAYLOAD_SIZE,
 * se eliminan chunkProgress, title y savePath y se reenvía; si sigue por encima, no se envía.
 *
 * @param mainWindow - Ventana a la que enviar; se ignora si es null o destruida.
 * @param download - Datos de progreso (id, bytes, estado, opcionalmente chunks).
 * @param options - includeChunks e includeMetadata para controlar qué campos se incluyen.
 */
export function sendDownloadProgress(
  mainWindow: BrowserWindow | null,
  download: DownloadProgressPayload,
  options: { includeChunks?: boolean; includeMetadata?: boolean } = {}
): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const { includeChunks = false, includeMetadata = false } = options;

  const payload: Record<string, unknown> = {
    id: download.id,
    state: download.state || 'queued',
    progress: download.progress ?? 0,
    downloadedBytes: download.downloadedBytes ?? 0,
    totalBytes: download.totalBytes ?? 0,
  };

  if (includeMetadata) {
    if (download.title) payload.title = download.title;
    if (download.savePath) payload.savePath = download.savePath;
    if (download.speed !== undefined) payload.speed = download.speed;
    if (download.remainingTime !== undefined) payload.remainingTime = download.remainingTime;
  }

  if (includeChunks && download.chunkProgress && Array.isArray(download.chunkProgress)) {
    const relevantChunks = download.chunkProgress
      .filter(chunk => chunk.state === 'active' || chunk.state === 'completed')
      .slice(0, 10)
      .map(chunk => ({
        index: chunk.index,
        progress: chunk.progress,
        state: chunk.state,
      }));

    if (relevantChunks.length > 0) {
      payload.chunkProgress = relevantChunks;
      payload.activeChunks = (download as { activeChunks?: number }).activeChunks ?? 0;
      payload.completedChunks = (download as { completedChunks?: number }).completedChunks ?? 0;
      payload.totalChunks = (download as { totalChunks?: number }).totalChunks ?? 0;
    }
  }

  const payloadSize = JSON.stringify(payload).length;
  if (payloadSize > MAX_PAYLOAD_SIZE) {
    log.warn(
      `Payload IPC demasiado grande: ${payloadSize} bytes (límite: ${MAX_PAYLOAD_SIZE}), truncando`
    );
    delete payload.chunkProgress;
    delete payload.title;
    delete payload.savePath;
    const reducedSize = JSON.stringify(payload).length;
    if (reducedSize > MAX_PAYLOAD_SIZE) {
      log.error(
        `Payload aún demasiado grande después de truncar: ${reducedSize} bytes, omitiendo envío`
      );
      return;
    }
  }

  try {
    mainWindow.webContents.send('download-progress', payload);
  } catch (error) {
    log.error('Error enviando progreso IPC:', error);
  }
}
