/**
 * Tests unitarios para electron/utils/validation.ts
 */
import {
  escapeLikeTerm,
  sanitizeSearchTerm,
  validateNodeId,
  validateDownloadId,
  validateSearchTerm,
  validateConfigFilename,
  getNetworkErrorMessage,
  isValidUrl,
  sanitizeFileName,
  validateAndSanitizeDownloadPath,
  VALIDATIONS,
} from '../../electron/utils/validation';

describe('validation', () => {
  describe('escapeLikeTerm', () => {
    it('debe escapar % y _', () => {
      expect(escapeLikeTerm('archivo_2024%test')).toBe('archivo|_2024|%test');
    });
    it('debe escapar | duplicándolo', () => {
      expect(escapeLikeTerm('a|b')).toBe('a||b');
    });
  });

  describe('sanitizeSearchTerm', () => {
    it('debe retornar string vacío si no es string', () => {
      expect(sanitizeSearchTerm(null as unknown as string)).toBe('');
      expect(sanitizeSearchTerm(123 as unknown as string)).toBe('');
    });
    it('debe trim y limitar a 100 caracteres', () => {
      expect(sanitizeSearchTerm('  foo  ')).toBe('foo');
      expect(sanitizeSearchTerm('a'.repeat(150)).length).toBe(100);
    });
    it('debe remover caracteres peligrosos', () => {
      expect(sanitizeSearchTerm('<>\'"\\')).toBe('');
    });
  });

  describe('validateNodeId', () => {
    it('debe aceptar entero positivo', () => {
      expect(validateNodeId(1)).toEqual({ valid: true, data: 1 });
      expect(validateNodeId(12345)).toEqual({ valid: true, data: 12345 });
    });
    it('debe rechazar no número o <= 0', () => {
      expect(validateNodeId(0).valid).toBe(false);
      expect(validateNodeId(-1).valid).toBe(false);
      expect(validateNodeId('abc' as unknown as number).valid).toBe(false);
      expect(validateNodeId(null as unknown as number).valid).toBe(false);
    });
  });

  describe('validateDownloadId', () => {
    it('debe aceptar entero positivo', () => {
      expect(validateDownloadId(1)).toEqual({ valid: true, data: 1 });
    });
    it('debe rechazar <= 0 o no número', () => {
      expect(validateDownloadId(0).valid).toBe(false);
      expect(validateDownloadId(-5).valid).toBe(false);
    });
  });

  describe('validateSearchTerm', () => {
    it('debe rechazar término muy corto', () => {
      const r = validateSearchTerm('a');
      expect(r.valid).toBe(false);
      expect(r.error).toContain(VALIDATIONS.SEARCH.TERM_MIN_LENGTH);
    });
    it('debe aceptar término de 2+ caracteres', () => {
      const r = validateSearchTerm('ab');
      expect(r.valid).toBe(true);
      expect(r.data).toBe('ab');
    });
    it('debe rechazar término inválido o no string', () => {
      expect(validateSearchTerm(null as unknown as string).valid).toBe(false);
      expect(validateSearchTerm('').valid).toBe(false);
    });
  });

  describe('validateConfigFilename', () => {
    it('debe aceptar nombre .json válido', () => {
      expect(validateConfigFilename('favorites.json')).toEqual({
        valid: true,
        data: 'favorites.json',
      });
    });
    it('debe rechazar sin .json', () => {
      expect(validateConfigFilename('favorites').valid).toBe(false);
    });
    it('debe rechazar path traversal', () => {
      expect(validateConfigFilename('../../etc/passwd.json').valid).toBe(false);
      expect(validateConfigFilename('foo/bar.json').valid).toBe(false);
    });
  });

  describe('getNetworkErrorMessage', () => {
    it('debe mapear códigos de red conocidos', () => {
      const e1 = new Error() as Error & { code?: string };
      e1.code = 'ENOTFOUND';
      expect(getNetworkErrorMessage(e1)).toBe('No se pudo conectar al servidor');
      const e2 = new Error() as Error & { code?: string };
      e2.code = 'ETIMEDOUT';
      expect(getNetworkErrorMessage(e2)).toBe('Tiempo de espera agotado');
    });
    it('debe retornar error.message si código desconocido', () => {
      const e = new Error('custom');
      expect(getNetworkErrorMessage(e)).toBe('custom');
    });
  });

  describe('isValidUrl', () => {
    it('debe aceptar HTTPS del host permitido', () => {
      expect(isValidUrl('https://myrient.erista.me/files/foo.zip')).toBe(true);
    });
    it('debe rechazar HTTP', () => {
      expect(isValidUrl('http://myrient.erista.me/files/foo.zip')).toBe(false);
    });
    it('debe rechazar host no permitido', () => {
      expect(isValidUrl('https://evil.com/file.zip')).toBe(false);
    });
    it('debe rechazar URL inválida', () => {
      expect(isValidUrl('not-a-url')).toBe(false);
    });
  });

  describe('sanitizeFileName', () => {
    it('debe retornar unnamed si no es string', () => {
      expect(sanitizeFileName(null as unknown as string)).toBe('unnamed');
    });
    it('debe sanitizar caracteres peligrosos', () => {
      const r = sanitizeFileName('file<>:name.zip');
      expect(r).not.toMatch(/[<>:"|?*]/);
    });
    it('debe limitar a 255 caracteres', () => {
      const r = sanitizeFileName('a'.repeat(300));
      expect(r.length).toBe(255);
    });
  });

  describe('validateAndSanitizeDownloadPath', () => {
    it('debe rechazar si no se proporciona ruta', () => {
      expect(validateAndSanitizeDownloadPath(null as unknown as string).valid).toBe(false);
      expect(validateAndSanitizeDownloadPath('').valid).toBe(false);
    });
    it('debe aceptar ruta dentro de directorios permitidos (mock app.getPath)', () => {
      const base = process.platform === 'win32' ? 'C:\\Users\\Test\\Downloads' : '/tmp/Downloads';
      const r = validateAndSanitizeDownloadPath(base);
      expect(r.valid).toBe(true);
      expect(r.path).toBeDefined();
    });
  });
});
