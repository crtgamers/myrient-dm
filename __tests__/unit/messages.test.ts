/**
 * Tests unitarios para constantes y formatters de mensajes (frontend).
 */
import {
  SUCCESS_MESSAGES,
  formatHistoryCleaned,
  formatHistoryCleanedOld,
  formatMemoryOptimized,
} from '../../src/constants/messages';

describe('messages (src/constants/messages.ts)', () => {
  describe('SUCCESS_MESSAGES', () => {
    it('define las claves esperadas', () => {
      expect(SUCCESS_MESSAGES).toHaveProperty('HISTORY_CLEANED');
      expect(SUCCESS_MESSAGES).toHaveProperty('SETTINGS_SAVED');
      expect(SUCCESS_MESSAGES.SETTINGS_SAVED).toBe('Se han guardado los cambios');
    });
  });

  describe('formatHistoryCleaned', () => {
    it('formatea el conteo de registros eliminados', () => {
      expect(formatHistoryCleaned(0)).toBe('0 registro(s) eliminado(s) de la base de datos');
      expect(formatHistoryCleaned(5)).toBe('5 registro(s) eliminado(s) de la base de datos');
      expect(formatHistoryCleaned(100)).toBe('100 registro(s) eliminado(s) de la base de datos');
    });
  });

  describe('formatHistoryCleanedOld', () => {
    it('formatea el conteo de registros antiguos eliminados', () => {
      expect(formatHistoryCleanedOld(3)).toBe(
        '3 registro(s) antiguo(s) eliminado(s) de la base de datos'
      );
    });
  });

  describe('formatMemoryOptimized', () => {
    it('formatea removed y kept', () => {
      expect(formatMemoryOptimized(10, 5)).toBe(
        '10 descarga(s) antigua(s) removida(s). 5 mantenida(s) en memoria.'
      );
    });
  });
});
