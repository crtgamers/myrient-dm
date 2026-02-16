/**
 * Helpers internos del servicio API (getApi, logger). No reexportar.
 * @module api/internal
 */

import logger from '../../utils/logger';
import { API_ERRORS, GENERAL_ERRORS } from '../../constants/errors';
import type { PreloadApi } from '../../types/preload';

export const apiLogger = logger.child('API');

/**
 * Devuelve la API expuesta por el preload (window.api) para invocar IPC al proceso main.
 * En entorno sin Electron (p. ej. tests) devuelve null.
 *
 * @returns PreloadApi o null si no está disponible.
 */
export function getApi(): PreloadApi | null {
  if (typeof window === 'undefined' || !window.api) {
    apiLogger.warn('window.api no disponible');
    return null;
  }
  return window.api;
}

export { API_ERRORS, GENERAL_ERRORS };
