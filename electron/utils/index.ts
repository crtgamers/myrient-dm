/**
 * @fileoverview Módulo índice que centraliza las utilidades reexportadas.
 * @module utils
 *
 * Los siguientes módulos se consumen por ruta directa por diseño (no se reexportan aquí):
 * - dbExtractor — extracción de base de datos (database.ts)
 * - workerPool — pool de workers (DownloadEngine)
 * - ipcHelpers — creación de handlers IPC (ipcHandlers, ipcStateHandlers)
 * - connectionTest — prueba de conexión (ipcStateHandlers)
 * - dbQueryWorkerManager — workers de consultas a la BD (database.ts)
 * - nodeNormalizer — normalización de nodos del catálogo (database.ts)
 * - partialIntegrity — verificación parcial de integridad (SimpleDownloader, ChunkDownloader)
 *
 * Para el resto (logger, fileHelpers, validation, schemas, circuitBreaker, rateLimiter)
 * se puede usar este barrel o la ruta directa.
 */

export {
  logger,
  log,
  configureLogger,
  createScopedLogger,
  setMainWindowGetter,
  getLogFilePath,
  getLogDirectory,
  cleanOldLogs,
  formatObject,
  electronLog,
} from './logger';

export * from './fileHelpers';
export * from './validation';

export * as schemas from './schemas';
export { CircuitBreaker, CircuitState } from './circuitBreaker';
export { RateLimiter } from './rateLimiter';
