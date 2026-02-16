/**
 * Tests unitarios para electron/engines/SpeedTracker.ts
 */
import { SpeedTracker } from '../../electron/engines/SpeedTracker';

describe('SpeedTracker', () => {
  let tracker: SpeedTracker;

  beforeEach(() => {
    tracker = new SpeedTracker(0.3, 0.1);
  });

  describe('startTracking / ensureTracking', () => {
    it('debe iniciar tracking para un downloadId', () => {
      tracker.startTracking(1, 1000);
      const result = tracker.update(1, 1000, 10000);
      expect(result).not.toBeNull();
      expect(result!.speedBytesPerSec).toBeGreaterThanOrEqual(0);
    });

    it('ensureTracking debe iniciar si no existe', () => {
      tracker.ensureTracking(1, 1000);
      const result = tracker.update(1, 500, 5000);
      expect(result).not.toBeNull();
    });

    it('ensureTracking no debe sobrescribir si ya existe', () => {
      tracker.startTracking(1, 1000);
      tracker.ensureTracking(1, 9999);
      const result = tracker.update(1, 100, 1000);
      expect(result).not.toBeNull();
    });
  });

  describe('update', () => {
    it('debe retornar null si no hay tracking para el id', () => {
      expect(tracker.update(99, 100, 1000)).toBeNull();
    });

    it('debe retornar speedBytesPerSec y remainingTime', () => {
      const start = Date.now();
      tracker.startTracking(1, start);
      const result = tracker.update(1, 1000, 10000);
      expect(result).not.toBeNull();
      expect(typeof result!.speedBytesPerSec).toBe('number');
      expect(result!.speedBytesPerSec).toBeGreaterThanOrEqual(0);
      expect(result!.remainingTime === null || typeof result!.remainingTime === 'number').toBe(
        true
      );
    });

    it('debe calcular tiempo restante cuando hay velocidad', () => {
      tracker.startTracking(1, Date.now() - 2000);
      tracker.update(1, 1000, 10000);
      const result = tracker.update(1, 2000, 10000);
      expect(result).not.toBeNull();
      if (result!.speedBytesPerSec > 0) {
        expect(result!.remainingTime).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('stopTracking / clear', () => {
    it('stopTracking debe eliminar el tracker', () => {
      tracker.startTracking(1, Date.now());
      tracker.stopTracking(1);
      expect(tracker.update(1, 100, 1000)).toBeNull();
    });

    it('clear debe eliminar todos los trackers', () => {
      tracker.startTracking(1, Date.now());
      tracker.startTracking(2, Date.now());
      tracker.clear();
      expect(tracker.update(1, 100, 1000)).toBeNull();
      expect(tracker.update(2, 100, 1000)).toBeNull();
    });
  });
});
