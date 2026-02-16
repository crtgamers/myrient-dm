/**
 * @fileoverview Módulo de validación centralizado para el proceso main.
 * @module validation
 *
 * Valida y sanitiza: términos de búsqueda, IDs de nodo/descarga, rutas de descarga,
 * URLs (solo HTTPS y hosts permitidos), nombres de archivo y parámetros de descarga/carpeta.
 * Usado por ipcHandlers, ipcStateHandlers y servicios.
 */

import config from '../config';
import { logger } from './logger';
import { VALIDATIONS } from '../constants/validations';
import { ERRORS } from '../constants/errors';
import * as schemasModule from './schemas';
import { sanitizeFilename as sanitizeFilenameHelper } from './fileHelpers';
import path from 'path';
import os from 'os';
import { app } from 'electron';

const log = logger.child('Validation');
const schemas = schemasModule;

export interface ValidationResult<T = unknown> {
  valid: boolean;
  data?: T;
  error?: string;
}

export interface PathValidationResult {
  valid: boolean;
  path?: string;
  error?: string;
}

export interface PreparedDownloadParams {
  id: number;
  title: string;
  url: string | null;
  downloadPath: string | null;
  savePath: string | null;
  priority: number;
  preserveStructure: boolean;
  forceOverwrite: boolean;
  totalBytes: number;
  [key: string]: unknown;
}

export interface DownloadFolderParamsValidated {
  folderId: number;
  downloadPath?: string;
  preserveStructure?: boolean;
  forceOverwrite?: boolean;
  deferStart?: boolean;
  [key: string]: unknown;
}

/**
 * Comprueba que la URL sea HTTPS y que el host esté en config.security.allowedHosts.
 *
 * @param urlString - URL a validar.
 * @returns true si es válida y permitida; false en caso contrario (log de advertencia).
 */
export function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);

    if (url.protocol !== 'https:') {
      log.warn('URL rechazada: protocolo no es HTTPS', urlString);
      return false;
    }

    if (!config.security.allowedHosts.includes(url.hostname)) {
      log.warn(
        `URL rechazada: dominio "${url.hostname}" no está en lista permitida.`,
        `Dominios válidos: ${config.security.allowedHosts.join(', ')}`
      );
      return false;
    }

    return true;
  } catch (error) {
    log.error('URL inválida:', urlString, (error as Error).message);
    return false;
  }
}

/**
 * Escapa caracteres especiales de SQL LIKE (%, _, |) para usar en consultas con LIKE.
 *
 * @param term - Texto a escapar.
 * @returns Texto con |, % y _ escapados para SQLite.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/\|/g, '||').replace(/%/g, '|%').replace(/_/g, '|_');
}

/**
 * Recorta, limita longitud y elimina caracteres potencialmente peligrosos del término de búsqueda.
 *
 * @param term - Término en bruto.
 * @returns Término sanitizado (trim, max length desde config, sin <>"'\\ y espacios múltiples).
 */
export function sanitizeSearchTerm(term: string): string {
  if (typeof term !== 'string') {
    return '';
  }

  const maxLength =
    config.database?.maxSearchTermLength ?? VALIDATIONS.LIMITS.MAX_SEARCH_TERM_LENGTH;
  return term
    .trim()
    .slice(0, maxLength)
    .replace(/[<>'"\\]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Valida que la ruta de descarga esté dentro de directorios permitidos (home, Downloads, Desktop, etc.)
 * y que no contenga path traversal (..). En Windows permite cualquier unidad (C:\, D:\, etc.).
 *
 * @param downloadPath - Ruta indicada por el usuario.
 * @returns Objeto con valid, path resuelto o error.
 */
export function validateAndSanitizeDownloadPath(downloadPath: string): PathValidationResult {
  if (!downloadPath || typeof downloadPath !== 'string') {
    return { valid: false, error: 'Ruta de descarga no proporcionada' };
  }

  try {
    const resolvedPath = path.resolve(downloadPath.trim());

    if (resolvedPath.includes('..')) {
      log.warn(`Intento de path traversal detectado: ${resolvedPath}`);
      return { valid: false, error: 'Ruta de descarga no válida' };
    }

    const allowedBaseDirs = [
      os.homedir(),
      app.getPath('downloads'),
      app.getPath('desktop'),
      app.getPath('documents'),
      path.join(app.getPath('userData'), 'downloads'),
    ].map(dir => path.resolve(dir).toLowerCase());

    const resolvedLower = resolvedPath.toLowerCase();
    let isAllowed = allowedBaseDirs.some(baseDir => {
      const baseWithSep = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
      return resolvedLower === baseDir || resolvedLower.startsWith(baseWithSep);
    });

    if (!isAllowed && process.platform === 'win32') {
      const driveLetterMatch = resolvedPath.match(/^([A-Za-z]):[\\/]/);
      if (driveLetterMatch) {
        isAllowed = true;
      }
    }

    if (!isAllowed) {
      log.warn(`Intento de acceso a ruta no permitida: ${resolvedPath}`);
      return {
        valid: false,
        error:
          'Por seguridad, las descargas solo se permiten en carpetas de usuario (Descargas, Escritorio, etc.)',
      };
    }

    return { valid: true, path: resolvedPath };
  } catch (error) {
    log.error('Error validando ruta de descarga:', error);
    return { valid: false, error: 'Error interno validando la ruta' };
  }
}

export function sanitizeFileName(fileName: string): string {
  if (typeof fileName !== 'string') {
    return 'unnamed';
  }

  let sanitized = sanitizeFilenameHelper(fileName);

  if (sanitized.length > VALIDATIONS.LIMITS.MAX_FILENAME_LENGTH) {
    sanitized = sanitized.slice(0, VALIDATIONS.LIMITS.MAX_FILENAME_LENGTH);
  }

  // Rangos de caracteres de control intencionados para sanitizar nombres de archivo
  /* eslint-disable no-control-regex */
  if (/[<>:"|?*\u0000-\u001f]/.test(sanitized)) {
    sanitized = sanitized.replace(/[<>:"|?*\u0000-\u001f]/g, '_');
  }
  /* eslint-enable no-control-regex */

  if (sanitized.trim().length === 0) {
    sanitized = 'unnamed';
  }

  return sanitized;
}

export function normalizePriority(priority: number | string): number {
  if (typeof priority === 'number' && priority >= 1 && priority <= 3) {
    return priority;
  }
  const map: Record<string, number> = { low: 1, normal: 2, high: 3 };
  return map[String(priority)] ?? 2;
}

export interface ValidateAndPrepareDownloadParamsOptions {
  requireUrl?: boolean;
  requireSavePath?: boolean;
  sanitizeTitle?: boolean;
  validatePath?: boolean;
}

export function validateAndPrepareDownloadParams(
  params: Record<string, unknown>,
  options: ValidateAndPrepareDownloadParamsOptions = {}
): ValidationResult<PreparedDownloadParams> {
  const {
    requireUrl = false,
    requireSavePath = false,
    sanitizeTitle = true,
    validatePath = true,
  } = options;

  if (!params || typeof params !== 'object') {
    return { valid: false, error: 'Parámetros no proporcionados' };
  }

  const id = params.id;
  if (id == null || (typeof id !== 'number' && typeof id !== 'string')) {
    return { valid: false, error: 'ID de archivo inválido' };
  }
  const numericId = typeof id === 'number' ? id : Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return { valid: false, error: 'ID de archivo inválido' };
  }

  if (!params.title || typeof params.title !== 'string') {
    return { valid: false, error: 'Título inválido' };
  }
  const sanitizedTitle = sanitizeTitle
    ? sanitizeFileName(params.title)
    : (params.title as string).trim();
  if (sanitizedTitle.length === 0) {
    return { valid: false, error: 'Título no puede estar vacío' };
  }

  if (requireUrl) {
    if (!params.url || typeof params.url !== 'string') {
      return { valid: false, error: 'URL requerida' };
    }
    if (!isValidUrl(params.url)) {
      return { valid: false, error: 'URL no válida o no permitida' };
    }
  } else if (params.url && typeof params.url === 'string' && !isValidUrl(params.url)) {
    return { valid: false, error: 'URL no válida o no permitida' };
  }

  let downloadPath: string | null = (params.downloadPath as string | undefined) ?? null;
  if (validatePath && downloadPath) {
    const pathValidation = validateAndSanitizeDownloadPath(downloadPath);
    if (!pathValidation.valid) {
      return { valid: false, error: pathValidation.error };
    }
    downloadPath = pathValidation.path ?? null;
  } else if (params.downloadPath && typeof params.downloadPath === 'string') {
    downloadPath = params.downloadPath.trim();
  }

  if (requireSavePath && !params.savePath) {
    return { valid: false, error: 'Ruta de guardado requerida' };
  }

  let savePath: string | null = null;
  if (params.savePath && typeof params.savePath === 'string') {
    const trimmed = params.savePath.trim();
    if (trimmed.length > 0) {
      if (validatePath) {
        const pathValidation = validateAndSanitizeDownloadPath(trimmed);
        if (!pathValidation.valid) {
          return { valid: false, error: pathValidation.error ?? 'Ruta de guardado no válida' };
        }
        savePath = pathValidation.path ?? null;
      } else {
        savePath = trimmed;
      }
    }
  }

  const totalBytes = typeof params.totalBytes === 'number' ? Math.max(0, params.totalBytes) : 0;

  return {
    valid: true,
    data: {
      ...params,
      id: numericId,
      title: sanitizedTitle,
      url: params.url && typeof params.url === 'string' ? params.url.trim() : null,
      downloadPath,
      savePath,
      priority: normalizePriority((params.priority as number | string) ?? 2),
      preserveStructure: params.preserveStructure !== false,
      forceOverwrite: params.forceOverwrite === true,
      totalBytes,
    } as PreparedDownloadParams,
  };
}

export function validateDownloadParams(
  params: Record<string, unknown>
): ValidationResult<PreparedDownloadParams> {
  return validateAndPrepareDownloadParams(params, {
    requireUrl: false,
    requireSavePath: false,
    sanitizeTitle: true,
    validatePath: true,
  });
}

export function validateSearchTerm(searchTerm: string): ValidationResult<string> {
  if (!searchTerm || typeof searchTerm !== 'string') {
    return { valid: false, error: 'Término de búsqueda inválido' };
  }

  const sanitized = sanitizeSearchTerm(searchTerm);

  if (schemas && schemas.validateSearch) {
    const result = schemas.validateSearch(sanitized);
    return {
      valid: result.success,
      data: result.data?.searchTerm,
      error: result.error,
    };
  }

  if (sanitized.length < 2) {
    return { valid: false, error: VALIDATIONS.SEARCH.TERM_MIN_LENGTH };
  }

  const maxLength =
    config.database?.maxSearchTermLength ?? VALIDATIONS.LIMITS.MAX_SEARCH_TERM_LENGTH;
  if (sanitized.length > maxLength) {
    return { valid: false, error: VALIDATIONS.SEARCH.TERM_MAX_LENGTH };
  }

  return { valid: true, data: sanitized };
}

export function validateNodeId(nodeId: unknown): ValidationResult<number> {
  if (schemas && schemas.validateNodeId) {
    const result = schemas.validateNodeId(nodeId);
    return {
      valid: result.success,
      data: result.data,
      error: result.error,
    };
  }

  if (typeof nodeId !== 'number' || !Number.isInteger(nodeId) || nodeId <= 0) {
    return { valid: false, error: 'ID de nodo inválido' };
  }

  return { valid: true, data: nodeId };
}

export function validateDownloadId(downloadId: unknown): ValidationResult<number> {
  if (schemas && schemas.validateDownloadId) {
    const result = schemas.validateDownloadId(downloadId);
    return {
      valid: result.success,
      data: result.data,
      error: result.error,
    };
  }

  if (typeof downloadId !== 'number' || !Number.isInteger(downloadId) || downloadId <= 0) {
    return { valid: false, error: 'ID de descarga inválido' };
  }

  return { valid: true, data: downloadId };
}

export function validateConfigFilename(filename: unknown): ValidationResult<string> {
  if (schemas && schemas.validateConfigFilename) {
    const result = schemas.validateConfigFilename(filename);
    return {
      valid: result.success,
      data: result.data,
      error: result.error,
    };
  }

  if (!filename || typeof filename !== 'string') {
    return { valid: false, error: 'Nombre de archivo inválido' };
  }

  if (!filename.endsWith('.json')) {
    return { valid: false, error: 'El archivo debe ser .json' };
  }

  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return { valid: false, error: 'Nombre de archivo no permitido' };
  }

  return { valid: true, data: filename };
}

export function validateDownloadFolderParams(
  params: Record<string, unknown>
): ValidationResult<DownloadFolderParamsValidated> {
  if (!params) {
    return { valid: false, error: 'Parámetros no proporcionados' };
  }

  // Validar con Zod schema si disponible
  if (schemas && schemas.validateDownloadFolderParamsZod) {
    const zodResult = schemas.validateDownloadFolderParamsZod(params);
    if (!zodResult.success) {
      return { valid: false, error: zodResult.error };
    }
  } else {
    // Fallback manual
    if (!params.folderId || typeof params.folderId !== 'number') {
      return { valid: false, error: 'ID de carpeta inválido' };
    }
  }

  const resultData: DownloadFolderParamsValidated = { ...params } as DownloadFolderParamsValidated;

  if (resultData.downloadPath) {
    const pathValidation = validateAndSanitizeDownloadPath(resultData.downloadPath);
    if (!pathValidation.valid) {
      return { valid: false, error: pathValidation.error };
    }
    resultData.downloadPath = pathValidation.path;
  }

  return { valid: true, data: resultData };
}

/**
 * Mapea códigos de error de red (ENOTFOUND, ETIMEDOUT, etc.) a mensajes localizados de ERRORS.NETWORK.
 *
 * @param error - Error con propiedad code opcional.
 * @returns Mensaje de error amigable o error.message si no hay mapeo.
 */
export function getNetworkErrorMessage(error: Error & { code?: string }): string {
  const errorMessages: Record<string, string> = {
    ENOTFOUND: ERRORS.NETWORK.CONNECTION_FAILED,
    ETIMEDOUT: ERRORS.NETWORK.TIMEOUT,
    ECONNREFUSED: ERRORS.NETWORK.CONNECTION_REFUSED,
    ECONNRESET: ERRORS.NETWORK.CONNECTION_RESET,
    EPIPE: ERRORS.NETWORK.CONNECTION_CLOSED,
    EHOSTUNREACH: ERRORS.NETWORK.HOST_UNREACHABLE,
  };

  return (error.code && errorMessages[error.code]) || error.message;
}

export { VALIDATIONS };
