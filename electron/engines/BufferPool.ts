/**
 * Pool de buffers reutilizables para reducir allocations y presión en GC.
 *
 * Gestiona un conjunto de buffers pre-alocados de tamaño fijo. Los consumidores
 * solicitan un buffer con `acquire()` y lo devuelven con `release()`.
 * Si el pool está vacío, se aloca un nuevo buffer. Si al devolver el pool está lleno,
 * el buffer se descarta (GC lo recogerá). Esto garantiza un uso de memoria acotado
 * sin bloquear operaciones si se excede el límite temporal.
 *
 * Uso típico:
 * ```ts
 * const pool = new BufferPool(16 * 1024 * 1024, { maxPooled: 4 });
 * const buf = pool.acquire();
 * try {
 *   // ... usar buf ...
 * } finally {
 *   pool.release(buf);
 * }
 * ```
 *
 * Thread-safety: cada worker thread debe tener su propia instancia (Node.js single-threaded
 * dentro de cada thread). No compartir instancias entre threads.
 *
 * @module BufferPool
 */

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface BufferPoolOptions {
  /** Cantidad máxima de buffers mantenidos en el pool (default: 4). */
  maxPooled?: number;
  /** Si true, llena el pool al construir (default: false). */
  preAllocate?: boolean;
  /** Nombre para logging/diagnóstico (default: 'BufferPool'). */
  name?: string;
}

export interface BufferPoolStats {
  /** Nombre del pool. */
  name: string;
  /** Tamaño de cada buffer en bytes. */
  bufferSize: number;
  /** Buffers actualmente disponibles en el pool. */
  availableCount: number;
  /** Máximo de buffers que el pool retiene. */
  maxPooled: number;
  /** Total de buffers alocados desde la creación del pool. */
  totalAllocations: number;
  /** Total de veces que se reutilizó un buffer del pool (evitó allocation). */
  totalReuses: number;
  /** Total de buffers descartados al devolver (pool lleno). */
  totalDiscarded: number;
  /** Total de veces que acquire() alocó un buffer nuevo (pool vacío). */
  totalMisses: number;
  /** Memoria actualmente retenida en el pool (bytes). */
  pooledBytes: number;
  /** Hit rate: porcentaje de acquire() servidos desde el pool. */
  hitRate: number;
}

// ---------------------------------------------------------------------------
// Clase principal
// ---------------------------------------------------------------------------

export class BufferPool {
  private readonly _bufferSize: number;
  private readonly _maxPooled: number;
  private readonly _name: string;
  private readonly _pool: Buffer[] = [];

  // Contadores de métricas
  private _totalAllocations = 0;
  private _totalReuses = 0;
  private _totalDiscarded = 0;
  private _totalMisses = 0;

  /**
   * @param bufferSize — Tamaño fijo de cada buffer en bytes.
   * @param options — Opciones de configuración del pool.
   */
  constructor(bufferSize: number, options?: BufferPoolOptions) {
    if (bufferSize <= 0) throw new RangeError('bufferSize debe ser > 0');
    this._bufferSize = bufferSize;
    this._maxPooled = Math.max(1, options?.maxPooled ?? 4);
    this._name = options?.name ?? 'BufferPool';

    if (options?.preAllocate) {
      for (let i = 0; i < this._maxPooled; i++) {
        this._pool.push(Buffer.allocUnsafe(this._bufferSize));
        this._totalAllocations++;
      }
    }
  }

  /** Tamaño de cada buffer gestionado por el pool. */
  get bufferSize(): number {
    return this._bufferSize;
  }

  /** Cantidad de buffers actualmente disponibles en el pool. */
  get availableCount(): number {
    return this._pool.length;
  }

  /**
   * Obtiene un buffer del pool. Si no hay buffers disponibles, aloca uno nuevo.
   *
   * El buffer retornado tiene exactamente `bufferSize` bytes. Su contenido no está
   * inicializado (equivalente a `Buffer.allocUnsafe`).
   *
   * **Importante:** Cada buffer adquirido DEBE ser devuelto con `release()` cuando
   * ya no se use, idealmente en un bloque `finally`.
   */
  acquire(): Buffer {
    const recycled = this._pool.pop();
    if (recycled) {
      this._totalReuses++;
      return recycled;
    }
    // Pool vacío: alocar nuevo
    this._totalAllocations++;
    this._totalMisses++;
    return Buffer.allocUnsafe(this._bufferSize);
  }

  /**
   * Obtiene un buffer del pool con un tamaño efectivo ≤ bufferSize.
   * Siempre retorna un buffer de tamaño `bufferSize` internamente, pero el caller
   * puede usar solo los primeros `requestedSize` bytes.
   *
   * Si `requestedSize > bufferSize`, retorna un buffer nuevo del tamaño solicitado
   * (no pooleable — será recogido por GC al no caber en el pool).
   */
  acquireFor(requestedSize: number): Buffer {
    if (requestedSize <= this._bufferSize) {
      return this.acquire();
    }
    // Tamaño mayor al del pool: alocar ad-hoc (no entra en el pool)
    this._totalAllocations++;
    this._totalMisses++;
    return Buffer.allocUnsafe(requestedSize);
  }

  /**
   * Devuelve un buffer al pool. Si el pool está lleno, el buffer se descarta
   * silenciosamente (será recogido por el GC).
   *
   * Solo acepta buffers con exactamente `bufferSize` bytes. Buffers de otro tamaño
   * se ignoran (no se pueden reciclar en este pool).
   */
  release(buffer: Buffer): void {
    // Solo aceptar buffers del tamaño correcto
    if (buffer.length !== this._bufferSize) {
      this._totalDiscarded++;
      return;
    }
    if (this._pool.length < this._maxPooled) {
      this._pool.push(buffer);
    } else {
      this._totalDiscarded++;
    }
  }

  /**
   * Libera todos los buffers del pool, permitiendo que el GC los recoja.
   * Útil al cerrar la aplicación o resetear el motor.
   */
  drain(): void {
    this._pool.length = 0;
  }

  /**
   * Devuelve estadísticas del pool para diagnóstico y logging.
   */
  getStats(): BufferPoolStats {
    const totalAcquires = this._totalReuses + this._totalMisses;
    return {
      name: this._name,
      bufferSize: this._bufferSize,
      availableCount: this._pool.length,
      maxPooled: this._maxPooled,
      totalAllocations: this._totalAllocations,
      totalReuses: this._totalReuses,
      totalDiscarded: this._totalDiscarded,
      totalMisses: this._totalMisses,
      pooledBytes: this._pool.length * this._bufferSize,
      hitRate: totalAcquires > 0 ? this._totalReuses / totalAcquires : 0,
    };
  }

  /**
   * Resetea los contadores de métricas (no afecta los buffers en el pool).
   */
  resetStats(): void {
    this._totalAllocations = 0;
    this._totalReuses = 0;
    this._totalDiscarded = 0;
    this._totalMisses = 0;
  }
}
