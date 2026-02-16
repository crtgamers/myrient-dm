/**
 * @fileoverview useSearch - Composable para búsqueda en el catálogo
 * @module useSearch
 *
 * U2/C1: searchFiles memoizado por (searchResults, sortField, sortDirection); el ordenamiento
 * solo se ejecuta cuando cambian esos valores, no en cada acceso al computed.
 */

import { ref, computed, watch, nextTick } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import { search as apiSearch } from '../services/api';
import { useSettings } from './useSettings';
import logger from '../utils/logger';

export interface SearchResultItem {
  id: number;
  title: string;
  type: string;
  size?: number;
  url?: string;
  [key: string]: unknown;
}

function sortSearchFiles(
  files: SearchResultItem[],
  field: string,
  direction: 'asc' | 'desc'
): SearchResultItem[] {
  return [...files].sort((a, b) => {
    let aVal: unknown = a[field];
    let bVal: unknown = b[field];
    if (aVal === null || aVal === undefined) aVal = '';
    if (bVal === null || bVal === undefined) bVal = '';
    if (typeof aVal === 'string') {
      aVal = aVal.toLowerCase();
      bVal = String(bVal).toLowerCase();
    }
    const aCmp = aVal as string | number;
    const bCmp = bVal as string | number;
    let comparison = 0;
    if (aCmp < bCmp) comparison = -1;
    else if (aCmp > bCmp) comparison = 1;
    return direction === 'asc' ? comparison : -comparison;
  });
}

const searchTerm = ref('');
const searchResults = ref<SearchResultItem[]>([]);
const isSearching = ref(false);
const isSearchCancelled = ref(false);
const searchReturnedEmpty = ref(false);
const searchError = ref('');
const sortField = ref('title');
const sortDirection = ref<'asc' | 'desc'>('asc');

let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let currentSearchAbortController: { searchId: number } | null = null;
let currentSearchId = 0;
let watcherInitialized = false;
let executeSearchRef: ((_searchId: number) => Promise<void>) | null = null;

const searchLogger = logger.child('Search');

export interface UseSearchOptions {
  /** Si se proporciona, se invoca al buscar y su valor (id de carpeta o null) se envía como scopeFolderId para limitar resultados a esa carpeta y sus subcarpetas. */
  getScopeFolderId?: () => number | null;
  /** Si se proporciona, se invoca al buscar y su valor (ids de carpetas) se envía como scopeFolderIds para limitar resultados a esas carpetas y su contenido (ej. solo favoritos). Tiene prioridad sobre getScopeFolderId si devuelve array no vacío. */
  getScopeFolderIds?: () => number[] | null;
}

/**
 * Composable de búsqueda en el catálogo: término, resultados, ordenación y debounce.
 * @param options - Opcional: getScopeFolderId para activar "buscar en esta carpeta".
 * @returns Refs (searchTerm, searchResults, isSearching, searchError, …), computed (searchFolders, searchFiles, totalResults), search(), clearSearch(), executeSearch(), setSortField, cleanup.
 */
export function useSearch(options?: UseSearchOptions): {
  searchTerm: Ref<string>;
  searchResults: Ref<SearchResultItem[]>;
  isSearching: Ref<boolean>;
  isSearchCancelled: Ref<boolean>;
  searchReturnedEmpty: Ref<boolean>;
  searchError: Ref<string>;
  sortField: Ref<string>;
  sortDirection: Ref<'asc' | 'desc'>;
  hasSearchResults: ComputedRef<boolean>;
  searchFolders: ComputedRef<SearchResultItem[]>;
  searchFiles: ComputedRef<SearchResultItem[]>;
  totalResults: ComputedRef<number>;
  search: () => void;
  searchWithDebounce: () => void;
  executeSearch: (_searchId?: number | null) => Promise<void>;
  clearSearch: () => void;
  setSortField: (_field: string) => void;
  isSortedBy: (_field: string) => boolean;
  getSortIndicator: (_field: string) => string;
  cleanup: () => void;
} {
  const getScopeFolderId = options?.getScopeFolderId;
  const getScopeFolderIds = options?.getScopeFolderIds;
  const { searchLimit, searchDebounce } = useSettings();

  const hasSearchResults = computed(() => searchResults.value.length > 0);

  const searchFolders = computed(() => {
    return searchResults.value
      .filter(item => item.type === 'folder')
      .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  });

  /** Lista de archivos de búsqueda ordenada; actualizada solo cuando cambian resultados o criterios (U2/C1). */
  const sortedSearchFiles = ref<SearchResultItem[]>([]);

  const updateSortedSearchFiles = (): void => {
    const files = searchResults.value.filter(item => item.type === 'file');
    sortedSearchFiles.value = sortSearchFiles(files, sortField.value, sortDirection.value);
  };

  watch([searchResults, sortField, sortDirection], updateSortedSearchFiles, { immediate: true });

  const searchFiles = computed(() => sortedSearchFiles.value);

  const totalResults = computed(() => searchResults.value.length);

  const executeSearch = async (searchIdParam: number | null = null): Promise<void> => {
    const term = searchTerm.value.trim();
    if (term.length < 2) {
      searchResults.value = [];
      isSearching.value = false;
      isSearchCancelled.value = false;
      return;
    }

    const thisSearchId = searchIdParam !== null ? searchIdParam : ++currentSearchId;

    if (currentSearchAbortController) {
      isSearchCancelled.value = true;
    }
    currentSearchAbortController = { searchId: thisSearchId };
    isSearching.value = true;
    isSearchCancelled.value = false;

    await nextTick();
    await new Promise(r => setTimeout(r, 0));

    try {
      const limit = searchLimit.value;
      const folderLimit = Math.min(50, Math.max(1, Math.floor(limit / 2)));
      const scopeFolderIds = getScopeFolderIds?.() ?? undefined;
      const scopeFolderId = scopeFolderIds?.length
        ? undefined
        : (getScopeFolderId?.() ?? undefined);
      const response = await apiSearch(term, {
        limit,
        offset: 0,
        folderLimit,
        ...(scopeFolderIds?.length
          ? { scopeFolderIds }
          : scopeFolderId != null
            ? { scopeFolderId }
            : {}),
      });

      if (thisSearchId !== currentSearchId) {
        isSearchCancelled.value = true;
        return;
      }
      if (term !== searchTerm.value.trim()) {
        isSearchCancelled.value = true;
        return;
      }

      if (response.success) {
        searchError.value = '';
        const data = (response.data as SearchResultItem[]) ?? [];
        searchResults.value = data;
        searchReturnedEmpty.value = data.length === 0;
        const res = response as { total?: number };
        searchLogger.info('Resultados de búsqueda', {
          term,
          total: res.total ?? data.length,
          shown: data.length,
        });
        isSearchCancelled.value = false;
      } else {
        searchError.value = response.error ?? 'Error al conectar con la base de datos';
        searchResults.value = [];
        searchReturnedEmpty.value = true;
        isSearchCancelled.value = false;
      }
    } catch (error) {
      if (thisSearchId !== currentSearchId || term !== searchTerm.value.trim()) {
        isSearchCancelled.value = true;
        return;
      }
      searchError.value = (error as Error).message ?? 'Error desconocido';
      searchResults.value = [];
      searchReturnedEmpty.value = true;
      isSearchCancelled.value = false;
    } finally {
      if (thisSearchId === currentSearchId && term === searchTerm.value.trim()) {
        isSearching.value = false;
        if (currentSearchAbortController?.searchId === thisSearchId) {
          currentSearchAbortController = null;
        }
      } else {
        isSearchCancelled.value = true;
      }
    }
  };

  executeSearchRef = executeSearch;

  const searchWithDebounce = (): void => {
    if (searchTimeout) {
      clearTimeout(searchTimeout);
      searchTimeout = null;
    }
    if (currentSearchAbortController) {
      currentSearchAbortController = null;
      isSearchCancelled.value = true;
    }
    const delay = searchDebounce.value || 300;
    const searchId = ++currentSearchId;
    searchTimeout = setTimeout(() => {
      if (executeSearchRef) executeSearchRef(searchId);
      searchTimeout = null;
    }, delay);
  };

  const search = (): void => {
    if (searchTimeout) {
      clearTimeout(searchTimeout);
      searchTimeout = null;
    }
    if (currentSearchAbortController) {
      currentSearchAbortController = null;
      isSearchCancelled.value = true;
    }
    const searchId = ++currentSearchId;
    void executeSearch(searchId);
  };

  const clearSearch = (): void => {
    searchTerm.value = '';
    searchResults.value = [];
    searchReturnedEmpty.value = false;
    searchError.value = '';
    isSearchCancelled.value = false;
    if (searchTimeout) {
      clearTimeout(searchTimeout);
      searchTimeout = null;
    }
    if (currentSearchAbortController) {
      currentSearchAbortController = null;
    }
  };

  const setSortField = (field: string): void => {
    if (sortField.value === field) {
      sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
    } else {
      sortField.value = field;
      sortDirection.value = 'asc';
    }
  };

  const isSortedBy = (field: string): boolean => sortField.value === field;

  const getSortIndicator = (field: string): string => {
    if (sortField.value !== field) return '';
    return sortDirection.value === 'asc' ? '↑' : '↓';
  };

  if (!watcherInitialized) {
    watch(searchTerm, newTerm => {
      if (newTerm.trim().length < 2) {
        if (searchTimeout) {
          clearTimeout(searchTimeout);
          searchTimeout = null;
        }
        if (currentSearchAbortController) {
          currentSearchAbortController = null;
          isSearchCancelled.value = true;
        }
        searchResults.value = [];
        searchReturnedEmpty.value = false;
        searchError.value = '';
        isSearchCancelled.value = false;
      }
    });

    watch(searchLimit, (newLimit, oldLimit) => {
      if (searchTerm.value.trim().length < 2) return;
      if (isSearching.value) return;
      if (oldLimit === undefined) return;
      if (newLimit === oldLimit) return;
      const searchId = ++currentSearchId;
      if (executeSearchRef) void executeSearchRef(searchId);
    });

    watcherInitialized = true;
  }

  const cleanup = (): void => {
    if (searchTimeout) {
      clearTimeout(searchTimeout);
      searchTimeout = null;
    }
    if (currentSearchAbortController) {
      currentSearchAbortController = null;
    }
  };

  return {
    searchTerm,
    searchResults,
    isSearching,
    isSearchCancelled,
    searchReturnedEmpty,
    searchError,
    sortField,
    sortDirection,
    hasSearchResults,
    searchFolders,
    searchFiles,
    totalResults,
    search,
    searchWithDebounce,
    executeSearch,
    clearSearch,
    setSortField,
    isSortedBy,
    getSortIndicator,
    cleanup,
  };
}

export default useSearch;
