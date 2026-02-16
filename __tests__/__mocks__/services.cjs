/**
 * @fileoverview Mock de electron/services/index.js para tests de integración IPC
 *
 * Expone serviceManager con getters y métodos vacíos para no ejecutar servicios reales.
 */
const serviceManager = {
  initialized: false,
  getDownloadService: () => null,
  getSearchService: () => null,
  getQueueService: () => null,
  getFileService: () => null,
  initialize: () => Promise.resolve(),
  destroy: () => Promise.resolve(),
};

module.exports = { serviceManager };
module.exports.serviceManager = serviceManager;
module.exports.default = { serviceManager };
