/**
 * Almacén de estado de la cola de descargas (SQLite WAL, archivo *-state.db).
 *
 * Tablas: downloads (estado, progreso, rutas), chunks (por descarga fragmentada),
 * attempts (reintentos), history (eventos). Un trigger actualiza state_version en
 * cada cambio de estado para que el frontend pueda pedir solo snapshots nuevos.
 * Incluye recuperación de descargas interrumpidas (starting/downloading/merging/verifying → queued)
 * al inicializar y batch de actualizaciones de progreso para no saturar la DB.
 *
 * @module StateStore
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import config from '../config';
import { logger } from '../utils';
import { DownloadState, ChunkState } from './types';
import { canTransition as stateMachineCanTransition } from './DownloadStateMachine';

const log = logger.child('StateStore');

/** Hooks opcionales por transición: side-effects al cambiar de estado (onExit/onEnter). */
export interface TransitionHooks {
  onExit?: (_id: number, _fromState: string, _toState: string) => void;
  onEnter?: (_id: number, _toState: string, _fromState: string) => void;
}

// Re-exportar para que los imports desde './StateStore' sigan funcionando
export { DownloadState, ChunkState };

const CREATE_SCHEMA_SQL = `
-- Tabla principal de descargas
CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT,
    save_path TEXT,
    download_path TEXT,
    preserve_structure INTEGER DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'queued',
    state_version INTEGER NOT NULL DEFAULT 1,
    progress REAL DEFAULT 0,
    downloaded_bytes INTEGER DEFAULT 0,
    total_bytes INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 1,
    force_overwrite INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    last_error TEXT,
    expected_hash TEXT,
    actual_hash TEXT,
    hash_verified INTEGER DEFAULT 0,
    size_verified INTEGER DEFAULT 0,
    queue_position INTEGER,
    CHECK(state IN ('queued', 'starting', 'downloading', 'paused', 'merging', 'verifying', 'completed', 'failed', 'cancelled'))
);
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    download_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    start_byte INTEGER NOT NULL,
    end_byte INTEGER NOT NULL,
    downloaded_bytes INTEGER DEFAULT 0,
    state TEXT DEFAULT 'pending',
    temp_file TEXT,
    hash TEXT,
    hash_verified INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE,
    UNIQUE(download_id, chunk_index),
    CHECK(state IN ('pending', 'downloading', 'completed', 'failed', 'paused'))
);
CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    download_id INTEGER NOT NULL,
    chunk_id INTEGER,
    attempt_number INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    error TEXT,
    error_code TEXT,
    bytes_transferred INTEGER DEFAULT 0,
    duration_ms INTEGER,
    speed_bytes_per_sec REAL,
    FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE,
    FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    download_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    event_data TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS state_version (
    version INTEGER PRIMARY KEY DEFAULT 1
);
INSERT OR IGNORE INTO state_version (version) VALUES (1);
CREATE INDEX IF NOT EXISTS idx_downloads_state ON downloads(state);
CREATE INDEX IF NOT EXISTS idx_downloads_state_version ON downloads(state_version);
CREATE INDEX IF NOT EXISTS idx_downloads_queue ON downloads(state, priority DESC, queue_position ASC) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS idx_chunks_download ON chunks(download_id);
CREATE INDEX IF NOT EXISTS idx_chunks_state ON chunks(download_id, state);
CREATE INDEX IF NOT EXISTS idx_attempts_download ON attempts(download_id);
CREATE INDEX IF NOT EXISTS idx_history_download ON history(download_id);
DROP TRIGGER IF EXISTS update_state_version;
CREATE TRIGGER update_state_version
AFTER UPDATE OF state ON downloads
BEGIN
    UPDATE state_version SET version = -(version + 1);
    UPDATE state_version SET version = -version;
END;
DROP TRIGGER IF EXISTS update_state_version_on_insert;
CREATE TRIGGER update_state_version_on_insert
AFTER INSERT ON downloads
BEGIN
    UPDATE state_version SET version = -(version + 1);
    UPDATE state_version SET version = -version;
END;
`;

export interface Download {
  id: number;
  title: string;
  url: string | null;
  savePath: string | null;
  downloadPath: string | null;
  preserveStructure: boolean;
  state: string;
  stateVersion: number;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  priority: number;
  forceOverwrite: boolean;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  expectedHash: string | null;
  actualHash: string | null;
  hashVerified: boolean;
  sizeVerified: boolean;
  queuePosition: number | null;
  /** Hash de los últimos N bytes del .part al pausar (verificación al reanudar). */
  partialTailHash: string | null;
  /** Tamaño del archivo cuando se guardó el checkpoint. */
  partialTailSize: number | null;
}

export interface Chunk {
  id: number;
  downloadId: number;
  chunkIndex: number;
  startByte: number;
  endByte: number;
  downloadedBytes: number;
  state: string;
  tempFile: string | null;
  hash: string | null;
  hashVerified: boolean;
  createdAt: number;
  updatedAt: number;
  /** Hash de los últimos N bytes del chunk al pausar. */
  tailCheckpointHash: string | null;
  /** Tamaño del chunk cuando se guardó el checkpoint. */
  tailCheckpointSize: number | null;
}

export interface SnapshotSummary {
  queued: number;
  downloading: number;
  paused: number;
  completed: number;
  failed: number;
  total: number;
}

export interface Snapshot {
  stateVersion: number;
  downloads: Download[];
  hasChanges: boolean;
  summary: SnapshotSummary;
  /** Presente solo en snapshots incrementales: lista completa de IDs actuales. */
  allIds?: number[];
  /** true si el snapshot es incremental (downloads contiene solo los cambios). */
  isIncremental?: boolean;
}

export interface AddDownloadInput {
  id: number;
  title: string;
  url?: string | null;
  savePath?: string | null;
  downloadPath?: string | null;
  preserveStructure?: boolean;
  totalBytes?: number;
  priority?: number;
  forceOverwrite?: boolean;
  skipQueueLimit?: boolean;
  startPaused?: boolean;
}

export interface UpdateDownloadUpdates {
  state?: string | null;
  progress?: number | null;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  savePath?: string | null;
  url?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  retryCount?: number | null;
  lastError?: string | null;
  actualHash?: string | null;
  hashVerified?: boolean;
  sizeVerified?: boolean;
  forceOverwrite?: boolean;
  /** Checkpoint de integridad parcial (para reanudar). */
  partialTailHash?: string | null;
  partialTailSize?: number | null;
}

interface ProgressBatchEntry {
  progress?: number | null;
  downloadedBytes?: number | null;
  lastUpdate: number;
}

type RunResult = { changes: number };
type PluckStatement = { get: () => number };
type Row = Record<string, unknown>;

/** Tipo interno para statements preparados (better-sqlite3 no siempre expone tipos). */
interface StateStoreStatements {
  insertDownload: { run: (_p: Record<string, unknown>) => RunResult };
  updateDownload: { run: (_p: Record<string, unknown>) => RunResult };
  transitionState: { run: (_p: Record<string, unknown>) => RunResult };
  updateStateOnly: { run: (_p: Record<string, unknown>) => RunResult };
  getById: { get: (_id: number) => Row | undefined };
  getAll: { all: () => Row[] };
  getByState: { all: (_state: string) => Row[] };
  clearLastError: { run: (_p: Record<string, unknown>) => RunResult };
  getQueued: { all: () => Row[] };
  insertChunk: { run: (_p: Record<string, unknown>) => RunResult };
  updateChunk: { run: (_p: Record<string, unknown>) => RunResult };
  getChunks: { all: (_downloadId: number) => Row[] };
  deleteChunks: { run: (_downloadId: number) => RunResult };
  getStateVersion: PluckStatement;
  insertAttempt: { run: (_p: Record<string, unknown>) => RunResult };
  getAttempts: { all: (_downloadId: number) => Row[] };
  insertHistory: { run: (_p: Record<string, unknown>) => RunResult };
  getHistory: { all: (_downloadId: number) => Row[] };
  /** IDs de todas las descargas (para snapshots incrementales). */
  getAllIds: { all: () => { id: number }[] };
  /** Descargas actualizadas después de un timestamp (para snapshots incrementales). */
  getUpdatedSince: { all: (_ts: number) => Row[] };
}

/**
 * Fuente de verdad del estado de la cola: persistencia transaccional y API para
 * addDownload, updateDownload, transitionState, getSnapshot, chunks y attempts.
 */
export class StateStore {
  private _db: Database.Database | null = null;
  private statements: StateStoreStatements | null = null;
  private _initialized = false;
  private _transitionHooks: TransitionHooks = {};

  /** Acceso a la BD e estado de inicialización (tests / uso interno). */
  get db(): Database.Database | null {
    return this._db;
  }
  get isInitialized(): boolean {
    return this._initialized;
  }
  private progressBatch = new Map<number, ProgressBatchEntry>();
  private progressBatchInterval: ReturnType<typeof setInterval> | null = null;
  private _retryFlushScheduled = false;
  private readonly progressBatchDelay: number;

  constructor() {
    const downloadsConfig = config.downloads as
      | { progressBatchDelay?: number; progressBatchSizeThreshold?: number }
      | undefined;
    this.progressBatchDelay = downloadsConfig?.progressBatchDelay ?? 100;
  }

  /**
   * Crea el directorio de la DB si no existe, abre *-state.db con WAL, ejecuta el schema,
   * prepara statements y recupera descargas interrumpidas.
   *
   * @returns true si la inicialización fue correcta.
   */
  initialize(): boolean {
    if (this._initialized) {
      log.warn('StateStore ya está inicializado');
      return true;
    }

    try {
      const baseDbPath = config.paths.queueDbPath;
      const dbDir = path.dirname(baseDbPath);
      const dbPath = baseDbPath.replace(/\.db$/, '-state.db');

      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      this._db = new Database(dbPath);
      this._db.pragma('journal_mode = WAL');
      this._db.pragma('synchronous = NORMAL');
      this._db.pragma('cache_size = -64000');
      this._db.pragma('temp_store = MEMORY');
      this._db.pragma('foreign_keys = ON');
      this._db.pragma('wal_autocheckpoint = 1000');
      this._db.exec(CREATE_SCHEMA_SQL);
      this._migrateO15PartialCheckpoint();
      this._prepareStatements();
      this._recoverInterruptedDownloads();
      this._initialized = true;
      log.info('StateStore inicializado correctamente');
      return true;
    } catch (error) {
      log.error('Error inicializando StateStore:', error);
      return false;
    }
  }

  /** Añade columnas para checkpoint de integridad parcial (descargas y chunks). */
  private _migrateO15PartialCheckpoint(): void {
    if (!this._db) return;
    const run = (sql: string) => {
      try {
        this._db!.exec(sql);
      } catch (e) {
        const msg = (e as Error).message;
        if (!/duplicate column name/i.test(msg)) throw e;
      }
    };
    run('ALTER TABLE downloads ADD COLUMN partial_tail_hash TEXT');
    run('ALTER TABLE downloads ADD COLUMN partial_tail_size INTEGER');
    run('ALTER TABLE chunks ADD COLUMN tail_checkpoint_hash TEXT');
    run('ALTER TABLE chunks ADD COLUMN tail_checkpoint_size INTEGER');
  }

  private _prepareStatements(): void {
    if (!this._db) return;
    const db = this._db;
    this.statements = {
      insertDownload: db.prepare(`
        INSERT INTO downloads (
            id, title, url, save_path, download_path, preserve_structure,
            state, state_version, progress, downloaded_bytes, total_bytes,
            priority, force_overwrite, created_at, updated_at, queue_position
        ) VALUES (
            @id, @title, @url, @savePath, @downloadPath, @preserveStructure,
            @state, 1, @progress, @downloadedBytes, @totalBytes,
            @priority, @forceOverwrite, @createdAt, @updatedAt, @queuePosition
        )
      `) as StateStoreStatements['insertDownload'],
      updateDownload: db.prepare(`
        UPDATE downloads SET
            state = COALESCE(@state, state),
            state_version = state_version + CASE WHEN @state IS NOT NULL AND @state != state THEN 1 ELSE 0 END,
            progress = COALESCE(@progress, progress),
            downloaded_bytes = COALESCE(@downloadedBytes, downloaded_bytes),
            total_bytes = COALESCE(@totalBytes, total_bytes),
            save_path = COALESCE(@savePath, save_path),
            url = COALESCE(@url, url),
            started_at = COALESCE(@startedAt, started_at),
            completed_at = COALESCE(@completedAt, completed_at),
            retry_count = COALESCE(@retryCount, retry_count),
            last_error = COALESCE(@lastError, last_error),
            actual_hash = COALESCE(@actualHash, actual_hash),
            hash_verified = COALESCE(@hashVerified, hash_verified),
            size_verified = COALESCE(@sizeVerified, size_verified),
            force_overwrite = COALESCE(@forceOverwrite, force_overwrite),
            partial_tail_hash = COALESCE(@partialTailHash, partial_tail_hash),
            partial_tail_size = COALESCE(@partialTailSize, partial_tail_size),
            updated_at = @updatedAt
        WHERE id = @id
      `) as StateStoreStatements['updateDownload'],
      transitionState: db.prepare(`
        UPDATE downloads SET state = @newState, state_version = state_version + 1, updated_at = @updatedAt
        WHERE id = @id AND state = @oldState
      `) as StateStoreStatements['transitionState'],
      updateStateOnly: db.prepare(`
        UPDATE downloads SET state = @newState, state_version = state_version + 1, updated_at = @updatedAt
        WHERE id = @id
      `) as StateStoreStatements['updateStateOnly'],
      getById: db.prepare(
        'SELECT * FROM downloads WHERE id = ?'
      ) as StateStoreStatements['getById'],
      getAll: db.prepare(`
        SELECT * FROM downloads
        ORDER BY CASE state WHEN 'downloading' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
            priority DESC, queue_position ASC, updated_at DESC
      `) as StateStoreStatements['getAll'],
      getByState: db.prepare(
        'SELECT * FROM downloads WHERE state = ?'
      ) as StateStoreStatements['getByState'],
      clearLastError: db.prepare(
        'UPDATE downloads SET last_error = NULL, updated_at = @updatedAt WHERE id = @id'
      ) as StateStoreStatements['clearLastError'],
      getQueued: db.prepare(`
        SELECT * FROM downloads WHERE state = 'queued'
        ORDER BY priority DESC, queue_position ASC, created_at ASC
      `) as StateStoreStatements['getQueued'],
      insertChunk: db.prepare(`
        INSERT OR IGNORE INTO chunks (download_id, chunk_index, start_byte, end_byte, downloaded_bytes, state, temp_file, hash, hash_verified, created_at, updated_at)
        VALUES (@downloadId, @chunkIndex, @startByte, @endByte, @downloadedBytes, @state, @tempFile, @hash, @hashVerified, @createdAt, @updatedAt)
      `) as StateStoreStatements['insertChunk'],
      updateChunk: db.prepare(`
        UPDATE chunks SET downloaded_bytes = COALESCE(@downloadedBytes, downloaded_bytes), state = COALESCE(@state, state),
            temp_file = COALESCE(@tempFile, temp_file), hash = COALESCE(@hash, hash), hash_verified = COALESCE(@hashVerified, hash_verified),
            tail_checkpoint_hash = COALESCE(@tailCheckpointHash, tail_checkpoint_hash),
            tail_checkpoint_size = COALESCE(@tailCheckpointSize, tail_checkpoint_size),
            updated_at = @updatedAt
        WHERE download_id = @downloadId AND chunk_index = @chunkIndex
      `) as StateStoreStatements['updateChunk'],
      getChunks: db.prepare(
        'SELECT * FROM chunks WHERE download_id = ? ORDER BY chunk_index ASC'
      ) as StateStoreStatements['getChunks'],
      deleteChunks: db.prepare(
        'DELETE FROM chunks WHERE download_id = ?'
      ) as StateStoreStatements['deleteChunks'],
      getStateVersion: db
        .prepare('SELECT ABS(version) FROM state_version LIMIT 1')
        .pluck(true) as unknown as PluckStatement,
      insertAttempt: db.prepare(`
        INSERT INTO attempts (download_id, chunk_id, attempt_number, timestamp, error, error_code, bytes_transferred, duration_ms, speed_bytes_per_sec)
        VALUES (@downloadId, @chunkId, @attemptNumber, @timestamp, @error, @errorCode, @bytesTransferred, @durationMs, @speedBytesPerSec)
      `) as StateStoreStatements['insertAttempt'],
      getAttempts: db.prepare(
        'SELECT * FROM attempts WHERE download_id = ? ORDER BY timestamp DESC'
      ) as StateStoreStatements['getAttempts'],
      insertHistory: db.prepare(
        'INSERT INTO history (download_id, event_type, event_data, created_at) VALUES (@downloadId, @eventType, @eventData, @createdAt)'
      ) as StateStoreStatements['insertHistory'],
      getHistory: db.prepare(
        'SELECT * FROM history WHERE download_id = ? ORDER BY created_at DESC'
      ) as StateStoreStatements['getHistory'],
      getAllIds: db.prepare(
        'SELECT id FROM downloads'
      ) as unknown as StateStoreStatements['getAllIds'],
      getUpdatedSince: db.prepare(
        `SELECT * FROM downloads WHERE updated_at > ?
         ORDER BY CASE state WHEN 'downloading' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
             priority DESC, queue_position ASC, updated_at DESC`
      ) as StateStoreStatements['getUpdatedSince'],
    };
  }

  /** Al abrir la DB, pasa a queued las descargas que quedaron en starting/downloading/merging/verifying. */
  private _recoverInterruptedDownloads(): void {
    if (!this._db) return;
    const now = Date.now();
    const result = this._db
      .prepare(
        `
      UPDATE downloads SET state = 'queued', updated_at = ?
      WHERE state IN ('starting', 'downloading', 'merging', 'verifying')
    `
      )
      .run(now);
    if (result.changes > 0) log.info(`Recuperadas ${result.changes} descargas interrumpidas`);
  }

  getStateVersion(): number {
    if (!this.statements) return 1;
    return (this.statements.getStateVersion.get() as number) || 1;
  }

  getSnapshot(minVersion: number | null = null): Snapshot {
    if (!this.statements) {
      return {
        stateVersion: 1,
        downloads: [],
        hasChanges: false,
        summary: { queued: 0, downloading: 0, paused: 0, completed: 0, failed: 0, total: 0 },
      };
    }
    const stateVersion = this.getStateVersion();
    const downloads = this.statements.getAll.all().map((row: Row) => this._rowToDownload(row));
    const hasActiveDownloads = downloads.some(
      d =>
        d.state === DownloadState.DOWNLOADING ||
        d.state === DownloadState.STARTING ||
        d.state === DownloadState.MERGING ||
        d.state === DownloadState.VERIFYING
    );
    const summary = this._calculateSummary(downloads);

    if (minVersion !== null && stateVersion <= minVersion) {
      return {
        stateVersion,
        downloads,
        hasChanges: hasActiveDownloads,
        summary,
      };
    }
    return { stateVersion, downloads, hasChanges: true, summary };
  }

  /** IDs de todas las descargas actuales (lightweight, para que el frontend detecte eliminaciones). */
  getAllDownloadIds(): number[] {
    if (!this.statements) return [];
    return this.statements.getAllIds.all().map(row => row.id);
  }

  /**
   * Snapshot incremental: devuelve solo las descargas actualizadas desde `sinceTimestamp`
   * junto con la lista completa de IDs para que el frontend detecte eliminaciones.
   * Si no hay cambios respecto a `minVersion`, devuelve hasChanges: false.
   */
  getIncrementalSnapshot(sinceTimestamp: number, minVersion: number | null = null): Snapshot {
    if (!this.statements) {
      return {
        stateVersion: 1,
        downloads: [],
        hasChanges: false,
        summary: { queued: 0, downloading: 0, paused: 0, completed: 0, failed: 0, total: 0 },
      };
    }
    const stateVersion = this.getStateVersion();

    // Si no hay cambios desde la versión conocida por el frontend, retorno vacío
    if (minVersion !== null && stateVersion <= minVersion) {
      const allIds = this.getAllDownloadIds();
      return {
        stateVersion,
        downloads: [],
        hasChanges: false,
        summary: this._calculateSummaryFromDb(),
        allIds,
        isIncremental: true,
      };
    }

    // Obtener solo descargas modificadas desde el timestamp
    const changedRows = this.statements.getUpdatedSince.all(sinceTimestamp);
    const changedDownloads = changedRows.map((row: Row) => this._rowToDownload(row));
    const allIds = this.getAllDownloadIds();

    return {
      stateVersion,
      downloads: changedDownloads,
      hasChanges: true,
      summary: this._calculateSummaryFromDb(),
      allIds,
      isIncremental: true,
    };
  }

  /** Calcula el summary directamente con COUNT agrupado (evita cargar todas las descargas). */
  private _calculateSummaryFromDb(): SnapshotSummary {
    if (!this._db) {
      return { queued: 0, downloading: 0, paused: 0, completed: 0, failed: 0, total: 0 };
    }
    try {
      const rows = this._db
        .prepare('SELECT state, COUNT(*) as cnt FROM downloads GROUP BY state')
        .all() as Array<{ state: string; cnt: number }>;
      const summary: SnapshotSummary = {
        queued: 0,
        downloading: 0,
        paused: 0,
        completed: 0,
        failed: 0,
        total: 0,
      };
      for (const row of rows) {
        const count = row.cnt;
        summary.total += count;
        switch (row.state) {
          case DownloadState.QUEUED:
            summary.queued += count;
            break;
          case DownloadState.DOWNLOADING:
          case DownloadState.STARTING:
          case DownloadState.MERGING:
          case DownloadState.VERIFYING:
            summary.downloading += count;
            break;
          case DownloadState.PAUSED:
            summary.paused += count;
            break;
          case DownloadState.COMPLETED:
            summary.completed += count;
            break;
          case DownloadState.FAILED:
            summary.failed += count;
            break;
        }
      }
      return summary;
    } catch (dbErr) {
      log.debug?.(
        'Error calculando resumen desde DB, retornando valores vacíos:',
        (dbErr as Error)?.message
      );
      return { queued: 0, downloading: 0, paused: 0, completed: 0, failed: 0, total: 0 };
    }
  }

  private _calculateSummary(downloads: Download[]): SnapshotSummary {
    return {
      queued: downloads.filter(d => d.state === DownloadState.QUEUED).length,
      downloading: downloads.filter(d => d.state === DownloadState.DOWNLOADING).length,
      paused: downloads.filter(d => d.state === DownloadState.PAUSED).length,
      completed: downloads.filter(d => d.state === DownloadState.COMPLETED).length,
      failed: downloads.filter(d => d.state === DownloadState.FAILED).length,
      total: downloads.length,
    };
  }

  addDownload(download: AddDownloadInput): Snapshot {
    if (!this._db || !this.statements) return this.getSnapshot(null);
    const now = Date.now();
    const existing = this.statements.getById.get(download.id) as Row | undefined;

    if (existing) {
      const existingState = (existing.state as string) || 'unknown';
      log.info(`Descarga ${download.id} ya existe (estado: ${existingState})`);
      return this.getSnapshot(null);
    }

    const downloadsConfig = config.downloads as { maxQueueSize?: number } | undefined;
    const skipQueueLimit = download.skipQueueLimit === true;
    if (!skipQueueLimit) {
      const maxQueueSize = downloadsConfig?.maxQueueSize ?? 1000;
      const currentQueueSize = this.statements.getByState.all(DownloadState.QUEUED).length;
      if (currentQueueSize >= maxQueueSize) {
        log.warn(
          `Límite de cola alcanzado: ${currentQueueSize}/${maxQueueSize}. Rechazando nueva descarga ${download.id}`
        );
        throw new Error(
          `La cola de descargas está llena (${currentQueueSize}/${maxQueueSize}). Por favor espera a que se completen algunas descargas.`
        );
      }
    }

    const startPaused = download.startPaused === true;
    const nextPosition = (
      this._db
        .prepare(
          startPaused
            ? 'SELECT COALESCE(MAX(queue_position), 0) + 1 as next FROM downloads'
            : "SELECT COALESCE(MAX(queue_position), 0) + 1 as next FROM downloads WHERE state = 'queued'"
        )
        .get() as { next: number }
    ).next;

    const initialState = startPaused ? DownloadState.PAUSED : DownloadState.QUEUED;
    this.statements.insertDownload.run({
      id: download.id,
      title: download.title,
      url: download.url ?? null,
      savePath: download.savePath ?? null,
      downloadPath: download.downloadPath ?? null,
      preserveStructure: download.preserveStructure ? 1 : 0,
      state: initialState,
      progress: 0,
      downloadedBytes: 0,
      totalBytes: download.totalBytes ?? 0,
      priority: download.priority ?? 1,
      forceOverwrite: download.forceOverwrite ? 1 : 0,
      createdAt: now,
      updatedAt: now,
      queuePosition: nextPosition,
    });
    log.info(`Descarga agregada: ${download.id}`);
    return this.getSnapshot();
  }

  /** Registra hooks que se ejecutan al transicionar (onExit desde estado anterior, onEnter al nuevo). */
  setTransitionHooks(hooks: TransitionHooks): void {
    this._transitionHooks = hooks;
  }

  transitionState(id: number, newState: string, oldState: string | null = null): boolean {
    if (!this.statements) return false;
    const download = this.getDownload(id);
    if (!download) {
      log.warn(`No se puede transicionar descarga ${id}: no existe`);
      return false;
    }
    const currentState = oldState ?? download.state;
    if (!this.canTransition(currentState, newState)) {
      log.warn(`Transición inválida para descarga ${id}: ${currentState} → ${newState}`);
      return false;
    }
    const now = Date.now();
    let result: RunResult;
    if (oldState != null) {
      result = this.statements.transitionState.run({
        id,
        oldState: currentState,
        newState,
        updatedAt: now,
      });
    } else {
      result = this.statements.updateStateOnly.run({ id, newState, updatedAt: now });
    }
    if (result.changes > 0) {
      try {
        this._transitionHooks.onExit?.(id, currentState, newState);
        this._transitionHooks.onEnter?.(id, newState, currentState);
      } catch (hookErr) {
        log.warn(`Hook de transición para descarga ${id}:`, (hookErr as Error)?.message);
      }
    }
    return result.changes > 0;
  }

  getDownload(id: number): Download | null {
    if (!this.statements) return null;
    const row = this.statements.getById.get(id) as Row | undefined;
    return row ? this._rowToDownload(row) : null;
  }

  clearLastError(id: number): boolean {
    if (!this.statements) return false;
    const now = Date.now();
    const result = this.statements.clearLastError.run({ id, updatedAt: now });
    return result.changes > 0;
  }

  getDownloadsByState(state: string): Download[] {
    if (!this.statements) return [];
    return this.statements.getByState.all(state).map((row: Row) => this._rowToDownload(row));
  }

  updateDownload(id: number, updates: UpdateDownloadUpdates): boolean {
    if (!this.statements) return false;
    const now = Date.now();
    try {
      if (updates.state !== undefined && updates.state !== null) {
        const currentDownload = this.getDownload(id);
        if (!currentDownload) {
          log.warn(`No se puede actualizar descarga ${id}: no existe`);
          return false;
        }
        if (updates.state !== currentDownload.state) {
          if (!this.canTransition(currentDownload.state, updates.state)) {
            const { state: _s, ...otherUpdates } = updates;
            if (Object.keys(otherUpdates).length === 0) return false;
            return this.updateDownload(id, otherUpdates);
          }
          this.transitionState(id, updates.state, currentDownload.state);
          const { state: _s2, ...otherUpdates2 } = updates;
          if (Object.keys(otherUpdates2).length === 0) return true;
          return this.updateDownload(id, otherUpdates2);
        }
      }

      const isProgressOnly =
        (updates.progress !== undefined || updates.downloadedBytes !== undefined) &&
        Object.keys(updates).filter(k => k !== 'progress' && k !== 'downloadedBytes').length === 0;

      if (isProgressOnly) {
        this._addToProgressBatch(
          id,
          updates.progress ?? undefined,
          updates.downloadedBytes ?? undefined,
          false
        );
        if (!this.progressBatchInterval) this._startProgressBatch();
        return true;
      }

      if (updates.progress !== undefined || updates.downloadedBytes !== undefined) {
        this._flushProgressBatch();
      }

      this.statements.updateDownload.run({
        id,
        state: null,
        progress: updates.progress ?? null,
        downloadedBytes: updates.downloadedBytes ?? null,
        totalBytes: updates.totalBytes ?? null,
        savePath: updates.savePath ?? null,
        url: updates.url ?? null,
        startedAt: updates.startedAt ?? null,
        completedAt: updates.completedAt ?? null,
        retryCount: updates.retryCount ?? null,
        lastError: updates.lastError ?? null,
        actualHash: updates.actualHash ?? null,
        hashVerified: updates.hashVerified !== undefined ? (updates.hashVerified ? 1 : 0) : null,
        sizeVerified: updates.sizeVerified !== undefined ? (updates.sizeVerified ? 1 : 0) : null,
        forceOverwrite:
          updates.forceOverwrite !== undefined ? (updates.forceOverwrite ? 1 : 0) : null,
        partialTailHash: updates.partialTailHash ?? null,
        partialTailSize: updates.partialTailSize ?? null,
        updatedAt: now,
      });
      return true;
    } catch (error) {
      log.error(`Error actualizando descarga ${id}:`, error);
      return false;
    }
  }

  createChunks(
    downloadId: number,
    chunks: { chunkIndex: number; startByte: number; endByte: number; tempFile?: string | null }[]
  ): {
    downloadId: number;
    chunkIndex: number;
    startByte: number;
    endByte: number;
    state: string;
  }[] {
    if (!this._db || !this.statements) return [];
    const now = Date.now();
    const created: {
      downloadId: number;
      chunkIndex: number;
      startByte: number;
      endByte: number;
      state: string;
    }[] = [];
    const transaction = this._db.transaction((chunksList: typeof chunks) => {
      for (const chunk of chunksList) {
        this.statements!.insertChunk.run({
          downloadId,
          chunkIndex: chunk.chunkIndex,
          startByte: chunk.startByte,
          endByte: chunk.endByte,
          downloadedBytes: 0,
          state: ChunkState.PENDING,
          tempFile: chunk.tempFile ?? null,
          hash: null,
          hashVerified: 0,
          createdAt: now,
          updatedAt: now,
        });
        created.push({
          downloadId,
          chunkIndex: chunk.chunkIndex,
          startByte: chunk.startByte,
          endByte: chunk.endByte,
          state: ChunkState.PENDING,
        });
      }
    });
    transaction(chunks);
    log.debug(`Creados ${created.length} chunks para descarga ${downloadId}`);
    return created;
  }

  getChunks(downloadId: number): Chunk[] {
    if (!this.statements) return [];
    const rows = this.statements.getChunks.all(downloadId) as Row[];
    return rows.map(row => {
      const startByte =
        typeof row.start_byte === 'bigint' ? Number(row.start_byte) : (row.start_byte as number);
      const endByte =
        typeof row.end_byte === 'bigint' ? Number(row.end_byte) : (row.end_byte as number);
      const downloadedBytes =
        typeof row.downloaded_bytes === 'bigint'
          ? Number(row.downloaded_bytes)
          : (row.downloaded_bytes as number);
      return {
        id: row.id as number,
        downloadId: row.download_id as number,
        chunkIndex: row.chunk_index as number,
        startByte,
        endByte,
        downloadedBytes,
        state: row.state as string,
        tempFile: row.temp_file as string | null,
        hash: row.hash as string | null,
        hashVerified: !!(row.hash_verified as number),
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
        tailCheckpointHash: (row.tail_checkpoint_hash as string) ?? null,
        tailCheckpointSize:
          row.tail_checkpoint_size != null ? Number(row.tail_checkpoint_size) : null,
      };
    });
  }

  deleteChunks(downloadId: number): number {
    if (!this.statements) return 0;
    try {
      const result = this.statements.deleteChunks.run(downloadId);
      if (result.changes > 0)
        log.debug(`Eliminados ${result.changes} chunks de BD para descarga ${downloadId}`);
      return result.changes;
    } catch (error) {
      log.error(`Error eliminando chunks de BD para descarga ${downloadId}:`, error);
      return 0;
    }
  }

  updateChunkProgress(
    downloadId: number,
    chunkIndex: number,
    updates: {
      downloadedBytes?: number | null;
      state?: string | null;
      tempFile?: string | null;
      hash?: string | null;
      hashVerified?: boolean;
      tailCheckpointHash?: string | null;
      tailCheckpointSize?: number | null;
    }
  ): boolean {
    if (!this.statements) return false;
    const now = Date.now();
    try {
      this.statements.updateChunk.run({
        downloadId,
        chunkIndex,
        downloadedBytes: updates.downloadedBytes ?? null,
        state: updates.state ?? null,
        tempFile: updates.tempFile ?? null,
        hash: updates.hash ?? null,
        hashVerified: updates.hashVerified !== undefined ? (updates.hashVerified ? 1 : 0) : null,
        tailCheckpointHash: updates.tailCheckpointHash ?? null,
        tailCheckpointSize: updates.tailCheckpointSize ?? null,
        updatedAt: now,
      });
      return true;
    } catch (error) {
      log.error(`Error actualizando chunk ${downloadId}-${chunkIndex}:`, error);
      return false;
    }
  }

  recordAttempt(attempt: {
    downloadId: number;
    chunkId?: number | null;
    attemptNumber?: number;
    timestamp?: number;
    error?: string | null;
    errorCode?: string | null;
    bytesTransferred?: number;
    durationMs?: number | null;
    speedBytesPerSec?: number | null;
  }): boolean {
    if (!this.statements) return false;
    try {
      this.statements.insertAttempt.run({
        downloadId: attempt.downloadId,
        chunkId: attempt.chunkId ?? null,
        attemptNumber: attempt.attemptNumber ?? 1,
        timestamp: attempt.timestamp ?? Date.now(),
        error: attempt.error ?? null,
        errorCode: attempt.errorCode ?? null,
        bytesTransferred: attempt.bytesTransferred ?? 0,
        durationMs: attempt.durationMs ?? null,
        speedBytesPerSec: attempt.speedBytesPerSec ?? null,
      });
      return true;
    } catch (error) {
      log.error('Error registrando intento:', error);
      return false;
    }
  }

  getAttempts(downloadId: number): {
    id: number;
    downloadId: number;
    chunkId: number | null;
    attemptNumber: number;
    timestamp: number;
    error: string | null;
    errorCode: string | null;
    bytesTransferred: number;
    durationMs: number | null;
    speedBytesPerSec: number | null;
  }[] {
    if (!this.statements) return [];
    const rows = this.statements.getAttempts.all(downloadId) as Row[];
    return rows.map(row => ({
      id: row.id as number,
      downloadId: row.download_id as number,
      chunkId: row.chunk_id as number | null,
      attemptNumber: row.attempt_number as number,
      timestamp: row.timestamp as number,
      error: row.error as string | null,
      errorCode: row.error_code as string | null,
      bytesTransferred: row.bytes_transferred as number,
      durationMs: row.duration_ms as number | null,
      speedBytesPerSec: row.speed_bytes_per_sec as number | null,
    }));
  }

  getHistory(downloadId: number): {
    id: number;
    downloadId: number;
    eventType: string;
    eventData: unknown;
    createdAt: number;
  }[] {
    if (!this.statements) return [];
    const rows = this.statements.getHistory.all(downloadId) as Row[];
    return rows.map(row => ({
      id: row.id as number,
      downloadId: row.download_id as number,
      eventType: row.event_type as string,
      eventData: row.event_data != null ? JSON.parse(row.event_data as string) : null,
      createdAt: row.created_at as number,
    }));
  }

  /** Delega en la máquina de estados explícita (DownloadStateMachine). */
  canTransition(fromState: string, toState: string): boolean {
    return stateMachineCanTransition(fromState, toState);
  }

  private _rowToDownload(row: Row): Download {
    const downloadedBytes =
      typeof row.downloaded_bytes === 'bigint'
        ? Number(row.downloaded_bytes)
        : (row.downloaded_bytes as number);
    const totalBytes =
      typeof row.total_bytes === 'bigint' ? Number(row.total_bytes) : (row.total_bytes as number);
    return {
      id: row.id as number,
      title: row.title as string,
      url: row.url as string | null,
      savePath: row.save_path as string | null,
      downloadPath: row.download_path as string | null,
      preserveStructure: !!(row.preserve_structure as number),
      state: row.state as string,
      stateVersion: row.state_version as number,
      progress: row.progress as number,
      downloadedBytes,
      totalBytes,
      priority: row.priority as number,
      forceOverwrite: !!(row.force_overwrite as number),
      createdAt: row.created_at as number,
      startedAt: row.started_at as number | null,
      completedAt: row.completed_at as number | null,
      updatedAt: row.updated_at as number,
      retryCount: row.retry_count as number,
      maxRetries: row.max_retries as number,
      lastError: row.last_error as string | null,
      expectedHash: row.expected_hash as string | null,
      actualHash: row.actual_hash as string | null,
      hashVerified: !!(row.hash_verified as number),
      sizeVerified: !!(row.size_verified as number),
      queuePosition: row.queue_position as number | null,
      partialTailHash: (row.partial_tail_hash as string) ?? null,
      partialTailSize: row.partial_tail_size != null ? Number(row.partial_tail_size) : null,
    };
  }

  deleteDownload(id: number): boolean {
    if (!this._db) return false;
    try {
      const result = this._db.prepare('DELETE FROM downloads WHERE id = ?').run(id);
      if (result.changes > 0) {
        // Incrementar state_version para que el frontend acepte el snapshot tras eliminar
        // (los triggers solo se disparan en INSERT/UPDATE, no en DELETE)
        this._db.prepare('UPDATE state_version SET version = -(ABS(version) + 1)').run();
        this._db.prepare('UPDATE state_version SET version = -version').run();
      }
      return result.changes > 0;
    } catch (error) {
      log.error(`Error eliminando descarga ${id}:`, error);
      return false;
    }
  }

  clearDownloads(): number {
    if (!this._db) return 0;
    try {
      // Quitar de la lista las descargas en estado listo o detenido: completed, failed, cancelled
      const result = this._db
        .prepare("DELETE FROM downloads WHERE state IN ('completed', 'failed', 'cancelled')")
        .run();
      if (result.changes > 0) {
        this._db.prepare('UPDATE state_version SET version = -(ABS(version) + 1)').run();
        this._db.prepare('UPDATE state_version SET version = -version').run();
      }
      log.info(`Limpiadas ${result.changes} descargas del historial`);
      return result.changes;
    } catch (error) {
      log.error('Error limpiando descargas:', error);
      return 0;
    }
  }

  private _startProgressBatch(): void {
    if (this.progressBatchInterval) return;
    this.progressBatchInterval = setInterval(
      () => this._flushProgressBatch(),
      this.progressBatchDelay
    );
    log.debug('Batch de progreso iniciado');
  }

  private _stopProgressBatch(): void {
    if (this.progressBatchInterval) {
      clearInterval(this.progressBatchInterval);
      this.progressBatchInterval = null;
    }
    this._flushProgressBatch();
  }

  private _flushProgressBatch(): void {
    if (!this.progressBatch || this.progressBatch.size === 0 || !this._db || !this.statements)
      return;
    const now = Date.now();
    const batchEntries = Array.from(this.progressBatch.entries());
    const batchBackup = new Map(this.progressBatch);
    this.progressBatch.clear();
    try {
      const transaction = this._db.transaction(() => {
        for (const [downloadId, data] of batchEntries) {
          this.statements!.updateDownload.run({
            id: downloadId,
            state: null,
            progress: data.progress ?? null,
            downloadedBytes: data.downloadedBytes ?? null,
            totalBytes: null,
            savePath: null,
            url: null,
            startedAt: null,
            completedAt: null,
            retryCount: null,
            lastError: null,
            actualHash: null,
            hashVerified: null,
            sizeVerified: null,
            forceOverwrite: null,
            partialTailHash: null,
            partialTailSize: null,
            updatedAt: now,
          });
        }
      });
      transaction();
      log.debug(`Batch de progreso flush completado: ${batchEntries.length} actualizaciones`);
    } catch (error) {
      log.error('Error en flush de batch de progreso, restaurando batch:', error);
      batchBackup.forEach((value, key) => {
        const existing = this.progressBatch.get(key);
        if (existing) {
          this.progressBatch.set(key, {
            progress: existing.progress ?? value.progress,
            downloadedBytes: existing.downloadedBytes ?? value.downloadedBytes,
            lastUpdate: existing.lastUpdate,
          });
        } else {
          this.progressBatch.set(key, value);
        }
      });
      if (!this._retryFlushScheduled) {
        this._retryFlushScheduled = true;
        setTimeout(() => {
          this._retryFlushScheduled = false;
          this._flushProgressBatch();
        }, this.progressBatchDelay * 2);
      }
    }
  }

  private _addToProgressBatch(
    downloadId: number,
    progress?: number | null,
    downloadedBytes?: number | null,
    forceFlush = false
  ): void {
    const existing = this.progressBatch.get(downloadId);
    const now = Date.now();
    this.progressBatch.set(downloadId, {
      progress: progress ?? existing?.progress,
      downloadedBytes: downloadedBytes ?? existing?.downloadedBytes,
      lastUpdate: now,
    });
    const timingConfig = config.timing as { maxProgressBatchSize?: number } | undefined;
    const maxBatchSize = timingConfig?.maxProgressBatchSize ?? 50;
    if (forceFlush || this.progressBatch.size >= maxBatchSize) this._flushProgressBatch();
  }

  close(): void {
    if (this.progressBatchInterval) this._stopProgressBatch();
    if (this._db) {
      this._db.pragma('wal_checkpoint(TRUNCATE)');
      this._db.close();
      this._db = null;
      this.statements = null;
      this._initialized = false;
      log.info('StateStore cerrado');
    }
  }
}

const stateStore = new StateStore();
export default stateStore;
