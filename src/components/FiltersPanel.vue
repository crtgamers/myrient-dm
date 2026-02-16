<template>
  <!-- Solo el panel (el overlay está en App.vue y hace fade; así solo este panel se desliza) -->
  <div
    ref="filtersPanelRef"
    class="filters-panel glass-effect"
    role="dialog"
    aria-modal="true"
    aria-labelledby="filters-panel-title"
  >
    <!-- Header -->
    <div class="filters-header">
      <div class="header-title">
        <Filter :size="20" />
        <h2 id="filters-panel-title">{{ t('filters.title') }}</h2>
      </div>
      <button
        type="button"
        class="btn-close-panel"
        :title="t('filters.closePanel')"
        :aria-label="t('filters.closePanelAria')"
        @click="$emit('close')"
      >
        <X :size="20" />
      </button>
    </div>

    <!-- Body -->
    <div class="filters-body-scroll">
      <!-- Presets Card -->
      <div class="filter-group-card">
        <div class="group-label">
          <Bookmark :size="16" />
          <span>{{ t('filters.savedConfigs') }}</span>
        </div>
        <div class="preset-manager">
          <div class="select-wrapper">
            <select
              v-model="currentPreset"
              class="modern-select"
              @change="handleLoadPreset"
            >
              <option value="">{{ t('filters.loadPreset') }}</option>
              <option
                v-for="(_preset, name) in filterPresets"
                :key="name"
                :value="name"
              >
                {{ name }}
              </option>
            </select>
            <ChevronDown
              class="select-arrow"
              :size="14"
            />
          </div>

          <div class="save-preset-input">
            <input
              v-model="presetName"
              type="text"
              class="modern-input"
              :placeholder="t('filters.newNamePlaceholder')"
              @keydown.enter="handleSavePreset"
            />
            <button
              class="icon-action-btn primary"
              :title="t('filters.savePreset')"
              :aria-label="t('filters.savePreset')"
              :disabled="!presetName.trim()"
              @click="handleSavePreset"
            >
              <Save
                :size="18"
                aria-hidden="true"
              />
            </button>
          </div>

          <button
            v-if="currentPreset"
            class="btn-text-danger"
            @click="handleDeletePreset"
          >
            <Trash2 :size="14" />
            <span>{{ t('filters.deletePreset') }}</span>
          </button>
        </div>
      </div>

      <!-- Filtros de Texto -->
      <div class="filter-group-card">
        <div class="group-label">
          <Type :size="16" />
          <span>{{ t('filters.textRules') }}</span>
        </div>

        <!-- Incluir -->
        <div class="sub-filter">
          <label>{{ t('filters.allowedWords') }}</label>
          <div class="input-add-group">
            <input
              v-model="tempIncludeText"
              type="text"
              class="modern-input"
              :placeholder="t('filters.exampleInclude')"
              @keydown.enter="addIncludeText"
            />
            <button
              class="add-btn"
              :aria-label="t('filters.addIncludeAria')"
              @click="addIncludeText"
            >
              <Plus
                :size="18"
                aria-hidden="true"
              />
            </button>
          </div>
          <div class="tag-cloud">
            <div
              v-for="(text, index) in advancedFilters.includeText"
              :key="'inc-' + index"
              class="filter-tag include"
            >
              <span>{{ text }}</span>
              <button
                :aria-label="t('filters.removeItemAria')"
                @click="removeIncludeText(index)"
              >
                <X
                  :size="12"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
        </div>

        <!-- Excluir -->
        <div class="sub-filter">
          <label>{{ t('filters.blockedWords') }}</label>
          <div class="input-add-group">
            <input
              v-model="tempExcludeText"
              type="text"
              class="modern-input"
              :placeholder="t('filters.exampleExclude')"
              @keydown.enter="addExcludeText"
            />
            <button
              class="add-btn danger"
              :aria-label="t('filters.addExcludeAria')"
              @click="addExcludeText"
            >
              <Plus
                :size="18"
                aria-hidden="true"
              />
            </button>
          </div>
          <div class="tag-cloud">
            <div
              v-for="(text, index) in advancedFilters.excludeText"
              :key="'exc-' + index"
              class="filter-tag exclude"
            >
              <span>{{ text }}</span>
              <button
                :aria-label="t('filters.removeItemAria')"
                @click="removeExcludeText(index)"
              >
                <X
                  :size="12"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Filtro por consola: solo aplicable tras tener resultados (proyecto/búsqueda); estado persistente mientras el panel esté abierto -->
      <div class="filter-group-card">
        <div class="group-label">
          <Layers :size="16" />
          <span>{{ t('filters.systemsProjects') }}</span>
        </div>
        <p
          v-if="!hasProjectOrSearchResults"
          class="empty-hint"
        >
          {{ t('filters.consoleFilterHint') }}
        </p>
        <div
          v-else-if="availableConsoles && availableConsoles.length > 0"
          class="checkbox-grid"
        >
          <label
            v-for="console in availableConsoles"
            :key="console"
            class="modern-checkbox-label"
          >
            <input
              :checked="advancedFilters.consoles.includes(console)"
              type="checkbox"
              class="ios-switch"
              @change="toggleConsole(console)"
            />
            <span class="label-text">{{ console }}</span>
          </label>
        </div>
        <p
          v-else
          class="empty-hint"
        >
          {{ t('filters.consoleFilterHint') }}
        </p>
      </div>

      <!-- Categorías de Etiquetas -->
      <div
        v-if="availableTags"
        class="filter-group-card"
      >
        <div class="group-label">
          <Tag :size="16" />
          <span>{{ t('filters.advancedTags') }}</span>
        </div>

        <!-- Regiones -->
        <div
          v-if="availableTags.regions.length > 0"
          class="tag-category-block"
        >
          <div class="block-header">
            <Globe :size="14" />
            <span>{{ t('filters.regions') }}</span>
          </div>
          <div class="tag-selection-grid">
            <div class="tag-column">
              <span class="col-title">{{ t('filters.include') }}</span>
              <div class="tag-list-scroll">
                <label
                  v-for="tag in availableTags.regions"
                  :key="'inc-reg-' + tag"
                  class="tag-pill-check"
                  :class="{ active: advancedFilters.includeTags.regions.includes(tag) }"
                >
                  <input
                    type="checkbox"
                    class="form-checkbox"
                    :checked="advancedFilters.includeTags.regions.includes(tag)"
                    @change="toggleTag('regions', 'include', tag)"
                  />
                  {{ tag }}
                </label>
              </div>
            </div>
            <div class="tag-column">
              <span class="col-title">{{ t('filters.exclude') }}</span>
              <div class="tag-list-scroll">
                <label
                  v-for="tag in availableTags.regions"
                  :key="'exc-reg-' + tag"
                  class="tag-pill-check exclude"
                  :class="{ active: advancedFilters.excludeTags.regions.includes(tag) }"
                >
                  <input
                    type="checkbox"
                    class="form-checkbox"
                    :checked="advancedFilters.excludeTags.regions.includes(tag)"
                    @change="toggleTag('regions', 'exclude', tag)"
                  />
                  {{ tag }}
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- Idiomas -->
        <div
          v-if="availableTags.languages.length > 0"
          class="tag-category-block"
        >
          <div class="block-header">
            <span>{{ t('filters.languages') }}</span>
          </div>
          <div class="tag-selection-grid">
            <div class="tag-column">
              <span class="col-title">{{ t('filters.include') }}</span>
              <div class="tag-list-scroll">
                <label
                  v-for="tag in availableTags.languages"
                  :key="'inc-lang-' + tag"
                  class="tag-pill-check"
                  :class="{ active: advancedFilters.includeTags.languages.includes(tag) }"
                >
                  <input
                    type="checkbox"
                    class="form-checkbox"
                    :checked="advancedFilters.includeTags.languages.includes(tag)"
                    @change="toggleTag('languages', 'include', tag)"
                  />
                  {{ tag }}
                </label>
              </div>
            </div>
            <div class="tag-column">
              <span class="col-title">{{ t('filters.exclude') }}</span>
              <div class="tag-list-scroll">
                <label
                  v-for="tag in availableTags.languages"
                  :key="'exc-lang-' + tag"
                  class="tag-pill-check exclude"
                  :class="{ active: advancedFilters.excludeTags.languages.includes(tag) }"
                >
                  <input
                    type="checkbox"
                    class="form-checkbox"
                    :checked="advancedFilters.excludeTags.languages.includes(tag)"
                    @change="toggleTag('languages', 'exclude', tag)"
                  />
                  {{ tag }}
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- Tipo / categoría (No-Intro/Redump) -->
        <div
          v-if="availableTags.types && availableTags.types.length > 0"
          class="tag-category-block"
        >
          <div class="block-header">
            <span>{{ t('filters.typeCategory') }}</span>
          </div>
          <div class="tag-selection-grid">
            <div class="tag-column">
              <span class="col-title">{{ t('filters.include') }}</span>
              <div class="tag-list-scroll">
                <label
                  v-for="tag in availableTags.types"
                  :key="'inc-type-' + tag"
                  class="tag-pill-check"
                  :class="{ active: advancedFilters.includeTags.types.includes(tag) }"
                >
                  <input
                    type="checkbox"
                    class="form-checkbox"
                    :checked="advancedFilters.includeTags.types.includes(tag)"
                    @change="toggleTag('types', 'include', tag)"
                  />
                  {{ tag }}
                </label>
              </div>
            </div>
            <div class="tag-column">
              <span class="col-title">{{ t('filters.exclude') }}</span>
              <div class="tag-list-scroll">
                <label
                  v-for="tag in availableTags.types"
                  :key="'exc-type-' + tag"
                  class="tag-pill-check exclude"
                  :class="{ active: advancedFilters.excludeTags.types.includes(tag) }"
                >
                  <input
                    type="checkbox"
                    class="form-checkbox"
                    :checked="advancedFilters.excludeTags.types.includes(tag)"
                    @change="toggleTag('types', 'exclude', tag)"
                  />
                  {{ tag }}
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- Estado / flags -->
        <div
          v-if="availableTags.statusFlags && availableTags.statusFlags.length > 0"
          class="tag-category-block"
        >
          <div class="block-header">
            <span>{{ t('filters.statusFlags') }}</span>
          </div>
          <div class="tag-selection-grid">
            <div class="tag-column">
              <span class="col-title">{{ t('filters.include') }}</span>
              <div class="tag-list-scroll">
                <label
                  v-for="tag in availableTags.statusFlags"
                  :key="'inc-flag-' + tag"
                  class="tag-pill-check"
                  :class="{ active: advancedFilters.includeTags.statusFlags.includes(tag) }"
                >
                  <input
                    type="checkbox"
                    class="form-checkbox"
                    :checked="advancedFilters.includeTags.statusFlags.includes(tag)"
                    @change="toggleTag('statusFlags', 'include', tag)"
                  />
                  {{ tag }}
                </label>
              </div>
            </div>
            <div class="tag-column">
              <span class="col-title">{{ t('filters.exclude') }}</span>
              <div class="tag-list-scroll">
                <label
                  v-for="tag in availableTags.statusFlags"
                  :key="'exc-flag-' + tag"
                  class="tag-pill-check exclude"
                  :class="{ active: advancedFilters.excludeTags.statusFlags.includes(tag) }"
                >
                  <input
                    type="checkbox"
                    class="form-checkbox"
                    :checked="advancedFilters.excludeTags.statusFlags.includes(tag)"
                    @change="toggleTag('statusFlags', 'exclude', tag)"
                  />
                  {{ tag }}
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Solo versiones limpias (No-Intro/Redump) -->
      <div class="filter-group-card">
        <div class="group-label">
          <Filter :size="16" />
          <span>{{ t('filters.cleanOnlyTitle') }}</span>
        </div>
        <div class="clean-only-grid">
          <label class="modern-checkbox-label">
            <input
              v-model="advancedFilters.cleanOnly.noHacks"
              type="checkbox"
              class="ios-switch"
            />
            <span class="label-text">{{ t('filters.cleanOnlyNoHacks') }}</span>
          </label>
          <label class="modern-checkbox-label">
            <input
              v-model="advancedFilters.cleanOnly.noTranslations"
              type="checkbox"
              class="ios-switch"
            />
            <span class="label-text">{{ t('filters.cleanOnlyNoTranslations') }}</span>
          </label>
          <label class="modern-checkbox-label">
            <input
              v-model="advancedFilters.cleanOnly.noPrototypes"
              type="checkbox"
              class="ios-switch"
            />
            <span class="label-text">{{ t('filters.cleanOnlyNoPrototypes') }}</span>
          </label>
          <label class="modern-checkbox-label">
            <input
              v-model="advancedFilters.cleanOnly.noBetas"
              type="checkbox"
              class="ios-switch"
            />
            <span class="label-text">{{ t('filters.cleanOnlyNoBetas') }}</span>
          </label>
        </div>
      </div>
    </div>

    <!-- Footer Estadísticas -->
    <div class="filters-footer">
      <div class="footer-stats">
        <span class="stat-count">{{ activeFilterCount }}</span>
        <span class="stat-label">{{ t('filters.filtersApplied') }}</span>
      </div>
      <button
        v-if="hasActiveFilters"
        class="clear-all-btn"
        :aria-label="t('filters.clearAllAria')"
        @click="handleClearFilters"
      >
        <RefreshCw :size="14" />
        {{ t('filters.clearAll') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  Filter,
  X,
  Bookmark,
  Save,
  Trash2,
  Type,
  Plus,
  Layers,
  Tag,
  Globe,
  ChevronDown,
  RefreshCw,
} from 'lucide-vue-next';
import { useFilters, type FilterableItem, type TagCategories } from '../composables/useFilters';
import { useModalFocusTrap } from '../composables/useModalFocusTrap';

const props = defineProps({
  searchResults: {
    type: Array as PropType<FilterableItem[]>,
    default: () => [],
  },
});

const emit = defineEmits(['close']);
const { t } = useI18n();

const filtersPanelRef = ref<HTMLElement | null>(null);
/** Panel visible mientras el componente está montado (no tiene prop show). */
useModalFocusTrap(filtersPanelRef, ref(true), () => emit('close'));

const {
  advancedFilters,
  filterPresets,
  currentFilterPreset,
  tempIncludeText,
  tempExcludeText,
  hasActiveFilters,
  activeFilterCount,
  getAvailableTags,
  getAvailableConsoles,
  addIncludeText: addIncludeTextOriginal,
  removeIncludeText: removeIncludeTextOriginal,
  addExcludeText: addExcludeTextOriginal,
  removeExcludeText: removeExcludeTextOriginal,
  savePreset: savePresetOriginal,
  loadPreset: loadPresetOriginal,
  deletePreset: deletePresetOriginal,
  clearAllFilters: clearAllFiltersOriginal,
} = useFilters();

const presetName = ref('');
const currentPreset = ref('');

/** Hay datos de proyecto o búsqueda para poder filtrar por consola (estado persistente mientras el panel esté abierto) */
const hasProjectOrSearchResults = computed(() => props.searchResults.length > 0);

const availableTags = computed(() => {
  if (props.searchResults.length === 0) return null;
  return getAvailableTags(props.searchResults);
});

const availableConsoles = computed(() => {
  if (props.searchResults.length === 0) return null;
  return getAvailableConsoles(props.searchResults);
});

watch(
  () => currentFilterPreset.value,
  newValue => {
    currentPreset.value = newValue;
  },
  { immediate: true }
);

const addIncludeText = () => addIncludeTextOriginal();
const removeIncludeText = (index: number) => removeIncludeTextOriginal(index);
const addExcludeText = () => addExcludeTextOriginal();
const removeExcludeText = (index: number) => removeExcludeTextOriginal(index);

const toggleTag = (category: keyof TagCategories, type: 'include' | 'exclude', tag: string) => {
  const target =
    type === 'include' ? advancedFilters.value.includeTags : advancedFilters.value.excludeTags;
  const opposite =
    type === 'include' ? advancedFilters.value.excludeTags : advancedFilters.value.includeTags;

  const idx = target[category].indexOf(tag);
  if (idx >= 0) {
    target[category].splice(idx, 1);
  } else {
    const oppositeIndex = opposite[category].indexOf(tag);
    if (oppositeIndex >= 0) opposite[category].splice(oppositeIndex, 1);
    target[category].push(tag);
  }
};

const handleSavePreset = () => {
  if (!presetName.value.trim()) return;
  currentFilterPreset.value = presetName.value.trim();
  savePresetOriginal();
  currentPreset.value = presetName.value.trim();
  presetName.value = '';
};

const handleLoadPreset = () => {
  if (!currentPreset.value) return;
  currentFilterPreset.value = currentPreset.value;
  loadPresetOriginal();
};

const handleDeletePreset = () => {
  if (!currentPreset.value) return;
  deletePresetOriginal(currentPreset.value);
  currentPreset.value = '';
  presetName.value = '';
};

const toggleConsole = (consoleName: string) => {
  const index = advancedFilters.value.consoles.indexOf(consoleName);
  if (index >= 0) advancedFilters.value.consoles.splice(index, 1);
  else advancedFilters.value.consoles.push(consoleName);
};

const handleClearFilters = () => {
  clearAllFiltersOriginal();
  currentPreset.value = '';
  presetName.value = '';
};
</script>

<style scoped>
.filters-body-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
  scrollbar-width: thin;
}

.filter-group-card {
  background: var(--bg-secondary);
  border: 0.0625rem solid var(--border-color);
  border-radius: var(--radius-xl);
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.group-label {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  color: var(--primary-color);
  font-weight: 800;
  font-size: 0.8125rem;
  text-transform: uppercase;
  letter-spacing: 0.0625rem;
}

.save-preset-input {
  display: flex;
  gap: var(--spacing-sm);
}

.icon-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-text-danger {
  background: transparent;
  border: none;
  color: var(--danger-color);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: var(--spacing-xs);
  width: fit-content;
}

/* Tags */
.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-top: 0.625rem;
}

.preset-manager {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.filter-tag {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: var(--spacing-xs) 0.625rem;
  border-radius: var(--radius-full);
  font-size: var(--text-sm);
  font-weight: 600;
}

.filter-tag.include {
  background: var(--primary-color-alpha);
  color: var(--primary-color);
}
.filter-tag.exclude {
  background: var(--danger-color-alpha-10);
  color: var(--danger-color);
}

.filter-tag button {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  display: flex;
  padding: 0;
  opacity: 0.7;
}

.filter-tag button:hover {
  opacity: 1;
}

.checkbox-grid,
.clean-only-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--spacing-sm);
}

.modern-checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  cursor: pointer;
  padding: var(--spacing-sm);
  border-radius: var(--radius-md);
  transition: background 0.2s;
}

.modern-checkbox-label:hover {
  background: var(--bg-tertiary);
}

.label-text {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-primary);
}

.filters-footer {
  padding: 1.25rem var(--spacing-lg);
  background: var(--bg-tertiary);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.footer-stats {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
}
.stat-count {
  font-size: var(--text-xl);
  font-weight: 900;
  color: var(--primary-color);
}
.stat-label {
  font-size: var(--text-sm);
  color: var(--text-muted);
  font-weight: 600;
  text-transform: uppercase;
}

.clear-all-btn {
  background: transparent;
  border: 0.0625rem solid var(--danger-color);
  color: var(--danger-color);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-full);
  font-size: var(--text-sm);
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  transition: all 0.2s;
}

.clear-all-btn:hover {
  background: var(--danger-color);
  color: white;
}

.tag-selection-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--spacing-md);
}

.tag-column {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}
.col-title {
  font-size: 0.6875rem;
  font-weight: 800;
  color: var(--text-muted);
  text-transform: uppercase;
}

.tag-list-scroll {
  max-height: 12.5rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.tag-pill-check {
  font-size: var(--text-sm);
  padding: 0.375rem 0.625rem;
  border-radius: var(--radius-md);
  background: var(--bg-tertiary);
  cursor: pointer;
  transition: all 0.2s;
  border: 0.0625rem solid transparent;
}

.tag-pill-check.active {
  background: var(--primary-color-alpha);
  border-color: var(--primary-color);
  color: var(--primary-color);
}
.tag-pill-check.exclude.active {
  background: var(--danger-color-alpha-10);
  border-color: var(--danger-color);
  color: var(--danger-color);
}

.tag-pill-check input {
  display: none;
}
</style>
