/**
 * Caché de progreso de chunks in-memory para evitar queries DB frecuentes en el hot-path.
 *
 * El hot-path de progreso (data handler de cada chunk activo) necesita:
 * - Total de bytes descargados de TODOS los chunks de una descarga
 * - Bytes descargados de un chunk específico (idle check)
 * - Si todos los chunks están completados (checkAndMerge)
 * - Array de progreso por chunk para la UI
 *
 * Sin este caché, cada una de esas lecturas ejecuta un SELECT síncrono a SQLite.
 * Con 3 descargas × 4 chunks × 2 updates/s = 24 queries/s innecesarias.
 *
 * La DB sigue siendo la fuente de verdad para persistencia; este caché solo
 * optimiza las lecturas frecuentes durante descargas activas.
 *
 * @module ChunkProgressAggregator
 */

export interface CachedChunkInfo {
  chunkIndex: number;
  startByte: number;
  endByte: number;
  downloadedBytes: number;
  state: string;
  /** Hash SHA-256 del chunk completado. null si aún no calculado. */
  hash: string | null;
}

/**
 * Almacena progreso de chunks en memoria, indexado por downloadId → chunkIndex.
 *
 * Cada entrada registra un timestamp de último acceso. El método
 * `purgeExpired(maxAgeMs)` elimina entradas inactivas más antiguas que el TTL.
 * `init()` invoca purga automática como safety net para prevenir memory leaks
 * sutiles en sesiones largas.
 */
class ChunkProgressAggregator {
  /** Map<downloadId, Map<chunkIndex, CachedChunkInfo>> */
  private _cache = new Map<number, Map<number, CachedChunkInfo>>();

  /** Timestamp de última actividad por downloadId (para TTL). */
  private _lastActivity = new Map<number, number>();

  /** TTL por defecto: 10 minutos sin actividad → entrada expirada. */
  private static readonly DEFAULT_TTL_MS = 10 * 60 * 1000;

  /**
   * Inicializa el caché para una descarga con datos leídos de la DB (una sola vez).
   * Aprovecha para purgar entradas expiradas (safety net).
   */
  init(
    downloadId: number,
    chunks: ReadonlyArray<{
      chunkIndex: number;
      startByte: number;
      endByte: number;
      downloadedBytes?: number;
      state: string;
    }>
  ): void {
    // Purgar entradas expiradas al inicializar una nueva (safety net)
    this.purgeExpired();

    const map = new Map<number, CachedChunkInfo>();
    for (const c of chunks) {
      map.set(c.chunkIndex, {
        chunkIndex: c.chunkIndex,
        startByte: c.startByte,
        endByte: c.endByte,
        downloadedBytes: c.downloadedBytes ?? 0,
        state: c.state,
        hash: null,
      });
    }
    this._cache.set(downloadId, map);
    this._lastActivity.set(downloadId, Date.now());
  }

  /**
   * Actualiza bytes descargados de un chunk (llamado desde el data handler).
   */
  updateBytes(downloadId: number, chunkIndex: number, downloadedBytes: number): void {
    const entry = this._cache.get(downloadId)?.get(chunkIndex);
    if (entry) {
      entry.downloadedBytes = downloadedBytes;
      this._lastActivity.set(downloadId, Date.now());
    }
  }

  /**
   * Actualiza el estado de un chunk (COMPLETED, FAILED, PENDING, etc.).
   */
  updateState(downloadId: number, chunkIndex: number, state: string): void {
    const entry = this._cache.get(downloadId)?.get(chunkIndex);
    if (entry) {
      entry.state = state;
    }
  }

  /**
   * Marca un chunk como completado con sus bytes finales.
   */
  markCompleted(downloadId: number, chunkIndex: number, downloadedBytes: number): void {
    const entry = this._cache.get(downloadId)?.get(chunkIndex);
    if (entry) {
      entry.downloadedBytes = downloadedBytes;
      entry.state = 'completed';
      this._lastActivity.set(downloadId, Date.now());
    }
  }

  /**
   * Resetea un chunk a PENDING con 0 bytes (para retry).
   */
  resetChunk(downloadId: number, chunkIndex: number): void {
    const entry = this._cache.get(downloadId)?.get(chunkIndex);
    if (entry) {
      entry.downloadedBytes = 0;
      entry.state = 'pending';
      entry.hash = null;
    }
  }

  /**
   * Almacena el hash SHA-256 de un chunk completado.
   */
  setChunkHash(downloadId: number, chunkIndex: number, hash: string): void {
    const entry = this._cache.get(downloadId)?.get(chunkIndex);
    if (entry) {
      entry.hash = hash;
    }
  }

  /**
   * Obtiene el hash almacenado de un chunk, o null si no existe.
   */
  getChunkHash(downloadId: number, chunkIndex: number): string | null {
    return this._cache.get(downloadId)?.get(chunkIndex)?.hash ?? null;
  }

  /**
   * Devuelve total de bytes descargados sumando todos los chunks de la descarga.
   */
  getTotalDownloaded(downloadId: number): number {
    const map = this._cache.get(downloadId);
    if (!map) return 0;
    let total = 0;
    for (const entry of map.values()) {
      total += entry.downloadedBytes;
    }
    return total;
  }

  /**
   * Devuelve bytes descargados de un chunk específico, o null si no está en caché.
   */
  getChunkBytes(downloadId: number, chunkIndex: number): number | null {
    return this._cache.get(downloadId)?.get(chunkIndex)?.downloadedBytes ?? null;
  }

  /**
   * Verifica si todos los chunks de una descarga están en estado COMPLETED.
   */
  allCompleted(downloadId: number): boolean {
    const map = this._cache.get(downloadId);
    if (!map || map.size === 0) return false;
    for (const entry of map.values()) {
      if (entry.state !== 'completed') return false;
    }
    return true;
  }

  /**
   * Devuelve la cantidad total de chunks para una descarga.
   */
  getChunkCount(downloadId: number): number {
    return this._cache.get(downloadId)?.size ?? 0;
  }

  /**
   * Devuelve la cantidad de chunks completados.
   */
  getCompletedCount(downloadId: number): number {
    const map = this._cache.get(downloadId);
    if (!map) return 0;
    let count = 0;
    for (const entry of map.values()) {
      if (entry.state === 'completed') count++;
    }
    return count;
  }

  /**
   * Devuelve la cantidad de chunks en estado DOWNLOADING.
   */
  getActiveCount(downloadId: number): number {
    const map = this._cache.get(downloadId);
    if (!map) return 0;
    let count = 0;
    for (const entry of map.values()) {
      if (entry.state === 'downloading') count++;
    }
    return count;
  }

  /**
   * Genera el array de progreso por chunk para emitir a la UI.
   */
  getChunkProgressArray(downloadId: number): Array<{
    index: number;
    progress: number;
    state: string;
    downloadedBytes: number;
    totalBytes: number;
  }> {
    const map = this._cache.get(downloadId);
    if (!map) return [];
    const result: Array<{
      index: number;
      progress: number;
      state: string;
      downloadedBytes: number;
      totalBytes: number;
    }> = [];
    for (const entry of map.values()) {
      const totalBytes = entry.endByte - entry.startByte + 1;
      const progress = totalBytes > 0 ? Math.min(entry.downloadedBytes / totalBytes, 1.0) : 0;
      result.push({
        index: entry.chunkIndex,
        progress,
        state: entry.state,
        downloadedBytes: entry.downloadedBytes,
        totalBytes,
      });
    }
    return result;
  }

  /**
   * Verifica si hay caché para una descarga.
   */
  has(downloadId: number): boolean {
    return this._cache.has(downloadId);
  }

  /**
   * Elimina todo el caché de una descarga (también limpia timestamp).
   */
  clear(downloadId: number): void {
    this._cache.delete(downloadId);
    this._lastActivity.delete(downloadId);
  }

  /**
   * Limpia todo el caché (para close/shutdown).
   */
  clearAll(): void {
    this._cache.clear();
    this._lastActivity.clear();
  }

  // -----------------------------------------------------------------------
  // Expiración y diagnóstico
  // -----------------------------------------------------------------------

  /**
   * Elimina entradas cuya última actividad excede `maxAgeMs`.
   *
   * Llamado automáticamente desde `init()` como safety net. También puede
   * invocarse periódicamente o bajo demanda desde el engine.
   *
   * @param maxAgeMs — Tiempo máximo de inactividad en ms (default: 10 min).
   * @returns Cantidad de entradas eliminadas.
   */
  purgeExpired(maxAgeMs: number = ChunkProgressAggregator.DEFAULT_TTL_MS): number {
    const now = Date.now();
    let purged = 0;
    for (const [downloadId, lastTs] of this._lastActivity) {
      if (now - lastTs > maxAgeMs) {
        this._cache.delete(downloadId);
        this._lastActivity.delete(downloadId);
        purged++;
      }
    }
    return purged;
  }

  /**
   * Devuelve la cantidad de descargas actualmente en caché (diagnóstico).
   */
  get size(): number {
    return this._cache.size;
  }

  /**
   * Devuelve estadísticas del caché para logging/diagnóstico.
   */
  getStats(): { cachedDownloads: number; totalChunks: number; oldestActivityMs: number | null } {
    let totalChunks = 0;
    let oldestTs: number | null = null;
    for (const [, map] of this._cache) {
      totalChunks += map.size;
    }
    for (const [, ts] of this._lastActivity) {
      if (oldestTs === null || ts < oldestTs) oldestTs = ts;
    }
    return {
      cachedDownloads: this._cache.size,
      totalChunks,
      oldestActivityMs: oldestTs !== null ? Date.now() - oldestTs : null,
    };
  }
}

/** Instancia singleton del agregador de progreso de chunks. */
const chunkProgressAggregator = new ChunkProgressAggregator();
export default chunkProgressAggregator;
export { ChunkProgressAggregator };
