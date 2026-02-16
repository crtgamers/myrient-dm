/**
 * @fileoverview Índice de componentes Vue reexportados para import desde '@/components'.
 * @module components
 *
 * Agrupa: layout (TitleBar, SearchHeader, Sidebar), files (FolderGrid, FileTable),
 * downloads (DownloadsPanel, ConfirmationToasts), modales, FavoritesSection, FiltersPanel, toasts y ErrorBoundary.
 */

export { default as TitleBar } from './layout/TitleBar.vue';
export { default as SearchHeader } from './layout/SearchHeader.vue';
export { default as HomeScreen } from './HomeScreen.vue';
export { default as Sidebar } from './layout/Sidebar.vue';

export { default as FolderGrid } from './files/FolderGrid.vue';
export { default as FileTable } from './files/FileTable.vue';

export { default as DownloadsPanel } from './downloads/DownloadsPanel.vue';
export { default as ConfirmationToasts } from './downloads/ConfirmationToasts.vue';

export { default as ToastNotifications } from './ToastNotifications.vue';
export { default as ErrorBoundary } from './ErrorBoundary.vue';
export { default as SkeletonLoaders } from './SkeletonLoaders.vue';
export { default as InitializationScreen } from './InitializationScreen.vue';

export { default as SettingsModal } from './modals/SettingsModal.vue';
export { default as ConfirmDialog } from './modals/ConfirmDialog.vue';
export { default as OverwriteConfirmDialog } from './modals/OverwriteConfirmDialog.vue';
export { default as BatchAddedConfirmModal } from './modals/BatchAddedConfirmModal.vue';
export { default as FolderDownloadChoiceModal } from './modals/FolderDownloadChoiceModal.vue';

export { default as FavoritesSection } from './FavoritesSection.vue';

export { default as FiltersPanel } from './FiltersPanel.vue';
