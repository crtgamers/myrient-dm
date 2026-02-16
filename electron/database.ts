/**
 * Módulo de acceso al catálogo (Myrient / LoLROMs SQLite).
 *
 * Responsabilidades:
 * - Conexión read-only a myrient_data.db o lolrom_data.db (tras crear índices y element_paths si aplica).
 * - Búsqueda por texto: FTS5/FTS4 si existe tabla FTS, fallback a LIKE; opcionalmente en worker thread.
 * - Navegación: getChildren, getAncestors, getNodeInfo, getFileDownloadInfo, getAllFilesInFolder.
 * - Extracción inicial desde .7z si la DB no existe y sí existe el archivo comprimido.
 *
 * Soporta múltiples fuentes: Myrient (tabla elements) y LoLROMs (tabla content).
 *
 * @module database
 */

export type CatalogSource = 'myrient' | 'lolroms';

import Database from 'better-sqlite3';
import { app, dialog } from 'electron';
import config from './config';
import { MAX_TABLE_NAME_LENGTH, MAX_SEARCH_TERM_LENGTH } from './constants/validations';
import { logger, escapeLikeTerm } from './utils';
import { getWorkerManager } from './utils/dbQueryWorkerManager';
import type { SearchOptions as SharedSearchOptions } from '../shared/types/search';

// Módulos extraídos para reducir acoplamiento (dbExtractor, nodeNormalizer)
import { fileExists, extractDatabase } from './utils/dbExtractor';
import {
  normalizeType,
  formatSize,
  normalizeNodeWithPathsMap,
  normalizeNodeWithAncestorMap,
} from './utils/nodeNormalizer';

const log = logger.child('Database');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resultado de una búsqueda: datos normalizados, total, paginación y flags de timeout/cancelación. */
export interface SearchResult {
  success: boolean;
  data?: NodeInfo[];
  total?: number;
  limit?: number;
  offset?: number;
  hasMore?: boolean;
  error?: string;
  timeout?: boolean;
  cancelled?: boolean;
}

/** Nodo del árbol del catálogo (archivo o carpeta) con metadatos para la UI. */
export interface NodeInfo {
  id: number;
  name: string;
  title?: string;
  parent_id?: number | null;
  type?: string;
  size_bytes?: number | null;
  size?: string;
  url?: string | null;
  displayTitle?: string;
  breadcrumbPath?: string;
  fullPath?: string;
  modified_date?: number | null;
}

export interface FTSTableInfo {
  name: string;
  type: 'fts5' | 'fts4';
  columns: string[];
}

/** Opciones de búsqueda (base compartida + signal para cancelación en main). */
export interface SearchOptions extends SharedSearchOptions {
  signal?: AbortSignal | null;
}

export interface GetChildrenOptions {
  limit?: number | null;
  offset?: number;
}

/** Resultado de getChildren: lista normalizada y total de hijos del nodo. */
export interface GetChildrenResult {
  success: boolean;
  data?: NodeInfo[];
  total?: number;
  error?: string;
}

/** Tipo mínimo para statements (get/all); las instancias reales son better-sqlite3 Statement. */
export interface DatabaseStatements {
  searchFTS: { get?(..._a: unknown[]): unknown; all(..._a: unknown[]): unknown[] } | null;
  searchFTSByType: { all(..._a: unknown[]): unknown[] } | null;
  searchFTSNoPagination: { all(..._a: unknown[]): unknown[] } | null;
  searchFTSCount: { get(..._a: unknown[]): unknown } | null;
  searchLike: { all(..._a: unknown[]): unknown[] } | null;
  searchLikeByType: { all(..._a: unknown[]): unknown[] } | null;
  searchLikeNoPagination: { all(..._a: unknown[]): unknown[] } | null;
  search: { all(..._a: unknown[]): unknown[] } | null;
  getChildren: { all(..._a: unknown[]): unknown[] } | null;
  getChildrenPaginated: { all(..._a: unknown[]): unknown[] } | null;
  getChildrenCount: { get(..._a: unknown[]): unknown } | null;
  getNodeById: { get(..._a: unknown[]): unknown } | null;
  getNodeTitle: { get(..._a: unknown[]): unknown } | null;
  getNodeWithUrl: { get(..._a: unknown[]): unknown } | null;
  getSuggestedTestFile: { get(..._a: unknown[]): unknown } | null;
  getAncestors: { all(..._a: unknown[]): unknown[] } | null;
  getAncestorsWithNode: { all(..._a: unknown[]): unknown[] } | null;
  getDescendantIds: { all(..._a: unknown[]): number[] } | null;
  getLatestModifiedDate: { get(..._a: unknown[]): unknown } | null;
  getAllFilesRecursive: { all(..._a: unknown[]): unknown[] } | null;
  [key: string]:
    | { get?(..._a: unknown[]): unknown; all?(..._a: unknown[]): unknown[] }
    | null
    | undefined;
}

interface NavCacheEntry {
  value: unknown;
  ts: number;
}

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

/**
 * Ejecuta una promesa con tiempo límite y opcional cancelación por AbortSignal.
 * Si hay signal y se aborta, rechaza con DOMException 'AbortError'.
 *
 * @param promise - Promesa a ejecutar.
 * @param timeoutMs - Tiempo máximo en ms.
 * @param operationName - Nombre de la operación para mensajes de error (por defecto 'Operación').
 * @param abortSignal - Si se proporciona y se aborta, rechaza con AbortError.
 * @returns Resultado de la promesa si se resuelve a tiempo y no se aborta.
 * @throws Error si se excede el tiempo; DOMException 'AbortError' si se aborta.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName = 'Operación',
  abortSignal: AbortSignal | null = null
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operationName} excedió el tiempo límite de ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const abortPromise = abortSignal
    ? new Promise<never>((_, reject) => {
        if (abortSignal.aborted) {
          reject(new DOMException('Búsqueda cancelada', 'AbortError'));
          return;
        }
        abortSignal.addEventListener(
          'abort',
          () => reject(new DOMException('Búsqueda cancelada', 'AbortError')),
          { once: true }
        );
      })
    : null;

  const toRace = abortPromise ? [promise, timeoutPromise, abortPromise] : [promise, timeoutPromise];

  try {
    const result = await Promise.race(toRace);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// DatabaseService
// ---------------------------------------------------------------------------

type DatabaseInstance = InstanceType<typeof Database>;

/**
 * Servicio de acceso al catálogo: conexión read-only, búsqueda FTS/LIKE, navegación y cache.
 * Tras initialize() la DB se abre en readonly; la primera apertura (r/w) crea índices y element_paths.
 */
class DatabaseService {
  db: DatabaseInstance | null = null;
  statements: DatabaseStatements | null = null;
  workerManager = getWorkerManager();
  useWorkerForFTS = true;
  workerFTSThreshold = 1;
  private _navCache = new Map<string, NavCacheEntry>();
  private _navCacheTTL = 30 * 1000;
  private _navCacheMaxSize = 200;

  ftsTable: string | null = null;
  ftsType: 'fts5' | 'fts4' | null = null;
  /** Flag para lazy init de element_paths (evita CTE costosa si ya poblada). */
  private _elementPathsPopulated = false;
  ftsColumns: string[] = ['name'];
  useFTS = false;

  /** Fuente activa del catálogo; null = ninguna DB cargada. */
  private _currentSource: CatalogSource | null = null;
  /** Nombre de la tabla principal: elements (Myrient) o content (LoLROMs). */
  private _tableName = 'elements';

  get currentSource(): CatalogSource | null {
    return this._currentSource;
  }

  /** Rutas y tabla según la fuente. */
  private _getPathsForSource(source: CatalogSource): {
    dbPath: string;
    compressed7zPath: string;
    tableName: string;
  } {
    const p = config.paths as {
      dbPath: string;
      compressed7zPath: string;
      lolromDbPath?: string;
      lolromCompressed7zPath?: string;
    };
    if (source === 'lolroms' && p.lolromDbPath && p.lolromCompressed7zPath) {
      return {
        dbPath: p.lolromDbPath,
        compressed7zPath: p.lolromCompressed7zPath,
        tableName: 'content',
      };
    }
    return {
      dbPath: p.dbPath,
      compressed7zPath: p.compressed7zPath,
      tableName: 'elements',
    };
  }

  /**
   * Abre la DB de la fuente indicada (crea índices y element_paths si hace falta),
   * la reabre en readonly, prepara statements y opcionalmente inicializa el worker.
   * Si no existe el .db pero sí el .7z, intenta extraer.
   *
   * @param source - 'myrient' o 'lolroms'
   * @returns true si la conexión y preparación fueron exitosas; false en caso contrario.
   */
  async initialize(source: CatalogSource): Promise<boolean> {
    return this.loadDatabase(source);
  }

  /**
   * Carga la base de datos de la fuente indicada. Cierra la conexión actual si existe.
   *
   * @param source - 'myrient' o 'lolroms'
   * @returns true si la carga fue exitosa; false en caso contrario (muestra diálogo de error solo en myrient si falta).
   */
  async loadDatabase(source: CatalogSource): Promise<boolean> {
    this.close();
    this._elementPathsPopulated = false;

    const endInit = logger.startOperation?.(`Cargando base de datos: ${source}`) ?? (() => {});
    const { dbPath, compressed7zPath, tableName } = this._getPathsForSource(source);

    const [dbExists, archiveExists] = await Promise.all([
      fileExists(dbPath),
      fileExists(compressed7zPath),
    ]);

    if (!dbExists && archiveExists) {
      log.info('Base de datos no encontrada, extrayendo desde .7z...');
      try {
        await extractDatabase(dbPath, compressed7zPath);
        log.info('Extracción completada, verificando archivo...');
        if (!(await fileExists(dbPath))) {
          this._showError(
            'Extraction Error',
            `Extraction completed but DB was not found at: ${dbPath}`
          );
          return false;
        }
      } catch (error) {
        log.error('Error durante la extracción:', error);
        this._showError(
          'Database Extraction Error',
          `Failed to extract the database:\n\n${(error as Error).message}`
        );
        return false;
      }
    }

    if (!dbExists && !archiveExists) {
      const dbName = source === 'myrient' ? 'myrient_data.db' : 'lolrom_data.db';
      this._showError('Database Error', `The file '${dbName}' was not found at: ${dbPath}`);
      return false;
    }

    try {
      this._currentSource = source;
      this.db = new Database(dbPath, { fileMustExist: true });

      // Detectar nombre de tabla: content o elements (LoLROMs puede usar cualquiera)
      const detectedTable = this._detectContentTable(tableName);
      if (!detectedTable) {
        this.db.close();
        this.db = null;
        this._showError(
          'Database Schema Error',
          `Expected table '${tableName}' or 'elements' not found. ` +
            `The database must have a table with columns: id, parent_id, name, type, url.`
        );
        return false;
      }
      this._tableName = detectedTable;
      log.info(`Usando tabla: ${detectedTable}`);

      this.db.exec(
        `CREATE INDEX IF NOT EXISTS idx_${detectedTable}_parent_id ON ${detectedTable}(parent_id)`
      );
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS idx_${detectedTable}_parent_type_name ON ${detectedTable}(parent_id, type DESC, name ASC)`
      );
      this._ensureElementPathsPopulated();

      this.db.close();
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });

      this._prepareStatements();

      if (this.useWorkerForFTS) {
        this.workerManager.initialize(dbPath, 'catalog', this._tableName).catch((error: Error) => {
          log.warn('No se pudo inicializar worker thread, usando modo síncrono:', error.message);
          this.useWorkerForFTS = false;
        });
      }

      endInit(`conectada en ${dbPath}`);
      return true;
    } catch (error) {
      log.error('Error al conectar con la base de datos:', error);
      this._showError(
        'Database Connection Error',
        `Could not open the database: ${(error as Error).message}`
      );
      return false;
    }
  }

  /**
   * Detecta la tabla principal del catálogo (content o elements).
   * Comprueba que exista y tenga las columnas id, parent_id, name, type.
   */
  _detectContentTable(preferredTable: string): string | null {
    if (!this.db) return null;
    const candidates = [preferredTable, preferredTable === 'content' ? 'elements' : 'content'];
    const requiredColumns = ['id', 'parent_id', 'name', 'type'];

    for (const tableName of candidates) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) continue;
      try {
        const tableInfo = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
          name: string;
        }>;
        const columns = new Set(tableInfo.map(r => r.name));
        const hasRequired = requiredColumns.every(col => columns.has(col));
        if (hasRequired) return tableName;
      } catch {
        /* tabla no existe, probar siguiente candidato */
      }
    }
    return null;
  }

  /**
   * Crea y puebla element_paths con rutas completas (solo si tabla tiene ≤100k filas).
   * Optimizado: si la tabla ya contiene datos de una sesión anterior, salta la CTE costosa.
   * Se ejecuta durante loadDatabase() con conexión write-mode para poder insertar.
   */
  _ensureElementPathsPopulated(): void {
    if (this._elementPathsPopulated || !this.db) return;
    this._elementPathsPopulated = true;
    const tbl = this._tableName;

    try {
      // Crear tabla si no existe
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS element_paths (
          id INTEGER PRIMARY KEY,
          full_path TEXT NOT NULL,
          parent_path TEXT NOT NULL
        )
      `);
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_element_paths_id ON element_paths(id)');

      // Verificar si ya está poblada (ej. de una sesión anterior en la misma DB → skip CTE)
      const existingCount =
        (this.db.prepare('SELECT COUNT(*) as c FROM element_paths').get() as { c?: number })?.c ??
        0;
      if (existingCount > 0) {
        log.debug?.(`element_paths: ya poblada (${existingCount} rutas), omitiendo CTE`);
        return;
      }

      const countRow = this.db.prepare(`SELECT COUNT(*) as c FROM ${tbl}`).get() as {
        c?: number;
      };
      const elementCount = countRow?.c ?? 0;

      if (elementCount > 100000) {
        if (log.debug)
          log.debug(`element_paths: omitiendo población (${elementCount} elementos > 100k)`);
        return;
      }

      const startPopulate = Date.now();
      this.db.exec(`
        INSERT OR REPLACE INTO element_paths (id, full_path, parent_path)
        WITH RECURSIVE path_tree AS (
          SELECT id, parent_id,
            COALESCE(TRIM(REPLACE(name, '/', '')), '') as name,
            COALESCE(TRIM(REPLACE(name, '/', '')), '') as full_path,
            '' as parent_path,
            0 as depth
          FROM ${tbl} WHERE id = 1
          UNION ALL
          SELECT e.id, e.parent_id,
            COALESCE(NULLIF(TRIM(REPLACE(e.name, '/', '')), ''), ''),
            p.full_path || CASE WHEN p.full_path <> '' THEN ' / ' ELSE '' END || COALESCE(NULLIF(TRIM(REPLACE(e.name, '/', '')), ''), ''),
            p.full_path,
            p.depth + 1
          FROM ${tbl} e
          INNER JOIN path_tree p ON e.parent_id = p.id
        )
        SELECT id, full_path, parent_path FROM path_tree WHERE id != 1
      `);
      const elapsed = Date.now() - startPopulate;
      const pathCount =
        (this.db.prepare('SELECT COUNT(*) as c FROM element_paths').get() as { c?: number })?.c ??
        0;
      log.info(`element_paths: poblado ${pathCount} rutas en ${elapsed}ms (lazy init)`);
    } catch (err) {
      log.warn('element_paths: no se pudo poblar:', (err as Error).message);
    }
  }

  /** Detecta si existe una tabla FTS5 o FTS4 en la DB y devuelve nombre, tipo y columnas indexadas. */
  _detectFTS(): FTSTableInfo | null {
    if (!this.db) return null;
    try {
      const fts5Tables = this.db
        .prepare(
          `
                SELECT name, sql FROM sqlite_master 
                WHERE type='table' 
                AND (name LIKE '%fts%' OR name LIKE '%_fts%' OR name LIKE '%_content%')
                AND sql LIKE '%USING fts5%'
            `
        )
        .all() as Array<{ name: string; sql: string | null }>;

      if (fts5Tables.length > 0) {
        const ftsTable = fts5Tables[0];
        let indexedColumns = ['title'];
        try {
          const sql = ftsTable.sql || '';
          const columnMatch = sql.match(/\(([^)]+)\)/);
          if (columnMatch) {
            indexedColumns = columnMatch[1]
              .split(',')
              .map(col => col.trim().split(/\s+/)[0])
              .filter(col => col && !col.startsWith('content='));
          }
        } catch {
          if (log.debug) log.debug('No se pudieron extraer columnas FTS');
        }
        log.info(`Tabla FTS5 detectada: ${ftsTable.name} (columnas: ${indexedColumns.join(', ')})`);
        return { name: ftsTable.name, type: 'fts5', columns: indexedColumns };
      }

      const fts4Tables = this.db
        .prepare(
          `
                SELECT name, sql FROM sqlite_master 
                WHERE type='table' 
                AND (name LIKE '%fts%' OR name LIKE '%_fts%')
                AND sql LIKE '%USING fts4%'
            `
        )
        .all() as Array<{ name: string }>;

      if (fts4Tables.length > 0) {
        log.info(`Tabla FTS4 detectada: ${fts4Tables[0].name}`);
        return { name: fts4Tables[0].name, type: 'fts4', columns: ['name'] };
      }

      return null;
    } catch (error) {
      log.warn('Error detectando FTS:', (error as Error).message);
      return null;
    }
  }

  _validateFTSTableName(tableName: string | null | undefined): boolean {
    if (!tableName || typeof tableName !== 'string') return false;
    const validTableNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    if (!validTableNamePattern.test(tableName)) {
      log.error(`Nombre de tabla FTS inválido (caracteres no permitidos): ${tableName}`);
      return false;
    }
    const dangerousKeywords = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'CREATE', 'TRUNCATE'];
    const upperTableName = tableName.toUpperCase();
    for (const keyword of dangerousKeywords) {
      if (upperTableName.includes(keyword)) {
        log.error(`Nombre de tabla FTS contiene palabra clave peligrosa: ${tableName}`);
        return false;
      }
    }
    if (tableName.length > MAX_TABLE_NAME_LENGTH) {
      log.error(`Nombre de tabla FTS demasiado largo: ${tableName.length} caracteres`);
      return false;
    }
    return true;
  }

  _prepareStatements(): void {
    if (!this.db) return;
    log.debug('Preparando statements SQL...');

    const ftsInfo = this._detectFTS();
    this.ftsTable = ftsInfo ? ftsInfo.name : null;
    this.ftsType = ftsInfo ? ftsInfo.type : null;
    this.ftsColumns = ftsInfo ? ftsInfo.columns : ['name'];
    this.useFTS = !!this.ftsTable;

    if (this.useFTS && this.ftsTable && !this._validateFTSTableName(this.ftsTable)) {
      log.error(`Tabla FTS inválida detectada: ${this.ftsTable}, deshabilitando FTS por seguridad`);
      this.useFTS = false;
      this.ftsTable = null;
      this.ftsType = null;
    }

    const ftsTable = this.ftsTable;
    const ftsType = this.ftsType;
    const tbl = this._tableName;

    this.statements = {
      searchFTS:
        this.useFTS && ftsTable && this._validateFTSTableName(ftsTable)
          ? ftsType === 'fts5'
            ? this.db.prepare(`
                        SELECT n.id, n.name, n.modified_date, n.type, n.parent_id, n.size_bytes,
                               bm25(${ftsTable}) AS relevance
                        FROM ${ftsTable} fts
                        INNER JOIN ${tbl} n ON n.id = fts.rowid
                        WHERE ${ftsTable} MATCH ?
                        ORDER BY n.type DESC, relevance ASC, n.name ASC
                        LIMIT ? OFFSET ?
                    `)
            : this.db.prepare(`
                        SELECT n.id, n.name, n.modified_date, n.type, n.parent_id, n.size_bytes,
                               matchinfo(${ftsTable}) AS matchinfo_data,
                               0 AS relevance
                        FROM ${ftsTable} fts
                        INNER JOIN ${tbl} n ON n.id = fts.rowid
                        WHERE ${ftsTable} MATCH ?
                        ORDER BY n.type DESC, n.name ASC
                        LIMIT ? OFFSET ?
                    `)
          : null,

      searchFTSByType:
        this.useFTS && ftsTable && this._validateFTSTableName(ftsTable)
          ? ftsType === 'fts5'
            ? this.db.prepare(`
                        SELECT n.id, n.name, n.modified_date, n.type, n.parent_id, n.size_bytes,
                               bm25(${ftsTable}) AS relevance
                        FROM ${ftsTable} fts
                        INNER JOIN ${tbl} n ON n.id = fts.rowid
                        WHERE ${ftsTable} MATCH ? AND n.type = ?
                        ORDER BY relevance ASC, n.name ASC
                        LIMIT ? OFFSET ?
                    `)
            : this.db.prepare(`
                        SELECT n.id, n.name, n.modified_date, n.type, n.parent_id, n.size_bytes,
                               0 AS relevance
                        FROM ${ftsTable} fts
                        INNER JOIN ${tbl} n ON n.id = fts.rowid
                        WHERE ${ftsTable} MATCH ? AND n.type = ?
                        ORDER BY n.name ASC
                        LIMIT ? OFFSET ?
                    `)
          : null,

      searchFTSNoPagination:
        this.useFTS && ftsTable && this._validateFTSTableName(ftsTable)
          ? ftsType === 'fts5'
            ? this.db.prepare(`
                        SELECT n.id, n.name, n.modified_date, n.type, n.parent_id, n.size_bytes,
                               bm25(${ftsTable}) AS relevance
                        FROM ${ftsTable} fts
                        INNER JOIN ${tbl} n ON n.id = fts.rowid
                        WHERE ${ftsTable} MATCH ?
                        ORDER BY n.type DESC, relevance ASC, n.name ASC
                        LIMIT 500
                    `)
            : this.db.prepare(`
                        SELECT n.id, n.name, n.modified_date, n.type, n.parent_id, n.size_bytes,
                               0 AS relevance
                        FROM ${ftsTable} fts
                        INNER JOIN ${tbl} n ON n.id = fts.rowid
                        WHERE ${ftsTable} MATCH ?
                        ORDER BY n.type DESC, n.name ASC
                        LIMIT 500
                    `)
          : null,

      searchFTSCount:
        this.useFTS && ftsTable && this._validateFTSTableName(ftsTable)
          ? this.db
              .prepare(
                `SELECT COUNT(*) FROM (SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ? LIMIT 10000)`
              )
              .pluck()
          : null,

      searchLike: this.db.prepare(`
                SELECT id, name, modified_date, type, parent_id, size_bytes,
                       CASE 
                           WHEN name LIKE ? THEN 1
                           WHEN name LIKE ? THEN 2
                           WHEN name LIKE ? THEN 3
                           ELSE 4
                       END AS relevance
                FROM ${tbl} 
                WHERE (name LIKE ? ESCAPE '|'
                   OR name LIKE ? ESCAPE '|'
                   OR name LIKE ? ESCAPE '|')
                ORDER BY type DESC, relevance ASC, name ASC
                LIMIT ? OFFSET ?
            `),

      searchLikeByType: this.db.prepare(`
                SELECT id, name, modified_date, type, parent_id, size_bytes,
                       CASE 
                           WHEN name LIKE ? THEN 1
                           WHEN name LIKE ? THEN 2
                           WHEN name LIKE ? THEN 3
                           ELSE 4
                       END AS relevance
                FROM ${tbl} 
                WHERE (name LIKE ? ESCAPE '|' OR name LIKE ? ESCAPE '|' OR name LIKE ? ESCAPE '|')
                  AND type = ?
                ORDER BY relevance ASC, name ASC
                LIMIT ? OFFSET ?
            `),

      searchLikeNoPagination: this.db.prepare(`
                SELECT id, name, modified_date, type, parent_id, size_bytes,
                       CASE 
                           WHEN name LIKE ? THEN 1
                           WHEN name LIKE ? THEN 2
                           WHEN name LIKE ? THEN 3
                           ELSE 4
                       END AS relevance
                FROM ${tbl} 
                WHERE name LIKE ? ESCAPE '|'
                   OR name LIKE ? ESCAPE '|'
                   OR name LIKE ? ESCAPE '|'
                ORDER BY type DESC, relevance ASC, name ASC
                LIMIT 500
            `),

      search: this.db.prepare(`
                SELECT id, name, modified_date, type, parent_id, size_bytes
                FROM ${tbl} 
                WHERE name LIKE ? ESCAPE '|'
                ORDER BY name ASC
                LIMIT 500
            `),

      getChildren: this.db.prepare(`
                SELECT id, parent_id, name, size_bytes, modified_date, type, url
                FROM ${tbl} 
                WHERE parent_id = ?
                ORDER BY type DESC, name ASC
            `),

      getChildrenPaginated: this.db.prepare(`
                SELECT id, parent_id, name, size_bytes, modified_date, type, url
                FROM ${tbl} 
                WHERE parent_id = ?
                ORDER BY type DESC, name ASC
                LIMIT ? OFFSET ?
            `),

      getChildrenCount: this.db.prepare(`SELECT COUNT(*) FROM ${tbl} WHERE parent_id = ?`).pluck(),

      getNodeById: this.db.prepare(`SELECT id, parent_id, name, type FROM ${tbl} WHERE id = ?`),

      getNodeTitle: this.db.prepare(`SELECT name FROM ${tbl} WHERE id = ?`).pluck(),

      getNodeWithUrl: this.db.prepare(`SELECT url, name, size_bytes FROM ${tbl} WHERE id = ?`),

      getSuggestedTestFile: this.db.prepare(`
        SELECT id, url, name, size_bytes FROM ${tbl}
        WHERE (type = 'file' OR type = 'File')
          AND url IS NOT NULL AND url != ''
          AND size_bytes IS NOT NULL AND size_bytes >= 1024
        ORDER BY size_bytes ASC
        LIMIT 1
      `),

      getAncestors: this.db.prepare(`
                WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id, name, 0 as depth 
                    FROM ${tbl} 
                    WHERE id = (SELECT parent_id FROM ${tbl} WHERE id = ?)
                    UNION ALL
                    SELECT n.id, n.parent_id, n.name, a.depth + 1 as depth 
                    FROM ${tbl} n
                    INNER JOIN ancestors a ON a.parent_id = n.id
                )
                SELECT name FROM ancestors WHERE id != 1 ORDER BY depth DESC
            `),

      getAncestorsWithNode: this.db.prepare(`
                WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id, name, 0 AS depth
                    FROM ${tbl} WHERE id = ?
                    UNION ALL
                    SELECT e.id, e.parent_id, e.name, a.depth + 1
                    FROM ${tbl} e
                    INNER JOIN ancestors a ON e.id = a.parent_id
                )
                SELECT id, name FROM ancestors WHERE id != 1 ORDER BY depth DESC
            `),

      /** IDs de la carpeta y todos sus descendientes (para filtrar búsqueda por carpeta). */
      getDescendantIds: this.db
        .prepare(
          `WITH RECURSIVE subtree AS (
            SELECT id FROM ${tbl} WHERE id = ?
            UNION ALL
            SELECT e.id FROM ${tbl} e INNER JOIN subtree s ON e.parent_id = s.id
          )
          SELECT id FROM subtree`
        )
        .pluck(true),

      getLatestModifiedDate: this.db.prepare(`
                SELECT modified_date 
                FROM ${tbl} 
                WHERE parent_id = 1 
                AND type = 'folder'
                AND modified_date IS NOT NULL
                ORDER BY modified_date DESC 
                LIMIT 1
            `),

      getAllFilesRecursive: this.db.prepare(`
                WITH RECURSIVE folder_tree AS (
                    SELECT id, parent_id, name, type, url, size_bytes, modified_date
                    FROM ${tbl} 
                    WHERE id = ?
                    UNION ALL
                    SELECT n.id, n.parent_id, n.name, n.type, n.url, n.size_bytes, n.modified_date
                    FROM ${tbl} n
                    INNER JOIN folder_tree ft ON n.parent_id = ft.id
                )
                SELECT id, name, url, size_bytes, modified_date
                FROM folder_tree
                WHERE type = 'file'
                ORDER BY name ASC
                LIMIT ?
            `),
    } as unknown as DatabaseStatements;

    if (log.debug) log.debug('Statements SQL preparados');
  }

  _prepareFTSTerm(
    term: string,
    options: { usePrefix?: boolean; usePhrase?: boolean; useOR?: boolean } = {}
  ): string {
    const usePrefix = options.usePrefix !== false;
    const usePhrase = options.usePhrase === false ? false : options.usePhrase;
    const useOR = options.useOR === true;

    const cleanTerm = term.trim();
    if (!cleanTerm) return '';

    if (usePhrase || (cleanTerm.startsWith('"') && cleanTerm.endsWith('"'))) {
      const phrase = cleanTerm.replace(/^"|"$/g, '');
      const escaped = phrase.replace(/"/g, '""');
      return `"${escaped}"`;
    }

    const words = cleanTerm
      .split(/\s+/)
      .filter(w => w.length > 0)
      .map(w => {
        let escaped = w.replace(/["'*]/g, '');
        const upperWord = escaped.toUpperCase();
        if (['NOT', 'AND', 'OR'].includes(upperWord)) escaped = `"${escaped}"`;
        if (usePrefix && escaped.length > 0) return `${escaped}*`;
        return escaped;
      });

    if (words.length === 0) return '';
    if (words.length === 1) return words[0];
    return words.join(useOR ? ' OR ' : ' AND ');
  }

  _prepareLikeTerms(term: string): string[] {
    let cleanTerm = term
      .trim()
      .replace(/\*/g, '')
      .replace(/^["']|["']$/g, '')
      .replace(/\s+(AND|OR|NOT)\s+/gi, ' ')
      .trim();
    if (!cleanTerm) cleanTerm = term.trim();
    const escaped = escapeLikeTerm(cleanTerm);
    const words = cleanTerm.split(/\s+/).filter(w => w.length > 0);

    if (words.length === 1) {
      return [`${escaped}%`, `% ${escaped}%`, `%${escaped}%`];
    }
    const allWordsEscaped = words.map(w => escapeLikeTerm(w));
    const allWordsPattern = allWordsEscaped.join('%');
    return [`${allWordsPattern}%`, `%${allWordsPattern}%`, `%${escaped}%`];
  }

  _searchFTSSync(ftsTerm: string, limit = 500, offset = 0): unknown[] {
    const stmt =
      limit === 500 && offset === 0
        ? this.statements!.searchFTSNoPagination
        : this.statements!.searchFTS;
    if (!stmt || !('all' in stmt)) return [];
    if (limit === 500 && offset === 0) return stmt.all(ftsTerm);
    return stmt.all(ftsTerm, limit, offset);
  }

  _searchWithLike(term: string, limit = 500, offset = 0): unknown[] {
    const patterns = this._prepareLikeTerms(term);
    const stmt =
      limit === 500 && offset === 0
        ? this.statements!.searchLikeNoPagination
        : this.statements!.searchLike;
    if (!stmt || !('all' in stmt)) return [];
    if (limit === 500 && offset === 0) {
      return stmt.all(patterns[0], patterns[1], patterns[2], patterns[0], patterns[1], patterns[2]);
    }
    return stmt.all(
      patterns[0],
      patterns[1],
      patterns[2],
      patterns[0],
      patterns[1],
      patterns[2],
      limit,
      offset
    );
  }

  _searchFTSSyncByType(ftsTerm: string, type: string, limit = 250, offset = 0): unknown[] {
    const stmt = this.statements!.searchFTSByType;
    if (!stmt || !('all' in stmt)) return [];
    return stmt.all(ftsTerm, type, limit, offset);
  }

  _searchWithLikeByType(term: string, type: string, limit = 250, offset = 0): unknown[] {
    const patterns = this._prepareLikeTerms(term);
    const stmt = this.statements!.searchLikeByType;
    if (!stmt || !('all' in stmt)) return [];
    return stmt.all(
      patterns[0],
      patterns[1],
      patterns[2],
      patterns[0],
      patterns[1],
      patterns[2],
      type,
      limit,
      offset
    );
  }

  /**
   * Búsqueda por término: FTS si está disponible (con opción de worker), fallback a LIKE.
   * Respeta signal para cancelación, timeout de config y folderLimit para reparto carpeta/archivo.
   *
   * @returns SearchResult con data normalizada, total, hasMore; cancelled si se abortó; timeout/error en fallo.
   */
  async search(searchTerm: string, options: SearchOptions = {}): Promise<SearchResult> {
    if (!this.db) return { success: false, error: 'Base de datos no disponible' };

    if (!searchTerm || searchTerm.trim().length < 2) {
      return { success: true, data: [], total: 0 };
    }

    const cleanSearchTerm = searchTerm.trim();
    const maxSearchTermLength =
      (config.database as { maxSearchTermLength?: number } | undefined)?.maxSearchTermLength ??
      MAX_SEARCH_TERM_LENGTH;
    if (cleanSearchTerm.length > maxSearchTermLength) {
      return { success: false, error: 'Término de búsqueda demasiado largo' };
    }

    const {
      limit = 500,
      offset = 0,
      usePrefix = true,
      usePhrase = false,
      useOR = false,
      folderLimit: requestedFolderLimit = 0,
      signal: abortSignal = null,
      includeTotalCount = false,
      scopeFolderId = null,
      scopeFolderIds = null,
    } = options;

    const folderLimit =
      typeof requestedFolderLimit === 'number' &&
      requestedFolderLimit > 0 &&
      requestedFolderLimit < limit
        ? Math.min(requestedFolderLimit, limit)
        : 0;

    const searchTimeoutMs =
      (config.database as { searchTimeoutMs?: number } | undefined)?.searchTimeoutMs ?? 10000;
    const workerSearchTimeoutMs =
      (config.database as { workerSearchTimeoutMs?: number } | undefined)?.workerSearchTimeoutMs ??
      15000;

    const doSearch = async (): Promise<SearchResult> => {
      let results: unknown[];
      let total: number;
      let ftsTermForCount: string | null = null;

      if (folderLimit > 0 && this.statements!.searchFTSByType) {
        const ftsTerm = this._prepareFTSTerm(cleanSearchTerm, { usePrefix, usePhrase, useOR });
        const folders =
          this.useFTS && this.statements!.searchFTSByType
            ? this._searchFTSSyncByType(ftsTerm, 'folder', folderLimit, 0)
            : this._searchWithLikeByType(cleanSearchTerm, 'folder', folderLimit, 0);
        const filesLimit = Math.max(0, limit - folders.length);
        const files =
          this.useFTS && this.statements!.searchFTSByType
            ? this._searchFTSSyncByType(ftsTerm, 'file', filesLimit, 0)
            : this._searchWithLikeByType(cleanSearchTerm, 'file', filesLimit, 0);
        results = [...folders, ...files];
        total = results.length;
      } else if (folderLimit > 0) {
        const folders = this._searchWithLikeByType(cleanSearchTerm, 'folder', folderLimit, 0);
        const filesLimit = Math.max(0, limit - folders.length);
        const files = this._searchWithLikeByType(cleanSearchTerm, 'file', filesLimit, 0);
        results = [...folders, ...files];
        total = results.length;
      } else if (this.useFTS && this.statements!.searchFTS) {
        const ftsTerm = this._prepareFTSTerm(cleanSearchTerm, { usePrefix, usePhrase, useOR });
        ftsTermForCount = ftsTerm;

        try {
          const shouldUseWorker =
            this.useWorkerForFTS &&
            limit >= this.workerFTSThreshold &&
            this.workerManager.isInitialized;

          if (shouldUseWorker) {
            try {
              const workerResult = await withTimeout(
                this.workerManager.searchFTS(
                  ftsTerm,
                  { limit, offset },
                  this.ftsTable!,
                  this.ftsType!
                ),
                workerSearchTimeoutMs,
                'Búsqueda FTS en worker'
              );
              if (workerResult.success) {
                results = Array.isArray(workerResult.data) ? workerResult.data : [];
                total = (
                  typeof workerResult.total === 'number' ? workerResult.total : results.length
                ) as number;
              } else {
                throw new Error(workerResult.error ?? 'Error desconocido en worker');
              }
            } catch (workerError) {
              const err = workerError as Error;
              if (err.message.includes('tiempo límite')) throw workerError;
              const isTimeout =
                err.message.includes('Timeout') || err.message.includes('tiempo límite');
              const isWorkerDead =
                !isTimeout &&
                (err.message.includes('Worker thread terminado') ||
                  err.message.includes('Worker no está inicializado') ||
                  err.message.includes('Worker error:'));
              if (isWorkerDead) {
                log.warn(
                  'Worker no disponible, usando fallback síncrono (solo en crash):',
                  err.message
                );
                results = this._searchFTSSync(ftsTerm, limit, offset);
                total = results.length;
              } else {
                throw workerError;
              }
            }
          } else {
            results = this._searchFTSSync(ftsTerm, limit, offset);
            total = results.length;
          }
        } catch (ftsError) {
          const err = ftsError as Error;
          if (err.message.includes('tiempo límite')) throw ftsError;
          log.warn('Error en búsqueda FTS, usando fallback LIKE:', err.message);
          results = this._searchWithLike(cleanSearchTerm, limit, offset);
          total = results.length;
        }
      } else {
        results = this._searchWithLike(cleanSearchTerm, limit, offset);
        total = results.length;
      }

      const ids = (results as Array<{ id: number }>).map(r => r.id);
      const pathsMap = this._getPathsFromElementPaths(ids);
      const usePaths = pathsMap !== null && ids.every(id => pathsMap.has(id));
      const nodeMap = usePaths ? null : this._batchBuildAncestorMap(ids);

      const normalized = (results as NodeInfo[]).map(item => {
        const norm = usePaths
          ? (normalizeNodeWithPathsMap(
              item as NodeInfo & { size_bytes?: number },
              pathsMap.get(item.id)! // usePaths garantiza que existe
            ) as NodeInfo)
          : (normalizeNodeWithAncestorMap(
              item as NodeInfo & { size_bytes?: number },
              nodeMap!
            ) as NodeInfo);
        if (!norm.title && norm.name) norm.title = norm.name;
        if (norm.size_bytes !== undefined && norm.size === undefined) {
          norm.size = formatSize(norm.size_bytes);
        }
        return norm;
      });

      if (
        includeTotalCount &&
        ftsTermForCount &&
        this.statements!.searchFTSCount &&
        'get' in this.statements!.searchFTSCount
      ) {
        try {
          total = (this.statements!.searchFTSCount.get(ftsTermForCount) as number) ?? total;
        } catch (ftsCountErr) {
          log.debug?.('Error obteniendo total FTS:', (ftsCountErr as Error)?.message);
        }
      }

      let finalData = normalized;
      let finalTotal = total;
      const getDescendantIdsStmt = this.statements!.getDescendantIds as {
        all(_id: number): number[];
      } | null;
      if (scopeFolderIds?.length && getDescendantIdsStmt) {
        const allowedIds = new Set<number>();
        for (const folderId of scopeFolderIds) {
          const ids = getDescendantIdsStmt.all(folderId);
          ids.forEach((id: number) => allowedIds.add(id));
        }
        finalData = normalized.filter((n: NodeInfo) => allowedIds.has(n.id));
        finalTotal = finalData.length;
      } else if (scopeFolderId != null && getDescendantIdsStmt) {
        const allowedIds = new Set(getDescendantIdsStmt.all(scopeFolderId));
        finalData = normalized.filter((n: NodeInfo) => allowedIds.has(n.id));
        finalTotal = finalData.length;
      }

      const hasMore = includeTotalCount
        ? offset + finalData.length < finalTotal
        : finalTotal === limit;

      return {
        success: true,
        data: finalData,
        total: finalTotal,
        limit,
        offset,
        hasMore,
      };
    };

    try {
      return await withTimeout(doSearch(), searchTimeoutMs, 'Búsqueda', abortSignal);
    } catch (error) {
      const err = error as Error & { name?: string };
      if (err.name === 'AbortError') {
        if (log.debug) log.debug('Búsqueda cancelada por el usuario');
        return { success: true, data: [], total: 0, cancelled: true };
      }
      if (err.message.includes('tiempo límite')) {
        log.warn('Timeout en búsqueda:', err.message);
        return {
          success: false,
          error: 'La búsqueda tardó demasiado. Intenta con un término más específico.',
          timeout: true,
          data: [],
        };
      }
      log.error('Error en la búsqueda:', error);
      return { success: false, error: err.message, data: [] };
    }
  }

  _getFromNavCache(key: string): unknown {
    const entry = this._navCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this._navCacheTTL) {
      this._navCache.delete(key);
      return null;
    }
    return entry.value;
  }

  _evictNavCacheIfNeeded(): void {
    const now = Date.now();
    for (const [k, entry] of this._navCache.entries()) {
      if (now - entry.ts > this._navCacheTTL) this._navCache.delete(k);
    }
    while (this._navCache.size >= this._navCacheMaxSize) {
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [k, entry] of this._navCache.entries()) {
        if (entry.ts < oldestTs) {
          oldestTs = entry.ts;
          oldestKey = k;
        }
      }
      if (oldestKey != null) this._navCache.delete(oldestKey);
    }
  }

  _setNavCache(key: string, value: unknown): void {
    this._evictNavCacheIfNeeded();
    this._navCache.set(key, { value, ts: Date.now() });
  }

  /** Obtiene los hijos del nodo con paginación y caché de navegación (TTL y límite de tamaño). */
  getChildren(parentId: number, options: GetChildrenOptions = {}): GetChildrenResult {
    if (!this.db || !this.statements) {
      return { success: false, error: 'Base de datos no disponible' };
    }

    const defaultLimit =
      (config.database as { defaultChildrenLimit?: number } | undefined)?.defaultChildrenLimit ??
      2000;
    const requestedLimit = options.limit != null ? Number(options.limit) : null;
    const limit =
      requestedLimit != null && !isNaN(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 10000)
        : defaultLimit;
    const offset = options.offset != null ? Math.max(0, Number(options.offset) || 0) : 0;
    const cacheKey = `c:${parentId}:${limit}:${offset}`;
    const cached = this._getFromNavCache(cacheKey) as GetChildrenResult | null;
    if (cached) {
      if (log.debug)
        log.debug(`Hijos de nodo ${parentId}: cache hit (${cached.data?.length ?? 0} items)`);
      return cached;
    }

    try {
      const getCount = this.statements.getChildrenCount;
      const total =
        ((getCount && 'get' in getCount ? getCount.get(parentId) : null) as number | undefined) ??
        0;

      let results: unknown[];
      if (
        limit > 0 &&
        this.statements.getChildrenPaginated &&
        'all' in this.statements.getChildrenPaginated
      ) {
        results = this.statements.getChildrenPaginated.all(parentId, limit, offset);
      } else if (this.statements.getChildren && 'all' in this.statements.getChildren) {
        results = this.statements.getChildren.all(parentId);
      } else {
        results = [];
      }

      const normalized = (
        results as Array<{ name?: string; size_bytes?: number; type?: string }>
      ).map(item => ({
        ...item,
        title: (item.name ?? '').replace(/\/$/, ''),
        name: (item.name ?? '').replace(/\/$/, ''),
        size: formatSize(item.size_bytes),
        type: normalizeType(item.type),
      }));

      const response: GetChildrenResult = { success: true, data: normalized as NodeInfo[], total };
      this._setNavCache(cacheKey, response);
      return response;
    } catch (error) {
      log.error('Error al obtener hijos:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /** Obtiene los ancestros del nodo (ruta desde la raíz) con caché de navegación. */
  getAncestors(nodeId: number): {
    success: boolean;
    data?: Array<{ id: number; title: string; name: string }>;
    error?: string;
  } {
    if (!this.db || !this.statements) {
      return { success: false, error: 'Base de datos no disponible' };
    }

    const cacheKey = `a:${nodeId}`;
    const cached = this._getFromNavCache(cacheKey) as {
      success: boolean;
      data: Array<{ id: number; title: string; name: string }>;
    } | null;
    if (cached) {
      if (log.debug) log.debug(`Ancestros de nodo ${nodeId}: cache hit`);
      return cached;
    }

    try {
      const stmt = this.statements.getAncestorsWithNode;
      if (!stmt || !('all' in stmt)) return { success: false, error: 'Nodo no encontrado' };
      const rows = stmt.all(nodeId) as Array<{ id: number; name: string | null }>;
      if (rows.length === 0) return { success: false, error: 'Nodo no encontrado' };

      const data = rows.map(row => {
        const name = (row.name ?? '').replace(/\/$/, '');
        return { id: row.id, title: name, name };
      });
      const response = { success: true, data };
      this._setNavCache(cacheKey, response);
      return response;
    } catch (error) {
      log.error('Error al obtener ancestros:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /** Devuelve los datos básicos del nodo (id, parent_id, name, type) o error si no existe. */
  getNodeInfo(nodeId: number): { success: boolean; data?: unknown; error?: string } {
    if (!this.db || !this.statements) {
      return { success: false, error: 'Base de datos no disponible' };
    }
    try {
      const getNode = this.statements.getNodeById;
      const node = getNode && 'get' in getNode ? getNode.get(nodeId) : null;
      if (!node) return { success: false, error: 'Nodo no encontrado' };
      return { success: true, data: node };
    } catch (error) {
      log.error('Error al obtener info del nodo:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /** Devuelve URL, nombre y tamaño de un nodo archivo para iniciar una descarga; null si no existe o no tiene URL. */
  getFileDownloadInfo(nodeId: number): { url: string; name: string; size_bytes: number } | null {
    if (!this.db || !this.statements) return null;
    try {
      const stmt = this.statements.getNodeWithUrl;
      return (stmt && 'get' in stmt ? stmt.get(nodeId) : null) as {
        url: string;
        name: string;
        size_bytes: number;
      } | null;
    } catch (error) {
      log.error('Error al obtener info de descarga:', error);
      return null;
    }
  }

  /** Un archivo pequeño (≥1 KB) del catálogo para usarlo en el test de conexión (configuración). */
  getSuggestedTestFile(): { id: number; url: string; name: string; size_bytes: number } | null {
    if (!this.db || !this.statements) return null;
    try {
      const stmt = this.statements.getSuggestedTestFile;
      const row = stmt && 'get' in stmt ? stmt.get() : null;
      return row
        ? {
            id: (row as { id: number }).id,
            url: (row as { url: string }).url,
            name: (row as { name: string }).name,
            size_bytes: (row as { size_bytes: number }).size_bytes,
          }
        : null;
    } catch (error) {
      log.error('Error al obtener archivo de prueba:', error);
      return null;
    }
  }

  /** Nombres de ancestros del nodo (para construir ruta relativa al guardar archivo). */
  getFileAncestorPath(nodeId: number): Array<{ name: string }> {
    if (!this.db || !this.statements) return [];
    try {
      const stmt = this.statements.getAncestors;
      return (stmt && 'all' in stmt ? stmt.all(nodeId) : []) as Array<{ name: string }>;
    } catch (error) {
      log.error('Error al obtener ruta de ancestros:', error);
      return [];
    }
  }

  /** Lista recursiva de todos los archivos de una carpeta; usa worker si está inicializado para no bloquear el main. */
  async getAllFilesInFolder(
    folderId: number
  ): Promise<{ success: boolean; data?: NodeInfo[]; error?: string }> {
    if (!this.db || !this.statements) {
      return { success: false, error: 'Base de datos no disponible' };
    }
    try {
      const getNode = this.statements.getNodeById;
      const node = getNode && 'get' in getNode ? getNode.get(folderId) : null;
      if (!node) return { success: false, error: 'Carpeta no encontrada' };
      if (normalizeType((node as { type?: string }).type) !== 'folder') {
        return { success: false, error: 'El nodo especificado no es una carpeta' };
      }

      if (this.workerManager.isInitialized) {
        try {
          const workerResult = await this.workerManager.getAllFilesInFolder(folderId);
          if (workerResult.success) {
            const list = Array.isArray(workerResult.data) ? workerResult.data : [];
            return {
              success: true,
              data: list.map((file: unknown) => {
                const f = file as {
                  id: number;
                  name?: string;
                  url?: string;
                  size_bytes?: number;
                  modified_date?: number;
                };
                return {
                  id: f.id,
                  title: (f.name ?? '').replace(/\/$/, ''),
                  name: (f.name ?? '').replace(/\/$/, ''),
                  url: f.url,
                  size: formatSize(f.size_bytes),
                  size_bytes: f.size_bytes,
                  modified_date: f.modified_date,
                };
              }),
            };
          }
          throw new Error(workerResult.error ?? 'Error desconocido en worker');
        } catch (workerError) {
          log.warn(
            'Error en worker para getAllFilesInFolder, usando modo síncrono:',
            (workerError as Error).message
          );
        }
      }

      const maxFilesLimit =
        (config.downloads as { maxFilesPerFolder?: number } | undefined)?.maxFilesPerFolder ?? 1000;
      const stmt = this.statements.getAllFilesRecursive;
      const files = (stmt && 'all' in stmt ? stmt.all(folderId, maxFilesLimit) : []) as Array<{
        id: number;
        name?: string;
        url?: string;
        size_bytes?: number;
        modified_date?: number;
      }>;

      return {
        success: true,
        data: files.map(file => ({
          id: file.id,
          title: (file.name ?? '').replace(/\/$/, ''),
          name: (file.name ?? '').replace(/\/$/, ''),
          url: file.url,
          size: formatSize(file.size_bytes),
          size_bytes: file.size_bytes,
          modified_date: file.modified_date,
        })),
      };
    } catch (error) {
      log.error('Error al obtener archivos de carpeta:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /** Fecha de actualización del catálogo (modified_date del nodo raíz de carpetas) para mostrar en la UI. */
  getUpdateDate(): { success: boolean; data?: string | null; error?: string } {
    if (!this.db || !this.statements) {
      return { success: false, error: 'Base de datos no disponible' };
    }
    try {
      const stmt = this.statements.getLatestModifiedDate;
      const result = (stmt && 'get' in stmt ? stmt.get() : null) as
        | { modified_date?: string | number }
        | undefined;
      return {
        success: true,
        data: result?.modified_date != null ? String(result.modified_date) : null,
      };
    } catch (error) {
      log.error('Error al obtener fecha de actualización:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  /** Cierra la conexión, libera statements y vacía la cache de navegación. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.statements = null;
      this._navCache.clear();
      this._currentSource = null;
      this._tableName = 'elements';
      log.info('Conexión a base de datos cerrada');
    }
  }

  /**
   * Construye un mapa de ancestros resolviendo parent_id recursivamente.
   * Usa JSON_EACH para evitar queries dinámicas con IN(...) y permitir caché de statements.
   */
  _batchBuildAncestorMap(ids: number[]): Map<number, { parent_id: number | null; name: string }> {
    const nodeMap = new Map<number, { parent_id: number | null; name: string }>();
    let toFetch = new Set(ids.filter(id => id != null && typeof id === 'number'));
    const MAX_ITERATIONS = 20;

    // Prepared statement reutilizable con JSON_EACH (SQLite >= 3.38)
    const stmt = this.db!.prepare(
      `SELECT id, parent_id, name FROM ${this._tableName} WHERE id IN (SELECT value FROM json_each(?))`
    );

    for (let iter = 0; iter < MAX_ITERATIONS && toFetch.size > 0; iter++) {
      const idsBatch = Array.from(toFetch);
      const jsonIds = JSON.stringify(idsBatch);
      const rows = stmt.all(jsonIds) as Array<{
        id: number;
        parent_id: number | null;
        name: string | null;
      }>;

      toFetch = new Set<number>();
      for (const row of rows) {
        nodeMap.set(row.id, {
          parent_id: row.parent_id,
          name: (row.name ?? '').replace(/\/$/, ''),
        });
        if (row.parent_id && row.parent_id !== 1 && !nodeMap.has(row.parent_id)) {
          toFetch.add(row.parent_id);
        }
      }
    }
    return nodeMap;
  }

  /**
   * Obtiene rutas pre-calculadas de element_paths.
   * Dispara lazy population si es la primera vez.
   * Usa JSON_EACH para evitar queries dinámicas con IN(...).
   */
  _getPathsFromElementPaths(
    ids: number[]
  ): Map<number, { full_path: string; parent_path: string }> | null {
    if (!this.db || !ids.length) return null;
    try {
      const count =
        (this.db.prepare('SELECT COUNT(*) as c FROM element_paths').get() as { c?: number })?.c ??
        0;
      if (count === 0) return null;
      const jsonIds = JSON.stringify(ids);
      const stmt = this.db.prepare(
        'SELECT id, full_path, parent_path FROM element_paths WHERE id IN (SELECT value FROM json_each(?))'
      );
      const rows = stmt.all(jsonIds) as Array<{
        id: number;
        full_path: string | null;
        parent_path: string | null;
      }>;
      const map = new Map<number, { full_path: string; parent_path: string }>();
      for (const row of rows) {
        map.set(row.id, { full_path: row.full_path ?? '', parent_path: row.parent_path ?? '' });
      }
      return map;
    } catch (pathsErr) {
      log.debug?.('Error obteniendo rutas de element_paths:', (pathsErr as Error)?.message);
      return null;
    }
  }

  _showError(title: string, message: string): void {
    log.error(`${title}: ${message}`);
    dialog.showErrorBox(title, message);
    app.quit();
  }
}

const database = new DatabaseService();
export default database;
