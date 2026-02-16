<template>
  <!-- Contenido de navegación (sin resultados de búsqueda activos) -->
  <ErrorBoundary
    v-if="showNavigation"
    key="explore"
    component-name="NavigationContent"
    :fallback-message="t('errors.loadContent')"
  >
    <div
      class="view-content fill-height"
      role="region"
      :aria-label="t('explore.navigationRegion')"
    >
      <FolderGrid
        v-if="folders.length > 0"
        :folders="folders"
        :title="foldersTitleComputed"
        :favorite-ids="favoriteIds"
        @navigate="$emit('navigate', $event)"
        @toggle-favorite="$emit('toggle-favorite', $event)"
      />
      <FileTable
        v-if="files.length > 0"
        :files="displayedFilesInExploreAsTable"
        :selected-files="selectedFiles"
        :all-selected="isAllFilesSelected"
        :downloads="downloadsForTable"
        :current-folder-id="currentNodeId ?? undefined"
        :is-at-root="isAtRoot"
        :has-active-filters="hasActiveFilters"
        :total-file-count="files.length"
        :active-filter-count="activeFilterCount"
        @download="$emit('download', $event)"
        @download-selected="$emit('download-selected')"
        @download-folder="$emit('download-folder')"
        @toggle-select="$emit('toggle-select', $event)"
        @toggle-select-all="$emit('toggle-select-all')"
      />
      <div
        v-if="hasMoreChildren && files.length > 0"
        class="load-more-section glass-effect"
      >
        <button
          type="button"
          class="load-more-btn"
          :disabled="loadingMoreChildren"
          @click="$emit('load-more')"
        >
          <span v-if="loadingMoreChildren">{{ t('explore.loading') }}</span>
          <span v-else>
            {{ t('explore.loadMore') }} ({{
              t('explore.loadMoreCount', {
                current: folders.length + files.length,
                total: totalChildrenCount,
              })
            }})
          </span>
        </button>
      </div>
      <div
        v-if="folders.length === 0 && files.length === 0"
        class="empty-state"
        role="status"
        aria-live="polite"
      >
        <p
          v-if="statusMessageKey"
          class="navigation-status-message"
        >
          {{ t(statusMessageKey, statusMessageParams) }}
        </p>
        <template v-else>
          <div
            class="empty-state-icon"
            aria-hidden="true"
          >
            <FolderOpen :size="48" />
          </div>
          <h3>{{ t('explore.emptyLocation') }}</h3>
          <p>{{ t('explore.emptyLocationHint') }}</p>
        </template>
      </div>
    </div>
  </ErrorBoundary>

  <!-- Resultados de búsqueda -->
  <ErrorBoundary
    v-else-if="showSearchResults"
    key="search"
    component-name="SearchResults"
    :fallback-message="t('errors.loadSearch')"
  >
    <div
      id="search-results"
      class="view-content fill-height"
      role="region"
      :aria-label="t('search.resultsTitle')"
    >
      <h2>{{ t('search.resultsTitle') }}</h2>
      <div
        v-if="!isSearching && (filteredSearchFolders.length > 0 || filteredSearchFiles.length > 0)"
        class="search-results-toggles"
        role="group"
        :aria-label="t('search.filterType')"
      >
        <button
          type="button"
          class="search-toggle-btn"
          :class="{ active: showSearchFolders }"
          :title="showSearchFolders ? t('search.hideFolders') : t('search.showFolders')"
          :aria-pressed="showSearchFolders"
          @click="$emit('update:show-search-folders', !showSearchFolders)"
        >
          <Folder :size="16" />
          <span>{{ t('search.folders') }}</span>
          <span class="search-toggle-count">({{ filteredSearchFolders.length }})</span>
        </button>
        <button
          type="button"
          class="search-toggle-btn"
          :class="{ active: showSearchFiles }"
          :title="showSearchFiles ? t('search.hideFiles') : t('search.showFiles')"
          :aria-pressed="showSearchFiles"
          @click="$emit('update:show-search-files', !showSearchFiles)"
        >
          <File :size="16" />
          <span>{{ t('search.files') }}</span>
          <span class="search-toggle-count">({{ filteredSearchFiles.length }})</span>
        </button>
      </div>
      <div
        v-if="isSearching"
        class="search-loading-skeletons"
      >
        <div class="skeleton-section">
          <div class="skeleton skeleton-title"></div>
          <SkeletonLoaders
            type="folder"
            :count="4"
          />
        </div>
        <div class="skeleton-section">
          <div class="skeleton skeleton-title"></div>
          <SkeletonLoaders
            type="table"
            :count="8"
          />
        </div>
      </div>
      <div
        v-if="!isSearching && isSearchCancelled && searchResultsLength === 0"
        class="search-cancelled"
        role="alert"
        aria-live="polite"
      >
        <div
          class="search-cancelled-icon"
          aria-hidden="true"
        >
          <AlertTriangle :size="48" />
        </div>
        <p>{{ t('search.cancelledHint') }}</p>
      </div>
      <template v-else>
        <FolderGrid
          v-if="showSearchFolders && filteredSearchFolders.length > 0"
          :folders="filteredSearchFoldersAsGrid"
          :title="t('search.folders')"
          :favorite-ids="favoriteIds"
          :is-search-result="true"
          @navigate="$emit('navigate', $event)"
          @toggle-favorite="$emit('toggle-favorite', $event)"
        />
        <FileTable
          v-if="showSearchFiles && filteredSearchFiles.length > 0"
          :files="filteredSearchFilesAsTable"
          :title="t('search.files')"
          :selected-files="selectedSearchFiles"
          :downloads="downloadsForTable"
          :sortable="true"
          :sort-field="sortField"
          :sort-direction="sortDirection"
          :show-path="true"
          :min-items-to-virtualize="30"
          :has-active-filters="hasActiveFilters"
          :active-filter-count="activeFilterCount"
          :total-file-count="searchFilesLength"
          @download="$emit('download', $event)"
          @download-selected="$emit('download-selected-search')"
          @toggle-select="$emit('toggle-search-file-select', $event)"
          @toggle-select-all="$emit('toggle-select-all-search')"
          @sort="$emit('set-sort-field', $event)"
        />
        <div
          v-if="
            !isSearching && filteredSearchFolders.length === 0 && filteredSearchFiles.length === 0
          "
          class="empty-state glass-effect"
          role="status"
          aria-live="polite"
        >
          <div class="empty-state-icon">
            <Search :size="64" />
          </div>
          <template v-if="searchError">
            <h3>{{ t('search.searchError') }}</h3>
            <p>{{ searchError }}. {{ t('search.searchErrorHint') }}</p>
          </template>
          <template v-else-if="searchHadResultsButFiltersHideAll">
            <h3>{{ t('search.filtersHideAll') }}</h3>
            <p>{{ t('search.filtersHideAllHint') }}</p>
          </template>
          <template v-else>
            <h3>{{ t('search.noResults') }}</h3>
            <p>{{ t('search.noResultsHint') }}</p>
          </template>
        </div>
        <div
          v-else-if="
            !showSearchFolders &&
            !showSearchFiles &&
            (filteredSearchFolders.length > 0 || filteredSearchFiles.length > 0)
          "
          class="search-no-results search-filtered-empty"
          role="status"
          aria-live="polite"
        >
          <p>{{ t('search.activateOneType') }}</p>
        </div>
      </template>
    </div>
  </ErrorBoundary>
</template>

<script setup lang="ts">
/**
 * ExploreView - Vista principal de exploración del catálogo.
 *
 * Muestra navegación (FolderGrid + FileTable con load-more) o resultados de búsqueda
 * (carpetas/archivos filtrados y ordenados). Emite navigate, download, toggle-favorite, etc.
 */
import { computed } from 'vue';
import type { PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { FolderOpen, AlertTriangle, Folder, File, Search } from 'lucide-vue-next';
import ErrorBoundary from '../components/ErrorBoundary.vue';
import FolderGrid from '../components/files/FolderGrid.vue';
import FileTable from '../components/files/FileTable.vue';
import SkeletonLoaders from '../components/SkeletonLoaders.vue';
import type { FileTableItem } from '../components/files/FileTable.vue';
import type { FolderGridItem } from '../components/files/FolderGrid.vue';

const { t } = useI18n();

const props = defineProps({
  showNavigation: { type: Boolean, required: true },
  showSearchResults: { type: Boolean, required: true },
  foldersTitle: { type: String, default: '' },
  folders: { type: Array as PropType<FolderGridItem[]>, default: () => [] },
  files: { type: Array as PropType<FileTableItem[]>, default: () => [] },
  displayedFilesInExploreAsTable: { type: Array as PropType<FileTableItem[]>, default: () => [] },
  selectedFiles: { type: Array as PropType<number[]>, default: () => [] },
  isAllFilesSelected: { type: Boolean, default: false },
  downloadsByFileId: { type: Object, default: () => ({}) },
  currentNodeId: { type: Number as PropType<number | null | undefined>, default: undefined },
  isAtRoot: { type: Boolean, default: true },
  hasActiveFilters: { type: Boolean, default: false },
  activeFilterCount: { type: Number, default: 0 },
  statusMessageKey: { type: String, default: '' },
  statusMessageParams: { type: Object, default: () => ({}) },
  hasMoreChildren: { type: Boolean, default: false },
  loadingMoreChildren: { type: Boolean, default: false },
  totalChildrenCount: { type: Number, default: 0 },
  favoriteIds: { type: [Set, Array] as PropType<Set<number> | number[]>, default: () => new Set() },
  isSearching: { type: Boolean, default: false },
  showSearchFolders: { type: Boolean, default: true },
  showSearchFiles: { type: Boolean, default: true },
  filteredSearchFolders: { type: Array, default: () => [] },
  filteredSearchFiles: { type: Array, default: () => [] },
  filteredSearchFoldersAsGrid: { type: Array as PropType<FolderGridItem[]>, default: () => [] },
  filteredSearchFilesAsTable: { type: Array as PropType<FileTableItem[]>, default: () => [] },
  selectedSearchFiles: { type: Array as PropType<number[]>, default: () => [] },
  sortField: { type: String, default: '' },
  sortDirection: { type: String, default: 'asc' },
  searchFilesLength: { type: Number, default: 0 },
  searchResultsLength: { type: Number, default: 0 },
  searchError: { type: String, default: '' },
  searchHadResultsButFiltersHideAll: { type: Boolean, default: false },
  isSearchCancelled: { type: Boolean, default: false },
});

/** FileTable espera Record<number, DownloadStateItem>; pasamos el objeto como está. */
const downloadsForTable = computed(
  () => props.downloadsByFileId as Record<number, { state?: string; [key: string]: unknown }>
);

/** Título de la sección carpetas: prop o fallback a Carpetas. */
const foldersTitleComputed = computed(() => props.foldersTitle || t('search.folders'));

defineEmits<{
  (_e: 'navigate', _node: unknown): void;
  (_e: 'toggle-favorite', _node: unknown): void;
  (_e: 'download', _item: unknown): void;
  (_e: 'download-selected'): void;
  (_e: 'download-folder'): void;
  (_e: 'toggle-select', _id: number): void;
  (_e: 'toggle-select-all'): void;
  (_e: 'load-more'): void;
  (_e: 'update:show-search-folders', _v: boolean): void;
  (_e: 'update:show-search-files', _v: boolean): void;
  (_e: 'download-selected-search'): void;
  (_e: 'toggle-search-file-select', _id: number): void;
  (_e: 'toggle-select-all-search'): void;
  (_e: 'set-sort-field', _field: string): void;
}>();
</script>
