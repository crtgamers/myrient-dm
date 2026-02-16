/**
 * Gestión de la ventana principal de Electron.
 *
 * Crea la ventana con estado persistente (posición y tamaño en window-state.json),
 * aplica CSP, configura preload y redirige console-message del renderer al logger.
 * En desarrollo carga desde VITE_DEV_SERVER_URL; en producción desde dist/index.html
 * (probando varias rutas según app.getAppPath() y process.resourcesPath).
 *
 * @module window
 */

import { BrowserWindow, Menu, app, screen, nativeImage } from 'electron';
import path from 'path';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import config from './config';
import { logger } from './utils';

const electronDir = path.dirname(fileURLToPath(import.meta.url));

const log = logger.child('Window');

let mainWindow: BrowserWindow | null = null;

const WINDOW_STATE_FILENAME = 'window-state.json';

/** Posición y tamaño de la ventana guardados en disco para restaurar al reabrir. */
export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Si la ventana estaba maximizada al cerrar (para reabrir maximizada y restaurar bien al pulsar Restaurar). */
  isMaximized?: boolean;
}

/** Bounds normales (no maximizados) para guardar al cerrar estando maximizado. */
let lastNormalBounds: WindowState | null = null;

/**
 * Guarda los bounds "normales" (no maximizados) para restaurar correctamente al pulsar Restaurar.
 * Debe llamarse antes de maximize() o cuando la ventana se desmaximiza, para que al cerrar en
 * estado maximizado se persistan estos bounds y al reabrir la app la ventana vuelva a ellos.
 *
 * @param bounds - Posición y tamaño (x, y, width, height) de la ventana en estado no maximizado.
 */
export function setLastNormalBounds(bounds: WindowState): void {
  lastNormalBounds = bounds;
}

const DEFAULT_RESTORE_WIDTH = 1200;
const DEFAULT_RESTORE_HEIGHT = 800;

/**
 * Calcula los bounds para restaurar la ventana a tamaño por defecto (1200×800),
 * limitados al área visible del monitor actual. Si la resolución es menor, ajusta
 * al máximo visible sin desbordes.
 */
function getDefaultRestoreBounds(win: BrowserWindow): WindowState {
  const windowConfig = config.window as {
    defaultWidth?: number;
    defaultHeight?: number;
    minWidth?: number;
    minHeight?: number;
  };
  const defaultWidth = windowConfig.defaultWidth ?? DEFAULT_RESTORE_WIDTH;
  const defaultHeight = windowConfig.defaultHeight ?? DEFAULT_RESTORE_HEIGHT;
  const minW = windowConfig.minWidth ?? 320;
  const minH = windowConfig.minHeight ?? 240;

  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea ?? display.bounds;

  let width = Math.min(defaultWidth, workArea.width);
  let height = Math.min(defaultHeight, workArea.height);
  width = Math.max(minW, width);
  height = Math.max(minH, height);
  width = Math.min(width, workArea.width);
  height = Math.min(height, workArea.height);

  const x = workArea.x + Math.max(0, (workArea.width - width) / 2);
  const y = workArea.y + Math.max(0, (workArea.height - height) / 2);

  return { x, y, width, height };
}

/**
 * Restaura la ventana a su tamaño por defecto (1200×800), adaptado a la resolución
 * del monitor si es menor. Debe llamarse cuando el usuario pulsa Restaurar estando maximizado.
 */
export function restoreWindowToDefault(win: BrowserWindow): void {
  if (!win || win.isDestroyed()) return;
  if (!win.isMaximized()) return;
  const restoreBounds = getDefaultRestoreBounds(win);
  win.unmaximize();
  win.setBounds(restoreBounds);
  setLastNormalBounds(restoreBounds);
}

function getWindowStatePath(): string {
  return path.join(config.paths.configPath, WINDOW_STATE_FILENAME);
}

/**
 * Lee el estado de ventana desde el disco. Devuelve null si el archivo no existe
 * o si el contenido no tiene el formato esperado (x, y, width, height numéricos).
 */
async function loadWindowState(): Promise<WindowState | null> {
  try {
    const statePath = getWindowStatePath();
    const data = await fs.readFile(statePath, 'utf-8');
    const state = JSON.parse(data) as unknown;
    if (
      state &&
      typeof (state as WindowState).x === 'number' &&
      typeof (state as WindowState).y === 'number' &&
      typeof (state as WindowState).width === 'number' &&
      typeof (state as WindowState).height === 'number'
    ) {
      return state as WindowState;
    }
  } catch (readErr) {
    log.debug?.(
      'No se pudo leer estado de ventana (se usarán dimensiones por defecto):',
      (readErr as Error)?.message
    );
  }
  return null;
}

/**
 * Comprueba que los bounds estén dentro de algún display y respeten tamaño mínimo.
 * Evita restaurar ventana en un monitor desconectado o con dimensiones inválidas.
 */
function isBoundsValid(bounds: WindowState): boolean {
  try {
    const { x, y, width, height } = bounds;
    const center = { x: x + width / 2, y: y + height / 2 };
    const display = screen.getDisplayNearestPoint(center);
    const workArea = display.workArea ?? display.bounds;
    const minW = (config.window as { minWidth?: number }).minWidth ?? 320;
    const minH = (config.window as { minHeight?: number }).minHeight ?? 240;
    if (width < minW || height < minH) return false;
    const intersects =
      x + width > workArea.x &&
      x < workArea.x + workArea.width &&
      y + height > workArea.y &&
      y < workArea.y + workArea.height;
    return intersects;
  } catch (screenErr) {
    log.debug?.('No se pudo verificar posición en pantalla:', (screenErr as Error)?.message);
    return false;
  }
}

/** Persiste posición, tamaño y maximizado en configPath para la siguiente sesión. */
async function saveWindowState(win: BrowserWindow): Promise<void> {
  if (!win || win.isDestroyed()) return;
  try {
    const isMaximized = win.isMaximized();
    let bounds: WindowState;
    if (isMaximized && lastNormalBounds) {
      bounds = { ...lastNormalBounds, isMaximized };
    } else {
      const b = win.getBounds();
      bounds = { ...b, isMaximized };
      if (!isMaximized) lastNormalBounds = bounds;
    }
    const statePath = getWindowStatePath();
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(bounds), 'utf-8');
    if (log.debug) log.debug('Estado de ventana guardado:', bounds);
  } catch (err) {
    log.warn('No se pudo guardar estado de ventana:', (err as Error).message);
  }
}

/**
 * Carga index.html desde disco (producción). Prueba varias rutas porque en empaquetado
 * app.getAppPath() y process.resourcesPath pueden variar según el packager.
 */
async function loadAppContent(win: BrowserWindow): Promise<void> {
  const indexPath = path.join(app.getAppPath(), 'dist', 'index.html');

  log.info('=== CARGA DE APLICACIÓN ===');
  log.info('Buscando en:', indexPath);

  try {
    await fs.access(indexPath);
    await win.loadFile(indexPath);
    log.info('Cargado:', indexPath);
    return;
  } catch (loadErr) {
    log.debug?.(
      'Ruta principal no encontrada, probando alternativas:',
      (loadErr as Error)?.message
    );
  }

  const alternatives = [
    path.join(app.getAppPath(), 'dist', 'index.html'),
    path.join(process.resourcesPath ?? '', 'dist', 'index.html'),
    path.join(electronDir, '../dist/index.html'),
  ];

  for (const altPath of alternatives) {
    try {
      await fs.access(altPath);
      log.info('Usando:', altPath);
      await win.loadFile(altPath);
      return;
    } catch (altErr) {
      log.debug?.(`Ruta alternativa no disponible (${altPath}):`, (altErr as Error)?.message);
      continue;
    }
  }

  const errorMsg = `No se encontró index.html\nBuscado en: ${indexPath}`;
  log.error(errorMsg);
  win.webContents.loadURL(`data:text/html;charset=utf-8,<h1>${encodeURIComponent(errorMsg)}</h1>`);
}

/**
 * Carga el contenido de la ventana: en desarrollo desde el dev server de Vite,
 * en producción desde loadAppContent (dist/index.html).
 */
export async function loadMainWindowContent(win: BrowserWindow): Promise<void> {
  const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
  if (VITE_DEV_SERVER_URL) {
    log.info('Cargando desde servidor de desarrollo:', VITE_DEV_SERVER_URL);
    await win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    await loadAppContent(win);
  }
}

export interface CreateMainWindowOptions {
  /** Si false, la ventana se crea vacía; el contenido se carga después (p. ej. tras init del motor). */
  loadContent?: boolean;
}

/**
 * Crea la ventana principal: bounds desde window-state o defaults, preload desde
 * dist-electron, CSP restrictiva, sin menú nativo. En close guarda el estado.
 * Redirige console-message del renderer al logger del main.
 */
export async function createMainWindow(
  options: CreateMainWindowOptions = {}
): Promise<BrowserWindow> {
  const { loadContent = true } = options;
  log.info('Creando ventana principal...');

  const windowConfig = config.window as {
    defaultWidth?: number;
    defaultHeight?: number;
    minWidth?: number;
    minHeight?: number;
    useContentSize?: boolean;
  };
  const { defaultWidth, defaultHeight, minWidth, minHeight, useContentSize } = windowConfig;

  let initialBounds: { width: number; height: number; x?: number; y?: number } = {
    width: defaultWidth ?? 1200,
    height: defaultHeight ?? 800,
  };
  const savedState = await loadWindowState();
  const wantMaximized = savedState?.isMaximized === true;
  if (savedState && isBoundsValid(savedState)) {
    initialBounds = savedState;
    log.info('Restaurando ventana en:', initialBounds, wantMaximized ? '(maximizada)' : '');
  }

  const iconPath = app.isPackaged
    ? path.join(app.getAppPath(), 'dist', 'icon.png')
    : path.join(electronDir, '..', 'public', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  const iconOpt = icon.isEmpty() ? undefined : icon;

  // En desarrollo electronDir es dist-electron; empaquetado puede ser app.asar/dist-electron.
  // Fallbacks para cuando el bundler o el asar cambian la ruta.
  const preloadPath = path.resolve(electronDir, 'preload.js');
  const preloadFallback = path.join(app.getAppPath(), 'dist-electron', 'preload.js');
  const preloadFromResources =
    process.resourcesPath &&
    path.join(process.resourcesPath, 'app.asar', 'dist-electron', 'preload.js');
  const preloadFile = existsSync(preloadPath)
    ? preloadPath
    : existsSync(preloadFallback)
      ? preloadFallback
      : preloadFromResources && existsSync(preloadFromResources)
        ? preloadFromResources
        : preloadPath;
  log.info('Preload script:', preloadFile);
  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: minWidth ?? 320,
    minHeight: minHeight ?? 240,
    useContentSize: useContentSize ?? true,
    frame: false,
    titleBarStyle: 'hidden',
    ...(iconOpt && { icon: iconOpt }),
    webPreferences: {
      preload: preloadFile,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Restringir orígenes de scripts, estilos e imágenes; permitir solo myrient.erista.me para recursos.
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
            "script-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: https://myrient.erista.me; " +
            "connect-src 'self' https://myrient.erista.me; " +
            "font-src 'self' data:; " +
            "worker-src 'none';",
        ],
      },
    });
  });

  if (loadContent) {
    await loadMainWindowContent(mainWindow);
  }

  if (wantMaximized) {
    mainWindow.maximize();
  }

  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      lastNormalBounds = mainWindow.getBounds();
    }
  });

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  type ConsoleMessageParams = {
    level?: number;
    message?: string;
    lineNumber?: number;
    line?: number;
    sourceId?: string;
  };
  const consoleMessageHandler = (
    ...args: [unknown, number, string, number, string?] | [unknown, ConsoleMessageParams]
  ) => {
    let level: number | string | undefined;
    let message: string | undefined;
    let lineNumber: number | undefined;
    let sourceId: string | undefined;

    if (args.length >= 5) {
      [, level, message, lineNumber, sourceId] = args as [unknown, number, string, number, string?];
    } else if (args.length === 2 && typeof args[1] === 'object') {
      const params = args[1] as ConsoleMessageParams;
      level = params.level;
      message = params.message;
      lineNumber = params.lineNumber ?? params.line;
      sourceId = params.sourceId;
    } else {
      return;
    }

    if (!message || typeof message !== 'string') return;
    if (message.includes('backend-log')) return;

    let levelName: 'debug' | 'info' | 'warn' | 'error' = 'info';
    if (typeof level === 'string') {
      levelName =
        level === 'debug'
          ? 'debug'
          : level === 'warning'
            ? 'warn'
            : level === 'error'
              ? 'error'
              : 'info';
    } else if (typeof level === 'number') {
      // Niveles de Chromium: 0=verbose, 1=info, 2=warning, 3=error
      const levelMap: Record<number, 'debug' | 'info' | 'warn' | 'error'> = {
        [-1]: 'debug',
        0: 'debug',
        1: 'info',
        2: 'warn',
        3: 'error',
      };
      levelName = levelMap[level] ?? 'info';
    }

    const consoleLog = logger.child('Chromium');
    const source = sourceId ?? 'unknown';
    const line = lineNumber ?? 0;
    consoleLog[levelName](`${message} (${path.basename(source)}:${line})`);
  };

  mainWindow.webContents.on(
    'console-message',
    consoleMessageHandler as (..._args: unknown[]) => void
  );

  Menu.setApplicationMenu(null);

  mainWindow.on('close', () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.removeListener(
          'console-message',
          consoleMessageHandler as (..._args: unknown[]) => void
        );
      }
    } catch (cleanupErr) {
      log.debug?.(
        'No se pudo limpiar listener de consola (ventana ya destruida):',
        (cleanupErr as Error)?.message
      );
    }
  });

  mainWindow.on('close', () => {
    saveWindowState(mainWindow!).catch((e: Error) =>
      log.debug?.('Error guardando estado de ventana:', e?.message)
    );
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  log.info('Ventana principal creada');
  return mainWindow;
}

/** Devuelve la ventana principal o null si aún no se ha creado o ya se cerró. */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
