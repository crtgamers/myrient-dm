<template>
  <ErrorBoundary
    key="downloads"
    component-name="DownloadsPanel"
    :fallback-message="t('errors.loadDownloads')"
  >
    <div class="view-content fill-height">
      <DownloadsPanel
        v-bind="downloadsPanelProps"
        v-on="downloadsPanelListeners"
      />
    </div>
  </ErrorBoundary>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import ErrorBoundary from '../components/ErrorBoundary.vue';
import DownloadsPanel from '../components/downloads/DownloadsPanel.vue';
import type { DownloadItemRecord } from '../components/downloads/DownloadItem.vue';
import type { SpeedStatsEntry } from '../components/downloads/DownloadItem.vue';

const { t } = useI18n();

const props = defineProps({
  downloads: {
    type: Array as PropType<DownloadItemRecord[]>,
    required: true,
  },
  totalDownloadCount: { type: Number, default: 0 },
  stateFilter: { type: String, default: '' },
  availableStateFilters: { type: Array as PropType<string[]>, default: () => [] },
  queueSearchTerm: { type: String, default: '' },
  speedStats: {
    type: Map as PropType<Map<number, SpeedStatsEntry>>,
    default: () => new Map(),
  },
  pendingConfirmations: { type: Array, default: () => [] },
  selectedDownloads: { type: Set as PropType<Set<number>>, default: () => new Set() },
  selectedHistoryDownloads: { type: Set as PropType<Set<number>>, default: () => new Set() },
  showEmpty: { type: Boolean, default: true },
  showChunkProgress: { type: Boolean, default: true },
  sortBy: { type: String, default: 'date' },
  sortDirection: { type: String, default: 'desc' },
  snapshotTruncated: { type: Boolean, default: false },
  snapshotTotalCount: { type: Number, default: 0 },
});

const emit = defineEmits<{
  (_e: 'update:stateFilter', _v: string): void;
  (_e: 'update:queueSearchTerm', _v: string): void;
  (_e: 'clear-downloads'): void;
  (_e: 'restart-stopped-with-overwrite'): void;
  (_e: 'restart-selected-with-overwrite'): void;
  (_e: 'cancel-all-downloads'): void;
  (_e: 'confirm-all'): void;
  (_e: 'cancel-all'): void;
  (_e: 'toggle-select-all-history'): void;
  (_e: 'toggle-select-history', _id: number): void;
  (_e: 'confirm-overwrite', _id: number): void;
  (_e: 'cancel-overwrite', _id: number): void;
  (_e: 'pause-all'): void;
  (_e: 'resume-all'): void;
  (_e: 'pause-selected'): void;
  (_e: 'resume-selected'): void;
  (_e: 'cancel-selected'): void;
  (_e: 'remove-selected'): void;
  (_e: 'pause', _id: number): void;
  (_e: 'resume', _id: number): void;
  (_e: 'cancel', _id: number): void;
  (_e: 'retry', _id: number): void;
  (_e: 'remove', _id: number): void;
  (_e: 'sort-by-column', _column: string): void;
}>();

const downloadsPanelProps = computed(() => ({
  downloads: props.downloads,
  totalDownloadCount: props.totalDownloadCount,
  stateFilter: props.stateFilter,
  availableStateFilters: props.availableStateFilters,
  queueSearchTerm: props.queueSearchTerm,
  speedStats: props.speedStats,
  pendingConfirmations: props.pendingConfirmations,
  selectedDownloads: props.selectedDownloads,
  selectedHistoryDownloads: props.selectedHistoryDownloads,
  showEmpty: props.showEmpty,
  showChunkProgress: props.showChunkProgress,
  sortBy: props.sortBy,
  sortDirection: props.sortDirection,
  snapshotTruncated: props.snapshotTruncated,
  snapshotTotalCount: props.snapshotTotalCount,
}));

const downloadsPanelListeners = computed(() => ({
  'update:stateFilter': (v: string) => emit('update:stateFilter', v),
  'update:queueSearchTerm': (v: string) => emit('update:queueSearchTerm', v),
  'clear-downloads': () => emit('clear-downloads'),
  'restart-stopped-with-overwrite': () => emit('restart-stopped-with-overwrite'),
  'restart-selected-with-overwrite': () => emit('restart-selected-with-overwrite'),
  'cancel-all-downloads': () => emit('cancel-all-downloads'),
  'confirm-all': () => emit('confirm-all'),
  'cancel-all': () => emit('cancel-all'),
  'toggle-select-all-history': () => emit('toggle-select-all-history'),
  'toggle-select-history': (id: number) => emit('toggle-select-history', id),
  'confirm-overwrite': (id: number) => emit('confirm-overwrite', id),
  'cancel-overwrite': (id: number) => emit('cancel-overwrite', id),
  'pause-all': () => emit('pause-all'),
  'resume-all': () => emit('resume-all'),
  'pause-selected': () => emit('pause-selected'),
  'resume-selected': () => emit('resume-selected'),
  'cancel-selected': () => emit('cancel-selected'),
  'remove-selected': () => emit('remove-selected'),
  pause: (id: number) => emit('pause', id),
  resume: (id: number) => emit('resume', id),
  cancel: (id: number) => emit('cancel', id),
  retry: (id: number) => emit('retry', id),
  remove: (id: number) => emit('remove', id),
  'sort-by-column': (column: string) => emit('sort-by-column', column),
}));
</script>
