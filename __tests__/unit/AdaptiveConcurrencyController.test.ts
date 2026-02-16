/**
 * Tests unitarios para electron/engines/AdaptiveConcurrencyController.ts
 *
 * Cubre: lifecycle (start/stop), scale-up conditions, scale-down conditions,
 * cooldown entre ajustes, user max ceiling, updateUserMaxConcurrent, getStatus.
 *
 * NOTA: Usamos fake timers (jest.useFakeTimers) para controlar setInterval/setTimeout
 * del evaluador periódico sin esperas reales.
 */
import { AdaptiveConcurrencyController } from '../../electron/engines/AdaptiveConcurrencyController';
import type { AdaptiveConcurrencyConfig } from '../../electron/engines/AdaptiveConcurrencyController';

describe('AdaptiveConcurrencyController', () => {
  let adjustCalls: Array<{ concurrent: number; perHost: number }>;
  let onAdjust: (_concurrent: number, _perHost: number) => void;

  /** Overrides de config para tests: habilitado, evaluación rápida, cooldown corto. */
  const testOverrides: Partial<AdaptiveConcurrencyConfig> = {
    enabled: true,
    evaluationIntervalMs: 100, // eval cada 100ms (con fake timers)
    cooldownMs: 50, // cooldown corto para tests
    windowSizeMs: 60_000,
    scaleUpErrorRateMax: 0.05,
    scaleDownErrorRateMin: 0.2,
    scaleUpMinThroughputBps: 256 * 1024,
    throughputDropThreshold: 0.4,
    scaleUpMinSamples: 2,
    scaleDownTransientRetryThreshold: 4,
  };

  beforeEach(() => {
    jest.useFakeTimers();
    adjustCalls = [];
    onAdjust = (concurrent, perHost) => {
      adjustCalls.push({ concurrent, perHost });
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Constructor y propiedades
  // -----------------------------------------------------------------------
  describe('constructor', () => {
    it('debe estar deshabilitado por defecto (sin overrides)', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust);
      expect(ctrl.enabled).toBe(false);
    });

    it('debe habilitarse con override enabled=true', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, testOverrides);
      expect(ctrl.enabled).toBe(true);
    });

    it('debe empezar con concurrencia conservadora (1)', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, testOverrides);
      expect(ctrl.currentConcurrent).toBe(1);
      expect(ctrl.currentPerHost).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle: start / stop
  // -----------------------------------------------------------------------
  describe('start / stop', () => {
    it('start() debe invocar onAdjust con valores iniciales', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, testOverrides);
      ctrl.start();
      expect(ctrl.started).toBe(true);
      expect(adjustCalls.length).toBe(1);
      expect(adjustCalls[0].concurrent).toBe(1);
    });

    it('start() debe ser idempotente', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, testOverrides);
      ctrl.start();
      ctrl.start();
      // Solo un onAdjust inicial
      expect(adjustCalls.length).toBe(1);
    });

    it('start() sin enabled=true no debe hacer nada', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, { enabled: false });
      ctrl.start();
      expect(ctrl.started).toBe(false);
      expect(adjustCalls.length).toBe(0);
    });

    it('stop() debe detener el controlador', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, testOverrides);
      ctrl.start();
      ctrl.stop();
      expect(ctrl.started).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Scale-up
  // -----------------------------------------------------------------------
  describe('scale-up', () => {
    it('debe escalar hacia arriba cuando hay suficientes éxitos y throughput', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, {
        ...testOverrides,
        cooldownMs: 0, // sin cooldown para facilitar test
      });
      ctrl.start();
      adjustCalls.length = 0;

      // Simular condiciones favorables: 3 éxitos, buen throughput
      ctrl.recordSuccess('host.com', 10_000_000, 5000);
      ctrl.recordSuccess('host.com', 10_000_000, 5000);
      ctrl.recordSuccess('host.com', 10_000_000, 5000);
      ctrl.recordThroughputSample(512 * 1024); // 512 KB/s

      // Avanzar el timer para que se ejecute la evaluación
      jest.advanceTimersByTime(200);

      // Debe haber escalado de 1 → 2
      expect(ctrl.currentConcurrent).toBeGreaterThanOrEqual(2);
      expect(adjustCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('no debe exceder el techo del usuario', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, {
        ...testOverrides,
        cooldownMs: 0,
      });
      ctrl.updateUserMaxConcurrent(2);
      ctrl.start();
      adjustCalls.length = 0;

      // Simular múltiples evaluaciones favorables
      for (let i = 0; i < 5; i++) {
        ctrl.recordSuccess('host.com', 10_000_000, 3000);
        ctrl.recordThroughputSample(1024 * 1024);
        jest.advanceTimersByTime(200);
      }

      // Nunca debe exceder 2 (techo del usuario)
      expect(ctrl.currentConcurrent).toBeLessThanOrEqual(2);
    });

    it('no debe escalar si no hay suficientes muestras (scaleUpMinSamples)', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, {
        ...testOverrides,
        cooldownMs: 0,
        scaleUpMinSamples: 5,
      });
      ctrl.start();
      adjustCalls.length = 0;

      // Solo 1 éxito (menos del mínimo de 5)
      ctrl.recordSuccess('host.com', 10_000_000, 3000);
      ctrl.recordThroughputSample(512 * 1024);
      jest.advanceTimersByTime(200);

      expect(ctrl.currentConcurrent).toBe(1); // sin cambio
    });

    it('no debe escalar si el throughput es bajo', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, {
        ...testOverrides,
        cooldownMs: 0,
      });
      ctrl.start();
      adjustCalls.length = 0;

      ctrl.recordSuccess('host.com', 1000, 5000);
      ctrl.recordSuccess('host.com', 1000, 5000);
      ctrl.recordThroughputSample(10 * 1024); // 10 KB/s (debajo del mínimo 256 KB/s)
      jest.advanceTimersByTime(200);

      expect(ctrl.currentConcurrent).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Scale-down
  // -----------------------------------------------------------------------
  describe('scale-down', () => {
    /**
     * Helper: fuerza el controlador a concurrencia 2 para poder probar scale-down.
     * Usa evaluationIntervalMs largo (5s) y avanza exactamente una evaluación para
     * escalar solo una vez (1→2), sin pasar a 3.
     */
    function setupAtConcurrency2(): AdaptiveConcurrencyController {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, {
        ...testOverrides,
        cooldownMs: 0,
        evaluationIntervalMs: 5000, // evaluación cada 5s
      });
      ctrl.updateUserMaxConcurrent(3);
      ctrl.start();
      adjustCalls.length = 0;

      // Registrar condiciones favorables
      ctrl.recordSuccess('host.com', 10_000_000, 3000);
      ctrl.recordSuccess('host.com', 10_000_000, 3000);
      ctrl.recordSuccess('host.com', 10_000_000, 3000);
      ctrl.recordThroughputSample(1024 * 1024);

      // Avanzar exactamente una evaluación (5s)
      jest.advanceTimersByTime(5000);

      // Verificar que escaló a exactamente 2
      expect(ctrl.currentConcurrent).toBe(2);
      adjustCalls.length = 0;
      return ctrl;
    }

    it('debe escalar hacia abajo cuando la tasa de error es alta', () => {
      const ctrl = setupAtConcurrency2();

      // Ahora simular muchos errores
      for (let i = 0; i < 10; i++) {
        ctrl.recordError('host.com', false); // errores permanentes
      }
      ctrl.recordSuccess('host.com', 1000, 1000); // 1 éxito entre muchos errores
      ctrl.recordThroughputSample(100 * 1024);
      // La evaluación es cada 5s; avanzar lo suficiente para una evaluación
      jest.advanceTimersByTime(5000);

      expect(ctrl.currentConcurrent).toBeLessThan(2);
    });

    it('debe escalar hacia abajo cuando hay muchos transient retries', () => {
      const ctrl = setupAtConcurrency2();

      // 5 transient retries (threshold = 4)
      for (let i = 0; i < 5; i++) {
        ctrl.recordError('host.com', true);
      }
      // La evaluación es cada 5s
      jest.advanceTimersByTime(5000);

      expect(ctrl.currentConcurrent).toBeLessThan(2);
    });

    it('no debe bajar por debajo de 1', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, {
        ...testOverrides,
        cooldownMs: 0,
      });
      ctrl.start();
      adjustCalls.length = 0;

      // Simular muchos errores
      for (let i = 0; i < 20; i++) {
        ctrl.recordError('host.com', false);
      }
      jest.advanceTimersByTime(500);

      expect(ctrl.currentConcurrent).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Cooldown
  // -----------------------------------------------------------------------
  describe('cooldown', () => {
    it('no debe hacer ajustes más rápido que el cooldown', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, {
        ...testOverrides,
        cooldownMs: 10_000, // 10s de cooldown
        evaluationIntervalMs: 100,
      });
      ctrl.start();
      adjustCalls.length = 0;

      // Condiciones favorables para scale-up
      ctrl.recordSuccess('host.com', 10_000_000, 3000);
      ctrl.recordSuccess('host.com', 10_000_000, 3000);
      ctrl.recordThroughputSample(512 * 1024);

      // Avanzar 200ms (3 evaluaciones pero cooldown de 10s no transcurrió aún)
      jest.advanceTimersByTime(200);

      // El last adjustment fue en start() → dentro de cooldown, no debe ajustar
      expect(adjustCalls.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // updateUserMaxConcurrent
  // -----------------------------------------------------------------------
  describe('updateUserMaxConcurrent', () => {
    it('debe reducir concurrencia si excede el nuevo techo', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, {
        ...testOverrides,
        cooldownMs: 0,
      });
      ctrl.updateUserMaxConcurrent(3);
      ctrl.start();
      adjustCalls.length = 0;

      // Escalar a 3
      for (let i = 0; i < 3; i++) {
        ctrl.recordSuccess('host.com', 10_000_000, 3000);
        ctrl.recordThroughputSample(1024 * 1024);
        jest.advanceTimersByTime(200);
      }

      const prev = ctrl.currentConcurrent;
      adjustCalls.length = 0;

      // Reducir techo a 1
      ctrl.updateUserMaxConcurrent(1);
      expect(ctrl.currentConcurrent).toBe(1);
      // Si estaba > 1, debe haber emitido onAdjust
      if (prev > 1) {
        expect(adjustCalls.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('debe clampear el techo entre 1 y 3', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, testOverrides);
      ctrl.updateUserMaxConcurrent(0);
      // El estado interno respeta el clamp
      const status = ctrl.getStatus();
      expect(status.userMaxConcurrent).toBe(1);

      ctrl.updateUserMaxConcurrent(10);
      const status2 = ctrl.getStatus();
      expect(status2.userMaxConcurrent).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // getStatus
  // -----------------------------------------------------------------------
  describe('getStatus', () => {
    it('debe retornar un snapshot consistente', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, testOverrides);
      ctrl.start();
      ctrl.recordSuccess('host.com', 1000, 1000);
      ctrl.recordError('host2.com', true);

      const status = ctrl.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.started).toBe(true);
      expect(status.currentConcurrent).toBe(1);
      expect(status.recentSuccessCount).toBe(1);
      expect(status.recentTransientCount).toBe(1);
      expect(typeof status.recentErrorRate).toBe('number');
    });
  });

  // -----------------------------------------------------------------------
  // reset
  // -----------------------------------------------------------------------
  describe('reset', () => {
    it('debe limpiar eventos y throughput pero mantener config', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, testOverrides);
      ctrl.start();
      ctrl.recordSuccess('host.com', 1000, 1000);
      ctrl.recordThroughputSample(512 * 1024);

      ctrl.reset();

      const status = ctrl.getStatus();
      expect(status.recentSuccessCount).toBe(0);
      expect(status.peakThroughputBps).toBe(0);
      expect(status.enabled).toBe(true); // config se mantiene
    });
  });

  // -----------------------------------------------------------------------
  // recordSuccess / recordError sin enabled
  // -----------------------------------------------------------------------
  describe('eventos con controlador deshabilitado', () => {
    it('no debe registrar eventos si enabled=false', () => {
      const ctrl = new AdaptiveConcurrencyController(onAdjust, { enabled: false });
      ctrl.recordSuccess('host.com', 1000, 1000);
      ctrl.recordError('host.com', false);
      ctrl.recordThroughputSample(100);

      const status = ctrl.getStatus();
      expect(status.recentSuccessCount).toBe(0);
      expect(status.recentErrorCount).toBe(0);
    });
  });
});
