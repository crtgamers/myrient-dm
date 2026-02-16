/**
 * Mock del módulo electron/window para tests (evita cargar ESM con import.meta).
 */
function setLastNormalBounds() {}
function restoreWindowToDefault() {}

module.exports = {
  setLastNormalBounds,
  restoreWindowToDefault,
};
