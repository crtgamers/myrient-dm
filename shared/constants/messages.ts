/**
 * @fileoverview Constantes de mensajes de éxito e información compartidas entre backend y frontend.
 * @module shared/constants/messages
 *
 * Fuente única de verdad para mensajes de éxito/info. El proceso principal (electron) y el renderer (src)
 * reexportan este módulo para poder importar desde sus propias rutas manteniendo coherencia.
 */

// =====================
// MENSAJES DE ÉXITO
// =====================

export const SUCCESS_MESSAGES: Record<string, string> = {
  HISTORY_CLEANED: 'Historial limpiado',
  MEMORY_OPTIMIZED: 'Memoria optimizada',
  LOGS_EXPORTED: 'Logs exportados exitosamente',
  DOWNLOAD_COMPLETED: 'Descarga completada',
  SETTINGS_SAVED: 'Se han guardado los cambios',
};

// =====================
// FUNCIONES PARA MENSAJES DINÁMICOS
// =====================

/**
 * Formatea el mensaje de historial limpiado con la cantidad de registros eliminados.
 *
 * @param count - Número de registros eliminados de la base de datos.
 * @returns Mensaje localizable para mostrar al usuario.
 */
export function formatHistoryCleaned(count: number): string {
  return `${count} registro(s) eliminado(s) de la base de datos`;
}

/**
 * Formatea el mensaje de historial limpiado (versión antigua, por compatibilidad).
 *
 * @param count - Número de registros antiguos eliminados.
 * @returns Mensaje localizable para mostrar al usuario.
 */
export function formatHistoryCleanedOld(count: number): string {
  return `${count} registro(s) antiguo(s) eliminado(s) de la base de datos`;
}

/**
 * Formatea el mensaje de memoria optimizada tras limpieza de descargas en memoria.
 *
 * @param removed - Cantidad de descargas removidas de memoria.
 * @param kept - Cantidad de descargas mantenidas en memoria.
 * @returns Mensaje localizable para mostrar al usuario.
 */
export function formatMemoryOptimized(removed: number, kept: number): string {
  return `${removed} descarga(s) antigua(s) removida(s). ${kept} mantenida(s) en memoria.`;
}
