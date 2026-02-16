/**
 * Tests unitarios para electron/engines/BufferPool.ts
 *
 * Cubre: acquire/release, límites de pool, pre-allocation, acquireFor,
 * estadísticas (hit rate, counters), drain, edge cases.
 */
import { BufferPool } from '../../electron/engines/BufferPool';

describe('BufferPool', () => {
  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------
  describe('constructor', () => {
    it('debe crear un pool con parámetros por defecto', () => {
      const pool = new BufferPool(1024);
      expect(pool.bufferSize).toBe(1024);
      expect(pool.availableCount).toBe(0);
    });

    it('debe rechazar bufferSize <= 0', () => {
      expect(() => new BufferPool(0)).toThrow(RangeError);
      expect(() => new BufferPool(-1)).toThrow(RangeError);
    });

    it('debe pre-alocar buffers si preAllocate=true', () => {
      const pool = new BufferPool(512, { maxPooled: 3, preAllocate: true });
      expect(pool.availableCount).toBe(3);
      const stats = pool.getStats();
      expect(stats.totalAllocations).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // acquire / release
  // -----------------------------------------------------------------------
  describe('acquire / release', () => {
    it('debe alocar un nuevo buffer cuando el pool está vacío', () => {
      const pool = new BufferPool(256);
      const buf = pool.acquire();
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBe(256);

      const stats = pool.getStats();
      expect(stats.totalMisses).toBe(1);
      expect(stats.totalAllocations).toBe(1);
    });

    it('debe reutilizar un buffer devuelto al pool', () => {
      const pool = new BufferPool(256, { maxPooled: 2 });
      const buf = pool.acquire();
      pool.release(buf);
      expect(pool.availableCount).toBe(1);

      const reused = pool.acquire();
      expect(reused).toBe(buf); // misma referencia (reutilizado)
      expect(pool.availableCount).toBe(0);

      const stats = pool.getStats();
      expect(stats.totalReuses).toBe(1);
    });

    it('debe descartar buffers si el pool está lleno al hacer release', () => {
      const pool = new BufferPool(128, { maxPooled: 1 });
      const buf1 = pool.acquire();
      const buf2 = pool.acquire();

      pool.release(buf1); // entra al pool
      pool.release(buf2); // descartado (pool lleno)

      expect(pool.availableCount).toBe(1);
      const stats = pool.getStats();
      expect(stats.totalDiscarded).toBe(1);
    });

    it('debe descartar buffers de tamaño incorrecto en release', () => {
      const pool = new BufferPool(256, { maxPooled: 4 });
      const wrongSize = Buffer.allocUnsafe(128);
      pool.release(wrongSize);

      expect(pool.availableCount).toBe(0);
      const stats = pool.getStats();
      expect(stats.totalDiscarded).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // acquireFor
  // -----------------------------------------------------------------------
  describe('acquireFor', () => {
    it('debe retornar un buffer del pool si requestedSize <= bufferSize', () => {
      const pool = new BufferPool(1024, { maxPooled: 2, preAllocate: true });
      const buf = pool.acquireFor(512);
      expect(buf.length).toBe(1024); // retorna bufferSize del pool
      expect(pool.availableCount).toBe(1); // uno fue sacado
    });

    it('debe alocar ad-hoc si requestedSize > bufferSize', () => {
      const pool = new BufferPool(256, { maxPooled: 2, preAllocate: true });
      const buf = pool.acquireFor(512);
      expect(buf.length).toBe(512); // ad-hoc, no del pool
      expect(pool.availableCount).toBe(2); // pool intacto

      const stats = pool.getStats();
      expect(stats.totalMisses).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // drain
  // -----------------------------------------------------------------------
  describe('drain', () => {
    it('debe vaciar todos los buffers del pool', () => {
      const pool = new BufferPool(256, { maxPooled: 3, preAllocate: true });
      expect(pool.availableCount).toBe(3);
      pool.drain();
      expect(pool.availableCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // getStats / resetStats
  // -----------------------------------------------------------------------
  describe('getStats', () => {
    it('debe reportar estadísticas correctas', () => {
      const pool = new BufferPool(1024, { maxPooled: 2, name: 'TestPool' });

      // 3 acquires sin pool → 3 misses, 3 allocations
      const bufs = [pool.acquire(), pool.acquire(), pool.acquire()];

      // Release 2 → pool lleno a 2
      pool.release(bufs[0]);
      pool.release(bufs[1]);
      pool.release(bufs[2]); // descartado

      // Acquire 1 → reuse
      pool.acquire();

      const stats = pool.getStats();
      expect(stats.name).toBe('TestPool');
      expect(stats.bufferSize).toBe(1024);
      expect(stats.maxPooled).toBe(2);
      expect(stats.totalAllocations).toBe(3);
      expect(stats.totalMisses).toBe(3);
      expect(stats.totalReuses).toBe(1);
      expect(stats.totalDiscarded).toBe(1);
      expect(stats.availableCount).toBe(1);
      expect(stats.pooledBytes).toBe(1024); // 1 buffer * 1024
      // hitRate = 1 reuse / (1 reuse + 3 misses) = 0.25
      expect(stats.hitRate).toBeCloseTo(0.25, 2);
    });

    it('debe reportar hitRate = 0 si no se ha hecho acquire', () => {
      const pool = new BufferPool(256);
      expect(pool.getStats().hitRate).toBe(0);
    });
  });

  describe('resetStats', () => {
    it('debe resetear contadores sin afectar buffers en el pool', () => {
      const pool = new BufferPool(256, { maxPooled: 2, preAllocate: true });
      pool.acquire(); // 1 reuse
      pool.resetStats();

      const stats = pool.getStats();
      expect(stats.totalAllocations).toBe(0);
      expect(stats.totalReuses).toBe(0);
      expect(stats.totalMisses).toBe(0);
      expect(stats.totalDiscarded).toBe(0);
      // Los buffers siguen en el pool
      expect(pool.availableCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Stress / ciclo de vida
  // -----------------------------------------------------------------------
  describe('ciclo de uso típico', () => {
    it('debe manejar adquirir y devolver repetidamente sin memory leak', () => {
      const pool = new BufferPool(4096, { maxPooled: 2 });

      // Simular 100 operaciones acquire/release
      for (let i = 0; i < 100; i++) {
        const buf = pool.acquire();
        pool.release(buf);
      }

      // El pool debe tener ≤ maxPooled buffers
      expect(pool.availableCount).toBeLessThanOrEqual(2);

      const stats = pool.getStats();
      // Después del primero (miss), los demás 99 son reuses
      expect(stats.totalReuses).toBe(99);
      expect(stats.totalMisses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(0.99, 2);
    });
  });
});
