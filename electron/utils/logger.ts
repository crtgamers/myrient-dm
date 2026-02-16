/**
 * @fileoverview Sistema de logging centralizado para el proceso main (electron-log).
 * @module utils/logger
 *
 * Proporciona logger con scope (child), formato de objetos, operaciones cronometradas,
 * envío opcional de logs al renderer vía IPC y limpieza de archivos antiguos.
 */

import log from 'electron-log';
import path from 'path';
import { app } from 'electron';
import { promises as fs } from 'fs';

export type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly';

export interface ConfigureLoggerOptions {
  fileLevel?: string;
  consoleLevel?: string;
  maxSize?: number;
  isDev?: boolean;
}

type MainWindowGetter = () => import('electron').BrowserWindow | null;

let getMainWindowFn: MainWindowGetter | null = null;

/**
 * Registra la función que devuelve la ventana principal; usada por el transport IPC para enviar logs al renderer.
 *
 * @param fn - Getter que devuelve BrowserWindow | null.
 */
export function setMainWindowGetter(fn: MainWindowGetter): void {
  getMainWindowFn = fn;
}

/**
 * Convierte un valor a string para logging: Errors con stack, objetos a JSON, primitivos a String.
 *
 * @param obj - Cualquier valor.
 * @returns Representación en string para logs.
 */
export function formatObject(obj: unknown): string {
  if (obj === null) return 'null';
  if (obj === undefined) return 'undefined';
  if (typeof obj === 'string') return obj;
  if (obj instanceof Error) {
    return `${obj.message}\n${obj.stack ?? ''}`;
  }
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

export interface ScopedLogger {
  error: (..._args: unknown[]) => void;
  warn: (..._args: unknown[]) => void;
  info: (..._args: unknown[]) => void;
  verbose: (..._args: unknown[]) => void;
  debug: (..._args: unknown[]) => void;
  silly: (..._args: unknown[]) => void;
  log: (..._args: unknown[]) => void;
  startOperation: (_operation: string) => (_result?: string) => void;
  object: (_label: string, _obj: unknown) => void;
  separator: (_title?: string) => void;
  child: (_subScope: string) => ScopedLogger;
  _raw: ReturnType<typeof log.scope>;
}

const childLoggers = new Map<string, ScopedLogger>();

export function createScopedLogger(scope: string): ScopedLogger {
  const existing = childLoggers.get(scope);
  if (existing) return existing;

  const baseChildLog = log.scope(scope);

  const logMethod =
    (method: 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly') =>
    (...args: unknown[]) => {
      if (
        args.length === 2 &&
        typeof args[0] === 'string' &&
        typeof args[1] === 'object' &&
        args[1] !== null
      ) {
        (baseChildLog[method] as (_msg: string, _obj: unknown) => void)(
          `${args[0]}`,
          formatObject(args[1])
        );
      } else {
        (baseChildLog[method] as (..._a: unknown[]) => void)(...args);
      }
    };

  const extendedChildLog: ScopedLogger = {
    error: logMethod('error'),
    warn: logMethod('warn'),
    info: logMethod('info'),
    verbose: logMethod('verbose'),
    debug: logMethod('debug'),
    silly: logMethod('silly'),
    log: logMethod('info'),
    startOperation(operation: string) {
      const start = Date.now();
      baseChildLog.info(`▶ Iniciando: ${operation}`);
      return (result = 'completado') => {
        const duration = Date.now() - start;
        baseChildLog.info(`✓ ${operation}: ${result} (${duration}ms)`);
      };
    },
    object(label: string, obj: unknown) {
      baseChildLog.info(`${label}:\n${formatObject(obj)}`);
    },
    separator(title = '') {
      if (title) {
        baseChildLog.info(`${'='.repeat(20)} ${title} ${'='.repeat(20)}`);
      } else {
        baseChildLog.info('='.repeat(50));
      }
    },
    child(subScope: string) {
      return createScopedLogger(`${scope}:${subScope}`);
    },
    _raw: baseChildLog,
  };

  childLoggers.set(scope, extendedChildLog);
  return extendedChildLog;
}

/**
 * Configura el logger global (archivo, consola, IPC al renderer).
 * Por defecto: fileLevel 'info', consoleLevel 'debug', maxSize 10 MB.
 * En producción la consola y el transport IPC usan nivel 'warn'.
 */
export function configureLogger(options: ConfigureLoggerOptions = {}): typeof log {
  const {
    fileLevel = 'info',
    consoleLevel = 'debug',
    maxSize = 10 * 1024 * 1024,
    isDev = process.env.NODE_ENV === 'development' || !app?.isPackaged,
  } = options;

  log.transports.file.level = fileLevel as import('electron-log').LevelOption;
  log.transports.file.maxSize = maxSize;

  log.transports.file.archiveLogFn = (oldLogFile: { path: string }) => {
    const info = path.parse(oldLogFile.path);
    const timestamp = new Date().toISOString().split('T')[0];
    return path.join(info.dir, `${info.name}-${timestamp}${info.ext}`);
  };

  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}';

  log.transports.console.level = (
    isDev ? consoleLevel : 'warn'
  ) as import('electron-log').LevelOption;
  log.transports.console.format = '[{h}:{i}:{s}] [{level}]{scope} {text}';
  log.transports.console.useStyles = true;

  const ipcTransport = (info: { scope?: string; data?: unknown; text?: string; level: string }) => {
    try {
      if (info.scope && info.scope.startsWith('Frontend')) {
        return;
      }
      if (!isDev && info.level !== 'warn' && info.level !== 'error') {
        return;
      }
      if (getMainWindowFn) {
        const mainWindow = getMainWindowFn();
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          const logEntry = {
            timestamp: new Date().toISOString(),
            level: info.level.toUpperCase(),
            scope: info.scope || null,
            message: info.data ?? [info.text],
            mode: isDev ? 'development' : 'production',
            source: 'backend',
          };
          mainWindow.webContents.send('backend-log', logEntry);
        }
      }
    } catch {
      // No usar log aquí para evitar recursión infinita en el transport IPC
    }
  };

  (ipcTransport as { level?: string }).level = isDev ? 'debug' : 'warn';
  (log.transports as Record<string, unknown>).ipc = ipcTransport;

  log.errorHandler.startCatching({
    showDialog: false,
    onError: (options: { error: Error }) => {
      log.error('Error no capturado:', options.error);
    },
  });

  log.info('='.repeat(50));
  log.info('Logger inicializado');
  log.info(`Modo: ${isDev ? 'Desarrollo' : 'Producción'}`);
  log.info(`Archivo de log: ${log.transports.file.getFile()?.path ?? 'No disponible'}`);
  log.info('='.repeat(50));

  return log;
}

/** Ruta absoluta del archivo de log actual, o null si no está configurado. */
export function getLogFilePath(): string | null {
  const file = log.transports.file.getFile();
  return file?.path ?? null;
}

/** Directorio donde se escriben los archivos de log, o null. */
export function getLogDirectory(): string | null {
  const filePath = getLogFilePath();
  return filePath ? path.dirname(filePath) : null;
}

/**
 * Elimina archivos .log del directorio de logs cuya fecha de modificación
 * sea anterior a daysToKeep días. Por defecto 30 días; en main.ts se llama
 * con 5 para una retención real de 5 días.
 * @param daysToKeep - Días a conservar (por defecto 30)
 * @see docs/LOGGING.md
 */
export async function cleanOldLogs(daysToKeep = 30): Promise<void> {
  const logDir = getLogDirectory();
  if (!logDir) {
    log.warn('No se pudo obtener el directorio de logs');
    return;
  }
  try {
    const files = await fs.readdir(logDir);
    const now = Date.now();
    const maxAge = daysToKeep * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      const filePath = path.join(logDir, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtime.getTime() > maxAge) {
        await fs.unlink(filePath);
        log.info(`Log antiguo eliminado: ${file}`);
      }
    }
  } catch (error) {
    log.error('Error limpiando logs antiguos:', error);
  }
}

export interface LoggerInstance {
  error: (..._args: unknown[]) => void;
  warn: (..._args: unknown[]) => void;
  info: (..._args: unknown[]) => void;
  verbose: (..._args: unknown[]) => void;
  debug: (..._args: unknown[]) => void;
  silly: (..._args: unknown[]) => void;
  log: (..._args: unknown[]) => void;
  child: (_scope: string) => ScopedLogger;
  startOperation: (_operation: string) => (_result?: string) => void;
  object: (_label: string, _obj: unknown) => void;
  separator: (_title?: string) => void;
  getFilePath: typeof getLogFilePath;
  getDirectory: typeof getLogDirectory;
  cleanOldLogs: typeof cleanOldLogs;
  configure: typeof configureLogger;
  _raw: typeof log;
}

export const logger: LoggerInstance = {
  error: (...args: unknown[]) => log.error(...args),
  warn: (...args: unknown[]) => log.warn(...args),
  info: (...args: unknown[]) => log.info(...args),
  verbose: (...args: unknown[]) => log.verbose(...args),
  debug: (...args: unknown[]) => log.debug(...args),
  silly: (...args: unknown[]) => log.silly(...args),
  log: (...args: unknown[]) => log.info(...args),
  child: (scope: string) => createScopedLogger(scope),
  startOperation(operation: string) {
    const start = Date.now();
    log.info(`▶ Iniciando: ${operation}`);
    return (result = 'completado') => {
      const duration = Date.now() - start;
      log.info(`✓ ${operation}: ${result} (${duration}ms)`);
    };
  },
  object(label: string, obj: unknown) {
    log.info(`${label}:\n${formatObject(obj)}`);
  },
  separator(title = '') {
    if (title) {
      log.info(`${'='.repeat(20)} ${title} ${'='.repeat(20)}`);
    } else {
      log.info('='.repeat(50));
    }
  },
  getFilePath: getLogFilePath,
  getDirectory: getLogDirectory,
  cleanOldLogs,
  configure: configureLogger,
  _raw: log,
};

export { logger as log };
export { log as electronLog };
