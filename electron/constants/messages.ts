/**
 * @fileoverview Reexporta las constantes de mensajes definidas en shared para uso en el proceso principal.
 * @module constants/messages
 *
 * Permite importar desde 'electron/constants/messages' cuando el main necesite mensajes de éxito/info.
 * La fuente de verdad es shared/constants/messages.ts.
 */

export {
  SUCCESS_MESSAGES,
  formatHistoryCleaned,
  formatHistoryCleanedOld,
  formatMemoryOptimized,
} from '../../shared/constants/messages';
