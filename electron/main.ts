/**
 * Punto de entrada del proceso principal de Electron.
 *
 * Responsabilidades:
 * - Inicializar logger, directorio de config, base de datos de catálogo y servicios.
 * - Crear la ventana principal, registrar handlers IPC y arrancar el motor de descargas.
 * - Gestionar cierre ordenado: pausar motor, quitar handlers, cerrar DB.
 * - Capturar uncaughtException y unhandledRejection y notificar al renderer.
 *
 * @module main
 */

import { app, BrowserWindow } from 'electron';
import { promises as fs } from 'fs';
import config from './config';
import { configureLogger, logger, cleanOldLogs, setMainWindowGetter } from './utils';
import database from './database';
import { serviceManager } from './services';
import { createMainWindow, getMainWindow, loadMainWindowContent } from './window';
import { registerHandlers, removeHandlers } from './ipcHandlers';
import {
  initializeDownloadEngine,
  registerStateHandlers,
  closeDownloadEngine,
  removeStateHandlers,
  getDownloadEngine,
} from './ipcStateHandlers';
import { initAutoUpdater, registerUpdaterHandlers, removeUpdaterHandlers } from './updater';

configureLogger({
  fileLevel: 'info',
  consoleLevel: 'debug',
  maxSize: 10 * 1024 * 1024,
  isDev: !app.isPackaged,
});

setMainWindowGetter(getMainWindow);

const log = logger.child('Main');

// Suprimir deprecations de dependencias que no controlamos; registrar solo las que nos interesan.
process.on('warning', (warning: Error & { name: string; message: string; stack?: string }) => {
  if (warning.name === 'DeprecationWarning' && warning.message.includes('console-message')) {
    return;
  }
  if (warning.name === 'DeprecationWarning' && warning.message.includes('url.parse()')) {
    log.warn('=== ADVERTENCIA DE DEPRECACIÓN (url.parse) ===');
    log.warn('Mensaje:', warning.message);
    log.warn('Stack:', warning.stack);
    log.warn('==============================================');
    if (!app.isPackaged) {
      console.warn('\n⚠️  Advertencia de deprecación detectada:');
      console.warn('Mensaje:', warning.message);
      console.warn('Stack trace completo:');
      console.warn(warning.stack);
      console.warn('\n💡 Nota: Esta advertencia probablemente viene de una dependencia.');
      console.warn('   El código de la aplicación ya usa la API moderna (new URL()).\n');
    }
  }
});

/**
 * Envía un error al renderer para mostrarlo en la UI (toast/consola).
 * Solo se ejecuta si la ventana principal existe y no está destruida.
 *
 * @param error - Error o valor rechazado (se normaliza a Error).
 * @param type - Origen del error para etiquetado en el frontend.
 */
function sendErrorToRenderer(
  error: Error | unknown,
  type: 'uncaught' | 'uncaughtException' | 'unhandledRejection' = 'uncaught'
): void {
  try {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      const err = error instanceof Error ? error : new Error(String(error));
      const errorInfo = {
        type,
        message: err?.message ?? String(error ?? 'Error desconocido'),
        stack: err?.stack,
        timestamp: Date.now(),
        severity: 'error',
      };
      mainWindow.webContents.send('error-notification', errorInfo);
    }
  } catch (sendError) {
    log.error('Error enviando notificación al renderer:', sendError);
  }
}

process.on('uncaughtException', (error: Error & { code?: string }) => {
  log.error('=== ERROR NO CAPTURADO ===');
  log.error('Error:', error.message);
  log.error('Stack:', error.stack);
  log.error('=========================');
  sendErrorToRenderer(error, 'uncaughtException');
  if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
    log.error('Error crítico del sistema, cerrando aplicación...');
    app.quit();
  }
});

process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
  log.error('=== PROMESA RECHAZADA ===');
  log.error('Razón:', reason);
  if (reason instanceof Error) {
    log.error('Stack:', reason.stack);
  }
  log.error('=========================');
  const error = reason instanceof Error ? reason : new Error(String(reason));
  sendErrorToRenderer(error, 'unhandledRejection');
});

let isCleaningUp = false;
let appFullyInitialized = false;

/**
 * Crea el directorio de configuración del usuario si no existe.
 * Necesario para guardar config JSON, downloads.db y window-state antes de usarlos.
 */
async function ensureConfigDirectory(): Promise<void> {
  try {
    await fs.access(config.paths.configPath);
  } catch {
    await fs.mkdir(config.paths.configPath, { recursive: true });
    log.info('Directorio de configuración creado:', config.paths.configPath);
  }
}

/**
 * Inicialización completa de la aplicación tras app.whenReady().
 * Orden: directorio config → logs → DB catálogo → ventana → servicios → IPC → motor descargas.
 * Si la DB de catálogo falla, se hace quit(); el motor se inicia después de cargar el contenido.
 */
async function initialize(): Promise<void> {
  const endInit = logger.startOperation?.('Inicialización de aplicación') ?? (() => {});

  log.separator?.('INICIANDO MYRIENT DOWNLOAD MANAGER');
  log.info('Versión de Electron:', process.versions.electron);
  log.info('Versión de Node:', process.versions.node);
  log.info('Plataforma:', process.platform);
  log.info('Modo:', app.isPackaged ? 'Producción' : 'Desarrollo');
  log.info('Archivo de log:', logger.getFilePath?.());

  await ensureConfigDirectory();
  await cleanOldLogs(5);

  // No cargar DB al inicio: el usuario elige Myrient o LoLROMs desde la pantalla de inicio
  log.info('Aplicación lista; base de datos se cargará al seleccionar fuente');

  const mainWindow = await createMainWindow({ loadContent: false });

  try {
    await serviceManager.initialize();
    log.info('Servicios de negocio inicializados');
  } catch (error) {
    log.warn('Error inicializando servicios:', (error as Error).message);
  }

  registerHandlers(mainWindow);
  registerStateHandlers(mainWindow);
  registerUpdaterHandlers();
  await loadMainWindowContent(mainWindow);

  initAutoUpdater(mainWindow);

  try {
    await initializeDownloadEngine(mainWindow);
    log.info('Nuevo motor de descargas (DownloadEngine) inicializado');

    const engine = getDownloadEngine();
    if (!engine || !engine.isInitialized) {
      throw new Error('DownloadEngine no se inicializó correctamente');
    }

    if (!engine.processingInterval) {
      log.warn('⚠️ Scheduler no está activo, forzando inicio...');
      engine.startQueueProcessing();
    }

    log.info('✅ DownloadEngine completamente operativo');
  } catch (error) {
    log.error('❌ Error crítico inicializando motor de descargas:', error);
  }

  endInit('exitosa');
  log.separator?.('APLICACIÓN LISTA');
  appFullyInitialized = true;
}

app.whenReady().then(initialize);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    initialize();
  }
});

app.on('window-all-closed', () => {
  if (!appFullyInitialized) {
    return;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event: Electron.Event) => {
  if (isCleaningUp) {
    return;
  }
  event.preventDefault();
  isCleaningUp = true;

  cleanup()
    .then(() => {
      log.info('Limpieza completada, cerrando aplicación...');
      app.quit();
    })
    .catch(error => {
      log.error('Error en limpieza durante before-quit:', error);
      app.quit();
    });
});

/**
 * Cierre ordenado antes de salir: detiene el motor de descargas, quita handlers IPC
 * y cierra la base de datos de catálogo. El orden evita que el renderer siga
 * enviando peticiones mientras se cierran recursos.
 */
async function cleanup(): Promise<void> {
  log.separator?.('LIMPIANDO RECURSOS (SAFE SHUTDOWN)');

  try {
    await closeDownloadEngine();
    log.info('DownloadEngine cerrado');
  } catch (error) {
    log.warn('Error cerrando DownloadEngine:', error);
  }

  removeStateHandlers();
  removeUpdaterHandlers();
  removeHandlers();
  log.info('Handlers IPC removidos');

  database.close();
  log.info('Database de índice cerrada');

  log.separator?.('APLICACIÓN CERRADA');
}
