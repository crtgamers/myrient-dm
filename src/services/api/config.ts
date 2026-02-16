/**
 * API de configuración y aplicación: locale, archivos de config, versión, actualizaciones.
 * @module api/config
 */

import { getApi, apiLogger, API_ERRORS, GENERAL_ERRORS } from './internal';
import type { APIResponse } from './types';

/**
 * Obtiene el locale de la aplicación (idioma del sistema).
 * @returns success y data (código de locale) o error.
 */
export async function getAppLocale(): Promise<APIResponse<string>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const result = await api.getAppLocale();
    const data = (result as { data?: string })?.data;
    return result?.success === true && typeof data === 'string'
      ? { success: true, data }
      : { success: false, error: 'Locale no disponible' };
  } catch (error) {
    apiLogger.error('Error obteniendo idioma del sistema', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Lee un archivo JSON del directorio de configuración del usuario.
 * @param filename - Nombre del archivo (ej. 'settings.json', 'favorites.json').
 * @returns success y data (objeto parseado) o error; data null si el archivo no existe.
 */
export async function readConfigFile(filename: string): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return await api.readConfigFile(filename);
  } catch (error) {
    apiLogger.error(`Error leyendo ${filename}:`, error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Escribe un objeto como JSON en el directorio de configuración del usuario.
 * @param filename - Nombre del archivo.
 * @param data - Objeto a serializar (debe ser serializable).
 * @returns success o error.
 */
export async function writeConfigFile(
  filename: string,
  data: unknown
): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return await api.writeConfigFile(filename, data);
  } catch (error) {
    apiLogger.error(`Error escribiendo ${filename}:`, error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Obtiene la versión actual de la aplicación.
 * @returns success y data (string de versión) o error.
 */
export async function getAppVersion(): Promise<APIResponse<string>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const res = await api.getAppVersion();
    return res as APIResponse<string>;
  } catch (error) {
    apiLogger.error('Error obteniendo versión:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Comprueba si hay actualizaciones disponibles (según configuración del updater).
 * @returns success y data con info de actualización o error.
 */
export async function checkForUpdates(): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return await api.checkForUpdates();
  } catch (error) {
    apiLogger.error('Error comprobando actualizaciones:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Cierra la aplicación e inicia la instalación de la actualización descargada.
 * @returns success o error.
 */
export async function quitAndInstall(): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return await api.quitAndInstall();
  } catch (error) {
    apiLogger.error('Error al reiniciar para instalar:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}
