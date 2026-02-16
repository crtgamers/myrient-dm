/**
 * @fileoverview Composable para estado de layout: modales, sidebar, vista actual.
 * @module useAppLayout
 *
 * Centraliza el estado de la interfaz: qué modales están abiertos, si el drawer del sidebar
 * está abierto, vista actual del sidebar y watchers de responsividad.
 */

import { ref, computed, watch } from 'vue';
import type { Ref, ComputedRef } from 'vue';

export type SidebarView = 'explore' | 'downloads' | 'favorites';

export interface UseAppLayoutOptions {
  /** Si la vista de descargas está activa (de useDownloads) */
  showingDownloads: Ref<boolean>;
  /** Si la vista de favoritos está activa (de useFavorites) */
  showingFavorites: Ref<boolean>;
  /** Ancho de ventana (de useWindowScale) para watcher de responsividad */
  width: Ref<number>;
}

export interface UseAppLayoutReturn {
  /** Modal de configuración visible */
  showSettings: Ref<boolean>;
  /** Consola de logs visible */
  showLogsConsole: Ref<boolean>;
  /** Panel de estadísticas visible */
  showStatisticsPanel: Ref<boolean>;
  /** Drawer del sidebar abierto (móvil) */
  sidebarDrawerOpen: Ref<boolean>;
  /** Barra de búsqueda de catálogo visible en vista explorar */
  showCatalogSearchBar: Ref<boolean>;
  /** Vista actual para el Sidebar */
  currentView: ComputedRef<SidebarView>;
  /** Abre modal de configuración y cierra sidebar */
  openSettings: () => void;
  /** Abre consola de logs y cierra sidebar */
  openLogs: () => void;
  /** Abre panel de estadísticas, cierra settings y cierra sidebar */
  openStatistics: () => void;
}

/**
 * Estado de layout: modales, sidebar drawer, vista actual.
 * Incluye watcher para cerrar el drawer cuando el viewport crece (>640px).
 */
export function useAppLayout(options: UseAppLayoutOptions): UseAppLayoutReturn {
  const { showingDownloads, showingFavorites, width } = options;

  const showSettings = ref(false);
  const showLogsConsole = ref(false);
  const showStatisticsPanel = ref(false);
  const sidebarDrawerOpen = ref(false);
  const showCatalogSearchBar = ref(true);

  const currentView = computed<SidebarView>(() => {
    if (showingDownloads.value) return 'downloads';
    if (showingFavorites.value) return 'favorites';
    return 'explore';
  });

  watch(width, w => {
    if (w > 640) sidebarDrawerOpen.value = false;
  });

  const openSettings = (): void => {
    sidebarDrawerOpen.value = false;
    showSettings.value = true;
  };

  const openLogs = (): void => {
    sidebarDrawerOpen.value = false;
    showLogsConsole.value = true;
  };

  const openStatistics = (): void => {
    sidebarDrawerOpen.value = false;
    showSettings.value = false;
    showStatisticsPanel.value = true;
  };

  return {
    showSettings,
    showLogsConsole,
    showStatisticsPanel,
    sidebarDrawerOpen,
    showCatalogSearchBar,
    currentView,
    openSettings,
    openLogs,
    openStatistics,
  };
}
