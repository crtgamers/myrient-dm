/**
 * Tests unitarios para electron/engines/DownloadValidator.ts
 *
 * Incluye tests originales + classifyTransientError, calculateAdaptiveRetryDelay.
 */
import {
  validateSavePath,
  isTransientNetworkError,
  calculateBackoffDelay,
  classifyTransientError,
  calculateAdaptiveRetryDelay,
} from '../../electron/engines/DownloadValidator';
import type { TransientErrorType } from '../../electron/engines/DownloadValidator';

describe('DownloadValidator', () => {
  describe('validateSavePath', () => {
    it('debe rechazar savePath vacío o no string', () => {
      expect(validateSavePath('')).toMatchObject({ valid: false });
      expect(validateSavePath(null as unknown as string)).toMatchObject({ valid: false });
      expect(validateSavePath(123 as unknown as string)).toMatchObject({ valid: false });
    });

    it('debe rechazar savePath fuera de downloadPath', () => {
      const base = process.platform === 'win32' ? 'C:\\Users\\Test\\Downloads' : '/tmp/Downloads';
      const outside = process.platform === 'win32' ? 'D:\\other\\file.zip' : '/etc/file.zip';
      const result = validateSavePath(outside, base);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('dentro del directorio');
    });

    it('debe aceptar savePath dentro de downloadPath', () => {
      const base = process.platform === 'win32' ? 'C:\\Users\\Test\\Downloads' : '/tmp/Downloads';
      const inside =
        process.platform === 'win32'
          ? 'C:\\Users\\Test\\Downloads\\sub\\file.zip'
          : '/tmp/Downloads/sub/file.zip';
      const result = validateSavePath(inside, base);
      expect(result.valid).toBe(true);
      expect(result.sanitizedPath).toBeDefined();
    });
  });

  describe('isTransientNetworkError', () => {
    it('debe retornar false si error es null/undefined', () => {
      expect(isTransientNetworkError(null)).toBe(false);
      expect(isTransientNetworkError(undefined)).toBe(false);
    });

    it('debe detectar códigos transitorios', () => {
      expect(isTransientNetworkError({ code: 'ECONNRESET', message: '' })).toBe(true);
      expect(isTransientNetworkError({ code: 'ETIMEDOUT', message: '' })).toBe(true);
      expect(isTransientNetworkError({ code: 'ENOTFOUND', message: '' })).toBe(true);
      expect(isTransientNetworkError({ code: 'ECONNREFUSED', message: '' })).toBe(true);
    });

    it('debe detectar strings de error Electron', () => {
      expect(isTransientNetworkError({ message: 'net::ERR_CONNECTION_RESET' })).toBe(true);
      expect(isTransientNetworkError({ message: 'net::ERR_TIMED_OUT' })).toBe(true);
    });

    it('debe retornar false para error no transitorio', () => {
      expect(isTransientNetworkError({ code: 'ENOENT', message: 'File not found' })).toBe(false);
      expect(isTransientNetworkError({ message: 'Unknown error' })).toBe(false);
    });
  });

  describe('calculateBackoffDelay', () => {
    it('debe retornar un número positivo', () => {
      const delay = calculateBackoffDelay(0);
      expect(typeof delay).toBe('number');
      expect(delay).toBeGreaterThan(0);
    });

    it('debe aumentar con retryCount', () => {
      const d0 = calculateBackoffDelay(0);
      const d1 = calculateBackoffDelay(1);
      const d2 = calculateBackoffDelay(2);
      expect(d1).toBeGreaterThanOrEqual(d0);
      expect(d2).toBeGreaterThanOrEqual(d1);
    });

    it('debe estar acotado (no exceder máximo razonable)', () => {
      const delay = calculateBackoffDelay(10);
      expect(delay).toBeLessThanOrEqual(35000);
    });
  });

  // -----------------------------------------------------------------------
  // classifyTransientError
  // -----------------------------------------------------------------------
  describe('classifyTransientError', () => {
    const cases: Array<{
      description: string;
      error: Partial<Error & { code: string }>;
      expected: TransientErrorType;
    }> = [
      {
        description: 'ETIMEDOUT → timeout',
        error: { code: 'ETIMEDOUT', message: '' },
        expected: 'timeout',
      },
      {
        description: 'net::ERR_TIMED_OUT → timeout',
        error: { message: 'net::ERR_TIMED_OUT' },
        expected: 'timeout',
      },
      {
        description: 'net::ERR_CONNECTION_TIMED_OUT → timeout',
        error: { message: 'net::ERR_CONNECTION_TIMED_OUT' },
        expected: 'timeout',
      },
      {
        description: '"timeout" en mensaje → timeout',
        error: { message: 'Request timeout after 30s' },
        expected: 'timeout',
      },
      {
        description: 'ECONNRESET → connection_reset',
        error: { code: 'ECONNRESET', message: '' },
        expected: 'connection_reset',
      },
      {
        description: 'net::ERR_CONNECTION_RESET → connection_reset',
        error: { message: 'net::ERR_CONNECTION_RESET' },
        expected: 'connection_reset',
      },
      {
        description: 'net::ERR_CONNECTION_CLOSED → connection_reset',
        error: { message: 'net::ERR_CONNECTION_CLOSED' },
        expected: 'connection_reset',
      },
      {
        description: 'net::ERR_HTTP2_PING_FAILED → connection_reset',
        error: { message: 'net::ERR_HTTP2_PING_FAILED' },
        expected: 'connection_reset',
      },
      {
        description: 'ECONNREFUSED → connection_refused',
        error: { code: 'ECONNREFUSED', message: '' },
        expected: 'connection_refused',
      },
      {
        description: 'ENOTFOUND → dns',
        error: { code: 'ENOTFOUND', message: '' },
        expected: 'dns',
      },
      {
        description: 'EAI_AGAIN → dns',
        error: { code: 'EAI_AGAIN', message: '' },
        expected: 'dns',
      },
      {
        description: 'net::ERR_NAME_NOT_RESOLVED → dns',
        error: { message: 'net::ERR_NAME_NOT_RESOLVED' },
        expected: 'dns',
      },
      {
        description: 'net::ERR_NETWORK_CHANGED → network_change',
        error: { message: 'net::ERR_NETWORK_CHANGED' },
        expected: 'network_change',
      },
      {
        description: 'net::ERR_INTERNET_DISCONNECTED → network_change',
        error: { message: 'net::ERR_INTERNET_DISCONNECTED' },
        expected: 'network_change',
      },
      {
        description: 'EPIPE → pipe_broken',
        error: { code: 'EPIPE', message: '' },
        expected: 'pipe_broken',
      },
      {
        description: 'ENETUNREACH → connection_refused',
        error: { code: 'ENETUNREACH', message: '' },
        expected: 'connection_refused',
      },
      {
        description: 'EHOSTUNREACH → connection_refused',
        error: { code: 'EHOSTUNREACH', message: '' },
        expected: 'connection_refused',
      },
      {
        description: 'HTTP_429 → server_overload',
        error: { code: 'HTTP_429', message: '' },
        expected: 'server_overload',
      },
      {
        description: 'HTTP_503 → server_overload',
        error: { code: 'HTTP_503', message: '' },
        expected: 'server_overload',
      },
      {
        description: 'error desconocido → unknown',
        error: { message: 'Algo falló misteriosamente' },
        expected: 'unknown',
      },
    ];

    for (const { description, error, expected } of cases) {
      it(`debe clasificar ${description}`, () => {
        expect(classifyTransientError(error as Error & { code?: string })).toBe(expected);
      });
    }

    it('debe retornar unknown para null/undefined', () => {
      expect(classifyTransientError(null as unknown as Error)).toBe('unknown');
      expect(classifyTransientError(undefined as unknown as Error)).toBe('unknown');
    });
  });

  // -----------------------------------------------------------------------
  // calculateAdaptiveRetryDelay
  // -----------------------------------------------------------------------
  describe('calculateAdaptiveRetryDelay', () => {
    it('debe retornar un delay positivo para cualquier error', () => {
      const error = Object.assign(new Error('net::ERR_TIMED_OUT'), { code: 'ETIMEDOUT' });
      const delay = calculateAdaptiveRetryDelay(0, error);
      expect(typeof delay).toBe('number');
      expect(delay).toBeGreaterThan(0);
    });

    it('debe priorizar retryAfterMs si está presente', () => {
      const error = Object.assign(new Error('Too many requests'), {
        code: 'HTTP_429',
        retryAfterMs: 45000,
      });
      const delay = calculateAdaptiveRetryDelay(0, error);
      expect(delay).toBe(45000);
    });

    it('debe usar backoff genérico si no hay error', () => {
      const delay = calculateAdaptiveRetryDelay(0);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(35000);
    });

    it('debe aplicar delays diferentes según el tipo de error', () => {
      // Timeout → base 5s, crecimiento 1.5x
      const timeoutError = Object.assign(new Error(''), { code: 'ETIMEDOUT' });
      const timeoutDelay = calculateAdaptiveRetryDelay(0, timeoutError);

      // Connection refused → base 15s, crecimiento 2.5x
      const refusedError = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
      const refusedDelay = calculateAdaptiveRetryDelay(0, refusedError);

      // Network change → base 3s, crecimiento 1.5x
      const netChangeError = Object.assign(new Error('net::ERR_NETWORK_CHANGED'), {});
      const netChangeDelay = calculateAdaptiveRetryDelay(0, netChangeError);

      // El delay de connection_refused debe ser mayor que el de timeout
      // y el de timeout mayor que network_change (en retry 0, sin jitter puro)
      // Con jitter puede variar, así que verificamos rangos razonables
      expect(refusedDelay).toBeGreaterThanOrEqual(15000); // base 15s
      expect(timeoutDelay).toBeGreaterThanOrEqual(5000); // base 5s
      expect(netChangeDelay).toBeGreaterThanOrEqual(3000); // base 3s
    });

    it('debe aumentar el delay con retryCount', () => {
      const error = Object.assign(new Error(''), { code: 'ECONNRESET' });
      const d0 = calculateAdaptiveRetryDelay(0, error);
      const d1 = calculateAdaptiveRetryDelay(1, error);
      const d2 = calculateAdaptiveRetryDelay(2, error);
      expect(d1).toBeGreaterThanOrEqual(d0);
      expect(d2).toBeGreaterThanOrEqual(d1);
    });

    it('debe respetar maxDelayMs del perfil', () => {
      // Timeout: max 20s
      const error = Object.assign(new Error(''), { code: 'ETIMEDOUT' });
      const delay = calculateAdaptiveRetryDelay(20, error); // muchos retries
      expect(delay).toBeLessThanOrEqual(20_000);
    });

    it('debe respetar maxDelayMs de server_overload', () => {
      // Server overload: max 300s
      const error = Object.assign(new Error(''), { code: 'HTTP_503' });
      const delay = calculateAdaptiveRetryDelay(20, error);
      expect(delay).toBeLessThanOrEqual(300_000);
    });
  });
});
