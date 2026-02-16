/**
 * @fileoverview Mock del logger de electron/utils/logger.js para tests en Node
 *
 * Sin Electron; misma interfaz que el logger real (child, info, warn, error, debug, etc.)
 * para rateLimiter, circuitBreaker y otros módulos que dependen del logger.
 */
const noop = () => {};
const childLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  separator: noop,
  startOperation: () => noop,
};

const logger = {
  child: () => childLogger,
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
};

// utils/index.js re-exporta log y otras funciones desde logger.js
const log = logger;
const configureLogger = noop;
const createScopedLogger = () => childLogger;
const setMainWindowGetter = noop;
const getLogFilePath = () => '';
const getLogDirectory = () => '';
const cleanOldLogs = noop;
const formatObject = (o) => (typeof o === 'object' ? JSON.stringify(o) : String(o));
const electronLog = { info: noop, warn: noop, error: noop, debug: noop };

exports.logger = logger;
exports.log = log;
exports.configureLogger = configureLogger;
exports.createScopedLogger = createScopedLogger;
exports.setMainWindowGetter = setMainWindowGetter;
exports.getLogFilePath = getLogFilePath;
exports.getLogDirectory = getLogDirectory;
exports.cleanOldLogs = cleanOldLogs;
exports.formatObject = formatObject;
exports.electronLog = electronLog;
