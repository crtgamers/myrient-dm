/**
 * Controlador de concurrencia con semáforos explícitos (slots global y por-download).
 *
 * Centraliza los límites de descargas activas (global) y de chunks en vuelo
 * por descarga. El engine y ChunkDownloader usan acquire/release en lugar de
 * conteos manuales dispersos.
 *
 * @module ConcurrencyController
 */

export interface ConcurrencyControllerOptions {
  /** Máximo de descargas activas (starting/downloading/merging/verifying) a la vez. */
  maxConcurrent?: number;
  /** Máximo de chunks en vuelo por descarga fragmentada. */
  maxChunkSlotsPerDownload?: number;
}

/**
 * Semáforos para límites globales y por-download (chunks).
 */
export class ConcurrencyController {
  private _maxConcurrent: number;
  private _maxChunkSlotsPerDownload: number;
  private _globalActive = 0;
  private _chunkSlotsByDownload = new Map<number, number>();

  constructor(options: ConcurrencyControllerOptions = {}) {
    this._maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
    this._maxChunkSlotsPerDownload = Math.min(
      16,
      Math.max(1, options.maxChunkSlotsPerDownload ?? 4)
    );
  }

  /** Intenta adquirir un slot global. Devuelve true si se adquirió, false si ya se alcanzó el límite. */
  acquireGlobalSlot(): boolean {
    if (this._globalActive >= this._maxConcurrent) return false;
    this._globalActive++;
    return true;
  }

  /** Libera un slot global. Idempotente (no baja de 0). */
  releaseGlobalSlot(): void {
    if (this._globalActive > 0) this._globalActive--;
  }

  /** Número de slots globales actualmente en uso. */
  getGlobalActiveCount(): number {
    return this._globalActive;
  }

  /** Número de slots globales disponibles sin adquirir. */
  getAvailableGlobalSlots(): number {
    return Math.max(0, this._maxConcurrent - this._globalActive);
  }

  /**
   * Intenta adquirir un slot de chunk para la descarga downloadId.
   * Devuelve true si se adquirió, false si ya se alcanzó el límite para esa descarga.
   */
  acquireChunkSlot(downloadId: number): boolean {
    const cur = this._chunkSlotsByDownload.get(downloadId) ?? 0;
    if (cur >= this._maxChunkSlotsPerDownload) return false;
    this._chunkSlotsByDownload.set(downloadId, cur + 1);
    return true;
  }

  /** Libera un slot de chunk para la descarga downloadId. Idempotente. */
  releaseChunkSlot(downloadId: number): void {
    const cur = this._chunkSlotsByDownload.get(downloadId) ?? 0;
    if (cur > 0) {
      const next = cur - 1;
      if (next === 0) this._chunkSlotsByDownload.delete(downloadId);
      else this._chunkSlotsByDownload.set(downloadId, next);
    }
  }

  /** Chunks en vuelo para una descarga (solo diagnóstico). */
  getChunkActiveCount(downloadId: number): number {
    return this._chunkSlotsByDownload.get(downloadId) ?? 0;
  }

  /** Actualiza el máximo de descargas concurrentes (p. ej. desde AdaptiveConcurrency o usuario). */
  setMaxConcurrent(value: number): void {
    this._maxConcurrent = Math.max(1, value);
  }

  get maxConcurrent(): number {
    return this._maxConcurrent;
  }

  get maxChunkSlotsPerDownload(): number {
    return this._maxChunkSlotsPerDownload;
  }

  /** Actualiza el máximo de chunks por descarga (p. ej. desde preferencias de usuario). */
  setMaxChunkSlotsPerDownload(value: number): void {
    this._maxChunkSlotsPerDownload = Math.min(16, Math.max(1, value));
  }
}
