/**
 * @fileoverview Re-exporta constantes de error desde shared para uso en el frontend
 * @module constants/errors
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
