/**
 * Tamaño de chunks adaptativo según velocidad de red medida.
 *
 * En vez de usar tamaños fijos por banda de tamaño de archivo, ajusta el tamaño
 * de chunk según el throughput real medido en la sesión:
 *
 * - **Conexiones lentas** → chunks más pequeños → mejor granularidad de retry,
 *   menos trabajo desperdiciado ante fallos.
 * - **Conexiones rápidas** → chunks más grandes → menos overhead de HTTP requests,
 *   menos conexiones paralelas necesarias.
 *
 * La velocidad se obtiene de `DownloadMetrics.getHostMetrics(host).avgSpeedBps`,
 * que acumula datos de descargas completadas durante la sesión. La primera descarga
 * a un host sin datos previos usa el sizing estático existente (fallback seguro).
 *
 * @module AdaptiveChunkSizer
 */

import { logger } from '../utils';

const log = logger.child('AdaptiveChunkSizer');

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export interface SpeedBand {
  /** Velocidad máxima (bytes/s) para esta banda (inclusive). */
  maxSpeedBps: number;
  /** Tamaño de chunk objetivo (bytes) para esta velocidad. */
  chunkSizeTarget: number;
  /** Etiqueta legible para logs. */
  label: string;
}

export interface AdaptiveChunkSizerConfig {
  /** Habilitar sizing adaptativo. false → se usa siempre el sizing estático. */
  enabled: boolean;
  /**
   * Cantidad mínima de descargas completadas a un host antes de confiar en
   * la velocidad medida. Evita decisiones basadas en muestras insuficientes.
   */
  minSamples: number;
  /** Bandas de velocidad → tamaño de chunk. Debe estar ordenado por maxSpeedBps ASC. */
  speedBands: SpeedBand[];
  /** Tamaño mínimo de chunk (bytes). Protege contra chunks demasiado pequeños. */
  minChunkSize: number;
  /** Tamaño máximo de chunk (bytes). Protege contra chunks demasiado grandes. */
  maxChunkSize: number;
}

export interface ChunkLayout {
  /** Rangos byte start/end para cada chunk. */
  ranges: Array<{ start: number; end: number }>;
  /** Tamaño de chunk objetivo usado. */
  chunkSizeUsed: number;
  /** Etiqueta de la banda de velocidad seleccionada. */
  bandLabel: string;
  /** Velocidad medida que se usó para la decisión (bytes/s). */
  measuredSpeedBps: number;
}

// ---------------------------------------------------------------------------
// Constantes por defecto
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

/**
 * Bandas de velocidad por defecto.
 *
 * Lógica: a menor velocidad, chunks más pequeños para limitar el costo de
 * un retry fallido. A mayor velocidad, chunks grandes para reducir overhead.
 */
export const DEFAULT_SPEED_BANDS: ReadonlyArray<SpeedBand> = [
  { maxSpeedBps: 512 * 1024, chunkSizeTarget: 4 * MB, label: 'muy lenta (<512 KB/s)' },
  { maxSpeedBps: 2 * MB, chunkSizeTarget: 8 * MB, label: 'lenta (512 KB–2 MB/s)' },
  { maxSpeedBps: 10 * MB, chunkSizeTarget: 16 * MB, label: 'media (2–10 MB/s)' },
  { maxSpeedBps: 50 * MB, chunkSizeTarget: 32 * MB, label: 'rápida (10–50 MB/s)' },
  { maxSpeedBps: Infinity, chunkSizeTarget: 64 * MB, label: 'muy rápida (>50 MB/s)' },
];

export const DEFAULT_CONFIG: AdaptiveChunkSizerConfig = {
  enabled: true,
  minSamples: 2,
  speedBands: DEFAULT_SPEED_BANDS as SpeedBand[],
  minChunkSize: 4 * MB,
  maxChunkSize: 128 * MB,
};

// ---------------------------------------------------------------------------
// Lógica principal
// ---------------------------------------------------------------------------

/**
 * Selecciona la banda de velocidad correspondiente al throughput medido.
 *
 * @param speedBps  — Velocidad medida en bytes/segundo.
 * @param bands     — Bandas ordenadas por maxSpeedBps ASC.
 * @returns La banda seleccionada, o la última si ninguna matchea.
 */
export function selectSpeedBand(
  speedBps: number,
  bands: ReadonlyArray<SpeedBand> = DEFAULT_SPEED_BANDS
): SpeedBand {
  for (const band of bands) {
    if (speedBps <= band.maxSpeedBps) return band;
  }
  // Safety: retornar la última banda
  return bands[bands.length - 1];
}

/**
 * Calcula un layout de chunks adaptativo basado en velocidad medida.
 *
 * Retorna `null` si:
 * - Adaptive sizing está deshabilitado.
 * - No hay velocidad medida (`measuredSpeedBps` es null/undefined/0).
 * - Las muestras son insuficientes (`completedSamples < minSamples`).
 *
 * En esos casos, el caller debe caer al sizing estático existente.
 *
 * @param totalBytes         — Tamaño total del archivo.
 * @param measuredSpeedBps   — Velocidad promedio medida (bytes/s), o null.
 * @param completedSamples   — Número de descargas completadas para el host.
 * @param maxChunks          — Máximo de chunks permitidos.
 * @param minChunks          — Mínimo de chunks.
 * @param cfg                — Configuración (default: DEFAULT_CONFIG).
 * @returns Layout adaptativo o null (usar sizing estático).
 */
export function calculateAdaptiveChunks(
  totalBytes: number,
  measuredSpeedBps: number | null | undefined,
  completedSamples: number,
  maxChunks: number = 16,
  minChunks: number = 2,
  cfg: AdaptiveChunkSizerConfig = DEFAULT_CONFIG
): ChunkLayout | null {
  if (!cfg.enabled) return null;
  if (measuredSpeedBps == null || measuredSpeedBps <= 0) return null;
  if (completedSamples < cfg.minSamples) {
    log.debug(
      `[AdaptiveChunkSizer] Muestras insuficientes (${completedSamples}/${cfg.minSamples}), usando sizing estático`
    );
    return null;
  }

  const band = selectSpeedBand(measuredSpeedBps, cfg.speedBands);

  // Clampar el target al rango permitido
  let targetSize = Math.max(cfg.minChunkSize, Math.min(cfg.maxChunkSize, band.chunkSizeTarget));

  // Calcular número de chunks
  let numChunks = Math.ceil(totalBytes / targetSize);
  numChunks = Math.max(minChunks, Math.min(maxChunks, numChunks));

  // Recalcular tamaño real de chunk basado en el número final
  const actualChunkSize = Math.ceil(totalBytes / numChunks);

  // Generar rangos
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < numChunks; i++) {
    const start = i * actualChunkSize;
    const end =
      i === numChunks - 1
        ? totalBytes - 1
        : Math.min((i + 1) * actualChunkSize - 1, totalBytes - 1);
    ranges.push({ start, end });
  }

  log.info(
    `[AdaptiveChunkSizer] ${formatBytes(totalBytes)} → ${numChunks} chunks de ~${formatBytes(actualChunkSize)} ` +
      `(banda: ${band.label}, velocidad medida: ${formatSpeed(measuredSpeedBps)}, ` +
      `muestras: ${completedSamples})`
  );

  return {
    ranges,
    chunkSizeUsed: actualChunkSize,
    bandLabel: band.label,
    measuredSpeedBps,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes === Infinity) return '∞';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}
