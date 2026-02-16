/**
 * Tests unitarios para electron/engines/Scheduler.ts
 *
 * Cubre: prioridad efectiva (aging, SJF, retry penalty), canStartDownload,
 * selectDownloadsToStart, register/unregister, per-host limits, setMaxConcurrentPerHost.
 */
import Scheduler from '../../electron/engines/Scheduler';

describe('Scheduler', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    scheduler = new Scheduler();
  });

  // -----------------------------------------------------------------------
  // calculateEffectivePriority
  // -----------------------------------------------------------------------
  describe('calculateEffectivePriority', () => {
    it('debe retornar la prioridad base cuando el download es reciente y sin retries', () => {
      const now = Date.now();
      const priority = scheduler.calculateEffectivePriority(
        { priority: 2, created_at: now, retry_count: 0 },
        now
      );
      expect(priority).toBe(2);
    });

    it('debe aplicar aging bonus a descargas antiguas', () => {
      const now = Date.now();
      // Crear download con 2 intervalos de aging (~60 min con default 30 min)
      const twoIntervalsAgo = now - 2 * 30 * 60 * 1000;
      const priority = scheduler.calculateEffectivePriority(
        { priority: 1, created_at: twoIntervalsAgo, retry_count: 0 },
        now
      );
      // aging bonus = min(2 * 1.0, 2) = 2; effectivePriority = 1 + 2 = 3
      expect(priority).toBeGreaterThan(1);
      expect(priority).toBeLessThanOrEqual(3);
    });

    it('debe aplicar mayor aging multiplier a prioridad 0 (low priority)', () => {
      const now = Date.now();
      const oneIntervalAgo = now - 30 * 60 * 1000;

      const normalPriority = scheduler.calculateEffectivePriority(
        { priority: 1, created_at: oneIntervalAgo },
        now
      );
      const lowPriority = scheduler.calculateEffectivePriority(
        { priority: 0, created_at: oneIntervalAgo },
        now
      );

      // Low priority tiene multiplier de 1.5 vs 1.0 del normal
      // normal: 1 + min(1*1.0, 2) = 2
      // low: 0 + min(1*1.5, 2) = 1.5
      // La ganancia relativa de aging es mayor para low priority
      const normalGain = normalPriority - 1;
      const lowGain = lowPriority - 0;
      expect(lowGain).toBeGreaterThan(normalGain);
    });

    it('debe limitar el aging bonus al máximo configurado', () => {
      const now = Date.now();
      // 10 intervalos de aging (5 horas con default 30 min)
      const longAgo = now - 10 * 30 * 60 * 1000;
      const priority = scheduler.calculateEffectivePriority(
        { priority: 1, created_at: longAgo, retry_count: 0 },
        now
      );
      // Max aging bonus = 2 → effectivePriority = 1 + 2 = 3
      expect(priority).toBeLessThanOrEqual(3);
    });

    it('debe aplicar retry penalty después del free retry', () => {
      const now = Date.now();
      const noRetry = scheduler.calculateEffectivePriority(
        { priority: 2, created_at: now, retry_count: 0 },
        now
      );
      // 1 retry = free (retryPenaltyFreeRetries = 1 default)
      const oneRetry = scheduler.calculateEffectivePriority(
        { priority: 2, created_at: now, retry_count: 1 },
        now
      );
      // 3 retries = 2 penalizables → penalty = min(2*0.5, 1.5) = 1.0
      const threeRetries = scheduler.calculateEffectivePriority(
        { priority: 2, created_at: now, retry_count: 3 },
        now
      );

      expect(oneRetry).toBe(noRetry); // 1 retry es gratis
      expect(threeRetries).toBeLessThan(noRetry);
    });

    it('debe limitar la retry penalty al máximo configurado', () => {
      const now = Date.now();
      const manyRetries = scheduler.calculateEffectivePriority(
        { priority: 2, created_at: now, retry_count: 100 },
        now
      );
      // max penalty = 1.5 → priority = 2 - 1.5 = 0.5
      expect(manyRetries).toBeGreaterThanOrEqual(2 - 1.5);
    });
  });

  // -----------------------------------------------------------------------
  // getEffectiveSize / compareSizes (SJF)
  // -----------------------------------------------------------------------
  describe('SJF (Shortest Job First)', () => {
    it('debe retornar el tamaño real si total_bytes > 0', () => {
      const size = scheduler.getEffectiveSize({ total_bytes: 5000 });
      expect(size).toBe(5000);
    });

    it('debe retornar tamaño default si total_bytes es 0 o ausente', () => {
      const size1 = scheduler.getEffectiveSize({ total_bytes: 0 });
      const size2 = scheduler.getEffectiveSize({});
      expect(size1).toBe(100 * 1024 * 1024); // default
      expect(size2).toBe(100 * 1024 * 1024);
    });

    it('debe retornar 0 si los tamaños son similares (dentro de tolerancia)', () => {
      // tolerancia default 10%
      const cmp = scheduler.compareSizes(1000, 1050);
      expect(cmp).toBe(0);
    });

    it('debe diferenciar tamaños fuera de tolerancia', () => {
      const cmp = scheduler.compareSizes(1000, 2000);
      expect(cmp).toBeLessThan(0); // 1000 < 2000 → favorece a
    });
  });

  // -----------------------------------------------------------------------
  // canStartDownload
  // -----------------------------------------------------------------------
  describe('canStartDownload', () => {
    it('debe permitir descarga si hay slots disponibles', () => {
      const result = scheduler.canStartDownload(0);
      expect(result.canStart).toBe(true);
      expect(result.slotsAvailable).toBeGreaterThan(0);
    });

    it('debe denegar si se alcanzó el límite global', () => {
      scheduler.setMaxConcurrent(2);
      const result = scheduler.canStartDownload(2);
      expect(result.canStart).toBe(false);
      expect(result.reason).toContain('global');
    });

    it('debe denegar si se alcanzó el límite por host', () => {
      // Registrar descargas para saturar el host
      scheduler.registerDownload(1, 'example.com');
      scheduler.registerDownload(2, 'example.com');
      const result = scheduler.canStartDownload(0, 'example.com');
      expect(result.canStart).toBe(false);
      expect(result.hostLimit).toBe(true);
    });

    it('debe permitir descargas de otro host si solo uno está saturado', () => {
      scheduler.registerDownload(1, 'example.com');
      scheduler.registerDownload(2, 'example.com');
      const result = scheduler.canStartDownload(0, 'other.com');
      expect(result.canStart).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // registerDownload / unregisterDownload
  // -----------------------------------------------------------------------
  describe('register/unregister', () => {
    it('debe incrementar getActiveCount al registrar', () => {
      expect(scheduler.getActiveCount()).toBe(0);
      scheduler.registerDownload(1, 'host.com');
      expect(scheduler.getActiveCount()).toBe(1);
      scheduler.registerDownload(2, 'host.com');
      expect(scheduler.getActiveCount()).toBe(2);
    });

    it('debe decrementar al desregistrar', () => {
      scheduler.registerDownload(1, 'host.com');
      scheduler.registerDownload(2, 'host.com');
      scheduler.unregisterDownload(1, 'host.com');
      expect(scheduler.getActiveCount()).toBe(1);
    });

    it('debe ser idempotente para desregistrar la misma descarga', () => {
      scheduler.registerDownload(1, 'host.com');
      scheduler.unregisterDownload(1, 'host.com');
      scheduler.unregisterDownload(1, 'host.com'); // no-op
      expect(scheduler.getActiveCount()).toBe(0);
    });

    it('debe limpiar el set del host al quedar vacío', () => {
      scheduler.registerDownload(1, 'host.com');
      scheduler.unregisterDownload(1, 'host.com');
      // El host ya no debería limitar nuevas descargas
      const result = scheduler.canStartDownload(0, 'host.com');
      expect(result.canStart).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // setMaxConcurrent / setMaxConcurrentPerHost
  // -----------------------------------------------------------------------
  describe('setMaxConcurrent / setMaxConcurrentPerHost', () => {
    it('debe clampear maxConcurrent entre 1 y 3', () => {
      scheduler.setMaxConcurrent(10);
      expect(scheduler.maxConcurrent).toBe(3);

      // 0 se trata como "no proporcionado" → default 2 por lógica `Number(n) || 2`
      scheduler.setMaxConcurrent(0);
      expect(scheduler.maxConcurrent).toBe(2);

      scheduler.setMaxConcurrent(1);
      expect(scheduler.maxConcurrent).toBe(1);

      scheduler.setMaxConcurrent(2);
      expect(scheduler.maxConcurrent).toBe(2);
    });

    it('debe clampear maxConcurrentPerHost entre 1 y maxConcurrent', () => {
      scheduler.setMaxConcurrent(2);
      scheduler.setMaxConcurrentPerHost(10);
      expect(scheduler.getMaxConcurrentPerHost()).toBe(2); // clamped a maxConcurrent

      // 0 se trata como "no proporcionado" → default 2 por lógica `Number(n) || 2`
      scheduler.setMaxConcurrentPerHost(0);
      expect(scheduler.getMaxConcurrentPerHost()).toBe(2);

      scheduler.setMaxConcurrentPerHost(1);
      expect(scheduler.getMaxConcurrentPerHost()).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // selectDownloadsToStart
  // -----------------------------------------------------------------------
  describe('selectDownloadsToStart', () => {
    it('debe retornar vacío si no hay cola', () => {
      const selected = scheduler.selectDownloadsToStart([], 5);
      expect(selected).toEqual([]);
    });

    it('debe retornar vacío si no hay slots', () => {
      const queue = [{ id: 1, url: 'https://host.com/a', priority: 1 }];
      const selected = scheduler.selectDownloadsToStart(queue, 0);
      expect(selected).toEqual([]);
    });

    it('debe seleccionar hasta slotsAvailable descargas', () => {
      const queue = [
        { id: 1, url: 'https://host.com/a', priority: 1 },
        { id: 2, url: 'https://host.com/b', priority: 1 },
        { id: 3, url: 'https://host.com/c', priority: 1 },
      ];
      const selected = scheduler.selectDownloadsToStart(queue, 1, 0);
      expect(selected.length).toBe(1);
    });

    it('debe respetar el límite global en selectDownloadsToStart', () => {
      scheduler.setMaxConcurrent(2);
      const queue = [
        { id: 1, url: 'https://a.com/f', priority: 1 },
        { id: 2, url: 'https://b.com/f', priority: 1 },
        { id: 3, url: 'https://c.com/f', priority: 1 },
      ];
      // currentActiveCount=1, slots=3 pero global max=2, así que max 1 nuevo
      const selected = scheduler.selectDownloadsToStart(queue, 3, 1);
      expect(selected.length).toBeLessThanOrEqual(1);
    });

    it('debe priorizar descargas con mayor prioridad efectiva', () => {
      const now = Date.now();
      const queue = [
        { id: 1, url: 'https://a.com/f', priority: 0, created_at: now },
        { id: 2, url: 'https://b.com/f', priority: 2, created_at: now },
      ];
      const selected = scheduler.selectDownloadsToStart(queue, 1, 0);
      expect(selected.length).toBe(1);
      expect(selected[0].id).toBe(2); // mayor prioridad
    });

    it('debe respetar límites per-host', () => {
      scheduler.setMaxConcurrent(3);
      // Saturar host a.com
      scheduler.registerDownload(100, 'a.com');
      scheduler.registerDownload(101, 'a.com');
      const queue = [
        { id: 1, url: 'https://a.com/f', priority: 2 }, // host saturado
        { id: 2, url: 'https://b.com/f', priority: 1 }, // host libre
      ];
      const selected = scheduler.selectDownloadsToStart(queue, 2, 2);
      // Solo id=2 debería poder arrancar (a.com está al límite)
      expect(selected.length).toBe(1);
      expect(selected[0].id).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // extractHost
  // -----------------------------------------------------------------------
  describe('extractHost', () => {
    it('debe extraer el hostname de una URL válida', () => {
      expect(scheduler.extractHost('https://myrient.erista.me/files/rom.zip')).toBe(
        'myrient.erista.me'
      );
    });

    it('debe retornar null para URL inválida o undefined', () => {
      expect(scheduler.extractHost(undefined)).toBeNull();
      expect(scheduler.extractHost('not-a-url')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // cleanup
  // -----------------------------------------------------------------------
  describe('cleanup', () => {
    it('debe ejecutar sin errores', () => {
      scheduler.registerDownload(1, 'host.com');
      expect(() => scheduler.cleanup()).not.toThrow();
    });
  });
});
