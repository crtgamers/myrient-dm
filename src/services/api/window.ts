/**
 * API de ventana y sistema: minimizar, maximizar, carpeta, rutas, URL externa.
 * @module api/window
 */

import { getApi, apiLogger, API_ERRORS, GENERAL_ERRORS } from './internal';
import type { APIResponse, PathResponse } from './types';

export type { PathResponse };

/** Minimiza la ventana principal. No hace nada si la API no está disponible. */
export function minimizeWindow(): void {
  const api = getApi();
  if (api) void api.minimizeWindow();
}

/** Maximiza o restaura la ventana principal. */
export function maximizeWindow(): void {
  const api = getApi();
  if (api) void api.maximizeWindow();
}

/** Indica si la ventana principal está maximizada (para sincronizar el icono de la barra de título). */
export async function getWindowIsMaximized(): Promise<boolean> {
  const api = getApi();
  if (!api) return false;
  const res = await api.getWindowIsMaximized();
  return res?.data === true;
}

/** Cierra la ventana principal (puede terminar la aplicación si es la única). */
export function closeWindow(): void {
  const api = getApi();
  if (api) void api.closeWindow();
}

/**
 * Abre el diálogo nativo para seleccionar una carpeta.
 * @returns success y data (ruta seleccionada) o null si el usuario cancela; error si falla.
 */
export async function selectFolder(): Promise<APIResponse<string | null>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return await api.selectFolder();
  } catch (error) {
    apiLogger.error('Error seleccionando carpeta:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Obtiene la ruta del directorio de datos de usuario de la aplicación.
 * @returns success, path y error opcional.
 */
export async function getUserDataPath(): Promise<PathResponse> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return (await api.getUserDataPath()) as PathResponse;
  } catch (error) {
    apiLogger.error('Error obteniendo ruta de datos:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Abre el directorio de datos de usuario en el explorador del sistema.
 * @returns success, path y error opcional.
 */
export async function openUserDataFolder(): Promise<PathResponse> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return (await api.openUserDataFolder()) as PathResponse;
  } catch (error) {
    apiLogger.error('Error abriendo carpeta del programa:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Abre una URL en el navegador por defecto del sistema.
 * @param url - URL a abrir (debe ser http(s) o permitida por la app).
 * @returns success o error.
 */
export async function openExternalUrl(url: string): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return await api.openExternalUrl(url);
  } catch (error) {
    apiLogger.error('Error abriendo URL externa:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}
