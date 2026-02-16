/**
 * Handlers IPC para búsqueda, catálogo, configuración, ventana, diálogos y logging.
 *
 * Registra en ipcMain los canales usados por el renderer para: búsqueda en DB (con rate limit
 * y AbortController por ventana para cancelar búsquedas anteriores), get-children/get-ancestors/
 * get-node-info, lectura/escritura de config JSON, minimizar/maximizar/cerrar ventana, seleccionar
 * carpeta, abrir carpeta en el explorador, abrir URL externa, frontend-log y guardar logs.
 * Todos los handlers pasan por createHandler (ipcHelpers) para capturar excepciones y devolver
 * { success, data? | error? }.
 *
 * @module ipcHandlers
 */

import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron';
import { setLastNormalBounds, restoreWindowToDefault } from './window';
import fs from 'fs';
import database from './database';
import { serviceManager } from './services';
import {
  logger,
  readJSONFile,
  writeJSONFile,
  validateSearchTerm,
  validateNodeId,
  validateConfigFilename,
  validateAndSanitizeDownloadPath,
} from './utils';
import { ERRORS } from './constants/errors';
import { RateLimiter } from './utils/rateLimiter';
import { createHandler as createHandlerBase } from './utils/ipcHelpers';
import config from './config';

const log = logger.child('IPC');

type HandlerFn = (
  _event: Electron.IpcMainInvokeEvent,
  ..._args: unknown[]
) => Promise<unknown> | unknown;

/** Wrapper que usa ipcHelpers con log y mensaje de error por defecto; no envuelve en { success, data }. */
const createHandler = (
  channel: string,
  handler: HandlerFn,
  _options: Record<string, unknown> = {}
) =>
  createHandlerBase(
    channel,
    handler as (_event: Electron.IpcMainInvokeEvent, ..._args: unknown[]) => Promise<unknown>,
    {
      log,
      defaultErrorMessage: ERRORS.GENERAL.INTERNAL_SERVER_ERROR,
    }
  );

const rateLimitingSearch = config.rateLimiting as
  | { search?: { maxRequests?: number; windowMs?: number; cleanupIntervalMs?: number } }
  | undefined;
const searchRateLimiter = new RateLimiter(
  rateLimitingSearch?.search?.maxRequests ?? 10,
  rateLimitingSearch?.search?.windowMs ?? 1000
);
const cleanupInterval = setInterval(() => {
  searchRateLimiter.cleanup();
}, rateLimitingSearch?.search?.cleanupIntervalMs ?? 60000);
if (typeof process !== 'undefined') {
  process.on('exit', () => {
    clearInterval(cleanupInterval);
  });
}

/** Un AbortController por webContents.sender.id; al iniciar una nueva búsqueda se aborta la anterior. */
const searchAbortControllers = new Map<number, AbortController>();

/**
 * Devuelve los servicios de negocio si el ServiceManager está inicializado.
 * En caso contrario devuelve null para cada uno (los handlers usan validaciones básicas o fallan).
 */
function getServices(): {
  downloadService: ReturnType<typeof serviceManager.getDownloadService>;
  searchService: ReturnType<typeof serviceManager.getSearchService>;
  queueService: ReturnType<typeof serviceManager.getQueueService>;
  fileService: ReturnType<typeof serviceManager.getFileService>;
} {
  const downloadService = serviceManager.initialized ? serviceManager.getDownloadService() : null;
  const searchService = serviceManager.initialized ? serviceManager.getSearchService() : null;
  const queueService = serviceManager.initialized ? serviceManager.getQueueService() : null;
  const fileService = serviceManager.initialized ? serviceManager.getFileService() : null;
  return { downloadService, searchService, queueService, fileService };
}

/**
 * Registra todos los handlers IPC de búsqueda, catálogo, config, ventana, diálogos y logging.
 * Debe llamarse tras crear la ventana principal (mainWindow se usa en select-folder, save-logs, minimize/maximize/close).
 */
export function registerHandlers(mainWindow: BrowserWindow): void {
  log.info('Registrando handlers IPC...');

  if (!serviceManager.initialized) {
    log.warn('ServiceManager no está inicializado, usando validaciones básicas');
  }

  ipcMain.handle(
    'search-db',
    createHandler('search-db', async (event, ...args) => {
      const searchTerm = args[0];
      const options = (args[1] ?? {}) as Record<string, unknown>;
      const identifier = event.sender.id.toString();

      if (!searchRateLimiter.isAllowed(identifier)) {
        const status = searchRateLimiter.getStatus(identifier);
        log.warn(
          `Rate limit excedido para búsqueda (sender: ${identifier}): ${status?.count ?? 'N/A'} requests`
        );
        return {
          success: false,
          error: 'Demasiadas búsquedas. Por favor espera un momento antes de buscar nuevamente.',
          rateLimited: true,
          retryAfter: status?.resetInMs ?? rateLimitingSearch?.search?.windowMs ?? 1000,
        };
      }

      const { searchService } = getServices();

      const validation = validateSearchTerm(searchTerm as string);
      if (!validation.valid) {
        if (typeof searchTerm === 'string' && searchTerm.trim().length < 2) {
          return { success: true, data: [], total: 0 };
        }
        return { success: false, error: validation.error };
      }

      let normalizedOptions: Record<string, unknown>;
      let searchTermToUse = validation.data as string;
      let searchCacheKey: string | null = null;

      if (searchService) {
        normalizedOptions = searchService.normalizeSearchOptions(
          options as {
            limit?: number;
            offset?: number;
            folderLimit?: number;
            usePrefix?: boolean;
            usePhrase?: boolean;
            useOR?: boolean;
          }
        ) as unknown as Record<string, unknown>;
        searchTermToUse = searchService.normalizeSearchTerm(searchTermToUse);
        searchCacheKey = searchService.getCacheKey(searchTermToUse, options);

        const cacheCheckStart = performance.now();
        const cachedResult = searchService.getFromCacheByKey(searchCacheKey) as {
          data?: unknown[];
          total?: number;
        } | null;
        if (cachedResult) {
          const cacheDurationMs = Math.round(performance.now() - cacheCheckStart);
          searchService.recordSearchMetrics({
            durationMs: cacheDurationMs,
            cacheHit: true,
            resultCount: cachedResult.data?.length ?? 0,
            total: cachedResult.total ?? 0,
          });
          const resultWithMetrics = { ...cachedResult, searchDurationMs: cacheDurationMs };
          if (cachedResult.total !== undefined) {
            const pagination = searchService.calculatePagination(
              cachedResult.total,
              (normalizedOptions as { limit: number }).limit,
              (normalizedOptions as { offset: number }).offset
            );
            return { ...resultWithMetrics, pagination };
          }
          return resultWithMetrics;
        }
      } else {
        const limitOpt = options.limit as number | string | undefined;
        const offsetOpt = options.offset as number | string | undefined;
        const folderLimitOpt = options.folderLimit as number | string | undefined;
        const scopeFolderIdOpt = options.scopeFolderId as number | undefined;
        const scopeFolderIdsOpt = options.scopeFolderIds as number[] | undefined;
        const scopeFolderIds =
          Array.isArray(scopeFolderIdsOpt) && scopeFolderIdsOpt.length > 0
            ? scopeFolderIdsOpt.filter((id): id is number => typeof id === 'number' && id > 0)
            : undefined;
        normalizedOptions = {
          limit: Math.min(Math.max(Number(limitOpt) || 500, 1), 1000),
          offset: Math.max(Number(offsetOpt) || 0, 0),
          folderLimit: Math.min(
            Math.max(Number(folderLimitOpt) || 0, 0),
            (Number(limitOpt) || 500) - 1
          ),
          usePrefix: options.usePrefix !== false,
          usePhrase: options.usePhrase === true,
          useOR: options.useOR === true,
          scopeFolderId:
            typeof scopeFolderIdOpt === 'number' && scopeFolderIdOpt > 0
              ? scopeFolderIdOpt
              : undefined,
          scopeFolderIds: scopeFolderIds?.length ? scopeFolderIds : undefined,
        };
      }

      const senderId = event.sender.id;
      const previousController = searchAbortControllers.get(senderId);
      if (previousController) {
        previousController.abort();
        searchAbortControllers.delete(senderId);
      }

      const controller = new AbortController();
      searchAbortControllers.set(senderId, controller);
      const optionsWithSignal = { ...normalizedOptions, signal: controller.signal };

      const searchStart = performance.now();
      let result: { success: boolean; data?: unknown[]; total?: number; cancelled?: boolean };
      try {
        result = await database.search(
          searchTermToUse,
          optionsWithSignal as import('./database').SearchOptions
        );
      } finally {
        if (searchAbortControllers.get(senderId) === controller) {
          searchAbortControllers.delete(senderId);
        }
      }

      const searchDurationMs = Math.round(performance.now() - searchStart);

      if (result.cancelled) {
        return { ...result, searchDurationMs };
      }

      if (searchService && result.success && searchCacheKey) {
        searchService.setCacheByKey(searchCacheKey, result as Record<string, unknown>);
        searchService.recordSearchMetrics({
          durationMs: searchDurationMs,
          cacheHit: false,
          resultCount: result.data?.length ?? 0,
          total: result.total ?? 0,
        });
      }

      if (searchService && result.success && result.total !== undefined) {
        const pagination = searchService.calculatePagination(
          result.total,
          (normalizedOptions as { limit: number }).limit,
          (normalizedOptions as { offset: number }).offset
        );
        return { ...result, pagination, searchDurationMs };
      }

      return { ...result, searchDurationMs };
    })
  );

  ipcMain.handle(
    'get-search-metrics',
    createHandler('get-search-metrics', () => {
      const { searchService } = getServices();
      return searchService ? searchService.getSearchMetrics() : { recent: [], summary: {} };
    })
  );

  ipcMain.handle(
    'get-children',
    createHandler('get-children', (_event, ...args) => {
      const parentId = args[0];
      const options = (args[1] ?? {}) as Record<string, unknown>;
      const validation = validateNodeId(parentId);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      const defaultLimit = 500;
      const limit =
        options.limit != null && Number(options.limit) > 0
          ? Math.min(Number(options.limit), 1000)
          : defaultLimit;
      const offset =
        options.offset != null && Number(options.offset) >= 0
          ? Math.max(0, Number(options.offset))
          : 0;
      return database.getChildren(validation.data!, { limit, offset });
    })
  );

  ipcMain.handle(
    'get-ancestors',
    createHandler('get-ancestors', (_event, nodeId) => {
      const validation = validateNodeId(nodeId);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      return database.getAncestors(validation.data!);
    })
  );

  ipcMain.handle(
    'get-node-info',
    createHandler('get-node-info', (_event, nodeId) => {
      const validation = validateNodeId(nodeId);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      return database.getNodeInfo(validation.data!);
    })
  );

  ipcMain.handle(
    'close-database',
    createHandler('close-database', () => {
      database.close();
      return { success: true };
    })
  );

  ipcMain.handle(
    'load-database',
    createHandler('load-database', async (_event, ...args) => {
      const source = args[0];
      if (source !== 'myrient' && source !== 'lolroms') {
        return { success: false, error: 'Fuente de catálogo inválida' };
      }
      const success = await database.loadDatabase(source);
      return { success };
    })
  );

  ipcMain.handle(
    'get-current-source',
    createHandler('get-current-source', () => ({
      success: true,
      data: database.currentSource,
    }))
  );

  ipcMain.handle(
    'get-db-update-date',
    createHandler('get-db-update-date', () => {
      if (!database.currentSource) {
        return { success: true, data: null };
      }
      return database.getUpdateDate();
    })
  );

  ipcMain.handle(
    'get-app-locale',
    createHandler('get-app-locale', () => {
      const locale = app.getLocale();
      return { success: true, data: locale };
    })
  );

  ipcMain.handle(
    'read-config-file',
    createHandler('read-config-file', async (_event, filename) => {
      const validation = validateConfigFilename(filename);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      const data = await readJSONFile(validation.data!);
      return { success: true, data };
    })
  );

  ipcMain.handle(
    'write-config-file',
    createHandler('write-config-file', async (_event, filename, data) => {
      const filenameValidation = validateConfigFilename(filename);
      if (!filenameValidation.valid) {
        return { success: false, error: filenameValidation.error };
      }
      if (data === undefined || data === null) {
        return { success: false, error: 'Datos no proporcionados' };
      }
      try {
        JSON.stringify(data);
      } catch (jsonErr) {
        log.debug?.('Datos no serializables a JSON:', (jsonErr as Error)?.message);
        return { success: false, error: 'Los datos no son serializables a JSON' };
      }
      const result = await writeJSONFile(filenameValidation.data!, data);
      return { success: result };
    })
  );

  ipcMain.handle(
    'window-minimize',
    createHandler('window-minimize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.minimize();
      }
    })
  );

  ipcMain.handle(
    'window-maximize',
    createHandler('window-maximize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMaximized()) {
          restoreWindowToDefault(mainWindow);
        } else {
          setLastNormalBounds(mainWindow.getBounds());
          mainWindow.maximize();
        }
      }
    })
  );

  ipcMain.handle(
    'window-is-maximized',
    createHandler('window-is-maximized', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        return { success: true, data: mainWindow.isMaximized() };
      }
      return { success: true, data: false };
    })
  );

  ipcMain.handle(
    'window-close',
    createHandler('window-close', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close();
      }
    })
  );

  ipcMain.handle(
    'select-folder',
    createHandler('select-folder', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false };
      }

      const selectedPath = result.filePaths[0];
      const pathValidation = validateAndSanitizeDownloadPath(selectedPath);
      if (!pathValidation.valid) {
        log.warn(`Selección de carpeta rechazada por seguridad: ${selectedPath}`);
        return { success: false, error: pathValidation.error };
      }

      return { success: true, path: pathValidation.path };
    })
  );

  ipcMain.handle(
    'open-folder',
    createHandler('open-folder', async (_event, filePath) => {
      if (!filePath || typeof filePath !== 'string') {
        return { success: false, error: 'Ruta no proporcionada o inválida' };
      }

      try {
        const pathValidation = validateAndSanitizeDownloadPath(filePath);
        if (!pathValidation.valid) {
          log.warn(`Bloqueado intento de abrir ruta no segura: ${filePath}`);
          return { success: false, error: pathValidation.error };
        }

        const resolvedPath = pathValidation.path!;

        let stats: fs.Stats;
        try {
          stats = await fs.promises.stat(resolvedPath);
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          if (err.code === 'ENOENT') {
            return { success: false, error: 'La ruta no existe' };
          }
          throw e;
        }

        if (stats.isDirectory()) {
          await shell.openPath(resolvedPath);
        } else if (stats.isFile()) {
          shell.showItemInFolder(resolvedPath);
        } else {
          return { success: false, error: 'La ruta no es un archivo ni un directorio válido' };
        }

        return { success: true };
      } catch (error) {
        log.error('Error abriendo carpeta:', error);
        return { success: false, error: (error as Error).message };
      }
    })
  );

  ipcMain.handle(
    'get-user-data-path',
    createHandler('get-user-data-path', async () => ({
      success: true,
      path: config.paths.userDataPath,
    }))
  );

  ipcMain.handle(
    'open-user-data-folder',
    createHandler('open-user-data-folder', async () => {
      const userDataPath = config.paths.userDataPath;
      try {
        await fs.promises.mkdir(userDataPath, { recursive: true });
        await shell.openPath(userDataPath);
        return { success: true, path: userDataPath };
      } catch (error) {
        log.error('Error abriendo carpeta del programa:', error);
        return { success: false, error: (error as Error).message, path: userDataPath };
      }
    })
  );

  ipcMain.handle(
    'open-external-url',
    createHandler('open-external-url', async (_event, url) => {
      if (!url || typeof url !== 'string') {
        return { success: false, error: 'URL no proporcionada' };
      }
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return { success: false, error: 'Solo se permiten enlaces https o http' };
        }
        await shell.openExternal(url);
        return { success: true };
      } catch (urlErr) {
        log.debug?.('URL inválida para abrir externamente:', (urlErr as Error)?.message);
        return { success: false, error: 'URL inválida' };
      }
    })
  );

  ipcMain.handle(
    'frontend-log',
    createHandler('frontend-log', async (_event, ...args) => {
      const logEntry = (args[0] ?? {}) as {
        level?: string;
        scope?: string;
        message?: unknown[];
        timestamp?: unknown;
        mode?: string;
      };
      const { level, scope, message = [], mode } = logEntry;
      const frontendLogger = logger.child(`Frontend:${scope ?? 'App'}`);

      const formattedMessage = (Array.isArray(message) ? message : [message])
        .map((msg: unknown) => {
          if (
            typeof msg === 'object' &&
            msg !== null &&
            (msg as { type?: string }).type === 'error'
          ) {
            const m = msg as { message?: string; stack?: string };
            return `${m.message ?? ''}\n${m.stack ?? ''}`;
          }
          if (typeof msg === 'object') {
            return JSON.stringify(msg, null, 2);
          }
          return String(msg);
        })
        .join(' ');

      const levelMethod =
        (
          {
            DEBUG: frontendLogger.debug?.bind(frontendLogger),
            INFO: frontendLogger.info.bind(frontendLogger),
            WARN: frontendLogger.warn.bind(frontendLogger),
            ERROR: frontendLogger.error.bind(frontendLogger),
          } as Record<string, (_s: string) => void>
        )[level ?? 'INFO'] ?? frontendLogger.info.bind(frontendLogger);

      levelMethod(`[${mode ?? 'renderer'}] ${formattedMessage}`);

      return { success: true };
    })
  );

  ipcMain.handle(
    'save-logs-to-file',
    createHandler('save-logs-to-file', (async (
      _event,
      logText: string,
      dialogOptions?: {
        title: string;
        filterText: string;
        filterAll: string;
        canceledMessage: string;
      }
    ) => {
      const title = dialogOptions?.title ?? 'Save logs';
      const filterText = dialogOptions?.filterText ?? 'Text files';
      const filterAll = dialogOptions?.filterAll ?? 'All files';
      const canceledMessage = dialogOptions?.canceledMessage ?? 'User canceled';

      const result = await dialog.showSaveDialog(mainWindow, {
        title,
        defaultPath: `myrient-logs-${new Date().toISOString().split('T')[0]}.txt`,
        filters: [
          { name: filterText, extensions: ['txt'] },
          { name: filterAll, extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, error: canceledMessage };
      }

      try {
        await fs.promises.writeFile(result.filePath, String(logText ?? ''), 'utf8');
        log.info(`Logs guardados en: ${result.filePath}`);
        return { success: true, path: result.filePath };
      } catch (error) {
        log.error('Error guardando logs:', error);
        return { success: false, error: (error as Error).message };
      }
    }) as HandlerFn)
  );

  log.info('Handlers IPC registrados correctamente');
}

/**
 * Quita todos los handlers registrados por registerHandlers, cancela búsquedas en curso
 * (abort de los AbortController) y detiene el intervalo de cleanup del rate limiter.
 */
export function removeHandlers(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }
  searchAbortControllers.forEach(c => {
    try {
      c.abort();
    } catch (abortErr) {
      log.debug?.('Error abortando búsqueda en cleanup:', (abortErr as Error)?.message);
    }
  });
  searchAbortControllers.clear();

  const channels = [
    'close-database',
    'load-database',
    'get-current-source',
    'search-db',
    'get-search-metrics',
    'get-children',
    'get-ancestors',
    'get-node-info',
    'get-db-update-date',
    'get-app-locale',
    'read-config-file',
    'write-config-file',
    'window-minimize',
    'window-maximize',
    'window-is-maximized',
    'window-close',
    'select-folder',
    'open-folder',
    'get-user-data-path',
    'open-user-data-folder',
    'open-external-url',
    'frontend-log',
    'save-logs-to-file',
  ];

  for (const channel of channels) {
    ipcMain.removeHandler(channel);
  }

  log.info('Handlers IPC removidos');
}
