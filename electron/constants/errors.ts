/**
 * @fileoverview Reexporta las constantes de error definidas en shared para uso en el proceso principal.
 * @module constants/errors
 *
 * Permite importar desde 'electron/constants/errors' en lugar de rutas relativas a shared.
 * La fuente de verdad es shared/constants/errors.ts.
 */

export {
  ERRORS,
  GENERAL_ERRORS,
  API_ERRORS,
  DOWNLOAD_ERRORS,
  NETWORK_ERRORS,
  DATABASE_ERRORS,
  QUEUE_ERRORS,
  FILE_ERRORS,
  WORKER_ERRORS,
  HISTORY_ERRORS,
  NAVIGATION_ERRORS,
  SETTINGS_ERRORS,
  FAVORITES_ERRORS,
  FILTERS_ERRORS,
  APP_ERRORS,
  OTHER_ERRORS,
  type ErrorsMap,
} from '../../shared/constants/errors';

export { default } from '../../shared/constants/errors';
