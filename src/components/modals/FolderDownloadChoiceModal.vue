<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="choice-dialog-overlay glass-effect"
      @click.self="$emit('cancel')"
    />

    <Transition name="modal-scale">
      <div
        v-if="show"
        ref="choiceDialogPanel"
        class="choice-dialog-panel glass-effect"
        role="dialog"
        aria-modal="true"
        aria-labelledby="choice-dialog-title"
        aria-describedby="choice-dialog-message"
      >
        <div class="choice-dialog-header">
          <div class="choice-dialog-icon">
            <Download :size="24" />
          </div>
          <h2
            id="choice-dialog-title"
            class="choice-dialog-title"
          >
            {{ t('modals.folderChoice.title') }}
          </h2>
        </div>

        <div class="choice-dialog-body">
          <p
            id="choice-dialog-message"
            class="choice-dialog-message"
          >
            {{ t('modals.folderChoice.message') }}
          </p>
          <div class="choice-dialog-actions">
            <button
              type="button"
              class="choice-dialog-btn choice-dialog-btn-primary"
              :aria-label="t('modals.folderChoice.downloadFilteredAria')"
              @click="$emit('download-filtered')"
            >
              <Filter
                :size="18"
                aria-hidden="true"
              />
              {{ t('modals.folderChoice.onlyVisible', { count: filteredCount }) }}
            </button>
            <button
              type="button"
              class="choice-dialog-btn choice-dialog-btn-secondary"
              :aria-label="t('modals.folderChoice.downloadAllAria')"
              @click="$emit('download-all')"
            >
              <FolderDown
                :size="18"
                aria-hidden="true"
              />
              {{ t('modals.folderChoice.entireFolder', { count: totalCount }) }}
            </button>
          </div>
        </div>

        <div class="choice-dialog-footer">
          <button
            type="button"
            class="choice-dialog-btn choice-dialog-btn-cancel"
            @click="$emit('cancel')"
          >
            {{ t('modals.folderChoice.cancel') }}
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, toRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { Download, Filter, FolderDown } from 'lucide-vue-next';
import { useModalFocusTrap } from '../../composables/useModalFocusTrap';

const { t } = useI18n();

const props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  filteredCount: {
    type: Number,
    default: 0,
  },
  totalCount: {
    type: Number,
    default: 0,
  },
});

const emit = defineEmits(['download-filtered', 'download-all', 'cancel']);

const choiceDialogPanel = ref<HTMLElement | null>(null);
useModalFocusTrap(choiceDialogPanel, toRef(props, 'show'), () => emit('cancel'));
</script>

<style scoped>
.choice-dialog-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-bg);
  z-index: 9998;
}

.choice-dialog-panel {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 90vw;
  max-width: 28rem;
  z-index: 9999;
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-2xl);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.choice-dialog-header {
  padding: var(--spacing-lg) var(--spacing-lg) 0;
  display: flex;
  align-items: center;
  gap: 0.875rem;
}

.choice-dialog-icon {
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 50%;
  background: var(--info-color-alpha-25);
  color: var(--primary-color);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.choice-dialog-title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.choice-dialog-body {
  padding: 1.25rem var(--spacing-lg);
}

.choice-dialog-message {
  margin: 0 0 1rem;
  font-size: var(--text-base);
  line-height: 1.55;
  color: var(--text-muted);
}

.choice-dialog-actions {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.choice-dialog-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem;
  border-radius: var(--radius-lg);
  font-size: var(--text-base);
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}

.choice-dialog-btn-primary {
  background: var(--primary-color);
  color: white;
}

.choice-dialog-btn-primary:hover {
  filter: brightness(1.1);
  box-shadow: 0 0.125rem 0.5rem rgba(var(--info-color-rgb), 0.35);
}

.choice-dialog-btn-secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 0.0625rem solid var(--border-color);
}

.choice-dialog-btn-secondary:hover {
  background: var(--bg-tertiary);
}

.choice-dialog-footer {
  padding: var(--spacing-md) var(--spacing-lg) var(--spacing-lg);
  display: flex;
  justify-content: flex-end;
}

.choice-dialog-btn-cancel {
  background: transparent;
  color: var(--text-muted);
  border: none;
}

.choice-dialog-btn-cancel:hover {
  color: var(--text-primary);
}
</style>
