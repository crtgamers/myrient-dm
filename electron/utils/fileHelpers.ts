/**
 * @fileoverview Utilidades para operaciones con archivos y sanitización de nombres
 * @module fileHelpers
 */

import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import config from '../config';
import { MAX_FILENAME_LENGTH } from '../constants/validations';
import { logger } from './logger';

const log = logger.child('FileUtils');

/**
 * fs.statfs (Node 19.6+ / 20.x+) para espacio en disco sin depender del shell.
 * - Windows: sí; usa GetDiskFreeSpaceEx (libuv). Compatible con las versiones de Windows soportadas por Node/Electron.
 * - Linux/macOS: usa statvfs. Sin requisitos extra de versión de SO.
 */
const statfsPromise: ((_path: string) => Promise<{ bsize: number; bavail: number }>) | null =
  typeof (fsPromises as { statfs?: (_path: string) => Promise<{ bsize: number; bavail: number }> })
    .statfs === 'function'
    ? (fsPromises as { statfs: (_path: string) => Promise<{ bsize: number; bavail: number }> })
        .statfs
    : null;

export interface FileCheckResult {
  exists: boolean;
  existingSize?: number;
  expectedSize?: number;
  sizeDifference?: number;
  similarSize?: boolean;
}

export function sanitizeFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') return 'unnamed';

  let sanitized = filename
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\\/g, '_')
    .replace(/\//g, '_')
    // Caracteres de control y DEL intencionados para sanitizar
    /* eslint-disable-next-line no-control-regex */
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();

  const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
  if (reservedNames.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  if (sanitized.length > MAX_FILENAME_LENGTH) {
    sanitized = sanitized.slice(0, MAX_FILENAME_LENGTH);
  }

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    sanitized = 'unnamed';
  }

  return sanitized;
}

export function sanitizePath(pathStr: string): string {
  return pathStr
    .split(path.sep)
    .map(part => sanitizeFilename(part))
    .join(path.sep);
}

export function checkFileExists(filePath: string, expectedSize: number): FileCheckResult {
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const existingSize = stats.size;
      const sizeDifference = Math.abs(existingSize - expectedSize);

      return {
        exists: true,
        existingSize,
        expectedSize,
        sizeDifference,
        similarSize: sizeDifference <= config.files.sizeMarginBytes,
      };
    }
    return { exists: false };
  } catch (error) {
    log.error('Error al verificar archivo:', error);
    return { exists: false };
  }
}

/**
 * Lee un archivo JSON desde el directorio de configuración (async, no bloquea el event loop).
 */
export async function readJSONFile(filename: string): Promise<unknown> {
  const filePath = path.join(config.paths.configPath, filename);
  try {
    await fsPromises.access(filePath);
    const data = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return null;
    }
    log.error(`Error leyendo ${filename}:`, error);
    return null;
  }
}

/**
 * Escribe un objeto como JSON en el directorio de configuración (async, no bloquea el event loop).
 */
export async function writeJSONFile(filename: string, data: unknown): Promise<boolean> {
  const filePath = path.join(config.paths.configPath, filename);
  try {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    log.error(`Error escribiendo ${filename}:`, error);
    return false;
  }
}

export function ensureDirectoryExists(dirPath: string): boolean {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return true;
  } catch (error) {
    log.error('Error creando directorio:', error);
    return false;
  }
}

export function hasWritePermission(dirPath: string): boolean {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch (accessErr) {
    log.debug?.('Sin permisos de escritura en:', dirPath, (accessErr as Error)?.message);
    return false;
  }
}

/** TTL de la caché de espacio en disco (ms). Misma ruta no se consulta de nuevo en este tiempo. */
const DISK_SPACE_CACHE_TTL_MS = 15_000;

const diskSpaceCache = new Map<string, { bytes: number; ts: number }>();

/**
 * Ejecuta un comando en un proceso hijo con timeout (no bloquea el event loop).
 */
function runCommandAsync(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Timeout después de ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('close', (code, _signal) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `Salida con código ${code}`));
      }
    });
    proc.on('error', err => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

/**
 * Comprueba si una ruta existe (archivo o directorio).
 */
async function pathExists(fileOrDir: string): Promise<boolean> {
  try {
    await fsPromises.access(fileOrDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Obtiene el espacio libre en disco para la ruta dada (async, no bloquea el main).
 * Acepta tanto rutas de archivo (ej. destino de descarga) como de directorio.
 * Si la ruta no existe aún, se usa el directorio padre y se sube hasta un directorio existente o la raíz del disco.
 * Resultado cacheado por ruta/unidad durante DISK_SPACE_CACHE_TTL_MS.
 */
export async function getAvailableDiskSpace(directoryPath: string): Promise<number | null> {
  const timeoutMs = 5000;
  let dirToCheck: string;
  try {
    const normalizedPath = path.resolve(directoryPath);
    try {
      const stats = await fsPromises.stat(normalizedPath);
      dirToCheck = stats.isDirectory() ? normalizedPath : path.dirname(normalizedPath);
    } catch {
      // Ruta inexistente (ej. archivo que aún no se ha descargado): usar directorio padre
      dirToCheck = path.dirname(normalizedPath);
    }
    // Si el directorio padre tampoco existe, subir hasta uno existente o la raíz del disco
    const root = path.parse(normalizedPath).root;
    while (dirToCheck !== root && !(await pathExists(dirToCheck))) {
      dirToCheck = path.dirname(dirToCheck);
    }
    if (dirToCheck !== root && !(await pathExists(dirToCheck))) {
      dirToCheck = root;
    }
  } catch (error) {
    log.warn('Error resolviendo ruta para espacio en disco:', (error as Error).message);
    return null;
  }

  const cacheKey =
    process.platform === 'win32' ? dirToCheck.replace(/^([A-Za-z]:).*$/i, '$1') : dirToCheck;
  const now = Date.now();
  const cached = diskSpaceCache.get(cacheKey);
  if (cached && now - cached.ts < DISK_SPACE_CACHE_TTL_MS) {
    return cached.bytes;
  }

  try {
    // Todas las plataformas: usar fs.statfs si está disponible (Node 19.6+ / 20.x+), incl. Windows
    if (statfsPromise) {
      try {
        const stats = await statfsPromise(dirToCheck);
        if (
          typeof stats.bsize === 'number' &&
          typeof stats.bavail === 'number' &&
          stats.bsize > 0 &&
          stats.bavail >= 0
        ) {
          const bytes = stats.bsize * stats.bavail;
          diskSpaceCache.set(cacheKey, { bytes, ts: now });
          return bytes;
        }
      } catch (statfsErr) {
        log.debug('statfs falló, usando fallback por plataforma:', (statfsErr as Error).message);
      }
    }

    // Fallback Windows: PowerShell Get-CimInstance
    if (process.platform === 'win32') {
      const driveMatch = dirToCheck.match(/^([A-Za-z]):/i);
      if (!driveMatch) {
        log.warn('No se pudo extraer unidad de disco de:', dirToCheck);
        return null;
      }
      const driveLetter = driveMatch[1] + ':';
      const psScript = `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${driveLetter}'").FreeSpace`;
      try {
        const result = await runCommandAsync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', psScript],
          timeoutMs
        );
        const trimmed = result.trim();
        const freeSpace = trimmed ? parseInt(trimmed, 10) : NaN;
        if (Number.isInteger(freeSpace) && freeSpace >= 0) {
          diskSpaceCache.set(cacheKey, { bytes: freeSpace, ts: now });
          return freeSpace;
        }
        log.warn('No se pudo parsear espacio libre de PowerShell:', trimmed || result);
      } catch (psErr) {
        log.warn('PowerShell falló para espacio en disco:', (psErr as Error).message);
      }
      return null;
    }

    // Fallback Linux/macOS: df -k. Columna 4 = Available en bloques de 1K.
    const safePath = dirToCheck.replace(/'/g, "'\\''");
    const result = await runCommandAsync(
      'sh',
      ['-c', `df -k '${safePath}' | tail -1 | awk '{print $4}'`],
      timeoutMs
    );
    const freeSpaceKB = parseInt(result.trim(), 10);
    if (isNaN(freeSpaceKB) || freeSpaceKB < 0) {
      log.warn('No se pudo parsear espacio libre de df:', result.trim() || result);
      return null;
    }
    const bytes = freeSpaceKB * 1024;
    diskSpaceCache.set(cacheKey, { bytes, ts: now });
    return bytes;
  } catch (error) {
    const msg = (error as Error).message || String(error) || 'Error desconocido';
    log.warn('Error obteniendo espacio en disco:', msg);
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  if (bytes < 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

export interface ValidateDiskSpaceResult {
  valid: boolean;
  error?: string;
  warning?: boolean;
  available?: number;
  required?: number;
}

/**
 * Valida que haya espacio suficiente en disco (async, no bloquea el main).
 */
export async function validateDiskSpace(
  filePath: string,
  expectedSize: number
): Promise<ValidateDiskSpaceResult> {
  if (!expectedSize || expectedSize <= 0) {
    return { valid: true, warning: true };
  }

  const availableSpace = await getAvailableDiskSpace(filePath);

  if (availableSpace === null) {
    log.warn('No se pudo verificar espacio en disco, continuando con precaución');
    return { valid: true, warning: true };
  }

  const requiredSpace = expectedSize * 1.1;

  if (availableSpace < requiredSpace) {
    return {
      valid: false,
      error: `Espacio insuficiente en disco: se requieren ${formatBytes(requiredSpace)}, disponibles ${formatBytes(availableSpace)}`,
      available: availableSpace,
      required: requiredSpace,
    };
  }

  return { valid: true };
}

export function safeUnlink(filePath: string, retryDelay = 1000): void {
  if (!filePath || !fs.existsSync(filePath)) return;

  fs.unlink(filePath, err => {
    if (err) {
      log.error('Error eliminando archivo:', {
        path: filePath,
        error: err.message,
        code: err.code,
      });

      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        log.warn('Archivo en uso, reintentando en', retryDelay, 'ms');
        setTimeout(() => {
          fs.unlink(filePath, retryErr => {
            if (retryErr) {
              log.error('Reintento fallido:', retryErr.message);
            }
          });
        }, retryDelay);
      }
    }
  });
}
