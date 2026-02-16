/**
 * Planificador de la cola: decide cuántas descargas pueden estar activas y cuáles arrancar.
 *
 * Respeta maxConcurrent (global), maxConcurrentPerHost y rate limit por host. Ordena la cola
 * por prioridad efectiva (aging, SJF opcional, penalización por reintentos) y selecciona
 * candidatos con selectDownloadsToStart. registerDownload/unregisterDownload mantienen
 * el conteo por host para canStartDownload.
 *
 * @module Scheduler
 */

import { logger } from '../utils';
import { RateLimiter } from '../utils/rateLimiter';
import config from '../config';

const _log = logger.child('Scheduler');

interface QueueOrderingConfig {
  agingEnabled?: boolean;
  agingIntervalMs?: number;
  maxAgingBonus?: number;
  lowPriorityAgingMultiplier?: number;
  sjfEnabled?: boolean;
  sjfWeight?: number;
  sjfTolerancePercent?: number;
  sjfDefaultSizeBytes?: number;
  retryPenaltyEnabled?: boolean;
  retryPenaltyPerRetry?: number;
  maxRetryPenalty?: number;
  retryPenaltyFreeRetries?: number;
}

interface DownloadLike {
  id?: number;
  url?: string | null;
  priority?: number;
  created_at?: number;
  createdAt?: number;
  total_bytes?: number;
  totalBytes?: number;
  retry_count?: number;
  retryCount?: number;
}

/** Resultado de canStartDownload: si hay slot, motivo de denegación o límite por host/rate. */
export interface CanStartResult {
  canStart: boolean;
  reason?: string;
  slotsAvailable?: number;
  hostLimit?: boolean;
  rateLimited?: boolean;
}

export default class Scheduler {
  private _maxConcurrent: number;
  private maxConcurrentPerHost: number;

  get maxConcurrent(): number {
    return this._maxConcurrent;
  }
  private hostRateLimiters = new Map<string, RateLimiter>();
  private activeByHost = new Map<string, Set<number>>();
  private roundRobinIndex = 0;

  private agingEnabled: boolean;
  private agingIntervalMs: number;
  private maxAgingBonus: number;
  private lowPriorityAgingMultiplier: number;
  private sjfEnabled: boolean;
  private sjfWeight: number;
  private sjfTolerancePercent: number;
  private sjfDefaultSizeBytes: number;
  private retryPenaltyEnabled: boolean;
  private retryPenaltyPerRetry: number;
  private maxRetryPenalty: number;
  private retryPenaltyFreeRetries: number;
  private _turboMode = false;

  constructor() {
    const downloadsConfig = config.downloads as
      | {
          maxConcurrent?: number;
          maxConcurrentPerHost?: number;
          queueOrdering?: QueueOrderingConfig;
        }
      | undefined;
    this._maxConcurrent = downloadsConfig?.maxConcurrent ?? 2;
    this.maxConcurrentPerHost = downloadsConfig?.maxConcurrentPerHost ?? 2;

    const orderingConfig: QueueOrderingConfig = downloadsConfig?.queueOrdering ?? {};
    this.agingEnabled = orderingConfig.agingEnabled ?? true;
    this.agingIntervalMs = orderingConfig.agingIntervalMs ?? 30 * 60 * 1000;
    this.maxAgingBonus = orderingConfig.maxAgingBonus ?? 2;
    this.lowPriorityAgingMultiplier = orderingConfig.lowPriorityAgingMultiplier ?? 1.5;
    this.sjfEnabled = orderingConfig.sjfEnabled ?? true;
    this.sjfWeight = orderingConfig.sjfWeight ?? 0.7;
    this.sjfTolerancePercent = orderingConfig.sjfTolerancePercent ?? 10;
    this.sjfDefaultSizeBytes = orderingConfig.sjfDefaultSizeBytes ?? 100 * 1024 * 1024;
    this.retryPenaltyEnabled = orderingConfig.retryPenaltyEnabled ?? true;
    this.retryPenaltyPerRetry = orderingConfig.retryPenaltyPerRetry ?? 0.5;
    this.maxRetryPenalty = orderingConfig.maxRetryPenalty ?? 1.5;
    this.retryPenaltyFreeRetries = orderingConfig.retryPenaltyFreeRetries ?? 1;
  }

  getEffectiveSize(download: DownloadLike): number {
    const size = download.total_bytes ?? download.totalBytes ?? 0;
    return size > 0 ? size : this.sjfDefaultSizeBytes;
  }

  compareSizes(sizeA: number, sizeB: number): number {
    if (!this.sjfEnabled) return 0;
    const maxSize = Math.max(sizeA, sizeB);
    if (maxSize === 0) return 0;
    const diffPercent = (Math.abs(sizeA - sizeB) / maxSize) * 100;
    if (diffPercent <= this.sjfTolerancePercent) return 0;
    return sizeA - sizeB;
  }

  calculateEffectivePriority(download: DownloadLike, now: number): number {
    const basePriority = download.priority ?? 1;
    let effectivePriority = basePriority;

    if (this.agingEnabled) {
      const createdAt = download.created_at ?? download.createdAt ?? now;
      const timeInQueue = now - createdAt;
      if (timeInQueue > 0) {
        const agingIntervals = timeInQueue / this.agingIntervalMs;
        const multiplier = basePriority === 0 ? this.lowPriorityAgingMultiplier : 1.0;
        const agingBonus = Math.min(agingIntervals * multiplier, this.maxAgingBonus);
        effectivePriority += agingBonus;
      }
    }

    if (this.retryPenaltyEnabled) {
      const retryCount = download.retry_count ?? download.retryCount ?? 0;
      const penalizableRetries = Math.max(0, retryCount - this.retryPenaltyFreeRetries);
      if (penalizableRetries > 0) {
        const retryPenalty = Math.min(
          penalizableRetries * this.retryPenaltyPerRetry,
          this.maxRetryPenalty
        );
        effectivePriority -= retryPenalty;
      }
    }

    return effectivePriority;
  }

  /** Actualiza el límite global de descargas simultáneas (clamped 1–3). */
  setMaxConcurrent(n: number): void {
    const clamped = Math.min(3, Math.max(1, Number(n) || 2));
    this._maxConcurrent = clamped;
    _log.info(`Scheduler: maxConcurrent actualizado a ${this._maxConcurrent}`);
  }

  /** Actualiza el límite de descargas simultáneas por host (clamped 1–maxConcurrent). */
  setMaxConcurrentPerHost(n: number): void {
    const clamped = Math.min(this._maxConcurrent, Math.max(1, Number(n) || 2));
    this.maxConcurrentPerHost = clamped;
    _log.info(`Scheduler: maxConcurrentPerHost actualizado a ${this.maxConcurrentPerHost}`);
  }

  /** Modo Turbo: una sola descarga activa, sin rate limit por host. */
  setTurboMode(enabled: boolean): void {
    this._turboMode = enabled;
    _log.info(`Scheduler: modo Turbo ${enabled ? 'activado' : 'desactivado'}`);
  }

  /** Getter público del límite actual por host. */
  getMaxConcurrentPerHost(): number {
    return this.maxConcurrentPerHost;
  }

  canStartDownload(currentActiveCount: number, host: string | null = null): CanStartResult {
    if (currentActiveCount >= this._maxConcurrent) {
      return {
        canStart: false,
        reason: 'Límite global de descargas alcanzado',
        slotsAvailable: 0,
      };
    }

    if (host) {
      const activeForHost = this.activeByHost.get(host)?.size ?? 0;
      if (activeForHost >= this.maxConcurrentPerHost) {
        return {
          canStart: false,
          reason: `Límite de descargas por host alcanzado para ${host}`,
          slotsAvailable: 0,
          hostLimit: true,
        };
      }

      if (!this._turboMode) {
        const rateLimiter = this.getRateLimiter(host);
        if (!rateLimiter.isAllowed(host)) {
          return {
            canStart: false,
            reason: `Rate limit alcanzado para ${host}`,
            slotsAvailable: 0,
            rateLimited: true,
          };
        }
      }
    }

    const slotsAvailable = this._maxConcurrent - currentActiveCount;
    return { canStart: true, slotsAvailable };
  }

  getRateLimiter(host: string): RateLimiter {
    if (!this.hostRateLimiters.has(host)) {
      const rateLimiting = config.rateLimiting as
        | {
            download?: { maxRequestsPerHost?: number; windowMs?: number };
            search?: { maxRequests?: number; windowMs?: number };
          }
        | undefined;
      const maxRequests =
        rateLimiting?.download?.maxRequestsPerHost ?? rateLimiting?.search?.maxRequests ?? 10;
      const windowMs = rateLimiting?.download?.windowMs ?? rateLimiting?.search?.windowMs ?? 1000;
      this.hostRateLimiters.set(host, new RateLimiter(maxRequests, windowMs));
    }
    return this.hostRateLimiters.get(host)!;
  }

  registerDownload(downloadId: number, host: string): void {
    if (!this.activeByHost.has(host)) {
      this.activeByHost.set(host, new Set());
    }
    this.activeByHost.get(host)!.add(downloadId);
    const rateLimiter = this.getRateLimiter(host);
    rateLimiter.record(host);
  }

  unregisterDownload(downloadId: number, host: string): void {
    const hostSet = this.activeByHost.get(host);
    if (hostSet) {
      hostSet.delete(downloadId);
      if (hostSet.size === 0) {
        this.activeByHost.delete(host);
      }
    }
  }

  /**
   * Ordena la cola por prioridad efectiva (y opcionalmente SJF) y devuelve hasta
   * slotsAvailable descargas que pasen canStartDownload (límite global y por host).
   */
  selectDownloadsToStart(
    queuedDownloads: DownloadLike[],
    slotsAvailable: number,
    currentActiveCount?: number
  ): DownloadLike[] {
    if (queuedDownloads.length === 0 || slotsAvailable <= 0) {
      return [];
    }

    const now = Date.now();

    const sorted = [...queuedDownloads].sort((a, b) => {
      const effectiveA = this.calculateEffectivePriority(a, now);
      const effectiveB = this.calculateEffectivePriority(b, now);
      const priorityDiff = effectiveB - effectiveA;
      if (Math.abs(priorityDiff) > 0.01) return priorityDiff;

      if (this.sjfEnabled) {
        const sizeA = this.getEffectiveSize(a);
        const sizeB = this.getEffectiveSize(b);
        const sizeComparison = this.compareSizes(sizeA, sizeB);
        if (sizeComparison !== 0 && this.sjfWeight >= 0.5) return sizeComparison;
      }

      return (a.createdAt ?? a.created_at ?? 0) - (b.createdAt ?? b.created_at ?? 0);
    });

    const selected: DownloadLike[] = [];
    // No almacenar index con módulo del tamaño actual de la cola
    // porque la cola cambia entre invocaciones. Usar modulo solo al acceder.
    let index = this.roundRobinIndex;
    let activeCount = currentActiveCount !== undefined ? currentActiveCount : this.getActiveCount();

    for (let i = 0; i < sorted.length && selected.length < slotsAvailable; i++) {
      const download = sorted[(index + i) % sorted.length];
      const host = this.extractHost(download.url ?? undefined);
      const availability = this.canStartDownload(activeCount, host);

      if (availability.canStart) {
        selected.push(download);
        activeCount++;
      }
    }

    // Avanzar el índice por la cantidad de ítems evaluados, sin modulo del tamaño actual
    this.roundRobinIndex = index + sorted.length;
    return selected;
  }

  extractHost(url: string | undefined): string | null {
    if (!url) return null;
    try {
      return new URL(url).hostname;
    } catch {
      _log.debug?.('URL no parseable:', url);
      return null;
    }
  }

  getActiveCount(): number {
    let total = 0;
    for (const hostSet of this.activeByHost.values()) {
      total += hostSet.size;
    }
    return total;
  }

  cleanup(): void {
    for (const limiter of this.hostRateLimiters.values()) {
      limiter.cleanup();
    }
  }
}
