/**
 * Lógica de negocio para archivos y rutas: validación, normalización, construcción de savePath.
 *
 * validateFilePath, validateFilename, normalizeFilePath; buildSavePath (base + filename + preserveStructure
 * + relativePath); prepareDirectory (crear o comprobar directorio y permisos); checkFileExists,
 * getFileCheckInfo (para sobrescritura/archivo existente). Usado por ipcStateHandlers (enriquecer
 * savePath) y por el motor para validar antes de escribir.
 *
 * @module FileService
 */

import BaseService, { ServiceResponse } from './BaseService';
import path from 'path';
import fs from 'fs';
import config from '../config';
import { sanitizeFilename } from '../utils';
import { VALIDATIONS } from '../constants/validations';

export interface FileValidationResult {
  valid: boolean;
  data?: string;
  original?: string;
  error?: string;
}

export interface FileCheckResult {
  exists: boolean;
  actualSize?: number;
  expectedSize: number;
  sizeDifference?: number;
  similarSize?: boolean;
  shouldOverwrite?: boolean;
  error?: string;
  path?: string;
  isFile?: boolean;
  isDirectory?: boolean;
  size?: number;
  stats?: fs.Stats;
}

export interface BuildSavePathResult {
  success: boolean;
  savePath?: string;
  basePath?: string;
  filename?: string;
  directory?: string;
  error?: string;
}

export interface PrepareDirectoryResult {
  success: boolean;
  directory?: string;
  created?: boolean;
  error?: string;
}

export default class FileService extends BaseService {
  constructor() {
    super('FileService');
  }

  /** Comprueba que la ruta sea válida, no vacía y no sea la raíz del sistema. */
  validateFilePath(filePath: string | null | undefined): FileValidationResult | ServiceResponse {
    try {
      if (!filePath || typeof filePath !== 'string') {
        return { valid: false, error: 'Ruta de archivo requerida' };
      }

      const normalized = path.resolve(filePath);

      if (!normalized || normalized.trim().length === 0) {
        return { valid: false, error: 'Ruta de archivo inválida' };
      }

      if (normalized === path.parse(normalized).root) {
        return {
          valid: false,
          error: 'No se puede usar la raíz del sistema como ruta',
        };
      }

      return { valid: true, data: normalized, original: filePath };
    } catch (error) {
      return this.handleError(error as Error & { code?: string }, 'validateFilePath');
    }
  }

  normalizeFilePath(filePath: string | null | undefined): string {
    try {
      if (!filePath || typeof filePath !== 'string') return '';
      return path.normalize(path.resolve(filePath));
    } catch (error) {
      this.log.warn('Error normalizando ruta de archivo:', (error as Error).message);
      return filePath ?? '';
    }
  }

  /** Sanitiza el nombre y comprueba longitud y caracteres prohibidos (<>:"|?*\\/). */
  validateFilename(filename: string | null | undefined): FileValidationResult | ServiceResponse {
    try {
      if (!filename || typeof filename !== 'string') {
        return { valid: false, error: 'Nombre de archivo requerido' };
      }

      const sanitized = sanitizeFilename(filename);

      if (!sanitized || sanitized.trim().length === 0) {
        return { valid: false, error: 'Nombre de archivo inválido después de sanitizar' };
      }

      const maxLength = 255;
      if (sanitized.length > maxLength) {
        return {
          valid: false,
          error: `Nombre de archivo demasiado largo (máximo ${maxLength} caracteres)`,
        };
      }

      const prohibitedChars = /[<>:"|?*\\/]/;
      if (prohibitedChars.test(sanitized)) {
        return { valid: false, error: 'Nombre de archivo contiene caracteres prohibidos' };
      }

      return { valid: true, data: sanitized, original: filename };
    } catch (error) {
      return this.handleError(error as Error & { code?: string }, 'validateFilename');
    }
  }

  /**
   * Construye la ruta final de guardado: basePath + (opcional) relativePath sanitizado + filename.
   * Valida basePath y filename antes; devuelve success, savePath, directory.
   */
  buildSavePath(
    basePath: string,
    filename: string,
    preserveStructure = true,
    relativePath = ''
  ): BuildSavePathResult | ServiceResponse {
    try {
      const baseValidation = this.validateFilePath(basePath);
      const baseValid = 'valid' in baseValidation ? baseValidation.valid : false;
      if (!baseValid) {
        return {
          success: false,
          error: (baseValidation as FileValidationResult).error,
        };
      }

      const normalizedBase = (baseValidation as FileValidationResult).data!;

      const filenameValidation = this.validateFilename(filename);
      const nameValid = 'valid' in filenameValidation ? filenameValidation.valid : false;
      if (!nameValid) {
        return {
          success: false,
          error: (filenameValidation as FileValidationResult).error,
        };
      }

      const sanitizedFilename = (filenameValidation as FileValidationResult).data!;

      let savePath = normalizedBase;

      if (preserveStructure && relativePath) {
        const segments = relativePath
          .split(path.sep)
          .map(segment => {
            const validation = this.validateFilename(segment);
            return 'valid' in validation && validation.valid ? validation.data! : null;
          })
          .filter((segment): segment is string => segment !== null && segment.length > 0);

        if (segments.length > 0) {
          savePath = path.join(savePath, ...segments);
        }
      }

      savePath = path.join(savePath, sanitizedFilename);
      savePath = this.normalizeFilePath(savePath);

      return {
        success: true,
        savePath,
        basePath: normalizedBase,
        filename: sanitizedFilename,
        directory: path.dirname(savePath),
      };
    } catch (error) {
      return this.handleError(error as Error & { code?: string }, 'buildSavePath');
    }
  }

  async prepareDirectory(directoryPath: string): Promise<PrepareDirectoryResult | ServiceResponse> {
    try {
      const validation = this.validateFilePath(directoryPath);
      const valid = 'valid' in validation ? validation.valid : false;
      if (!valid) {
        return { success: false, error: (validation as FileValidationResult).error };
      }

      const normalizedPath = (validation as FileValidationResult).data!;

      try {
        const stats = await fs.promises.stat(normalizedPath);
        if (!stats.isDirectory()) {
          return {
            success: false,
            error: VALIDATIONS.PATH.NOT_A_DIRECTORY,
          };
        }

        try {
          await fs.promises.access(normalizedPath, fs.constants.W_OK);
        } catch (permErr) {
          this.log.debug?.(
            'Sin permisos de escritura en directorio:',
            normalizedPath,
            (permErr as Error)?.message
          );
          return {
            success: false,
            error: 'No se tienen permisos de escritura en el directorio',
          };
        }

        return {
          success: true,
          directory: normalizedPath,
          created: false,
        };
      } catch (statError) {
        const err = statError as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          try {
            await fs.promises.mkdir(normalizedPath, { recursive: true });

            const verifyStats = await fs.promises.stat(normalizedPath);
            if (!verifyStats.isDirectory()) {
              return { success: false, error: 'No se pudo crear el directorio' };
            }

            return {
              success: true,
              directory: normalizedPath,
              created: true,
            };
          } catch (mkdirError) {
            return {
              success: false,
              error: `Error creando directorio: ${(mkdirError as Error).message}`,
            };
          }
        }

        return {
          success: false,
          error: `Error verificando directorio: ${err.message}`,
        };
      }
    } catch (error) {
      return this.handleError(error as Error & { code?: string }, 'prepareDirectory');
    }
  }

  async checkFileExists(filePath: string): Promise<
    | {
        exists: boolean;
        isFile?: boolean;
        isDirectory?: boolean;
        size?: number;
        path?: string;
        stats?: fs.Stats;
        error?: string;
      }
    | ServiceResponse
  > {
    try {
      const validation = this.validateFilePath(filePath);
      const valid = 'valid' in validation ? validation.valid : false;
      if (!valid) {
        return { exists: false, error: (validation as FileValidationResult).error };
      }

      const normalizedPath = (validation as FileValidationResult).data!;

      try {
        const stats = await fs.promises.stat(normalizedPath);
        return {
          exists: true,
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          size: stats.size,
          path: normalizedPath,
          stats,
        };
      } catch (statError) {
        const err = statError as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          return { exists: false, path: normalizedPath };
        }
        return {
          exists: false,
          error: `Error verificando archivo: ${err.message}`,
          path: normalizedPath,
        };
      }
    } catch (error) {
      return this.handleError(error as Error & { code?: string }, 'checkFileExists');
    }
  }

  async getFileCheckInfo(filePath: string, expectedSize = 0): Promise<FileCheckResult> {
    try {
      const fileInfo = await this.checkFileExists(filePath);

      if (
        !('exists' in fileInfo) ||
        !fileInfo.exists ||
        !('isFile' in fileInfo) ||
        !fileInfo.isFile
      ) {
        return {
          exists: false,
          expectedSize,
          shouldOverwrite: false,
          sizeDifference: 0,
        };
      }

      const actualSize = fileInfo.size ?? 0;
      const sizeDifference = Math.abs(actualSize - expectedSize);
      const sizeMargin =
        (config.files as { sizeMarginBytes?: number } | undefined)?.sizeMarginBytes ?? 10240;
      const similarSize = sizeDifference <= sizeMargin;

      return {
        exists: true,
        shouldOverwrite: similarSize && expectedSize > 0,
        actualSize,
        expectedSize,
        sizeDifference,
        similarSize,
        path: filePath,
      };
    } catch (error) {
      this.log.warn('Error obteniendo información de archivo:', (error as Error).message);
      return {
        exists: false,
        expectedSize: 0,
        shouldOverwrite: false,
        sizeDifference: 0,
        error: (error as Error).message,
      };
    }
  }
}
