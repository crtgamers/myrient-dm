/**
 * @fileoverview Composable para historial de descargas: limpieza, estadísticas y eventos.
 * @module useHistorySection
 *
 * Gestiona la limpieza de historial (clean/clear), estadísticas de limpieza y
 * los event handlers para history-cleaned y memory-cleaned.
 */

import { ref, onMounted, onUnmounted } from 'vue';
import type { Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useToasts } from './useToasts';
import { useSettings } from './useSettings';
import { cleanHistory, clearHistory } from '../services/api';
import {
  formatHistoryCleaned,
  formatHistoryCleanedOld,
  formatMemoryOptimized,
} from '../constants/messages';
import { GENERAL_ERRORS } from '../constants/errors';
import logger from '../utils/logger';

export interface CleanupStats {
  lastMemoryCleanup: number | null;
  lastDbCleanup: number | null;
  totalRemoved: number;
  totalKept: number;
}

export interface UseHistorySectionReturn {
  /** Estadísticas de limpieza para pasar a SettingsModal */
  cleanupStats: Ref<CleanupStats>;
  /** Limpia historial por antigüedad (días) */
  handleCleanHistory: (_daysOld: number) => Promise<void>;
  /** Limpia todo el historial */
  handleClearHistory: () => Promise<void>;
}

/**
 * Composable para sección de historial: limpieza, stats y event listeners.
 */
export function useHistorySection(): UseHistorySectionReturn {
  const { t } = useI18n();
  const { showToast } = useToasts();
  const { showNotifications } = useSettings();

  const cleanupStats = ref<CleanupStats>({
    lastMemoryCleanup: null,
    lastDbCleanup: null,
    totalRemoved: 0,
    totalKept: 0,
  });

  const handleCleanHistory = async (daysOld: number): Promise<void> => {
    try {
      const result = await cleanHistory(daysOld);
      if (result.success) {
        showToast({
          title: t('success.historyCleaned'),
          message: formatHistoryCleaned(result.count),
          type: 'success',
          duration: 5000,
        });
        cleanupStats.value.lastDbCleanup = Date.now();
      } else {
        showToast({
          title: t('errors.historyCleanFailed'),
          message: result.error || GENERAL_ERRORS.UNKNOWN,
          type: 'error',
          duration: 5000,
        });
      }
    } catch (error) {
      logger.child('App').error('Error limpiando historial:', error as Error);
      showToast({
        title: t('errors.historyCleanFailed'),
        message: (error as Error).message || GENERAL_ERRORS.UNKNOWN,
        type: 'error',
        duration: 5000,
      });
    }
  };

  const handleClearHistory = async (): Promise<void> => {
    try {
      const result = await clearHistory();
      if (result.success) {
        showToast({
          title: t('success.historyCleaned'),
          message: formatHistoryCleaned(result.count),
          type: 'success',
          duration: 5000,
        });
        cleanupStats.value.lastDbCleanup = Date.now();
      } else {
        showToast({
          title: t('errors.historyCleanFailed'),
          message: result.error || GENERAL_ERRORS.UNKNOWN,
          type: 'error',
          duration: 5000,
        });
      }
    } catch (error) {
      logger.child('App').error('Error limpiando todo el historial:', error as Error);
      showToast({
        title: t('errors.historyCleanFailed'),
        message: (error as Error).message || GENERAL_ERRORS.UNKNOWN,
        type: 'error',
        duration: 5000,
      });
    }
  };

  const handleHistoryCleaned = (event: Event): void => {
    const e = event as CustomEvent<{ count: number }>;
    const { count } = e.detail;
    if (showNotifications.value && count > 0) {
      showToast({
        title: t('success.historyCleaned'),
        message: formatHistoryCleanedOld(count),
        type: 'info',
        duration: 5000,
      });
      cleanupStats.value.lastDbCleanup = Date.now();
    }
  };

  const handleMemoryCleaned = (event: Event): void => {
    const e = event as CustomEvent<{ removed: number; kept: number; total?: number }>;
    const { removed, kept } = e.detail;
    if (showNotifications.value && removed > 0) {
      showToast({
        title: t('success.memoryOptimized'),
        message: formatMemoryOptimized(removed, kept),
        type: 'success',
        duration: 4000,
      });
      cleanupStats.value.lastMemoryCleanup = Date.now();
      cleanupStats.value.totalRemoved += removed;
      cleanupStats.value.totalKept = kept;
    }
  };

  onMounted(() => {
    window.addEventListener('history-cleaned', handleHistoryCleaned);
    window.addEventListener('memory-cleaned', handleMemoryCleaned);
  });

  onUnmounted(() => {
    window.removeEventListener('history-cleaned', handleHistoryCleaned);
    window.removeEventListener('memory-cleaned', handleMemoryCleaned);
  });

  return {
    cleanupStats,
    handleCleanHistory,
    handleClearHistory,
  };
}
