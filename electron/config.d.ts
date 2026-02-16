/**
 * Tipos para la configuración centralizada del proceso main.
 *
 * La implementación concreta y valores por defecto están en config.ts.
 * Algunas claves se dejan como Record<string, unknown> para flexibilidad;
 * los valores reales están documentados en config.ts (network, downloads.chunked, etc.).
 */
export interface AppConfig {
  /** Timeouts, reintentos y límites de conexión HTTP. */
  network: Record<string, number>;
  /** Umbrales y tiempos del circuit breaker (descarga, chunks, por host). */
  circuitBreaker: Record<string, unknown>;
  /** Cola, chunks, buffers, reintentos y parámetros del motor de descargas. */
  downloads: Record<string, unknown>;
  /** Throttle de progreso en UI, debounce de búsqueda. */
  ui: Record<string, number>;
  /** Límites de tasa para búsqueda y para añadir descargas vía IPC. */
  rateLimiting: Record<string, unknown>;
  /** Timeouts y límites para consultas a la DB de catálogo (worker y main). */
  database?: {
    maxSearchTermLength?: number;
    searchTimeoutMs?: number;
    workerSearchTimeoutMs?: number;
    defaultChildrenLimit?: number;
    [key: string]: unknown;
  };
  /** Tamaño del pool de workers y timeout de tareas. */
  workers: Record<string, number>;
  /** Perfiles de retry adaptativo por tipo de error. */
  retryProfiles?: Record<
    string,
    {
      baseDelayMs?: number;
      maxDelayMs?: number;
      growthFactor?: number;
      jitterFactor?: number;
    }
  >;
  /** Configuración del pool de buffers reutilizables. */
  bufferPool?: {
    bufferSize?: number;
    maxPooled?: number;
    workerMaxPooled?: number;
    preAllocate?: boolean;
  };
  /** Intervalos del scheduler, timeouts de estado y reintentos. */
  timing: Record<string, number>;
  /** Rutas absolutas: userData, config, DB catálogo, DB cola, 7z. */
  paths: {
    userDataPath: string;
    configPath: string;
    dbPath: string;
    compressed7zPath: string;
    lolromDbPath: string;
    lolromCompressed7zPath: string;
    queueDbPath: string;
  };
  /** Hosts permitidos para descargas (CSP y validación). */
  security: {
    allowedHosts: readonly string[];
  };
  /** Límite de tamaño de archivo y margen para validaciones. */
  files: {
    maxFileSize: number;
    sizeMarginBytes: number;
  };
  /** Dimensiones por defecto y mínimas de la ventana principal. */
  window: Record<string, number | boolean>;
}
