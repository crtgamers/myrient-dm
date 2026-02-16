/**
 * @fileoverview Manejo global de errores para Vue
 * @module errorHandler
 */

import logger from './logger';
import { useToasts } from '../composables/useToasts';

export interface ToastOptions {
  title?: string;
  message?: string;
  type?: string;
  duration?: number;
  [key: string]: unknown;
}

type ToastHandler = (_options: ToastOptions) => void;

let globalToastHandler: ToastHandler | null = null;

/**
 * Registra el handler de toasts que usará showErrorToast (p. ej. desde App.vue tras montar useToasts).
 *
 * @param showToast - Función que muestra un toast con título, mensaje y tipo.
 */
export function registerGlobalToastHandler(showToast: ToastHandler): void {
  globalToastHandler = showToast;
}

/** Devuelve el handler de toasts global registrado, o null. */
export function getGlobalToastHandler(): ToastHandler | null {
  return globalToastHandler;
}

/**
 * Muestra un toast de error. Usa el handler global si está registrado; si no, intenta useToasts().
 *
 * @param options - title, message, type ('error'), duration (opcional).
 */
export function showErrorToast(options: ToastOptions): void {
  if (globalToastHandler) {
    try {
      globalToastHandler(options);
    } catch (error) {
      logger.child('ErrorHandler').error('Error mostrando toast de error', error);
    }
  } else {
    try {
      const { showToast } = useToasts();
      showToast(options);
    } catch (err) {
      logger.child('ErrorHandler').error('Error al mostrar toast', err, {
        title: options.title,
        message: options.message,
      });
    }
  }
}
