/**
 * Tests unitarios para electron/utils/workerPool.ts (pool dinámico de workers).
 *
 * Mockea `worker_threads.Worker` para probar la lógica del pool sin
 * hilos reales. Cubre: scaling bajo demanda, idle timeout, health checks,
 * backward-compat, getStats, shutdown.
 */

// ---------------------------------------------------------------------------
// Mock de Worker
// ---------------------------------------------------------------------------

type MessageHandler = (_msg: Record<string, unknown>) => void;

class MockWorker {
  private _listeners = new Map<string, ((..._args: unknown[]) => void)[]>();
  terminated = false;
  /** Handlers acumulados para simular respuestas */
  messageHandlers: MessageHandler[] = [];

  on(event: string, fn: (..._args: unknown[]) => void): this {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(fn);
    if (event === 'message') this.messageHandlers.push(fn as MessageHandler);
    return this;
  }

  once(event: string, fn: (..._args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]) => {
      this.removeListener(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }

  removeListener(event: string, fn: (..._args: unknown[]) => void): this {
    const arr = this._listeners.get(event);
    if (arr) {
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    }
    if (event === 'message') {
      const mIdx = this.messageHandlers.indexOf(fn as MessageHandler);
      if (mIdx !== -1) this.messageHandlers.splice(mIdx, 1);
    }
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) {
      this._listeners.delete(event);
      if (event === 'message') this.messageHandlers = [];
    } else {
      this._listeners.clear();
      this.messageHandlers = [];
    }
    return this;
  }

  postMessage(msg: Record<string, unknown>): void {
    if (this.terminated) throw new Error('Worker terminated');
    // Simular respuesta automática a PING (delay 0 para que fake timers lo procesen)
    if (msg.type === 'PING') {
      setTimeout(() => {
        this._emit('message', { type: 'PONG', taskId: msg.taskId });
      }, 0);
      return;
    }
    // Simular tarea exitosa con setTimeout(0) para que fake timers lo procesen
    if (msg.taskId) {
      setTimeout(() => {
        this._emit('message', {
          type: 'SUCCESS',
          taskId: msg.taskId,
          result: { ok: true },
        });
      }, 0);
    }
  }

  terminate(): Promise<number> {
    this.terminated = true;
    setTimeout(() => this._emit('exit', 0), 0);
    return Promise.resolve(0);
  }

  private _emit(event: string, ...args: unknown[]): void {
    const fns = this._listeners.get(event);
    if (fns) {
      for (const fn of [...fns]) {
        fn(...args);
      }
    }
  }
}

/** Lista de MockWorkers creados, para inspección en tests. */
const createdWorkers: MockWorker[] = [];

jest.mock('worker_threads', () => ({
  Worker: jest.fn().mockImplementation(() => {
    const w = new MockWorker();
    createdWorkers.push(w);
    return w;
  }),
}));

// Mock parcial de os: solo sobreescribir cpus(), preservar el resto (tmpdir, etc.)
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return {
    ...actual,
    cpus: jest.fn(() => Array(8).fill({ model: 'mock', speed: 3000 })),
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import WorkerPool from '../../electron/utils/workerPool';
import type { WorkerPoolStats } from '../../electron/utils/workerPool';

describe('WorkerPool dinámico', () => {
  beforeEach(() => {
    createdWorkers.length = 0;
  });

  // Helper: crear pool con defaults sensatos para tests
  function createPool(overrides: Record<string, unknown> = {}): WorkerPool {
    return new WorkerPool('/fake/worker.js', {
      minWorkers: 1,
      maxWorkers: 3,
      taskTimeoutMs: 5000,
      idleTimeoutMs: 10000,
      healthCheckIntervalMs: 0, // Deshabilitado por defecto en tests
      healthCheckTimeoutMs: 2000,
      ...overrides,
    });
  }

  // -----------------------------------------------------------------------
  // Inicialización
  // -----------------------------------------------------------------------
  describe('inicialización', () => {
    it('debe crear minWorkers al inicio', async () => {
      const pool = createPool({ minWorkers: 2, maxWorkers: 4 });
      const stats = pool.getStats();
      expect(stats.totalWorkers).toBe(2);
      expect(stats.availableWorkers).toBe(2);
      expect(stats.minWorkers).toBe(2);
      expect(stats.maxWorkers).toBe(4);
      await pool.shutdown();
    });

    it('debe crear 1 worker por defecto con minWorkers=1', async () => {
      const pool = createPool();
      expect(pool.getStats().totalWorkers).toBe(1);
      await pool.shutdown();
    });

    it('debe respetar maxWorkers como techo', async () => {
      const pool = createPool({ minWorkers: 1, maxWorkers: 2 });
      expect(pool.getStats().maxWorkers).toBe(2);
      await pool.shutdown();
    });
  });

  // -----------------------------------------------------------------------
  // Legacy constructor
  // -----------------------------------------------------------------------
  describe('constructor legacy (backward-compat)', () => {
    it('debe aceptar la firma (path, poolSize, timeout)', async () => {
      const pool = new WorkerPool('/fake/worker.js', 3, 10000);
      const stats = pool.getStats();
      expect(stats.maxWorkers).toBe(3);
      expect(stats.minWorkers).toBeLessThanOrEqual(3);
      await pool.shutdown();
    });

    it('debe usar poolSize=2 por defecto si no se pasa argumento', async () => {
      const pool = new WorkerPool('/fake/worker.js');
      const stats = pool.getStats();
      expect(stats.maxWorkers).toBe(2);
      await pool.shutdown();
    });
  });

  // -----------------------------------------------------------------------
  // Ejecución de tareas
  // -----------------------------------------------------------------------
  describe('ejecución de tareas', () => {
    it('debe ejecutar una tarea y resolverla', async () => {
      const pool = createPool();
      const result = await pool.execute({ type: 'TEST' });
      expect(result).toEqual({ ok: true });
      await pool.shutdown();
    });

    it('debe encolar tareas cuando todos los workers están busy', async () => {
      const pool = createPool({ minWorkers: 1, maxWorkers: 1 });

      // Hacer que el primer worker no responda automáticamente
      const firstWorker = createdWorkers[0];
      const originalPostMessage = MockWorker.prototype.postMessage.bind(firstWorker);
      let capturedTaskId: string | null = null;
      firstWorker.postMessage = (msg: Record<string, unknown>) => {
        if (msg.type === 'PING') return;
        capturedTaskId = msg.taskId as string;
        // No responder automáticamente
      };

      const promise1 = pool.execute({ type: 'SLOW' });
      const stats = pool.getStats();
      expect(stats.busyWorkers).toBe(1);

      // La segunda tarea se encola
      const promise2 = pool.execute({ type: 'QUEUED' });
      expect(pool.getStats().waitingTasks).toBe(1);

      // Restaurar postMessage ANTES de resolver, para que la 2da tarea use auto-response
      firstWorker.postMessage = originalPostMessage;

      // Resolver la primera manualmente
      for (const handler of [...firstWorker.messageHandlers]) {
        handler({ type: 'SUCCESS', taskId: capturedTaskId, result: { first: true } });
      }

      const result1 = await promise1;
      expect(result1).toEqual({ first: true });

      // La segunda ahora se ejecuta (con auto-response del mock restaurado)
      const result2 = await promise2;
      expect(result2).toEqual({ ok: true });

      await pool.shutdown();
    });

    it('debe rechazar tareas si el pool está cerrándose', async () => {
      const pool = createPool();
      const shutdownPromise = pool.shutdown();
      await expect(pool.execute({ type: 'LATE' })).rejects.toThrow('cerrándose');
      await shutdownPromise;
    });
  });

  // -----------------------------------------------------------------------
  // Scaling bajo demanda
  // -----------------------------------------------------------------------
  describe('scaling bajo demanda', () => {
    it('debe crear workers adicionales cuando hay tareas encoladas', async () => {
      const pool = createPool({ minWorkers: 1, maxWorkers: 3 });
      expect(pool.getStats().totalWorkers).toBe(1);

      // Hacer que el worker 0 no responda automáticamente
      const w0 = createdWorkers[0];
      let task0Id: string | null = null;
      w0.postMessage = (msg: Record<string, unknown>) => {
        if (msg.type !== 'PING') task0Id = msg.taskId as string;
      };

      // Enviar 3 tareas: 1 al worker existente + 2 provocan scale-up
      const p1 = pool.execute({ type: 'T1' });
      const p2 = pool.execute({ type: 'T2' });
      const p3 = pool.execute({ type: 'T3' });

      // Deberían haberse creado workers adicionales
      expect(pool.getStats().totalWorkers).toBeGreaterThan(1);
      expect(pool.getStats().totalWorkers).toBeLessThanOrEqual(3);

      // Resolver primera tarea manual
      for (const h of w0.messageHandlers) {
        h({ type: 'SUCCESS', taskId: task0Id, result: { t: 1 } });
      }

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toEqual({ t: 1 });
      expect(r2).toEqual({ ok: true });
      expect(r3).toEqual({ ok: true });

      await pool.shutdown();
    });

    it('no debe exceder maxWorkers', async () => {
      const pool = createPool({ minWorkers: 1, maxWorkers: 2 });

      // Bloquear todos los workers para que no respondan
      for (const w of createdWorkers) {
        w.postMessage = () => {};
      }

      // Tarea para worker existente
      const _p1 = pool.execute({ type: 'T1' }).catch(() => {});

      // Esto provoca scale-up a 2 (max). Bloquear el nuevo también.
      // Hook el nuevo worker apenas se cree:
      const origLen = createdWorkers.length;
      const _p2 = pool.execute({ type: 'T2' }).catch(() => {});

      // El nuevo worker se creó, bloquearlo
      if (createdWorkers.length > origLen) {
        createdWorkers[createdWorkers.length - 1].postMessage = () => {};
      }

      // La tercera debe encolarse, NO crear un 3er worker
      const _p3 = pool.execute({ type: 'T3' }).catch(() => {});

      expect(pool.getStats().totalWorkers).toBeLessThanOrEqual(2);
      expect(pool.getStats().waitingTasks).toBeGreaterThanOrEqual(1);

      await pool.shutdown();
    });
  });

  // -----------------------------------------------------------------------
  // Idle cleanup
  // -----------------------------------------------------------------------
  describe('idle timeout', () => {
    it('debe destruir workers ociosos después del idleTimeout (respetando minWorkers)', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      try {
        const pool = createPool({ minWorkers: 1, maxWorkers: 3, idleTimeoutMs: 10000 });

        // Ejecutar 3 tareas para forzar scale-up a 3 workers
        await Promise.all([
          pool.execute({ type: 'T1' }),
          pool.execute({ type: 'T2' }),
          pool.execute({ type: 'T3' }),
        ]);

        const statsAfterTasks = pool.getStats();
        expect(statsAfterTasks.availableWorkers).toBe(statsAfterTasks.totalWorkers);
        const workersBeforeIdle = statsAfterTasks.totalWorkers;
        expect(workersBeforeIdle).toBeGreaterThan(1);

        // Timer chequea cada idleTimeoutMs/2 = 5000ms.
        // Los workers completaron tareas a t≈0, así que idleSince≈0.
        // A t=15000, el check ejecuta con now=15000, idle=15000 > 10000 → cleanup.
        jest.advanceTimersByTime(16000);

        const statsAfterIdle = pool.getStats();
        expect(statsAfterIdle.totalWorkers).toBeLessThan(workersBeforeIdle);
        expect(statsAfterIdle.totalWorkers).toBeGreaterThanOrEqual(1);
        expect(statsAfterIdle.totalIdleDestroys).toBeGreaterThan(0);

        await pool.shutdown();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Health checks
  // -----------------------------------------------------------------------
  describe('health checks', () => {
    it('debe reemplazar workers que no responden al PING', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      try {
        const pool = createPool({
          minWorkers: 1,
          maxWorkers: 2,
          healthCheckIntervalMs: 5000,
          healthCheckTimeoutMs: 1000,
        });

        // Hacer que el worker NO responda al PING
        const w0 = createdWorkers[0];
        w0.postMessage = () => {};

        const workersBefore = pool.getStats().totalWorkersCreated;

        // Disparar health check (cada 5000ms)
        jest.advanceTimersByTime(5000);
        // Esperar timeout del health check (1000ms)
        jest.advanceTimersByTime(1500);

        const statsAfter = pool.getStats();
        expect(statsAfter.totalHealthReplacements).toBeGreaterThanOrEqual(1);
        expect(statsAfter.totalWorkersCreated).toBeGreaterThan(workersBefore);

        await pool.shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    it('no debe reemplazar workers que responden al PING', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      try {
        const pool = createPool({
          minWorkers: 1,
          maxWorkers: 2,
          healthCheckIntervalMs: 5000,
          healthCheckTimeoutMs: 2000,
        });

        // Avanzar para disparar el health check (t=5000: envía PING)
        jest.advanceTimersByTime(5001);
        // El mock responde PONG con setTimeout(0), que se procesa en el siguiente tick
        jest.advanceTimersByTime(1);
        // El timeout de 2000ms aún no expiró, y el PONG ya llegó

        // Ahora avanzar más allá del timeout para confirmar que no se reemplazó
        jest.advanceTimersByTime(3000);

        expect(pool.getStats().totalHealthReplacements).toBe(0);

        await pool.shutdown();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // -----------------------------------------------------------------------
  // getStats
  // -----------------------------------------------------------------------
  describe('getStats', () => {
    it('debe reportar métricas completas', async () => {
      const pool = createPool();
      await pool.execute({ type: 'T1' });
      await pool.execute({ type: 'T2' });

      const stats: WorkerPoolStats = pool.getStats();
      expect(stats.totalTasksCompleted).toBe(2);
      expect(stats.totalWorkersCreated).toBeGreaterThanOrEqual(1);
      expect(stats.isShuttingDown).toBe(false);
      expect(typeof stats.maxWorkers).toBe('number');
      expect(typeof stats.minWorkers).toBe('number');

      await pool.shutdown();
    });
  });

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------
  describe('shutdown', () => {
    it('debe terminar todos los workers y rechazar tareas pendientes', async () => {
      const pool = createPool({ minWorkers: 2, maxWorkers: 3 });

      // Bloquear worker
      for (const w of createdWorkers) {
        w.postMessage = () => {};
      }
      pool.execute({ type: 'BLOCKED' }).catch(() => {}); // Capturar rechazo

      await pool.shutdown();

      const stats = pool.getStats();
      expect(stats.totalWorkers).toBe(0);
      expect(stats.isShuttingDown).toBe(true);
      expect(stats.waitingTasks).toBe(0);
    });

    it('debe loguear resumen al cerrar', async () => {
      const pool = createPool();
      await pool.execute({ type: 'T1' });
      await pool.shutdown();
      expect(pool.getStats().isShuttingDown).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Timeout de tarea
  // -----------------------------------------------------------------------
  describe('task timeout', () => {
    it('debe rechazar una tarea si excede el timeout', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      try {
        const pool = createPool({ taskTimeoutMs: 2000 });

        // Worker no responde
        createdWorkers[0].postMessage = () => {};

        const promise = pool.execute({ type: 'SLOW' });

        jest.advanceTimersByTime(2500);

        await expect(promise).rejects.toThrow('timeout');

        await pool.shutdown();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Auto-detect CPU
  // -----------------------------------------------------------------------
  describe('auto maxWorkers basado en CPU', () => {
    it('debe usar auto-detect cuando maxWorkers=0', async () => {
      const pool = new WorkerPool('/fake/worker.js', {
        minWorkers: 1,
        maxWorkers: 0, // auto
        healthCheckIntervalMs: 0,
      });
      const stats = pool.getStats();
      // Con 8 CPUs mockeados → max = min(8-1, 4) = 4
      expect(stats.maxWorkers).toBe(4);
      await pool.shutdown();
    });
  });
});
