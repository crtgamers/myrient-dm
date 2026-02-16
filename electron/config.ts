/**
 * Configuración por defecto del proceso main (valores de runtime).
 *
 * Aquí se definen timeouts, límites de cola, parámetros del motor de descargas,
 * circuit breaker, rutas de DB, etc. Los ajustes que el usuario cambia desde la UI
 * (carpeta de descargas, descargas simultáneas, etc.) se guardan en archivos JSON
 * bajo configPath y se leen/mezclan en los servicios que los usan (no aquí).
 *
 * @module config
 */

import path from 'path';
import { app } from 'electron';
import type { AppConfig } from './config.d';

const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'config');

const config: AppConfig = {
  network: {
    timeout: 30000,
    retryDelay: 1000,
    maxRetryDelay: 30000,
    connectionRetryDelay: 3000,
    maxConnectionRetryDelay: 60000,
    maxRetries: 3,
    connectTimeout: 10000,
    responseTimeout: 30000,
    idleTimeout: 60000,
    retryAfter429DefaultMs: 60000,
    retryAfter429MaxMs: 300000,
  },

  circuitBreaker: {
    enabled: true,
    download: {
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 60000,
      resetTimeout: 60000,
    },
    chunk: {
      failureThreshold: 10,
      successThreshold: 3,
      timeout: 30000,
      resetTimeout: 30000,
    },
    perHost: {
      enabled: true,
      failureThreshold: 10,
      timeout: 120000,
    },
  },

  downloads: {
    maxConcurrent: 3,
    queueOrdering: {
      agingEnabled: true,
      agingIntervalMs: 30 * 60 * 1000,
      maxAgingBonus: 2,
      lowPriorityAgingMultiplier: 1.5,
      sjfEnabled: true,
      sjfWeight: 0.7,
      sjfTolerancePercent: 10,
      sjfDefaultSizeBytes: 100 * 1024 * 1024,
      retryPenaltyEnabled: true,
      retryPenaltyPerRetry: 0.5,
      maxRetryPenalty: 1.5,
      retryPenaltyFreeRetries: 1,
    },
    maxConcurrentPerHost: 2,
    maxQueueBatchSize: 100,
    maxRetries: 3,
    maxFilesPerFolder: 1000,
    maxQueueSize: 1000,
    staleTimeout: 300000,
    progressUpdateInterval: 1000,
    progressBatchDelay: 100,
    progressBatchSizeThreshold: 1024 * 1024,
    queueProcessingTimeout: 10000,
    queueProcessDelay: 2000,
    lockTimeout: 5000,
    lockCheckInterval: 25,
    writeBufferSize: 1024 * 1024,
    minWriteBufferSize: 256 * 1024,
    maxWriteBufferSize: 16 * 1024 * 1024,
    adaptiveBufferSize: true,
    backpressureEventThreshold: 10,
    maxBackpressureDuration: 5000,
    bufferReductionFactor: 0.75,
    bufferIncreaseFactor: 1.25,
    // Buffer adaptativo según velocidad (conexiones lentas → 256 KB, rápidas → 2–4 MB)
    adaptiveWriteBuffer: {
      enabled: true,
      speedBands: [
        { maxSpeedBps: 512 * 1024, bufferSize: 256 * 1024 },
        { maxSpeedBps: 2 * 1024 * 1024, bufferSize: 512 * 1024 },
        { maxSpeedBps: 10 * 1024 * 1024, bufferSize: 1024 * 1024 },
        { maxSpeedBps: 50 * 1024 * 1024, bufferSize: 2 * 1024 * 1024 },
        { maxSpeedBps: Infinity, bufferSize: 4 * 1024 * 1024 },
      ],
    },
    chunked: {
      sizeThreshold: 50 * 1024 * 1024,
      maxChunks: 16,
      minChunks: 2,
      mediumRangeMaxBytes: 500 * 1024 * 1024,
      chunkSizeMediumTarget: 8 * 1024 * 1024,
      chunkCountMediumMin: 4,
      chunkCountMediumMax: 8,
      chunkSizeLargeBase: 32 * 1024 * 1024,
      chunkCountLargeMin: 8,
      chunkCountLargeMax: 16,
      chunkRanges: [
        { maxSize: 125 * 1024 * 1024, chunkSize: 12 * 1024 * 1024 },
        { maxSize: 250 * 1024 * 1024, chunkSize: 25 * 1024 * 1024 },
        { maxSize: 1024 * 1024 * 1024, chunkSize: 32 * 1024 * 1024 },
        { maxSize: 5 * 1024 * 1024 * 1024, chunkSize: 32 * 1024 * 1024 },
        { maxSize: Infinity, chunkSize: 64 * 1024 * 1024 },
      ],
      minChunkSize: 8 * 1024 * 1024,
      maxConcurrentChunks: 3,
      chunkRetries: 3,
      chunkOperationTimeoutMinutes: 5,
      checkRangeSupport: true,
      rangeSupportTimeout: 5000,
      chunkResponseTimeout: 60000,
      chunkIdleTimeout: 120000,
      forceSimpleDownload: false,
      chunkProgressInterval: 500,
      cleanupOnComplete: true,
      preserveOnPause: true,
      adaptiveConcurrency: false, // Ajuste dinámico de slots según throughput y errores
      adaptiveConcurrencyConfig: {
        evaluationIntervalMs: 15_000,
        cooldownMs: 30_000,
        windowSizeMs: 90_000,
        scaleUpErrorRateMax: 0.05,
        scaleDownErrorRateMin: 0.2,
        scaleUpMinThroughputBps: 256 * 1024,
        throughputDropThreshold: 0.4,
        scaleUpMinSamples: 2,
        scaleDownTransientRetryThreshold: 4,
      },
      // Sizing adaptativo de chunks según velocidad de red medida
      adaptiveChunkSizing: {
        enabled: true,
        minSamples: 2,
        minChunkSize: 4 * 1024 * 1024,
        maxChunkSize: 128 * 1024 * 1024,
        speedBands: [
          {
            maxSpeedBps: 512 * 1024,
            chunkSizeTarget: 4 * 1024 * 1024,
            label: 'muy lenta (<512 KB/s)',
          },
          {
            maxSpeedBps: 2 * 1024 * 1024,
            chunkSizeTarget: 8 * 1024 * 1024,
            label: 'lenta (512 KB–2 MB/s)',
          },
          {
            maxSpeedBps: 10 * 1024 * 1024,
            chunkSizeTarget: 16 * 1024 * 1024,
            label: 'media (2–10 MB/s)',
          },
          {
            maxSpeedBps: 50 * 1024 * 1024,
            chunkSizeTarget: 32 * 1024 * 1024,
            label: 'rápida (10–50 MB/s)',
          },
          {
            maxSpeedBps: Infinity,
            chunkSizeTarget: 64 * 1024 * 1024,
            label: 'muy rápida (>50 MB/s)',
          },
        ],
      },
      preallocateFile: true,
      dbBatchInterval: 2000,
      chunkWriteBufferSize: 1024 * 1024,
      mergeBufferSize: 16 * 1024 * 1024,
      mergeBatchSize: 8 * 1024 * 1024,
      mergeYieldInterval: 10,
      targetSpeedPerChunk: 5 * 1024 * 1024,
      backpressureThreshold: 5,
      useWorkerThread: true,
    },
  },

  ui: {
    progressThrottle: 200,
    searchDebounce: 300,
    /** Debounce de emitStateChanged para coalescer cambios rápidos (ms). */
    stateChangeDebounceMs: 50,
    /** Intervalo de batch de eventos de progreso hacia el renderer (ms). */
    progressBatchIntervalMs: 50,
  },

  rateLimiting: {
    search: {
      maxRequests: 10,
      windowMs: 1000,
      cleanupIntervalMs: 60000,
    },
    /** E1: límite explícito para get-download-state (evitar picos de CPU en main si el renderer pide estado muy a menudo). */
    getDownloadState: {
      maxRequests: 3,
      windowMs: 1000,
    },
    download: {
      // Alto límite para no rechazar colas masivas (p. ej. 1000 archivos) en ventana de 15s.
      maxRequests: 2500,
      windowMs: 15000,
      maxRequestsPerHost: 20,
      cleanupIntervalMs: 60000,
    },
  },

  database: {
    searchTimeoutMs: 10000,
    workerSearchTimeoutMs: 15000,
    maxSearchTermLength: 100,
    defaultChildrenLimit: 2000,
  },

  workers: {
    poolSize: 2, // Legacy — usado como fallback si maxWorkers no está definido
    // Parámetros del pool dinámico de workers
    minWorkers: 1,
    maxWorkers: 0, // 0 = auto (os.cpus().length - 1, clamped 2..4)
    taskTimeoutMs: 5 * 60 * 1000,
    idleTimeoutMs: 60 * 1000, // Destruir workers idle después de 60s
    healthCheckIntervalMs: 30 * 1000, // Verificar salud cada 30s
    healthCheckTimeoutMs: 5 * 1000, // Timeout de respuesta al PING
  },

  // Perfiles de retry adaptativo por tipo de error (timeout, connection_reset, etc.).
  // Cada clave sobreescribe el perfil por defecto en DownloadValidator.
  // Tipos: timeout, connection_reset, connection_refused, dns, network_change,
  //        server_overload, pipe_broken, unknown
  retryProfiles: {
    timeout: { baseDelayMs: 5_000, maxDelayMs: 20_000, growthFactor: 1.5 },
    connection_reset: { baseDelayMs: 10_000, maxDelayMs: 60_000 },
    network_change: { baseDelayMs: 3_000, maxDelayMs: 15_000, growthFactor: 1.5 },
  },

  bufferPool: {
    /** Tamaño de cada buffer en el pool (bytes). Debe coincidir con mergeBufferSize. */
    bufferSize: 16 * 1024 * 1024,
    /** Máximo de buffers retenidos en el pool (main process). */
    maxPooled: 4,
    /** Máximo de buffers retenidos en el pool del worker thread. */
    workerMaxPooled: 2,
    /** Pre-alocar buffers al crear el pool. */
    preAllocate: false,
  },

  timing: {
    stateCheckInterval: 500,
    processQueueInitialDelay: 100,
    processQueueBackupDelay: 200,
    stateChangeTimeout: 30000,
    lockAcquisitionTimeout: 5000,
    maxProgressBatchSize: 50,
    retryBaseDelay: 1000,
    retryMaxDelay: 30000,
  },

  paths: {
    userDataPath,
    configPath,
    dbPath: app.isPackaged
      ? path.join(process.resourcesPath, 'myrient_data.db')
      : path.join(process.cwd(), 'resources', 'myrient_data.db'),
    compressed7zPath: app.isPackaged
      ? path.join(process.resourcesPath, 'myrient_data.7z')
      : path.join(process.cwd(), 'resources', 'myrient_data.7z'),
    lolromDbPath: app.isPackaged
      ? path.join(process.resourcesPath, 'lolrom_data.db')
      : path.join(process.cwd(), 'resources', 'lolrom_data.db'),
    lolromCompressed7zPath: app.isPackaged
      ? path.join(process.resourcesPath, 'lolrom_data.7z')
      : path.join(process.cwd(), 'resources', 'lolrom_data.7z'),
    queueDbPath: path.join(configPath, 'downloads.db'),
  },

  security: {
    allowedHosts: Object.freeze(['myrient.erista.me', 'lolroms.com']),
  },

  files: {
    maxFileSize: 50 * 1024 * 1024 * 1024,
    sizeMarginBytes: 10240,
  },

  window: {
    defaultWidth: 1200,
    defaultHeight: 800,
    /** Mínimo para soporte CRT y ventanas muy pequeñas (320×240) */
    minWidth: 320,
    minHeight: 240,
    useContentSize: true,
  },
};

export default config;
