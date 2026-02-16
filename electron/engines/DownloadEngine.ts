/**
 * Orquestador principal del motor de descargas.
 *
 * Coordina: StateStore (persistencia), Scheduler (límites y prioridad), ChunkStore (archivos
 * temporales de chunks), FileAssembler (merge), Verifier (hash/tamaño), EventBus (eventos al UI),
 * WorkerPool (merge en worker), simpleDownloader (archivos pequeños) y chunkDownloader (HTTP Range).
 * processQueue() se ejecuta periódicamente; selecciona descargas en cola, valida espacio/ruta,
 * decide simple vs chunked y delega en startSimpleDownload o startChunkedDownload.
 *
 * @module DownloadEngine
 */

import { app } from 'electron';
import { Worker } from 'worker_threads';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config';
import { logger, validateDiskSpace, readJSONFile } from '../utils';
import { isValidUrl, normalizePriority } from '../utils/validation';
import {
  validateSavePath as validateSavePathForDownload,
  isTransientNetworkError as isTransientNetworkErrorCheck,
  calculateBackoffDelay as calculateBackoffDelayMs,
} from './DownloadValidator';
import { serviceManager } from '../services';
import sessionManager from './SessionManager';
import circuitBreakerManager from './CircuitBreakerManager';
import downloadManager from './DownloadManager';
import chunkManager from './ChunkManager';
import database from '../database';
import stateStore from './StateStore';
import { DownloadState, ChunkState, type ICatalogProvider, type ISavePathResolver } from './types';
import Scheduler from './Scheduler';
import ChunkStore from './ChunkStore';
import FileAssembler, { type IncrementalMergeSession } from './FileAssembler';
import Verifier from './Verifier';
import eventBus from './EventBus';
import WorkerPool from '../utils/workerPool';
import speedTracker from './SpeedTracker';
import * as simpleDownloader from './SimpleDownloader';
import * as chunkDownloader from './ChunkDownloader';
import downloadMetrics from './DownloadMetrics';
import chunkProgressCache from './ChunkProgressAggregator';
import { AdaptiveConcurrencyController } from './AdaptiveConcurrencyController';
import { isActiveState } from './DownloadStateMachine';
import { ConcurrencyController } from './ConcurrencyController';
import type { Download } from './StateStore';
import type { Snapshot } from './StateStore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chunkStore = new ChunkStore();

/** Resuelve la ruta absoluta a downloadWorker.js (dev y empaquetado). */
function getDownloadWorkerPath(): string {
  const workerFile = 'downloadWorker.js';
  const candidates = [
    path.join(__dirname, 'workers', workerFile),
    path.join(app.getAppPath(), 'dist-electron', 'workers', workerFile),
    process.resourcesPath
      ? path.join(process.resourcesPath, 'app.asar', 'dist-electron', 'workers', workerFile)
      : '',
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return path.join(app.getAppPath(), 'dist-electron', 'workers', workerFile);
}

const log = logger.child('DownloadEngine');

export interface AddDownloadPayload {
  id: number;
  title: string;
  url?: string | null;
  savePath?: string | null;
  downloadPath?: string | null;
  preserveStructure?: boolean;
  priority?: number;
  forceOverwrite?: boolean;
  totalBytes?: number;
  skipQueueLimit?: boolean;
  startPaused?: boolean;
}

interface DownloadConfigOverrides {
  maxConcurrentChunks: number | null;
  maxChunkRetries: number | null;
  chunkOperationTimeoutMinutes: number | null;
  skipVerification: boolean | null;
  /** Cuando true, todas las descargas usan flujo directo (sin chunks). */
  forceDirectDownload: boolean | null;
}

interface WorkerPoolLike {
  execute: (
    _task: Record<string, unknown>,
    _onProgress?: (_progress: number, _bytesProcessed: number) => void
  ) => Promise<unknown>;
  shutdown: () => Promise<void>;
}

/**
 * Dependencias inyectables del motor de descargas (para tests e instancias independientes).
 * Todas opcionales: si no se proporcionan, se usan los singletons globales (backward-compatible).
 * Permite instanciar el motor en tests sin depender de módulos con estado global.
 */
export interface DownloadEngineDeps {
  stateStore?: typeof stateStore;
  eventBus?: typeof eventBus;
  sessionManager?: typeof sessionManager;
  circuitBreakerManager?: typeof circuitBreakerManager;
  downloadManager?: typeof downloadManager;
  chunkManager?: typeof chunkManager;
  speedTracker?: typeof speedTracker;
  chunkStore?: ChunkStore;
  scheduler?: Scheduler;
}

/**
 * Instancia única del motor: inicializa StateStore, ChunkStore, WorkerPool y arranca
 * el intervalo de processQueue; expone addDownload, pause/resume/cancel, getSnapshot, etc.
 */
export class DownloadEngine {
  isInitialized = false;
  isProcessing = false;
  processingInterval: ReturnType<typeof setInterval> | null = null;
  /** Intervalo de log de métricas agregadas cada 60s. */
  private _metricsLogInterval: ReturnType<typeof setInterval> | null = null;
  /** Timer del debounce de processQueue; evita múltiples setTimeout solapados. */
  private _processQueueTimer: ReturnType<typeof setTimeout> | null = null;
  /** Controlador de concurrencia adaptativa (ajusta slots según throughput y errores). */
  private _adaptiveConcurrency: AdaptiveConcurrencyController | null = null;

  chunkStore: ChunkStore;
  scheduler: Scheduler;
  fileAssembler: FileAssembler;
  verifier: Verifier;
  stateStore: typeof stateStore;
  sessionManager: typeof sessionManager;
  circuitBreakerManager: typeof circuitBreakerManager;
  downloadManager: typeof downloadManager;
  chunkManager: typeof chunkManager;
  speedTracker: typeof speedTracker;
  /** Referencia al EventBus inyectado para desacoplar del singleton. */
  readonly eventBus: typeof eventBus;
  mergeInProgress: Set<number>;
  /** Semáforos global y por-download para límite de chunks en vuelo. */
  concurrencyController: ConcurrencyController;
  /** Sesiones de merge incremental por downloadId (append en orden, finalize al completar). */
  private _incrementalMergeSessions = new Map<number, IncrementalMergeSession>();
  downloadConfigOverrides: DownloadConfigOverrides;
  downloadService: {
    validateDownloadParams: (_d: unknown) => { valid: boolean; error?: string; data?: unknown };
    shouldUseChunkedDownload: (_url: string | null, _totalBytes: number) => Promise<boolean>;
  } | null = null;
  queueService: unknown = null;
  /** Proveedor de datos del catálogo (URL, ancestros). Inyectable para tests. */
  catalogProvider: ICatalogProvider | null = null;
  /** Resolución de rutas de guardado. Inyectable para tests. */
  fileService: ISavePathResolver | null = null;
  workerPool: WorkerPoolLike | null = null;

  get activeDownloads(): Map<number, unknown> {
    return this.downloadManager.store;
  }

  get activeChunks(): Map<string, unknown> {
    return this.chunkManager.store;
  }

  /**
   * @param deps — dependencias opcionales; si no se pasan, se usan los singletons globales.
   *               Permite testing unitario con mocks y futuras instancias independientes.
   */
  constructor(deps?: DownloadEngineDeps) {
    this.chunkStore = deps?.chunkStore ?? chunkStore;
    this.scheduler = deps?.scheduler ?? new Scheduler();
    this.fileAssembler = new FileAssembler(this.chunkStore);
    this.verifier = new Verifier();
    this.stateStore = deps?.stateStore ?? stateStore;
    this.eventBus = deps?.eventBus ?? eventBus;
    this.sessionManager = deps?.sessionManager ?? sessionManager;
    this.circuitBreakerManager = deps?.circuitBreakerManager ?? circuitBreakerManager;
    this.downloadManager = deps?.downloadManager ?? downloadManager;
    this.chunkManager = deps?.chunkManager ?? chunkManager;
    this.speedTracker = deps?.speedTracker ?? speedTracker;
    this.mergeInProgress = new Set<number>();
    const downloadsCfg = config.downloads as Record<string, unknown>;
    const chunkedCfgForController = downloadsCfg?.chunked as
      | { maxConcurrentChunks?: number }
      | undefined;
    this.concurrencyController = new ConcurrencyController({
      maxConcurrent: (downloadsCfg?.maxConcurrent as number) ?? 3,
      maxChunkSlotsPerDownload: chunkedCfgForController?.maxConcurrentChunks ?? 4,
    });
    this.downloadConfigOverrides = {
      maxConcurrentChunks: null,
      maxChunkRetries: null,
      chunkOperationTimeoutMinutes: null,
      skipVerification: null,
      forceDirectDownload: null,
    };

    // Concurrencia adaptativa: controlador que ajusta scheduler y ConcurrencyController según throughput
    const chunkedCfg = (config.downloads as Record<string, unknown>)?.chunked as
      | Record<string, unknown>
      | undefined;
    const adaptiveEnabled = chunkedCfg?.adaptiveConcurrency === true;
    this._adaptiveConcurrency = new AdaptiveConcurrencyController(
      (concurrent: number, perHost: number) => {
        this.scheduler.setMaxConcurrent(concurrent);
        this.scheduler.setMaxConcurrentPerHost(perHost);
        this.concurrencyController.setMaxConcurrent(concurrent);
        // Tras scale-up, intentar arrancar nuevas descargas de la cola
        this._scheduleProcessQueue();
      },
      { enabled: adaptiveEnabled }
    );
  }

  /**
   * Programa una ejecución debounced de processQueue. Si ya hay un timer pendiente,
   * no crea otro (coalesce). Reemplaza el patrón duplicado de
   * Reemplaza el patrón duplicado de processQueue + setTimeout(processQueue).
   */
  _scheduleProcessQueue(delayMs = 100): void {
    if (this._processQueueTimer != null) return; // Ya hay uno pendiente
    this._processQueueTimer = setTimeout(() => {
      this._processQueueTimer = null;
      this.processQueue().catch(error =>
        log.error('[scheduleProcessQueue] Error en procesamiento programado:', error)
      );
    }, delayMs);
  }

  /**
   * Inicializa StateStore, ChunkStore, limpia directorios huérfanos de chunks, carga
   * WorkerPool y configuración guardada (maxParallel, chunks), y arranca processQueue.
   *
   * @returns true si todo fue correcto; false en caso de error (log + no throw).
   */
  async initialize(_options: Record<string, unknown> = {}): Promise<boolean> {
    if (this.isInitialized) {
      log.warn('DownloadEngine ya está inicializado');
      return true;
    }

    try {
      log.info('Inicializando DownloadEngine...');

      if (!this.stateStore.initialize()) {
        throw new Error('No se pudo inicializar StateStore');
      }

      // Hooks de la máquina de estados: registrar host al entrar a STARTING, desregistrar al salir de activos
      this.stateStore.setTransitionHooks({
        onEnter: (id, toState) => {
          if (toState === DownloadState.STARTING) {
            const d = this.stateStore.getDownload(id);
            if (d?.url) this._registerDownloadHost(id, d.url);
          }
        },
        onExit: (id, fromState, toState) => {
          if (isActiveState(fromState) && !isActiveState(toState)) {
            this._unregisterDownloadHost(id);
            this.concurrencyController.releaseGlobalSlot();
          }
        },
      });

      await chunkStore.initialize();

      const activeIds = new Set(
        this.stateStore.getDownloadsByState(DownloadState.DOWNLOADING).map(d => d.id)
      );
      await chunkStore.cleanupOrphanedDirs(activeIds);

      try {
        this.downloadService =
          serviceManager.getDownloadService() as DownloadEngine['downloadService'];
        this.queueService = serviceManager.getQueueService();
        this.catalogProvider = database as unknown as ICatalogProvider;
        this.fileService = (
          serviceManager.getFileService
            ? serviceManager.getFileService()
            : serviceManager.get('file')
        ) as ISavePathResolver | null;
      } catch (error) {
        log.warn('Servicios no disponibles:', (error as Error).message);
      }

      const workerPath = getDownloadWorkerPath();
      const workersConfig = config.workers as {
        poolSize?: number;
        minWorkers?: number;
        maxWorkers?: number;
        taskTimeoutMs?: number;
        idleTimeoutMs?: number;
        healthCheckIntervalMs?: number;
        healthCheckTimeoutMs?: number;
      };
      // Config dinámica del pool de workers; fallback a poolSize si no hay maxWorkers
      this.workerPool = new WorkerPool(workerPath, {
        minWorkers: workersConfig.minWorkers ?? 1,
        maxWorkers: workersConfig.maxWorkers ?? workersConfig.poolSize ?? 0,
        taskTimeoutMs: workersConfig.taskTimeoutMs ?? 5 * 60 * 1000,
        idleTimeoutMs: workersConfig.idleTimeoutMs ?? 60_000,
        healthCheckIntervalMs: workersConfig.healthCheckIntervalMs ?? 30_000,
        healthCheckTimeoutMs: workersConfig.healthCheckTimeoutMs ?? 5_000,
      }) as unknown as WorkerPoolLike;

      const savedSettings = (await readJSONFile('download-settings.json')) as {
        maxParallelDownloads?: number;
        maxConcurrentChunks?: number;
        maxChunkRetries?: number;
        chunkOperationTimeoutMinutes?: number;
        skipVerification?: boolean;
        disableChunkedDownloads?: boolean;
        turboDownload?: boolean;
      } | null;
      if (savedSettings) {
        const turbo = savedSettings.turboDownload === true;
        if (this.scheduler) {
          this.scheduler.setTurboMode(turbo);
          if (turbo) {
            this.scheduler.setMaxConcurrent(1);
            this.scheduler.setMaxConcurrentPerHost(1);
            this.concurrencyController.setMaxConcurrent(1);
            log.info('Límites aplicados desde configuración: modo Turbo activo (1 descarga)');
          } else {
            const n = savedSettings.maxParallelDownloads;
            if (typeof n === 'number' && n >= 1) {
              const maxP = Math.min(3, Math.max(1, n));
              this.scheduler.setMaxConcurrent(maxP);
              this.scheduler.setMaxConcurrentPerHost(Math.min(maxP, 2));
              this.concurrencyController.setMaxConcurrent(maxP);
              log.info(
                `Límites aplicados desde configuración: maxParallelDownloads=${this.scheduler.maxConcurrent}`
              );
            }
          }
        }
        const chunks = turbo
          ? 4
          : typeof savedSettings.maxConcurrentChunks === 'number' &&
              savedSettings.maxConcurrentChunks >= 1
            ? Math.min(4, Math.max(1, savedSettings.maxConcurrentChunks))
            : undefined;
        this.setDownloadConfigOverrides({
          ...(chunks !== undefined && { maxConcurrentChunks: chunks }),
          maxChunkRetries: savedSettings.maxChunkRetries,
          chunkOperationTimeoutMinutes: savedSettings.chunkOperationTimeoutMinutes,
          skipVerification: savedSettings.skipVerification ?? false,
          disableChunkedDownloads: savedSettings.disableChunkedDownloads !== false,
        });
      }

      // Informar al controlador de concurrencia adaptativa del techo configurado por el usuario
      if (this._adaptiveConcurrency?.enabled) {
        this._adaptiveConcurrency.updateUserMaxConcurrent(this.scheduler.maxConcurrent);
      }

      this.startQueueProcessing();

      this.isInitialized = true;
      log.info('DownloadEngine inicializado correctamente');
      return true;
    } catch (error) {
      log.error('Error inicializando DownloadEngine:', error);
      return false;
    }
  }

  /** Inicia el intervalo que llama a processQueue periódicamente; idempotente. */
  startQueueProcessing(): void {
    if (this.processingInterval) {
      log.warn('Procesamiento de cola ya está iniciado');
      return;
    }
    const interval =
      (config.downloads as { queueProcessDelay?: number })?.queueProcessDelay ?? 2000;
    this.processingInterval = setInterval(() => {
      this.processQueue().catch(error => {
        log.error('Error procesando cola:', error);
      });
    }, interval);
    log.info(`✅ Procesamiento de cola iniciado (intervalo: ${interval}ms)`);
    // Log periódico de métricas agregadas cada 60s
    this._metricsLogInterval = setInterval(() => downloadMetrics.logSummary(), 60_000);
    // Iniciar controlador de concurrencia adaptativa
    this._adaptiveConcurrency?.start();
    this.processQueue().catch(error => {
      log.error('Error en procesamiento inicial de cola:', error);
    });
  }

  stopQueueProcessing(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    if (this._metricsLogInterval) {
      clearInterval(this._metricsLogInterval);
      this._metricsLogInterval = null;
    }
    // Detener controlador de concurrencia adaptativa
    this._adaptiveConcurrency?.stop();
    // Log final de métricas al detener
    downloadMetrics.logSummary();
  }

  async processQueue(): Promise<void> {
    if (this.isProcessing) {
      if (!app.isPackaged) log.debug('[processQueue] Saltando: ya se está procesando la cola');
      return;
    }

    this.isProcessing = true;

    try {
      const queued = this.stateStore.getDownloadsByState(DownloadState.QUEUED);
      if (queued.length === 0) return;

      log.info(`[processQueue] Procesando ${queued.length} descarga(s) en cola`);

      const maxQueueBatchSize =
        (config.downloads as { maxQueueBatchSize?: number })?.maxQueueBatchSize ?? 100;
      const queuedToProcess = queued.slice(0, maxQueueBatchSize);

      // Slots globales desde ConcurrencyController (semáforo explícito)
      const slotsAvailable = this.concurrencyController.getAvailableGlobalSlots();
      const globalActiveCount = this.concurrencyController.getGlobalActiveCount();

      if (!app.isPackaged) {
        log.debug(
          `[processQueue] Estado: ${queued.length} en cola, ${globalActiveCount} activas (slots libres: ${slotsAvailable})`
        );
      }

      if (slotsAvailable <= 0) {
        if (!app.isPackaged) log.debug('[processQueue] No hay slots globales disponibles');
        return;
      }

      const toStart = this.scheduler.selectDownloadsToStart(
        queuedToProcess,
        slotsAvailable,
        globalActiveCount
      );

      for (const d of toStart) {
        const downloadId = (d as Download).id;
        if (downloadId == null) continue;
        const current = this.stateStore.getDownload(downloadId);
        if (!current || current.state !== DownloadState.QUEUED) {
          if (!app.isPackaged) {
            log.debug(
              `[processQueue] Omitiendo descarga ${downloadId}: estado actual ${current?.state ?? 'no encontrada'} (no en cola)`
            );
          }
          continue;
        }
        if (!this.concurrencyController.acquireGlobalSlot()) {
          if (!app.isPackaged)
            log.debug('[processQueue] No se pudo adquirir slot global, omitiendo inicio');
          break;
        }
        try {
          await this.startDownload(downloadId);
        } catch (error) {
          const err = error as Error;
          if (err.message && err.message.includes('cancelled')) {
            if (!app.isPackaged)
              log.debug(`[processQueue] Descarga ${downloadId} ya cancelada, omitiendo inicio`);
            continue;
          }
          log.error(`Error iniciando descarga ${downloadId}:`, error);
          this.stateStore.transitionState(downloadId, DownloadState.FAILED);
          this.stateStore.updateDownload(downloadId, { lastError: err.message });
          this.eventBus.emitDownloadFailed(downloadId, err);
        }
      }

      if (toStart.length > 0) {
        log.info(
          `[processQueue] Procesadas ${toStart.length} descargas de ${queued.length} en cola`
        );
      }
    } catch (error) {
      log.error('[processQueue] Error crítico:', error);
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  async addDownload(download: AddDownloadPayload): Promise<Snapshot> {
    const skipQueueLimit = download.skipQueueLimit === true;

    if (this.downloadService) {
      const validation = this.downloadService.validateDownloadParams(download);
      if (!validation.valid) {
        throw new Error(validation.error);
      }
      download = validation.data as AddDownloadPayload;
    }

    const storePayload: Record<string, unknown> = {
      id: download.id,
      title: download.title,
      url: download.url ?? null,
      savePath: download.savePath ?? null,
      downloadPath: download.downloadPath ?? null,
      preserveStructure: download.preserveStructure !== false,
      priority: normalizePriority(download.priority ?? 2),
      forceOverwrite: download.forceOverwrite ?? false,
      totalBytes: download.totalBytes ?? 0,
    };
    if (skipQueueLimit) storePayload.skipQueueLimit = true;
    const startPaused = download.startPaused === true;
    if (startPaused) storePayload.startPaused = true;

    const snapshot = this.stateStore.addDownload(
      storePayload as unknown as import('./StateStore').AddDownloadInput
    );

    const existingDownload = this.stateStore.getDownload(download.id);
    if (existingDownload && !download.forceOverwrite) {
      const savePath = existingDownload.savePath ?? download.savePath;
      let needsConfirmation = false;
      let existingSize = 0;
      const expectedSize = download.totalBytes ?? existingDownload.totalBytes ?? 0;

      if (savePath) {
        try {
          const stats = await fs.stat(savePath);
          existingSize = stats.size;
          if (
            existingDownload.state === DownloadState.COMPLETED ||
            (existingSize > 0 &&
              existingDownload.state !== DownloadState.FAILED &&
              existingDownload.state !== DownloadState.CANCELLED)
          ) {
            needsConfirmation = true;
          }
        } catch (statErr) {
          log.debug?.(
            'No se pudo obtener stat del archivo existente:',
            (statErr as Error)?.message
          );
          if (existingDownload.state === DownloadState.COMPLETED) {
            needsConfirmation = true;
            existingSize = existingDownload.downloadedBytes ?? existingDownload.totalBytes ?? 0;
          }
        }
      } else if (existingDownload.state === DownloadState.COMPLETED) {
        needsConfirmation = true;
        existingSize = existingDownload.downloadedBytes ?? existingDownload.totalBytes ?? 0;
      }

      if (needsConfirmation) {
        if (
          existingDownload.state === DownloadState.STARTING ||
          existingDownload.state === DownloadState.DOWNLOADING ||
          existingDownload.state === DownloadState.MERGING ||
          existingDownload.state === DownloadState.VERIFYING
        ) {
          await this.cancelDownload(download.id);
          this.stateStore.transitionState(
            download.id,
            DownloadState.PAUSED,
            DownloadState.CANCELLED
          );
        } else if (existingDownload.state !== DownloadState.PAUSED) {
          this.stateStore.transitionState(
            download.id,
            DownloadState.PAUSED,
            existingDownload.state
          );
        }
        this.stateStore.updateDownload(download.id, {
          lastError: 'requires_overwrite_confirmation',
        });
        this.eventBus.emitNeedsConfirmation(download.id, {
          savePath,
          existingSize,
          expectedSize,
          title: existingDownload.title ?? download.title,
        });
        const updatedSnapshot = this.stateStore.getSnapshot();
        this.eventBus.emitStateChanged(updatedSnapshot.stateVersion);
        return updatedSnapshot;
      }
    }

    this.eventBus.emitStateChanged(snapshot.stateVersion);
    if (!startPaused) {
      this.processQueue().catch(error => {
        log.error('Error procesando cola después de agregar descarga:', error);
      });
    }
    return snapshot;
  }

  async startDownload(downloadId: number): Promise<void> {
    log.info(`[startDownload] Iniciando descarga ${downloadId}`);
    const download = this.stateStore.getDownload(downloadId);
    if (!download) {
      throw new Error(`Descarga ${downloadId} no encontrada`);
    }

    log.debug(
      `[startDownload] Descarga ${downloadId}: estado=${download.state}, url=${download.url ? 'present' : 'missing'}, savePath=${download.savePath ? 'present' : 'missing'}`
    );

    if (!this.stateStore.canTransition(download.state, DownloadState.STARTING)) {
      throw new Error(`No se puede iniciar descarga en estado: ${download.state}`);
    }

    let preparedDownload: Download & { url?: string | null };
    try {
      preparedDownload = (await this._ensureDownloadMetadata(download)) as Download & {
        url?: string | null;
      };
    } catch (error) {
      const err = error as Error;
      log.error(`Error preparando metadatos descarga ${downloadId}:`, error);
      this.stateStore.transitionState(downloadId, DownloadState.FAILED, download.state);
      this.stateStore.updateDownload(downloadId, { lastError: err.message });
      this.eventBus.emitDownloadFailed(downloadId, err);
      throw error;
    }

    if (preparedDownload.savePath) {
      const pathValidation = validateSavePathForDownload(
        preparedDownload.savePath,
        preparedDownload.downloadPath ?? undefined
      );
      if (!pathValidation.valid) {
        this.stateStore.transitionState(downloadId, DownloadState.FAILED, download.state);
        this.stateStore.updateDownload(downloadId, { lastError: pathValidation.error });
        this.eventBus.emitDownloadFailed(
          downloadId,
          new Error(pathValidation.error ?? 'Ruta de guardado inválida')
        );
        throw new Error(pathValidation.error ?? 'Ruta de guardado inválida');
      }
      preparedDownload.savePath = pathValidation.sanitizedPath ?? preparedDownload.savePath;
    }

    if (preparedDownload.totalBytes > 0 && preparedDownload.savePath) {
      const spaceCheck = await validateDiskSpace(
        preparedDownload.savePath,
        preparedDownload.totalBytes
      );
      if (!spaceCheck.valid) {
        log.error(`Espacio insuficiente para descarga ${downloadId}: ${spaceCheck.error}`);
        this.stateStore.transitionState(downloadId, DownloadState.FAILED, download.state);
        this.stateStore.updateDownload(downloadId, {
          lastError: spaceCheck.error ?? 'Espacio insuficiente en disco',
        });
        this.eventBus.emitDownloadFailed(
          downloadId,
          new Error(spaceCheck.error ?? 'Espacio insuficiente')
        );
        throw new Error(spaceCheck.error ?? 'Espacio insuficiente en disco');
      }
    } else if (preparedDownload.totalBytes === 0) {
      log.warn(
        `Tamaño desconocido para descarga ${downloadId}, no se puede validar espacio antes de iniciar`
      );
    }

    if (!preparedDownload.forceOverwrite && preparedDownload.savePath) {
      try {
        await fs.access(preparedDownload.savePath);
        const stats = await fs.stat(preparedDownload.savePath);
        this.stateStore.transitionState(downloadId, DownloadState.PAUSED, download.state);
        this.stateStore.updateDownload(downloadId, {
          lastError: 'requires_overwrite_confirmation',
        });
        this.eventBus.emitNeedsConfirmation(downloadId, {
          savePath: preparedDownload.savePath,
          existingSize: stats.size,
          expectedSize: preparedDownload.totalBytes ?? 0,
          title: preparedDownload.title,
        });
        this.eventBus.emitStateChanged(this.stateStore.getStateVersion());
        return;
      } catch (statErr) {
        // Archivo no existe en disco, continuar con la descarga
        log.debug?.(
          `[processDownload] Archivo no encontrado para descarga ${downloadId}:`,
          (statErr as Error)?.message
        );
      }
    }

    this.stateStore.transitionState(downloadId, DownloadState.STARTING, download.state);
    // _registerDownloadHost se ejecuta en hook onEnter(STARTING)
    // Registrar inicio de descarga en métricas
    const dlHost = this.scheduler.extractHost(preparedDownload.url ?? '');
    downloadMetrics.recordStart(downloadId, dlHost);
    this.eventBus.emitStateChanged(this.stateStore.getStateVersion());

    // Correlation ID: sessionId asociado a este ciclo de vida de la descarga
    const sid = this.sessionManager.getSessionId(downloadId);

    try {
      const useChunked = await this._shouldUseChunkedDownload(preparedDownload);
      if (useChunked) {
        log.info(`[startDownload] [sid:${sid}] Descarga ${downloadId} → chunked`);
        await this._startChunkedDownload(preparedDownload);
      } else {
        log.info(`[startDownload] [sid:${sid}] Descarga ${downloadId} → simple`);
        await this._startSimpleDownload(preparedDownload);
      }
    } catch (error) {
      const err = error as Error;
      log.error(`[startDownload] [sid:${sid}] Error iniciando descarga ${downloadId}:`, error);
      downloadMetrics.recordFailed(downloadId);
      // Reportar fallo al controlador de concurrencia adaptativa
      this._reportAdaptiveError(downloadId, false);
      this.stateStore.transitionState(downloadId, DownloadState.FAILED);
      this.stateStore.updateDownload(downloadId, { lastError: err.message });
      this.eventBus.emitDownloadFailed(downloadId, err);
      this._unregisterDownloadHost(downloadId);
      throw error;
    }
  }

  async _startSimpleDownload(download: Download): Promise<void> {
    return simpleDownloader.startSimpleDownload(
      this as unknown as import('./types').DownloadEngineRef,
      {
        id: download.id,
        url: download.url,
        savePath: download.savePath,
        totalBytes: download.totalBytes,
        forceOverwrite: download.forceOverwrite,
      }
    );
  }

  async _startChunkedDownload(download: Download & { url?: string | null }): Promise<void> {
    return chunkDownloader.startChunkedDownload(
      this as unknown as import('./types').ChunkEngineRef,
      {
        id: download.id,
        totalBytes: download.totalBytes,
        savePath: download.savePath,
        url: download.url ?? null,
        forceOverwrite: download.forceOverwrite,
        startedAt: download.startedAt,
      }
    );
  }

  async _mergeChunks(downloadId: number): Promise<void> {
    if (this.mergeInProgress.has(downloadId)) return;

    const download = this.stateStore.getDownload(downloadId);
    if (!download || download.state !== DownloadState.DOWNLOADING) {
      log.warn(
        `[_mergeChunks] Descarga ${downloadId} no está en DOWNLOADING (estado: ${download?.state}), abortando merge`
      );
      return;
    }

    this.mergeInProgress.add(downloadId);
    const transitioned = this.stateStore.transitionState(downloadId, DownloadState.MERGING);
    if (!transitioned) {
      log.warn(
        `[_mergeChunks] No se pudo transicionar descarga ${downloadId} a MERGING, abortando`
      );
      this.mergeInProgress.delete(downloadId);
      return;
    }
    this.eventBus.emitMergeStarted(downloadId);

    try {
      await chunkDownloader.mergeChunks(
        this as unknown as import('./types').ChunkEngineRef,
        downloadId
      );
    } catch (error) {
      const err = error as Error;
      log.error(`Error en merge de descarga ${downloadId}:`, error);
      this.stateStore.transitionState(downloadId, DownloadState.FAILED);
      this.stateStore.updateDownload(downloadId, { lastError: err.message });
      this.eventBus.emitDownloadFailed(downloadId, err);
      this.eventBus.emitStateChanged(this.stateStore.getStateVersion());
      throw error;
    } finally {
      this.mergeInProgress.delete(downloadId);
    }
  }

  async _verifyDownload(downloadId: number): Promise<void> {
    const download = this.stateStore.getDownload(downloadId)!;
    const skipVerification = this.downloadConfigOverrides.skipVerification === true;
    if (skipVerification) {
      this.stateStore.transitionState(downloadId, DownloadState.COMPLETED, DownloadState.VERIFYING);
      this.stateStore.updateDownload(downloadId, {
        completedAt: Date.now(),
        progress: 1.0,
        downloadedBytes: download.totalBytes,
        lastError: null,
      });
      // Borrar archivos temporales (chunks) al completar; el archivo final ya está en savePath
      this.chunkStore
        .deleteAllChunks(downloadId)
        .catch((e: Error) => log.debug?.(`Cleanup chunks al completar ${downloadId}:`, e?.message));
      const updatedDownload = this.stateStore.getDownload(downloadId);
      const stateVersion = this.stateStore.getStateVersion();
      this.eventBus.emitDownloadCompleted(downloadId, {
        title: updatedDownload?.title,
        savePath: updatedDownload?.savePath ?? undefined,
      });
      this.eventBus.emitStateChanged(stateVersion);
      log.info(
        `[sid:${this.sessionManager.getSessionId(downloadId)}] Descarga ${downloadId} completada (verificación omitida). Procesando siguiente en cola...`
      );
      downloadMetrics.recordCompleted(downloadId, download.totalBytes ?? undefined);
      // Reportar éxito al controlador de concurrencia adaptativa
      this._reportAdaptiveSuccess(downloadId, download);
      // _unregisterDownloadHost se ejecuta en hook onExit(VERIFYING → COMPLETED)
      this._scheduleProcessQueue();
      return;
    }
    this.eventBus.emitVerificationStarted(downloadId);
    this.eventBus.emitStateChanged(this.stateStore.getStateVersion());

    try {
      const sizeResult = await this.verifier.verifyFile(download.savePath!, download.totalBytes);
      if (!sizeResult.sizeValid) {
        throw new Error(`Tamaño incorrecto: ${sizeResult.actualSize}/${download.totalBytes}`);
      }

      let actualHash: string | null = download.actualHash;
      type VerificationResult = { hash?: string; actualHash?: string; hashValid?: boolean };
      let verificationResult: VerificationResult = {};

      if (download.expectedHash || download.totalBytes >= 1024 * 1024) {
        verificationResult = (await this._runWorker(
          'VERIFY_HASH',
          { filePath: download.savePath ?? undefined },
          (progress: number, _bytesProcessed: number) => {
            this.eventBus.emitDownloadProgress(downloadId, {
              progress: 1.0,
              downloadedBytes: download.totalBytes,
              totalBytes: download.totalBytes,
              verificationProgress: progress,
              merging: false,
              speed: 0,
              speedBytesPerSec: 0,
              remainingTime: null,
              chunked: false,
            });
          }
        )) as VerificationResult;
        actualHash = verificationResult.hash ?? null;

        if (download.expectedHash && actualHash) {
          const hashValid = actualHash === download.expectedHash.toLowerCase();
          if (!hashValid) {
            throw new Error(`Hash incorrecto: ${actualHash} !== ${download.expectedHash}`);
          }
        }
      }

      if (verificationResult.actualHash) {
        this.stateStore.updateDownload(downloadId, {
          actualHash: verificationResult.actualHash,
          hashVerified: verificationResult.hashValid !== false,
          sizeVerified: true,
        });
      } else if (download.totalBytes >= 1024 * 1024) {
        try {
          const calculatedHash = await this.verifier.calculateHash(download.savePath!);
          this.stateStore.updateDownload(downloadId, {
            actualHash: calculatedHash,
            hashVerified: false,
            sizeVerified: true,
          });
          log.debug(
            `Hash calculado y guardado para descarga ${downloadId} (${calculatedHash.substring(0, 8)}...)`
          );
        } catch (hashError) {
          log.warn(
            `Error calculando hash para descarga ${downloadId}:`,
            (hashError as Error).message
          );
        }
      }

      this.stateStore.transitionState(downloadId, DownloadState.COMPLETED, DownloadState.VERIFYING);
      this.stateStore.updateDownload(downloadId, {
        completedAt: Date.now(),
        progress: 1.0,
        downloadedBytes: download.totalBytes,
        lastError: null,
      });
      // Borrar archivos temporales (chunks) al completar; el archivo final ya está en savePath
      this.chunkStore
        .deleteAllChunks(downloadId)
        .catch((e: Error) => log.debug?.(`Cleanup chunks al completar ${downloadId}:`, e?.message));

      const updatedDownload = this.stateStore.getDownload(downloadId);
      const stateVersion = this.stateStore.getStateVersion();
      this.eventBus.emitDownloadCompleted(downloadId, {
        title: updatedDownload?.title,
        savePath: updatedDownload?.savePath ?? undefined,
      });
      this.eventBus.emitStateChanged(stateVersion);

      log.info(
        `[sid:${this.sessionManager.getSessionId(downloadId)}] Descarga ${downloadId} completada exitosamente. Procesando siguiente descarga en cola...`
      );
      downloadMetrics.recordCompleted(downloadId, download.totalBytes ?? undefined);
      // Reportar éxito al controlador de concurrencia adaptativa
      this._reportAdaptiveSuccess(downloadId, download);
      // _unregisterDownloadHost se ejecuta en hook onExit(VERIFYING → COMPLETED)
      this._scheduleProcessQueue();
    } catch (error) {
      const err = error as Error;
      log.error(
        `[sid:${this.sessionManager.getSessionId(downloadId)}] Error verificando descarga ${downloadId}:`,
        error
      );
      downloadMetrics.recordFailed(downloadId);
      // Reportar fallo al controlador de concurrencia adaptativa
      this._reportAdaptiveError(downloadId, false);
      this.stateStore.transitionState(downloadId, DownloadState.FAILED);
      this.stateStore.updateDownload(downloadId, { lastError: err.message });
      this.eventBus.emitDownloadFailed(downloadId, err);
      // _unregisterDownloadHost se ejecuta en hook onExit(VERIFYING → FAILED)
      throw error;
    }
  }

  async _shouldUseChunkedDownload(
    download: Download & { totalBytes?: number; url?: string | null }
  ): Promise<boolean> {
    if (this.downloadConfigOverrides.forceDirectDownload === true) {
      log.info('[DownloadEngine] Descarga por chunks desactivada (solo descarga directa)');
      return false;
    }
    if (!this.downloadService) return false;

    try {
      if (!download.totalBytes || download.totalBytes === 0) {
        const freshSize = await this._getFileSize(download.url ?? '');
        if (freshSize > 0) {
          this.stateStore.updateDownload(download.id, { totalBytes: freshSize });
          download.totalBytes = freshSize;
        }
      }

      const useChunked = await this.downloadService.shouldUseChunkedDownload(
        download.url ?? null,
        download.totalBytes ?? 0
      );
      if (!useChunked) return false;

      const chunkedConfig =
        (config.downloads as { chunked?: { checkRangeSupport?: boolean } })?.chunked ?? {};
      if (chunkedConfig.checkRangeSupport) {
        const supportsRange = await this._checkRangeSupport(download.url ?? '');
        if (!supportsRange) {
          log.info(
            `[DownloadEngine] Servidor no soporta Range requests para ${download.url}, usando descarga simple`
          );
          return false;
        }
      }
      return true;
    } catch (error) {
      log.warn('Error determinando estrategia de descarga:', error);
      return false;
    }
  }

  async _checkRangeSupport(url: string): Promise<boolean> {
    const { net } = await import('electron');
    const timeoutMs =
      (config.downloads as { chunked?: { rangeSupportTimeout?: number } })?.chunked
        ?.rangeSupportTimeout ??
      (config.network as { responseTimeout?: number })?.responseTimeout ??
      5000;
    return new Promise<boolean>(resolve => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const req = net.request({ method: 'HEAD', url });
      req.setHeader('Range', 'bytes=0-0');
      timeoutId = setTimeout(() => {
        try {
          const r = req as { destroyed?: boolean; abort?: () => void };
          if (r && !r.destroyed && r.abort) r.abort();
        } catch (abortErr) {
          log.debug?.('Error abortando request HEAD:', (abortErr as Error)?.message);
        }
        resolve(false);
      }, timeoutMs);

      req.on(
        'response',
        (response: { statusCode: number; headers: Record<string, string | string[]> }) => {
          if (timeoutId) clearTimeout(timeoutId);
          timeoutId = null;
          const code = response.statusCode;
          if (code === 206) {
            resolve(true);
            return;
          }
          if (code === 200) {
            const acceptRanges = (
              (response.headers['accept-ranges'] ??
                response.headers['Accept-Ranges'] ??
                '') as string
            ).toLowerCase();
            resolve(acceptRanges === 'bytes');
            return;
          }
          resolve(false);
        }
      );
      req.on('error', () => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(false);
      });
      req.end();
    });
  }

  async _ensureDownloadMetadata(
    download: Download
  ): Promise<Download & { url: string; savePath?: string; totalBytes?: number }> {
    const updates: Record<string, unknown> = {};
    let url: string = download.url ?? '';

    if (!url) {
      const fileInfo = this.catalogProvider?.getFileDownloadInfo(download.id) ?? null;
      if (!fileInfo || !fileInfo.url) {
        throw new Error(`No se pudo obtener URL para descarga ${download.id}`);
      }
      url = fileInfo.url;
      if (!url.startsWith('http')) {
        const parts = url.split('/').map((part: string) => encodeURIComponent(part));
        url = `https://myrient.erista.me/files/${parts.join('/')}`;
      }
      updates.url = url;
      const fileTitle =
        (fileInfo as { title?: string; name?: string }).title ??
        (fileInfo as { name?: string }).name;
      if (!download.title && fileTitle) {
        updates.title = fileTitle;
      }
    }

    if (!isValidUrl(url)) {
      throw new Error(`URL no válida o no permitida: ${url}`);
    }

    if (!download.totalBytes || download.totalBytes === 0) {
      const size = await this._getFileSize(url);
      if (size > 0) {
        updates.totalBytes = size;
        (download as Download & { totalBytes: number }).totalBytes = size;
      }
    }

    if (!download.savePath) {
      const savePath = await this._determineSavePath({
        id: download.id,
        title: download.title || (updates.title as string) || 'download',
        downloadPath: download.downloadPath,
        preserveStructure: download.preserveStructure !== false,
      });
      if (!savePath) {
        throw new Error('No se seleccionó ubicación de guardado');
      }
      updates.savePath = savePath;
      (download as Download & { savePath: string }).savePath = savePath;
    }

    if (Object.keys(updates).length > 0) {
      this.stateStore.updateDownload(download.id, updates);
    }

    return { ...download, ...updates, url } as Download & {
      url: string;
      savePath?: string;
      totalBytes?: number;
    };
  }

  async _getFileSize(
    url: string,
    retries: number = (config.network as { maxRetries?: number })?.maxRetries ?? 3
  ): Promise<number> {
    const { net } = await import('electron');
    const circuitBreaker = this._getHostCircuitBreaker(url);

    const operation = async (): Promise<number> => {
      for (let i = 0; i < retries; i++) {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let headRequest:
          | {
              abort?: () => void;
              on: (_ev: string, _fn: (..._a: unknown[]) => void) => void;
              end: () => void;
              destroyed?: boolean;
            }
          | undefined;
        try {
          headRequest = net.request({ method: 'HEAD', url }) as typeof headRequest;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => {
                if (headRequest && headRequest.abort) headRequest.abort();
                reject(new Error('Timeout'));
              },
              (config.network as { timeout?: number })?.timeout ?? 15000
            );
          });

          const requestPromise = new Promise<{ headers: Record<string, string | string[]> }>(
            (resolve, reject) => {
              headRequest!.on('response', (response: unknown) => {
                if (timeoutId) clearTimeout(timeoutId);
                resolve(response as { headers: Record<string, string | string[]> });
              });
              headRequest!.on('error', (error: unknown) => {
                if (timeoutId) clearTimeout(timeoutId);
                reject(error);
              });
              headRequest!.end();
            }
          );

          const response = await Promise.race([requestPromise, timeoutPromise]);
          if (timeoutId) clearTimeout(timeoutId);
          const size = parseInt(
            (Array.isArray(response.headers['content-length'])
              ? response.headers['content-length'][0]
              : response.headers['content-length']) || '0',
            10
          );
          return Number.isFinite(size) ? Math.max(0, size) : 0;
        } catch (error) {
          if (timeoutId) clearTimeout(timeoutId);
          if (i === retries - 1) throw error;
          await new Promise(resolve =>
            setTimeout(
              resolve,
              ((config.network as { retryDelay?: number })?.retryDelay ?? 1000) * Math.pow(2, i)
            )
          );
        }
      }
      return 0;
    };

    if (circuitBreaker && (config.circuitBreaker as { enabled?: boolean })?.enabled) {
      try {
        return (await circuitBreaker.execute(operation, () => {
          throw new Error('Circuit breaker');
        })) as number;
      } catch (error) {
        log.warn(`[CircuitBreaker] HEAD falló para ${url}:`, (error as Error).message);
        return 0;
      }
    }
    return operation();
  }

  async _determineSavePath(options: {
    id: number;
    title: string;
    downloadPath: string | null;
    preserveStructure: boolean;
  }): Promise<string | null> {
    const normalizedDownloadPath =
      options.downloadPath && typeof options.downloadPath === 'string'
        ? options.downloadPath.trim()
        : null;

    if (!normalizedDownloadPath || normalizedDownloadPath.length === 0) {
      return null;
    }

    if (this.fileService) {
      let relativePath = '';
      if (options.preserveStructure && this.catalogProvider) {
        const ancestors = this.catalogProvider.getFileAncestorPath(options.id);
        relativePath = ancestors
          .map((a: { name?: string; title?: string }) => {
            const name = a.name ?? a.title ?? '';
            if (!name) return '';
            const validation = this.fileService!.validateFilename(name.replace(/\/$/, ''));
            return validation.valid ? (validation.data ?? '') : '';
          })
          .filter(Boolean)
          .join(path.sep);
      }

      const result = this.fileService.buildSavePath(
        normalizedDownloadPath,
        options.title,
        options.preserveStructure,
        relativePath
      );
      if (result.success) return result.savePath ?? null;
      log.warn(`Fallo construyendo savePath con FileService: ${result.error}`);
    }

    const ancestors =
      options.preserveStructure && this.catalogProvider
        ? this.catalogProvider.getFileAncestorPath(options.id)
        : [];
    const ancestorPath = ancestors
      .map((a: { name?: string; title?: string }) => (a.name ?? a.title ?? '').replace(/\/$/, ''))
      .filter(Boolean)
      .join(path.sep);
    return options.preserveStructure && ancestorPath
      ? path.join(normalizedDownloadPath, ancestorPath, options.title)
      : path.join(normalizedDownloadPath, options.title);
  }

  async pauseDownload(downloadId: number): Promise<Snapshot> {
    const download = this.stateStore.getDownload(downloadId);
    if (!download) throw new Error(`Descarga ${downloadId} no encontrada`);
    log.info(
      `[pauseDownload] [sid:${this.sessionManager.getSessionId(downloadId)}] Descarga ${downloadId} (estado: ${download.state})`
    );

    if (download.state === DownloadState.PAUSED) {
      return this.stateStore.getSnapshot();
    }

    if (!this.stateStore.canTransition(download.state, DownloadState.PAUSED)) {
      throw new Error(`No se puede pausar descarga en estado: ${download.state}`);
    }

    // Guardar checkpoint de integridad parcial antes de cerrar streams (para reanudar)
    if (this.activeDownloads.has(downloadId)) {
      await simpleDownloader.savePartialCheckpointForPause(
        this as unknown as import('./types').DownloadEngineRef,
        downloadId
      );
    }
    await chunkDownloader.saveChunkCheckpointsForPause(
      this as unknown as import('./types').ChunkEngineRef,
      downloadId
    );
    this._cleanupActiveDownload(downloadId);
    this.sessionManager.invalidate(downloadId);
    chunkDownloader.abortAllChunksForDownload(
      this as unknown as import('./types').ChunkEngineRef,
      downloadId
    );
    const chunks = this.stateStore.getChunks(downloadId);
    for (const c of chunks) {
      if (c.state === ChunkState.DOWNLOADING) {
        this.stateStore.updateChunkProgress(downloadId, c.chunkIndex, { state: ChunkState.PAUSED });
      }
    }

    this.stateStore.transitionState(downloadId, DownloadState.PAUSED as string);
    this.stateStore.clearLastError(downloadId);
    downloadMetrics.recordCancelledOrPaused(downloadId);
    chunkProgressCache.clear(downloadId); // Liberar caché de progreso de chunks al pausar
    const snapshot = this.stateStore.getSnapshot();
    this.eventBus.emitStateChanged(snapshot.stateVersion);
    return snapshot;
  }

  async resumeDownload(downloadId: number): Promise<Snapshot> {
    const download = this.stateStore.getDownload(downloadId);
    if (!download) throw new Error(`Descarga ${downloadId} no encontrada`);

    const currentState = download.state;
    log.info(`[resumeDownload] Descarga ${downloadId}: estado actual = ${currentState}`);

    if (currentState === DownloadState.PAUSED) {
      const transitioned = this.stateStore.transitionState(downloadId, DownloadState.QUEUED);
      if (!transitioned)
        log.warn(`No se pudo transicionar descarga ${downloadId} de PAUSED a QUEUED`);
      else log.info(`[resumeDownload] Descarga ${downloadId}: transicionado de PAUSED a QUEUED`);
      const snapshot = this.stateStore.getSnapshot();
      this.eventBus.emitStateChanged(snapshot.stateVersion);
      this._scheduleProcessQueue();
      return snapshot;
    }

    if (currentState === DownloadState.QUEUED) {
      const snapshot = this.stateStore.getSnapshot();
      this.eventBus.emitStateChanged(snapshot.stateVersion);
      this._scheduleProcessQueue(50);
      return snapshot;
    }

    if (currentState === DownloadState.CANCELLED || currentState === DownloadState.FAILED) {
      log.info(`[resumeDownload] Descarga ${downloadId}: reiniciando desde ${currentState}`);
      this.stateStore.updateDownload(downloadId, {
        lastError: null,
        progress: 0,
        downloadedBytes: 0,
        completedAt: null,
        startedAt: null,
        retryCount: 0,
      });
      const transitioned = this.stateStore.transitionState(downloadId, DownloadState.QUEUED);
      if (!transitioned)
        log.warn(`No se pudo transicionar descarga ${downloadId} de ${currentState} a QUEUED`);
      this.stateStore.deleteChunks(downloadId);
      await chunkStore.deleteAllChunks(downloadId);
    } else {
      return this.stateStore.getSnapshot();
    }

    const snapshot = this.stateStore.getSnapshot();
    this.eventBus.emitStateChanged(snapshot.stateVersion);
    this._scheduleProcessQueue();
    return snapshot;
  }

  async pauseAll(): Promise<Snapshot> {
    const snapshot = this.stateStore.getSnapshot();
    const toPause = snapshot.downloads.filter(d =>
      (
        [
          DownloadState.QUEUED,
          DownloadState.STARTING,
          DownloadState.DOWNLOADING,
          DownloadState.MERGING,
          DownloadState.VERIFYING,
        ] as string[]
      ).includes(d.state)
    );

    for (const d of toPause) {
      this._cleanupActiveDownload(d.id);
      this.sessionManager.invalidate(d.id);
      chunkDownloader.abortAllChunksForDownload(
        this as unknown as import('./types').ChunkEngineRef,
        d.id
      );
      const chunks = this.stateStore.getChunks(d.id);
      for (const c of chunks) {
        if (c.state === ChunkState.DOWNLOADING) {
          this.stateStore.updateChunkProgress(d.id, c.chunkIndex, { state: ChunkState.PAUSED });
        }
      }
      if (this.stateStore.canTransition(d.state, DownloadState.PAUSED)) {
        this.stateStore.transitionState(d.id, DownloadState.PAUSED as string);
      }
      chunkProgressCache.clear(d.id); // Liberar caché de chunks al pausar
    }

    const newSnapshot = this.stateStore.getSnapshot();
    this.eventBus.emitStateChanged(newSnapshot.stateVersion);
    log.info(`[pauseAll] Pausadas ${toPause.length} descarga(s)`);
    return newSnapshot;
  }

  async cancelDownload(downloadId: number): Promise<Snapshot> {
    const download = this.stateStore.getDownload(downloadId);
    if (!download) throw new Error(`Descarga ${downloadId} no encontrada`);
    log.info(
      `[cancelDownload] [sid:${this.sessionManager.getSessionId(downloadId)}] Descarga ${downloadId} (estado: ${download.state})`
    );

    this._cleanupActiveDownload(downloadId);
    this.sessionManager.invalidate(downloadId);
    downloadMetrics.recordCancelledOrPaused(downloadId);
    chunkProgressCache.clear(downloadId); // Liberar caché de chunks al cancelar
    // Durante MERGING no abortamos chunks (el worker los está usando); solo cambiamos estado
    if (download.state !== DownloadState.MERGING) {
      chunkDownloader.abortAllChunksForDownload(
        this as unknown as import('./types').ChunkEngineRef,
        downloadId
      );
    }

    const transitioned = this.stateStore.transitionState(
      downloadId,
      DownloadState.CANCELLED as string
    );
    if (transitioned) {
      // No borrar chunks ni archivos si sigue en merge (el worker los usa); se limpia al terminar el merge
      if (download.state !== DownloadState.MERGING) {
        this.stateStore.deleteChunks(downloadId);
        await chunkStore.deleteAllChunks(downloadId);
      }
    } else {
      log.warn(
        `[cancelDownload] No se pudo transicionar descarga ${downloadId} a CANCELLED (estado actual: ${download.state})`
      );
    }

    const snapshot = this.stateStore.getSnapshot();
    this.eventBus.emitStateChanged(snapshot.stateVersion);
    return snapshot;
  }

  async cancelAll(): Promise<Snapshot> {
    const snapshot = this.stateStore.getSnapshot();
    const toCancel = snapshot.downloads.filter(d =>
      (
        [
          DownloadState.QUEUED,
          DownloadState.STARTING,
          DownloadState.DOWNLOADING,
          DownloadState.MERGING,
          DownloadState.VERIFYING,
          DownloadState.PAUSED,
        ] as string[]
      ).includes(d.state)
    );

    for (const d of toCancel) {
      this._cleanupActiveDownload(d.id);
      this.sessionManager.invalidate(d.id);
      chunkProgressCache.clear(d.id); // Liberar caché de chunks al cancelar
      // Durante MERGING no abortamos chunks (el worker los está usando); solo cambiamos estado
      if (d.state !== DownloadState.MERGING) {
        chunkDownloader.abortAllChunksForDownload(
          this as unknown as import('./types').ChunkEngineRef,
          d.id
        );
      }
      if (this.stateStore.canTransition(d.state, DownloadState.CANCELLED)) {
        const transitioned = this.stateStore.transitionState(
          d.id,
          DownloadState.CANCELLED as string
        );
        if (transitioned) {
          // No borrar chunks ni archivos si sigue en merge (el worker los usa); se limpia al terminar
          if (d.state !== DownloadState.MERGING) {
            this.stateStore.deleteChunks(d.id);
            await chunkStore.deleteAllChunks(d.id);
          }
        }
      }
    }

    const newSnapshot = this.stateStore.getSnapshot();
    this.eventBus.emitStateChanged(newSnapshot.stateVersion);
    log.info(`[cancelAll] Canceladas ${toCancel.length} descarga(s)`);
    return newSnapshot;
  }

  async resumeAll(): Promise<Snapshot> {
    const snapshot = this.stateStore.getSnapshot();
    const toResume = snapshot.downloads.filter(d => d.state === DownloadState.PAUSED);

    for (const d of toResume) {
      if (this.stateStore.canTransition(d.state, DownloadState.QUEUED)) {
        this.stateStore.transitionState(d.id, DownloadState.QUEUED);
      }
    }

    const newSnapshot = this.stateStore.getSnapshot();
    this.eventBus.emitStateChanged(newSnapshot.stateVersion);
    log.info(`[resumeAll] Reanudadas ${toResume.length} descarga(s)`);
    this._scheduleProcessQueue();
    return newSnapshot;
  }

  getSnapshot(minVersion?: number | null): Snapshot {
    return this.stateStore.getSnapshot(minVersion ?? null);
  }

  setDownloadConfigOverrides(
    settings: {
      maxConcurrentChunks?: number;
      maxChunkRetries?: number;
      chunkOperationTimeoutMinutes?: number;
      skipVerification?: boolean;
      disableChunkedDownloads?: boolean;
    } = {}
  ): void {
    if (typeof settings.maxConcurrentChunks === 'number' && settings.maxConcurrentChunks >= 1) {
      this.downloadConfigOverrides.maxConcurrentChunks = settings.maxConcurrentChunks;
      this.concurrencyController.setMaxChunkSlotsPerDownload(settings.maxConcurrentChunks);
    }
    if (typeof settings.maxChunkRetries === 'number' && settings.maxChunkRetries >= 0) {
      this.downloadConfigOverrides.maxChunkRetries = settings.maxChunkRetries;
    }
    if (
      typeof settings.chunkOperationTimeoutMinutes === 'number' &&
      settings.chunkOperationTimeoutMinutes >= 1
    ) {
      this.downloadConfigOverrides.chunkOperationTimeoutMinutes =
        settings.chunkOperationTimeoutMinutes;
    }
    if (typeof settings.skipVerification === 'boolean') {
      this.downloadConfigOverrides.skipVerification = settings.skipVerification;
    }
    if (typeof settings.disableChunkedDownloads === 'boolean') {
      this.downloadConfigOverrides.forceDirectDownload = settings.disableChunkedDownloads
        ? true
        : false;
    }
  }

  async confirmOverwrite(downloadId: number): Promise<Snapshot> {
    const download = this.stateStore.getDownload(downloadId);
    if (!download) throw new Error(`Descarga ${downloadId} no encontrada`);

    const originalState = download.state;
    const needsRestart =
      originalState === DownloadState.COMPLETED ||
      (originalState === DownloadState.PAUSED &&
        download.lastError === 'requires_overwrite_confirmation');

    this.stateStore.updateDownload(downloadId, {
      forceOverwrite: true,
      lastError: null,
    });

    if (needsRestart) {
      this.stateStore.deleteChunks(downloadId);
      await chunkStore.deleteAllChunks(downloadId);

      if (download.savePath) {
        try {
          await fs.unlink(download.savePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.warn(`Error eliminando archivo existente: ${(error as Error).message}`);
          }
        }
      }

      this.stateStore.updateDownload(downloadId, {
        progress: 0,
        downloadedBytes: 0,
        completedAt: null,
        startedAt: null,
        actualHash: null,
        hashVerified: false,
        sizeVerified: false,
      });

      if (originalState === DownloadState.COMPLETED) {
        this.stateStore.transitionState(downloadId, DownloadState.QUEUED);
      } else if (originalState === DownloadState.PAUSED) {
        this.stateStore.transitionState(downloadId, DownloadState.QUEUED);
      }
    }

    const snapshot = this.stateStore.getSnapshot();
    this.eventBus.emitStateChanged(snapshot.stateVersion);

    const updatedDownload = this.stateStore.getDownload(downloadId);
    const currentState = updatedDownload?.state ?? originalState;

    if (needsRestart || currentState === DownloadState.QUEUED) {
      this.processQueue().catch(error => {
        log.error('Error procesando cola después de confirmar sobrescritura:', error);
      });
    } else if (currentState === DownloadState.PAUSED) {
      await this.resumeDownload(downloadId);
    }

    return snapshot;
  }

  /**
   * Reinicia descargas en estado cancelled o failed (no completed ni descargando),
   * marcándolas como forceOverwrite para no pedir confirmación de reemplazo.
   * @param ids - Si se indica, solo se reinician estas descargas (solo las que estén cancelled/failed).
   */
  async restartStoppedWithOverwrite(ids?: number[]): Promise<Snapshot> {
    const snapshot = this.stateStore.getSnapshot();
    const candidate = ids ? snapshot.downloads.filter(d => ids.includes(d.id)) : snapshot.downloads;
    const toRestart = candidate.filter(
      d => d.state === DownloadState.CANCELLED || d.state === DownloadState.FAILED
    );
    if (toRestart.length === 0) {
      return snapshot;
    }
    for (const d of toRestart) {
      const downloadId = d.id;
      this.stateStore.updateDownload(downloadId, {
        forceOverwrite: true,
        lastError: null,
      });
      const download = this.stateStore.getDownload(downloadId);
      if (!download) continue;
      if (download.state === DownloadState.CANCELLED || download.state === DownloadState.FAILED) {
        this.stateStore.updateDownload(downloadId, {
          progress: 0,
          downloadedBytes: 0,
          completedAt: null,
          startedAt: null,
          retryCount: 0,
        });
        this.stateStore.transitionState(downloadId, DownloadState.QUEUED);
        this.stateStore.deleteChunks(downloadId);
        void chunkStore.deleteAllChunks(downloadId);
      }
    }
    const newSnapshot = this.stateStore.getSnapshot();
    this.eventBus.emitStateChanged(newSnapshot.stateVersion);
    log.info(
      `[restartStoppedWithOverwrite] Reiniciadas ${toRestart.length} descarga(s) con overwrite`
    );
    this.processQueue().catch(error => {
      log.error('Error procesando cola tras reiniciar descargas:', error);
    });
    return newSnapshot;
  }

  _runWorker(
    type: string,
    taskData: Record<string, unknown>,
    onProgress?: (_progress: number, _bytesProcessed: number) => void
  ): Promise<unknown> {
    if (this.workerPool) {
      return this.workerPool.execute({ type, ...taskData }, onProgress);
    }
    return this._runWorkerDirect(type, taskData, onProgress);
  }

  _runWorkerDirect(
    type: string,
    taskData: Record<string, unknown>,
    onProgress?: (_progress: number, _bytesProcessed: number) => void
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const workerPath = getDownloadWorkerPath();
      const worker = new Worker(workerPath);
      const taskId = Date.now().toString();

      worker.postMessage({ type, taskId, ...taskData });

      worker.on(
        'message',
        (msg: {
          type: string;
          taskId?: string;
          progress?: number;
          bytesProcessed?: number;
          result?: unknown;
          error?: string;
        }) => {
          if (msg.type === 'PROGRESS' && onProgress) {
            onProgress(msg.progress ?? 0, msg.bytesProcessed ?? 0);
          } else if (msg.type === 'SUCCESS' && msg.taskId === taskId) {
            worker.terminate();
            resolve(msg.result);
          } else if (msg.type === 'ERROR' && msg.taskId === taskId) {
            worker.terminate();
            reject(new Error(msg.error));
          }
        }
      );

      worker.on('error', err => {
        worker.terminate();
        reject(err);
      });

      worker.on('exit', code => {
        if (code !== 0) {
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });
    });
  }

  async getDownloadDebug(downloadId: number): Promise<Record<string, unknown>> {
    const download = this.stateStore.getDownload(downloadId);
    if (!download) throw new Error(`Descarga ${downloadId} no encontrada`);

    const chunks = this.stateStore.getChunks(downloadId);
    const attempts = this.stateStore.getAttempts(downloadId);
    const history = this.stateStore.getHistory(downloadId);
    const activeDownload = this.activeDownloads.get(downloadId);
    const activeChunks = Array.from(this.activeChunks.keys())
      .filter(key => key.startsWith(`${downloadId}-`))
      .map(key => this.activeChunks.get(key));

    return {
      download: {
        id: download.id,
        title: download.title,
        url: download.url,
        state: download.state,
        progress: download.progress,
        downloadedBytes: download.downloadedBytes,
        totalBytes: download.totalBytes,
        savePath: download.savePath,
        priority: download.priority,
        forceOverwrite: download.forceOverwrite,
        lastError: download.lastError,
        createdAt: download.createdAt,
        startedAt: download.startedAt,
        completedAt: download.completedAt,
      },
      chunks: {
        total: chunks.length,
        completed: chunks.filter(c => c.state === ChunkState.COMPLETED).length,
        downloading: chunks.filter(c => c.state === ChunkState.DOWNLOADING).length,
        failed: chunks.filter(c => c.state === ChunkState.FAILED).length,
        paused: chunks.filter(c => c.state === ChunkState.PAUSED).length,
        details: chunks.map(c => ({
          index: c.chunkIndex,
          state: c.state,
          downloadedBytes: c.downloadedBytes,
          totalBytes: c.endByte - c.startByte + 1,
          tempFile: c.tempFile,
          hash: c.hash,
          hashVerified: c.hashVerified,
        })),
      },
      attempts: {
        total: attempts.length,
        details: attempts.map(a => ({
          attemptNumber: a.attemptNumber,
          timestamp: a.timestamp,
          error: a.error,
          errorCode: a.errorCode,
          bytesTransferred: a.bytesTransferred,
          durationMs: a.durationMs,
          speedBytesPerSec: a.speedBytesPerSec,
        })),
      },
      history: {
        total: history.length,
        events: history.map(h => ({
          eventType: h.eventType,
          eventData: h.eventData,
          createdAt: h.createdAt,
        })),
      },
      active: {
        isActive: !!activeDownload,
        activeChunks: activeChunks.length,
        mergeInProgress: this.mergeInProgress.has(downloadId),
      },
    };
  }

  /**
   * Devuelve métricas agregadas de la sesión actual. Incluye
   * percentiles de latencia, buffer pool, worker pool, profundidad de cola y circuit breaker por host.
   */
  getSessionMetrics(): Record<string, unknown> {
    const metrics = downloadMetrics.getGlobalMetrics() as unknown as Record<string, unknown>;
    // Incluir estado del controlador de concurrencia adaptativa
    if (this._adaptiveConcurrency?.enabled) {
      (metrics as Record<string, unknown>).adaptiveConcurrency =
        this._adaptiveConcurrency.getStatus();
    }
    // Métricas extendidas para diagnóstico
    (metrics as Record<string, unknown>).latencyPercentiles =
      downloadMetrics.getLatencyPercentiles();
    (metrics as Record<string, unknown>).bufferPool = FileAssembler.getBufferPoolStats();
    const wp = this.workerPool as { getStats?: () => unknown } | null;
    (metrics as Record<string, unknown>).workerPool = wp?.getStats?.() ?? null;
    (metrics as Record<string, unknown>).queueDepth = this.stateStore.getSnapshot().summary.queued;
    (metrics as Record<string, unknown>).circuitBreakerByHost =
      circuitBreakerManager.getAllHostStates();
    return metrics;
  }

  _getHostCircuitBreaker(url: string): ReturnType<typeof circuitBreakerManager.getCircuitBreaker> {
    return this.circuitBreakerManager.getCircuitBreaker(url);
  }

  async _handleSimpleResponse(
    downloadId: number,
    response: unknown,
    _request: unknown
  ): Promise<void> {
    return simpleDownloader.handleSimpleResponse(
      this as unknown as import('./types').DownloadEngineRef,
      downloadId,
      response as Parameters<typeof simpleDownloader.handleSimpleResponse>[2],
      _request
    );
  }

  async _handleChunkResponse(
    downloadId: number,
    chunkIndex: number,
    chunk: import('./ChunkDownloader').ChunkRange,
    response: unknown,
    request: unknown,
    actualStartByte: number,
    downloadedBytes: number,
    resolve: () => void,
    reject: (_err: Error) => void,
    sessionId: string | null = null
  ): Promise<void> {
    return chunkDownloader.handleChunkResponse(
      this as unknown as import('./types').ChunkEngineRef,
      downloadId,
      chunkIndex,
      chunk,
      response as import('./ChunkDownloader').ChunkResponseLike,
      request,
      actualStartByte,
      downloadedBytes,
      resolve,
      reject,
      sessionId
    );
  }

  _cleanupActiveDownload(downloadId: number): void {
    this.downloadManager.cleanup(downloadId);
    this._unregisterDownloadHost(downloadId);
  }

  /** Registra la descarga en el scheduler por host (tracking per-host y rate limiter). */
  _registerDownloadHost(downloadId: number, url: string): void {
    const host = this.scheduler.extractHost(url);
    if (host) this.scheduler.registerDownload(downloadId, host);
  }

  /** Desregistra la descarga del scheduler por host (libera slot per-host y rate limiter). Idempotente. */
  _unregisterDownloadHost(downloadId: number): void {
    const download = this.stateStore.getDownload(downloadId);
    const url = download?.url;
    if (url) {
      const host = this.scheduler.extractHost(url);
      if (host) this.scheduler.unregisterDownload(downloadId, host);
    }
  }

  /** Obtiene la sesión de merge incremental para una descarga (si existe). */
  getIncrementalMergeSession(downloadId: number): IncrementalMergeSession | undefined {
    return this._incrementalMergeSessions.get(downloadId);
  }

  /** Crea y almacena una sesión de merge incremental para una descarga. */
  createIncrementalMergeSession(
    downloadId: number,
    finalPath: string,
    expectedSize: number,
    chunkCount: number
  ): IncrementalMergeSession {
    const session = this.fileAssembler.startIncrementalMerge(
      downloadId,
      finalPath,
      expectedSize,
      chunkCount
    );
    this._incrementalMergeSessions.set(downloadId, session);
    return session;
  }

  /** Elimina la sesión de merge incremental de una descarga (tras finalize). */
  removeIncrementalMergeSession(downloadId: number): void {
    this._incrementalMergeSessions.delete(downloadId);
  }

  async _cleanupPartialFile(savePath: string | null): Promise<boolean> {
    if (!savePath) return false;
    const partialPath = savePath + '.part';
    try {
      await fs.unlink(partialPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      log.warn(`Error eliminando archivo parcial ${partialPath}:`, (error as Error).message);
      return false;
    }
  }

  async _waitForStateChange(
    downloadId: number,
    targetStates: string[],
    timeoutMs: number | null = null
  ): Promise<boolean> {
    const startTime = Date.now();
    const timeout =
      timeoutMs ?? (config.timing as { stateChangeTimeout?: number })?.stateChangeTimeout ?? 30000;
    const checkInterval =
      (config.timing as { stateCheckInterval?: number })?.stateCheckInterval ?? 500;

    return new Promise<boolean>(resolve => {
      const checkState = (): void => {
        const download = this.stateStore.getDownload(downloadId);
        if (!download) {
          log.warn(`Descarga ${downloadId} no encontrada mientras se esperaba cambio de estado`);
          resolve(false);
          return;
        }
        if (targetStates.includes(download.state)) {
          log.debug(
            `Descarga ${downloadId} cambió a estado ${download.state} (esperado: ${targetStates.join(', ')})`
          );
          resolve(true);
          return;
        }
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeout) {
          log.warn(
            `Timeout esperando cambio de estado para descarga ${downloadId}. Estado actual: ${download.state}, esperado: ${targetStates.join(', ')}`
          );
          resolve(false);
          return;
        }
        setTimeout(checkState, checkInterval);
      };
      checkState();
    });
  }

  _isTransientNetworkError(error: Error): boolean {
    return isTransientNetworkErrorCheck(error);
  }

  _calculateBackoffDelay(retryCount: number): number {
    return calculateBackoffDelayMs(retryCount);
  }

  // -----------------------------------------------------------------------
  // Helpers para concurrencia adaptativa
  // -----------------------------------------------------------------------

  /**
   * Reporta una descarga completada exitosamente al controlador adaptativo.
   * Calcula throughput basado en bytes y duración.
   */
  private _reportAdaptiveSuccess(
    _downloadId: number,
    download: { url?: string | null; totalBytes?: number; startedAt?: number | null }
  ): void {
    if (!this._adaptiveConcurrency?.enabled) return;
    const host = this.scheduler.extractHost(download.url ?? '') ?? 'unknown';
    const bytes = download.totalBytes ?? 0;
    const startedAt = download.startedAt ?? 0;
    const durationMs = startedAt > 0 ? Date.now() - startedAt : 0;
    this._adaptiveConcurrency.recordSuccess(host, bytes, durationMs);
    // Reportar throughput: bytes/s de esta descarga
    if (durationMs > 0 && bytes > 0) {
      const bps = (bytes / durationMs) * 1000;
      this._adaptiveConcurrency.recordThroughputSample(bps);
    }
  }

  /**
   * Reporta un fallo de descarga al controlador adaptativo.
   */
  private _reportAdaptiveError(downloadId: number, isTransient: boolean): void {
    if (!this._adaptiveConcurrency?.enabled) return;
    const download = this.stateStore.getDownload(downloadId);
    const host = this.scheduler.extractHost(download?.url ?? '') ?? 'unknown';
    this._adaptiveConcurrency.recordError(host, isTransient);
  }

  /**
   * Reporta un evento al controlador adaptativo. Invocable desde SimpleDownloader
   * y ChunkResponseHandler a través de DownloadEngineRef.
   */
  _recordAdaptiveEvent(_type: 'transient_retry', host: string): void {
    if (!this._adaptiveConcurrency?.enabled) return;
    this._adaptiveConcurrency.recordError(host, true);
  }

  /**
   * Devuelve el estado actual del controlador de concurrencia adaptativa.
   */
  getAdaptiveConcurrencyStatus(): Record<string, unknown> | null {
    if (!this._adaptiveConcurrency) return null;
    return this._adaptiveConcurrency.getStatus() as unknown as Record<string, unknown>;
  }

  /**
   * Actualiza el techo de concurrencia del controlador adaptativo.
   * Invocable desde ipcStateHandlers cuando el usuario cambia settings.
   */
  updateAdaptiveConcurrencyMax(newMax: number): void {
    this._adaptiveConcurrency?.updateUserMaxConcurrent(newMax);
  }

  async close(): Promise<void> {
    this.stopQueueProcessing();
    // Limpiar timer de debounce de processQueue
    if (this._processQueueTimer != null) {
      clearTimeout(this._processQueueTimer);
      this._processQueueTimer = null;
    }

    const active = this.stateStore.getDownloadsByState(DownloadState.DOWNLOADING);
    for (const download of active) {
      try {
        await this.pauseDownload(download.id);
      } catch (error) {
        log.warn(`Error pausando descarga ${download.id} al cerrar:`, error);
      }
    }

    for (const downloadId of this.downloadManager.store.keys()) {
      this._cleanupActiveDownload(downloadId);
    }
    this.chunkManager.cleanupAll();

    this.eventBus.removeAllListeners();
    chunkProgressCache.clearAll(); // Liberar toda la memoria del caché de chunks al cerrar

    if (this.workerPool) {
      await this.workerPool.shutdown();
      this.workerPool = null;
    }

    this.stateStore.close();
    this.isInitialized = false;
    log.info('DownloadEngine cerrado');
  }
}

const downloadEngine = new DownloadEngine();
export default downloadEngine;
