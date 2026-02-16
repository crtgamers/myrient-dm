<template>
  <div
    v-if="files.length > 0"
    id="files-section"
    class="files-container"
  >
    <div class="files-header">
      <div class="header-info">
        <h2>{{ title }}</h2>
        <span class="count-badge">
          <template v-if="hasActiveFilters">
            {{ t('fileTable.name') }}: {{ totalFileCount }} → {{ files.length }}
          </template>
          <template v-else> {{ files.length }} </template>
        </span>
      </div>
      <div class="header-buttons">
        <button
          v-if="currentFolderId && !isAtRoot"
          class="action-btn download-all-btn glass-effect"
          :aria-label="t('fileTable.downloadFolderTitle')"
          :title="t('fileTable.downloadFolderTitle')"
          @click="$emit('download-folder')"
        >
          <FolderDown :size="18" />
          <span>{{ t('fileTable.fullFolder') }}</span>
        </button>
        <button
          v-if="selectedFiles.length > 0"
          class="action-btn download-selected-btn"
          @click="$emit('download-selected')"
        >
          <DownloadCloud :size="18" />
          <span>{{ t('fileTable.downloadCount', { count: selectedFiles.length }) }}</span>
        </button>
      </div>
    </div>

    <div
      ref="tableContainer"
      class="table-container glass-effect"
      role="region"
      :aria-label="t('fileTable.filesTable')"
      @scroll="handleScroll"
    >
      <table
        role="table"
        :aria-label="t('fileTable.filesList')"
      >
        <thead>
          <tr class="glass-effect">
            <th class="checkbox-col">
              <input
                type="checkbox"
                class="form-checkbox"
                :checked="
                  allSelected !== undefined
                    ? allSelected
                    : selectedFiles.length === files.length && files.length > 0
                "
                :title="t('fileTable.selectAll')"
                :aria-label="t('fileTable.selectAllFiles')"
                @change="$emit('toggle-select-all')"
              />
            </th>
            <th
              v-if="sortable"
              class="name-col sortable"
              role="columnheader"
              :aria-sort="
                sortField === 'title'
                  ? sortDirection === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none'
              "
              tabindex="0"
              @click="$emit('sort', 'title')"
            >
              <div class="th-content">
                <span>{{ t('fileTable.name') }}</span>
                <component
                  :is="sortDirection === 'asc' ? ChevronUp : ChevronDown"
                  v-if="sortField === 'title'"
                  :size="14"
                  class="sort-icon"
                />
              </div>
            </th>
            <th
              v-else
              class="name-col"
            >
              {{ t('fileTable.name') }}
            </th>

            <th
              v-if="showPath && sortable"
              class="sortable location-cell"
              role="columnheader"
              tabindex="0"
              @click="$emit('sort', 'fullPath')"
            >
              <div class="th-content">
                <span>{{ t('fileTable.location') }}</span>
                <component
                  :is="sortDirection === 'asc' ? ChevronUp : ChevronDown"
                  v-if="sortField === 'fullPath'"
                  :size="14"
                  class="sort-icon"
                />
              </div>
            </th>

            <th
              v-if="sortable"
              class="sortable"
              role="columnheader"
              tabindex="0"
              @click="$emit('sort', 'modified_date')"
            >
              <div class="th-content">
                <span>{{ t('fileTable.modified') }}</span>
                <component
                  :is="sortDirection === 'asc' ? ChevronUp : ChevronDown"
                  v-if="sortField === 'modified_date'"
                  :size="14"
                  class="sort-icon"
                />
              </div>
            </th>
            <th v-else>{{ t('fileTable.modified') }}</th>

            <th
              v-if="sortable"
              class="sortable size-cell"
              role="columnheader"
              tabindex="0"
              @click="$emit('sort', 'size')"
            >
              <div class="th-content align-right">
                <span>{{ t('fileTable.size') }}</span>
                <component
                  :is="sortDirection === 'asc' ? ChevronUp : ChevronDown"
                  v-if="sortField === 'size'"
                  :size="14"
                  class="sort-icon"
                />
              </div>
            </th>
            <th
              v-else
              class="size-cell"
            >
              {{ t('fileTable.size') }}
            </th>

            <th class="actions-col">{{ t('fileTable.action') }}</th>
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

          <tr
            v-for="file in visibleItems"
            :key="file.id"
            :class="{ selected: selectedFiles.includes(file.id), 'in-queue': !!downloads[file.id] }"
            role="row"
            tabindex="0"
            @keydown.enter="handleRowDownload(file)"
          >
            <td class="checkbox-col">
              <input
                type="checkbox"
                class="form-checkbox"
                :checked="selectedFiles.includes(file.id)"
                :aria-label="t('fileTable.selectFile', { name: file.title || t('common.noName') })"
                @change="$emit('toggle-select', file.id)"
              />
            </td>
            <td
              class="name-cell"
              :title="file.title"
            >
              <div class="file-title-wrapper">
                <span class="file-title">{{ file.title }}</span>
                <span class="location-text">{{ file.fullPath || '-' }}</span>
              </div>
            </td>
            <td
              v-if="showPath"
              class="location-cell"
              :title="file.fullPath"
            >
              <span class="location-text">{{ file.fullPath || '-' }}</span>
            </td>
            <td class="date-cell">
              {{ formatDate(file.modified_date) }}
            </td>
            <td class="size-cell">
              {{ file.size || '-' }}
            </td>
            <td class="actions-col">
              <button
                class="row-download-btn"
                :class="getButtonInfo(file.id).buttonClass"
                :disabled="getButtonInfo(file.id).disabled"
                :aria-label="
                  t('fileTable.downloadFile', { name: file.title || t('common.noName') })
                "
                @click="handleRowDownload(file)"
              >
                <component
                  :is="getButtonInfo(file.id).icon"
                  :size="16"
                />
                <span class="btn-text">{{ getButtonInfo(file.id).text }}</span>
              </button>
            </td>
          </tr>

          <tr
            v-if="shouldVirtualize && visibleRange.end < files.length"
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
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  FolderDown,
  DownloadCloud,
  ChevronUp,
  ChevronDown,
  Download,
  CheckCircle2,
  Clock,
  Loader2,
  AlertCircle,
} from 'lucide-vue-next';
import type { PropType, Component } from 'vue';
import { useVirtualScroll } from '../../composables/useVirtualScroll';

const { t } = useI18n();

export interface FileTableItem {
  id: number;
  title?: string;
  type?: string;
  fullPath?: string;
  [key: string]: unknown;
}

interface DownloadStateItem {
  state?: string;
  [key: string]: unknown;
}

/** Info precalculada por fileId para el botón de descarga (U4: evitar evaluar por fila en cada render). */
interface DownloadButtonInfo {
  text: string;
  icon: Component;
  buttonClass: string;
  disabled: boolean;
}

const DEFAULT_BUTTON_INFO: DownloadButtonInfo = {
  text: 'Descargar',
  icon: Download,
  buttonClass: 'btn-primary',
  disabled: false,
};

// Props
const props = defineProps({
  files: {
    type: Array as PropType<FileTableItem[]>,
    required: true,
  },
  title: {
    type: String,
    default: 'Archivos',
  },
  selectedFiles: {
    type: Array as PropType<number[]>,
    default: () => [],
  },
  /** Si se pasa, define el estado "todos seleccionados" (p. ej. cuando hay límite de 1000) */
  allSelected: {
    type: Boolean,
    default: undefined,
  },
  downloads: {
    type: Object as PropType<Record<number, DownloadStateItem>>,
    default: () => ({}),
  },
  sortable: {
    type: Boolean,
    default: false,
  },
  sortField: {
    type: String,
    default: 'title',
  },
  sortDirection: {
    type: String,
    default: 'asc',
  },
  showPath: {
    type: Boolean,
    default: false,
  },
  enableVirtualization: {
    type: Boolean,
    default: true,
  },
  /** Sprint 2: Mínimo de items para activar virtualización (default 50, 30 para búsqueda) */
  minItemsToVirtualize: {
    type: Number,
    default: 50,
  },
  overscan: {
    type: Number,
    default: 5,
  },
  currentFolderId: {
    type: Number,
    default: null,
  },
  isAtRoot: {
    type: Boolean,
    default: false,
  },
  /** Filtros activos: mostrar "Archivos: N → Mostrando: M" y badge en botón Filtrar */
  hasActiveFilters: {
    type: Boolean,
    default: false,
  },
  /** Número total de archivos antes de filtrar (cuando hasActiveFilters) */
  totalFileCount: {
    type: Number,
    default: 0,
  },
  /** Cantidad de filtros activos (para badge) */
  activeFilterCount: {
    type: Number,
    default: 0,
  },
});

// Emits
const emit = defineEmits([
  'download',
  'download-selected',
  'download-folder',
  'toggle-select',
  'toggle-select-all',
  'sort',
]);

// Referencias
const tableContainer = ref<HTMLElement | null>(null);

// Solo emitir descarga si el archivo no está ya en la lista
const handleRowDownload = (file: FileTableItem) => {
  if (!(props.downloads as Record<number, DownloadStateItem>)[file.id]) emit('download', file);
};

// Computed: Número de columnas
const columnCount = computed(() => {
  let count = 3;
  if (props.showPath) count++;
  count += 2;
  return count;
});

// Virtual Scroll
const {
  shouldVirtualize,
  visibleRange,
  visibleItems,
  topSpacerHeight,
  bottomSpacerHeight,
  totalHeight,
  handleScroll,
} = useVirtualScroll<FileTableItem>({
  items: computed(() => props.files),
  containerRef: tableContainer,
  itemHeight: 52,
  overscan: props.overscan || 5,
  minItemsToVirtualize: props.minItemsToVirtualize ?? 50,
  enabled: props.enableVirtualization !== false,
});

// Métodos
const formatDate = (dateStr: string | number | undefined | unknown) => {
  if (dateStr === undefined || dateStr === null) return '-';
  try {
    const date = new Date(
      typeof dateStr === 'string' || typeof dateStr === 'number' ? dateStr : String(dateStr)
    );
    return date.toLocaleDateString();
  } catch {
    return String(dateStr);
  }
};

/** Mapa fileId → { text, icon, buttonClass, disabled }; solo entradas con estado de descarga (U4). */
const downloadButtonInfo = computed((): Record<number, DownloadButtonInfo> => {
  const map: Record<number, DownloadButtonInfo> = {};
  const downloads = props.downloads as Record<number, DownloadStateItem>;
  for (const id of Object.keys(downloads).map(Number)) {
    if (Number.isNaN(id)) continue;
    const download = downloads[id];
    if (!download) continue;
    const s = (download.state || '').toLowerCase();
    const disabled = [
      'downloading',
      'merging',
      'verifying',
      'progressing',
      'queued',
      'starting',
      'completed',
    ].includes(s);
    let text = 'Descargar';
    let icon: Component = Download;
    let buttonClass = 'btn-primary';
    if (s === 'completed') {
      text = 'Listo';
      icon = CheckCircle2;
      buttonClass = 'btn-success';
    } else if (['downloading', 'merging', 'verifying', 'progressing'].includes(s)) {
      text = 'Bajando';
      icon = Loader2;
      buttonClass = 'btn-info animating';
    } else if (s === 'paused') {
      text = 'Pausado';
    } else if (s === 'failed') {
      text = 'Error';
      icon = AlertCircle;
      buttonClass = 'btn-danger';
    } else if (s === 'cancelled') {
      text = 'Detenido';
    } else if (['queued', 'starting'].includes(s)) {
      text = 'En cola';
      icon = Clock;
      buttonClass = 'btn-warning';
    }
    map[id] = { text, icon, buttonClass, disabled };
  }
  return map;
});

const getButtonInfo = (fileId: number): DownloadButtonInfo =>
  downloadButtonInfo.value[fileId] ?? DEFAULT_BUTTON_INFO;
</script>

<style scoped>
.animating :deep(svg) {
  animation: spin 2s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* fadeIn definido en utilities.css */
.files-container {
  animation: fadeIn 0.4s ease-out;
}
</style>

<style scoped>
/* Estilos para botones de acción en el header */
.header-buttons {
  display: flex;
  gap: 0.625rem;
}

.filter-files-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0.5rem;
  font-size: 0.95rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 0.125rem 0.25rem rgba(0, 0, 0, 0.1);
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 0.0625rem solid var(--border-color);
}

.filter-files-btn:hover {
  background: var(--bg-tertiary);
  transform: translateY(-0.125rem);
  box-shadow: 0 0.25rem 0.375rem rgba(0, 0, 0, 0.15);
}

.filter-files-btn.has-filters {
  border-color: var(--primary-color);
  color: var(--primary-color);
  background: var(--info-color-alpha-12);
}

.filter-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25rem;
  height: 1.25rem;
  padding: 0 0.375rem;
  font-size: 0.75rem;
  font-weight: 700;
  border-radius: 999px;
  background: var(--primary-color);
  color: white;
  margin-left: 0.25rem;
}

.download-folder-btn,
.download-selected-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0.5rem;
  font-size: 0.95rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 0.125rem 0.25rem rgba(0, 0, 0, 0.1);
}

.download-folder-btn {
  background-color: var(--primary-color);
  color: white;
}

.download-selected-btn {
  background-color: var(--success-color);
  color: white;
}

.download-folder-btn:hover,
.download-selected-btn:hover {
  transform: translateY(-0.125rem);
  filter: brightness(1.1);
  box-shadow: 0 0.25rem 0.375rem rgba(0, 0, 0, 0.15);
}

.download-folder-btn:active,
.download-selected-btn:active {
  transform: translateY(0);
}
</style>
