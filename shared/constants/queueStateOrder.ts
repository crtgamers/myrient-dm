/**
 * Orden de estados de la cola de descargas (única fuente de verdad para UI y ordenamiento).
 * Valores menores = mayor prioridad visual (aparecen antes en la lista ordenada).
 *
 * @module shared/constants/queueStateOrder
 */

/** Mapa estado → orden numérico para ordenar la cola (downloading primero, completed al final). */
export const STATE_ORDER: Record<string, number> = {
  downloading: 0,
  starting: 0,
  progressing: 0,
  merging: 0,
  verifying: 0,
  resuming: 0,
  queued: 1,
  paused: 2,
  pausing: 2,
  awaiting: 3,
  cancelled: 4,
  canceled: 4,
  failed: 5,
  error: 5,
  completed: 6,
};

/**
 * Devuelve el orden numérico de un estado para ordenar la cola en UI.
 * Estados desconocidos devuelven 99 (se muestran al final).
 *
 * @param state - Estado de la descarga (ej. 'downloading', 'completed').
 * @returns Orden numérico (0 = mayor prioridad visual).
 */
export function getStateOrder(state: string | undefined): number {
  if (!state) return 99;
  return STATE_ORDER[state.toLowerCase()] ?? 99;
}
