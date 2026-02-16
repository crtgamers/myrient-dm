/**
 * @fileoverview Composable para gestión de descargas (motor transaccional)
 * @module useDownloads
 */

import { ref, computed, reactive, watch } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import { useSettings } from './useSettings';
import logger from '../utils/logger';
import type {
  PreloadApi,
  AddDownloadParams,
  DownloadFolderParams,
  DownloadStateSnapshot,
  DownloadStateChangedPayload,
  DownloadProgressPayload,
  DownloadProgressBatchPayload,
  DownloadFailedPayload,
  ChunkFailedPayload,
  NeedsConfirmationPayload,
  FolderAddProgressPayload,
  FolderAddCompletePayload,
} from '@/types/preload';
import { getStateOrder } from '../../shared/constants/queueStateOrder';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface DownloadItem {
  id: number;
  title?: string;
  state?: string;
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  total_bytes?: number;
  createdAt?: number;
  created_at?: number;
  updatedAt?: number;
  updated_at?: number;
  priority?: number;
  lastError?: string;
  speed?: number;
  speedBytesPerSec?: number;
  remainingTime?: number;
  queueStatus?: string;
  error?: string;
  [key: string]: unknown;
}

export interface DownloadSnapshot {
  downloads: DownloadItem[];
  stateVersion?: number;
  /** Lista completa de IDs (presente solo en snapshots incrementales). */
  allIds?: number[];
  /** true si el snapshot es incremental. */
  isIncremental?: boolean;
}

export interface OverwriteInfoEntry {
  existingSize?: number;
  expectedSize?: number;
}

export interface FileToDownload {
  id: number;
  title?: string;
  url?: string;
}

export interface FolderToDownload {
  id: number;
  title?: string;
}

// ---------------------------------------------------------------------------
// Ordenamiento (orden de estados: shared/constants/queueStateOrder)
// ---------------------------------------------------------------------------

function compareDownloads(
  a: DownloadItem,
  b: DownloadItem,
  sortBy: string,
  direction: 'asc' | 'desc'
): number {
  let comparison = 0;
  switch (sortBy) {
    case 'name':
      comparison = (a.title ?? '').localeCompare(b.title ?? '');
      break;
    case 'size': {
      const sizeA = a.totalBytes ?? a.total_bytes ?? 0;
      const sizeB = b.totalBytes ?? b.total_bytes ?? 0;
      comparison = sizeA - sizeB;
      break;
    }
    case 'progress':
      comparison = (a.progress ?? 0) - (b.progress ?? 0);
      break;
    case 'date': {
      const dateA = a.createdAt ?? a.created_at ?? a.updatedAt ?? a.updated_at ?? 0;
      const dateB = b.createdAt ?? b.created_at ?? b.updatedAt ?? b.updated_at ?? 0;
      comparison = dateA - dateB;
      break;
    }
    case 'priority':
      comparison = (a.priority ?? 1) - (b.priority ?? 1);
      break;
    default:
      comparison = 0;
  }
  return direction === 'desc' ? -comparison : comparison;
}

function sortDownloads(
  downloads: DownloadItem[],
  sortBy: string,
  direction: string
): DownloadItem[] {
  if (!downloads || !Array.isArray(downloads)) return [];
  const dir = direction === 'asc' ? 'asc' : 'desc';
  return [...downloads].sort((a, b) => {
    const stateOrderA = getStateOrder(a.state);
    const stateOrderB = getStateOrder(b.state);
    if (stateOrderA !== stateOrderB) return stateOrderA - stateOrderB;
    return compareDownloads(a, b, sortBy, dir);
  });
}

// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------

export interface FolderAddProgressState {
  added: number;
  total: number;
  folderTitle?: string;
}

interface GlobalState {
  downloads: DownloadItem[];
  stateVersion: number;
  isInitialized: boolean;
  selectedDownloads: Set<number>;
  selectedHistoryDownloads: Set<number>;
  showingDownloads: boolean;
  /** true cuando getDownloadState devolvió más descargas de las mostradas (límite 500). */
  snapshotTruncated?: boolean;
  /** Total de descargas cuando snapshotTruncated es true. */
  snapshotTotalCount?: number;
}

const globalState = reactive<GlobalState>({
  downloads: [],
  stateVersion: 0,
  isInitialized: false,
  selectedDownloads: new Set<number>(),
  selectedHistoryDownloads: new Set<number>(),
  showingDownloads: false,
});

/** Progreso visible al añadir carpeta en segundo plano (eventos folder-add-*). */
const folderAddProgress = ref<FolderAddProgressState | null>(null);

const overwriteInfo = reactive<Record<number, OverwriteInfoEntry>>({});

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

/**
 * Composable de gestión de descargas: cola, estado, progreso, confirmaciones y acciones (añadir, pausar, reanudar, cancelar, etc.).
 * Sincroniza con el backend vía getDownloadState y eventos IPC (download-state-changed, download-progress, …).
 *
 * U1: lista ordenada memoizada por (stateVersion, sortBy, sortDirection); solo se re-ordena cuando cambian,
 * no en cada actualización de progreso (los objetos se mutan in place y la referencia de lista se reutiliza).
 *
 * @returns downloads, allDownloads, downloadQueue, pendingConfirmations, acciones, ordenación, initDownloads, cleanup, etc.
 */
export function useDownloads(): {
  downloads: ComputedRef<DownloadItem[]>;
  allDownloads: ComputedRef<DownloadItem[]>;
  downloadsByFileId: ComputedRef<Record<number, DownloadItem>>;
  downloadQueue: ComputedRef<DownloadItem[]>;
  speedStats: ComputedRef<
    Map<number, { speed?: number; speedBytes?: number; remainingTime?: number; progress?: number }>
  >;
  pendingConfirmations: ComputedRef<
    (DownloadItem & { showNotification: boolean; existingSize: number; expectedSize: number })[]
  >;
  showingDownloads: ComputedRef<boolean>;
  selectedDownloads: ComputedRef<Set<number>>;
  selectedHistoryDownloads: ComputedRef<Set<number>>;
  currentDownloadIndex: Ref<number>;
  activeDownloadCount: ComputedRef<number>;
  averageDownloadSpeed: ComputedRef<number>;
  currentDownloadName: ComputedRef<string>;
  download: (
    _file: FileToDownload,
    _options?: { startPaused?: boolean }
  ) => Promise<{ success: boolean; error?: string }>;
  downloadFolder: (
    _folderParams: FolderToDownload,
    _options?: { deferStart?: boolean }
  ) => Promise<unknown>;
  pauseDownload: (_id: number) => Promise<void>;
  resumeDownload: (_id: number) => Promise<void>;
  cancelDownload: (_id: number) => Promise<void>;
  retryDownload: (_id: number) => Promise<void>;
  confirmOverwrite: (_id: number) => Promise<void>;
  cancelOverwrite: (_id: number) => Promise<void>;
  confirmOverwriteAll: () => Promise<void>;
  cancelOverwriteAll: () => Promise<void>;
  removeDownload: (_id: number) => Promise<void>;
  removeFromHistory: (_id: number) => Promise<void>;
  clearDownloads: () => Promise<void>;
  restartStoppedWithOverwrite: () => Promise<void>;
  restartSelectedWithOverwrite: (_ids: number[]) => Promise<void>;
  pauseAllDownloads: () => Promise<void>;
  resumeAllDownloads: () => Promise<void>;
  cancelAllDownloads: () => Promise<void>;
  pauseSelected: (_ids: number[]) => Promise<void>;
  resumeSelected: (_ids: number[]) => Promise<void>;
  cancelSelected: (_ids: number[]) => Promise<void>;
  removeSelected: (_ids: number[]) => Promise<void>;
  toggleSelectDownload: (_id: number) => void;
  toggleSelectHistoryDownload: (_id: number) => void;
  toggleSelectAllHistoryDownloads: () => void;
  sortBy: Ref<string>;
  sortDirection: Ref<'asc' | 'desc'>;
  setSortBy: (_sortBy: string) => void;
  setSortDirection: (_direction: string) => void;
  toggleSortDirection: () => void;
  sortByColumn: (_column: string) => void;
  initDownloads: () => Promise<void>;
  cleanup: () => void;
  folderAddProgress: Ref<FolderAddProgressState | null>;
  setFolderAddProgressInBackground: (_total: number, _folderTitle?: string) => void;
  snapshotTruncated: ComputedRef<boolean>;
  snapshotTotalCount: ComputedRef<number>;
} {
  const log = logger.child('UseDownloads');

  /** Obtiene window.api solo si está definido y expone getDownloadState y on (evita fallos en app empaquetada). */
  const getApi = (): PreloadApi | undefined => {
    if (typeof window === 'undefined') return undefined;
    const api = (window as unknown as { api?: PreloadApi }).api;
    if (!api || typeof api.getDownloadState !== 'function' || typeof api.on !== 'function') {
      return undefined;
    }
    return api;
  };

  const unsubscribeFns: (() => void)[] = [];
  const {
    downloadPath,
    preserveStructure,
    showNotifications: _showNotifications,
    selectDownloadFolder,
    downloadsSortBy,
    downloadsSortDirection,
  } = useSettings();

  /** Lista completa ordenada; solo se re-ordena cuando cambian stateVersion o criterios de orden (U1). */
  const sortedAllDownloads = ref<DownloadItem[]>([]);

  const updateSortedList = (): void => {
    sortedAllDownloads.value = sortDownloads(
      globalState.downloads,
      downloadsSortBy.value,
      downloadsSortDirection.value
    );
  };

  watch(
    [() => globalState.stateVersion, downloadsSortBy, downloadsSortDirection],
    updateSortedList,
    { immediate: true }
  );

  const allDownloads = computed(() => sortedAllDownloads.value);

  const ACTIVE_OR_PAUSED_STATES = [
    'queued',
    'starting',
    'downloading',
    'pausing',
    'resuming',
    'merging',
    'verifying',
    'progressing',
  ];

  const downloads = computed(() =>
    sortedAllDownloads.value.filter(
      d => ACTIVE_OR_PAUSED_STATES.includes(d.state ?? '') || d.state === 'paused'
    )
  );

  const downloadQueue = computed(() => globalState.downloads.filter(d => d.state === 'queued'));

  const downloadsByFileId = computed(() => {
    const map: Record<number, DownloadItem> = {};
    for (const d of globalState.downloads) {
      map[d.id] = d;
    }
    return map;
  });

  const activeDownloads = computed(() =>
    globalState.downloads.filter(d =>
      ['downloading', 'merging', 'verifying'].includes(d.state ?? '')
    )
  );

  const pendingConfirmations = computed(() =>
    globalState.downloads
      .filter(d => d.state === 'paused' && d.lastError === 'requires_overwrite_confirmation')
      .map(d => ({
        ...d,
        showNotification: true,
        existingSize: overwriteInfo[d.id]?.existingSize ?? d.downloadedBytes ?? 0,
        expectedSize: overwriteInfo[d.id]?.expectedSize ?? d.totalBytes ?? 0,
      }))
  );

  const activeDownloadCount = computed(() => activeDownloads.value.length);

  const averageDownloadSpeed = computed(() => {
    if (activeDownloadCount.value === 0) return 0;
    return activeDownloads.value.reduce((acc, d) => acc + (d.speed ?? 0), 0);
  });

  const currentDownloadName = computed(() => {
    const active = activeDownloads.value;
    if (active.length === 0) return '';
    if (active.length === 1) return active[0].title ?? '';
    return `${active[0].title ?? ''} y ${active.length - 1} más`;
  });

  const showingDownloads = computed({
    get: () => globalState.showingDownloads,
    set: (val: boolean) => {
      globalState.showingDownloads = val;
    },
  });

  const selectedDownloads = computed(() => globalState.selectedDownloads);
  const selectedHistoryDownloads = computed(() => globalState.selectedHistoryDownloads);

  const speedStats = computed(() => {
    const map = new Map<
      number,
      { speed?: number; speedBytes?: number; remainingTime?: number; progress?: number }
    >();
    globalState.downloads.forEach(d => {
      if (d.speed !== undefined) {
        map.set(d.id, {
          speed: d.speed,
          speedBytes: d.speedBytesPerSec,
          remainingTime: d.remainingTime,
          progress: d.progress,
        });
      }
    });
    return map;
  });

  const mapStateToQueueStatus = (state: string | undefined): string => {
    if (!state) return 'queued';
    const s = state.toLowerCase();
    if (['starting', 'progressing', 'merging', 'verifying', 'downloading'].includes(s)) {
      return 'downloading';
    }
    if (s === 'failed') return 'error';
    if (s === 'canceled') return 'cancelled';
    return s;
  };

  const updateState = (snapshot: DownloadSnapshot | null | undefined): void => {
    if (!snapshot) return;
    const currentVersion = globalState.stateVersion ?? 0;
    const newVersion = snapshot.stateVersion ?? 0;
    if (currentVersion > 0 && newVersion < currentVersion) return;

    const withMeta = snapshot as DownloadStateSnapshot;

    // Snapshot incremental: merge en lugar de reemplazo para evitar parpadeos
    if (withMeta.isIncremental && withMeta.allIds) {
      const allIdsSet = new Set(withMeta.allIds);

      // 1. Eliminar descargas que ya no existen en el backend
      globalState.downloads = globalState.downloads.filter(d => allIdsSet.has(d.id));

      // 2. Actualizar o agregar descargas que cambiaron
      const changedDownloads = snapshot.downloads ?? [];
      for (const changed of changedDownloads) {
        if (changed.state) changed.state = changed.state.toLowerCase();
        changed.queueStatus = mapStateToQueueStatus(changed.state);
        if (changed.queueStatus === 'error' && !changed.error) {
          changed.error = changed.lastError ?? 'Error desconocido';
        }
        const existingIdx = globalState.downloads.findIndex(d => d.id === changed.id);
        if (existingIdx >= 0) {
          globalState.downloads[existingIdx] = changed;
        } else {
          globalState.downloads.push(changed);
        }
      }
    } else {
      // Snapshot completo: reemplazo total, pero preservar progreso en vivo de descargas activas
      // para evitar que al eliminar otra descarga se sobrescriba el progreso con datos de la DB (stale)
      const newDownloads = snapshot.downloads ?? [];
      const activeStates = new Set([
        'downloading',
        'starting',
        'merging',
        'verifying',
        'progressing',
      ]);
      const currentById = new Map(globalState.downloads.map(d => [d.id, d]));
      for (const d of newDownloads) {
        const state = (d.state ?? '').toLowerCase();
        if (activeStates.has(state)) {
          const current = currentById.get(d.id);
          if (current) {
            const curProgress = current.progress ?? current.percent ?? 0;
            const curBytes = current.downloadedBytes ?? 0;
            const newProgress = d.progress ?? d.percent ?? 0;
            const newBytes = d.downloadedBytes ?? 0;
            if (curBytes > newBytes || curProgress > newProgress) {
              if (current.progress != null) d.progress = current.progress;
              if (current.percent != null) d.percent = current.percent;
              if (current.downloadedBytes != null) d.downloadedBytes = current.downloadedBytes;
              if (current.speed != null) d.speed = current.speed;
              if (current.speedBytesPerSec != null) d.speedBytesPerSec = current.speedBytesPerSec;
              if (current.remainingTime != null) d.remainingTime = current.remainingTime;
              if (current.chunkProgress != null) d.chunkProgress = current.chunkProgress;
              if (current.activeChunks != null) d.activeChunks = current.activeChunks;
              if (current.completedChunks != null) d.completedChunks = current.completedChunks;
              if (current.totalChunks != null) d.totalChunks = current.totalChunks;
              if (current.mergeProgress != null) d.mergeProgress = current.mergeProgress;
              if (current.mergeSpeed != null) d.mergeSpeed = current.mergeSpeed;
              if (current.currentChunk != null) d.currentChunk = current.currentChunk;
              if (current.bytesProcessed != null) d.bytesProcessed = current.bytesProcessed;
            }
          }
        }
      }
      globalState.downloads = newDownloads;
      globalState.downloads.forEach(d => {
        if (d.state) d.state = d.state.toLowerCase();
        d.queueStatus = mapStateToQueueStatus(d.state);
        if (d.queueStatus === 'error' && !d.error) {
          d.error = d.lastError ?? 'Error desconocido';
        }
      });
    }

    globalState.stateVersion = snapshot.stateVersion ?? 0;
    globalState.snapshotTruncated = withMeta.truncated;
    globalState.snapshotTotalCount =
      withMeta.totalCount ??
      (typeof withMeta.summary?.total === 'number'
        ? withMeta.summary.total
        : globalState.downloads.length);

    // M1: limpiar overwriteInfo de IDs que ya no están en la cola (evitar acumulación en sesiones largas)
    const downloadIds = new Set(globalState.downloads.map(d => d.id));
    for (const idStr of Object.keys(overwriteInfo)) {
      const id = Number(idStr);
      if (!downloadIds.has(id)) delete overwriteInfo[id];
    }
  };

  const ensureDownloadPath = async (): Promise<{ ok: boolean; error?: string }> => {
    if (
      !downloadPath.value ||
      (typeof downloadPath.value === 'string' && downloadPath.value.trim().length === 0)
    ) {
      log.info('No hay ruta de descarga configurada. Solicitando carpeta al usuario...');
      await selectDownloadFolder();
    }
    if (
      !downloadPath.value ||
      (typeof downloadPath.value === 'string' && downloadPath.value.trim().length === 0)
    ) {
      const errorMessage =
        'No se ha seleccionado ninguna carpeta de destino. Selecciona una ubicación para guardar las descargas.';
      log.warn(errorMessage);
      return { ok: false, error: errorMessage };
    }
    return { ok: true };
  };

  const download = async (
    file: FileToDownload,
    options: { startPaused?: boolean } = {}
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      log.info(`Solicitando descarga: ${file.title}`);
      const pathCheck = await ensureDownloadPath();
      if (!pathCheck.ok) return { success: false, error: pathCheck.error };

      const params: AddDownloadParams = {
        id: file.id,
        title: file.title ?? '',
        url: file.url,
        downloadPath: downloadPath.value,
        preserveStructure: preserveStructure.value,
      };
      if (options.startPaused === true)
        (params as AddDownloadParams & { startPaused?: boolean }).startPaused = true;

      const api = getApi();
      if (!api) return { success: false, error: 'API de Electron no disponible' };
      const result = await api.addDownload(params);
      if (result.success) return { success: true };
      const err = result as { error?: string };
      log.error('Error al agregar descarga:', err.error);
      return { success: false, error: err.error };
    } catch (error) {
      log.error('Excepción al agregar descarga:', error);
      return { success: false, error: (error as Error).message };
    }
  };

  const downloadFolder = async (
    folderParams: FolderToDownload,
    options: { deferStart?: boolean } = {}
  ): Promise<unknown> => {
    const pathCheck = await ensureDownloadPath();
    if (!pathCheck.ok) return { success: false, error: pathCheck.error };
    const params: DownloadFolderParams = {
      folderId: folderParams.id,
      downloadPath: downloadPath.value,
      preserveStructure: preserveStructure.value,
    };
    if (options.deferStart === true) params.deferStart = true;
    const api = getApi();
    if (!api) return { success: false, error: 'API de Electron no disponible' };
    return await api.downloadFolder(params);
  };

  const pauseDownload = async (id: number): Promise<void> => {
    const api = getApi();
    if (api) await api.pauseDownloadState(id);
  };

  const resumeDownload = async (id: number): Promise<void> => {
    const api = getApi();
    if (api) await api.resumeDownloadState(id);
  };

  const cancelDownload = async (id: number): Promise<void> => {
    const api = getApi();
    if (api) await api.cancelDownloadState(id);
  };

  const retryDownload = async (id: number): Promise<void> => {
    const download = globalState.downloads.find(d => d.id === id);
    if (!download) return;
    const state = (download.state ?? '').toLowerCase();
    const lastError = download.lastError ?? '';

    const api = getApi();
    if (!api) return;
    if (state === 'paused' && lastError === 'requires_overwrite_confirmation') {
      await api.confirmOverwriteState(id);
    } else if (state === 'paused' || state === 'queued') {
      await api.resumeDownloadState(id);
    } else if (state === 'completed') {
      await api.addDownload({
        id: download.id,
        title: download.title ?? '',
        downloadPath: downloadPath.value,
        preserveStructure: preserveStructure.value,
        forceOverwrite: false,
      });
    } else if (state === 'cancelled' || state === 'failed') {
      await api.resumeDownloadState(id);
    }
  };

  const confirmOverwrite = async (id: number): Promise<void> => {
    const api = getApi();
    if (api) await api.confirmOverwriteState(id);
    delete overwriteInfo[id];
  };

  const cancelOverwrite = async (id: number): Promise<void> => {
    const api = getApi();
    if (api) await api.cancelDownloadState(id);
    delete overwriteInfo[id];
  };

  const removeDownload = async (id: number): Promise<void> => {
    const api = getApi();
    if (!api) return;
    try {
      const res = (await api.deleteDownloadState(id)) as {
        success?: boolean;
        snapshot?: DownloadSnapshot;
        data?: { snapshot?: DownloadSnapshot; data?: { snapshot?: DownloadSnapshot } };
      };
      if (!res?.success) return;
      // Aplicar snapshot de la respuesta (backend devuelve { success, snapshot } o anidado en data)
      const snapshot =
        res?.snapshot ??
        res?.data?.data?.snapshot ??
        (res?.data as { snapshot?: DownloadSnapshot } | undefined)?.snapshot;
      if (snapshot?.downloads) {
        updateState(snapshot);
        // No hacer getDownloadState() tras eliminar: el snapshot ya actualizó la lista y
        // un refetch sobrescribiría el progreso en vivo de la descarga activa con datos de la DB.
      } else {
        // Si no llegó snapshot, refrescar desde el backend para no quedar desincronizado
        const stateRes = await api.getDownloadState();
        if (stateRes?.success && stateRes?.data)
          applySnapshot(stateRes.data as DownloadStateSnapshot);
      }
    } catch (e) {
      log.error('Error al eliminar descarga de la lista:', e);
    }
  };

  const applySnapshot = (data: DownloadStateSnapshot | undefined): void => {
    if (data?.downloads) updateState(data as DownloadSnapshot);
  };

  const pauseAllDownloads = async (): Promise<void> => {
    const api = getApi();
    if (!api) return;
    try {
      const result = await api.pauseAllDownloads();
      if (result?.data) applySnapshot(result.data);
      else {
        const res = await api.getDownloadState();
        if (res?.success && res?.data) applySnapshot(res.data);
      }
    } catch (e) {
      log.error('Error pausando todas las descargas:', e);
      const res = await api.getDownloadState();
      if (res?.success && res?.data) applySnapshot(res.data);
    }
  };

  const resumeAllDownloads = async (): Promise<void> => {
    const api = getApi();
    if (!api) return;
    try {
      const result = await api.resumeAllDownloads();
      if (result?.data) applySnapshot(result.data);
      else {
        const res = await api.getDownloadState();
        if (res?.success && res?.data) applySnapshot(res.data);
      }
    } catch (e) {
      log.error('Error reanudando todas las descargas:', e);
      const res = await api.getDownloadState();
      if (res?.success && res?.data) applySnapshot(res.data);
    }
  };

  const cancelAllDownloads = async (): Promise<void> => {
    const api = getApi();
    if (!api) return;
    try {
      const result = await api.cancelAllDownloads();
      if (result?.success && result?.data) applySnapshot(result.data);
      else {
        const res = await api.getDownloadState();
        if (res?.success && res?.data) applySnapshot(res.data);
      }
    } catch (e) {
      log.error('Error cancelando todas las descargas:', e);
      const res = await api.getDownloadState();
      if (res?.success && res?.data) applySnapshot(res.data);
    }
  };

  const pauseSelected = async (ids: number[]): Promise<void> => {
    const api = getApi();
    if (!api) return;
    for (const id of ids) {
      await api.pauseDownloadState(id);
    }
    const res = await api.getDownloadState();
    if (res?.success && res?.data) applySnapshot(res.data);
  };

  const resumeSelected = async (ids: number[]): Promise<void> => {
    const api = getApi();
    if (!api) return;
    for (const id of ids) {
      await api.resumeDownloadState(id);
    }
    const res = await api.getDownloadState();
    if (res?.success && res?.data) applySnapshot(res.data);
  };

  const cancelSelected = async (ids: number[]): Promise<void> => {
    const api = getApi();
    if (!api) return;
    for (const id of ids) {
      await api.cancelDownloadState(id);
    }
    const res = await api.getDownloadState();
    if (res?.success && res?.data) applySnapshot(res.data);
  };

  const removeSelected = async (ids: number[]): Promise<void> => {
    const api = getApi();
    if (!api) return;
    for (const id of ids) {
      await removeDownload(id);
    }
    ids.forEach(id => globalState.selectedHistoryDownloads.delete(id));
  };

  const clearDownloads = async (): Promise<void> => {
    const api = getApi();
    if (!api) return;
    try {
      const res = (await api.clearDownloadsState()) as {
        success?: boolean;
        data?: { snapshot?: DownloadSnapshot; data?: { snapshot?: DownloadSnapshot } };
        snapshot?: DownloadStateSnapshot;
      };
      if (res?.success) {
        const snapshot =
          res.snapshot ??
          res?.data?.data?.snapshot ??
          (res?.data as { snapshot?: DownloadSnapshot } | undefined)?.snapshot;
        if (snapshot?.downloads) {
          applySnapshot(snapshot);
          // No refetch: el snapshot ya actualiza la lista y evitaría sobrescribir progreso en vivo
        } else {
          const result = await api.getDownloadState();
          if (result?.success && result?.data) applySnapshot(result.data as DownloadStateSnapshot);
        }
      }
    } catch (e) {
      log.error('Error clearing downloads:', e);
    }
  };

  const restartStoppedWithOverwrite = async (): Promise<void> => {
    const api = getApi();
    if (!api) return;
    try {
      const res = (await api.restartStoppedWithOverwrite()) as {
        success?: boolean;
        data?: DownloadStateSnapshot;
        snapshot?: DownloadStateSnapshot;
      };
      if (res?.success) {
        const snapshot = res.snapshot ?? res?.data;
        if (snapshot?.downloads) {
          applySnapshot(snapshot);
        } else {
          const result = await api.getDownloadState();
          if (result?.success && result?.data) applySnapshot(result.data as DownloadStateSnapshot);
        }
      }
    } catch (e) {
      log.error('Error reiniciando descargas detenidas:', e);
    }
  };

  const restartSelectedWithOverwrite = async (ids: number[]): Promise<void> => {
    const api = getApi();
    if (!api || ids.length === 0) return;
    try {
      const res = (await api.restartStoppedWithOverwrite(ids)) as {
        success?: boolean;
        data?: DownloadStateSnapshot;
        snapshot?: DownloadStateSnapshot;
      };
      if (res?.success) {
        const snapshot = res.snapshot ?? res?.data;
        if (snapshot?.downloads) {
          applySnapshot(snapshot);
        } else {
          const result = await api.getDownloadState();
          if (result?.success && result?.data) applySnapshot(result.data as DownloadStateSnapshot);
        }
      }
    } catch (e) {
      log.error('Error reiniciando descargas seleccionadas:', e);
    }
  };

  const removeFromHistory = async (id: number): Promise<void> => {
    await removeDownload(id);
  };

  const confirmOverwriteAll = async (): Promise<void> => {
    for (const d of pendingConfirmations.value) {
      await confirmOverwrite(d.id);
    }
  };

  const cancelOverwriteAll = async (): Promise<void> => {
    for (const d of pendingConfirmations.value) {
      await cancelOverwrite(d.id);
    }
  };

  const toggleSelectDownload = (id: number): void => {
    if (globalState.selectedDownloads.has(id)) {
      globalState.selectedDownloads.delete(id);
    } else {
      globalState.selectedDownloads.add(id);
    }
  };

  const toggleSelectHistoryDownload = (id: number): void => {
    if (globalState.selectedHistoryDownloads.has(id)) {
      globalState.selectedHistoryDownloads.delete(id);
    } else {
      globalState.selectedHistoryDownloads.add(id);
    }
  };

  const toggleSelectAllHistoryDownloads = (): void => {
    if (globalState.selectedHistoryDownloads.size === globalState.downloads.length) {
      globalState.selectedHistoryDownloads.clear();
    } else {
      globalState.downloads.forEach(d => globalState.selectedHistoryDownloads.add(d.id));
    }
  };

  const initDownloads = async (): Promise<void> => {
    if (globalState.isInitialized) return;
    const api = getApi();
    if (!api) {
      log.warn(
        'window.api no disponible o incompleto; descargas no inicializadas (ejecuta la app con Electron)'
      );
      globalState.isInitialized = true;
      return;
    }
    try {
      const result = await api.getDownloadState();
      if (result?.success && result.data) applySnapshot(result.data);
    } catch (e) {
      log.error('Error cargando estado inicial:', e);
    }

    let stateChangeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    const STATE_CHANGE_DEBOUNCE_MS = 80;

    /** E2: un solo fetch debounced para state-changed, completed, failed, chunk-failed, folder-add-complete. */
    const scheduleStateFetch = (): void => {
      if (stateChangeDebounceTimer) clearTimeout(stateChangeDebounceTimer);
      stateChangeDebounceTimer = setTimeout(() => {
        stateChangeDebounceTimer = null;
        api.getDownloadState(globalState.stateVersion).then(res => {
          if (res?.success && res.data) applySnapshot(res.data);
        });
      }, STATE_CHANGE_DEBOUNCE_MS);
    };

    unsubscribeFns.push(
      api.on('download-state-changed', (payload: DownloadStateChangedPayload) => {
        const stateVersion = payload?.stateVersion;
        const currentVersion = globalState.stateVersion ?? 0;
        if (stateVersion != null && stateVersion <= currentVersion) return;
        scheduleStateFetch();
      })
    );

    const applyProgressUpdate = (data: DownloadProgressPayload) => {
      const index = globalState.downloads.findIndex(d => d.id === data.id);
      if (index !== -1) {
        const target = globalState.downloads[index];
        Object.assign(target, data);
        if (data.state) target.state = data.state.toLowerCase();
        target.queueStatus = mapStateToQueueStatus(target.state);
      }
    };

    unsubscribeFns.push(
      api.on('download-progress', (data: DownloadProgressPayload) => {
        applyProgressUpdate(data);
      })
    );

    unsubscribeFns.push(
      api.on('download-progress-batch', (payload: DownloadProgressBatchPayload) => {
        if (payload?.updates && Array.isArray(payload.updates)) {
          payload.updates.forEach(applyProgressUpdate);
        }
      })
    );

    unsubscribeFns.push(
      api.on('download-completed', () => {
        scheduleStateFetch();
      })
    );

    unsubscribeFns.push(
      api.on('download-failed', (data: DownloadFailedPayload) => {
        if (data?.failedDuringMerge && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(
            new CustomEvent('download-failed-merge', {
              detail: { id: data.id, error: data.error },
            })
          );
        }
        scheduleStateFetch();
      })
    );

    unsubscribeFns.push(
      api.on('chunk-failed', (p: ChunkFailedPayload) => {
        scheduleStateFetch();
        if (p && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(
            new CustomEvent('chunk-failed', {
              detail: {
                downloadId: p.downloadId,
                chunkIndex: p.chunkIndex,
                error: p.error,
                willRetry: p.willRetry,
              },
            })
          );
        }
      })
    );

    unsubscribeFns.push(
      api.on('needs-confirmation', (d: NeedsConfirmationPayload) => {
        if (d && typeof d.id !== 'undefined') {
          overwriteInfo[d.id] = {
            existingSize: d.existingSize ?? 0,
            expectedSize: d.expectedSize ?? 0,
          };
        }
      })
    );

    unsubscribeFns.push(
      api.on('folder-add-progress', (p: FolderAddProgressPayload) => {
        if (
          p &&
          typeof p.added === 'number' &&
          typeof p.total === 'number' &&
          folderAddProgress.value
        ) {
          folderAddProgress.value = {
            ...folderAddProgress.value,
            added: p.added,
            total: p.total,
          };
        }
      })
    );

    unsubscribeFns.push(
      api.on('folder-add-complete', (_p: FolderAddCompletePayload) => {
        folderAddProgress.value = null;
        scheduleStateFetch();
      })
    );

    globalState.isInitialized = true;
    log.info('Sistema de descargas inicializado del lado del cliente');
  };

  const cleanup = (): void => {
    unsubscribeFns.forEach(fn => {
      try {
        if (typeof fn === 'function') fn();
      } catch (e) {
        log.warn('Error removiendo listener de descargas:', e);
      }
    });
    unsubscribeFns.length = 0;
    globalState.isInitialized = false;
  };

  const setSortBy = (sortBy: string): void => {
    const validOptions = ['name', 'size', 'progress', 'date', 'priority'];
    if (validOptions.includes(sortBy)) downloadsSortBy.value = sortBy;
  };

  const setSortDirection = (direction: string): void => {
    downloadsSortDirection.value = direction === 'asc' ? 'asc' : 'desc';
  };

  const toggleSortDirection = (): void => {
    downloadsSortDirection.value = downloadsSortDirection.value === 'asc' ? 'desc' : 'asc';
  };

  const sortByColumn = (column: string): void => {
    if (downloadsSortBy.value === column) {
      toggleSortDirection();
    } else {
      setSortBy(column);
      if (column === 'name') downloadsSortDirection.value = 'asc';
      else if (column === 'date') downloadsSortDirection.value = 'desc';
      else if (column === 'progress') downloadsSortDirection.value = 'desc';
      else if (column === 'size') downloadsSortDirection.value = 'asc';
      else if (column === 'priority') downloadsSortDirection.value = 'desc';
    }
  };

  /** Llamar cuando downloadFolder devuelve processingInBackground para mostrar progreso. */
  const setFolderAddProgressInBackground = (total: number, folderTitle?: string): void => {
    folderAddProgress.value = { added: 0, total, folderTitle };
  };

  const currentDownloadIndex = ref(-1);

  const snapshotTruncated = computed(() => globalState.snapshotTruncated === true);
  const snapshotTotalCount = computed(() => globalState.snapshotTotalCount ?? 0);

  return {
    downloads: computed(() => downloads.value),
    allDownloads,
    downloadsByFileId,
    downloadQueue,
    speedStats,
    pendingConfirmations,
    showingDownloads,
    selectedDownloads,
    selectedHistoryDownloads,
    currentDownloadIndex,
    activeDownloadCount,
    averageDownloadSpeed,
    currentDownloadName,
    download,
    downloadFolder,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    retryDownload,
    confirmOverwrite,
    cancelOverwrite,
    confirmOverwriteAll,
    cancelOverwriteAll,
    removeDownload,
    removeFromHistory,
    clearDownloads,
    restartStoppedWithOverwrite,
    restartSelectedWithOverwrite,
    pauseAllDownloads,
    resumeAllDownloads,
    cancelAllDownloads,
    pauseSelected,
    resumeSelected,
    cancelSelected,
    removeSelected,
    toggleSelectDownload,
    toggleSelectHistoryDownload,
    toggleSelectAllHistoryDownloads,
    sortBy: downloadsSortBy,
    sortDirection: downloadsSortDirection,
    setSortBy,
    setSortDirection,
    toggleSortDirection,
    sortByColumn,
    initDownloads,
    cleanup,
    folderAddProgress,
    setFolderAddProgressInBackground,
    snapshotTruncated,
    snapshotTotalCount,
  };
}

export default useDownloads;
