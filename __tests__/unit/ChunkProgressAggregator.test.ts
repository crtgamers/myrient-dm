/**
 * Tests unitarios para electron/engines/ChunkProgressAggregator.ts
 *
 * Cubre: init, updateBytes, updateState, markCompleted, resetChunk,
 * setChunkHash/getChunkHash, getTotalDownloaded, allCompleted,
 * getChunkProgressArray, clear, clearAll, purgeExpired, getStats.
 */
import { ChunkProgressAggregator } from '../../electron/engines/ChunkProgressAggregator';

describe('ChunkProgressAggregator', () => {
  let aggregator: ChunkProgressAggregator;

  const sampleChunks = [
    { chunkIndex: 0, startByte: 0, endByte: 4999, downloadedBytes: 0, state: 'pending' },
    { chunkIndex: 1, startByte: 5000, endByte: 9999, downloadedBytes: 0, state: 'pending' },
    { chunkIndex: 2, startByte: 10000, endByte: 14999, downloadedBytes: 0, state: 'pending' },
  ];

  beforeEach(() => {
    aggregator = new ChunkProgressAggregator();
  });

  // -----------------------------------------------------------------------
  // init / has / clear
  // -----------------------------------------------------------------------
  describe('init / has / clear', () => {
    it('debe inicializar caché para una descarga', () => {
      aggregator.init(1, sampleChunks);
      expect(aggregator.has(1)).toBe(true);
      expect(aggregator.getChunkCount(1)).toBe(3);
    });

    it('debe reemplazar caché existente al re-inicializar', () => {
      aggregator.init(1, sampleChunks);
      aggregator.updateBytes(1, 0, 2500);

      // Re-inicializar con nuevos datos
      aggregator.init(1, [sampleChunks[0]]);
      expect(aggregator.getChunkCount(1)).toBe(1);
      expect(aggregator.getChunkBytes(1, 0)).toBe(0); // reseteado
    });

    it('clear debe eliminar el caché de una descarga', () => {
      aggregator.init(1, sampleChunks);
      aggregator.clear(1);
      expect(aggregator.has(1)).toBe(false);
      expect(aggregator.getChunkCount(1)).toBe(0);
    });

    it('clearAll debe eliminar todo el caché', () => {
      aggregator.init(1, sampleChunks);
      aggregator.init(2, sampleChunks);
      aggregator.clearAll();
      expect(aggregator.has(1)).toBe(false);
      expect(aggregator.has(2)).toBe(false);
      expect(aggregator.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // updateBytes / getTotalDownloaded / getChunkBytes
  // -----------------------------------------------------------------------
  describe('updateBytes', () => {
    it('debe actualizar bytes de un chunk', () => {
      aggregator.init(1, sampleChunks);
      aggregator.updateBytes(1, 0, 3000);
      expect(aggregator.getChunkBytes(1, 0)).toBe(3000);
    });

    it('debe no-op si el downloadId no existe', () => {
      aggregator.updateBytes(999, 0, 3000);
      expect(aggregator.getChunkBytes(999, 0)).toBeNull();
    });
  });

  describe('getTotalDownloaded', () => {
    it('debe sumar bytes de todos los chunks', () => {
      aggregator.init(1, sampleChunks);
      aggregator.updateBytes(1, 0, 2000);
      aggregator.updateBytes(1, 1, 3000);
      aggregator.updateBytes(1, 2, 1000);
      expect(aggregator.getTotalDownloaded(1)).toBe(6000);
    });

    it('debe retornar 0 si no hay caché', () => {
      expect(aggregator.getTotalDownloaded(999)).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // updateState / markCompleted / resetChunk
  // -----------------------------------------------------------------------
  describe('updateState / markCompleted / resetChunk', () => {
    it('debe actualizar estado de un chunk', () => {
      aggregator.init(1, sampleChunks);
      aggregator.updateState(1, 0, 'downloading');
      const progress = aggregator.getChunkProgressArray(1);
      expect(progress.find(p => p.index === 0)!.state).toBe('downloading');
    });

    it('markCompleted debe marcar chunk como completed con bytes', () => {
      aggregator.init(1, sampleChunks);
      aggregator.markCompleted(1, 0, 5000);
      const progress = aggregator.getChunkProgressArray(1);
      const chunk0 = progress.find(p => p.index === 0)!;
      expect(chunk0.state).toBe('completed');
      expect(chunk0.downloadedBytes).toBe(5000);
    });

    it('resetChunk debe volver a pending con 0 bytes', () => {
      aggregator.init(1, sampleChunks);
      aggregator.markCompleted(1, 0, 5000);
      aggregator.setChunkHash(1, 0, 'abc123');
      aggregator.resetChunk(1, 0);

      expect(aggregator.getChunkBytes(1, 0)).toBe(0);
      expect(aggregator.getChunkHash(1, 0)).toBeNull();
      const progress = aggregator.getChunkProgressArray(1);
      expect(progress.find(p => p.index === 0)!.state).toBe('pending');
    });
  });

  // -----------------------------------------------------------------------
  // Hash
  // -----------------------------------------------------------------------
  describe('setChunkHash / getChunkHash', () => {
    it('debe almacenar y recuperar hash de un chunk', () => {
      aggregator.init(1, sampleChunks);
      aggregator.setChunkHash(1, 0, 'sha256-abc123');
      expect(aggregator.getChunkHash(1, 0)).toBe('sha256-abc123');
    });

    it('debe retornar null si no hay hash', () => {
      aggregator.init(1, sampleChunks);
      expect(aggregator.getChunkHash(1, 0)).toBeNull();
    });

    it('debe retornar null para downloadId inexistente', () => {
      expect(aggregator.getChunkHash(999, 0)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // allCompleted / getCompletedCount / getActiveCount
  // -----------------------------------------------------------------------
  describe('allCompleted', () => {
    it('debe retornar false si hay chunks pendientes', () => {
      aggregator.init(1, sampleChunks);
      aggregator.markCompleted(1, 0, 5000);
      expect(aggregator.allCompleted(1)).toBe(false);
    });

    it('debe retornar true si todos están completados', () => {
      aggregator.init(1, sampleChunks);
      aggregator.markCompleted(1, 0, 5000);
      aggregator.markCompleted(1, 1, 5000);
      aggregator.markCompleted(1, 2, 5000);
      expect(aggregator.allCompleted(1)).toBe(true);
    });

    it('debe retornar false para downloadId inexistente', () => {
      expect(aggregator.allCompleted(999)).toBe(false);
    });
  });

  describe('getCompletedCount / getActiveCount', () => {
    it('debe contar chunks completados y activos', () => {
      aggregator.init(1, sampleChunks);
      aggregator.markCompleted(1, 0, 5000);
      aggregator.updateState(1, 1, 'downloading');

      expect(aggregator.getCompletedCount(1)).toBe(1);
      expect(aggregator.getActiveCount(1)).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // getChunkProgressArray
  // -----------------------------------------------------------------------
  describe('getChunkProgressArray', () => {
    it('debe generar array con progreso por chunk', () => {
      aggregator.init(1, sampleChunks);
      aggregator.updateBytes(1, 0, 2500); // 50% de 5000

      const progress = aggregator.getChunkProgressArray(1);
      expect(progress).toHaveLength(3);
      const chunk0 = progress.find(p => p.index === 0)!;
      expect(chunk0.progress).toBeCloseTo(0.5, 2);
      expect(chunk0.totalBytes).toBe(5000);
    });

    it('debe retornar vacío para downloadId inexistente', () => {
      expect(aggregator.getChunkProgressArray(999)).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // purgeExpired
  // -----------------------------------------------------------------------
  describe('purgeExpired', () => {
    it('debe eliminar entradas inactivas más antiguas que el TTL', () => {
      aggregator.init(1, sampleChunks);
      aggregator.init(2, sampleChunks);

      // Simular que la descarga 1 es antigua
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValueOnce(now + 20 * 60 * 1000); // 20 min después

      // Con TTL de 10 min, ambas deberían expirar
      const purged = aggregator.purgeExpired(10 * 60 * 1000);
      expect(purged).toBe(2);
      expect(aggregator.has(1)).toBe(false);
      expect(aggregator.has(2)).toBe(false);

      jest.restoreAllMocks();
    });

    it('no debe eliminar entradas recientes', () => {
      aggregator.init(1, sampleChunks);

      // Con TTL de 10 min y datos recién creados, no debe purgar nada
      const purged = aggregator.purgeExpired(10 * 60 * 1000);
      expect(purged).toBe(0);
      expect(aggregator.has(1)).toBe(true);
    });

    it('debe preservar entradas con actividad reciente', () => {
      aggregator.init(1, sampleChunks);
      aggregator.init(2, sampleChunks);

      // Avanzar 5 minutos y actualizar solo descarga 2
      const now = Date.now();
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(now + 5 * 60 * 1000) // updateBytes timestamp
        .mockReturnValueOnce(now + 8 * 60 * 1000); // purgeExpired timestamp

      aggregator.updateBytes(2, 0, 1000); // refresca timestamp de descarga 2

      // Con TTL de 6 min: descarga 1 expiró (8 min sin actividad), descarga 2 no (3 min)
      const purged = aggregator.purgeExpired(6 * 60 * 1000);
      expect(purged).toBe(1);
      expect(aggregator.has(1)).toBe(false);
      expect(aggregator.has(2)).toBe(true);

      jest.restoreAllMocks();
    });

    it('init() debe invocar purgeExpired automáticamente', () => {
      const purgeSpy = jest.spyOn(aggregator, 'purgeExpired');
      aggregator.init(1, sampleChunks);
      expect(purgeSpy).toHaveBeenCalled();
      purgeSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // size / getStats
  // -----------------------------------------------------------------------
  describe('size / getStats', () => {
    it('size debe reflejar la cantidad de descargas en caché', () => {
      expect(aggregator.size).toBe(0);
      aggregator.init(1, sampleChunks);
      expect(aggregator.size).toBe(1);
      aggregator.init(2, sampleChunks);
      expect(aggregator.size).toBe(2);
      aggregator.clear(1);
      expect(aggregator.size).toBe(1);
    });

    it('getStats debe retornar estadísticas correctas', () => {
      aggregator.init(1, sampleChunks);
      aggregator.init(2, [sampleChunks[0], sampleChunks[1]]);

      const stats = aggregator.getStats();
      expect(stats.cachedDownloads).toBe(2);
      expect(stats.totalChunks).toBe(5); // 3 + 2
      expect(stats.oldestActivityMs).toBeGreaterThanOrEqual(0);
      expect(stats.oldestActivityMs).toBeLessThan(1000); // recién creados
    });

    it('getStats debe retornar null si no hay caché', () => {
      const stats = aggregator.getStats();
      expect(stats.cachedDownloads).toBe(0);
      expect(stats.totalChunks).toBe(0);
      expect(stats.oldestActivityMs).toBeNull();
    });
  });
});
