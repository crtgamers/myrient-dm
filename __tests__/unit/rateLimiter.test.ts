/**
 * Tests unitarios para electron/utils/rateLimiter.ts
 */
import { RateLimiter } from '../../electron/utils/rateLimiter';

describe('RateLimiter', () => {
  describe('constructor', () => {
    it('debe crear instancia con maxRequests y windowMs válidos', () => {
      const limiter = new RateLimiter(10, 1000);
      expect(limiter.maxRequests).toBe(10);
      expect(limiter.windowMs).toBe(1000);
    });

    it('debe lanzar si maxRequests <= 0', () => {
      expect(() => new RateLimiter(0, 1000)).toThrow(
        'maxRequests y windowMs deben ser mayores a 0'
      );
      expect(() => new RateLimiter(-1, 1000)).toThrow();
    });

    it('debe lanzar si windowMs <= 0', () => {
      expect(() => new RateLimiter(10, 0)).toThrow('maxRequests y windowMs deben ser mayores a 0');
    });
  });

  describe('isAllowed', () => {
    it('debe permitir requests hasta el límite', () => {
      const limiter = new RateLimiter(3, 5000);
      expect(limiter.isAllowed('user1')).toBe(true);
      expect(limiter.isAllowed('user1')).toBe(true);
      expect(limiter.isAllowed('user1')).toBe(true);
      expect(limiter.isAllowed('user1')).toBe(false);
    });

    it('debe rechazar si identifier no es string', () => {
      const limiter = new RateLimiter(10, 1000);
      expect(limiter.isAllowed(null as unknown as string)).toBe(false);
      expect(limiter.isAllowed(undefined as unknown as string)).toBe(false);
      expect(limiter.isAllowed(123 as unknown as string)).toBe(false);
    });

    it('debe rechazar si identifier es string vacío', () => {
      const limiter = new RateLimiter(10, 1000);
      expect(limiter.isAllowed('')).toBe(false);
    });

    it('debe aislar por identificador', () => {
      const limiter = new RateLimiter(2, 5000);
      expect(limiter.isAllowed('userA')).toBe(true);
      expect(limiter.isAllowed('userA')).toBe(true);
      expect(limiter.isAllowed('userA')).toBe(false);
      expect(limiter.isAllowed('userB')).toBe(true);
      expect(limiter.isAllowed('userB')).toBe(true);
      expect(limiter.isAllowed('userB')).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('debe retornar null si no hay requests', () => {
      const limiter = new RateLimiter(10, 1000);
      expect(limiter.getStatus('user1')).toBeNull();
    });

    it('debe retornar count y remaining tras requests', () => {
      const limiter = new RateLimiter(5, 5000);
      limiter.isAllowed('user1');
      limiter.isAllowed('user1');
      const status = limiter.getStatus('user1');
      expect(status).not.toBeNull();
      expect(status!.count).toBe(2);
      expect(status!.remaining).toBe(3);
      expect(status!.resetInMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('cleanup', () => {
    it('debe eliminar identificadores sin requests recientes', () => {
      const limiter = new RateLimiter(2, 100);
      limiter.isAllowed('user1');
      expect(limiter.getStats().totalIdentifiers).toBe(1);
      return new Promise<void>(resolve => {
        setTimeout(() => {
          const removed = limiter.cleanup();
          expect(removed).toBe(1);
          expect(limiter.getStatus('user1')).toBeNull();
          resolve();
        }, 150);
      });
    });
  });

  describe('reset', () => {
    it('debe eliminar requests del identificador', () => {
      const limiter = new RateLimiter(2, 5000);
      limiter.isAllowed('user1');
      limiter.isAllowed('user1');
      expect(limiter.isAllowed('user1')).toBe(false);
      limiter.reset('user1');
      expect(limiter.isAllowed('user1')).toBe(true);
    });

    it('debe retornar false si el identificador no existía', () => {
      const limiter = new RateLimiter(10, 1000);
      expect(limiter.reset('inexistente')).toBe(false);
    });
  });

  describe('resetAll', () => {
    it('debe limpiar todos los identificadores', () => {
      const limiter = new RateLimiter(10, 1000);
      limiter.isAllowed('a');
      limiter.isAllowed('b');
      const count = limiter.resetAll();
      expect(count).toBe(2);
      expect(limiter.getStats().totalIdentifiers).toBe(0);
    });
  });

  describe('getStats', () => {
    it('debe retornar totalIdentifiers, maxRequests, windowMs', () => {
      const limiter = new RateLimiter(20, 2000);
      limiter.isAllowed('u1');
      const stats = limiter.getStats();
      expect(stats.totalIdentifiers).toBe(1);
      expect(stats.maxRequests).toBe(20);
      expect(stats.windowMs).toBe(2000);
    });
  });
});
