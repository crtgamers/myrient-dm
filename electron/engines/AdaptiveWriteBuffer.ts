/**
 * Buffer de escritura adaptativo según velocidad de descarga.
 *
 * Calcula el highWaterMark recomendado para WriteStreams en función de la
 * velocidad medida por host (DownloadMetrics). Conexiones lentas → buffer menor
 * (menos memoria); conexiones rápidas → buffer mayor (menos backpressure).
 *
 * @module AdaptiveWriteBuffer
 */

import config from '../config';
import downloadMetrics from './DownloadMetrics';

type DownloadsConfig = {
  adaptiveBufferSize?: boolean;
  adaptiveWriteBuffer?: {
    enabled?: boolean;
    speedBands?: Array<{ maxSpeedBps: number; bufferSize: number }>;
  };
  writeBufferSize?: number;
  minWriteBufferSize?: number;
  maxWriteBufferSize?: number;
  chunked?: { chunkWriteBufferSize?: number };
};

/**
 * Devuelve el highWaterMark recomendado para un WriteStream según la velocidad
 * del host (si está disponible) y la configuración de bands. Si el buffer
 * adaptativo está deshabilitado o no hay métricas, devuelve el valor por defecto.
 *
 * @param host - Hostname de la URL (o null si no aplica).
 * @param options - forChunk: true para descargas chunked (usa default de chunk).
 * @returns Tamaño del buffer en bytes, dentro de [minWriteBufferSize, maxWriteBufferSize].
 */
export function getRecommendedWriteBufferSize(
  host: string | null,
  options?: { forChunk?: boolean }
): number {
  const downloads = config.downloads as DownloadsConfig;
  const adaptive = downloads.adaptiveWriteBuffer;
  const enabled =
    downloads.adaptiveBufferSize &&
    adaptive?.enabled !== false &&
    Array.isArray(adaptive?.speedBands) &&
    adaptive.speedBands.length > 0;

  const defaultSize = options?.forChunk
    ? (downloads.chunked?.chunkWriteBufferSize ?? 1024 * 1024)
    : (downloads.writeBufferSize ?? 1024 * 1024);
  const minSize = downloads.minWriteBufferSize ?? 256 * 1024;
  const maxSize = downloads.maxWriteBufferSize ?? 16 * 1024 * 1024;

  if (!enabled || !host) {
    return Math.max(minSize, Math.min(maxSize, defaultSize));
  }

  const speedBps = host != null ? (downloadMetrics.getHostMetrics(host)?.avgSpeedBps ?? 0) : 0;
  const bands = adaptive.speedBands!;
  let chosen = defaultSize;
  for (const band of bands) {
    if (speedBps <= band.maxSpeedBps) {
      chosen = band.bufferSize;
      break;
    }
  }
  return Math.max(minSize, Math.min(maxSize, chosen));
}
