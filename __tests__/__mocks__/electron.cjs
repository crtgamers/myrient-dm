/**
 * @fileoverview Mock de Electron para tests en Node (sin proceso Electron)
 *
 * Proporciona app, ipcMain, dialog, shell, etc. Si globalThis.__ipcHandlersMap existe
 * (tests de integración IPC), ipcMain.handle registra handlers en ese mapa.
 */
const app = {
  getPath: (name) => {
    const base = process.platform === 'win32' ? 'C:\\Users\\Test' : '/tmp';
    const paths = {
      downloads: base + (process.platform === 'win32' ? '\\Downloads' : '/Downloads'),
      desktop: base + (process.platform === 'win32' ? '\\Desktop' : '/Desktop'),
      documents: base + (process.platform === 'win32' ? '\\Documents' : '/Documents'),
      userData: base + (process.platform === 'win32' ? '\\.myrient-dm' : '/.myrient-dm'),
    };
    return paths[name] || base + '/' + name;
  },
  getVersion: () => '0.9.0',
  isPackaged: false,
};

// Captura de handlers en globalThis.__ipcHandlersMap (tests de integración IPC)
// Usar mapa en tiempo de llamada para que beforeAll pueda asignar {} y recibir handlers
const ipcMain =
  typeof globalThis !== 'undefined'
    ? {
        handle: (channel, fn) => {
          const map = (globalThis.__ipcHandlersMap = globalThis.__ipcHandlersMap || {});
          map[channel] = fn;
        },
        removeHandler: () => {},
      }
    : {
        handle: () => {},
        removeHandler: () => {},
      };

const dialog = {
  showOpenDialog: () => Promise.resolve({ canceled: true }),
};

const shell = {
  openPath: () => Promise.resolve(''),
};

module.exports = { app, ipcMain, dialog, shell };
exports.app = app;
exports.ipcMain = ipcMain;
exports.dialog = dialog;
exports.shell = shell;
