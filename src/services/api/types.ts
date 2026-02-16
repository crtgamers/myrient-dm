/**
 * Tipos e interfaces públicos del servicio API.
 * @module api/types
 */

import type { SearchOptions } from '../../types/preload';

export type { SearchOptions };

/** Respuesta estándar de las llamadas API (success, data opcional, error opcional, total opcional). */
export interface APIResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  total?: number;
}

/** Parámetros para añadir una descarga (archivo) a la cola. */
export interface DownloadParams {
  id: number;
  title: string;
  downloadPath?: string;
  preserveStructure?: boolean;
  forceOverwrite?: boolean;
}

/** Parámetros para descargar una carpeta completa. */
export interface FolderDownloadParams {
  folderId: number;
  downloadPath?: string;
  preserveStructure?: boolean;
  forceOverwrite?: boolean;
}

/** Resultado del test de conexión con recomendaciones de chunks y paralelismo. */
export interface ConnectionTestData {
  success: boolean;
  recommendedMaxChunks: number;
  recommendedMaxParallel: number;
  message: string;
  details: string[];
}

/** Respuesta del archivo de prueba sugerido para test de conexión. */
export interface SuggestedTestFileResponse {
  success: boolean;
  fileId?: number;
  url?: string;
  title?: string;
  totalBytes?: number;
  error?: string;
}

/** Respuesta de limpieza de historial (count de registros eliminados). */
export interface CleanHistoryResponse {
  success: boolean;
  count: number;
  error?: string;
}

/** Parámetros para aplicar configuración de descargas desde el panel de ajustes. */
export interface ApplyDownloadSettingsParams {
  maxParallelDownloads?: number;
  maxConcurrentChunks?: number;
  maxChunkRetries?: number;
  chunkOperationTimeoutMinutes?: number;
  skipVerification?: boolean;
  disableChunkedDownloads?: boolean;
  turboDownload?: boolean;
}

/** Respuesta con path (ruta de datos de usuario, carpeta abierta, etc.). */
export interface PathResponse {
  success: boolean;
  path?: string;
  error?: string;
}
