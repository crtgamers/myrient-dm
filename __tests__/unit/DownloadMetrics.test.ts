/**
 * Tests unitarios para electron/engines/DownloadMetrics.ts
 *
 * Cubre: recordStart/recordCompleted/recordFailed, recordTransientRetry,
 * recordBytes, getErrorRate, getHostMetrics, durationBuckets, logSummary, reset.
 */
import { DownloadMetrics } from '../../electron/engines/DownloadMetrics';

describe('DownloadMetrics', () => {
  let metrics: DownloadMetrics;

  beforeEach(() => {
    metrics = new DownloadMetrics();
  });

  // -----------------------------------------------------------------------
  // Ciclo de vida básico
  // -----------------------------------------------------------------------
  describe('ciclo de vida', () => {
    it('debe registrar inicio de descarga', () => {
      metrics.recordStart(1, 'host.com');
      const global = metrics.getGlobalMetrics();
      expect(global.totalStarted).toBe(1);
    });

    it('debe registrar descarga completada y actualizar métricas', () => {
      metrics.recordStart(1, 'host.com');
      metrics.recordCompleted(1, 5000);

      const global = metrics.getGlobalMetrics();
      expect(global.totalCompleted).toBe(1);
      expect(global.totalFailed).toBe(0);
    });

    it('debe registrar descarga fallida', () => {
      metrics.recordStart(1, 'host.com');
      metrics.recordFailed(1);

      const global = metrics.getGlobalMetrics();
      expect(global.totalCompleted).toBe(0);
      expect(global.totalFailed).toBe(1);
    });

    it('debe registrar bytes descargados', () => {
      metrics.recordStart(1, 'host.com');
      metrics.recordBytes(1, 1000);
      metrics.recordBytes(1, 2000);

      const global = metrics.getGlobalMetrics();
      expect(global.totalBytesDownloaded).toBe(3000);
    });

    it('debe limpiar tracker al cancelar/pausar', () => {
      metrics.recordStart(1, 'host.com');
      metrics.recordCancelledOrPaused(1);

      // Si luego completamos sin tracker, no debería fallar
      metrics.recordCompleted(1, 0);
      const global = metrics.getGlobalMetrics();
      expect(global.totalCompleted).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Error rate
  // -----------------------------------------------------------------------
  describe('getErrorRate', () => {
    it('debe retornar 0 si no hay descargas', () => {
      expect(metrics.getErrorRate()).toBe(0);
    });

    it('debe calcular la tasa de error correctamente', () => {
      metrics.recordStart(1, 'host.com');
      metrics.recordStart(2, 'host.com');
      metrics.recordStart(3, 'host.com');
      metrics.recordCompleted(1);
      metrics.recordCompleted(2);
      metrics.recordFailed(3);

      // 1 fallida / (2 completadas + 1 fallida) = 0.333...
      expect(metrics.getErrorRate()).toBeCloseTo(1 / 3, 4);
    });
  });

  // -----------------------------------------------------------------------
  // Transient retries
  // -----------------------------------------------------------------------
  describe('recordTransientRetry', () => {
    it('debe incrementar el contador global de transient retries', () => {
      metrics.recordTransientRetry('host.com');
      metrics.recordTransientRetry('host.com');
      metrics.recordTransientRetry(null);

      const global = metrics.getGlobalMetrics();
      expect(global.totalTransientRetries).toBe(3);
    });

    it('debe incrementar el error count del host', () => {
      metrics.recordTransientRetry('host.com');

      const hostMetrics = metrics.getHostMetrics('host.com');
      expect(hostMetrics).not.toBeNull();
      expect(hostMetrics!.errorCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Host metrics
  // -----------------------------------------------------------------------
  describe('getHostMetrics', () => {
    it('debe retornar null para host sin datos', () => {
      expect(metrics.getHostMetrics('unknown.com')).toBeNull();
    });

    it('debe acumular métricas por host', () => {
      metrics.recordStart(1, 'a.com');
      metrics.recordStart(2, 'b.com');
      metrics.recordCompleted(1, 10_000);
      metrics.recordCompleted(2, 20_000);

      const a = metrics.getHostMetrics('a.com');
      const b = metrics.getHostMetrics('b.com');
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.completedCount).toBe(1);
      expect(a!.totalBytes).toBe(10_000);
      expect(b!.completedCount).toBe(1);
      expect(b!.totalBytes).toBe(20_000);
    });

    it('debe calcular avgSpeedBps correctamente', () => {
      // Forzar timing con Date.now stub
      const now = Date.now();
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(now) // recordStart
        .mockReturnValueOnce(now + 2000); // recordCompleted (2s después)

      metrics.recordStart(1, 'fast.com');
      metrics.recordCompleted(1, 10_000);

      const hostMetrics = metrics.getHostMetrics('fast.com');
      expect(hostMetrics).not.toBeNull();
      // 10000 bytes / 2s = 5000 bytes/s
      expect(hostMetrics!.avgSpeedBps).toBeCloseTo(5000, 0);

      jest.restoreAllMocks();
    });
  });

  // -----------------------------------------------------------------------
  // Host error rate
  // -----------------------------------------------------------------------
  describe('getHostErrorRate', () => {
    it('debe retornar 0 para host inexistente', () => {
      expect(metrics.getHostErrorRate('nope.com')).toBe(0);
    });

    it('debe calcular error rate del host', () => {
      metrics.recordStart(1, 'flaky.com');
      metrics.recordFailed(1);
      metrics.recordStart(2, 'flaky.com');
      metrics.recordCompleted(2);

      // 1 error / (1 completed + 1 error) = 0.5
      expect(metrics.getHostErrorRate('flaky.com')).toBeCloseTo(0.5, 4);
    });
  });

  // -----------------------------------------------------------------------
  // Duration buckets
  // -----------------------------------------------------------------------
  describe('durationBuckets', () => {
    it('debe categorizar descargas en buckets de duración', () => {
      const now = Date.now();

      // Descarga rápida: 2s → bucket "<5s"
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(now) // recordStart
        .mockReturnValueOnce(now + 2000); // recordCompleted

      metrics.recordStart(1, 'host.com');
      metrics.recordCompleted(1);

      const global = metrics.getGlobalMetrics();
      expect(global.durationBuckets['<5s']).toBe(1);

      jest.restoreAllMocks();
    });
  });

  // -----------------------------------------------------------------------
  // logSummary
  // -----------------------------------------------------------------------
  describe('logSummary', () => {
    it('debe ejecutar sin error cuando no hay datos', () => {
      expect(() => metrics.logSummary()).not.toThrow();
    });

    it('debe ejecutar sin error con datos', () => {
      metrics.recordStart(1, 'host.com');
      metrics.recordCompleted(1, 1000);
      expect(() => metrics.logSummary()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // reset
  // -----------------------------------------------------------------------
  describe('reset', () => {
    it('debe limpiar todas las métricas', () => {
      metrics.recordStart(1, 'host.com');
      metrics.recordCompleted(1, 5000);
      metrics.recordTransientRetry('host.com');

      metrics.reset();

      const global = metrics.getGlobalMetrics();
      expect(global.totalStarted).toBe(0);
      expect(global.totalCompleted).toBe(0);
      expect(global.totalFailed).toBe(0);
      expect(global.totalTransientRetries).toBe(0);
      expect(global.totalBytesDownloaded).toBe(0);
      expect(Object.keys(global.hosts)).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Defensive copy
  // -----------------------------------------------------------------------
  describe('getGlobalMetrics (copia defensiva)', () => {
    it('no debe permitir modificar las métricas internas', () => {
      metrics.recordStart(1, 'host.com');
      const snapshot1 = metrics.getGlobalMetrics();
      snapshot1.totalStarted = 999;

      const snapshot2 = metrics.getGlobalMetrics();
      expect(snapshot2.totalStarted).toBe(1); // no afectada
    });
  });

  // -----------------------------------------------------------------------
  // activeDownloadsCount y getLatencyPercentiles
  // -----------------------------------------------------------------------
  describe('métricas extendidas', () => {
    it('debe incluir activeDownloadsCount en getGlobalMetrics', () => {
      expect(metrics.getGlobalMetrics().activeDownloadsCount).toBe(0);
      metrics.recordStart(1, 'host.com');
      metrics.recordStart(2, 'host.com');
      expect(metrics.getGlobalMetrics().activeDownloadsCount).toBe(2);
      metrics.recordCompleted(1);
      expect(metrics.getGlobalMetrics().activeDownloadsCount).toBe(1);
    });

    it('getLatencyPercentiles debe retornar 0 cuando no hay duraciones', () => {
      const p = metrics.getLatencyPercentiles();
      expect(p.p50Ms).toBe(0);
      expect(p.p95Ms).toBe(0);
      expect(p.p99Ms).toBe(0);
    });

    it('getLatencyPercentiles debe calcular p50/p95/p99 de duraciones recientes', () => {
      const now = Date.now();
      // recordStart usa Date.now() para startedAt; recordCompleted usa Date.now() - startedAt para durationMs
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(now) // start 1 → startedAt = now
        .mockReturnValueOnce(now + 100) // complete 1 → duration 100 ms
        .mockReturnValueOnce(now + 100) // start 2 → startedAt = now+100
        .mockReturnValueOnce(now + 250) // complete 2 → duration 150 ms
        .mockReturnValueOnce(now + 250) // start 3 → startedAt = now+250
        .mockReturnValueOnce(now + 450); // complete 3 → duration 200 ms

      metrics.recordStart(1, 'h.com');
      metrics.recordCompleted(1);
      metrics.recordStart(2, 'h.com');
      metrics.recordCompleted(2);
      metrics.recordStart(3, 'h.com');
      metrics.recordCompleted(3);

      const p = metrics.getLatencyPercentiles();
      expect(p.p50Ms).toBe(150); // mediana de [100, 150, 200]
      expect(p.p95Ms).toBe(200);
      expect(p.p99Ms).toBe(200);

      jest.restoreAllMocks();
    });

    it('reset debe limpiar percentiles', () => {
      const now = Date.now();
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(now)
        .mockReturnValueOnce(now + 100);
      metrics.recordStart(1, 'h.com');
      metrics.recordCompleted(1);
      expect(metrics.getLatencyPercentiles().p50Ms).toBe(100);
      metrics.reset();
      expect(metrics.getLatencyPercentiles().p50Ms).toBe(0);
      jest.restoreAllMocks();
    });
  });
});
