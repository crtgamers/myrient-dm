/**
 * @fileoverview Constantes de mensajes de error compartidas entre backend y frontend.
 * @module shared/constants/errors
 *
 * Fuente única de verdad para textos de error. El proceso principal (electron) y el renderer (src)
 * reexportan este módulo para poder importar desde sus propias rutas manteniendo coherencia.
 */

// =====================
// ERRORES GENERALES
// =====================

export const GENERAL_ERRORS: Record<string, string> = {
  UNKNOWN: 'Error desconocido',
  INTERNAL_SERVER_ERROR: 'Error interno del servidor',
  UNEXPECTED: 'Error inesperado',
  OPERATION_FAILED: 'Error en la operación',
};

// =====================
// ERRORES DE API (frontend)
// =====================

export const API_ERRORS: Record<string, string> = {
  NOT_AVAILABLE: 'API no disponible',
  REQUEST_FAILED: 'Error en la solicitud',
  SEARCH_FAILED: 'Error en búsqueda',
  GET_CHILDREN_FAILED: 'Error obteniendo hijos',
  GET_ANCESTORS_FAILED: 'Error obteniendo ancestros',
  GET_NODE_INFO_FAILED: 'Error obteniendo info del nodo',
  GET_UPDATE_DATE_FAILED: 'Error obteniendo fecha de actualización',
  DOWNLOAD_START_FAILED: 'Error iniciando descarga',
  DOWNLOAD_FOLDER_FAILED: 'Error iniciando descarga de carpeta',
  PAUSE_FAILED: 'Error pausando descarga',
  RESUME_FAILED: 'Error reanudando descarga',
  CANCEL_FAILED: 'Error cancelando descarga',
  RETRY_FAILED: 'Error reiniciando descarga',
  CONFIRM_OVERWRITE_FAILED: 'Error confirmando sobrescritura',
  DELETE_FAILED: 'Error eliminando descarga',
  GET_STATS_FAILED: 'Error obteniendo estadísticas',
  CLEAN_HISTORY_FAILED: 'Error limpiando historial',
  READ_CONFIG_FAILED: 'Error leyendo archivo de configuración',
  WRITE_CONFIG_FAILED: 'Error escribiendo archivo de configuración',
  SELECT_FOLDER_FAILED: 'Error seleccionando carpeta',
};

// =====================
// ERRORES DE DESCARGA
// =====================

export const DOWNLOAD_ERRORS: Record<string, string> = {
  START_FAILED: 'Error al iniciar descarga',
  RESUME_FAILED: 'Error al reanudar descarga',
  RETRY_FAILED: 'Error al reiniciar descarga',
  CONFIRM_OVERWRITE_FAILED: 'Error al confirmar sobrescritura',
  DELETE_FAILED: 'Error al eliminar descarga',
  GET_FILES_FAILED: 'Error al obtener archivos de la carpeta',
  FOLDER_FAILED: 'Error al descargar carpeta',
  FOLDER_PROCESSING_FAILED: 'Error al procesar la descarga de la carpeta',
  CURRENT_FOLDER_FAILED: 'Error descargando carpeta',
  PAUSE_FAILED: 'Error al pausar descarga',
  CANCEL_FAILED: 'Error al cancelar descarga',
  GET_UPDATED_FAILED: 'Error obteniendo descarga actualizada',
  NO_LOCATION_SELECTED: 'No se seleccionó ubicación',
  CONNECTION_CLOSED: 'Conexión cerrada prematuramente',
  REDIRECTION_NOT_SUPPORTED: 'Redirección no soportada',
  CREATE_DIRECTORY_FAILED: 'Error al crear directorio',
  MULTIPLE_RETRIES_FAILED: 'Error después de múltiples reintentos',
  CIRCUIT_BREAKER_OPEN:
    'Circuit breaker abierto: demasiados errores en este host. Reintentando más tarde...',
  CIRCUIT_BREAKER_CHUNKS:
    'Circuit breaker abierto: demasiados errores en chunks. Reintentando más tarde...',
  QUEUE_FULL: 'La cola de descargas está llena',
};

// =====================
// ERRORES DE RED
// =====================

export const NETWORK_ERRORS: Record<string, string> = {
  CONNECTION_FAILED: 'No se pudo conectar al servidor',
  TIMEOUT: 'Tiempo de espera agotado',
  CONNECTION_REFUSED: 'Conexión rechazada por el servidor',
  CONNECTION_RESET: 'Conexión reiniciada por el servidor',
  CONNECTION_CLOSED: 'Conexión cerrada inesperadamente',
  HOST_UNREACHABLE: 'Servidor no alcanzable',
};

// =====================
// ERRORES DE BASE DE DATOS
// =====================

export const DATABASE_ERRORS: Record<string, string> = {
  CONNECTION_FAILED: 'Error al conectar con la base de datos',
  EXTRACTION_FAILED: 'Error al Extraer Base de Datos',
  EXTRACTION_TITLE: 'Error de Extracción',
  QUERY_FAILED: 'Error al ejecutar consulta',
  SEARCH_FAILED: 'Error en la búsqueda',
  GET_CHILDREN_FAILED: 'Error al obtener hijos',
  GET_ANCESTORS_FAILED: 'Error al obtener ancestros',
  GET_NODE_INFO_FAILED: 'Error al obtener info del nodo',
  GET_DOWNLOAD_INFO_FAILED: 'Error al obtener info de descarga',
  GET_ANCESTOR_PATH_FAILED: 'Error al obtener ruta de ancestros',
  GET_FOLDER_FILES_FAILED: 'Error al obtener archivos de carpeta',
  GET_UPDATE_DATE_FAILED: 'Error al obtener fecha de actualización',
  FTS_FALLBACK_WARNING: 'Error en búsqueda FTS, usando fallback',
};

// =====================
// ERRORES DE COLA DE DESCARGA
// =====================

export const QUEUE_ERRORS: Record<string, string> = {
  INIT_FAILED: 'Error inicializando QueueDatabase',
  ADD_FAILED: 'Error agregando descarga',
  UPDATE_FAILED: 'Error actualizando descarga',
  UPDATE_STATE_FAILED: 'Error actualizando estado',
  DELETE_FAILED: 'Error eliminando descarga',
  START_FAILED: 'Error iniciando descarga',
  COMPLETE_FAILED: 'Error completando descarga',
  MARK_FAILED_FAILED: 'Error marcando descarga como fallida',
  UPDATE_CHUNK_FAILED: 'Error actualizando chunk',
  CLEANUP_MISLABELED_FAILED: 'Error en limpieza de descargas mal etiquetadas',
  LOAD_FAILED: 'Error cargando cola',
};

// =====================
// ERRORES DE ARCHIVOS
// =====================

export const FILE_ERRORS: Record<string, string> = {
  VERIFY_FAILED: 'Error al verificar archivo',
  CREATE_DIRECTORY_FAILED: 'Error creando directorio',
  DELETE_FAILED: 'Error eliminando archivo',
  READ_FAILED: 'Error leyendo archivo',
  WRITE_FAILED: 'Error escribiendo archivo',
};

// =====================
// ERRORES DE WORKERS
// =====================

export const WORKER_ERRORS: Record<string, string> = {
  MERGE_FAILED: 'Error en fusión',
  MERGE_WORKER_ERROR: 'Error en worker de merge',
  THREAD_ERROR: 'Error en worker thread',
  START_MERGE_WORKER_FAILED: 'Error iniciando worker de merge',
  CLEANUP_FAILED: 'Error limpiando worker',
};

// =====================
// ERRORES DE HISTORIAL (frontend)
// =====================

export const HISTORY_ERRORS: Record<string, string> = {
  CLEAN_FAILED: 'Error al limpiar historial',
  LOAD_FAILED: 'Error cargando historial',
  SAVE_FAILED: 'Error guardando historial',
  DELETE_FAILED: 'Error eliminando del historial',
  CANCEL_ALL_FAILED: 'Error cancelando todas las descargas',
};

// =====================
// ERRORES DE NAVEGACIÓN (frontend)
// =====================

export const NAVIGATION_ERRORS: Record<string, string> = {
  LOAD_CHILDREN_FAILED: 'Error al cargar',
  LOAD_BREADCRUMB_FAILED: 'Error cargando breadcrumb',
  INVALID_NODE: 'Nodo inválido para navegación',
};

// =====================
// ERRORES DE CONFIGURACIÓN (frontend)
// =====================

export const SETTINGS_ERRORS: Record<string, string> = {
  LOAD_FAILED: 'Error cargando configuración',
  SAVE_FAILED: 'Error guardando configuración',
  LOAD_UI_PREFERENCES_FAILED: 'Error cargando preferencias UI',
  SAVE_UI_PREFERENCES_FAILED: 'Error guardando preferencias UI',
  SELECT_FOLDER_FAILED: 'Error seleccionando carpeta',
};

// =====================
// ERRORES DE FAVORITOS (frontend)
// =====================

export const FAVORITES_ERRORS: Record<string, string> = {
  LOAD_FAILED: 'Error cargando favoritos',
  SAVE_FAILED: 'Error guardando favoritos',
  INVALID_NODE: 'Nodo inválido',
};

// =====================
// ERRORES DE FILTROS (frontend)
// =====================

export const FILTERS_ERRORS: Record<string, string> = {
  LOAD_PRESETS_FAILED: 'Error cargando presets',
  SAVE_PRESETS_FAILED: 'Error guardando presets',
  EMPTY_PRESET_NAME: 'Nombre de preset vacío',
};

// =====================
// ERRORES DE APP (frontend)
// =====================

export const APP_ERRORS: Record<string, string> = {
  DOWNLOAD_ROOT_FAILED: 'No se puede descargar la raíz',
  NO_CURRENT_FOLDER: 'No hay carpeta actual para descargar',
  LOAD_UPDATE_DATE_FAILED: 'Error cargando fecha de actualización',
  CLEAN_HISTORY_FAILED: 'Error limpiando historial',
};

// =====================
// OTROS ERRORES (backend)
// =====================

export const OTHER_ERRORS: Record<string, string> = {
  REQUEST_ERROR: 'Error en request',
  RESPONSE_ERROR: 'Error en response',
  FILE_STREAM_ERROR: 'Error en fileStream',
  PAUSE_FAILED: 'Error al pausar descarga',
  CANCEL_FAILED: 'Error al cancelar descarga',
  PROGRESS_BATCHER_FLUSH_FAILED: 'Error en flush',
  PROGRESS_BATCHER_SCHEDULED_FLUSH_FAILED: 'Error en flush programado',
  PROGRESS_BATCHER_FINAL_FLUSH_FAILED: 'Error en flush final',
  AUTO_HISTORY_CLEANUP_FAILED: 'Error en limpieza automática de historial',
  EXTRACTION_CODE_ERROR: 'Error en extracción, código',
};

// =====================
// OBJETO UNIFICADO
// =====================

/** Objeto unificado de errores por categoría (GENERAL, API, DOWNLOAD, NETWORK, etc.). */
export interface ErrorsMap {
  GENERAL: Record<string, string>;
  API: Record<string, string>;
  DOWNLOAD: Record<string, string>;
  NETWORK: Record<string, string>;
  DATABASE: Record<string, string>;
  QUEUE: Record<string, string>;
  FILE: Record<string, string>;
  WORKER: Record<string, string>;
  HISTORY: Record<string, string>;
  NAVIGATION: Record<string, string>;
  SETTINGS: Record<string, string>;
  FAVORITES: Record<string, string>;
  FILTERS: Record<string, string>;
  APP: Record<string, string>;
  OTHER: Record<string, string>;
}

export const ERRORS: ErrorsMap = {
  GENERAL: GENERAL_ERRORS,
  API: API_ERRORS,
  DOWNLOAD: DOWNLOAD_ERRORS,
  NETWORK: NETWORK_ERRORS,
  DATABASE: DATABASE_ERRORS,
  QUEUE: QUEUE_ERRORS,
  FILE: FILE_ERRORS,
  WORKER: WORKER_ERRORS,
  HISTORY: HISTORY_ERRORS,
  NAVIGATION: NAVIGATION_ERRORS,
  SETTINGS: SETTINGS_ERRORS,
  FAVORITES: FAVORITES_ERRORS,
  FILTERS: FILTERS_ERRORS,
  APP: APP_ERRORS,
  OTHER: OTHER_ERRORS,
};

export default ERRORS;
