/**
 * Tests unitarios para electron/engines/AdaptiveChunkSizer.ts
 *
 * Cubre: selectSpeedBand, calculateAdaptiveChunks, integración con calculateChunks,
 * casos límite (sin velocidad, muestras insuficientes, deshabilitado).
 */
import {
  selectSpeedBand,
  calculateAdaptiveChunks,
  DEFAULT_SPEED_BANDS,
  DEFAULT_CONFIG,
} from '../../electron/engines/AdaptiveChunkSizer';
import type {
  AdaptiveChunkSizerConfig,
  SpeedBand,
} from '../../electron/engines/AdaptiveChunkSizer';

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe('AdaptiveChunkSizer', () => {
  // -----------------------------------------------------------------------
  // selectSpeedBand
  // -----------------------------------------------------------------------
  describe('selectSpeedBand', () => {
    it('debe seleccionar banda "muy lenta" para velocidades < 512 KB/s', () => {
      const band = selectSpeedBand(256 * 1024);
      expect(band.label).toContain('muy lenta');
      expect(band.chunkSizeTarget).toBe(4 * MB);
    });

    it('debe seleccionar banda "lenta" para 512 KB/s – 2 MB/s', () => {
      const band = selectSpeedBand(1 * MB);
      expect(band.label).toContain('lenta');
      expect(band.chunkSizeTarget).toBe(8 * MB);
    });

    it('debe seleccionar banda "media" para 2 – 10 MB/s', () => {
      const band = selectSpeedBand(5 * MB);
      expect(band.label).toContain('media');
      expect(band.chunkSizeTarget).toBe(16 * MB);
    });

    it('debe seleccionar banda "rápida" para 10 – 50 MB/s', () => {
      const band = selectSpeedBand(25 * MB);
      expect(band.label).toContain('rápida');
      expect(band.chunkSizeTarget).toBe(32 * MB);
    });

    it('debe seleccionar banda "muy rápida" para > 50 MB/s', () => {
      const band = selectSpeedBand(100 * MB);
      expect(band.label).toContain('muy rápida');
      expect(band.chunkSizeTarget).toBe(64 * MB);
    });

    it('debe seleccionar el límite exacto de una banda (inclusivo)', () => {
      // 512 KB/s exacto → pertenece a la banda "muy lenta"
      const band = selectSpeedBand(512 * 1024);
      expect(band.label).toContain('muy lenta');
    });

    it('debe funcionar con bandas personalizadas', () => {
      const customBands: SpeedBand[] = [
        { maxSpeedBps: 1000, chunkSizeTarget: 1 * MB, label: 'custom-slow' },
        { maxSpeedBps: Infinity, chunkSizeTarget: 50 * MB, label: 'custom-fast' },
      ];
      expect(selectSpeedBand(500, customBands).label).toBe('custom-slow');
      expect(selectSpeedBand(2000, customBands).label).toBe('custom-fast');
    });

    it('debe retornar última banda si ninguna matchea (safety)', () => {
      // Bandas sin Infinity: todas las velocidades > max caen a la última
      const limitedBands: SpeedBand[] = [
        { maxSpeedBps: 100, chunkSizeTarget: 1 * MB, label: 'only' },
      ];
      const band = selectSpeedBand(999999, limitedBands);
      expect(band.label).toBe('only');
    });
  });

  // -----------------------------------------------------------------------
  // calculateAdaptiveChunks — casos exitosos
  // -----------------------------------------------------------------------
  describe('calculateAdaptiveChunks — sizing adaptativo', () => {
    it('debe generar chunks pequeños para conexión lenta', () => {
      // 200 MB de archivo, velocidad 300 KB/s → banda "muy lenta" → target 4 MB
      const result = calculateAdaptiveChunks(200 * MB, 300 * 1024, 5);
      expect(result).not.toBeNull();
      expect(result!.bandLabel).toContain('muy lenta');
      // 200 MB / 4 MB = 50 chunks, clampado a maxChunks=16
      expect(result!.ranges).toHaveLength(16);
      // Verificar cobertura total
      expect(result!.ranges[0].start).toBe(0);
      expect(result!.ranges[result!.ranges.length - 1].end).toBe(200 * MB - 1);
    });

    it('debe generar chunks grandes para conexión rápida', () => {
      // 500 MB de archivo, velocidad 60 MB/s → banda "muy rápida" → target 64 MB
      const result = calculateAdaptiveChunks(500 * MB, 60 * MB, 5);
      expect(result).not.toBeNull();
      expect(result!.bandLabel).toContain('muy rápida');
      // 500 MB / 64 MB ≈ 8 chunks
      expect(result!.ranges.length).toBeLessThanOrEqual(16);
      expect(result!.ranges.length).toBeGreaterThanOrEqual(2);
    });

    it('debe generar chunks medianos para velocidad media', () => {
      // 300 MB, 5 MB/s → banda "media" → target 16 MB
      const result = calculateAdaptiveChunks(300 * MB, 5 * MB, 3);
      expect(result).not.toBeNull();
      expect(result!.bandLabel).toContain('media');
      // 300 MB / 16 MB ≈ 19 → clampado a maxChunks(16)
      expect(result!.ranges).toHaveLength(16);
    });

    it('debe respetar maxChunks', () => {
      // Con maxChunks=4
      const result = calculateAdaptiveChunks(1 * GB, 300 * 1024, 5, 4);
      expect(result).not.toBeNull();
      expect(result!.ranges.length).toBeLessThanOrEqual(4);
    });

    it('debe respetar minChunks', () => {
      // Archivo grande con velocidad muy rápida → pocos chunks, pero mín 3
      const result = calculateAdaptiveChunks(100 * MB, 100 * MB, 5, 16, 3);
      expect(result).not.toBeNull();
      expect(result!.ranges.length).toBeGreaterThanOrEqual(3);
    });

    it('debe cubrir exactamente el archivo sin gaps ni overlaps', () => {
      const totalBytes = 157 * MB + 12345; // tamaño no redondo
      const result = calculateAdaptiveChunks(totalBytes, 5 * MB, 3);
      expect(result).not.toBeNull();
      const ranges = result!.ranges;

      // Primer chunk empieza en 0
      expect(ranges[0].start).toBe(0);
      // Último chunk termina en totalBytes-1
      expect(ranges[ranges.length - 1].end).toBe(totalBytes - 1);

      // Sin gaps: cada start === anterior.end + 1
      for (let i = 1; i < ranges.length; i++) {
        expect(ranges[i].start).toBe(ranges[i - 1].end + 1);
      }

      // Suma de bytes === totalBytes
      const totalCovered = ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
      expect(totalCovered).toBe(totalBytes);
    });

    it('debe incluir measuredSpeedBps en el resultado', () => {
      const result = calculateAdaptiveChunks(200 * MB, 3 * MB, 5);
      expect(result).not.toBeNull();
      expect(result!.measuredSpeedBps).toBe(3 * MB);
    });
  });

  // -----------------------------------------------------------------------
  // calculateAdaptiveChunks — fallback a null
  // -----------------------------------------------------------------------
  describe('calculateAdaptiveChunks — fallback (retorna null)', () => {
    it('debe retornar null si está deshabilitado', () => {
      const cfg: AdaptiveChunkSizerConfig = { ...DEFAULT_CONFIG, enabled: false };
      const result = calculateAdaptiveChunks(200 * MB, 5 * MB, 5, 16, 2, cfg);
      expect(result).toBeNull();
    });

    it('debe retornar null si velocidad es null', () => {
      const result = calculateAdaptiveChunks(200 * MB, null, 5);
      expect(result).toBeNull();
    });

    it('debe retornar null si velocidad es undefined', () => {
      const result = calculateAdaptiveChunks(200 * MB, undefined, 5);
      expect(result).toBeNull();
    });

    it('debe retornar null si velocidad es 0', () => {
      const result = calculateAdaptiveChunks(200 * MB, 0, 5);
      expect(result).toBeNull();
    });

    it('debe retornar null si velocidad es negativa', () => {
      const result = calculateAdaptiveChunks(200 * MB, -100, 5);
      expect(result).toBeNull();
    });

    it('debe retornar null si muestras son insuficientes', () => {
      // Default minSamples=2, pasamos 1
      const result = calculateAdaptiveChunks(200 * MB, 5 * MB, 1);
      expect(result).toBeNull();
    });

    it('debe retornar null si muestras son 0', () => {
      const result = calculateAdaptiveChunks(200 * MB, 5 * MB, 0);
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // calculateAdaptiveChunks — configuración personalizada
  // -----------------------------------------------------------------------
  describe('calculateAdaptiveChunks — config personalizada', () => {
    it('debe respetar minChunkSize de la config', () => {
      const cfg: AdaptiveChunkSizerConfig = {
        ...DEFAULT_CONFIG,
        minChunkSize: 32 * MB, // forzar mínimo alto
        speedBands: [
          // Banda que normalmente daría 4 MB
          { maxSpeedBps: Infinity, chunkSizeTarget: 2 * MB, label: 'test' },
        ],
      };
      const result = calculateAdaptiveChunks(200 * MB, 100 * 1024, 5, 16, 2, cfg);
      expect(result).not.toBeNull();
      // El target (2 MB) se clampa a minChunkSize (32 MB)
      // 200 MB / 32 MB ≈ 7 chunks
      expect(result!.ranges.length).toBeLessThanOrEqual(7);
    });

    it('debe respetar maxChunkSize de la config', () => {
      const cfg: AdaptiveChunkSizerConfig = {
        ...DEFAULT_CONFIG,
        maxChunkSize: 8 * MB, // forzar máximo bajo
        speedBands: [
          // Banda que daría 64 MB
          { maxSpeedBps: Infinity, chunkSizeTarget: 64 * MB, label: 'fast' },
        ],
      };
      const result = calculateAdaptiveChunks(200 * MB, 100 * MB, 5, 16, 2, cfg);
      expect(result).not.toBeNull();
      // El target se clampa a 8 MB → 200/8 = 25 → clampado a maxChunks=16
      expect(result!.ranges).toHaveLength(16);
    });

    it('debe respetar minSamples personalizado', () => {
      const cfg: AdaptiveChunkSizerConfig = { ...DEFAULT_CONFIG, minSamples: 10 };
      // 5 muestras < 10 mínimas → null
      const result = calculateAdaptiveChunks(200 * MB, 5 * MB, 5, 16, 2, cfg);
      expect(result).toBeNull();

      // 10 muestras ≥ 10 → ok
      const result2 = calculateAdaptiveChunks(200 * MB, 5 * MB, 10, 16, 2, cfg);
      expect(result2).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Escenarios de velocidad extrema
  // -----------------------------------------------------------------------
  describe('escenarios extremos', () => {
    it('debe manejar archivo de 1 GB con conexión muy lenta', () => {
      const result = calculateAdaptiveChunks(1 * GB, 100 * 1024, 5);
      expect(result).not.toBeNull();
      // 1 GB / 4 MB = 256 → clampado a 16 chunks
      expect(result!.ranges).toHaveLength(16);
      expect(result!.bandLabel).toContain('muy lenta');
    });

    it('debe manejar archivo de 50 MB con conexión muy rápida', () => {
      // Justo en el umbral, debería generar pocos chunks grandes
      const totalBytes = 55 * MB; // justo sobre 50 MB threshold
      const result = calculateAdaptiveChunks(totalBytes, 100 * MB, 5);
      expect(result).not.toBeNull();
      // 55 MB / 64 MB = 1 → clampado a minChunks=2
      expect(result!.ranges.length).toBeGreaterThanOrEqual(2);
    });

    it('debe manejar archivo de 10 GB', () => {
      const totalBytes = 10 * GB;
      const result = calculateAdaptiveChunks(totalBytes, 20 * MB, 3);
      expect(result).not.toBeNull();
      // 10 GB / 32 MB = 320 → clampado a 16
      expect(result!.ranges).toHaveLength(16);
      expect(result!.bandLabel).toContain('rápida');
    });

    it('debe manejar velocidad en el límite exacto de una banda', () => {
      // 2 MB/s es el límite de "lenta" (512 KB - 2 MB/s)
      const result = calculateAdaptiveChunks(200 * MB, 2 * MB, 5);
      expect(result).not.toBeNull();
      expect(result!.bandLabel).toContain('lenta');
    });
  });

  // -----------------------------------------------------------------------
  // DEFAULT_SPEED_BANDS y DEFAULT_CONFIG
  // -----------------------------------------------------------------------
  describe('defaults', () => {
    it('DEFAULT_SPEED_BANDS debe tener 5 bandas ordenadas', () => {
      expect(DEFAULT_SPEED_BANDS).toHaveLength(5);
      // Verificar orden ascendente
      for (let i = 1; i < DEFAULT_SPEED_BANDS.length; i++) {
        expect(DEFAULT_SPEED_BANDS[i].maxSpeedBps).toBeGreaterThan(
          DEFAULT_SPEED_BANDS[i - 1].maxSpeedBps
        );
      }
      // Última banda debe ser Infinity
      expect(DEFAULT_SPEED_BANDS[DEFAULT_SPEED_BANDS.length - 1].maxSpeedBps).toBe(Infinity);
    });

    it('DEFAULT_CONFIG debe tener valores razonables', () => {
      expect(DEFAULT_CONFIG.enabled).toBe(true);
      expect(DEFAULT_CONFIG.minSamples).toBeGreaterThanOrEqual(1);
      expect(DEFAULT_CONFIG.minChunkSize).toBeGreaterThan(0);
      expect(DEFAULT_CONFIG.maxChunkSize).toBeGreaterThan(DEFAULT_CONFIG.minChunkSize);
    });
  });
});
