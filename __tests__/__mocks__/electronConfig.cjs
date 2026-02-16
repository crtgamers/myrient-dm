const path = require('path');
const os = require('os');

// Ruta de BD de tests: directorio temporal del sistema (evitar permisos en proyecto)
const testQueueDbPath = path.join(os.tmpdir(), 'myrient-dm-test-queue.db');

/**
 * @fileoverview Mock de electron/config.js para tests
 *
 * Usado por validation, fileHelpers, StateStore y otros que dependen de config.
 * Rutas y opciones apuntan a directorios temporales.
 */
const config = {
  security: {
    allowedHosts: ['myrient.erista.me'],
  },
  paths: {
    configPath: process.platform === 'win32' ? 'C:\\tmp\\config' : '/tmp/config',
    queueDbPath: testQueueDbPath,
  },
  files: {
    sizeMarginBytes: 10240,
  },
  downloads: {
    maxQueueSize: 1000,
    progressBatchDelay: 100,
    progressBatchSizeThreshold: 1024 * 1024,
  },
};

module.exports = config;
exports.default = config;
