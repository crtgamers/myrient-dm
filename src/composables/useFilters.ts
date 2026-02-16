/**
 * @fileoverview Composable para filtros avanzados en el catálogo
 * @module useFilters
 */

import { ref, computed } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import { readConfigFile, writeConfigFile } from '../services/api';
import logger from '../utils/logger';

export interface CleanOnlyState {
  noHacks: boolean;
  noTranslations: boolean;
  noPrototypes: boolean;
  noBetas: boolean;
}

export interface TagCategories {
  regions: string[];
  languages: string[];
  versions: string[];
  types: string[];
  statusFlags: string[];
  other: string[];
}

export interface AdvancedFiltersState {
  includeText: string[];
  excludeText: string[];
  consoles: string[];
  includeTags: TagCategories;
  excludeTags: TagCategories;
  cleanOnly: CleanOnlyState;
}

export const TAG_PATTERNS: Record<string, string[]> = {
  regions: [
    'USA',
    'Europe',
    'Japan',
    'World',
    'Asia',
    'Australia',
    'Brazil',
    'Canada',
    'China',
    'France',
    'Germany',
    'Italy',
    'Korea',
    'Netherlands',
    'Spain',
    'Sweden',
    'UK',
  ],
  languages: [
    'En',
    'Es',
    'Fr',
    'De',
    'It',
    'Ja',
    'Ko',
    'Pt',
    'Zh',
    'Nl',
    'Sv',
    'No',
    'Da',
    'Fi',
    'Pl',
    'Ru',
  ],
  versions: ['Rev', 'v1', 'v2', 'Beta', 'Proto', 'Demo', 'Sample', 'Promo', 'Alt', 'Unl'],
  types: ['Game', 'Demo', 'Beta', 'Prototype', 'Sample', 'Program', 'BIOS', 'Proto', 'Promo'],
  statusFlags: ['Rev', 'Rev A', 'v1', 'v2', 'v1.1', 'Beta', 'Proto', 'Unl', 'Hack', 'Fixed', 'Alt'],
};

const defaultFiltersState = (): AdvancedFiltersState => ({
  includeText: [],
  excludeText: [],
  consoles: [],
  includeTags: {
    regions: [],
    languages: [],
    versions: [],
    types: [],
    statusFlags: [],
    other: [],
  },
  excludeTags: {
    regions: [],
    languages: [],
    versions: [],
    types: [],
    statusFlags: [],
    other: [],
  },
  cleanOnly: {
    noHacks: false,
    noTranslations: false,
    noPrototypes: false,
    noBetas: false,
  },
});

const showAdvancedFilters = ref(false);
const advancedFilters = ref<AdvancedFiltersState>(defaultFiltersState());
const filterPresets = ref<Record<string, AdvancedFiltersState>>({});
const currentFilterPreset = ref('');
const tempIncludeText = ref('');
const tempExcludeText = ref('');

export interface FilterableItem {
  id?: number;
  title: string;
  type?: string;
  fullPath?: string;
  breadcrumbPath?: string;
  displayTitle?: string;
  [key: string]: unknown;
}

/**
 * Composable de filtros avanzados en el catálogo: include/exclude por texto y tags, consolas, cleanOnly y presets.
 * Persistencia en advancedFilters.json.
 * @returns showAdvancedFilters, advancedFilters, filterPresets, hasActiveFilters, applyFilters, getAvailableTags, getAvailableConsoles, y acciones para modificar filtros.
 */
export function useFilters(): {
  showAdvancedFilters: Ref<boolean>;
  advancedFilters: Ref<AdvancedFiltersState>;
  filterPresets: Ref<Record<string, AdvancedFiltersState>>;
  currentFilterPreset: Ref<string>;
  tempIncludeText: Ref<string>;
  tempExcludeText: Ref<string>;
  hasActiveFilters: ComputedRef<boolean>;
  activeFilterCount: ComputedRef<number>;
  extractTags: (_title: string) => string[];
  classifyTag: (_tag: string) => string;
  applyFilters: (_items: FilterableItem[]) => FilterableItem[];
  getAvailableTags: (_items: FilterableItem[]) => Record<string, string[]>;
  getAvailableConsoles: (_items: FilterableItem[]) => string[];
  addIncludeText: () => void;
  removeIncludeText: (_index: number) => void;
  addExcludeText: () => void;
  removeExcludeText: (_index: number) => void;
  selectAllTags: (
    _category: keyof TagCategories,
    _type: 'include' | 'exclude',
    _availableTags: string[]
  ) => void;
  clearTagCategory: (_category: keyof TagCategories, _type: 'include' | 'exclude') => void;
  loadFilterPresets: () => Promise<void>;
  saveFilterPresets: () => Promise<void>;
  savePreset: () => void;
  loadPreset: () => void;
  deletePreset: (_name: string) => void;
  clearAllFilters: () => void;
  resetFiltersOnDatabaseChange: () => void;
  toggleFiltersPanel: () => void;
} {
  const extractTags = (title: string): string[] => {
    const tagMatch = title.match(/\(([^)]+)\)/g);
    if (!tagMatch) return [];
    return tagMatch.map(t => t.replace(/[()]/g, '').trim());
  };

  const classifyTag = (tag: string): string => {
    if (TAG_PATTERNS.regions.some(r => tag.includes(r))) return 'regions';
    if (TAG_PATTERNS.languages.some(l => tag === l || tag.startsWith(l + ','))) return 'languages';
    if (TAG_PATTERNS.types.some(t => tag.includes(t))) return 'types';
    if (TAG_PATTERNS.statusFlags.some(s => tag.includes(s))) return 'statusFlags';
    if (TAG_PATTERNS.versions.some(v => tag.includes(v))) return 'versions';
    return 'other';
  };

  const hasActiveFilters = computed(() => {
    const f = advancedFilters.value;
    const clean = f.cleanOnly ?? {};
    return (
      f.includeText.length > 0 ||
      f.excludeText.length > 0 ||
      f.consoles.length > 0 ||
      f.includeTags.regions.length > 0 ||
      f.includeTags.languages.length > 0 ||
      f.includeTags.versions.length > 0 ||
      f.includeTags.types.length > 0 ||
      f.includeTags.statusFlags.length > 0 ||
      f.includeTags.other.length > 0 ||
      f.excludeTags.regions.length > 0 ||
      f.excludeTags.languages.length > 0 ||
      f.excludeTags.versions.length > 0 ||
      f.excludeTags.types.length > 0 ||
      f.excludeTags.statusFlags.length > 0 ||
      f.excludeTags.other.length > 0 ||
      clean.noHacks ||
      clean.noTranslations ||
      clean.noPrototypes ||
      clean.noBetas
    );
  });

  const activeFilterCount = computed(() => {
    const f = advancedFilters.value;
    const clean = f.cleanOnly ?? {};
    let n =
      f.includeText.length +
      f.excludeText.length +
      f.consoles.length +
      f.includeTags.regions.length +
      f.includeTags.languages.length +
      f.includeTags.versions.length +
      f.includeTags.types.length +
      f.includeTags.statusFlags.length +
      f.includeTags.other.length +
      f.excludeTags.regions.length +
      f.excludeTags.languages.length +
      f.excludeTags.versions.length +
      f.excludeTags.types.length +
      f.excludeTags.statusFlags.length +
      f.excludeTags.other.length;
    if (clean.noHacks) n += 1;
    if (clean.noTranslations) n += 1;
    if (clean.noPrototypes) n += 1;
    if (clean.noBetas) n += 1;
    return n;
  });

  const applyFilters = (items: FilterableItem[]): FilterableItem[] => {
    if (!hasActiveFilters.value) return items;
    return items.filter(item => {
      const title = (item.title ?? '').toLowerCase();
      const tags = extractTags(item.title ?? '');

      if (advancedFilters.value.includeText.length > 0) {
        const includeMatch = advancedFilters.value.includeText.some(text =>
          title.includes(text.toLowerCase())
        );
        if (!includeMatch) return false;
      }
      if (advancedFilters.value.excludeText.length > 0) {
        const excludeMatch = advancedFilters.value.excludeText.some(text =>
          title.includes(text.toLowerCase())
        );
        if (excludeMatch) return false;
      }
      if (advancedFilters.value.consoles.length > 0) {
        const folderPath = item.fullPath ?? item.breadcrumbPath ?? '';
        const pathParts = String(folderPath)
          .split('/')
          .filter(p => p.trim());
        const setName = pathParts.length > 0 ? pathParts[0] : '';
        if (!setName && item.type === 'folder' && item.displayTitle) {
          const displayParts = String(item.displayTitle)
            .split(' / ')
            .filter(p => p.trim());
          const setFromDisplay = displayParts.length > 0 ? displayParts[0] : '';
          if (setFromDisplay) {
            const setMatch = advancedFilters.value.consoles.some(
              set =>
                setFromDisplay.toLowerCase().includes(set.toLowerCase()) ||
                set.toLowerCase().includes(setFromDisplay.toLowerCase())
            );
            if (!setMatch) return false;
          } else {
            return false;
          }
        } else if (setName) {
          const setMatch = advancedFilters.value.consoles.some(
            set =>
              setName.toLowerCase().includes(set.toLowerCase()) ||
              set.toLowerCase().includes(setName.toLowerCase())
          );
          if (!setMatch) return false;
        } else {
          return false;
        }
      }
      const includeTagsActive =
        advancedFilters.value.includeTags.regions.length > 0 ||
        advancedFilters.value.includeTags.languages.length > 0 ||
        advancedFilters.value.includeTags.versions.length > 0 ||
        advancedFilters.value.includeTags.types.length > 0 ||
        advancedFilters.value.includeTags.statusFlags.length > 0 ||
        advancedFilters.value.includeTags.other.length > 0;
      if (includeTagsActive) {
        const hasRequiredTag = tags.some(tag =>
          [
            advancedFilters.value.includeTags.regions,
            advancedFilters.value.includeTags.languages,
            advancedFilters.value.includeTags.versions,
            advancedFilters.value.includeTags.types,
            advancedFilters.value.includeTags.statusFlags,
            advancedFilters.value.includeTags.other,
          ].some(arr => arr.includes(tag))
        );
        if (!hasRequiredTag) return false;
      }
      const hasExcludedTag = tags.some(tag =>
        [
          advancedFilters.value.excludeTags.regions,
          advancedFilters.value.excludeTags.languages,
          advancedFilters.value.excludeTags.versions,
          advancedFilters.value.excludeTags.types,
          advancedFilters.value.excludeTags.statusFlags,
          advancedFilters.value.excludeTags.other,
        ].some(arr => arr.includes(tag))
      );
      if (hasExcludedTag) return false;
      const clean = advancedFilters.value.cleanOnly ?? {};
      if (clean.noHacks && tags.some(t => /hack/i.test(t))) return false;
      if (clean.noTranslations && tags.some(t => /translation|translated|tr/i.test(t)))
        return false;
      if (clean.noPrototypes && tags.some(t => /proto/i.test(t))) return false;
      if (clean.noBetas && tags.some(t => /beta/i.test(t))) return false;
      return true;
    });
  };

  const getAvailableTags = (items: FilterableItem[]): Record<string, string[]> => {
    const tags: Record<string, Set<string>> = {
      regions: new Set(),
      languages: new Set(),
      versions: new Set(),
      types: new Set(),
      statusFlags: new Set(),
      other: new Set(),
    };
    items.forEach(item => {
      extractTags(item.title ?? '').forEach(tag => {
        const category = classifyTag(tag);
        tags[category].add(tag);
      });
    });
    return {
      regions: Array.from(tags.regions).sort(),
      languages: Array.from(tags.languages).sort(),
      versions: Array.from(tags.versions).sort(),
      types: Array.from(tags.types).sort(),
      statusFlags: Array.from(tags.statusFlags).sort(),
      other: Array.from(tags.other).sort(),
    };
  };

  const getAvailableConsoles = (items: FilterableItem[]): string[] => {
    const consoles = new Set<string>();
    items.forEach(item => {
      const folderPath = item.fullPath ?? item.breadcrumbPath ?? '';
      const pathParts = String(folderPath)
        .split('/')
        .filter(p => p.trim());
      if (pathParts.length > 0) {
        consoles.add(pathParts[0]);
      } else if (item.type === 'folder' && item.displayTitle) {
        const displayParts = String(item.displayTitle)
          .split(' / ')
          .filter(p => p.trim());
        if (displayParts.length > 0) consoles.add(displayParts[0]);
      }
    });
    return Array.from(consoles).sort();
  };

  const addIncludeText = (): void => {
    const text = tempIncludeText.value.trim();
    if (text && !advancedFilters.value.includeText.includes(text)) {
      advancedFilters.value.includeText.push(text);
    }
    tempIncludeText.value = '';
  };

  const removeIncludeText = (index: number): void => {
    advancedFilters.value.includeText.splice(index, 1);
  };

  const addExcludeText = (): void => {
    const text = tempExcludeText.value.trim();
    if (text && !advancedFilters.value.excludeText.includes(text)) {
      advancedFilters.value.excludeText.push(text);
    }
    tempExcludeText.value = '';
  };

  const removeExcludeText = (index: number): void => {
    advancedFilters.value.excludeText.splice(index, 1);
  };

  const selectAllTags = (
    category: keyof TagCategories,
    type: 'include' | 'exclude',
    availableTags: string[]
  ): void => {
    const target =
      type === 'include' ? advancedFilters.value.includeTags : advancedFilters.value.excludeTags;
    const opposite =
      type === 'include' ? advancedFilters.value.excludeTags : advancedFilters.value.includeTags;
    target[category] = availableTags.filter(tag => !opposite[category].includes(tag));
  };

  const clearTagCategory = (category: keyof TagCategories, type: 'include' | 'exclude'): void => {
    const target =
      type === 'include' ? advancedFilters.value.includeTags : advancedFilters.value.excludeTags;
    target[category] = [];
  };

  const loadFilterPresets = async (): Promise<void> => {
    try {
      const result = await readConfigFile('filter-presets.json');
      if (result.success && result.data) {
        filterPresets.value = result.data as Record<string, AdvancedFiltersState>;
      }
    } catch (error) {
      logger.child('Filters').error('Error cargando presets', error);
    }
  };

  const saveFilterPresets = async (): Promise<void> => {
    try {
      await writeConfigFile('filter-presets.json', filterPresets.value);
    } catch (error) {
      logger.child('Filters').error('Error guardando presets', error);
    }
  };

  const savePreset = (): void => {
    const name = currentFilterPreset.value.trim();
    if (!name) return;
    filterPresets.value[name] = JSON.parse(JSON.stringify(advancedFilters.value));
    void saveFilterPresets();
  };

  const loadPreset = (): void => {
    const name = currentFilterPreset.value;
    if (!name || !filterPresets.value[name]) return;
    advancedFilters.value = JSON.parse(JSON.stringify(filterPresets.value[name]));
  };

  const deletePreset = (name: string): void => {
    if (filterPresets.value[name]) {
      delete filterPresets.value[name];
      void saveFilterPresets();
      if (currentFilterPreset.value === name) currentFilterPreset.value = '';
    }
  };

  const clearAllFilters = (): void => {
    advancedFilters.value = defaultFiltersState();
    currentFilterPreset.value = '';
  };

  const resetFiltersOnDatabaseChange = (): void => {
    clearAllFilters();
  };

  const toggleFiltersPanel = (): void => {
    showAdvancedFilters.value = !showAdvancedFilters.value;
  };

  return {
    showAdvancedFilters,
    advancedFilters,
    filterPresets,
    currentFilterPreset,
    tempIncludeText,
    tempExcludeText,
    hasActiveFilters,
    activeFilterCount,
    extractTags,
    classifyTag,
    applyFilters,
    getAvailableTags,
    getAvailableConsoles,
    addIncludeText,
    removeIncludeText,
    addExcludeText,
    removeExcludeText,
    selectAllTags,
    clearTagCategory,
    loadFilterPresets,
    saveFilterPresets,
    savePreset,
    loadPreset,
    deletePreset,
    clearAllFilters,
    resetFiltersOnDatabaseChange,
    toggleFiltersPanel,
  };
}

export default useFilters;
