/**
 * Constantes de cola compartidas (prioridad de descargas).
 * @module shared/constants/queue
 *
 * Fuente única de verdad para valores de prioridad. El motor de descargas (StateStore,
 * QueueService, Scheduler) y cualquier código que necesite prioridades debe importar desde aquí.
 * (Antes en electron/queueDatabase.ts, módulo eliminado.)
 */

/** Niveles de prioridad de una descarga en la cola (valor numérico para ordenamiento). */
export const DownloadPriority = Object.freeze({
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  URGENT: 3,
} as const);

export type DownloadPriorityLevel = (typeof DownloadPriority)[keyof typeof DownloadPriority];
