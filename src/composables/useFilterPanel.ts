/**
 * @fileoverview Composable que conecta resultados de búsqueda con filtros avanzados.
 * @module useFilterPanel
 *
 * Aplica los filtros de useFilters a searchFolders/searchFiles de useSearch y expone
 * los resultados filtrados para la vista de búsqueda y el FiltersPanel.
 */

import { ref, computed, watch } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import type { FilterableItem, AdvancedFiltersState } from './useFilters';

export interface UseFilterPanelOptions {
  searchFolders: ComputedRef<FilterableItem[]>;
  searchFiles: ComputedRef<FilterableItem[]>;
  searchResults: Ref<{ id?: number; title?: string; type?: string; [key: string]: unknown }[]>;
  applyFilters: (_items: FilterableItem[]) => FilterableItem[];
  hasActiveFilters: ComputedRef<boolean>;
  advancedFilters: Ref<AdvancedFiltersState>;
}

export interface UseFilterPanelReturn {
  /** Fuente para FiltersPanel (resultados como FilterableItem[]) */
  filterPanelSourceAsFilterable: ComputedRef<FilterableItem[]>;
  /** Carpetas de búsqueda tras aplicar filtros */
  filteredSearchFolders: ComputedRef<FilterableItem[]>;
  /** Archivos de búsqueda tras aplicar filtros */
  filteredSearchFiles: ComputedRef<FilterableItem[]>;
  /** true si hay resultados pero los filtros ocultan todos */
  searchHadResultsButFiltersHideAll: ComputedRef<boolean>;
}

/**
 * Conecta búsqueda y filtros: aplica applyFilters a searchFolders/searchFiles
 * y mantiene resultados filtrados actualizados.
 */
export function useFilterPanel(options: UseFilterPanelOptions): UseFilterPanelReturn {
  const {
    searchFolders,
    searchFiles,
    searchResults,
    applyFilters,
    hasActiveFilters,
    advancedFilters,
  } = options;

  const filteredSearchFoldersRef = ref<FilterableItem[]>([]);
  const filteredSearchFilesRef = ref<FilterableItem[]>([]);

  function updateFilteredSearchResults(): void {
    filteredSearchFoldersRef.value = applyFilters(searchFolders.value);
    filteredSearchFilesRef.value = applyFilters(searchFiles.value);
  }

  watch([searchFolders, searchFiles, advancedFilters], updateFilteredSearchResults, {
    deep: true,
    immediate: true,
  });

  const filterPanelSourceAsFilterable = computed(() => searchResults.value as FilterableItem[]);

  const filteredSearchFolders = computed(() => filteredSearchFoldersRef.value);
  const filteredSearchFiles = computed(() => filteredSearchFilesRef.value);

  const searchHadResultsButFiltersHideAll = computed(
    () =>
      searchResults.value.length > 0 &&
      hasActiveFilters.value &&
      filteredSearchFolders.value.length === 0 &&
      filteredSearchFiles.value.length === 0
  );

  return {
    filterPanelSourceAsFilterable,
    filteredSearchFolders,
    filteredSearchFiles,
    searchHadResultsButFiltersHideAll,
  };
}
