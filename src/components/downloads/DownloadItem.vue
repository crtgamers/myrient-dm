<template>
  <tr
    v-memo="[
      download.state,
      download.queueStatus,
      download.progress ?? download.percent,
      download.verificationProgress,
      download.chunked,
      download.activeChunks,
      download.completedChunks,
      download.merging,
      download.queuePosition,
      isSelected,
    ]"
    class="download-row"
    :class="[{ 'row-selected': isSelected }, 'row-status-' + (download.queueStatus || 'default')]"
    role="row"
  >
    <!-- Checkbox selection -->
    <td class="checkbox-col">
      <input
        type="checkbox"
        class="form-checkbox"
        :checked="isSelected"
        :aria-label="
          t('downloadItem.selectDownload', { name: download.title || t('common.noName') })
        "
        @change="$emit('toggle-select', download.id)"
      />
    </td>

    <!-- File Name -->
    <td
      class="name-cell"
      :title="download.title"
    >
      <div class="file-info">
        <span class="file-name">{{ download.title }}</span>
        <span class="file-path">{{ directoryPath }}</span>
      </div>
    </td>

    <!-- Progress -->
    <td class="progress-col">
      <div class="progress-wrapper">
        <div class="progress-bar-container">
          <div
            class="progress-bar-fill"
            :class="progressClass"
            :style="{ width: barProgress * 100 + '%' }"
          />
        </div>
        <span class="progress-text">{{ percentage }}%</span>
      </div>

      <!-- Chunk Progress Indicator -->
      <ChunkProgressIndicator
        v-if="showChunkProgress"
        :chunked="download.chunked || false"
        :chunk-progress="download.chunkProgress || []"
        :active-chunks="download.activeChunks || 0"
        :completed-chunks="download.completedChunks || 0"
        :total-chunks="download.totalChunks || 0"
        :merge-progress="mergeProgress"
        :merge-speed="download.mergeSpeed"
        :is-merging="download.state === 'merging' || !!download.merging"
        :current-chunk="download.currentChunk"
        :bytes-processed="download.bytesProcessed"
      />
    </td>

    <!-- Status -->
    <td class="status-col">
      <div
        class="status-badge-modern"
        :class="['status-' + statusKey, { 'status-clickable': statusKey === 'error' }]"
        role="button"
        :aria-label="statusKey === 'error' ? t('downloadItem.viewError') : undefined"
        :tabindex="statusKey === 'error' ? 0 : undefined"
        @click="statusKey === 'error' ? $emit('show-error-detail', download.id) : undefined"
        @keydown.enter="statusKey === 'error' ? $emit('show-error-detail', download.id) : undefined"
        @keydown.space.prevent="
          statusKey === 'error' ? $emit('show-error-detail', download.id) : undefined
        "
      >
        <component
          :is="statusIcon"
          :size="12"
        />
        <span>{{ statusText }}</span>
      </div>
    </td>

    <!-- Speed -->
    <td class="speed-col">
      <div
        v-if="speedInfo && speedInfo.speed != null"
        class="speed-value"
      >
        {{ (speedInfo.speed ?? 0).toFixed(1) }} <span class="unit">MB/s</span>
      </div>
      <span
        v-else
        class="muted-dash"
        >-</span
      >
    </td>

    <!-- ETA -->
    <td class="eta-col">
      <span class="eta-value">{{ estimatedTime }}</span>
    </td>

    <!-- Actions -->
    <td class="actions-col">
      <div class="actions-group">
        <!-- En espera de confirmación (sobrescritura): Sobrescribir, Cancelar y Eliminar -->
        <template v-if="isWaitingConfirmation">
          <button
            class="icon-btn btn-confirm"
            :title="t('downloadItem.overwrite')"
            :aria-label="t('downloadItem.overwrite')"
            @click="$emit('confirm-overwrite', download.id)"
          >
            <Check
              :size="20"
              aria-hidden="true"
            />
          </button>
          <button
            class="icon-btn btn-delete"
            :title="t('common.cancel')"
            :aria-label="t('common.cancel')"
            @click="$emit('cancel', download.id)"
          >
            <Square
              :size="18"
              aria-hidden="true"
            />
          </button>
          <button
            class="icon-btn btn-delete"
            :title="t('downloadItem.remove')"
            :aria-label="t('downloadItem.remove')"
            @click="$emit('remove', download.id)"
          >
            <Trash2
              :size="20"
              aria-hidden="true"
            />
          </button>
        </template>

        <!-- Fusionando: sin botones; si falla 3 veces pasa a Error (Reiniciar / Remover de la lista) -->
        <template v-else-if="download.state === 'merging'"></template>

        <!-- Verifying: sin botones (la descarga está lista, no se puede pausar ni detener) -->
        <template v-else-if="download.state === 'verifying'"></template>

        <!-- En cola: Cancelar y Eliminar -->
        <template v-else-if="download.state === 'queued' || download.queueStatus === 'queued'">
          <button
            class="icon-btn btn-delete"
            :title="t('common.cancel')"
            :aria-label="t('common.cancel')"
            @click="$emit('cancel', download.id)"
          >
            <Square
              :size="18"
              aria-hidden="true"
            />
          </button>
          <button
            class="icon-btn btn-delete"
            :title="t('downloadItem.remove')"
            :aria-label="t('downloadItem.remove')"
            @click="$emit('remove', download.id)"
          >
            <Trash2
              :size="20"
              aria-hidden="true"
            />
          </button>
        </template>

        <!-- Descargando: solo Pausar -->
        <template v-else-if="download.queueStatus === 'downloading'">
          <button
            class="icon-btn btn-pause"
            :title="t('downloadItem.pause')"
            :aria-label="t('downloadItem.pause')"
            @click="$emit('pause', download.id)"
          >
            <Pause
              :size="20"
              aria-hidden="true"
            />
          </button>
        </template>

        <!-- Pausado: Iniciar/Continuar y Detener -->
        <template v-else-if="download.queueStatus === 'paused'">
          <button
            class="icon-btn btn-resume"
            :title="t('downloadItem.resume')"
            :aria-label="t('downloadItem.resume')"
            @click="$emit('resume', download.id)"
          >
            <Play
              :size="20"
              aria-hidden="true"
            />
          </button>
          <button
            class="icon-btn btn-delete"
            :title="t('downloadItem.stop')"
            :aria-label="t('downloadItem.stop')"
            @click="$emit('cancel', download.id)"
          >
            <Square
              :size="18"
              aria-hidden="true"
            />
          </button>
        </template>

        <!-- Detenido: Reiniciar y Remover de la lista -->
        <template v-else-if="download.state === 'cancelled'">
          <button
            class="icon-btn btn-retry"
            :title="t('downloadItem.retry')"
            :aria-label="t('downloadItem.retry')"
            @click="$emit('retry', download.id)"
          >
            <RotateCcw
              :size="20"
              aria-hidden="true"
            />
          </button>
          <button
            class="icon-btn btn-delete"
            :title="t('downloadItem.removeFromList')"
            :aria-label="t('downloadItem.removeFromList')"
            @click="$emit('remove', download.id)"
          >
            <Trash2
              :size="20"
              aria-hidden="true"
            />
          </button>
        </template>

        <!-- Listo: Abrir carpeta y Remover de la lista -->
        <template v-else-if="download.queueStatus === 'completed'">
          <button
            class="icon-btn btn-folder"
            :title="t('downloadItem.openFolder')"
            :aria-label="t('downloadItem.openFolder')"
            @click="openFolder"
          >
            <ExternalLink
              :size="20"
              aria-hidden="true"
            />
          </button>
          <button
            class="icon-btn btn-delete"
            :title="t('downloadItem.removeFromList')"
            :aria-label="t('downloadItem.removeFromList')"
            @click="$emit('remove', download.id)"
          >
            <Trash2
              :size="20"
              aria-hidden="true"
            />
          </button>
        </template>

        <!-- Error: Reiniciar y Remover de la lista -->
        <template v-else>
          <button
            class="icon-btn btn-retry"
            :title="t('downloadItem.retry')"
            :aria-label="t('downloadItem.retry')"
            @click="$emit('retry', download.id)"
          >
            <RefreshCw
              :size="20"
              aria-hidden="true"
            />
          </button>
          <button
            class="icon-btn btn-delete"
            :title="t('downloadItem.removeFromList')"
            :aria-label="t('downloadItem.removeFromList')"
            @click="$emit('remove', download.id)"
          >
            <Trash2
              :size="20"
              aria-hidden="true"
            />
          </button>
        </template>
      </div>
    </td>
  </tr>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
import {
  Pause,
  Play,
  Square,
  RotateCcw,
  Trash2,
  Check,
  ExternalLink,
  RefreshCw,
  Clock,
  Download,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from 'lucide-vue-next';
import type { PropType } from 'vue';
import ChunkProgressIndicator from './ChunkProgressIndicator.vue';
import type { ChunkProgressItem } from './ChunkProgressIndicator.vue';
import logger from '../../utils/logger';

export interface DownloadItemRecord {
  id: number;
  title?: string;
  state?: string;
  queueStatus?: string;
  progress?: number;
  percent?: number;
  speed?: number;
  savePath?: string;
  merging?: boolean;
  mergeProgress?: number;
  remainingTime?: number;
  chunked?: boolean;
  totalChunks?: number;
  chunkProgress?: ChunkProgressItem[];
  activeChunks?: number;
  completedChunks?: number;
  mergeSpeed?: number;
  currentChunk?: number;
  bytesProcessed?: number;
  [key: string]: unknown;
}

export interface SpeedStatsEntry {
  speed?: number;
  speedBytes?: number;
  remainingTime?: number;
  progress?: number;
}

export interface TimeEstimateEntry {
  canStartImmediately?: boolean;
  requiresSpeed?: boolean;
}

const props = defineProps({
  download: { type: Object as PropType<DownloadItemRecord>, required: true },
  isSelected: { type: Boolean, default: false },
  speedStats: {
    type: Map as PropType<Map<number, SpeedStatsEntry>>,
    default: () => new Map(),
  },
  showChunkProgressSettings: { type: Boolean, default: true },
  timeEstimates: {
    type: Map as PropType<Map<number, TimeEstimateEntry>>,
    default: () => new Map(),
  },
});

defineEmits([
  'toggle-select',
  'confirm-overwrite',
  'cancel-overwrite',
  'remove',
  'pause',
  'cancel',
  'resume',
  'retry',
  'show-error-detail',
]);

const barProgress = computed((): number => {
  if (props.download.state === 'verifying' && props.download.verificationProgress != null) {
    return Number(props.download.verificationProgress);
  }
  const p = props.download.progress ?? props.download.percent ?? 0;
  return Number(p);
});
const percentage = computed(() => Math.round(barProgress.value * 100));

const speedInfo = computed(() => props.speedStats.get(props.download.id));

const directoryPath = computed(() => {
  const fullPath = props.download.savePath;
  if (!fullPath) return '-';
  const lastSep = Math.max(fullPath.lastIndexOf('\\'), fullPath.lastIndexOf('/'));
  return lastSep > 0 ? fullPath.substring(0, lastSep) : fullPath;
});

const progressClass = computed(() => {
  const s = (props.download.state || '').toLowerCase();
  const q = (props.download.queueStatus || '').toLowerCase();
  if (q === 'completed') return 'bg-success';
  if (q === 'paused' || s === 'paused') return 'bg-warning';
  if (q === 'error') return 'bg-danger';
  if (s === 'merging' || props.download.merging) return 'bg-info animating';
  if (s === 'verifying') return 'bg-info animating';
  return 'bg-primary animating';
});

const isWaitingConfirmation = computed(
  () =>
    (props.download.state || '').toLowerCase() === 'paused' &&
    (props.download.lastError === 'requires_overwrite_confirmation' ||
      props.download.error === 'requires_overwrite_confirmation')
);

const statusKey = computed(() => {
  const s = (props.download.state || '').toLowerCase();
  const q = (props.download.queueStatus || '').toLowerCase();
  if (isWaitingConfirmation.value) return 'waiting';
  if (s === 'paused' || q === 'paused') return 'paused';
  if (s === 'cancelled' || q === 'cancelled') return 'cancelled';
  if (q === 'queued') return 'queued';
  // merging y verifying antes que downloading (queueStatus los mapea a 'downloading')
  if (s === 'merging' || props.download.merging) return 'merging';
  if (s === 'verifying') return 'verifying';
  if (s === 'starting') return 'starting';
  if (q === 'downloading' || s === 'progressing') return 'downloading';
  if (q === 'completed') return 'completed';
  if (q === 'error') return 'error';
  return 'default';
});

const statusIcon = computed(() => {
  const key = statusKey.value;
  if (key === 'waiting') return AlertCircle;
  if (key === 'paused') return Pause;
  if (key === 'queued') return Clock;
  if (key === 'starting') return Loader2;
  if (key === 'downloading') return Download;
  if (key === 'merging') return Loader2;
  if (key === 'verifying') return Loader2;
  if (key === 'completed') return CheckCircle2;
  if (key === 'error') return AlertCircle;
  return Clock;
});

const statusText = computed(() => {
  const key = statusKey.value;
  if (key === 'waiting') return 'Confirmar';
  if (key === 'paused') return 'Pausada';
  if (key === 'queued') return 'En cola';
  if (key === 'starting') return 'Iniciando';
  if (key === 'downloading') return 'Bajando';
  if (key === 'merging') return 'Fusionando';
  if (key === 'verifying') return 'Verificando';
  if (key === 'completed') return 'Listo';
  if (key === 'cancelled') return 'Detenido';
  if (key === 'error') return 'Error';
  return 'Iniciando';
});

const mergeProgress = computed((): number | undefined => {
  if (props.download.mergeProgress !== undefined) {
    return Number(props.download.mergeProgress);
  }
  return props.download.merging ? barProgress.value : undefined;
});

const showChunkProgress = computed(() => {
  if (!props.showChunkProgressSettings) return false;
  return props.download.chunked || (props.download.totalChunks && props.download.totalChunks > 0);
});

const estimatedTime = computed(() => {
  const download = props.download as DownloadItemRecord;
  if (download.queueStatus === 'queued' || download.state === 'queued') {
    const estimate = props.timeEstimates.get(download.id as number);
    return estimate?.canStartImmediately ? 'Inmediato' : 'En cola';
  }
  if (
    ['downloading', 'progressing', 'merging'].includes(download.queueStatus ?? '') ||
    download.merging
  ) {
    const remainingSeconds = download.remainingTime;
    if (!remainingSeconds || remainingSeconds <= 0 || !isFinite(remainingSeconds)) return '...';
    const h = Math.floor(remainingSeconds / 3600);
    const m = Math.floor((remainingSeconds % 3600) / 60);
    const s = Math.floor(remainingSeconds % 60);
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
  return '-';
});

const openFolder = async () => {
  const filePath = props.download.savePath;
  if (!filePath) return;
  const api =
    typeof window !== 'undefined'
      ? (window as { api?: { openFolder: (_p: string) => Promise<unknown> } }).api
      : undefined;
  if (!api?.openFolder) return;
  try {
    await api.openFolder(filePath);
  } catch (e) {
    logger.child('Downloads:Item').error('Error abriendo carpeta de descarga', {
      id: props.download.id,
      savePath: filePath,
      error: e,
    });
  }
};
</script>

<style scoped>
.status-clickable {
  cursor: pointer;
}
.status-clickable:hover {
  opacity: 0.9;
}
</style>
