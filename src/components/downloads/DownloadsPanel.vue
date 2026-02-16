<template>
  <div
    v-if="totalDownloadCount > 0"
    id="downloads-section"
    class="downloads-container"
  >
    <div class="downloads-header">
      <div class="header-info">
        <h2>{{ t('downloadsPanel.title') }}</h2>
        <div class="queue-state-filter-wrap">
          <select
            v-model="stateFilterValue"
            class="queue-state-filter"
            :title="t('downloadsPanel.filterByState')"
            :aria-label="t('downloadsPanel.filterByState')"
          >
            <option value="">{{ t('queue.all') }}</option>
            <option
              v-for="key in availableStateFilters"
              :key="key"
              :value="key"
            >
              {{ stateFilterLabels[key] || key }}
            </option>
          </select>
        </div>
        <span class="count-badge">
          <template v-if="snapshotTruncated && snapshotTotalCount > 0">
            Mostrando {{ downloads.length }} de {{ snapshotTotalCount }} descargas
          </template>
          <template v-else> {{ downloads.length }} total </template>
        </span>
      </div>
      <div class="header-actions">
        <!-- Modo selección: acciones sobre los elementos seleccionados -->
        <template v-if="selectedHistoryDownloads.size > 0">
          <button
            v-if="selectedHasActive"
            class="btn-action-header btn-pause-all glass-effect"
            :title="
              t('downloadsPanel.pauseSelectedTitle', { count: selectedHistoryDownloads.size })
            "
            @click="$emit('pause-selected', Array.from(selectedHistoryDownloads))"
          >
            <Pause :size="18" />
            <span>{{ t('downloadsPanel.pauseSelected') }}</span>
          </button>
          <button
            v-if="selectedHasPaused"
            class="btn-action-header btn-resume-all glass-effect"
            :title="
              t('downloadsPanel.resumeSelectedTitle', { count: selectedHistoryDownloads.size })
            "
            @click="$emit('resume-selected', Array.from(selectedHistoryDownloads))"
          >
            <Play :size="18" />
            <span>{{ t('downloadsPanel.resumeSelected') }}</span>
          </button>
          <button
            v-if="selectedHasActiveOrPaused"
            class="btn-action-header btn-cancel-all glass-effect"
            :title="t('downloadsPanel.stopSelectedTitle', { count: selectedHistoryDownloads.size })"
            @click="$emit('cancel-selected', Array.from(selectedHistoryDownloads))"
          >
            <XOctagon :size="18" />
            <span>{{ t('downloadsPanel.stopSelected') }}</span>
          </button>
          <button
            v-if="selectedHasRestartable"
            class="btn-action-header btn-restart-all glass-effect"
            :title="
              t('downloadsPanel.restartSelectedStoppedTitle', {
                count: selectedHistoryDownloads.size,
              })
            "
            @click="$emit('restart-selected-with-overwrite', Array.from(selectedHistoryDownloads))"
          >
            <RefreshCw :size="18" />
            <span>{{ t('downloadsPanel.restartSelectedStopped') }}</span>
          </button>
          <button
            class="btn-action-header btn-clear-list glass-effect"
            :title="
              t('downloadsPanel.removeSelectedTitle', { count: selectedHistoryDownloads.size })
            "
            @click="onRemoveSelectedRequest"
          >
            <Trash2 :size="18" />
            <span>{{ t('downloadsPanel.removeSelected') }}</span>
          </button>
        </template>

        <!-- Modo global: según estado de toda la cola -->
        <template v-else>
          <!-- 1) Hay descargas en ejecución → solo Pausar todo -->
          <button
            v-if="hasActiveOrQueuedDownloads"
            class="btn-action-header btn-pause-all glass-effect"
            :title="t('downloadsPanel.pauseAllTitle')"
            @click="$emit('pause-all')"
          >
            <Pause :size="18" />
            <span>{{ t('downloadsPanel.pauseAll') }}</span>
          </button>

          <!-- 2) Hay descargas en pausa (y ninguna en ejecución) → Iniciar todo + Detener todo -->
          <template v-else-if="hasPausedOrCancelledDownloads">
            <button
              class="btn-action-header btn-resume-all glass-effect"
              :title="t('downloadsPanel.resumeAllTitle')"
              @click="$emit('resume-all')"
            >
              <Play :size="18" />
              <span>{{ t('downloadsPanel.resumeAll') }}</span>
            </button>
            <button
              class="btn-action-header btn-cancel-all glass-effect"
              :title="t('downloadsPanel.stopAllTitle')"
              @click="$emit('cancel-all-downloads')"
            >
              <XOctagon :size="18" />
              <span>{{ t('downloadsPanel.stopAll') }}</span>
            </button>
          </template>

          <!-- 3) Todas detenidas → Reiniciar (solo si hay canceladas/error) + Limpiar lista -->
          <template v-else-if="allStopped">
            <button
              v-if="hasCancelledOrFailedDownloads"
              class="btn-action-header btn-restart-all glass-effect"
              :title="t('downloadsPanel.restartStoppedTitle')"
              @click="$emit('restart-stopped-with-overwrite')"
            >
              <RefreshCw :size="18" />
              <span>{{ t('downloadsPanel.restartStopped') }}</span>
            </button>
            <button
              class="btn-action-header btn-clear-list glass-effect"
              :title="t('downloadsPanel.clearListTitle')"
              @click="onClearListRequest"
            >
              <Trash2 :size="18" />
              <span>{{ t('downloadsPanel.clearList') }}</span>
            </button>
          </template>
        </template>

        <!-- Buscar: siempre visible -->
        <button
          class="btn-action-header btn-search-queue glass-effect"
          :class="{ active: showQueueSearchBox }"
          :title="t('downloadsPanel.searchTitle')"
          @click="showQueueSearchBox = !showQueueSearchBox"
        >
          <Search :size="18" />
          <span>{{ t('downloadsPanel.search') }}</span>
        </button>
      </div>
    </div>

    <!-- Cuadro de búsqueda desplegable (debajo de la barra de la cola) -->
    <div
      v-show="showQueueSearchBox"
      class="queue-search-bar glass-effect"
      role="search"
    >
      <div class="queue-search-input-group">
        <Search
          class="queue-search-icon"
          :size="18"
        />
        <input
          v-model="queueSearchValue"
          type="text"
          class="queue-search-input"
          :placeholder="t('downloadsPanel.searchPlaceholder')"
          :aria-label="t('searchHeader.filterQueue')"
        />
      </div>
    </div>

    <!-- Bulk Actions (Solo si hay seleccionadas) -->
    <div
      v-if="selectedDownloads.size > 0"
      class="bulk-action-bar glass-effect"
    >
      <div class="bulk-info">
        <CheckSquare :size="16" />
        <span>{{ selectedDownloads.size }} seleccionada(s)</span>
      </div>
      <div class="bulk-btns">
        <button
          class="btn-bulk btn-confirm"
          @click="$emit('confirm-all')"
        >
          {{ t('downloadItem.overwrite') }}
        </button>
        <button
          class="btn-bulk btn-cancel"
          @click="$emit('cancel-all')"
        >
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>

    <!-- Table Container (altura flexible vía CSS en .view-content.fill-height) -->
    <div
      ref="downloadsContainer"
      class="downloads-table-container glass-effect"
      role="region"
      :aria-label="t('downloadsPanel.title')"
      @scroll="handleScroll"
    >
      <table
        class="downloads-table"
        role="table"
      >
        <thead>
          <tr class="glass-effect">
            <th class="checkbox-col">
              <input
                type="checkbox"
                class="form-checkbox checkbox-input"
                :checked="
                  selectedHistoryDownloads.size === downloads.length && downloads.length > 0
                "
                :aria-label="t('downloadsPanel.selectAllDownloads')"
                @change="$emit('toggle-select-all-history', $event)"
              />
            </th>
            <th
              class="name-col sortable-col"
              :class="{ sorted: sortBy === 'name' }"
              :title="t('downloadsPanel.sortByName')"
              @click="$emit('sort-by-column', 'name')"
            >
              <span>{{ t('downloadsPanel.file') }}</span>
              <component
                :is="
                  sortBy === 'name' ? (sortDirection === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
                "
                :size="14"
                class="sort-icon"
              />
            </th>
            <th
              class="progress-col sortable-col"
              :class="{ sorted: sortBy === 'progress' }"
              :title="t('downloadsPanel.sortByProgress')"
              @click="$emit('sort-by-column', 'progress')"
            >
              <span>{{ t('downloadsPanel.progress') }}</span>
              <component
                :is="
                  sortBy === 'progress'
                    ? sortDirection === 'asc'
                      ? ArrowUp
                      : ArrowDown
                    : ArrowUpDown
                "
                :size="14"
                class="sort-icon"
              />
            </th>
            <th class="status-col">{{ t('downloadsPanel.status') }}</th>
            <th class="speed-col">{{ t('downloadsPanel.speed') }}</th>
            <th class="eta-col">{{ t('downloadsPanel.eta') }}</th>
            <th class="actions-col">{{ t('downloadsPanel.actions') }}</th>
          </tr>
        </thead>
        <tbody :style="{ height: shouldVirtualize ? totalHeight : 'auto' }">
          <tr
            v-if="shouldVirtualize && visibleRange.start > 0"
            style="height: 0"
          >
            <td
              :colspan="columnCount"
              :style="{ height: topSpacerHeight + 'px', padding: 0, border: 'none' }"
            />
          </tr>

          <DownloadItem
            v-for="download in visibleItems"
            :key="download.id"
            :download="download"
            :is-selected="selectedHistoryDownloads.has(download.id)"
            :speed-stats="speedStats"
            :show-chunk-progress-settings="showChunkProgress"
            :time-estimates="timeEstimates"
            @toggle-select="$emit('toggle-select-history', $event)"
            @confirm-overwrite="$emit('confirm-overwrite', $event)"
            @cancel-overwrite="$emit('cancel-overwrite', $event)"
            @remove="onRemoveRequest($event)"
            @pause="$emit('pause', $event)"
            @cancel="onCancelRequest($event)"
            @resume="$emit('resume', $event)"
            @retry="onRetryRequest($event)"
            @show-error-detail="errorModalDownloadId = $event"
          />

          <tr
            v-if="shouldVirtualize && visibleRange.end < downloads.length"
            style="height: 0"
          >
            <td
              :colspan="columnCount"
              :style="{ height: bottomSpacerHeight + 'px', padding: 0, border: 'none' }"
            />
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div
    v-else-if="showEmpty"
    class="empty-state glass-effect"
  >
    <div class="empty-state-icon">
      <DownloadCloud :size="64" />
    </div>
    <h3>{{ t('downloadsPanel.emptyTitle') }}</h3>
    <p>{{ t('downloadsPanel.emptyHint') }}</p>
  </div>

  <!-- Modal de detalle de error (descarga fallida) -->
  <DownloadErrorModal
    :show="errorModalDownloadId !== null"
    :download="downloadForErrorModal"
    @close="errorModalDownloadId = null"
    @retry="onErrorModalRetry"
    @remove="onErrorModalRemove"
  />

  <!-- Diálogo de confirmación para Eliminar / Cancelar / Reiniciar -->
  <ConfirmDialog
    :show="actionConfirmShow"
    :title="actionConfirmTitle"
    :message="actionConfirmMessage"
    :confirm-label="actionConfirmLabel"
    :cancel-label="t('nav.back')"
    variant="warning"
    @confirm="onActionConfirmConfirm"
    @cancel="onActionConfirmCancel"
  />
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  Pause,
  Play,
  XOctagon,
  Trash2,
  DownloadCloud,
  CheckSquare,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Search,
  RefreshCw,
} from 'lucide-vue-next';
import { useVirtualScroll } from '../../composables/useVirtualScroll';

const { t } = useI18n();
import type { DownloadItemRecord } from './DownloadItem.vue';
import DownloadItem from './DownloadItem.vue';
import DownloadErrorModal from '../modals/DownloadErrorModal.vue';
import ConfirmDialog from '../modals/ConfirmDialog.vue';

// Props
const props = defineProps({
  downloads: {
    type: Array as PropType<DownloadItemRecord[]>,
    required: true,
  },
  speedStats: {
    type: Map as PropType<Map<number, import('./DownloadItem.vue').SpeedStatsEntry>>,
    default: () => new Map(),
  },
  pendingConfirmations: {
    type: Array,
    default: () => [],
  },
  selectedDownloads: {
    type: Set as PropType<Set<number>>,
    default: () => new Set(),
  },
  selectedHistoryDownloads: {
    type: Set as PropType<Set<number>>,
    default: () => new Set(),
  },
  showEmpty: {
    type: Boolean,
    default: false,
  },
  showChunkProgress: {
    type: Boolean,
    default: true,
  },
  sortBy: {
    type: String,
    default: 'date',
  },
  sortDirection: {
    type: String,
    default: 'desc',
  },
  stateFilter: {
    type: String,
    default: '',
  },
  availableStateFilters: {
    type: Array as PropType<string[]>,
    default: () => [],
  },
  queueSearchTerm: {
    type: String,
    default: '',
  },
  /** true cuando la cola está truncada (solo se muestran las primeras 500). */
  snapshotTruncated: {
    type: Boolean,
    default: false,
  },
  /** Total de descargas cuando snapshotTruncated es true. */
  snapshotTotalCount: {
    type: Number,
    default: 0,
  },
  /** Número total de descargas en la cola (sin filtrar). Usado para mantener visible el panel y la barra de búsqueda cuando el filtro no devuelve resultados. */
  totalDownloadCount: {
    type: Number,
    default: 0,
  },
});

// Modal de detalle de error: id de la descarga cuyo error se muestra (null = cerrado)
const errorModalDownloadId = ref<number | null>(null);
const downloadForErrorModal = computed(() => {
  if (errorModalDownloadId.value == null) return null;
  return props.downloads.find(d => d.id === errorModalDownloadId.value) ?? null;
});
function onErrorModalRetry(id: number) {
  emit('retry', id);
  errorModalDownloadId.value = null;
}
function onErrorModalRemove(id: number) {
  emit('remove', id);
  errorModalDownloadId.value = null;
}

// Confirmación antes de Eliminar (en Listo), Cancelar (en activos), Reiniciar, Limpiar lista y Eliminar selección
type PendingActionType = 'remove' | 'cancel' | 'retry' | 'clear-list' | 'remove-selected';
const actionConfirmShow = ref(false);
const pendingAction = ref<{ type: PendingActionType; id?: number; ids?: number[] } | null>(null);

const actionConfirmTitle = computed(() => {
  if (!pendingAction.value) return '';
  switch (pendingAction.value.type) {
    case 'remove':
      return t('downloadsPanel.confirmRemoveTitle');
    case 'cancel':
      return t('downloadsPanel.confirmCancelTitle');
    case 'retry':
      return t('downloadsPanel.confirmRetryTitle');
    case 'clear-list':
      return t('downloadsPanel.confirmClearListTitle');
    case 'remove-selected':
      return t('downloadsPanel.confirmRemoveSelectedTitle');
    default:
      return t('common.confirm');
  }
});

const actionConfirmMessage = computed(() => {
  if (!pendingAction.value) return '';
  switch (pendingAction.value.type) {
    case 'remove':
      return t('downloadsPanel.confirmRemoveMessage');
    case 'cancel':
      return t('downloadsPanel.confirmCancelMessage');
    case 'retry':
      return t('downloadsPanel.confirmRetryMessage');
    case 'clear-list':
      return t('downloadsPanel.confirmClearListMessage');
    case 'remove-selected':
      return t('downloadsPanel.confirmRemoveSelectedMessage', {
        count: pendingAction.value.ids?.length ?? 0,
      });
    default:
      return '';
  }
});

const actionConfirmLabel = computed(() => {
  if (!pendingAction.value) return t('common.confirm');
  switch (pendingAction.value.type) {
    case 'remove':
      return t('downloadItem.remove');
    case 'cancel':
      return t('common.cancel');
    case 'retry':
      return t('downloadItem.retry');
    case 'clear-list':
      return t('downloadsPanel.clearList');
    case 'remove-selected':
      return t('downloadsPanel.removeSelected');
    default:
      return t('common.confirm');
  }
});

function getDownloadById(id: number): DownloadItemRecord | undefined {
  return props.downloads.find((d: DownloadItemRecord) => d.id === id);
}

function onRemoveRequest(id: number) {
  const d = getDownloadById(id);
  const isCompleted =
    d && (d.queueStatus === 'completed' || (d.state || '').toLowerCase() === 'completed');
  // Listo: quitar de la lista sin confirmación. Detenidas (pausada, cancelada, fallida): pedir confirmación para no borrar por error descargas incompletas.
  if (isCompleted) {
    emit('remove', id);
  } else {
    pendingAction.value = { type: 'remove', id };
    actionConfirmShow.value = true;
  }
}

function onCancelRequest(id: number) {
  const d = getDownloadById(id);
  const state = (d?.state || '').toLowerCase();
  const isActive =
    state === 'downloading' ||
    state === 'merging' ||
    (d?.queueStatus === 'downloading' && state === 'starting');
  if (isActive) {
    pendingAction.value = { type: 'cancel', id };
    actionConfirmShow.value = true;
  } else {
    emit('cancel', id);
  }
}

function onRetryRequest(id: number) {
  pendingAction.value = { type: 'retry', id };
  actionConfirmShow.value = true;
}

function onClearListRequest() {
  pendingAction.value = { type: 'clear-list' };
  actionConfirmShow.value = true;
}

function onActionConfirmConfirm() {
  if (!pendingAction.value) return;
  const { type, id, ids } = pendingAction.value;
  if (type === 'remove' && id != null) emit('remove', id);
  else if (type === 'cancel' && id != null) emit('cancel', id);
  else if (type === 'retry' && id != null) emit('retry', id);
  else if (type === 'clear-list') emit('clear-downloads');
  else if (type === 'remove-selected' && ids?.length) emit('remove-selected', ids);
  pendingAction.value = null;
  actionConfirmShow.value = false;
}

function onRemoveSelectedRequest() {
  const ids = Array.from(props.selectedHistoryDownloads);
  if (ids.length === 0) return;
  pendingAction.value = { type: 'remove-selected', ids };
  actionConfirmShow.value = true;
}

function onActionConfirmCancel() {
  actionConfirmShow.value = false;
  pendingAction.value = null;
}

// Etiquetas para las opciones del filtro por estado (traducidas)
const stateFilterLabels = computed<Record<string, string>>(() => ({
  downloading: t('queue.downloading'),
  queued: t('queue.queued'),
  paused: t('queue.paused'),
  awaiting: t('queue.awaiting'),
  completed: t('queue.completed'),
  cancelled: t('queue.cancelled'),
  error: t('queue.error'),
}));

// Emits
const emit = defineEmits([
  'update:stateFilter',
  'update:queueSearchTerm',
  'clear-downloads',
  'restart-stopped-with-overwrite',
  'restart-selected-with-overwrite',
  'cancel-all-downloads',
  'pause-all',
  'resume-all',
  'pause-selected',
  'resume-selected',
  'cancel-selected',
  'remove-selected',
  'confirm-all',
  'cancel-all',
  'toggle-select-all-history',
  'toggle-select-history',
  'confirm-overwrite',
  'cancel-overwrite',
  'pause',
  'resume',
  'cancel',
  'retry',
  'remove',
  'sort-by-column',
]);

// Valor del select de estado (sincronizado con prop stateFilter)
const stateFilterValue = computed({
  get: () => props.stateFilter || '',
  set: v => emit('update:stateFilter', v || ''),
});

// Búsqueda en la cola: desplegable al pulsar "Buscar"
const showQueueSearchBox = ref(false);
const queueSearchValue = computed({
  get: () => props.queueSearchTerm || '',
  set: v => emit('update:queueSearchTerm', v || ''),
});

// Refs
const downloadsContainer = ref<HTMLElement | null>(null);
const timeEstimates = ref(
  new Map<number, { canStartImmediately: boolean; requiresSpeed: boolean }>()
);

// Sprint 1: Event-driven en lugar de polling. Actualizar estimaciones cuando cambian las descargas
// (download-progress y download-state-changed ya actualizan el estado reactivamente).
const updateEstimates = () => {
  const newEstimates = new Map<number, { canStartImmediately: boolean; requiresSpeed: boolean }>();
  (props.downloads as DownloadItemRecord[]).forEach((d: DownloadItemRecord) => {
    if (d.queueStatus === 'queued') {
      newEstimates.set(d.id, {
        canStartImmediately: false,
        requiresSpeed: true,
      });
    }
  });
  timeEstimates.value = newEstimates;
};

watch(
  () => props.downloads,
  () => updateEstimates(),
  { immediate: true, deep: true }
);

// Computed
const columnCount = computed(() => {
  return 7;
});

const {
  shouldVirtualize,
  visibleRange,
  visibleItems,
  topSpacerHeight,
  bottomSpacerHeight,
  totalHeight,
  handleScroll,
} = useVirtualScroll({
  items: computed(() => props.downloads),
  containerRef: downloadsContainer,
  itemHeight: 64,
  overscan: 5,
  minItemsToVirtualize: 30,
  enabled: true,
});

function isDownloadActive(d: DownloadItemRecord): boolean {
  const state = (d.state || '').toLowerCase();
  return (
    d.queueStatus === 'downloading' ||
    d.queueStatus === 'queued' ||
    state === 'progressing' ||
    state === 'starting' ||
    state === 'merging' ||
    state === 'verifying'
  );
}

function isDownloadPaused(d: DownloadItemRecord): boolean {
  return d.state === 'paused' || d.queueStatus === 'paused';
}

function isDownloadStopped(d: DownloadItemRecord): boolean {
  if (isDownloadActive(d) || isDownloadPaused(d)) return false;
  const state = (d.state || '').toLowerCase();
  return (
    state === 'completed' ||
    state === 'cancelled' ||
    state === 'failed' ||
    d.queueStatus === 'completed' ||
    d.queueStatus === 'cancelled' ||
    d.queueStatus === 'error'
  );
}

/** Descargas que sí pueden reiniciarse con el botón: canceladas o con error (no listas ni descargando). */
function isDownloadRestartable(d: DownloadItemRecord): boolean {
  const state = (d.state || '').toLowerCase();
  return (
    state === 'cancelled' ||
    state === 'failed' ||
    d.queueStatus === 'cancelled' ||
    d.queueStatus === 'error'
  );
}

const hasActiveOrQueuedDownloads = computed(() =>
  (props.downloads as DownloadItemRecord[]).some(isDownloadActive)
);

const hasPausedOrCancelledDownloads = computed(() =>
  (props.downloads as DownloadItemRecord[]).some(isDownloadPaused)
);

/** Todas están detenidas (ni activas ni en pausa): completadas, canceladas o error. */
const allStopped = computed(() => {
  const list = props.downloads as DownloadItemRecord[];
  return list.length > 0 && list.every(isDownloadStopped);
});

/** Hay al menos una descarga cancelada o con error (reiniciables con el botón). */
const hasCancelledOrFailedDownloads = computed(() =>
  (props.downloads as DownloadItemRecord[]).some(isDownloadRestartable)
);

/** Descargas seleccionadas (filtrando por las que están en la lista actual). */
const selectedDownloadRecords = computed(() => {
  const list = props.downloads as DownloadItemRecord[];
  const set = props.selectedHistoryDownloads;
  return list.filter(d => set.has(d.id));
});

const selectedHasActive = computed(() => selectedDownloadRecords.value.some(isDownloadActive));
const selectedHasPaused = computed(() => selectedDownloadRecords.value.some(isDownloadPaused));
const selectedHasActiveOrPaused = computed(() =>
  selectedDownloadRecords.value.some(d => isDownloadActive(d) || isDownloadPaused(d))
);
/** Entre las seleccionadas hay al menos una que se puede reiniciar (cancelada/error). */
const selectedHasRestartable = computed(() =>
  selectedDownloadRecords.value.some(isDownloadRestartable)
);
</script>
