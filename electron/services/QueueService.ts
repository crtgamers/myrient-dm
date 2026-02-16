/**
 * Lógica de negocio para la cola de descargas: orden, prioridad, slots y estimaciones.
 *
 * Ordenamiento por prioridad efectiva (aging, SJF opcional, penalización por reintentos);
 * sortQueue, selectDownloadsToStart, calculateQueuePosition; checkAvailability,
 * calculateQueueStats; estimateTimeUntilStart, estimateQueueTime, calculateAverageSpeed;
 * prioritizeDownload, reorderDownload. Config desde config.downloads.queueOrdering.
 * El Scheduler del motor usa lógica similar; este servicio expone reglas para la UI y métricas.
 *
 * @module QueueService
 */

import BaseService, { ServiceResponse } from './BaseService';
import config from '../config';
import { DownloadPriority } from '../../shared/constants/queue';

export interface QueueAvailability {
  canStart: boolean;
  shouldQueue: boolean;
  slotsAvailable: number;
  activeCount?: number;
  queuedCount?: number;
  maxConcurrent: number;
  maxQueueSize: number;
}

export interface QueueStats {
  total: number;
  active: number;
  slotsAvailable: number;
  maxConcurrent: number;
  byPriority?: Record<number, number>;
  canStart: boolean;
  shouldQueue: boolean;
}

interface DownloadLike {
  id?: number;
  download_id?: number;
  title?: string;
  priority?: number;
  created_at?: number;
  createdAt?: number;
  updated_at?: number;
  retry_count?: number;
  retryCount?: number;
  total_bytes?: number;
  totalBytes?: number;
  speed?: number;
  speedBytesPerSec?: number;
}

interface OrderingConfig {
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

export default class QueueService extends BaseService {
  maxConcurrent: number;
  orderingConfig: OrderingConfig;
  agingEnabled: boolean;
  agingIntervalMs: number;
  maxAgingBonus: number;
  lowPriorityAgingMultiplier: number;
  sjfEnabled: boolean;
  sjfWeight: number;
  sjfTolerancePercent: number;
  sjfDefaultSizeBytes: number;
  retryPenaltyEnabled: boolean;
  retryPenaltyPerRetry: number;
  maxRetryPenalty: number;
  retryPenaltyFreeRetries: number;

  constructor() {
    super('QueueService');
    const downloads = config.downloads as Record<string, unknown>;
    this.maxConcurrent = (downloads?.maxConcurrent as number) ?? 2;
    this.orderingConfig = (downloads?.queueOrdering as OrderingConfig) ?? {};

    this.agingEnabled = this.orderingConfig.agingEnabled ?? true;
    this.agingIntervalMs = (this.orderingConfig.agingIntervalMs as number) ?? 30 * 60 * 1000;
    this.maxAgingBonus = this.orderingConfig.maxAgingBonus ?? 2;
    this.lowPriorityAgingMultiplier =
      (this.orderingConfig.lowPriorityAgingMultiplier as number) ?? 1.5;

    this.sjfEnabled = this.orderingConfig.sjfEnabled ?? true;
    this.sjfWeight = this.orderingConfig.sjfWeight ?? 0.7;
    this.sjfTolerancePercent = this.orderingConfig.sjfTolerancePercent ?? 10;
    this.sjfDefaultSizeBytes =
      (this.orderingConfig.sjfDefaultSizeBytes as number) ?? 100 * 1024 * 1024;

    this.retryPenaltyEnabled = this.orderingConfig.retryPenaltyEnabled ?? true;
    this.retryPenaltyPerRetry = this.orderingConfig.retryPenaltyPerRetry ?? 0.5;
    this.maxRetryPenalty = this.orderingConfig.maxRetryPenalty ?? 1.5;
    this.retryPenaltyFreeRetries = this.orderingConfig.retryPenaltyFreeRetries ?? 1;
  }

  calculateEffectivePriority(download: DownloadLike, now = Date.now()): number {
    const basePriority = download.priority ?? DownloadPriority.NORMAL;
    let effectivePriority = basePriority;

    if (this.agingEnabled) {
      const createdAt = download.created_at ?? download.createdAt ?? now;
      const timeInQueue = now - createdAt;
      if (timeInQueue > 0) {
        const agingIntervals = timeInQueue / this.agingIntervalMs;
        const multiplier =
          basePriority === DownloadPriority.LOW ? this.lowPriorityAgingMultiplier : 1.0;
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

  calculateRetryPenalty(download: DownloadLike): number {
    if (!this.retryPenaltyEnabled) return 0;
    const retryCount = download.retry_count ?? download.retryCount ?? 0;
    const penalizableRetries = Math.max(0, retryCount - this.retryPenaltyFreeRetries);
    if (penalizableRetries <= 0) return 0;
    return Math.min(penalizableRetries * this.retryPenaltyPerRetry, this.maxRetryPenalty);
  }

  getEffectiveSize(download: DownloadLike): number {
    const size = download.total_bytes ?? download.totalBytes ?? 0;
    return size <= 0 ? this.sjfDefaultSizeBytes : size;
  }

  compareSizes(sizeA: number, sizeB: number): number {
    if (!this.sjfEnabled) return 0;
    const maxSize = Math.max(sizeA, sizeB);
    if (maxSize === 0) return 0;
    const diffPercent = (Math.abs(sizeA - sizeB) / maxSize) * 100;
    if (diffPercent <= this.sjfTolerancePercent) return 0;
    return sizeA - sizeB;
  }

  sortQueue(queue: DownloadLike[] | null | undefined): DownloadLike[] {
    try {
      if (!queue || !Array.isArray(queue)) return [];

      const now = Date.now();

      return [...queue].sort((a, b) => {
        const effectivePriorityA = this.calculateEffectivePriority(a, now);
        const effectivePriorityB = this.calculateEffectivePriority(b, now);
        const priorityDiff = effectivePriorityB - effectivePriorityA;
        if (Math.abs(priorityDiff) > 0.01) return priorityDiff;

        if (this.sjfEnabled) {
          const sizeA = this.getEffectiveSize(a);
          const sizeB = this.getEffectiveSize(b);
          const sizeComparison = this.compareSizes(sizeA, sizeB);
          if (sizeComparison !== 0 && this.sjfWeight >= 0.5) return sizeComparison;
        }

        const createdA = a.created_at ?? a.createdAt ?? 0;
        const createdB = b.created_at ?? b.createdAt ?? 0;
        const createdDiff = createdA - createdB;

        if (this.sjfEnabled && this.sjfWeight < 0.5 && this.sjfWeight > 0) {
          const sizeA = this.getEffectiveSize(a);
          const sizeB = this.getEffectiveSize(b);
          const sizeComparison = this.compareSizes(sizeA, sizeB);
          if (sizeComparison !== 0 && createdDiff !== 0) {
            const sizeScore = sizeComparison > 0 ? 1 : -1;
            const createdScore = createdDiff > 0 ? 1 : -1;
            const combinedScore = this.sjfWeight * sizeScore + (1 - this.sjfWeight) * createdScore;
            return combinedScore;
          }
        }

        return createdDiff;
      });
    } catch (error) {
      this.log.error('Error ordenando cola:', (error as Error).message);
      return queue ?? [];
    }
  }

  selectDownloadsToStart(
    queue: DownloadLike[] | null | undefined,
    activeCount: number
  ): DownloadLike[] {
    try {
      if (!queue || !Array.isArray(queue) || queue.length === 0) return [];
      const slotsAvailable = Math.max(0, this.maxConcurrent - activeCount);
      if (slotsAvailable <= 0) return [];
      const queueSorted = this.sortQueue(queue);
      return queueSorted.slice(0, slotsAvailable);
    } catch (error) {
      this.log.error('Error seleccionando descargas:', (error as Error).message);
      return [];
    }
  }

  calculateQueuePosition(
    downloadParams: { priority?: number },
    queue: DownloadLike[] | null | undefined
  ): number {
    try {
      if (!queue || !Array.isArray(queue)) return 0;
      const queueSorted = this.sortQueue(queue);
      const newPriority = downloadParams.priority ?? DownloadPriority.NORMAL;
      const now = Date.now();
      let position = queueSorted.length;

      for (let i = 0; i < queueSorted.length; i++) {
        const item = queueSorted[i];
        const itemEffectivePriority = this.calculateEffectivePriority(item, now);
        if (newPriority > itemEffectivePriority + 0.01) {
          position = i;
          break;
        }
      }
      return position;
    } catch (error) {
      this.log.error('Error calculando posición en cola:', (error as Error).message);
      return queue?.length ?? 0;
    }
  }

  checkAvailability(activeCount = 0, queuedCount = 0): QueueAvailability {
    try {
      const downloads = config.downloads as Record<string, unknown>;
      const maxQueueSize = (downloads?.maxQueueSize as number) ?? 1000;
      const slotsAvailable = Math.max(0, this.maxConcurrent - activeCount);
      const canStart = slotsAvailable > 0;
      const shouldQueue = !canStart && queuedCount < maxQueueSize;

      return {
        canStart,
        shouldQueue,
        slotsAvailable,
        activeCount,
        queuedCount,
        maxConcurrent: this.maxConcurrent,
        maxQueueSize,
      };
    } catch (error) {
      this.log.error('Error verificando disponibilidad:', (error as Error).message);
      return {
        canStart: false,
        shouldQueue: false,
        slotsAvailable: 0,
        activeCount: 0,
        queuedCount: 0,
        maxConcurrent: this.maxConcurrent,
        maxQueueSize: 1000,
      };
    }
  }

  calculateQueueStats(queue: DownloadLike[] | null | undefined, activeCount: number): QueueStats {
    try {
      const queuedCount = queue?.length ?? 0;
      const availability = this.checkAvailability(activeCount, queuedCount);

      const byPriority: Record<number, number> = {
        [DownloadPriority.LOW]: 0,
        [DownloadPriority.NORMAL]: 0,
        [DownloadPriority.HIGH]: 0,
        [DownloadPriority.URGENT]: 0,
      };

      if (queue && Array.isArray(queue)) {
        queue.forEach(item => {
          const priority = item.priority ?? DownloadPriority.NORMAL;
          byPriority[priority] = (byPriority[priority] ?? 0) + 1;
        });
      }

      return {
        total: queuedCount,
        active: activeCount,
        slotsAvailable: availability.slotsAvailable,
        maxConcurrent: this.maxConcurrent,
        byPriority,
        canStart: availability.canStart,
        shouldQueue: availability.shouldQueue,
      };
    } catch (error) {
      this.log.error('Error calculando estadísticas de cola:', (error as Error).message);
      return {
        total: 0,
        active: 0,
        slotsAvailable: 0,
        maxConcurrent: this.maxConcurrent,
        byPriority: {},
        canStart: false,
        shouldQueue: false,
      };
    }
  }

  calculateOrderingStats(queue: DownloadLike[] | null | undefined): Record<string, unknown> {
    const now = Date.now();
    const result: Record<string, unknown> = {
      aging: {
        enabled: this.agingEnabled,
        config: {
          intervalMs: this.agingIntervalMs,
          maxBonus: this.maxAgingBonus,
          lowPriorityMultiplier: this.lowPriorityAgingMultiplier,
        },
        summary: { avgAgingBonus: 0, maxAgingBonus: 0, downloadsWithBonus: 0 },
      },
      sjf: {
        enabled: this.sjfEnabled,
        config: {
          weight: this.sjfWeight,
          tolerancePercent: this.sjfTolerancePercent,
          defaultSizeBytes: this.sjfDefaultSizeBytes,
        },
        summary: {
          avgSizeBytes: 0,
          minSizeBytes: 0,
          maxSizeBytes: 0,
          unknownSizeCount: 0,
          avgSizeMB: 0,
          minSizeMB: 0,
          maxSizeMB: 0,
          knownSizeCount: 0,
        },
      },
      retryPenalty: {
        enabled: this.retryPenaltyEnabled,
        config: {
          penaltyPerRetry: this.retryPenaltyPerRetry,
          maxPenalty: this.maxRetryPenalty,
          freeRetries: this.retryPenaltyFreeRetries,
        },
        summary: {
          avgPenalty: 0,
          maxPenalty: 0,
          downloadsWithPenalty: 0,
          totalRetries: 0,
        },
      },
      downloads: [] as unknown[],
      totalDownloads: 0,
    };

    if (!queue || !Array.isArray(queue) || queue.length === 0) return result;

    let totalAgingBonus = 0;
    let maxAgingBonus = 0;
    let withAgingBonus = 0;
    let totalSize = 0;
    let minSize = Infinity;
    let maxSize = 0;
    let unknownSizeCount = 0;
    let totalRetryPenalty = 0;
    let maxRetryPenalty = 0;
    let withRetryPenalty = 0;
    let totalRetries = 0;

    const downloadsList = queue.map(download => {
      const basePriority = download.priority ?? DownloadPriority.NORMAL;
      const effectivePriority = this.calculateEffectivePriority(download, now);
      const createdAt = download.created_at ?? download.createdAt ?? now;
      const timeInQueueMs = now - createdAt;
      const retryCount = download.retry_count ?? download.retryCount ?? 0;

      let agingBonus = 0;
      if (this.agingEnabled && timeInQueueMs > 0) {
        const agingIntervals = timeInQueueMs / this.agingIntervalMs;
        const multiplier =
          basePriority === DownloadPriority.LOW ? this.lowPriorityAgingMultiplier : 1.0;
        agingBonus = Math.min(agingIntervals * multiplier, this.maxAgingBonus);
      }
      const retryPenalty = this.calculateRetryPenalty(download);

      if (agingBonus > 0) {
        withAgingBonus++;
        totalAgingBonus += agingBonus;
        maxAgingBonus = Math.max(maxAgingBonus, agingBonus);
      }
      totalRetries += retryCount;
      if (retryPenalty > 0) {
        withRetryPenalty++;
        totalRetryPenalty += retryPenalty;
        maxRetryPenalty = Math.max(maxRetryPenalty, retryPenalty);
      }

      const rawSize = download.total_bytes ?? download.totalBytes ?? 0;
      const effectiveSize = this.getEffectiveSize(download);
      if (rawSize <= 0) unknownSizeCount++;
      else {
        totalSize += rawSize;
        minSize = Math.min(minSize, rawSize);
        maxSize = Math.max(maxSize, rawSize);
      }

      return {
        id: download.id,
        title: download.title,
        basePriority,
        effectivePriority: Math.round(effectivePriority * 100) / 100,
        agingBonus: Math.round(agingBonus * 100) / 100,
        retryCount,
        retryPenalty: Math.round(retryPenalty * 100) / 100,
        timeInQueueMs,
        timeInQueueMinutes: Math.round(timeInQueueMs / 60000),
        sizeBytes: rawSize,
        effectiveSizeBytes: effectiveSize,
        sizeMB: Math.round((effectiveSize / (1024 * 1024)) * 10) / 10,
        sizeUnknown: rawSize <= 0,
      };
    });

    (result.aging as Record<string, unknown>).summary = {
      avgAgingBonus:
        withAgingBonus > 0 ? Math.round((totalAgingBonus / withAgingBonus) * 100) / 100 : 0,
      maxAgingBonus: Math.round(maxAgingBonus * 100) / 100,
      downloadsWithBonus: withAgingBonus,
    };
    (result.retryPenalty as Record<string, unknown>).summary = {
      avgPenalty:
        withRetryPenalty > 0 ? Math.round((totalRetryPenalty / withRetryPenalty) * 100) / 100 : 0,
      maxPenalty: Math.round(maxRetryPenalty * 100) / 100,
      downloadsWithPenalty: withRetryPenalty,
      totalRetries,
    };
    const knownSizeCount = queue.length - unknownSizeCount;
    (result.sjf as Record<string, unknown>).summary = {
      avgSizeBytes: knownSizeCount > 0 ? Math.round(totalSize / knownSizeCount) : 0,
      avgSizeMB:
        knownSizeCount > 0 ? Math.round((totalSize / knownSizeCount / (1024 * 1024)) * 10) / 10 : 0,
      minSizeBytes: minSize === Infinity ? 0 : minSize,
      minSizeMB: minSize === Infinity ? 0 : Math.round((minSize / (1024 * 1024)) * 10) / 10,
      maxSizeBytes: maxSize,
      maxSizeMB: Math.round((maxSize / (1024 * 1024)) * 10) / 10,
      unknownSizeCount,
      knownSizeCount,
    };
    result.downloads = downloadsList;
    result.totalDownloads = queue.length;

    return result;
  }

  calculateAgingStats(queue: DownloadLike[] | null | undefined): Record<string, unknown> {
    return this.calculateOrderingStats(queue);
  }

  prioritizeDownload(
    downloadId: string | number,
    queue: DownloadLike[],
    newPriority: number
  ):
    | { success: boolean; queue?: DownloadLike[]; newPosition?: number; error?: string }
    | ServiceResponse {
    try {
      if (!queue || !Array.isArray(queue)) {
        return { success: false, error: 'Cola inválida' };
      }
      const validPriorities: number[] = [
        DownloadPriority.LOW,
        DownloadPriority.NORMAL,
        DownloadPriority.HIGH,
        DownloadPriority.URGENT,
      ];
      if (!validPriorities.includes(newPriority)) {
        return { success: false, error: 'Prioridad inválida' };
      }
      const index = queue.findIndex(
        item => item.id === downloadId || item.download_id === downloadId
      );
      if (index === -1) {
        return { success: false, error: 'Descarga no encontrada en cola' };
      }
      queue[index].priority = newPriority;
      (queue[index] as DownloadLike & { updated_at?: number }).updated_at = Date.now();
      const reorderedQueue = this.sortQueue(queue);
      return {
        success: true,
        queue: reorderedQueue,
        newPosition: reorderedQueue.findIndex(
          item => item.id === downloadId || item.download_id === downloadId
        ),
      };
    } catch (error) {
      return this.handleError(error as Error & { code?: string }, 'prioritizeDownload');
    }
  }

  reorderDownload(
    downloadId: string | number,
    queue: DownloadLike[],
    newPosition: number
  ):
    | { success: boolean; queue?: DownloadLike[]; newPosition?: number; error?: string }
    | ServiceResponse {
    try {
      if (!queue || !Array.isArray(queue)) {
        return { success: false, error: 'Cola inválida' };
      }
      if (newPosition < 0 || newPosition >= queue.length) {
        return { success: false, error: 'Posición inválida' };
      }
      const index = queue.findIndex(
        item => item.id === downloadId || item.download_id === downloadId
      );
      if (index === -1) {
        return { success: false, error: 'Descarga no encontrada en cola' };
      }
      const item = queue.splice(index, 1)[0];
      queue.splice(newPosition, 0, item);
      (item as DownloadLike & { updated_at?: number }).updated_at = Date.now();
      return {
        success: true,
        queue: this.sortQueue(queue),
        newPosition,
      };
    } catch (error) {
      return this.handleError(error as Error & { code?: string }, 'reorderDownload');
    }
  }

  calculateAverageSpeed(
    activeDownloads: Array<{ speed?: number; speedBytesPerSec?: number }> = []
  ): number {
    try {
      if (!activeDownloads || activeDownloads.length === 0) return 0;
      const downloadsWithSpeed = activeDownloads.filter(d => {
        const speed = d.speed ?? d.speedBytesPerSec ?? 0;
        return speed > 0;
      });
      if (downloadsWithSpeed.length === 0) return 0;
      return downloadsWithSpeed.reduce((sum, d) => {
        let speedBytesPerSec = d.speedBytesPerSec ?? 0;
        if (d.speed != null && !d.speedBytesPerSec) speedBytesPerSec = d.speed * 1024 * 1024;
        return sum + speedBytesPerSec;
      }, 0);
    } catch (error) {
      this.log.error('Error calculando velocidad promedio:', (error as Error).message);
      return 0;
    }
  }

  estimateTimeUntilStart(
    downloadId: string | number,
    queue: DownloadLike[] | null | undefined,
    activeCount: number,
    averageSpeedBytesPerSec = 0
  ): Record<string, unknown> {
    try {
      if (!queue || !Array.isArray(queue) || queue.length === 0) {
        return {
          estimatedSeconds: 0,
          estimatedMinutes: 0,
          estimatedHours: 0,
          positionInQueue: 0,
          canStartImmediately: true,
        };
      }
      const sortedQueue = this.sortQueue(queue);
      const position = sortedQueue.findIndex(
        item => item.id === downloadId || item.download_id === downloadId
      );
      if (position === -1) {
        return {
          estimatedSeconds: 0,
          estimatedMinutes: 0,
          estimatedHours: 0,
          positionInQueue: 0,
          canStartImmediately: false,
          notFound: true,
        };
      }
      const slotsAvailable = Math.max(0, this.maxConcurrent - activeCount);
      const canStartImmediately = slotsAvailable > 0 && position < slotsAvailable;
      if (canStartImmediately) {
        return {
          estimatedSeconds: 0,
          estimatedMinutes: 0,
          estimatedHours: 0,
          positionInQueue: position + 1,
          canStartImmediately: true,
        };
      }
      const downloadsBefore = position;
      const batchesToWait = Math.ceil(downloadsBefore / Math.max(1, this.maxConcurrent));
      if (averageSpeedBytesPerSec <= 0) {
        return {
          estimatedSeconds: null,
          estimatedMinutes: null,
          estimatedHours: null,
          positionInQueue: position + 1,
          canStartImmediately: false,
          requiresSpeed: true,
          batchesToWait,
        };
      }
      const previousDownloads = sortedQueue.slice(0, position);
      let totalBytesToDownload = 0;
      let validDownloads = 0;
      previousDownloads.forEach(d => {
        const totalBytes = d.totalBytes ?? d.total_bytes ?? 0;
        if (totalBytes > 0) {
          totalBytesToDownload += totalBytes;
          validDownloads++;
        }
      });
      if (totalBytesToDownload === 0) {
        const avgFileSize = 100 * 1024 * 1024;
        totalBytesToDownload =
          validDownloads > 0 ? validDownloads * avgFileSize : downloadsBefore * avgFileSize;
      }
      const estimatedSeconds =
        totalBytesToDownload / (averageSpeedBytesPerSec * Math.max(1, this.maxConcurrent));
      return {
        estimatedSeconds: Math.max(0, estimatedSeconds),
        estimatedMinutes: Math.max(0, estimatedSeconds / 60),
        estimatedHours: Math.max(0, estimatedSeconds / 3600),
        positionInQueue: position + 1,
        canStartImmediately: false,
        totalBytesToDownload,
        batchesToWait,
      };
    } catch (error) {
      this.log.error('Error estimando tiempo hasta inicio:', (error as Error).message);
      return {
        estimatedSeconds: null,
        estimatedMinutes: null,
        estimatedHours: null,
        positionInQueue: 0,
        canStartImmediately: false,
        error: (error as Error).message,
      };
    }
  }

  estimateQueueTime(
    queue: DownloadLike[] | null | undefined,
    activeCount: number,
    averageSpeedBytesPerSec = 0
  ): Record<string, unknown> {
    try {
      if (!queue || !Array.isArray(queue) || queue.length === 0) {
        return {
          totalEstimatedSeconds: 0,
          totalEstimatedMinutes: 0,
          totalEstimatedHours: 0,
          totalDownloads: 0,
          totalBytes: 0,
          canStartImmediately: true,
        };
      }
      const sortedQueue = this.sortQueue(queue);
      const slotsAvailable = Math.max(0, this.maxConcurrent - activeCount);
      let totalBytes = 0;
      let downloadsWithSize = 0;
      sortedQueue.forEach(d => {
        const bytes = d.totalBytes ?? d.total_bytes ?? 0;
        if (bytes > 0) {
          totalBytes += bytes;
          downloadsWithSize++;
        }
      });
      if (averageSpeedBytesPerSec <= 0) {
        return {
          totalEstimatedSeconds: null,
          totalEstimatedMinutes: null,
          totalEstimatedHours: null,
          totalDownloads: sortedQueue.length,
          totalBytes,
          downloadsWithSize,
          canStartImmediately: slotsAvailable > 0,
          requiresSpeed: true,
          slotsAvailable,
        };
      }
      const effectiveSpeed = averageSpeedBytesPerSec * this.maxConcurrent;
      let totalEstimatedSeconds = totalBytes / effectiveSpeed;
      const downloadsWithoutSize = sortedQueue.length - downloadsWithSize;
      if (downloadsWithoutSize > 0) {
        const avgFileSize = 100 * 1024 * 1024;
        const additionalBytes = downloadsWithoutSize * avgFileSize;
        totalEstimatedSeconds += additionalBytes / effectiveSpeed;
        return {
          totalEstimatedSeconds: Math.max(0, totalEstimatedSeconds),
          totalEstimatedMinutes: Math.max(0, totalEstimatedSeconds / 60),
          totalEstimatedHours: Math.max(0, totalEstimatedSeconds / 3600),
          totalDownloads: sortedQueue.length,
          totalBytes: totalBytes + additionalBytes,
          downloadsWithSize,
          downloadsWithoutSize,
          canStartImmediately: slotsAvailable > 0,
          slotsAvailable,
          effectiveSpeed,
        };
      }
      return {
        totalEstimatedSeconds: Math.max(0, totalEstimatedSeconds),
        totalEstimatedMinutes: Math.max(0, totalEstimatedSeconds / 60),
        totalEstimatedHours: Math.max(0, totalEstimatedSeconds / 3600),
        totalDownloads: sortedQueue.length,
        totalBytes,
        downloadsWithSize,
        downloadsWithoutSize: 0,
        canStartImmediately: slotsAvailable > 0,
        slotsAvailable,
        effectiveSpeed,
      };
    } catch (error) {
      this.log.error('Error estimando tiempo de cola:', (error as Error).message);
      return {
        totalEstimatedSeconds: null,
        totalEstimatedMinutes: null,
        totalEstimatedHours: null,
        totalDownloads: queue?.length ?? 0,
        totalBytes: 0,
        error: (error as Error).message,
      };
    }
  }
}
