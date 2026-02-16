/**
 * Tests unitarios para electron/utils/circuitBreaker.ts
 */
import { CircuitBreaker, CircuitState } from '../../electron/utils/circuitBreaker';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker | null = null;

  afterEach(() => {
    if (cb) {
      cb.destroy();
      cb = null;
    }
  });

  describe('constructor', () => {
    it('debe crear instancia con estado CLOSED', () => {
      cb = new CircuitBreaker({ failureThreshold: 2, timeout: 100 });
      expect(cb.state).toBe(CircuitState.CLOSED);
      expect(cb.isClosed()).toBe(true);
      cb.destroy();
    });

    it('debe usar opciones por defecto si no se pasan', () => {
      cb = new CircuitBreaker();
      expect(cb.failureThreshold).toBe(5);
      expect(cb.successThreshold).toBe(2);
      expect(cb.timeout).toBe(60000);
      cb.destroy();
    });
  });

  describe('execute', () => {
    it('debe ejecutar operación y retornar resultado cuando está CLOSED', async () => {
      cb = new CircuitBreaker({ failureThreshold: 5, timeout: 1000 });
      const result = await cb.execute(async () => 'ok');
      expect(result).toBe('ok');
    });

    it('debe registrar fallo y re-lanzar error', async () => {
      cb = new CircuitBreaker({ failureThreshold: 2, timeout: 1000 });
      await expect(
        cb.execute(async () => {
          throw new Error('fail');
        })
      ).rejects.toThrow('fail');
      expect(cb.stats.totalFailures).toBe(1);
    });

    it('debe abrir circuito tras failureThreshold fallos', async () => {
      cb = new CircuitBreaker({ failureThreshold: 2, timeout: 5000 });
      await expect(
        cb.execute(async () => {
          throw new Error('1');
        })
      ).rejects.toThrow('1');
      await expect(
        cb.execute(async () => {
          throw new Error('2');
        })
      ).rejects.toThrow('2');
      expect(cb.state).toBe(CircuitState.OPEN);
      expect(cb.isOpen()).toBe(true);
    });

    it('debe retornar fallback cuando está OPEN', async () => {
      cb = new CircuitBreaker({ failureThreshold: 1, timeout: 5000 });
      await expect(
        cb.execute(async () => {
          throw new Error('x');
        })
      ).rejects.toThrow('x');
      const fallback = await cb.execute(() => 'op', 'valor-fallback');
      expect(fallback).toBe('valor-fallback');
      const fallbackFn = await cb.execute(
        () => 'op',
        () => 'fallback-fn'
      );
      expect(fallbackFn).toBe('fallback-fn');
    });

    it('debe incrementar totalRejected cuando está OPEN', async () => {
      cb = new CircuitBreaker({ failureThreshold: 1, timeout: 5000 });
      await expect(
        cb.execute(async () => {
          throw new Error('x');
        })
      ).rejects.toThrow('x');
      await cb.execute(() => {}, 'fallback');
      await cb.execute(() => {}, 'fallback');
      expect(cb.stats.totalRejected).toBe(2);
    });
  });

  describe('getState', () => {
    it('debe retornar estado actual', () => {
      cb = new CircuitBreaker({ failureThreshold: 5 });
      const state = cb.getState();
      expect(state).toHaveProperty('state', CircuitState.CLOSED);
      expect(state).toHaveProperty('failureCount');
      expect(state).toHaveProperty('stats');
      expect(state.stats).toHaveProperty('totalRequests');
    });
  });

  describe('reset', () => {
    it('debe forzar estado CLOSED y limpiar contadores', async () => {
      cb = new CircuitBreaker({ failureThreshold: 1, timeout: 5000 });
      await expect(
        cb.execute(async () => {
          throw new Error('x');
        })
      ).rejects.toThrow('x');
      expect(cb.state).toBe(CircuitState.OPEN);
      cb.reset();
      expect(cb.state).toBe(CircuitState.CLOSED);
      expect(cb.failureCount).toBe(0);
    });
  });

  describe('destroy', () => {
    it('debe limpiar intervalo sin lanzar', () => {
      cb = new CircuitBreaker();
      expect(() => cb.destroy()).not.toThrow();
      cb = null;
    });
  });
});
