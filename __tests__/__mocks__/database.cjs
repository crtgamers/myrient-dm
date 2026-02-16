/**
 * @fileoverview Mock de electron/database.js para tests de integración IPC
 *
 * Jest lo usa al resolver electron/database.js (p. ej. en integration).
 * Expone métodos que devuelven datos por defecto sin tocar la BD real.
 */
const noop = () => {};
const defaultSearchResult = { success: true, data: [], total: 0 };
const defaultChildrenResult = { success: true, data: [] };
const defaultAncestorsResult = { success: true, data: [] };

const database = {
  getUpdateDate: () => null,
  getDb: () => null,
  search: () => Promise.resolve(defaultSearchResult),
  getChildren: () => defaultChildrenResult,
  getAncestors: () => defaultAncestorsResult,
  getNodeInfo: () => ({ success: false, error: 'mock' }),
  isReady: () => true,
  close: noop,
};

module.exports = database;
module.exports.default = database;
