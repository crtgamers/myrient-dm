/**
 * Lógica de negocio para búsquedas en el catálogo: validación, normalización, caché y paginación.
 *
 * validateAndNormalizeSearchTerm, normalizeSearchTerm, normalizeSearchOptions; prepareFTSTerm,
 * determineSearchStrategy; calculatePagination; caché en memoria por clave (término + opciones)
 * con TTL y límite de tamaño (LFU al llenar); recordSearchMetrics, getSearchMetrics.
 * El handler IPC search-db usa este servicio cuando está inicializado para cache y opciones normalizadas.
 *
 * @module SearchService
 */

import BaseService, { ServiceResponse } from './BaseService';
import { validateSearchTerm } from '../utils';
import { MAX_SEARCH_TERM_LENGTH } from '../constants/validations';
import type { SearchOptions } from '../../shared/types/search';

export type { SearchOptions } from '../../shared/types/search';

export interface PaginationInfo {
  total: number;
  limit: number;
  offset: number;
  currentPage: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
  nextOffset?: number | null;
  previousOffset?: number | null;
}

export interface CacheEntry<T = unknown> {
  result: T;
  timestamp: number;
  lastAccess: number;
  accessCount?: number;
}

export interface NormalizedSearchOptions {
  limit: number;
  offset: number;
  folderLimit: number;
  usePrefix: boolean;
  usePhrase: boolean;
  useOR: boolean;
  includeTotalCount: boolean;
  scopeFolderId?: number;
  scopeFolderIds?: number[];
}

interface SearchMetricsItem {
  durationMs?: number;
  cacheHit?: boolean;
  resultCount?: number;
  total?: number;
  timestamp?: number;
}

interface CacheEntryInternal {
  result: Record<string, unknown>;
  timestamp: number;
  lastAccess: number;
  accessCount?: number;
}

export default class SearchService extends BaseService {
  cache: Map<string, CacheEntryInternal>;
  cacheMaxSize: number;
  cacheTTL: number;
  private _cacheHits: number;
  private _cacheMisses: number;
  private _searchMetrics: SearchMetricsItem[];
  private _searchMetricsMaxSize: number;

  constructor() {
    super('SearchService');
    this.cache = new Map();
    this.cacheMaxSize = 100;
    this.cacheTTL = 5 * 60 * 1000;
    this._cacheHits = 0;
    this._cacheMisses = 0;
    this._searchMetrics = [];
    this._searchMetricsMaxSize = 50;
  }

  /** Valida el término con validateSearchTerm y lo normaliza (trim, longitud máxima). */
  validateAndNormalizeSearchTerm(
    searchTerm: string
  ):
    | { valid: true; data: string; original: string }
    | { valid: false; error?: string }
    | ServiceResponse {
    try {
      const validation = validateSearchTerm(searchTerm);
      if (!validation.valid) {
        return { valid: false, error: validation.error };
      }
      const normalized = this.normalizeSearchTerm(validation.data!);
      return { valid: true, data: normalized, original: searchTerm };
    } catch (error) {
      return this.handleError(error as Error & { code?: string }, 'validateAndNormalizeSearchTerm');
    }
  }

  normalizeSearchTerm(term: string | null | undefined): string {
    try {
      if (!term || typeof term !== 'string') return '';
      let normalized = term.trim().replace(/\s+/g, ' ');
      if (normalized.length > MAX_SEARCH_TERM_LENGTH) {
        normalized = normalized.substring(0, MAX_SEARCH_TERM_LENGTH).trim();
      }
      return normalized;
    } catch (error) {
      this.log.warn('Error normalizando término de búsqueda:', (error as Error).message);
      return term ?? '';
    }
  }

  /** Ajusta limit/offset/folderLimit y flags usePrefix, usePhrase, useOR, includeTotalCount dentro de rangos válidos. */
  normalizeSearchOptions(options: SearchOptions = {}): NormalizedSearchOptions {
    try {
      let limit = typeof options.limit === 'number' ? options.limit : 500;
      if (isNaN(limit) || limit < 1) limit = 500;
      limit = Math.min(Math.max(limit, 1), 1000);

      let offset = typeof options.offset === 'number' ? options.offset : 0;
      if (isNaN(offset) || offset < 0) offset = 0;
      offset = Math.max(offset, 0);

      let folderLimit = typeof options.folderLimit === 'number' ? options.folderLimit : 0;
      if (isNaN(folderLimit) || folderLimit < 0) folderLimit = 0;
      folderLimit = Math.min(folderLimit, limit - 1);

      const usePrefix = options.usePrefix !== false;
      const usePhrase = options.usePhrase === true;
      const useOR = options.useOR === true;
      const includeTotalCount = options.includeTotalCount === true;
      const scopeFolderId =
        typeof options.scopeFolderId === 'number' && options.scopeFolderId > 0
          ? options.scopeFolderId
          : undefined;
      const scopeFolderIdsRaw = options.scopeFolderIds;
      const scopeFolderIds =
        Array.isArray(scopeFolderIdsRaw) && scopeFolderIdsRaw.length > 0
          ? scopeFolderIdsRaw.filter((id): id is number => typeof id === 'number' && id > 0)
          : undefined;

      return {
        limit,
        offset,
        folderLimit,
        usePrefix,
        usePhrase,
        useOR,
        includeTotalCount,
        scopeFolderId,
        scopeFolderIds: scopeFolderIds?.length ? scopeFolderIds : undefined,
      };
    } catch (error) {
      this.log.warn(
        'Error normalizando opciones de búsqueda, usando defaults:',
        (error as Error).message
      );
      return {
        limit: 500,
        offset: 0,
        folderLimit: 0,
        usePrefix: true,
        usePhrase: false,
        useOR: false,
        includeTotalCount: false,
      };
    }
  }

  determineSearchStrategy(searchTerm: string, options: SearchOptions = {}): 'fts' | 'like' {
    try {
      if (searchTerm.length < 2) return 'like';
      if (options.usePhrase) return 'fts';
      if (options.useOR) return 'fts';
      return 'fts';
    } catch (error) {
      this.log.warn(
        'Error determinando estrategia de búsqueda, usando FTS:',
        (error as Error).message
      );
      return 'fts';
    }
  }

  prepareFTSTerm(term: string | null | undefined, options: SearchOptions = {}): string {
    try {
      if (!term || typeof term !== 'string') return '';
      const normalized = this.normalizeSearchTerm(term);
      if (options.usePhrase) {
        const escaped = normalized.replace(/"/g, '""');
        return `"${escaped}"`;
      }
      if (options.useOR) {
        const words = normalized.split(/\s+/).filter(w => w.length > 0);
        return words.join(' OR ');
      }
      if (options.usePrefix !== false) {
        const words = normalized.split(/\s+/).filter(w => w.length > 0);
        return words.map(w => `${w}*`).join(' ');
      }
      return normalized;
    } catch (error) {
      this.log.warn(
        'Error preparando término FTS, usando término original:',
        (error as Error).message
      );
      return term ?? '';
    }
  }

  /** Calcula totalPages, currentPage, hasNext/hasPrevious y nextOffset/previousOffset. */
  calculatePagination(total: number, limit: number, offset: number): PaginationInfo {
    try {
      const safeTotal = Math.max(0, total ?? 0);
      const safeLimit = Math.max(1, limit ?? 500);
      const safeOffset = Math.max(0, offset ?? 0);
      const totalPages = Math.ceil(safeTotal / safeLimit);
      const currentPage = Math.floor(safeOffset / safeLimit) + 1;
      const hasNext = safeOffset + safeLimit < safeTotal;
      const hasPrevious = safeOffset > 0;
      return {
        total: safeTotal,
        limit: safeLimit,
        offset: safeOffset,
        totalPages,
        currentPage,
        hasNext,
        hasPrevious,
        nextOffset: hasNext ? safeOffset + safeLimit : null,
        previousOffset: hasPrevious ? Math.max(0, safeOffset - safeLimit) : null,
      };
    } catch (error) {
      this.log.warn('Error calculando paginación:', (error as Error).message);
      return {
        total: 0,
        limit: limit || 500,
        offset: offset || 0,
        totalPages: 0,
        currentPage: 1,
        hasNext: false,
        hasPrevious: false,
        nextOffset: null,
        previousOffset: null,
      };
    }
  }

  recordSearchMetrics(metrics: SearchMetricsItem): void {
    try {
      this._searchMetrics.push({ ...metrics, timestamp: Date.now() });
      if (this._searchMetrics.length > this._searchMetricsMaxSize) {
        this._searchMetrics.shift();
      }
    } catch (e) {
      this.log.warn('Error registrando métricas:', (e as Error).message);
    }
  }

  getSearchMetrics(): {
    recent: SearchMetricsItem[];
    summary: {
      totalSearches: number;
      cacheHits: number;
      dbQueries: number;
      avgDurationMs: number;
      p95DurationMs: number;
      cacheHitRate: number;
    };
  } {
    const recent = [...this._searchMetrics];
    const cacheStats = this.getCacheStats();
    const fromDb = recent.filter(m => !m.cacheHit);
    const fromCache = recent.filter(m => m.cacheHit);
    return {
      recent,
      summary: {
        totalSearches: recent.length,
        cacheHits: fromCache.length,
        dbQueries: fromDb.length,
        avgDurationMs:
          fromDb.length > 0
            ? Math.round(fromDb.reduce((s, m) => s + (m.durationMs ?? 0), 0) / fromDb.length)
            : 0,
        p95DurationMs:
          fromDb.length > 0
            ? (() => {
                const sorted = [...fromDb].sort(
                  (a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0)
                );
                const idx = Math.floor(fromDb.length * 0.95);
                return Math.round(sorted[idx]?.durationMs ?? 0);
              })()
            : 0,
        cacheHitRate: cacheStats.hitRate,
      },
    };
  }

  getCacheKey(searchTerm: string, options: SearchOptions = {}): string {
    return this._generateCacheKey(searchTerm, options);
  }

  private _generateCacheKey(searchTerm: string, options: SearchOptions): string {
    try {
      const normalizedTerm = this.normalizeSearchTerm(searchTerm);
      const normalizedOptions = this.normalizeSearchOptions(options);
      const keyParts = [
        normalizedTerm.toLowerCase(),
        normalizedOptions.limit,
        normalizedOptions.offset,
        normalizedOptions.folderLimit ?? 0,
        normalizedOptions.usePrefix ? '1' : '0',
        normalizedOptions.usePhrase ? '1' : '0',
        normalizedOptions.useOR ? '1' : '0',
        normalizedOptions.includeTotalCount ? '1' : '0',
        normalizedOptions.scopeFolderId ?? '',
        Array.isArray(normalizedOptions.scopeFolderIds)
          ? normalizedOptions.scopeFolderIds.join(',')
          : '',
      ];
      return keyParts.join('|');
    } catch (error) {
      this.log.warn('Error generando clave de caché:', (error as Error).message);
      return `${searchTerm}|${JSON.stringify(options)}`;
    }
  }

  getFromCacheByKey(cacheKey: string): Record<string, unknown> | null {
    try {
      const entry = this.cache.get(cacheKey);
      if (!entry) {
        this._cacheMisses++;
        return null;
      }
      const now = Date.now();
      const age = now - entry.timestamp;
      if (age > this.cacheTTL) {
        this.cache.delete(cacheKey);
        this._cacheMisses++;
        if (this.log.debug) {
          this.log.debug(`Entrada de caché expirada eliminada (edad: ${Math.round(age / 1000)}s)`);
        }
        return null;
      }
      entry.lastAccess = now;
      entry.accessCount = (entry.accessCount ?? 0) + 1;
      this._cacheHits++;
      if (this.log.debug) {
        this.log.debug(
          `Resultado obtenido del caché (hits: ${entry.accessCount}, edad: ${Math.round(age / 1000)}s)`
        );
      }
      return entry.result;
    } catch (error) {
      this.log.warn('Error obteniendo del caché:', (error as Error).message);
      return null;
    }
  }

  getFromCache(searchTerm: string, options: SearchOptions = {}): Record<string, unknown> | null {
    const key = this.getCacheKey(searchTerm, options);
    return this.getFromCacheByKey(key);
  }

  setCacheByKey(cacheKey: string, result: Record<string, unknown>): void {
    try {
      if (!result || (result.success as boolean) === false) return;
      const now = Date.now();
      if (this.cache.has(cacheKey)) {
        const existing = this.cache.get(cacheKey)!;
        existing.result = { ...result };
        existing.timestamp = now;
        existing.lastAccess = now;
        return;
      }
      const entry: CacheEntryInternal = {
        result: { ...result },
        timestamp: now,
        lastAccess: now,
        accessCount: 0,
      };
      if (this.cache.size >= this.cacheMaxSize) {
        let minKey: string | null = null;
        let minScore = Infinity;
        for (const [k, e] of this.cache.entries()) {
          const score = (e.accessCount ?? 0) * 1e9 - (e.lastAccess ?? e.timestamp);
          if (score < minScore) {
            minScore = score;
            minKey = k;
          }
        }
        if (minKey) {
          this.cache.delete(minKey);
          if (this.log.debug) this.log.debug('Caché lleno (LFU), eliminada entrada menos usada');
        }
      }
      this.cache.set(cacheKey, entry);
      if (this.log.debug)
        this.log.debug(`Resultado guardado en caché (tamaño: ${this.cache.size})`);
    } catch (error) {
      this.log.warn('Error guardando en caché:', (error as Error).message);
    }
  }

  setCache(searchTerm: string, options: SearchOptions, result: Record<string, unknown>): void {
    const key = this.getCacheKey(searchTerm, options);
    this.setCacheByKey(key, result);
  }

  cleanExpiredCache(): number {
    try {
      const now = Date.now();
      let removedCount = 0;
      const keysToRemove: string[] = [];
      for (const [key, entry] of this.cache.entries()) {
        const age = now - entry.timestamp;
        if (age > this.cacheTTL) keysToRemove.push(key);
      }
      for (const key of keysToRemove) {
        this.cache.delete(key);
        removedCount++;
      }
      return removedCount;
    } catch (error) {
      this.log.warn('Error limpiando caché expirado:', (error as Error).message);
      return 0;
    }
  }

  clearCache(): number {
    try {
      const size = this.cache.size;
      this.cache.clear();
      this.log.info(`Caché limpiado: ${size} entradas eliminadas`);
      return size;
    } catch (error) {
      this.log.warn('Error limpiando caché:', (error as Error).message);
      return 0;
    }
  }

  getCacheStats(): {
    size: number;
    maxSize: number;
    ttl: number;
    expiredEntries: number;
    averageAge: number;
    hitRate: number;
    hits: number;
    misses: number;
  } {
    try {
      const now = Date.now();
      let expiredCount = 0;
      let totalAge = 0;
      for (const entry of this.cache.values()) {
        const age = now - entry.timestamp;
        totalAge += age;
        if (age > this.cacheTTL) expiredCount++;
      }
      const avgAge = this.cache.size > 0 ? totalAge / this.cache.size : 0;
      const total = (this._cacheHits || 0) + (this._cacheMisses || 0);
      const hitRate = total > 0 ? (this._cacheHits || 0) / total : 0;
      return {
        size: this.cache.size,
        maxSize: this.cacheMaxSize,
        ttl: this.cacheTTL,
        expiredEntries: expiredCount,
        averageAge: Math.round(avgAge),
        hitRate: Math.round(hitRate * 100) / 100,
        hits: this._cacheHits || 0,
        misses: this._cacheMisses || 0,
      };
    } catch (error) {
      this.log.warn('Error obteniendo estadísticas de caché:', (error as Error).message);
      return {
        size: 0,
        maxSize: this.cacheMaxSize,
        ttl: this.cacheTTL,
        expiredEntries: 0,
        averageAge: 0,
        hitRate: 0,
        hits: this._cacheHits || 0,
        misses: this._cacheMisses || 0,
      };
    }
  }
}
