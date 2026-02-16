/**
 * API de descargas: cola, historial, configuración, test de conexión, eventos.
 * @module api/downloads
 */

import { getApi, apiLogger, API_ERRORS, GENERAL_ERRORS } from './internal';
import type {
  APIResponse,
  DownloadParams,
  FolderDownloadParams,
  CleanHistoryResponse,
  ApplyDownloadSettingsParams,
  SuggestedTestFileResponse,
  ConnectionTestData,
} from './types';
import type {
  DownloadStateChangedPayload,
  DownloadProgressPayload,
  DownloadCompletedPayload,
  DownloadFailedPayload,
  ChunkFailedPayload,
  NeedsConfirmationPayload,
  FolderAddProgressPayload,
  FolderAddCompletePayload,
} from '../../types/preload';

export type {
  DownloadParams,
  FolderDownloadParams,
  CleanHistoryResponse,
  ApplyDownloadSettingsParams,
  SuggestedTestFileResponse,
  ConnectionTestData,
};

/**
 * Inicia la descarga de una carpeta (todos los archivos recursivamente).
 * @param params - folderId, downloadPath, preserveStructure, forceOverwrite.
 * @returns success y data/error según resultado del backend.
 */
export async function downloadFolder(params: FolderDownloadParams): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return await api.downloadFolder(params);
  } catch (error) {
    apiLogger.error('Error iniciando descarga de carpeta:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Limpia el estado de descargas antiguas (llama a clearDownloadsState en backend).
 * @param _daysOld - Reservado para futura limpieza por antigüedad; actualmente no usado.
 * @returns success, count de registros limpiados y error opcional.
 */
export async function cleanHistory(_daysOld = 30): Promise<CleanHistoryResponse> {
  const api = getApi();
  if (!api) return { success: false, count: 0, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const result = await api.clearDownloadsState();
    const ok = result?.success === true;
    const count =
      (result as { data?: { count?: number }; count?: number })?.data?.count ??
      (result as { count?: number })?.count ??
      0;
    return {
      success: ok,
      count,
      error: ok ? undefined : ((result as { error?: string })?.error ?? GENERAL_ERRORS.UNKNOWN),
    };
  } catch (error) {
    apiLogger.error('Error limpiando historial:', error);
    return { success: false, count: 0, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Limpia todo el historial de descargas en el backend.
 * @returns success, count y error opcional.
 */
export async function clearHistory(): Promise<CleanHistoryResponse> {
  const api = getApi();
  if (!api) return { success: false, count: 0, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const result = await api.clearDownloadsState();
    const ok = result?.success === true;
    const res = result as { count?: number; data?: { count?: number } };
    const count = res?.count ?? res?.data?.count ?? 0;
    return {
      success: ok,
      count,
      error: ok ? undefined : ((result as { error?: string })?.error ?? GENERAL_ERRORS.UNKNOWN),
    };
  } catch (error) {
    apiLogger.error('Error limpiando todo el historial:', error);
    return { success: false, count: 0, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Aplica configuración de descargas (maxParallel, chunks, retries, timeouts, etc.).
 * @param settings - Parámetros de configuración; se envían al proceso main.
 * @returns success o error.
 */
export async function applyDownloadSettings(
  settings: ApplyDownloadSettingsParams | Record<string, unknown> = {}
): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    await api.applyDownloadSettings((settings || {}) as Record<string, unknown>);
    return { success: true };
  } catch (error) {
    apiLogger.error('Error aplicando configuración de descargas:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Obtiene un archivo pequeño sugerido del catálogo para test de conexión (configuración).
 * @returns success, fileId, url, title, totalBytes o error.
 */
export async function getSuggestedTestFile(): Promise<SuggestedTestFileResponse> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const res = (await api.getSuggestedTestFile()) as SuggestedTestFileResponse & {
      fileId?: number;
      url?: string;
      title?: string;
      totalBytes?: number;
    };
    return res?.success
      ? {
          success: true,
          fileId: res.fileId,
          url: res.url,
          title: res.title,
          totalBytes: res.totalBytes,
        }
      : { success: false, error: res?.error || 'No se pudo obtener archivo de prueba' };
  } catch (error) {
    apiLogger.error('Error obteniendo archivo de prueba:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Ejecuta una prueba de conexión contra la URL con el tamaño dado (recomendaciones de chunks/paralelo).
 * @param url - URL del archivo de prueba.
 * @param totalBytes - Tamaño en bytes.
 * @returns success, data (recommendedMaxChunks, recommendedMaxParallel, message, details) o error.
 */
export async function runConnectionTest(
  url: string,
  totalBytes: number
): Promise<{ success: boolean; data?: ConnectionTestData; error?: string }> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const res = (await api.runConnectionTest({ url, totalBytes })) as {
      success?: boolean;
      data?: ConnectionTestData;
      error?: string;
      message?: string;
    };
    if (res?.success && res.data) {
      return { success: true, data: res.data };
    }
    return {
      success: false,
      error: res?.error || (res.data?.message as string | undefined) || 'Error en la prueba',
      data: res.data,
    };
  } catch (error) {
    apiLogger.error('Error en test de conexión:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Obtiene el estado actual de la cola de descargas (snapshot).
 * @param minVersion - Si se indica, el backend puede devolver solo cambios desde esa versión (incremental).
 * @returns success, data (lista de descargas, stateVersion, etc.) y error opcional.
 */
export async function getDownloadState(
  minVersion: number | null = null
): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return await api.getDownloadState(minVersion);
  } catch (error) {
    apiLogger.error('Error obteniendo estado de descargas:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Añade una descarga a la cola (archivo por id/title y opciones de ruta/sobrescritura).
 * @param params - id, title, downloadPath, preserveStructure, forceOverwrite.
 * @returns success y data o error.
 */
export async function addDownload(params: DownloadParams): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const result = await api.addDownload({
      id: params.id,
      title: params.title,
      downloadPath: params.downloadPath,
      preserveStructure: params.preserveStructure,
      forceOverwrite: params.forceOverwrite,
    });
    return { success: true, data: result };
  } catch (error) {
    apiLogger.error('Error agregando descarga:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/** Pausa una descarga por ID. */
export async function pauseDownloadState(downloadId: number): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const result = await api.pauseDownloadState(downloadId);
    return { success: true, data: result };
  } catch (error) {
    apiLogger.error('Error pausando descarga:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/** Pausa todas las descargas en curso. */
export async function pauseAllDownloads(): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const result = await api.pauseAllDownloads();
    return { success: true, data: result };
  } catch (error) {
    apiLogger.error('Error pausando todas las descargas:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/** Cancela todas las descargas (en curso y en cola). */
export async function cancelAllDownloads(): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const result = await api.cancelAllDownloads();
    return { success: true, data: result };
  } catch (error) {
    apiLogger.error('Error cancelando todas las descargas:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/** Reanuda todas las descargas pausadas. */
export async function resumeAllDownloads(): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const result = await api.resumeAllDownloads();
    return { success: true, data: result };
  } catch (error) {
    apiLogger.error('Error reanudando todas las descargas:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/** Reanuda una descarga pausada por ID. */
export async function resumeDownloadState(downloadId: number): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const result = await api.resumeDownloadState(downloadId);
    return { success: true, data: result };
  } catch (error) {
    apiLogger.error('Error reanudando descarga:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/** Cancela una descarga por ID. */
export async function cancelDownloadState(downloadId: number): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const result = await api.cancelDownloadState(downloadId);
    return { success: true, data: result };
  } catch (error) {
    apiLogger.error('Error cancelando descarga:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/** Elimina una descarga del estado (historial), por ID. */
export async function deleteDownloadState(downloadId: number): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const result = await api.deleteDownloadState(downloadId);
    return { success: true, data: result };
  } catch (error) {
    apiLogger.error('Error eliminando descarga:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/** Confirma sobrescritura para una descarga que está esperando confirmación. */
export async function confirmOverwriteState(downloadId: number): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const result = await api.confirmOverwriteState(downloadId);
    return { success: true, data: result };
  } catch (error) {
    apiLogger.error('Error confirmando sobrescritura:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Obtiene información de depuración de una descarga (para diagnóstico).
 * No usado por la UI actual; útil para DevTools o pantallas de soporte.
 */
export async function getDownloadDebug(downloadId: number): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const result = await api.getDownloadDebug(downloadId);
    return { success: true, data: result };
  } catch (error) {
    apiLogger.error('Error obteniendo debug de descarga:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/** Obtiene métricas agregadas de la sesión actual. */
export async function getSessionMetrics(): Promise<APIResponse<Record<string, unknown> | null>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const result = (await api.getSessionMetrics()) as {
      success?: boolean;
      data?: Record<string, unknown> | null;
      error?: string;
    };
    if (result?.success && 'data' in result) {
      return { success: true, data: result.data ?? null };
    }
    return {
      success: false,
      error: result?.error ?? GENERAL_ERRORS.UNKNOWN,
    };
  } catch (error) {
    apiLogger.error('Error obteniendo métricas de sesión:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

// ——— Eventos ———

export function onDownloadStateChanged(
  callback: (_payload: DownloadStateChangedPayload) => void
): () => void {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a eventos: API no disponible');
    return () => {};
  }
  return api.on('download-state-changed', callback);
}

export function onDownloadCompleted(
  callback: (_payload: DownloadCompletedPayload) => void
): () => void {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a eventos: API no disponible');
    return () => {};
  }
  return api.on('download-completed', callback);
}

export function onDownloadFailed(callback: (_payload: DownloadFailedPayload) => void): () => void {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a eventos: API no disponible');
    return () => {};
  }
  return api.on('download-failed', callback);
}

export function onChunkFailed(callback: (_payload: ChunkFailedPayload) => void): () => void {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a eventos: API no disponible');
    return () => {};
  }
  return api.on('chunk-failed', callback);
}

export function onNeedsConfirmation(
  callback: (_payload: NeedsConfirmationPayload) => void
): () => void {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a eventos: API no disponible');
    return () => {};
  }
  return api.on('needs-confirmation', callback);
}

export function onDownloadProgress(
  callback: (_payload: DownloadProgressPayload) => void
): () => void {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a eventos: API no disponible');
    return () => {};
  }
  return api.on('download-progress', callback);
}

export function onHistoryCleaned(callback: (..._args: unknown[]) => void): () => void {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a eventos: API no disponible');
    return () => {};
  }
  return api.on('history-cleaned', callback);
}

export function onDownloadsRestored(callback: (..._args: unknown[]) => void): () => void {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a eventos: API no disponible');
    return () => {};
  }
  return api.on('downloads-restored', callback);
}

export function onErrorNotification(callback: (..._args: unknown[]) => void): () => void {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a eventos de error: API no disponible');
    return () => {};
  }
  return api.on('error-notification', callback);
}

export function onFolderAddProgress(
  callback: (_payload: FolderAddProgressPayload) => void
): () => void {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a folder-add-progress: API no disponible');
    return () => {};
  }
  return api.on('folder-add-progress', callback);
}

export function onFolderAddComplete(
  callback: (_payload: FolderAddCompletePayload) => void
): () => void {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a folder-add-complete: API no disponible');
    return () => {};
  }
  return api.on('folder-add-complete', callback);
}
