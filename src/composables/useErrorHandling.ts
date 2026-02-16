/**
 * @fileoverview Composable para manejo centralizado de errores
 * @module useErrorHandling
 *
 * Maneja errores del proceso principal de Electron y notificaciones de error globales.
 */

import { useToasts } from './useToasts';
import { onErrorNotification } from '../services/api';
import logger from '../utils/logger';

export interface MainProcessErrorInfo {
  message?: string;
  type?: string;
  [key: string]: unknown;
}

/**
 * Composable de manejo de errores del proceso principal: suscripción a error-notification y toast de error.
 * @returns init() (registra listener), cleanup() (desregistra), handleMainProcessError (para uso programático).
 */
export function useErrorHandling(): {
  init: () => void;
  cleanup: () => void;
  handleMainProcessError: (_errorInfo: MainProcessErrorInfo) => void;
} {
  const errorLogger = logger.child('ErrorHandling');
  const { showToast } = useToasts();

  const handleMainProcessError = (errorInfo: MainProcessErrorInfo): void => {
    errorLogger.error('Error del proceso principal:', errorInfo);

    let title = 'Error en la aplicación';
    let message =
      'Ha ocurrido un error inesperado. La aplicación puede comportarse de manera inesperada.';

    if (errorInfo?.message) {
      const msg = String(errorInfo.message).toLowerCase();

      if (msg.includes('network') || msg.includes('fetch') || msg.includes('connection')) {
        title = 'Error de conexión';
        message = 'Error de conexión con el proceso principal. Intenta recargar la aplicación.';
      } else if (msg.includes('timeout')) {
        title = 'Timeout';
        message = 'Una operación tardó demasiado tiempo. Intenta nuevamente.';
      } else if (msg.includes('permission') || msg.includes('access') || msg.includes('eacces')) {
        title = 'Error de permisos';
        message =
          'No tienes permisos para realizar esta operación. Verifica los permisos de archivos.';
      } else if (msg.includes('quota') || msg.includes('storage') || msg.includes('enospc')) {
        title = 'Espacio insuficiente';
        message = 'No hay suficiente espacio de almacenamiento disponible.';
      } else if (msg.includes('database') || msg.includes('sqlite') || msg.includes('db')) {
        title = 'Error de base de datos';
        message =
          'Error accediendo a la base de datos. Puede que necesites reiniciar la aplicación.';
      } else if (errorInfo.type === 'uncaughtException') {
        title = 'Error crítico';
        message = `${errorInfo.message.substring(0, 150)}${errorInfo.message.length > 150 ? '...' : ''}`;
      } else if (errorInfo.type === 'unhandledRejection') {
        title = 'Error asíncrono';
        message = `Error en operación asíncrona: ${errorInfo.message.substring(0, 150)}${errorInfo.message.length > 150 ? '...' : ''}`;
      } else {
        message = errorInfo.message.substring(0, 200);
        if (errorInfo.message.length > 200) message += '...';
      }
    }

    showToast({
      title,
      message,
      type: 'error',
      duration: 10000,
    });
  };

  let unsubscribeErrorNotification: (() => void) | null = null;

  const init = (): void => {
    try {
      unsubscribeErrorNotification = onErrorNotification((...args: unknown[]) => {
        handleMainProcessError((args[0] as MainProcessErrorInfo) ?? {});
      });
      errorLogger.info('Manejo de errores inicializado');
    } catch (error) {
      errorLogger.error('Error inicializando manejo de errores:', error);
    }
  };

  const cleanup = (): void => {
    if (unsubscribeErrorNotification) {
      try {
        unsubscribeErrorNotification();
        unsubscribeErrorNotification = null;
        errorLogger.info('Manejo de errores limpiado');
      } catch (error) {
        errorLogger.error('Error limpiando manejo de errores:', error);
      }
    }
  };

  return {
    init,
    cleanup,
    handleMainProcessError,
  };
}
