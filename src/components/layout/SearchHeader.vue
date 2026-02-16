<template>
  <div id="header">
    <!-- Breadcrumb a la izquierda y botón Buscar a la derecha (oculto en vista Cola de descargas) -->
    <nav
      v-if="!isDownloadsView"
      id="breadcrumb"
      class="breadcrumb-nav"
      role="navigation"
    >
      <div class="breadcrumb-list">
        <button
          class="breadcrumb-item"
          :class="{ active: isAtRoot }"
          @click="$emit('go-to-root')"
        >
          <Home :size="14" />
          <span>{{ effectiveRootLabel }}</span>
        </button>
        <template
          v-for="(node, index) in breadcrumbPath"
          :key="node.id"
        >
          <ChevronRight
            class="breadcrumb-sep"
            :size="12"
          />
          <button
            class="breadcrumb-item"
            :class="{ active: index === breadcrumbPath.length - 1 }"
            @click="$emit('navigate-to', node)"
          >
            {{ node.title }}
          </button>
        </template>
      </div>

      <div class="breadcrumb-actions">
        <!-- Filtros: solo visible cuando hay resultados de búsqueda -->
        <button
          v-if="hasSearchResults"
          class="nav-action-btn mini"
          :class="{ active: showAdvancedFilters }"
          :aria-label="t('searchHeader.showHideFilters')"
          @click="$emit('toggle-filters')"
        >
          <Filter :size="14" />
          <span>{{ t('searchHeader.filtersShort') }}</span>
        </button>
        <!-- Buscar: despliega la barra de búsqueda -->
        <button
          class="nav-action-btn mini btn-catalog-search-toggle"
          :class="{ active: showCatalogSearchBar }"
          :aria-label="t('searchHeader.showHideSearch')"
          @click="onNavSearchClick"
        >
          <Search :size="14" />
          <span>{{ t('downloadsPanel.search') }}</span>
        </button>
      </div>
    </nav>

    <!-- Barra de búsqueda: visible al pulsar Buscar o siempre cuando hay búsqueda activa/sin resultados (para poder limpiar) -->
    <div
      v-if="!isDownloadsView && (showCatalogSearchBar || hasActiveSearchOrEmpty)"
      id="search-container"
      class="search-wrapper"
      role="search"
    >
      <div class="search-input-group glass-effect">
        <Search
          class="search-icon"
          :size="18"
        />
        <input
          id="search-input"
          v-model="searchInputValue"
          type="text"
          :placeholder="
            isDownloadsView
              ? t('downloadsPanel.searchPlaceholder')
              : t('searchHeader.searchPlaceholder')
          "
          :aria-label="
            isDownloadsView ? t('searchHeader.filterQueue') : t('searchHeader.searchField')
          "
          @keydown.enter="onSearchKeydown"
        />
        <!-- Modo "Buscar en esta carpeta": solo visible cuando estamos dentro de una carpeta -->
        <button
          v-if="!isDownloadsView && !isAtRoot"
          type="button"
          class="search-scope-folder-btn"
          :class="{ active: searchInCurrentFolder }"
          :aria-label="t('searchHeader.searchInThisFolder')"
          :aria-pressed="searchInCurrentFolder"
          :title="t('searchHeader.searchInThisFolder')"
          @click="$emit('update:searchInCurrentFolder', !searchInCurrentFolder)"
        >
          <Square
            v-if="!searchInCurrentFolder"
            :size="18"
            aria-hidden="true"
          />
          <SquareCheck
            v-else
            :size="18"
            aria-hidden="true"
          />
          <span class="search-scope-folder-label">{{ t('searchHeader.searchInThisFolder') }}</span>
        </button>
        <button
          v-if="!isDownloadsView"
          class="search-action-btn"
          :disabled="searchTerm.trim().length < 2"
          @click="$emit('search')"
        >
          {{ t('downloadsPanel.search') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
import type { PropType } from 'vue';
import { Filter, Search, Home, ChevronRight, Square, SquareCheck } from 'lucide-vue-next';

export interface BreadcrumbNode {
  id: number;
  title?: string;
}

// Props
const props = defineProps({
  showAdvancedFilters: {
    type: Boolean,
    default: false,
  },
  hasSearchResults: {
    type: Boolean,
    default: false,
  },
  /** True cuando hay búsqueda activa (término con 2+ caracteres) o búsqueda devolvió vacío (para mantener barra visible) */
  hasActiveSearchOrEmpty: {
    type: Boolean,
    default: false,
  },
  breadcrumbPath: {
    type: Array as PropType<BreadcrumbNode[]>,
    default: () => [],
  },
  isAtRoot: {
    type: Boolean,
    default: true,
  },
  /** Etiqueta del primer segmento (ej. "Inicio" o "Favoritos"). Por defecto nav.home */
  rootLabel: {
    type: String,
    default: '',
  },
  searchTerm: {
    type: String,
    default: '',
  },
  queueSearchTerm: {
    type: String,
    default: '',
  },
  isDownloadsView: {
    type: Boolean,
    default: false,
  },
  showCatalogSearchBar: {
    type: Boolean,
    default: false,
  },
  /** Modo "Buscar en esta carpeta": limita resultados a la carpeta actual y sus subcarpetas */
  searchInCurrentFolder: {
    type: Boolean,
    default: false,
  },
});

// Emits
const emit = defineEmits([
  'toggle-filters',
  'go-to-root',
  'navigate-to',
  'search',
  'update:searchTerm',
  'update:queueSearchTerm',
  'update:searchInCurrentFolder',
  'toggle-catalog-search',
]);

// Etiqueta efectiva del root: prop o i18n por defecto
const effectiveRootLabel = computed(() => (props.rootLabel ? props.rootLabel : t('nav.home')));

// Valor del input: enlazado al término correcto según la vista para que v-model funcione en ambos sentidos
const searchInputValue = computed({
  get() {
    return props.isDownloadsView ? props.queueSearchTerm : props.searchTerm;
  },
  set(value) {
    if (props.isDownloadsView) {
      emit('update:queueSearchTerm', value);
    } else {
      emit('update:searchTerm', value);
    }
  },
});

function onSearchKeydown() {
  if (!props.isDownloadsView) {
    emit('search');
  }
}

/** Si la barra está abierta y hay término, ejecutar búsqueda; si no, abrir/cerrar barra */
function onNavSearchClick() {
  if (!props.isDownloadsView && props.showCatalogSearchBar && props.searchTerm.trim().length >= 2) {
    emit('search');
  } else {
    emit('toggle-catalog-search');
  }
}
</script>

<!-- Sin estilos - usa style.css global -->
