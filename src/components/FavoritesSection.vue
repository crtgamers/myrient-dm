<template>
  <div
    v-if="folders.length > 0"
    id="favorites-section"
    class="favorites-container"
  >
    <div class="section-header">
      <Star
        class="header-icon"
        :size="20"
      />
      <h2>{{ t('favoritesSection.title') }}</h2>
      <span class="count-badge">{{ folders.length }}</span>
    </div>

    <div class="folders-grid">
      <div
        v-for="folder in folders"
        :key="folder.id"
        class="folder-wrapper"
      >
        <button
          class="folder-btn glass-effect"
          :title="folder.title"
          :aria-label="t('favoritesSection.navigateToFavorite', { name: folder.title })"
          @click="$emit('navigate', folder)"
        >
          <div class="folder-icon-wrapper favorite">
            <FolderHeart :size="24" />
          </div>
          <div class="folder-info">
            <span class="folder-name">{{ folder.title }}</span>
          </div>
        </button>
        <button
          class="favorite-star-btn active"
          :title="t('favoritesSection.removeFromFavorites')"
          :aria-label="t('favoritesSection.removeFolderFromFavorites', { name: folder.title })"
          @click.stop="$emit('remove', folder)"
        >
          <Star
            :size="18"
            fill="currentColor"
          />
        </button>
      </div>
    </div>
  </div>

  <div
    v-else
    class="empty-state glass-effect"
  >
    <div class="empty-state-icon">
      <StarOff :size="64" />
    </div>
    <h3>{{ t('favoritesSection.noFavorites') }}</h3>
    <p>{{ t('favoritesSection.noFavoritesHint') }}</p>
  </div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { Star, FolderHeart, StarOff } from 'lucide-vue-next';

const { t } = useI18n();

export interface FavoriteFolderItem {
  id: number;
  title?: string;
  type?: string;
}

// Props
defineProps({
  folders: {
    type: Array as PropType<FavoriteFolderItem[]>,
    required: true,
  },
});

// Emits
defineEmits(['navigate', 'remove']);
</script>

<style scoped>
.favorites-container {
  animation: fadeIn 0.4s ease-out;
  flex: 1;
  overflow-x: hidden;
  overflow-y: auto;
  min-height: 0;
  padding-bottom: var(--spacing-md);
}

.header-icon {
  color: var(--warning-color);
}

.folder-icon-wrapper.favorite {
  background: var(--warning-color-alpha-10);
  color: var(--warning-color);
}

.folder-btn:hover .folder-icon-wrapper.favorite {
  background: var(--warning-color);
  color: white;
}
</style>
