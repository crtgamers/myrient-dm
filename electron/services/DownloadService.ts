/**
 * Lógica de negocio para descargas: validación, estrategia simple/chunked, duplicados, prioridad.
 *
 * validateDownloadParams, validateDownloadFolderParams, canStartDownload, canDownloadFolder;
 * shouldUseChunkedDownload (según tamaño y config); isDuplicate, normalizeSavePath,
 * prepareFileDownloadParams, calculateFolderDownloadStats. Usado por ipcStateHandlers y
 * DownloadEngine para validar antes de añadir a la cola y para decidir descarga simple vs fragmentada.
 *
 * @module DownloadService
 */

import BaseService, { ServiceResponse } from './BaseService';
import config from '../config';
import {
  getNetworkErrorMessage,
  validateAndPrepareDownloadParams,
  type PreparedDownloadParams,
  type ValidationResult,
} from '../utils/validation';
import path from 'path';
import { sanitizeFilename } from '../utils';

/** Resultado de validación de parámetros de descarga (válido o error de servicio). */
export type DownloadValidationResult = ValidationResult<PreparedDownloadParams> | ServiceResponse;

export interface CanStartDownloadResult {
  canStart: boolean;
  reason: string;
  shouldQueue?: boolean;
  queuePosition?: number;
}

export interface IsDuplicateResult {
  isDuplicate: boolean;
  reason?: string;
  existingDownload?: { id?: number; title?: string; url?: string; downloadPath?: string };
}

export interface ValidateDownloadFolderResult {
  valid: boolean;
  error?: string;
  data?: {
    folderId: number;
    downloadPath: string | null;
    preserveStructure: boolean;
    forceOverwrite: boolean;
  };
}

export interface CanDownloadFolderResult {
  canDownload: boolean;
  reason: string;
  fileCount?: number;
  maxFilesPerFolder?: number;
  availableQueueSlots?: number;
  maxQueueSize?: number;
  estimatedQueueSlots?: number;
}

export interface PrepareFileDownloadResult {
  success: boolean;
  params?: PreparedDownloadParams & { url?: string | null };
  error?: string;
}

export interface FolderDownloadStats {
  totalFiles: number;
  validFiles: number;
  duplicateFiles: number;
  newDownloads: number;
  totalSize: number;
  averageSize: number;
  canDownload?: boolean;
  validation?: CanDownloadFolderResult;
  error?: string;
}

interface ChunkedConfig {
  sizeThreshold?: number;
  forceSimpleDownload?: boolean;
  enabled?: boolean;
  maxChunks?: number;
  mediumRangeMaxBytes?: number;
  chunkSizeMediumTarget?: number;
  chunkCountMediumMin?: number;
  chunkCountMediumMax?: number;
  chunkSizeLargeBase?: number;
  chunkCountLargeMin?: number;
  chunkCountLargeMax?: number;
  chunkRanges?: Array<{ maxSize: number; chunkSize: number }>;
}

interface ExistingDownloadLike {
  id?: number;
  title?: string;
  url?: string;
  downloadPath?: string;
}

interface FileInfoLike {
  id?: number | string;
  title?: string;
  url?: string;
  size?: number;
}

export default class DownloadService extends BaseService {
  chunkedConfig: ChunkedConfig;

  constructor() {
    super('DownloadService');
    this.chunkedConfig = (config.downloads?.chunked as ChunkedConfig) ?? {};
  }

  /** Valida parámetros de descarga (id, title, url, paths, etc.) vía validateAndPrepareDownloadParams. */
  validateDownloadParams(params: Record<string, unknown>): DownloadValidationResult {
    try {
      return validateAndPrepareDownloadParams(params, {
        requireUrl: false,
        requireSavePath: false,
        sanitizeTitle: true,
        validatePath: true,
      });
    } catch (error) {
      return this.handleError(error as Error & { code?: string }, 'validateDownloadParams');
    }
  }

  /**
   * Devuelve true si el archivo supera el umbral de tamaño y la config permite chunks
   * (no forceSimpleDownload, enabled !== false). Usado por el engine para elegir simple vs chunked.
   */
  async shouldUseChunkedDownload(
    url: string | null | undefined,
    fileSize: number
  ): Promise<boolean> {
    try {
      const threshold = this.chunkedConfig.sizeThreshold ?? 50 * 1024 * 1024;

      this.log.info(
        `[DownloadService] Evaluando estrategia: ${this._formatBytes(fileSize)} (umbral: ${this._formatBytes(threshold)})`
      );

      if (this.chunkedConfig.forceSimpleDownload) {
        this.log.info('[DownloadService] ❌ Chunks deshabilitados (forceSimpleDownload)');
        return false;
      }

      if (this.chunkedConfig.enabled === false) {
        this.log.info('[DownloadService] ❌ Chunks deshabilitados (enabled=false)');
        return false;
      }

      if (!url) {
        this.log.info('[DownloadService] ❌ No hay URL, usando descarga directa');
        return false;
      }

      if (!fileSize || fileSize <= 0) {
        this.log.info('[DownloadService] ❌ Tamaño desconocido, usando descarga directa');
        return false;
      }

      if (fileSize < threshold) {
        this.log.info(
          `[DownloadService] ❌ Archivo < 50 MB (${this._formatBytes(fileSize)}), usando descarga DIRECTA`
        );
        return false;
      }

      const chunkConfig = this._getChunkConfigForSize(fileSize);
      this.log.info(
        `[DownloadService] ✓ Archivo > 50 MB, usando descarga FRAGMENTADA: ` +
          `${this._formatBytes(fileSize)} → ${chunkConfig.chunks} chunks de ~${this._formatBytes(chunkConfig.chunkSize)}`
      );
      return true;
    } catch (error) {
      this.log.warn(
        '[DownloadService] Error en shouldUseChunkedDownload:',
        (error as Error).message
      );
      return false;
    }
  }

  /** Configuración de chunks para un tamaño (coherente con ChunkDownloader.calculateChunks). */
  private _getChunkConfigForSize(fileSize: number): { chunks: number; chunkSize: number } {
    const maxChunks = this.chunkedConfig.maxChunks ?? 16;
    const mediumMax = this.chunkedConfig.mediumRangeMaxBytes ?? 500 * 1024 * 1024;
    const useBandStrategy =
      mediumMax > 0 &&
      (this.chunkedConfig.chunkSizeMediumTarget != null ||
        this.chunkedConfig.chunkCountMediumMin != null);

    let chunks: number;
    if (useBandStrategy) {
      const sizeMediumTarget = this.chunkedConfig.chunkSizeMediumTarget ?? 8 * 1024 * 1024;
      const countMediumMin = this.chunkedConfig.chunkCountMediumMin ?? 4;
      const countMediumMax = this.chunkedConfig.chunkCountMediumMax ?? 8;
      const sizeLargeBase = this.chunkedConfig.chunkSizeLargeBase ?? 32 * 1024 * 1024;
      const countLargeMin = this.chunkedConfig.chunkCountLargeMin ?? 8;
      const countLargeMax = Math.min(this.chunkedConfig.chunkCountLargeMax ?? 16, maxChunks);

      if (fileSize < mediumMax) {
        chunks = Math.ceil(fileSize / sizeMediumTarget);
        chunks = Math.max(countMediumMin, Math.min(countMediumMax, chunks));
      } else {
        chunks = Math.ceil(fileSize / sizeLargeBase);
        chunks = Math.max(countLargeMin, Math.min(countLargeMax, chunks));
      }
      chunks = Math.min(chunks, maxChunks);
    } else {
      const ranges = this.chunkedConfig.chunkRanges ?? [
        { maxSize: 125 * 1024 * 1024, chunkSize: 12 * 1024 * 1024 },
        { maxSize: 250 * 1024 * 1024, chunkSize: 25 * 1024 * 1024 },
        { maxSize: 1024 * 1024 * 1024, chunkSize: 32 * 1024 * 1024 },
        { maxSize: 5 * 1024 * 1024 * 1024, chunkSize: 32 * 1024 * 1024 },
        { maxSize: Infinity, chunkSize: 64 * 1024 * 1024 },
      ];
      const range = ranges.find(r => fileSize <= r.maxSize) ?? ranges[ranges.length - 1];
      const baseChunkSize = range.chunkSize;
      chunks = Math.ceil(fileSize / baseChunkSize);
      chunks = Math.max(2, Math.min(chunks, maxChunks));
    }
    const actualChunkSize = Math.ceil(fileSize / chunks);
    return { chunks, chunkSize: actualChunkSize };
  }

  private _formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  calculateOptimalChunks(fileSize: number): number {
    try {
      if (!fileSize || fileSize <= 0) return 1;
      const threshold = this.chunkedConfig.sizeThreshold ?? 50 * 1024 * 1024;
      if (fileSize < threshold) return 1;
      const cfg = this._getChunkConfigForSize(fileSize);
      return cfg.chunks;
    } catch (error) {
      this.log.warn('Error calculando chunks óptimos:', (error as Error).message);
      return 1;
    }
  }

  canStartDownload(
    downloadParams: Record<string, unknown>,
    currentStats?: {
      maxConcurrent?: number;
      downloading?: number;
      paused?: number;
      queued?: number;
    }
  ): CanStartDownloadResult {
    try {
      const validation = this.validateDownloadParams(downloadParams);
      const valid = 'valid' in validation ? validation.valid : false;
      if (!valid) {
        return {
          canStart: false,
          reason: (validation as { error?: string }).error ?? 'Parámetros inválidos',
        };
      }

      const maxConcurrent =
        currentStats?.maxConcurrent ?? (config.downloads?.maxConcurrent as number | undefined) ?? 2;
      const activeCount = (currentStats?.downloading ?? 0) + (currentStats?.paused ?? 0);

      if (activeCount >= maxConcurrent) {
        return {
          canStart: false,
          reason: 'Límite de descargas simultáneas alcanzado',
          shouldQueue: true,
          queuePosition: (currentStats?.queued ?? 0) + 1,
        };
      }

      return { canStart: true, reason: 'Slots disponibles' };
    } catch (error) {
      return {
        canStart: false,
        reason:
          this.handleError(error as Error & { code?: string }, 'canStartDownload').error ??
          'Error desconocido',
      };
    }
  }

  calculatePriority(_downloadParams: Record<string, unknown>): number {
    return 1;
  }

  isDuplicate(
    downloadParams: { id?: number; title?: string; url?: string; downloadPath?: string },
    existingDownloads?: ExistingDownloadLike[] | null
  ): IsDuplicateResult {
    try {
      if (!existingDownloads || !Array.isArray(existingDownloads)) {
        return { isDuplicate: false };
      }

      const { id, title, url, downloadPath } = downloadParams;

      const duplicateById = existingDownloads.find(d => d.id === id);
      if (duplicateById) {
        return { isDuplicate: true, reason: 'ID duplicado', existingDownload: duplicateById };
      }

      if (url) {
        const duplicateByUrl = existingDownloads.find(
          d => d.url === url && d.downloadPath === downloadPath
        );
        if (duplicateByUrl) {
          return {
            isDuplicate: true,
            reason: 'URL y ruta duplicados',
            existingDownload: duplicateByUrl,
          };
        }
      }

      const duplicateByTitleAndPath = existingDownloads.find(
        d => d.title === title && d.downloadPath === downloadPath
      );
      if (duplicateByTitleAndPath) {
        return {
          isDuplicate: true,
          reason: 'Título y ruta duplicados',
          existingDownload: duplicateByTitleAndPath,
        };
      }

      return { isDuplicate: false };
    } catch (error) {
      this.log.warn(
        'Error verificando duplicados, permitiendo descarga:',
        (error as Error).message
      );
      return { isDuplicate: false };
    }
  }

  getDownloadErrorMessage(error: Error & { code?: string }): string {
    return getNetworkErrorMessage(error);
  }

  normalizeSavePath(
    downloadPath: string,
    title: string,
    preserveStructure = true,
    relativePath = ''
  ): string {
    try {
      let savePath = path.resolve(downloadPath);

      if (preserveStructure && relativePath) {
        const cleanRelativePath = relativePath
          .split(path.sep)
          .map(segment => sanitizeFilename(segment))
          .filter(segment => segment.length > 0)
          .join(path.sep);

        if (cleanRelativePath) {
          savePath = path.join(savePath, cleanRelativePath);
        }
      }

      const cleanTitle = sanitizeFilename(title);
      savePath = path.join(savePath, cleanTitle);

      return savePath;
    } catch (error) {
      this.log.error('Error normalizando ruta, usando ruta simple:', (error as Error).message);
      return path.join(path.resolve(downloadPath), sanitizeFilename(title));
    }
  }

  validateDownloadFolderParams(
    params: Record<string, unknown>
  ): ValidateDownloadFolderResult | ServiceResponse {
    try {
      if (!params || typeof params !== 'object') {
        return { valid: false, error: 'Parámetros de descarga de carpeta requeridos' };
      }

      const { folderId, downloadPath, preserveStructure, forceOverwrite } = params;

      if (!folderId || (typeof folderId !== 'number' && typeof folderId !== 'string')) {
        return { valid: false, error: 'ID de carpeta inválido' };
      }

      const folderIdNum =
        typeof folderId === 'string' ? parseInt(folderId, 10) : (folderId as number);

      if (isNaN(folderIdNum) || folderIdNum <= 0 || !Number.isInteger(folderIdNum)) {
        return { valid: false, error: 'ID de carpeta debe ser un número entero positivo' };
      }

      if (
        downloadPath !== undefined &&
        downloadPath !== null &&
        String(downloadPath).trim() !== ''
      ) {
        if (typeof downloadPath !== 'string') {
          return { valid: false, error: 'Ruta de descarga debe ser una cadena de texto' };
        }
        if (downloadPath.trim().length === 0) {
          return { valid: false, error: 'Ruta de descarga no puede estar vacía' };
        }
        const maxPathLength = 1000;
        if (downloadPath.length > maxPathLength) {
          return {
            valid: false,
            error: `Ruta de descarga demasiado larga (máximo ${maxPathLength} caracteres)`,
          };
        }
      }

      const preserveStructureValid =
        preserveStructure === undefined || typeof preserveStructure === 'boolean';
      const forceOverwriteValid =
        forceOverwrite === undefined || typeof forceOverwrite === 'boolean';

      if (!preserveStructureValid || !forceOverwriteValid) {
        return { valid: false, error: 'Parámetros booleanos inválidos' };
      }

      return {
        valid: true,
        data: {
          folderId: folderIdNum,
          downloadPath: typeof downloadPath === 'string' ? downloadPath.trim() : null,
          preserveStructure: preserveStructure !== false,
          forceOverwrite: forceOverwrite === true,
        },
      };
    } catch (error) {
      return this.handleError(error as Error & { code?: string }, 'validateDownloadFolderParams');
    }
  }

  canDownloadFolder(
    folderParams: Record<string, unknown>,
    fileCount = 0,
    currentStats: Record<string, number> = {},
    overrides: Record<string, number> = {}
  ): CanDownloadFolderResult {
    try {
      const validation = this.validateDownloadFolderParams(folderParams);
      const valid = 'valid' in validation ? validation.valid : false;
      if (!valid) {
        return {
          canDownload: false,
          reason: (validation as { error?: string }).error ?? 'Parámetros inválidos',
        };
      }

      if (!fileCount || fileCount <= 0) {
        return {
          canDownload: false,
          reason: 'La carpeta no contiene archivos para descargar',
        };
      }

      const maxFilesPerFolder =
        overrides.maxFilesPerFolder ??
        (config.downloads as Record<string, unknown>)?.maxFilesPerFolder ??
        1000;
      if (fileCount > (maxFilesPerFolder as number)) {
        return {
          canDownload: false,
          reason: `La carpeta contiene demasiados archivos (${fileCount}). El límite es ${maxFilesPerFolder} archivos por carpeta`,
          fileCount,
          maxFilesPerFolder: maxFilesPerFolder as number,
        };
      }

      const maxQueueSize =
        overrides.maxQueueSize ??
        (config.downloads as Record<string, unknown>)?.maxQueueSize ??
        1000;
      const currentQueueSize = currentStats.queuedInMemory ?? currentStats.queued ?? 0;
      const availableQueueSlots = (maxQueueSize as number) - currentQueueSize;

      if (fileCount > availableQueueSlots) {
        return {
          canDownload: false,
          reason: `No hay suficiente espacio en la cola. La carpeta tiene ${fileCount} archivos pero solo hay ${availableQueueSlots} slots disponibles`,
          fileCount,
          availableQueueSlots,
          maxQueueSize: maxQueueSize as number,
        };
      }

      return {
        canDownload: true,
        reason: 'Carpeta válida para descarga',
        fileCount,
        estimatedQueueSlots: fileCount,
      };
    } catch (error) {
      return {
        canDownload: false,
        reason:
          this.handleError(error as Error & { code?: string }, 'canDownloadFolder').error ??
          'Error desconocido',
      };
    }
  }

  prepareFileDownloadParams(
    folderParams: Record<string, unknown>,
    fileInfo: FileInfoLike
  ): PrepareFileDownloadResult {
    try {
      const folderValidation = this.validateDownloadFolderParams(folderParams);
      const valid = 'valid' in folderValidation ? folderValidation.valid : false;
      if (!valid) {
        throw new Error((folderValidation as { error?: string }).error);
      }

      const validatedFolderParams = (folderValidation as ValidateDownloadFolderResult).data!;

      if (!fileInfo || typeof fileInfo !== 'object') {
        throw new Error('Información de archivo requerida');
      }

      const { id, title } = fileInfo;

      if (!id || (typeof id !== 'number' && typeof id !== 'string')) {
        throw new Error('ID de archivo inválido');
      }

      const fileId = typeof id === 'string' ? parseInt(id, 10) : id;
      if (isNaN(fileId) || fileId <= 0 || !Number.isInteger(fileId)) {
        throw new Error('ID de archivo debe ser un número entero positivo');
      }

      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        throw new Error('Título de archivo requerido');
      }

      const downloadParams: PreparedDownloadParams & { url?: string | null } = {
        id: fileId,
        title: title.trim(),
        downloadPath: validatedFolderParams.downloadPath,
        savePath: null,
        totalBytes: 0,
        preserveStructure: validatedFolderParams.preserveStructure,
        forceOverwrite: validatedFolderParams.forceOverwrite,
        url: fileInfo.url ?? null,
        priority: this.calculatePriority({
          id: fileId,
          title: title.trim(),
          downloadPath: validatedFolderParams.downloadPath,
        }),
      };

      return { success: true, params: downloadParams };
    } catch (error) {
      return {
        success: false,
        error: this.handleError(error as Error & { code?: string }, 'prepareFileDownloadParams')
          .error,
      };
    }
  }

  calculateFolderDownloadStats(
    folderParams: Record<string, unknown>,
    files: FileInfoLike[] = [],
    existingDownloads: ExistingDownloadLike[] = []
  ): FolderDownloadStats {
    try {
      if (!files || !Array.isArray(files)) {
        return {
          totalFiles: 0,
          validFiles: 0,
          duplicateFiles: 0,
          newDownloads: 0,
          totalSize: 0,
          averageSize: 0,
        };
      }

      let validFiles = 0;
      let duplicateFiles = 0;
      let newDownloads = 0;
      let totalSize = 0;

      for (const file of files) {
        if (!file.id || !file.title) continue;

        validFiles++;
        totalSize += file.size ?? 0;

        const downloadParams = {
          id: typeof file.id === 'string' ? parseInt(String(file.id), 10) : (file.id as number),
          title: file.title,
          downloadPath: folderParams.downloadPath as string | undefined,
        };

        const duplicateCheck = this.isDuplicate(downloadParams, existingDownloads);
        if (duplicateCheck.isDuplicate) {
          duplicateFiles++;
        } else {
          newDownloads++;
        }
      }

      const averageSize = validFiles > 0 ? totalSize / validFiles : 0;

      return {
        totalFiles: files.length,
        validFiles,
        duplicateFiles,
        newDownloads,
        totalSize,
        averageSize: Math.round(averageSize),
        canDownload: newDownloads > 0,
        validation: this.canDownloadFolder(folderParams, validFiles, {}),
      };
    } catch (error) {
      this.log.error('Error calculando estadísticas de carpeta:', (error as Error).message);
      return {
        totalFiles: 0,
        validFiles: 0,
        duplicateFiles: 0,
        newDownloads: 0,
        totalSize: 0,
        averageSize: 0,
        canDownload: false,
        error: (error as Error).message,
      };
    }
  }
}
