/**
 * Máquina de estados explícita para descargas (transiciones y hooks).
 *
 * Reemplaza el diccionario estático canTransition por una definición explícita
 * de transiciones permitidas. Las transiciones inválidas son imposibles;
 * los side-effects (ej. registrar/desregistrar host) se ejecutan vía hooks
 * en StateStore (onEnter/onExit) que el engine registra.
 *
 * @module DownloadStateMachine
 */

/** Estados de descarga (valores en DB, minúsculas). */
export const STATE = {
  QUEUED: 'queued',
  STARTING: 'starting',
  DOWNLOADING: 'downloading',
  PAUSED: 'paused',
  MERGING: 'merging',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type StateKey = keyof typeof STATE;
export type StateValue = (typeof STATE)[StateKey];

/**
 * Transiciones permitidas: desde cada estado, lista de estados destino válidos.
 * Cualquier transición no listada es inválida.
 */
const TRANSITIONS: Record<string, readonly string[]> = {
  [STATE.QUEUED]: [STATE.STARTING, STATE.PAUSED, STATE.CANCELLED, STATE.FAILED],
  [STATE.STARTING]: [STATE.DOWNLOADING, STATE.PAUSED, STATE.FAILED, STATE.CANCELLED],
  [STATE.DOWNLOADING]: [
    STATE.PAUSED,
    STATE.MERGING,
    STATE.VERIFYING,
    STATE.FAILED,
    STATE.CANCELLED,
  ],
  [STATE.PAUSED]: [STATE.QUEUED, STATE.CANCELLED],
  [STATE.MERGING]: [STATE.VERIFYING, STATE.FAILED, STATE.CANCELLED],
  [STATE.VERIFYING]: [STATE.COMPLETED, STATE.FAILED],
  [STATE.COMPLETED]: [STATE.QUEUED, STATE.PAUSED],
  [STATE.FAILED]: [STATE.QUEUED, STATE.MERGING],
  [STATE.CANCELLED]: [STATE.PAUSED, STATE.QUEUED],
};

/**
 * Indica si una transición de fromState a toState está permitida.
 * Los estados se comparan en minúsculas (como en la DB).
 */
export function canTransition(fromState: string, toState: string): boolean {
  const from = fromState.toLowerCase();
  const to = toState.toLowerCase();
  const allowed = TRANSITIONS[from];
  return allowed != null && allowed.includes(to);
}

/**
 * Estados considerados "activos" (descarga en curso: red o disco).
 * Útil para hooks: al salir de cualquiera de estos hay que desregistrar host.
 */
export const ACTIVE_STATES: readonly string[] = [
  STATE.STARTING,
  STATE.DOWNLOADING,
  STATE.MERGING,
  STATE.VERIFYING,
];

export function isActiveState(state: string): boolean {
  return ACTIVE_STATES.includes(state.toLowerCase());
}
