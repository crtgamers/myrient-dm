<template>
  <div
    v-if="folders.length > 0"
    id="folders-section"
    class="folders-container"
  >
    <div class="folders-section-header">
      <div class="section-header">
        <h2 v-if="title">
          {{ title }}
        </h2>
        <span class="count-badge">{{ folders.length }}</span>
        <div class="section-header-actions">
          <button
            type="button"
            class="view-toggle-btn glass-effect"
            :title="
              folderViewMode === 'grid' ? t('folderGrid.viewAsList') : t('folderGrid.viewAsGrid')
            "
            :aria-label="
              folderViewMode === 'grid' ? t('folderGrid.viewAsList') : t('folderGrid.viewAsGrid')
            "
            @click="folderViewMode = folderViewMode === 'grid' ? 'list' : 'grid'"
          >
            <List
              v-if="folderViewMode === 'grid'"
              :size="20"
              aria-hidden="true"
            />
            <LayoutGrid
              v-else
              :size="20"
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    </div>
    <div class="folders-grid-scroll">
      <div
        class="folders-grid"
        :class="{ 'folders-list-view': folderViewMode === 'list' }"
      >
        <div
          v-for="folder in folders"
          :key="folder.id"
          class="folder-wrapper"
        >
          <button
            class="folder-btn glass-effect"
            :class="{ 'search-folder-result': isSearchResult }"
            :title="folder.displayTitle || folder.title"
            :aria-label="
              t('folderGrid.navigateToFolder', { name: folder.displayTitle || folder.title || '' })
            "
            @click="$emit('navigate', folder)"
          >
            <div class="folder-icon-wrapper">
              <Folder
                :size="24"
                class="folder-icon"
              />
            </div>
            <div class="folder-info">
              <span
                v-if="folder.breadcrumbPath && isSearchResult"
                class="folder-breadcrumb"
              >
                {{ folder.breadcrumbPath }}
              </span>
              <span class="folder-name">{{ folder.title }}</span>
            </div>
          </button>
          <button
            type="button"
            class="favorite-star-btn"
            :class="{
              active: isFavorite(folder.id),
              visible: showFavoriteAlways || isFavorite(folder.id),
            }"
            :title="
              isFavorite(folder.id)
                ? t('folderGrid.removeFromFavorites')
                : t('folderGrid.addToFavorites')
            "
            :aria-label="
              isFavorite(folder.id)
                ? t('favoritesSection.removeFolderFromFavorites', { name: folder.title || '' })
                : t('folderGrid.addToFavorites')
            "
            @click.stop="$emit('toggle-favorite', folder)"
          >
            <Star
              :size="18"
              :fill="isFavorite(folder.id) ? 'currentColor' : 'none'"
            />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { ref } from 'vue';
import { Folder, Star, List, LayoutGrid } from 'lucide-vue-next';

const { t } = useI18n();

const folderViewMode = ref<'grid' | 'list'>('grid');

export interface FolderGridItem {
  id: number;
  title?: string;
  displayTitle?: string;
  breadcrumbPath?: string;
}

// Props
const props = defineProps({
  folders: {
    type: Array as PropType<FolderGridItem[]>,
    required: true,
  },
  title: {
    type: String,
    default: '',
  },
  favoriteIds: {
    type: [Set, Array] as PropType<Set<number> | number[]>,
    default: () => new Set(),
  },
  isSearchResult: {
    type: Boolean,
    default: false,
  },
  showFavoriteAlways: {
    type: Boolean,
    default: false,
  },
});

// Emits
defineEmits(['navigate', 'toggle-favorite']);

// Métodos (acepta Set o number[] para reactividad con arrays)
const isFavorite = (folderId: number) => {
  const ids = props.favoriteIds;
  if (ids instanceof Set) return ids.has(folderId);
  return Array.isArray(ids) && ids.includes(folderId);
};
</script>
