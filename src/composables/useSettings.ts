/**
 * @fileoverview useSettings - Composable para gestión de configuración
 * @module useSettings
 */

import { ref, watch, onUnmounted } from 'vue';
import type { Ref } from 'vue';

/** Preferencia de animaciones: auto = seguir sistema, reduce = siempre reducir, full = siempre completas */
export type MotionPreference = 'auto' | 'reduce' | 'full';
import {
  readConfigFile,
  writeConfigFile,
  selectFolder,
  applyDownloadSettings,
} from '../services/api';
import { useToasts } from './useToasts';
import logger from '../utils/logger';
import { SUCCESS_MESSAGES } from '../constants/messages';
import { resolveSupportedLocale } from '../locales';
import { getCurrentLocale, setAppLocale } from '../plugins/i18n';

export type PrimaryColorKey = 'green' | 'blue' | 'red' | 'purple' | 'orange' | 'cyan';

export const PRIMARY_COLORS: Record<
  PrimaryColorKey,
  { name: string; value: string; hover: string }
> = {
  green: { name: 'Green', value: '#4CAF50', hover: '#45a049' },
  blue: { name: 'Blue', value: '#2196F3', hover: '#1976D2' },
  red: { name: 'Red', value: '#f44336', hover: '#d32f2f' },
  purple: { name: 'Purple', value: '#9c27b0', hover: '#7b1fa2' },
  orange: { name: 'Orange', value: '#ff9800', hover: '#f57c00' },
  cyan: { name: 'Cyan', value: '#00bcd4', hover: '#0097a7' },
};

export const QUEUE_BATCH_THRESHOLD_MIN = 10;
export const QUEUE_BATCH_THRESHOLD_MAX = 1000;

const downloadPath = ref('');
const preserveStructure = ref(true);
const showNotifications = ref(true);
const maxParallelDownloads = ref(3);
const maxConcurrentChunks = ref(3);
const maxChunkRetries = ref(3);
const chunkOperationTimeoutMinutes = ref(5);
const skipVerification = ref(false);
const searchLimit = ref(500);
const isDarkMode = ref(true);
const autoResumeDownloads = ref(true);
const primaryColor = ref<PrimaryColorKey>('green');
const queueBatchConfirmThreshold = ref(25);
const maxHistoryInMemory = ref(100);
const maxCompletedInMemory = ref(50);
const maxFailedInMemory = ref(20);
const showChunkProgress = ref(true);
const disableChunkedDownloads = ref(true);
const turboDownload = ref(false);
const searchDebounce = ref(300);
const downloadsSortBy = ref('date');
const downloadsSortDirection = ref<'asc' | 'desc'>('desc');
const locale = ref<string>('');
const autoCheckUpdates = ref(true);
const motionPreference = ref<MotionPreference>('full');
/** Modo rendimiento: desactiva blur y efectos glass (por defecto desactivado = efectos completos) */
const performanceMode = ref(false);

let isLoading = false;
let motionMediaQuery: MediaQueryList | null = null;
let motionMediaListener: (() => void) | null = null;

interface SaveOptions {
  showToast?: boolean;
}

function clampQueueBatchThreshold(value: number): number {
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) return 0;
  if (n === 0) return 0;
  return Math.min(QUEUE_BATCH_THRESHOLD_MAX, Math.max(QUEUE_BATCH_THRESHOLD_MIN, Math.floor(n)));
}

interface DownloadSettingsData {
  downloadPath?: string;
  preserveStructure?: boolean;
  showNotifications?: boolean;
  maxParallelDownloads?: number;
  maxConcurrentChunks?: number;
  maxChunkRetries?: number;
  chunkOperationTimeoutMinutes?: number;
  skipVerification?: boolean;
  searchLimit?: number;
  autoResumeDownloads?: boolean;
  queueBatchConfirmThreshold?: number;
  maxHistoryInMemory?: number;
  maxCompletedInMemory?: number;
  maxFailedInMemory?: number;
  showChunkProgress?: boolean;
  disableChunkedDownloads?: boolean;
  turboDownload?: boolean;
  searchDebounce?: number;
}

interface UIPreferencesData {
  isDarkMode?: boolean;
  primaryColor?: string;
  showChunkProgress?: boolean;
  searchDebounce?: number;
  downloadsSortBy?: string;
  downloadsSortDirection?: string;
  /** Código de idioma guardado (ej: en, es, es-CL). Prioridad sobre idioma del sistema. */
  locale?: string;
  /** Si false, no se comprueban actualizaciones al iniciar la app. */
  autoCheckUpdates?: boolean;
  /** Animaciones: auto = seguir prefers-reduced-motion, reduce = siempre reducir, full = siempre completas */
  motionPreference?: MotionPreference;
  /** Modo rendimiento: true = sin blur/glass para mejor FPS; false = glassmorphism completo */
  performanceMode?: boolean;
}

/**
 * Composable de configuración: ruta de descargas, preferencias de cola, tema, idioma y persistencia en JSON.
 * @returns Refs de cada opción (downloadPath, maxParallelDownloads, isDarkMode, …), loadSettings, saveSettings y helpers.
 */
export function useSettings(): {
  downloadPath: Ref<string>;
  preserveStructure: Ref<boolean>;
  showNotifications: Ref<boolean>;
  autoCheckUpdates: Ref<boolean>;
  maxParallelDownloads: Ref<number>;
  maxConcurrentChunks: Ref<number>;
  turboDownload: Ref<boolean>;
  maxChunkRetries: Ref<number>;
  chunkOperationTimeoutMinutes: Ref<number>;
  skipVerification: Ref<boolean>;
  searchLimit: Ref<number>;
  isDarkMode: Ref<boolean>;
  autoResumeDownloads: Ref<boolean>;
  queueBatchConfirmThreshold: Ref<number>;
  maxHistoryInMemory: Ref<number>;
  maxCompletedInMemory: Ref<number>;
  maxFailedInMemory: Ref<number>;
  showChunkProgress: Ref<boolean>;
  disableChunkedDownloads: Ref<boolean>;
  searchDebounce: Ref<number>;
  primaryColor: Ref<PrimaryColorKey>;
  downloadsSortBy: Ref<string>;
  downloadsSortDirection: Ref<'asc' | 'desc'>;
  locale: Ref<string>;
  setLocale: (_locale: string) => Promise<void>;
  loadDownloadSettings: () => Promise<void>;
  loadUIPreferences: () => Promise<void>;
  saveDownloadSettings: (_opts?: SaveOptions) => Promise<void>;
  saveUIPreferences: (_opts?: SaveOptions) => Promise<void>;
  selectDownloadFolder: () => Promise<void>;
  toggleTheme: () => void;
  updateThemeClass: () => void;
  updatePrimaryColor: () => void;
  setPrimaryColor: (_color: PrimaryColorKey) => void;
  motionPreference: Ref<MotionPreference>;
  setMotionPreference: (_value: MotionPreference) => void;
  performanceMode: Ref<boolean>;
  setPerformanceMode: (_value: boolean) => void;
  initSettings: () => Promise<void>;
} {
  const loadDownloadSettings = async (): Promise<void> => {
    isLoading = true;
    try {
      const result = await readConfigFile('download-settings.json');
      if (result.success && result.data) {
        const data = result.data as DownloadSettingsData;
        downloadPath.value = data.downloadPath ?? '';
        preserveStructure.value = data.preserveStructure !== false;
        showNotifications.value = data.showNotifications !== false;
        maxParallelDownloads.value = data.maxParallelDownloads ?? 3;
        maxConcurrentChunks.value = Math.min(4, data.maxConcurrentChunks ?? 3);
        maxChunkRetries.value = data.maxChunkRetries ?? 3;
        chunkOperationTimeoutMinutes.value = data.chunkOperationTimeoutMinutes ?? 5;
        skipVerification.value = data.skipVerification === true;
        searchLimit.value = Math.min(1000, Math.max(100, data.searchLimit ?? 500));
        autoResumeDownloads.value = data.autoResumeDownloads !== false;
        queueBatchConfirmThreshold.value =
          data.queueBatchConfirmThreshold !== undefined
            ? clampQueueBatchThreshold(data.queueBatchConfirmThreshold)
            : 25;
        maxHistoryInMemory.value = data.maxHistoryInMemory ?? 100;
        maxCompletedInMemory.value = data.maxCompletedInMemory ?? 50;
        maxFailedInMemory.value = data.maxFailedInMemory ?? 20;
        showChunkProgress.value = data.showChunkProgress !== false;
        disableChunkedDownloads.value = data.disableChunkedDownloads !== false;
        turboDownload.value = data.turboDownload === true;
        searchDebounce.value = data.searchDebounce ?? 300;
      }
      await applyDownloadSettings({
        maxParallelDownloads: maxParallelDownloads.value,
        maxConcurrentChunks: maxConcurrentChunks.value,
        turboDownload: turboDownload.value,
        maxChunkRetries: maxChunkRetries.value,
        chunkOperationTimeoutMinutes: chunkOperationTimeoutMinutes.value,
        skipVerification: skipVerification.value,
        disableChunkedDownloads: disableChunkedDownloads.value,
      });
    } catch (error) {
      logger.child('Settings').error('Error cargando configuración de descargas', error);
    } finally {
      isLoading = false;
    }
  };

  const loadUIPreferences = async (): Promise<void> => {
    try {
      const result = await readConfigFile('ui-preferences.json');
      if (result.success && result.data) {
        const data = result.data as UIPreferencesData;
        isDarkMode.value = data.isDarkMode !== false;
        if (data.primaryColor && data.primaryColor in PRIMARY_COLORS) {
          primaryColor.value = data.primaryColor as PrimaryColorKey;
        }
        if (data.showChunkProgress !== undefined) {
          showChunkProgress.value = data.showChunkProgress !== false;
        }
        if (data.searchDebounce !== undefined) {
          searchDebounce.value = Math.max(0, Math.min(2000, data.searchDebounce ?? 300));
        }
        if (data.downloadsSortBy) {
          const validSortBy = ['name', 'size', 'progress', 'date', 'priority'];
          if (validSortBy.includes(data.downloadsSortBy)) {
            downloadsSortBy.value = data.downloadsSortBy;
          }
        }
        if (data.downloadsSortDirection) {
          downloadsSortDirection.value = data.downloadsSortDirection === 'asc' ? 'asc' : 'desc';
        }
        if (typeof data.locale === 'string' && data.locale.trim()) {
          locale.value = data.locale.trim();
        } else {
          // Sincronizar con el idioma ya aplicado por main.ts (detección sistema)
          locale.value = getCurrentLocale();
        }
        if (data.autoCheckUpdates !== undefined) {
          autoCheckUpdates.value = data.autoCheckUpdates !== false;
        }
        if (
          data.motionPreference === 'reduce' ||
          data.motionPreference === 'full' ||
          data.motionPreference === 'auto'
        ) {
          motionPreference.value = data.motionPreference;
        }
        if (data.performanceMode === true) {
          performanceMode.value = true;
        }
      }
      updateThemeClass();
      updatePrimaryColor();
      updateMotionClass();
      updatePerformanceModeClass();
    } catch (error) {
      logger.child('Settings').error('Error cargando preferencias de UI', error);
    }
  };

  const saveDownloadSettings = async (opts: SaveOptions = {}): Promise<void> => {
    if (isLoading) return;
    const showToast = opts.showToast !== false;
    try {
      await writeConfigFile('download-settings.json', {
        downloadPath: downloadPath.value,
        preserveStructure: preserveStructure.value,
        showNotifications: showNotifications.value,
        maxParallelDownloads: maxParallelDownloads.value,
        maxConcurrentChunks: maxConcurrentChunks.value,
        maxChunkRetries: maxChunkRetries.value,
        chunkOperationTimeoutMinutes: chunkOperationTimeoutMinutes.value,
        skipVerification: skipVerification.value,
        searchLimit: searchLimit.value,
        autoResumeDownloads: autoResumeDownloads.value,
        queueBatchConfirmThreshold: queueBatchConfirmThreshold.value,
        maxHistoryInMemory: maxHistoryInMemory.value,
        maxCompletedInMemory: maxCompletedInMemory.value,
        maxFailedInMemory: maxFailedInMemory.value,
        disableChunkedDownloads: disableChunkedDownloads.value,
        turboDownload: turboDownload.value,
      });
      await applyDownloadSettings({
        maxParallelDownloads: maxParallelDownloads.value,
        maxConcurrentChunks: maxConcurrentChunks.value,
        turboDownload: turboDownload.value,
        maxChunkRetries: maxChunkRetries.value,
        chunkOperationTimeoutMinutes: chunkOperationTimeoutMinutes.value,
        skipVerification: skipVerification.value,
        disableChunkedDownloads: disableChunkedDownloads.value,
      });
      if (!isLoading && showToast) {
        const { showToast: showToastFn } = useToasts();
        showToastFn({
          title: SUCCESS_MESSAGES.SETTINGS_SAVED,
          type: 'success',
          duration: 3000,
        });
      }
    } catch (error) {
      logger.child('Settings').error('Error guardando configuración de descargas', error);
    }
  };

  const saveUIPreferences = async (opts: SaveOptions = {}): Promise<void> => {
    const showToast = opts.showToast !== false;
    try {
      await writeConfigFile('ui-preferences.json', {
        isDarkMode: isDarkMode.value,
        primaryColor: primaryColor.value,
        showChunkProgress: showChunkProgress.value,
        searchDebounce: searchDebounce.value,
        downloadsSortBy: downloadsSortBy.value,
        downloadsSortDirection: downloadsSortDirection.value,
        locale: locale.value || undefined,
        autoCheckUpdates: autoCheckUpdates.value,
        motionPreference: motionPreference.value,
        performanceMode: performanceMode.value,
      });
      updatePrimaryColor();
      if (!isLoading && showToast) {
        const { showToast: showToastFn } = useToasts();
        showToastFn({
          title: SUCCESS_MESSAGES.SETTINGS_SAVED,
          type: 'success',
          duration: 3000,
        });
      }
    } catch (error) {
      logger.child('Settings').error('Error guardando preferencias de UI', error);
    }
  };

  const selectDownloadFolder = async (): Promise<void> => {
    try {
      const result = await selectFolder();
      const pathValue = (result as { path?: string }).path ?? (result as { data?: string }).data;
      if (result.success && pathValue) {
        downloadPath.value = pathValue;
        await saveDownloadSettings();
      }
    } catch (error) {
      logger.child('Settings').error('Error seleccionando carpeta de descargas', error);
    }
  };

  const toggleTheme = (): void => {
    isDarkMode.value = !isDarkMode.value;
    updateThemeClass();
    void saveUIPreferences();
  };

  const updateThemeClass = (): void => {
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('light-mode', !isDarkMode.value);
    }
  };

  const updateMotionClass = (): void => {
    if (typeof document === 'undefined') return;
    const body = document.body;
    const pref = motionPreference.value;
    body.classList.remove('reduce-motion', 'force-full-motion');
    if (pref === 'reduce') {
      body.classList.add('reduce-motion');
    } else if (pref === 'full') {
      body.classList.add('force-full-motion');
    }
  };

  const setMotionPreference = (value: MotionPreference | string): void => {
    if (value !== 'auto' && value !== 'reduce' && value !== 'full') return;
    motionPreference.value = value as MotionPreference;
    updateMotionClass();
    void saveUIPreferences();
  };

  const updatePerformanceModeClass = (): void => {
    if (typeof document === 'undefined') return;
    const enabled = performanceMode.value;
    document.body.classList.toggle('performance-mode', enabled);
    document.body.setAttribute('data-reduced-effects', enabled ? 'true' : '');
  };

  const setPerformanceMode = (value: boolean): void => {
    performanceMode.value = value;
    updatePerformanceModeClass();
    void saveUIPreferences();
  };

  const updatePrimaryColor = (): void => {
    if (typeof document !== 'undefined' && typeof document.documentElement !== 'undefined') {
      const colorConfig = PRIMARY_COLORS[primaryColor.value] ?? PRIMARY_COLORS.green;
      document.documentElement.style.setProperty('--primary-color', colorConfig.value);
      document.documentElement.style.setProperty('--primary-color-hover', colorConfig.hover);
    }
  };

  const setPrimaryColor = (color: PrimaryColorKey): void => {
    if (color in PRIMARY_COLORS) {
      primaryColor.value = color;
      updatePrimaryColor();
      void saveUIPreferences();
    }
  };

  const setLocale = async (newLocale: string): Promise<void> => {
    const trimmed = (newLocale || '').trim();
    if (!trimmed) return;
    const resolved = resolveSupportedLocale(trimmed);
    locale.value = resolved;
    await setAppLocale(resolved);
    await saveUIPreferences({ showToast: false });
  };

  const initSettings = async (): Promise<void> => {
    await Promise.all([loadDownloadSettings(), loadUIPreferences()]);
    updateThemeClass();
    updatePrimaryColor();
    updateMotionClass();
    if (typeof window !== 'undefined' && window.matchMedia) {
      motionMediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      motionMediaListener = (): void => {
        if (motionPreference.value === 'auto') updateMotionClass();
      };
      motionMediaQuery.addEventListener('change', motionMediaListener);
    }
  };

  onUnmounted(() => {
    if (motionMediaQuery && motionMediaListener) {
      motionMediaQuery.removeEventListener('change', motionMediaListener);
    }
  });

  watch(
    [
      preserveStructure,
      showNotifications,
      maxParallelDownloads,
      maxConcurrentChunks,
      turboDownload,
      maxChunkRetries,
      chunkOperationTimeoutMinutes,
      skipVerification,
      searchLimit,
      autoResumeDownloads,
      queueBatchConfirmThreshold,
      maxHistoryInMemory,
      maxCompletedInMemory,
      maxFailedInMemory,
      disableChunkedDownloads,
    ],
    () => {
      void saveDownloadSettings({ showToast: false });
    },
    { deep: false }
  );

  watch(
    [
      isDarkMode,
      primaryColor,
      showChunkProgress,
      searchDebounce,
      downloadsSortBy,
      downloadsSortDirection,
      autoCheckUpdates,
      motionPreference,
      performanceMode,
    ],
    () => {
      void saveUIPreferences({ showToast: false });
    },
    { deep: false }
  );
  // locale no se guarda por watch; se guarda explícitamente en setLocale para evitar ciclos

  return {
    downloadPath,
    preserveStructure,
    showNotifications,
    autoCheckUpdates,
    maxParallelDownloads,
    maxConcurrentChunks,
    turboDownload,
    maxChunkRetries,
    chunkOperationTimeoutMinutes,
    skipVerification,
    searchLimit,
    isDarkMode,
    autoResumeDownloads,
    queueBatchConfirmThreshold,
    maxHistoryInMemory,
    maxCompletedInMemory,
    maxFailedInMemory,
    showChunkProgress,
    disableChunkedDownloads,
    searchDebounce,
    primaryColor,
    downloadsSortBy,
    downloadsSortDirection,
    locale,
    setLocale,
    loadDownloadSettings,
    loadUIPreferences,
    initSettings,
    saveDownloadSettings,
    saveUIPreferences,
    selectDownloadFolder,
    toggleTheme,
    updateThemeClass,
    setPrimaryColor,
    updatePrimaryColor,
    motionPreference,
    setMotionPreference,
    performanceMode,
    setPerformanceMode,
  };
}

export default useSettings;
