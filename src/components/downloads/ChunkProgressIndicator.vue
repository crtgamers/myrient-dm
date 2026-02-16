<template>
  <div
    v-if="shouldShow"
    class="chunk-progress-container"
  >
    <!-- Información general de chunks -->
    <div class="chunk-summary">
      <span class="chunk-stats">
        {{ t('downloads.chunkSummary', { completed: completedChunks, total: totalChunks }) }}
        <span
          v-if="activeChunks > 0"
          class="active-chunks"
        >
          {{ t('downloads.chunkActive', { count: activeChunks }) }}
        </span>
      </span>
    </div>

    <!-- Visualización de chunks (expandible) -->
    <div class="chunks-visualization">
      <div
        v-for="chunk in sortedChunks"
        :key="chunk.index"
        class="chunk-item"
        :class="getChunkClass(chunk)"
        :title="getChunkTooltip(chunk)"
      >
        <div
          v-if="chunk.progress > 0"
          class="chunk-bar"
          :style="{
            width: chunk.progress * 100 + '%',
            transition: chunk.progress >= 1 ? 'width 0.3s ease' : 'none',
          }"
        />
        <span class="chunk-index">{{ chunk.index }}</span>
        <span
          v-if="chunk.speed != null && chunk.speed > 0"
          class="chunk-speed"
        >
          {{ formatSpeed(chunk.speed ?? 0) }}
        </span>
      </div>
    </div>

    <!-- Indicador de merge si está fusionando (se muestra en cuanto state es merging, aunque aún no llegue progreso) -->
    <div
      v-if="showMergeSection"
      class="merge-progress"
    >
      <div class="merge-info">
        <span class="merge-label">🔄 {{ t('downloads.mergingLabel') }}</span>
        <span class="merge-percent">{{ mergePercent }}%</span>
      </div>
      <div class="merge-bar">
        <div
          class="merge-bar-fill"
          :style="{ width: displayMergeProgress * 100 + '%' }"
        />
      </div>
      <div
        v-if="mergeSpeed"
        class="merge-speed"
      >
        {{ formatSpeed(mergeSpeed) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { PropType } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

export interface ChunkProgressItem {
  index: number;
  progress: number;
  speed?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  state?: string;
}

const props = defineProps({
  chunked: {
    type: Boolean,
    default: false,
  },
  chunkProgress: {
    type: Array as PropType<ChunkProgressItem[]>,
    default: () => [],
  },
  activeChunks: {
    type: Number,
    default: 0,
  },
  completedChunks: {
    type: Number,
    default: 0,
  },
  totalChunks: {
    type: Number,
    default: 0,
  },
  mergeProgress: {
    type: Number,
    default: undefined,
  },
  mergeSpeed: {
    type: Number,
    default: undefined, // bytes/seg
  },
  isMerging: {
    type: Boolean,
    default: false,
  },
  currentChunk: {
    type: Number,
    default: undefined,
  },
  bytesProcessed: {
    type: Number,
    default: undefined,
  },
});

// Mostrar sección de merge en cuanto state es merging, aunque aún no llegue mergeProgress
const showMergeSection = computed(() => props.mergeProgress !== undefined || props.isMerging);
const displayMergeProgress = computed(() =>
  props.mergeProgress !== undefined ? props.mergeProgress : 0
);
const mergePercent = computed(() => Math.round(displayMergeProgress.value * 100));

// Determinar si se debe mostrar el componente
const shouldShow = computed(() => {
  // Mostrar si está fusionando (mergeProgress definido o state merging)
  if (props.mergeProgress !== undefined || props.isMerging) {
    return true;
  }

  // Mostrar si hay totalChunks > 0 (indica que es una descarga chunked)
  if (props.totalChunks && props.totalChunks > 0) {
    return true;
  }

  // Mostrar si hay chunkProgress con datos (incluso si está vacío, puede estar inicializándose)
  if (props.chunkProgress && Array.isArray(props.chunkProgress) && props.chunkProgress.length > 0) {
    return true;
  }

  // Mostrar si chunked está explícitamente en true
  if (props.chunked) {
    return true;
  }

  return false;
});

// Ordenar chunks por índice
const sortedChunks = computed(() => {
  if (
    !props.chunkProgress ||
    !Array.isArray(props.chunkProgress) ||
    props.chunkProgress.length === 0
  ) {
    // Si no hay chunkProgress pero hay totalChunks, crear array de chunks pendientes
    if (props.totalChunks > 0) {
      return Array.from({ length: props.totalChunks }, (_, i) => ({
        index: i,
        progress: 0,
        speed: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        state: 'pending',
      }));
    }
    return [];
  }

  return [...(props.chunkProgress as ChunkProgressItem[])].sort(
    (a: ChunkProgressItem, b: ChunkProgressItem) => a.index - b.index
  );
});

// Obtener clase CSS para chunk según su estado
const getChunkClass = (chunk: ChunkProgressItem) => {
  if (chunk.progress >= 1) return 'chunk-completed';
  if (chunk.progress > 0) return 'chunk-active';
  return 'chunk-pending';
};

// Tooltip informativo para cada chunk
const getChunkTooltip = (chunk: ChunkProgressItem) => {
  const progress = Math.round(chunk.progress * 100);
  const speed = (chunk.speed ?? 0) > 0 ? formatSpeed(chunk.speed!) : t('downloads.chunkWaiting');
  return t('downloads.chunkTooltip', { index: chunk.index, progress, speed });
};

// Formatear velocidad
const formatSpeed = (speed: number) => {
  if (speed === 0 || speed === undefined || speed === null) return '-';

  // Asumir que speed ya está en MB/s si viene del backend
  // Si es muy grande (> 1000), probablemente está en bytes/seg
  let mbps = speed;
  if (speed > 1000) {
    // Convertir de bytes/seg a MB/s
    mbps = speed / (1024 * 1024);
  }

  if (mbps < 0.1) {
    // Mostrar en KB/s si es muy lento
    const kbps = mbps * 1024;
    return `${kbps.toFixed(1)} KB/s`;
  }

  return `${mbps.toFixed(2)} MB/s`;
};
</script>

<style scoped>
.chunk-progress-container {
  margin-top: 0.5rem;
  padding: 0.625rem;
  background: var(--surface-overlay-10);
  border: 0.0625rem solid var(--border-color);
  border-radius: 0.375rem;
  font-size: 0.6875rem;
  width: 100%;
  box-sizing: border-box;
  display: block;
  visibility: visible;
  opacity: 1;
}

.chunk-summary {
  margin-bottom: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.chunk-stats {
  font-weight: 500;
}

.active-chunks {
  color: var(--primary-color);
  font-weight: 600;
}

.chunks-visualization {
  display: flex;
  flex-wrap: wrap;
  gap: 0.1875rem;
  margin-top: 0.5rem;
  min-height: 1.75rem;
}

.chunk-item {
  position: relative;
  width: 1.625rem;
  height: 1.625rem;
  background: var(--bg-tertiary);
  border: 0.0625rem solid var(--border-color);
  border-radius: 0.25rem;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.chunk-item:hover {
  transform: scale(1.1);
  z-index: 10;
  border-color: var(--primary-color);
}

.chunk-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 100%;
  background: var(--primary-color);
  transition: width 0.3s ease;
  opacity: 0.7;
}

.chunk-completed .chunk-bar {
  background: var(--success-color);
  opacity: 1;
}

.chunk-active .chunk-bar {
  background: var(--primary-color);
  animation: pulse 1.5s ease-in-out infinite;
}

.chunk-pending {
  opacity: 0.5;
}

.chunk-index {
  position: relative;
  z-index: 1;
  font-size: 0.5625rem;
  font-weight: 600;
  color: var(--text-primary);
  text-shadow: 0 0.0625rem 0.125rem var(--overlay-bg-80);
}

.chunk-speed {
  display: none;
  position: absolute;
  top: -1.25rem;
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  background: var(--overlay-bg-90);
  padding: 0.125rem 0.25rem;
  border-radius: 0.1875rem;
  font-size: 0.625rem;
  color: var(--text-primary);
  pointer-events: none;
}

.chunk-item:hover .chunk-speed {
  display: block;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.7;
  }
  50% {
    opacity: 1;
  }
}

/* Indicador de merge */
.merge-progress {
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 0.0625rem solid var(--border-color);
}

.merge-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.25rem;
  font-size: 0.6875rem;
}

.merge-label {
  color: var(--text-primary);
  font-weight: 500;
}

.merge-percent {
  color: var(--primary-color);
  font-weight: 600;
}

.merge-bar {
  width: 100%;
  height: 0.375rem;
  background: var(--bg-tertiary);
  border-radius: 0.1875rem;
  overflow: hidden;
  margin-bottom: 0.25rem;
}

.merge-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary-color), var(--success-color));
  transition: width 0.3s ease;
  animation: merge-pulse 1.5s ease-in-out infinite;
}

@keyframes merge-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.8;
  }
}

.merge-speed {
  text-align: right;
  font-size: 0.625rem;
  color: var(--text-muted);
}
</style>
