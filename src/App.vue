<template>
  <div
    id="container"
    role="main"
    :aria-label="t('app.ariaMain')"
  >
    <!-- Skip link: primer foco para usuarios de teclado (WCAG 2.4.1) -->
    <a
      href="#content-container"
      class="skip-link"
    >
      {{ t('app.skipToContent') }}
    </a>
    <!-- Wrapper para escalado en ventanas pequeñas (640–800px); modales quedan fuera -->
    <div
      class="app-content-wrapper"
      :style="useScaleWrapper ? scaleWrapperStyle : {}"
    >
      <!-- Barra de Título -->
      <TitleBar
        :is-at-root="isAtRoot"
        :is-dark-mode="isDarkMode"
        :active-download-count="activeDownloadCount"
        :current-download-name="currentDownloadName"
        :average-download-speed="averageDownloadSpeed"
        :show-drawer-toggle="width <= 640"
        @go-back="goBack"
        @toggle-theme="toggleTheme"
        @open-settings="onOpenSettings"
        @open-logs="onOpenLogs"
        @open-statistics="onOpenStatistics"
        @open-drawer="sidebarDrawerOpen = true"
      />

      <div class="main-layout">
        <!-- Sidebar de Navegación (colapsado automático en viewport estrecho) -->
        <Sidebar
          :current-view="currentView"
          :active-download-count="allDownloads.length"
          :narrow-viewport="width < 961"
          :is-drawer-mode="width <= 640"
          :drawer-open="sidebarDrawerOpen"
          @navigate="handleViewChange"
          @open-logs="onOpenLogs"
          @open-settings="onOpenSettings"
          @close-drawer="sidebarDrawerOpen = false"
        />

        <!-- Área de Contenido -->
        <main class="content-area">
          <!-- Header con Búsqueda y Breadcrumb -->
          <SearchHeader
            v-model:search-term="searchTerm"
            v-model:queue-search-term="queueSearchTerm"
            v-model:search-in-current-folder="searchInCurrentFolder"
            :show-advanced-filters="showAdvancedFilters"
            :has-search-results="searchResults.length > 0"
            :has-active-search-or-empty="searchTerm.trim().length >= 2 || searchReturnedEmpty"
            :breadcrumb-path="effectiveBreadcrumbPath"
            :is-at-root="effectiveIsAtRoot"
            :root-label="effectiveRootLabel"
            :is-downloads-view="showingDownloads"
            :show-catalog-search-bar="effectiveShowCatalogSearchBar"
            @toggle-filters="toggleAdvancedFilters"
            @toggle-catalog-search="showCatalogSearchBar = !showCatalogSearchBar"
            @go-to-root="goToRoot"
            @navigate-to="navigateToNode"
            @search="handleSearch"
          />

          <!-- Contenido Principal -->
          <div id="content-container">
            <!-- Overlay de carga durante búsqueda (evita sensación de bloqueo) -->
            <Transition name="overlay-fade">
              <div
                v-if="isSearching"
                class="search-loading-overlay"
                role="status"
                aria-live="polite"
                aria-busy="true"
                :aria-label="t('search.searchCatalog')"
              >
                <div class="search-loading-overlay__content">
                  <Loader2
                    class="search-loading-overlay__spinner"
                    :size="40"
                    aria-hidden="true"
                  />
                  <p class="search-loading-overlay__text">{{ t('search.searching') }}</p>
                </div>
              </div>
            </Transition>
            <!-- Overlay al añadir carpeta con muchos archivos (progreso en segundo plano) -->
            <Transition name="overlay-fade">
              <div
                v-if="folderAddProgress"
                class="search-loading-overlay folder-add-overlay"
                role="status"
                aria-live="polite"
                aria-busy="true"
                :aria-label="
                  t('explore.addingFiles', {
                    added: folderAddProgress.added,
                    total: folderAddProgress.total,
                  })
                "
              >
                <div class="search-loading-overlay__content">
                  <Loader2
                    class="search-loading-overlay__spinner"
                    :size="40"
                    aria-hidden="true"
                  />
                  <p class="search-loading-overlay__text">
                    {{
                      t('explore.addingFiles', {
                        added: folderAddProgress.added,
                        total: folderAddProgress.total,
                      })
                    }}
                  </p>
                  <p
                    v-if="folderAddProgress.folderTitle"
                    class="folder-add-overlay__subtitle"
                  >
                    {{ folderAddProgress.folderTitle }}
                  </p>
                </div>
              </div>
            </Transition>
            <div class="view-switcher">
              <transition
                name="view-fade"
                mode="out-in"
              >
                <div
                  :key="currentView"
                  class="view-switcher-slot"
                >
                  <!-- Vista Favoritos -->
                  <FavoritesView
                    v-if="showingFavorites"
                    :folders="favoriteFolders"
                    :show-folder-content="favoritesNavigatedNodeId !== null"
                    :show-search-results="searchResults.length > 0 || searchReturnedEmpty"
                    :is-searching="isSearching"
                    :show-search-folders="showSearchFolders"
                    :show-search-files="showSearchFiles"
                    :filtered-search-folders="filteredSearchFolders"
                    :filtered-search-files="filteredSearchFiles"
                    :filtered-search-folders-as-grid="filteredSearchFoldersAsGrid"
                    :filtered-search-files-as-table="filteredSearchFilesAsTable"
                    :selected-search-files="selectedSearchFiles"
                    :sort-field="sortField"
                    :sort-direction="sortDirection"
                    :search-files-length="searchFiles.length"
                    :search-results-length="searchResults.length"
                    :search-error="searchError ?? ''"
                    :search-had-results-but-filters-hide-all="searchHadResultsButFiltersHideAll"
                    :is-search-cancelled="isSearchCancelled"
                    :has-active-filters="hasActiveFilters"
                    :active-filter-count="activeFilterCount"
                    :favorite-ids="favoriteIdsForFavoritesView"
                    :downloads-by-file-id="downloadsByFileId"
                    :navigation-folders="folders"
                    :navigation-files="displayedFilesInExploreAsTable"
                    :selected-files="selectedFiles"
                    :is-all-files-selected="isAllFilesSelected"
                    :current-node-id="currentNodeIdForView"
                    :is-at-root="false"
                    :has-more-children="hasMoreChildren"
                    :loading-more-children="loadingMoreChildren"
                    :total-children-count="totalChildrenCountForView"
                    :status-message-key="statusMessageKey ?? ''"
                    :status-message-params="statusMessageParams ?? {}"
                    @navigate="navigateToNode"
                    @remove="toggleFavorite"
                    @toggle-favorite="onToggleFavoriteInExplore"
                    @download="(item: unknown) => download(item as FileToDownloadItem)"
                    @download-selected-search="downloadSelectedSearchFiles"
                    @toggle-search-file-select="toggleSearchFileSelection"
                    @toggle-select-all-search="toggleSelectAllSearch"
                    @set-sort-field="setSortField"
                    @update:show-search-folders="showSearchFolders = $event"
                    @update:show-search-files="showSearchFiles = $event"
                    @download-selected="downloadSelectedFiles"
                    @download-folder="downloadCurrentFolder"
                    @toggle-select="toggleFileSelection"
                    @toggle-select-all="toggleSelectAllFiles"
                    @load-more="loadMoreChildren"
                  />

                  <!-- Vista Descargas -->
                  <DownloadsView
                    v-else-if="showingDownloads"
                    :downloads="filteredDownloadsForQueue"
                    :total-download-count="allDownloads.length"
                    :state-filter="queueStateFilter"
                    :available-state-filters="availableQueueStateFilters"
                    :queue-search-term="queueSearchTerm"
                    :speed-stats="speedStats"
                    :pending-confirmations="pendingConfirmations"
                    :selected-downloads="selectedDownloads"
                    :selected-history-downloads="selectedHistoryDownloads"
                    :show-empty="true"
                    :show-chunk-progress="showChunkProgress"
                    :sort-by="downloadsSortBy"
                    :sort-direction="downloadsSortDirection"
                    :snapshot-truncated="snapshotTruncated"
                    :snapshot-total-count="snapshotTotalCount"
                    @update:state-filter="queueStateFilter = $event"
                    @update:queue-search-term="queueSearchTerm = $event"
                    @clear-downloads="clearDownloads"
                    @restart-stopped-with-overwrite="restartStoppedWithOverwrite"
                    @restart-selected-with-overwrite="restartSelectedWithOverwrite"
                    @cancel-all-downloads="cancelAllDownloads"
                    @confirm-all="confirmOverwriteAll"
                    @cancel-all="cancelOverwriteAll"
                    @toggle-select-all-history="toggleSelectAllHistoryDownloads"
                    @toggle-select-history="toggleSelectHistoryDownload"
                    @confirm-overwrite="confirmOverwrite"
                    @cancel-overwrite="cancelOverwrite"
                    @pause-all="pauseAllDownloads"
                    @resume-all="resumeAllDownloads"
                    @pause-selected="pauseSelected"
                    @resume-selected="resumeSelected"
                    @cancel-selected="cancelSelected"
                    @remove-selected="removeSelected"
                    @pause="pauseDownload"
                    @resume="resumeDownload"
                    @cancel="cancelDownload"
                    @retry="retryDownload"
                    @remove="removeFromHistory"
                    @sort-by-column="sortDownloadsByColumn"
                  />

                  <!-- Pantalla de inicio: selección Myrient / LoLROMs -->
                  <HomeScreen
                    v-else-if="!activeSource && !showingDownloads"
                    :loading-source="loadingSource"
                    @select-source="onSelectCatalogSource"
                  />

                  <!-- Vista Explorar (navegación + resultados de búsqueda) -->
                  <ExploreView
                    v-else-if="activeSource"
                    :show-navigation="searchResults.length === 0 && !searchReturnedEmpty"
                    :show-search-results="searchResults.length > 0 || searchReturnedEmpty"
                    :folders-title="foldersTitleForExplore"
                    :folders="folders"
                    :files="files"
                    :displayed-files-in-explore-as-table="displayedFilesInExploreAsTable"
                    :selected-files="selectedFiles"
                    :is-all-files-selected="isAllFilesSelected"
                    :downloads-by-file-id="downloadsByFileId"
                    :current-node-id="currentNodeIdForView"
                    :is-at-root="isAtRoot"
                    :has-active-filters="hasActiveFilters"
                    :active-filter-count="activeFilterCount"
                    :status-message-key="statusMessageKey ?? ''"
                    :status-message-params="statusMessageParams ?? {}"
                    :has-more-children="hasMoreChildren"
                    :loading-more-children="loadingMoreChildren"
                    :total-children-count="totalChildrenCountForView"
                    :favorite-ids="favoriteIdsForExplore"
                    :is-searching="isSearching"
                    :show-search-folders="showSearchFolders"
                    :show-search-files="showSearchFiles"
                    :filtered-search-folders="filteredSearchFolders"
                    :filtered-search-files="filteredSearchFiles"
                    :filtered-search-folders-as-grid="filteredSearchFoldersAsGrid"
                    :filtered-search-files-as-table="filteredSearchFilesAsTable"
                    :selected-search-files="selectedSearchFiles"
                    :sort-field="sortField"
                    :sort-direction="sortDirection"
                    :search-files-length="searchFiles.length"
                    :search-results-length="searchResults.length"
                    :search-error="searchError ?? ''"
                    :search-had-results-but-filters-hide-all="searchHadResultsButFiltersHideAll"
                    :is-search-cancelled="isSearchCancelled"
                    @navigate="
                      (node: unknown) =>
                        navigateToNode(node as CatalogNode | { id: number; source?: CatalogSource })
                    "
                    @toggle-favorite="onToggleFavoriteInExplore"
                    @download="(item: unknown) => download(item as FileToDownloadItem)"
                    @download-selected="downloadSelectedFiles"
                    @download-folder="downloadCurrentFolder"
                    @toggle-select="toggleFileSelection"
                    @toggle-select-all="toggleSelectAllFiles"
                    @load-more="loadMoreChildren"
                    @update:show-search-folders="showSearchFolders = $event"
                    @update:show-search-files="showSearchFiles = $event"
                    @download-selected-search="downloadSelectedSearchFiles"
                    @toggle-search-file-select="toggleSearchFileSelection"
                    @toggle-select-all-search="toggleSelectAllSearch"
                    @set-sort-field="setSortField"
                  />

                  <!-- Placeholder cuando no hay fuente ni descargas (evitar slot vacío) -->
                  <div
                    v-else
                    class="view-switcher-slot"
                  />
                </div>
              </transition>
            </div>
          </div>
        </main>
      </div>
    </div>

    <!-- Modal de elección: descargar solo visibles o toda la carpeta (cuando hay filtros activos) -->
    <FolderDownloadChoiceModal
      :show="showFolderDownloadChoiceModal"
      :filtered-count="displayedFilesInExploreAsTable.length"
      :total-count="files.length"
      @download-filtered="onDownloadFilteredOnly"
      @download-all="onConfirmFolderDownloadChoiceAll"
      @cancel="showFolderDownloadChoiceModal = false"
    />

    <!-- Modal de confirmación: descarga carpeta completa -->
    <ConfirmDialog
      :show="showConfirmFolderModal"
      :title="t('downloads.folderComplete')"
      :message="t('downloads.folderCompleteWarning')"
      :confirm-label="t('downloads.continue')"
      :cancel-label="t('common.cancel')"
      variant="warning"
      @confirm="onConfirmFolderDownload"
      @cancel="showConfirmFolderModal = false"
    />

    <!-- Modal: archivos agregados a la cola (modo preparación de cola) -->
    <BatchAddedConfirmModal
      :show="showBatchAddedModal"
      :added-count="batchAddedPayload.addedCount"
      :folder-label="batchAddedPayload.folderLabel ?? ''"
      :folder-count="batchAddedPayload.folderCount"
      @start-download="onBatchStartDownload"
      @review-queue="onBatchReviewQueue"
      @cancel="onBatchCancel"
    />

    <!-- Modal de Configuración -->
    <SettingsModal
      v-model:search-limit="searchLimit"
      v-model:download-path="downloadPath"
      v-model:preserve-structure="preserveStructure"
      v-model:max-parallel-downloads="maxParallelDownloads"
      v-model:turbo-download="turboDownload"
      v-model:queue-batch-confirm-threshold="queueBatchConfirmThreshold"
      v-model:max-concurrent-chunks="maxConcurrentChunks"
      v-model:max-chunk-retries="maxChunkRetries"
      v-model:chunk-operation-timeout-minutes="chunkOperationTimeoutMinutes"
      v-model:skip-verification="skipVerification"
      v-model:disable-chunked-downloads="disableChunkedDownloads"
      v-model:show-notifications="showNotifications"
      v-model:auto-check-updates="autoCheckUpdates"
      v-model:auto-resume-downloads="autoResumeDownloads"
      v-model:max-history-in-memory="maxHistoryInMemory"
      v-model:max-completed-in-memory="maxCompletedInMemory"
      v-model:max-failed-in-memory="maxFailedInMemory"
      v-model:show-chunk-progress="showChunkProgress"
      :show="showSettings"
      :favorites-count="favorites.length"
      :last-update-date="formattedUpdateDate"
      :cleanup-stats="cleanupStats"
      :primary-color="primaryColor"
      :motion-preference="motionPreference"
      :performance-mode="performanceMode"
      @close="showSettings = false"
      @update:motion-preference="setMotionPreference"
      @update:performance-mode="setPerformanceMode"
      @save-settings="saveDownloadSettings"
      @select-folder="selectDownloadFolder"
      @clear-favorites="clearFavorites"
      @clean-history="handleCleanHistory"
      @clear-history="handleClearHistory"
      @set-primary-color="setPrimaryColor"
      @open-statistics="onOpenStatistics"
    />

    <!-- Consola de Logs -->
    <LogsConsole
      :show="showLogsConsole"
      @close="showLogsConsole = false"
    />

    <!-- Panel de estadísticas de red -->
    <StatisticsPanel
      :show="showStatisticsPanel"
      :average-download-speed="averageDownloadSpeed"
      :active-download-count="activeDownloadCount"
      @close="showStatisticsPanel = false"
    />

    <!-- Modal de confirmación: reemplazar archivo(s) existente(s) -->
    <OverwriteConfirmDialog
      :confirmations="pendingConfirmations"
      @confirm="confirmOverwrite"
      @cancel="cancelOverwrite"
      @confirm-all="confirmOverwriteAll"
      @cancel-all="cancelOverwriteAll"
    />

    <!-- Toast Notifications -->
    <ToastNotifications
      :toasts="toasts"
      @remove="removeToast"
    />

    <!-- Pantalla de Inicio (Animación) -->
    <transition name="view-fade">
      <InitializationScreen
        v-if="isAppInitializing"
        :status-message="initializationStatus"
      />
    </transition>

    <!-- Panel de Filtros Avanzados: overlay solo hace fade; solo el panel se desliza (evita sensación de que la pantalla se mueve) -->
    <Transition name="overlay-fade">
      <div
        v-if="showAdvancedFilters"
        class="filters-overlay"
        aria-hidden="true"
        @click="toggleAdvancedFilters"
      />
    </Transition>
    <Transition name="panel-slide">
      <FiltersPanel
        v-if="showAdvancedFilters"
        :search-results="filterPanelSourceAsFilterable"
        @close="toggleAdvancedFilters"
      />
    </Transition>
  </div>
</template>

<script setup lang="ts">
/**
 * App.vue - Componente raíz de la aplicación Vue
 *
 * Orquesta vistas principales (exploración, favoritos, cola de descargas, búsqueda),
 * modales de configuración y confirmación, y el manejo global de errores.
 * Integra composables para estado compartido y comunicación con el backend via window.api.
 */
import { ref, computed, onMounted, onUnmounted, watch, defineAsyncComponent } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { Loader2 } from 'lucide-vue-next';

// Shell y componentes de primer pintado (import estático)
import {
  TitleBar,
  Sidebar,
  SearchHeader,
  ToastNotifications,
  InitializationScreen,
  HomeScreen,
} from './components';

// Componente mínimo mostrado mientras se carga un chunk (evita pantalla en blanco en redes lentas)
import AsyncLoadPlaceholder from './components/AsyncLoadPlaceholder.vue';

// Vistas principales: lazy load con placeholder (sus iconos Lucide van en chunks separados)
const FavoritesView = defineAsyncComponent({
  loader: () => import('./views/FavoritesView.vue'),
  loadingComponent: AsyncLoadPlaceholder,
  delay: 200,
});
const DownloadsView = defineAsyncComponent({
  loader: () => import('./views/DownloadsView.vue'),
  loadingComponent: AsyncLoadPlaceholder,
  delay: 200,
});
const ExploreView = defineAsyncComponent({
  loader: () => import('./views/ExploreView.vue'),
  loadingComponent: AsyncLoadPlaceholder,
  delay: 200,
});

// Modales y paneles: lazy load sin placeholder (se abren tras acción del usuario)
const FiltersPanel = defineAsyncComponent(() => import('./components/FiltersPanel.vue'));
const SettingsModal = defineAsyncComponent(() => import('./components/modals/SettingsModal.vue'));
const ConfirmDialog = defineAsyncComponent(() => import('./components/modals/ConfirmDialog.vue'));
const OverwriteConfirmDialog = defineAsyncComponent(
  () => import('./components/modals/OverwriteConfirmDialog.vue')
);
const BatchAddedConfirmModal = defineAsyncComponent(
  () => import('./components/modals/BatchAddedConfirmModal.vue')
);
const FolderDownloadChoiceModal = defineAsyncComponent(
  () => import('./components/modals/FolderDownloadChoiceModal.vue')
);
const LogsConsole = defineAsyncComponent(() => import('./components/LogsConsole.vue'));
const StatisticsPanel = defineAsyncComponent(
  () => import('./components/modals/StatisticsPanel.vue')
);

// Composables
import { useSettings } from './composables/useSettings';
import { useFavorites } from './composables/useFavorites';
import { useWindowScale } from './composables/useWindowScale';
import { useNavigation } from './composables/useNavigation';
import { useSearch } from './composables/useSearch';
import { useFilters } from './composables/useFilters';
import { useDownloads } from './composables/useDownloads';
import { useToasts } from './composables/useToasts';
import { useErrorHandling } from './composables/useErrorHandling';
import { useFileSelection } from './composables/useFileSelection';
import { useQueueContent } from './composables/useQueueContent';
import { useAppLayout } from './composables/useAppLayout';
import { useHistorySection } from './composables/useHistorySection';
import { useToastHandlers } from './composables/useToastHandlers';
import { useFilterPanel } from './composables/useFilterPanel';
import type { CatalogNode } from './composables/useNavigation';
import type { FileTableItem } from './components/files/FileTable.vue';
import type { FolderGridItem } from './components/files/FolderGrid.vue';

// Registrar handler global de errores
import { registerGlobalToastHandler } from './utils/errorHandler';

// API
import {
  loadDatabase,
  closeDatabase,
  getDbUpdateDate,
  getCurrentSource,
  onFolderAddComplete,
} from './services/api';
import type { CatalogSource } from './services/api';

// Utils
import logger from './utils/logger';
import { APP_ERRORS } from './constants/errors';

// =====================
// COMPOSABLES
// =====================

const { t } = useI18n();

const {
  downloadPath,
  preserveStructure,
  showNotifications,
  autoCheckUpdates,
  maxParallelDownloads,
  turboDownload,
  maxConcurrentChunks,
  maxChunkRetries,
  chunkOperationTimeoutMinutes,
  skipVerification,
  disableChunkedDownloads,
  searchLimit,
  isDarkMode,
  autoResumeDownloads,
  queueBatchConfirmThreshold,
  maxHistoryInMemory,
  maxCompletedInMemory,
  maxFailedInMemory,
  showChunkProgress,
  primaryColor,
  initSettings,
  saveDownloadSettings,
  selectDownloadFolder,
  toggleTheme,
  setPrimaryColor,
  motionPreference,
  setMotionPreference,
  performanceMode,
  setPerformanceMode,
} = useSettings();

const {
  favorites,
  showingFavorites,
  favoriteFolders,
  favoriteIds,
  getFavoriteIdsForSource,
  loadFavorites,
  toggleFavorite,
  clearFavorites,
} = useFavorites();

/** Favoritos filtrados por fuente actual (para mostrar estrellas en ExploreView). Array para reactividad. */
const favoriteIdsForExplore = computed(() =>
  Array.from(getFavoriteIdsForSource(activeSource.value))
);

/** Título de sección carpetas en raíz: "Directorio Myrient" o "Directorio LoLROMS"; si no en raíz, "Carpetas" */
const foldersTitleForExplore = computed(() => {
  if (!isAtRoot.value || !activeSource.value) return t('search.folders');
  return activeSource.value === 'myrient' ? t('home.directoryMyrient') : t('home.directoryLolroms');
});

/** Favoritos para FavoritesView: todos cuando en raíz, filtrados por fuente cuando dentro de una carpeta. */
const favoriteIdsForFavoritesView = computed(() =>
  favoritesNavigatedNodeId.value === null
    ? favoriteIds.value
    : getFavoriteIdsForSource(activeSource.value)
);

const { scaleWrapperStyle, useScaleWrapper, width } = useWindowScale();

const {
  downloads: _downloads,
  downloadsByFileId,
  speedStats,
  pendingConfirmations,
  showingDownloads,
  selectedDownloads,
  selectedHistoryDownloads,
  allDownloads,
  activeDownloadCount,
  averageDownloadSpeed,
  currentDownloadName,
  download,
  downloadFolder,
  pauseDownload,
  resumeDownload,
  pauseAllDownloads,
  resumeAllDownloads,
  cancelDownload,
  retryDownload,
  confirmOverwrite,
  cancelOverwrite,
  confirmOverwriteAll,
  cancelOverwriteAll,
  toggleSelectHistoryDownload,
  toggleSelectAllHistoryDownloads,
  clearDownloads,
  restartStoppedWithOverwrite,
  restartSelectedWithOverwrite,
  cancelAllDownloads,
  pauseSelected,
  resumeSelected,
  cancelSelected,
  removeSelected,
  removeFromHistory,
  initDownloads,
  cleanup: cleanupDownloads,
  sortBy: downloadsSortBy,
  sortDirection: downloadsSortDirection,
  sortByColumn: sortDownloadsByColumn,
  folderAddProgress,
  setFolderAddProgressInBackground,
  snapshotTruncated,
  snapshotTotalCount,
} = useDownloads();

const {
  showSettings,
  showLogsConsole,
  showStatisticsPanel,
  sidebarDrawerOpen,
  showCatalogSearchBar,
  currentView,
  openSettings: onOpenSettings,
  openLogs: onOpenLogs,
  openStatistics: onOpenStatistics,
} = useAppLayout({
  showingDownloads,
  showingFavorites,
  width,
});

const {
  currentNodeId,
  allChildren: _allChildren,
  breadcrumbPath,
  folders,
  files,
  locationPath: _locationPath,
  isAtRoot,
  hasMoreChildren,
  totalChildrenCount,
  statusMessageKey,
  statusMessageParams,
  loadChildren: _loadChildren,
  loadMoreChildren,
  loadingMoreChildren,
  navigateToNode: navigateToNodeOriginal,
  goToRoot: goToRootOriginal,
  goBack: goBackOriginal,
  initNavigation,
  collapseToInitialPage,
} = useNavigation();

/** Cuando estamos en Favoritos y el usuario entró a una carpeta: id de esa carpeta; null = listado de favoritos */
const favoritesNavigatedNodeId = ref<number | null>(null);

/** Toggle favorito desde la vista Explorar: usa la fuente actual del backend para no cruzar Myrient/Lolroms. */
const onToggleFavoriteInExplore = async (node: unknown) => {
  const n = node as { id: number; title?: string; type?: string; source?: CatalogSource };
  const res = await getCurrentSource();
  const source =
    (res.success && res.data != null ? res.data : activeSource.value) ?? n.source ?? 'myrient';
  toggleFavorite({ ...n, source }, undefined);
};

// Wrappers de navegación que ocultan los paneles
const navigateToNode = async (node: CatalogNode | { id: number; source?: CatalogSource }) => {
  const nodeWithSource = node as { id: number; source?: CatalogSource };
  const targetSource = nodeWithSource.source ?? activeSource.value;

  // Si el nodo tiene una fuente y es distinta a la actual, cargar esa DB primero
  if (targetSource && targetSource !== activeSource.value) {
    loadingSource.value = targetSource;
    try {
      const result = await loadDatabase(targetSource);
      if (!result.success) {
        showToast({
          title: t('errors.loadContent'),
          message: result.error ?? t('errors.loadContentDetail', { detail: 'Unknown' }),
          type: 'error',
          duration: 8000,
        });
        loadingSource.value = null;
        return;
      }
      activeSource.value = targetSource;
      showCatalogSearchBar.value = true;
    } catch (error) {
      showToast({
        title: t('errors.loadContent'),
        message: (error as Error).message,
        type: 'error',
        duration: 8000,
      });
      loadingSource.value = null;
      return;
    } finally {
      loadingSource.value = null;
    }
  }

  const wasInFavorites = showingFavorites.value;
  if (!wasInFavorites) {
    (showingFavorites as Ref<boolean>).value = false;
    (showingDownloads as Ref<boolean>).value = false;
  }
  if (searchResults.value.length > 0) {
    clearSearch();
  }
  if (wasInFavorites) {
    favoritesNavigatedNodeId.value = node.id;
  }
  await navigateToNodeOriginal(node);
};

/** Inicio: en Favoritos vuelve al listado de favoritos; en descargas/favoritos al ir a Inicio se sale a archivos; en archivos → si está en raíz, volver a pantalla de catálogos; si no, ir a raíz */
const goToRoot = async () => {
  if (showingFavorites.value) {
    favoritesNavigatedNodeId.value = null;
    return;
  }
  const inExplore = !showingDownloads.value;
  if (!inExplore) {
    (showingDownloads as Ref<boolean>).value = false;
    return;
  }
  if (searchResults.value.length > 0) {
    clearSearch();
  }
  // Si ya estamos en pantalla de catálogos (sin fuente), no hacer nada
  if (inExplore && !activeSource.value) return;
  // Si estamos en raíz de un catálogo, volver a pantalla de selección (Myrient / LoLROMs)
  if (inExplore && activeSource.value && isAtRoot.value) {
    try {
      await closeDatabase();
      activeSource.value = null;
      showCatalogSearchBar.value = false;
    } catch (error) {
      logger.child('App').error('Error cerrando base de datos:', error);
    }
    return;
  }
  await goToRootOriginal();
};

const goBack = async () => {
  (showingFavorites as Ref<boolean>).value = false;
  (showingDownloads as Ref<boolean>).value = false;
  await goBackOriginal();
};

/** Modo "Buscar en esta carpeta": limita la búsqueda a la carpeta actual y sus subcarpetas */
const searchInCurrentFolder = ref(false);

const {
  searchTerm,
  searchResults,
  isSearching,
  isSearchCancelled,
  searchReturnedEmpty,
  searchError,
  sortField,
  sortDirection,
  searchFolders,
  searchFiles,
  search,
  clearSearch,
  setSortField,
  cleanup: cleanupSearch,
} = useSearch({
  getScopeFolderId: () =>
    searchInCurrentFolder.value && currentNodeId.value ? currentNodeId.value : null,
  /** En vista Favoritos, limitar búsqueda a las carpetas favoritas y su contenido */
  getScopeFolderIds: () => (showingFavorites.value ? favoriteFolders.value.map(f => f.id) : []),
});

const {
  showAdvancedFilters,
  loadFilterPresets,
  toggleFiltersPanel: toggleAdvancedFilters,
  applyFilters,
  hasActiveFilters,
  activeFilterCount,
  clearAllFilters,
  advancedFilters,
} = useFilters();

const {
  filterPanelSourceAsFilterable,
  filteredSearchFolders,
  filteredSearchFiles,
  searchHadResultsButFiltersHideAll,
} = useFilterPanel({
  searchFolders,
  searchFiles,
  searchResults,
  applyFilters,
  hasActiveFilters,
  advancedFilters,
});

// =====================
// ESTADO LOCAL
// =====================
const showConfirmFolderModal = ref(false);
const showFolderDownloadChoiceModal = ref(false);
const showBatchAddedModal = ref(false);
let unsubscribeFolderAddComplete: (() => void) | undefined;
const batchAddedPayload = ref<{
  addedCount: number;
  folderLabel: string | null;
  folderCount: number;
}>({ addedCount: 0, folderLabel: null, folderCount: 0 });

// Fuente de catálogo activa (null = pantalla de inicio)
const activeSource = ref<CatalogSource | null>(null);
const loadingSource = ref<'myrient' | 'lolroms' | null>(null);

// Visibilidad de resultados de búsqueda (carpetas/archivos)
const showSearchFolders = ref(true);
const showSearchFiles = ref(true);
const lastUpdateDate = ref<number | string | null>(null);

// Estado de inicialización
const isAppInitializing = ref(true);
const initializationStatus = ref('');

// Toasts
const { toasts, showToast, removeToast } = useToasts();

// Cola de descargas: filtrado y watchers (useQueueContent envuelve useQueueFilter)
const { queueSearchTerm, queueStateFilter, availableQueueStateFilters, filteredDownloadsForQueue } =
  useQueueContent({ allDownloads, showingDownloads });

const handleViewChange = (view: 'explore' | 'downloads' | 'favorites') => {
  sidebarDrawerOpen.value = false;
  const sd = showingDownloads as Ref<boolean>;
  const sf = showingFavorites as Ref<boolean>;
  if (view === 'explore') {
    const wasInExplore = !sd.value && !sf.value;
    if (wasInExplore) {
      // Ya estábamos en archivos: Inicio = ir a la raíz del catálogo
      void goToRoot();
    } else {
      // Estábamos en descargas o favoritos: solo volver a la vista archivos (misma carpeta)
      collapseToInitialPage();
      sd.value = false;
      sf.value = false;
    }
  } else if (view === 'downloads') {
    sd.value = true;
    sf.value = false;
    clearAllFilters();
    showAdvancedFilters.value = false;
  } else if (view === 'favorites') {
    sd.value = false;
    sf.value = true;
    favoritesNavigatedNodeId.value = null;
    clearSearch();
    clearAllFilters();
    showAdvancedFilters.value = false;
  }
};

// Registrar el handler de toasts global para el errorHandler
registerGlobalToastHandler(showToast);

// Manejo de errores del proceso principal
const { init: initErrorHandling, cleanup: cleanupErrorHandling } = useErrorHandling();

// Historial: limpieza, estadísticas y eventos
const { cleanupStats, handleCleanHistory, handleClearHistory } = useHistorySection();

// Handlers de toast para eventos de descarga (download-completed, chunk-failed, download-failed-merge)
useToastHandlers();

// =====================
// COMPUTED
// =====================

/** En Favoritos: vacío en listado; dentro de una carpeta favorita = path del catálogo (Favoritos + path). En Explorar: path normal */
const effectiveBreadcrumbPath = computed(() =>
  showingFavorites.value && favoritesNavigatedNodeId.value === null ? [] : breadcrumbPath.value
);
/** En Favoritos: "en raíz" solo en listado de favoritos; en Explorar usa isAtRoot del catálogo */
const effectiveIsAtRoot = computed(() =>
  showingFavorites.value ? favoritesNavigatedNodeId.value === null : isAtRoot.value
);
/** Etiqueta del primer segmento: "Favoritos" en vista Favoritos, "Inicio" en el resto */
const effectiveRootLabel = computed(() =>
  showingFavorites.value ? t('nav.favorites') : t('nav.home')
);

/** Barra de búsqueda: solo visible cuando hay una fuente cargada (no en pantalla de inicio) */
const effectiveShowCatalogSearchBar = computed(
  () =>
    activeSource.value !== null &&
    !showingDownloads.value &&
    !showingFavorites.value &&
    showCatalogSearchBar.value
);

const formattedUpdateDate = computed((): string | undefined => {
  if (lastUpdateDate.value == null) return undefined;
  return new Date(lastUpdateDate.value as number).toLocaleDateString();
});

// Valores para vistas (evitar null donde la vista espera number | undefined)
const currentNodeIdForView = computed(() => currentNodeId.value ?? undefined);
const totalChildrenCountForView = computed(() => totalChildrenCount.value ?? 0);

// Archivos mostrados en vista explorar: sin filtros (los filtros solo aplican a la vista de búsqueda)
const displayedFilesInExplore = computed(() => files.value);

// Tipados para componentes que requieren id
const displayedFilesInExploreAsTable = computed(
  () => displayedFilesInExplore.value as FileTableItem[]
);

// Casts para componentes de búsqueda (FolderGrid, FileTable)
const filteredSearchFoldersAsGrid = computed(
  () => filteredSearchFolders.value as unknown as FolderGridItem[]
);
const filteredSearchFilesAsTable = computed(
  () => filteredSearchFiles.value as unknown as FileTableItem[]
);

// =====================
// MÉTODOS
// =====================

const handleSearch = () => {
  if (searchTerm.value.trim().length >= 2) {
    search();
  }
};

// Selección de archivos (composable useFileSelection)
const {
  selectedFiles,
  selectedSearchFiles,
  isAllFilesSelected,
  toggleFileSelection,
  toggleSelectAllFiles,
  toggleSearchFileSelection,
  createToggleSelectAllSearch,
} = useFileSelection({
  displayedFiles: displayedFilesInExploreAsTable as unknown as ComputedRef<{ id: number }[]>,
  showToast,
  t,
});

// toggleSelectAllSearch necesita la referencia a filteredSearchFiles que se define como computed más arriba
const toggleSelectAllSearch = createToggleSelectAllSearch(
  filteredSearchFilesAsTable as unknown as ComputedRef<{ id: number }[]>
);

interface FileToDownloadItem {
  id: number;
  title?: string;
  url?: string;
}

/**
 * Descarga una lista de archivos: si supera el umbral de confirmación, los agrega en pausa y muestra el modal de batch.
 */
const downloadFileList = async (
  filesToDownload: FileToDownloadItem[],
  options: { folderLabel?: string; folderCount?: number } = {}
) => {
  const threshold = queueBatchConfirmThreshold.value;
  const useDeferStart = threshold > 0 && filesToDownload.length >= threshold;

  if (useDeferStart) {
    for (const file of filesToDownload) {
      await download(file, { startPaused: true });
    }
    batchAddedPayload.value = {
      addedCount: filesToDownload.length,
      folderLabel: options.folderLabel ?? null,
      folderCount: options.folderCount ?? 0,
    };
    showBatchAddedModal.value = true;
  } else {
    filesToDownload.forEach((file: FileToDownloadItem) => download(file));
  }
};

const downloadSelectedFiles = async () => {
  const filesWithId = displayedFilesInExplore.value as {
    id: number;
    title?: string;
    url?: string;
  }[];
  const filesToDownload = filesWithId.filter(
    (f: { id: number }) =>
      selectedFiles.value.includes(f.id) &&
      !(downloadsByFileId.value as Record<number, unknown>)[f.id]
  );
  await downloadFileList(filesToDownload);
  selectedFiles.value = [];
};

const downloadSelectedSearchFiles = async () => {
  const searchFilesWithId = filteredSearchFiles.value as {
    id: number;
    title?: string;
    url?: string;
  }[];
  const filesToDownload = searchFilesWithId.filter(
    (f: { id: number }) =>
      selectedSearchFiles.value.includes(f.id) &&
      !(downloadsByFileId.value as Record<number, unknown>)[f.id]
  );
  await downloadFileList(
    filesToDownload.map((f: { id: number; title?: string; url?: string }) => ({
      id: f.id,
      title: f.title,
      url: f.url,
    }))
  );
  selectedSearchFiles.value = [];
};

const downloadCurrentFolder = async () => {
  const appLogger = logger.child('App');

  if (isAtRoot.value) {
    appLogger.warn(APP_ERRORS.DOWNLOAD_ROOT_FAILED);
    return;
  }

  if (!currentNodeId.value) {
    appLogger.error(APP_ERRORS.NO_CURRENT_FOLDER);
    return;
  }

  // Si hay filtros activos, preguntar: solo visibles o toda la carpeta
  if (hasActiveFilters.value) {
    showFolderDownloadChoiceModal.value = true;
    return;
  }

  showConfirmFolderModal.value = true;
};

/** Descargar solo los archivos actualmente visibles (filtrados). */
const onDownloadFilteredOnly = async () => {
  showFolderDownloadChoiceModal.value = false;
  const filesWithId = displayedFilesInExplore.value as {
    id: number;
    title?: string;
    url?: string;
  }[];
  const filesToDownload = filesWithId.filter(
    (f: { id: number }) => !(downloadsByFileId.value as Record<number, unknown>)[f.id]
  );
  await downloadFileList(filesToDownload);
};

/** Elegir "Toda la carpeta" en el modal de filtros: abrir confirmación estándar. */
const onConfirmFolderDownloadChoiceAll = () => {
  showFolderDownloadChoiceModal.value = false;
  showConfirmFolderModal.value = true;
};

/** Devuelve el último segmento de una ruta (nombre de carpeta sin ruta completa). */
function lastSegment(str: string | null | undefined): string {
  if (str == null || str === '') return '';
  const parts = String(str).trim().split(/[/\\]/);
  return parts[parts.length - 1]?.trim() || str;
}

const onConfirmFolderDownload = async () => {
  showConfirmFolderModal.value = false;
  const appLogger = logger.child('App');

  if (isAtRoot.value || !currentNodeId.value) {
    return;
  }

  const threshold = queueBatchConfirmThreshold.value;
  const useDeferStart = threshold > 0;

  try {
    const folderInfo =
      breadcrumbPath.value.length > 0
        ? {
            id: currentNodeId.value,
            title: breadcrumbPath.value[breadcrumbPath.value.length - 1].title,
          }
        : { id: currentNodeId.value, title: t('info.currentFolder') };

    const result = (await downloadFolder(folderInfo, { deferStart: useDeferStart })) as {
      success?: boolean;
      added?: number;
      totalFiles?: number;
      total?: number;
      folderTitle?: string;
      error?: string;
      processingInBackground?: boolean;
    };

    if (result.success) {
      if (result.processingInBackground && result.total != null) {
        setFolderAddProgressInBackground(result.total, result.folderTitle);
        return;
      }
      const added = result.added ?? 0;
      appLogger.info(
        `Descarga de carpeta: ${added} archivos agregados de ${result.totalFiles ?? added} totales`
      );

      if (useDeferStart && added >= threshold) {
        batchAddedPayload.value = {
          addedCount: added,
          folderLabel: lastSegment((result as { folderTitle?: string }).folderTitle),
          folderCount: 1,
        };
        showBatchAddedModal.value = true;
      } else if (useDeferStart && added > 0) {
        await resumeAllDownloads();
      }
    } else {
      appLogger.error(APP_ERRORS.DOWNLOAD_ROOT_FAILED, result.error);
    }
  } catch (error) {
    appLogger.error('Excepción descargando carpeta:', error as Error);
  }
};

const onBatchStartDownload = () => {
  showBatchAddedModal.value = false;
  resumeAllDownloads();
};

const onBatchReviewQueue = () => {
  showBatchAddedModal.value = false;
  (showingDownloads as Ref<boolean>).value = true;
  (showingFavorites as Ref<boolean>).value = false;
};

const onBatchCancel = () => {
  showBatchAddedModal.value = false;
};

/** Selecciona y carga una fuente de catálogo (Myrient o LoLROMs) */
const onSelectCatalogSource = async (source: CatalogSource) => {
  const appLogger = logger.child('App');
  loadingSource.value = source;
  try {
    const result = await loadDatabase(source);
    if (result.success) {
      activeSource.value = source;
      showCatalogSearchBar.value = true;
      await initNavigation();
    } else {
      showToast({
        title: t('errors.loadContent'),
        message: result.error ?? t('errors.loadContentDetail', { detail: 'Unknown' }),
        type: 'error',
        duration: 8000,
      });
    }
  } catch (error) {
    appLogger.error('Error cargando fuente:', error);
    showToast({
      title: t('errors.loadContent'),
      message: (error as Error).message,
      type: 'error',
      duration: 8000,
    });
  } finally {
    loadingSource.value = null;
  }
};

const loadUpdateDate = async () => {
  const appLogger = logger.child('App');
  try {
    const result = await getDbUpdateDate();
    if (result.success && result.data != null) {
      lastUpdateDate.value = result.data as number | string;
    }
  } catch (error) {
    appLogger.error('Error cargando fecha de actualización:', error as Error);
  }
};

// =====================
// WATCHERS
// =====================

// Ocultar barra de búsqueda de catálogo al entrar en descargas/favoritos
watch(showingDownloads, val => {
  if (val) showCatalogSearchBar.value = false;
});
watch(showingFavorites, val => {
  if (val) showCatalogSearchBar.value = false;
});

watch(currentNodeId, () => {
  if (searchResults.value.length > 0) {
    clearSearch();
  }
  if (isAtRoot.value) {
    searchInCurrentFolder.value = false;
  }
});

// Al salir de la vista de búsqueda (sin resultados), limpiar filtros y cerrar panel
watch(
  () => searchResults.value.length,
  (len, prevLen) => {
    if (prevLen !== undefined && prevLen > 0 && len === 0) {
      clearAllFilters();
      showAdvancedFilters.value = false;
    }
  }
);

// =====================
// LIFECYCLE
// =====================

onMounted(async () => {
  initializationStatus.value = t('init.starting');
  // Inicializar proceso de arranque con mensajes informativos
  try {
    initializationStatus.value = t('init.loadingConfig');
    await initSettings();

    initializationStatus.value = t('init.loadingFavorites');
    await loadFavorites();

    initializationStatus.value = t('init.loadingFilters');
    await loadFilterPresets();

    // initNavigation se llama cuando el usuario selecciona Myrient o LoLROMs
    initializationStatus.value = t('init.loadingDownloads');
    await initDownloads();

    initializationStatus.value = t('init.loadingDatabase');
    await loadUpdateDate();

    // Inicializar manejo de errores del proceso principal
    initErrorHandling();

    // Pequeña pausa para asegurar una transición suave y no un "parpadeo" si carga muy rápido
    setTimeout(() => {
      isAppInitializing.value = false;
      if (typeof window !== 'undefined' && !(window as { api?: unknown }).api) {
        showToast({
          title: t('errors.electronNotDetected'),
          message: t('errors.electronNotDetectedHint'),
          type: 'warning',
          duration: 12000,
        });
      }
    }, 800);
  } catch (error) {
    logger.error('Error durante la inicialización:', error);
    isAppInitializing.value = false; // Forzar entrada para no bloquear al usuario
  }

  // Resultado de añadir carpeta en segundo plano (folder-add-complete)
  unsubscribeFolderAddComplete = onFolderAddComplete(payload => {
    const appLogger = logger.child('App');
    if (payload?.error) {
      appLogger.error('Error al agregar carpeta en segundo plano:', payload.error);
      showToast({
        title: t('errors.addFolderError'),
        message: payload.error,
        type: 'error',
        duration: 8000,
      });
      return;
    }
    const added = payload?.added ?? 0;
    const threshold = queueBatchConfirmThreshold.value;
    if (threshold > 0 && added >= threshold) {
      batchAddedPayload.value = {
        addedCount: added,
        folderLabel: lastSegment(payload?.folderTitle),
        folderCount: 1,
      };
      showBatchAddedModal.value = true;
    } else if (added > 0) {
      resumeAllDownloads();
    }
  });
});

onUnmounted(() => {
  if (typeof unsubscribeFolderAddComplete === 'function') {
    unsubscribeFolderAddComplete();
  }

  // Limpiar manejo de errores
  cleanupErrorHandling();

  // Limpiar composables
  cleanupDownloads();
  cleanupSearch();
});
</script>
