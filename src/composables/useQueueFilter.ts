/**
 * Composable: filtrado y búsqueda en la cola de descargas.
 *
 * Extraído de App.vue para reducir la complejidad del componente raíz
 * y mejorar la mantenibilidad.
 *
 * Debounce del término de búsqueda (QUEUE_SEARCH_DEBOUNCE_MS) para no filtrar en cada
 * keystroke y reducir trabajo en el hilo principal (auditoría performance U5).
 *
 * @module useQueueFilter
 */

import { ref, computed, watch, onUnmounted, type Ref } from 'vue';

/** Estados que mapea cada opción del filtro de estado. */
const QUEUE_STATE_FILTER_MAP: Record<string, string[]> = {
  downloading: ['downloading', 'starting', 'progressing', 'merging', 'verifying', 'resuming'],
  queued: ['queued'],
  paused: ['paused', 'pausing'],
  awaiting: ['awaiting'],
  completed: ['completed'],
  cancelled: ['cancelled', 'canceled'],
  error: ['failed', 'error'],
};

/** Debounce (ms) para el término de búsqueda en la cola; el filtrado usa el valor debounced. */
const QUEUE_SEARCH_DEBOUNCE_MS = 150;

interface DownloadLike {
  state?: string;
  title?: string;
  name?: string;
  fileName?: string;
  savePath?: string;
  save_path?: string;
  downloadPath?: string;
  url?: string;
}

/**
 * Composable de filtrado de la cola de descargas por estado y término de búsqueda.
 * Preserva el tipo de elemento para que la salida sea asignable a DownloadItemRecord[].
 * @param allDownloads - Ref con la lista completa de descargas.
 * @returns queueSearchTerm, queueStateFilter, availableQueueStateFilters, filteredDownloadsForQueue.
 */
export function useQueueFilter<T extends DownloadLike>(allDownloads: Ref<T[]>) {
  const queueSearchTerm = ref('');
  const queueStateFilter = ref('');

  /** Valor debounced del término de búsqueda; el filtro usa este para no correr en cada tecla. */
  const queueSearchTermDebounced = ref('');

  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  watch(queueSearchTerm, newVal => {
    if (searchDebounceTimer !== null) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    searchDebounceTimer = setTimeout(() => {
      queueSearchTermDebounced.value = newVal;
      searchDebounceTimer = null;
    }, QUEUE_SEARCH_DEBOUNCE_MS);
  });

  onUnmounted(() => {
    if (searchDebounceTimer !== null) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
  });

  /** Opciones de filtro que tienen al menos 1 descarga (evita mostrar opciones vacías). */
  const availableQueueStateFilters = computed(() => {
    const list = allDownloads.value;
    const available: string[] = [];
    for (const key of Object.keys(QUEUE_STATE_FILTER_MAP)) {
      const states = new Set(QUEUE_STATE_FILTER_MAP[key].map(s => s.toLowerCase()));
      const hasAny = list.some(d => states.has((d.state || '').toLowerCase()));
      if (hasAny) available.push(key);
    }
    return available;
  });

  /** Cola filtrada por estado y término de búsqueda (término con debounce). */
  const filteredDownloadsForQueue = computed(() => {
    let list = allDownloads.value;

    const stateFilter = (queueStateFilter.value || '').trim();
    if (stateFilter && QUEUE_STATE_FILTER_MAP[stateFilter]) {
      const allowedStates = new Set(QUEUE_STATE_FILTER_MAP[stateFilter].map(s => s.toLowerCase()));
      list = list.filter(d => allowedStates.has((d.state || '').toLowerCase()));
    }

    const term = (queueSearchTermDebounced.value || '').trim().toLowerCase();
    if (!term) return list;

    return list.filter(d => {
      const title = (d.title || d.name || d.fileName || '').toLowerCase();
      const path = (d.savePath || d.save_path || d.downloadPath || '').toLowerCase();
      const url = (d.url || '').toLowerCase();
      return title.includes(term) || path.includes(term) || url.includes(term);
    });
  });

  return {
    queueSearchTerm,
    queueStateFilter,
    availableQueueStateFilters,
    filteredDownloadsForQueue,
    /** Mapa exportado para uso externo (e.g. watchs que verifican si un filtro aún es válido). */
    QUEUE_STATE_FILTER_MAP,
  };
}
