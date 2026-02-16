<template>
  <div
    class="home-screen view-content fill-height"
    role="region"
    :aria-label="t('home.selectSource')"
  >
    <h2 class="home-screen__title">{{ t('home.selectSource') }}</h2>
    <div class="home-screen__grid">
      <button
        type="button"
        class="home-source-card"
        :disabled="loadingSource === 'myrient'"
        :aria-busy="loadingSource === 'myrient'"
        :aria-label="t('home.myrient')"
        @click="$emit('select-source', 'myrient')"
      >
        <div
          class="home-source-card__icon"
          aria-hidden="true"
        >
          <Folder :size="48" />
        </div>
        <span class="home-source-card__label">{{ t('home.myrient') }}</span>
        <span
          v-if="loadingSource === 'myrient'"
          class="home-source-card__loading"
        >
          <Loader2
            class="home-source-card__spinner"
            :size="20"
            aria-hidden="true"
          />
        </span>
      </button>
      <button
        type="button"
        class="home-source-card"
        :disabled="loadingSource === 'lolroms'"
        :aria-busy="loadingSource === 'lolroms'"
        :aria-label="t('home.lolroms')"
        @click="$emit('select-source', 'lolroms')"
      >
        <div
          class="home-source-card__icon"
          aria-hidden="true"
        >
          <Folder :size="48" />
        </div>
        <span class="home-source-card__label">{{ t('home.lolroms') }}</span>
        <span
          v-if="loadingSource === 'lolroms'"
          class="home-source-card__loading"
        >
          <Loader2
            class="home-source-card__spinner"
            :size="20"
            aria-hidden="true"
          />
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * HomeScreen - Pantalla de inicio con dos carpetas: Myrient y LoLROMs.
 * El usuario selecciona una fuente para cargar su base de datos.
 */
import { useI18n } from 'vue-i18n';
import { Folder, Loader2 } from 'lucide-vue-next';

defineProps<{
  loadingSource?: 'myrient' | 'lolroms' | null;
}>();

defineEmits<{
  (_e: 'select-source', _source: 'myrient' | 'lolroms'): void;
}>();

const { t } = useI18n();
</script>

<style scoped>
.home-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2rem;
  gap: 2rem;
}

.home-screen__title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text-secondary, #9ca3af);
}

.home-screen__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1.5rem;
  max-width: 500px;
  width: 100%;
}

.home-source-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 2rem 1.5rem;
  background: var(--bg-secondary, rgba(31, 41, 55, 0.5));
  border: 1px solid var(--border-color, rgba(75, 85, 99, 0.3));
  border-radius: 0.75rem;
  cursor: pointer;
  transition:
    border-color 0.2s,
    background 0.2s,
    transform 0.15s;
  color: var(--text-primary, #f9fafb);
  font-size: 1rem;
  font-weight: 500;
  position: relative;
}

.home-source-card:hover:not(:disabled) {
  border-color: var(--primary-color, #10b981);
  background: var(--primary-alpha, rgba(16, 185, 129, 0.1));
  transform: translateY(-2px);
}

.home-source-card:focus-visible {
  outline: 2px solid var(--primary-color, #10b981);
  outline-offset: 2px;
}

.home-source-card:disabled {
  cursor: not-allowed;
  opacity: 0.8;
}

.home-source-card__icon {
  color: var(--primary-color, #10b981);
}

.home-source-card__label {
  text-align: center;
}

.home-source-card__loading {
  position: absolute;
  bottom: 0.5rem;
  right: 0.5rem;
}

.home-source-card__spinner {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
