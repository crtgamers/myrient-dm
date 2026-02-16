/**
 * @fileoverview Sistema de logging centralizado para el frontend (renderer).
 * @module logger
 *
 * Mantiene un buffer en memoria de entradas, suscribe logs del backend (backend-log),
 * reenvía logs al main vía window.api.log y expone getLogs, exportLogs, saveLogsToFile.
 */

import { API_ERRORS, GENERAL_ERRORS } from '../constants/errors';

const isDev = import.meta.env.DEV || import.meta.env.MODE === 'development';

const MAX_LOG_ENTRIES = 1000;
const logs: LogEntry[] = [];
const logListeners = new Set<(_entry: LogEntry) => void>();

let backendLogUnsubscribe: (() => void) | null = null;

function setupBackendLogListener(): void {
  try {
    const api = window.api;
    if (!api || typeof api.on !== 'function' || backendLogUnsubscribe) {
      return;
    }
    console.log('[Logger] Configurando listener de logs del backend...');
    backendLogUnsubscribe = api.on('backend-log', (logEntry: unknown) => {
      addToMemory(logEntry as LogEntry);
    });
  } catch {
    console.warn('[Logger] No se pudo configurar listener de logs del backend');
  }
}

if (typeof window !== 'undefined') {
  const checkApi = setInterval(() => {
    if (window.api) {
      setupBackendLogListener();
      clearInterval(checkApi);
    }
  }, 100);
  setTimeout(() => clearInterval(checkApi), 10000);
}

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MIN_LOG_LEVEL = isDev ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO;

export interface LogEntry {
  timestamp: string;
  level: string;
  scope: string;
  message: unknown[];
  mode: string;
}

function formatLogEntry(level: string, scope: string | null, args: unknown[]): LogEntry {
  const timestamp = new Date().toISOString();
  const message = args.map(arg => {
    if (arg instanceof Error) {
      return { type: 'error', message: arg.message, stack: arg.stack };
    }
    if (typeof arg === 'object') {
      try {
        return JSON.parse(JSON.stringify(arg));
      } catch {
        return String(arg);
      }
    }
    return arg;
  });

  return {
    timestamp,
    level,
    scope: scope || 'App',
    message,
    mode: isDev ? 'development' : 'production',
  };
}

function addToMemory(entry: LogEntry): void {
  logs.push(entry);
  if (logs.length > MAX_LOG_ENTRIES) {
    logs.shift();
  }
  logListeners.forEach(listener => {
    try {
      listener(entry);
    } catch {
      // ignore
    }
  });
}

async function sendToBackend(entry: LogEntry): Promise<void> {
  try {
    const api = window.api;
    if (api && api.log) {
      await api.log(entry as unknown as Record<string, unknown>);
    }
  } catch (error) {
    console.error('[Logger] Error enviando log al backend:', error);
  }
}

function processLog(level: number, levelName: string, scope: string | null, args: unknown[]): void {
  if (level < MIN_LOG_LEVEL) return;

  const entry = formatLogEntry(levelName, scope, args);
  addToMemory(entry);
  sendToBackend(entry).catch(() => {});
  if (isDev) {
    const consoleMethod =
      (
        {
          DEBUG: console.debug,
          INFO: console.log,
          WARN: console.warn,
          ERROR: console.error,
        } as Record<string, (..._a: unknown[]) => void>
      )[levelName] ?? console.log;
    const prefix = scope ? `[${scope}]` : '';
    consoleMethod(`[${levelName}]${prefix}`, ...args);
  }
}

export interface GetLogsOptions {
  level?: string;
  scope?: string;
  limit?: number;
}

export interface ScopedLogger {
  debug: (..._args: unknown[]) => void;
  info: (..._args: unknown[]) => void;
  warn: (..._args: unknown[]) => void;
  error: (..._args: unknown[]) => void;
  log: (..._args: unknown[]) => void;
  child: (_subScope: string) => ScopedLogger;
}

function createScopedLogger(scope: string | null): ScopedLogger {
  return {
    debug: (...args: unknown[]) => processLog(LOG_LEVELS.DEBUG, 'DEBUG', scope, args),
    info: (...args: unknown[]) => processLog(LOG_LEVELS.INFO, 'INFO', scope, args),
    warn: (...args: unknown[]) => processLog(LOG_LEVELS.WARN, 'WARN', scope, args),
    error: (...args: unknown[]) => processLog(LOG_LEVELS.ERROR, 'ERROR', scope, args),
    log: (...args: unknown[]) => processLog(LOG_LEVELS.INFO, 'INFO', scope, args),
    child: (subScope: string) => createScopedLogger(scope ? `${scope}:${subScope}` : subScope),
  };
}

export interface LoggerInstance extends ScopedLogger {
  getLogs: (_options?: GetLogsOptions) => LogEntry[];
  clearLogs: () => void;
  onLog: (_callback: (_entry: LogEntry) => void) => () => void;
  exportLogs: (_options?: GetLogsOptions) => string;
  saveLogsToFile: (
    _options?: GetLogsOptions,
    _dialogOptions?: {
      title: string;
      filterText: string;
      filterAll: string;
      canceledMessage: string;
    }
  ) => Promise<{ success: boolean; error?: string; path?: string }>;
  initBackendListener: () => void;
}

const logger: LoggerInstance = {
  debug: (...args: unknown[]) => processLog(LOG_LEVELS.DEBUG, 'DEBUG', null, args),
  info: (...args: unknown[]) => processLog(LOG_LEVELS.INFO, 'INFO', null, args),
  warn: (...args: unknown[]) => processLog(LOG_LEVELS.WARN, 'WARN', null, args),
  error: (...args: unknown[]) => processLog(LOG_LEVELS.ERROR, 'ERROR', null, args),
  log: (...args: unknown[]) => processLog(LOG_LEVELS.INFO, 'INFO', null, args),
  child: (scope: string) => createScopedLogger(scope),

  getLogs: (options: GetLogsOptions = {}) => {
    let filtered = [...logs];
    if (options.level) {
      filtered = filtered.filter(log => log.level === options.level!.toUpperCase());
    }
    if (options.scope) {
      filtered = filtered.filter(log => log.scope === options.scope);
    }
    if (options.limit) {
      filtered = filtered.slice(-options.limit);
    }
    return filtered;
  },

  clearLogs: () => {
    logs.length = 0;
  },

  onLog: (callback: (_entry: LogEntry) => void) => {
    logListeners.add(callback);
    return () => logListeners.delete(callback);
  },

  exportLogs: (options: GetLogsOptions = {}) => {
    const filtered = logger.getLogs(options);
    const lines = filtered.map(entry => {
      const time = new Date(entry.timestamp).toLocaleString();
      const level = entry.level.padEnd(5);
      const scope = entry.scope ? `[${entry.scope}]` : '';
      const messageStr = entry.message
        .map(msg => {
          if (typeof msg === 'object' && msg !== null) {
            const m = msg as { type?: string; message?: string; stack?: string };
            if (m.type === 'error') return `${m.message ?? ''}\n${m.stack ?? ''}`;
            return JSON.stringify(msg, null, 2);
          }
          return String(msg);
        })
        .join(' ');
      return `[${time}] [${entry.mode}] [${level}] ${scope} ${messageStr}`;
    });
    const header =
      `=== Logs Exportados ===\n` +
      `Modo: ${isDev ? 'Desarrollo' : 'Producción'}\n` +
      `Fecha: ${new Date().toLocaleString()}\n` +
      `Total de entradas: ${filtered.length}\n` +
      `=======================\n\n`;
    return header + lines.join('\n');
  },

  saveLogsToFile: async (
    options: GetLogsOptions = {},
    dialogOptions?: {
      title: string;
      filterText: string;
      filterAll: string;
      canceledMessage: string;
    }
  ) => {
    try {
      const api = window.api;
      if (!api || !api.saveLogsToFile) {
        return { success: false, error: API_ERRORS.NOT_AVAILABLE };
      }
      const logText = logger.exportLogs(options);
      return await api.saveLogsToFile(logText, dialogOptions);
    } catch (error) {
      return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
    }
  },

  initBackendListener: () => {
    setupBackendLogListener();
  },
};

export default logger;
