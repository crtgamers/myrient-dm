<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="batch-confirm-overlay glass-effect"
      @click.self="$emit('cancel')"
    />

    <Transition name="modal-scale">
      <div
        v-if="show"
        ref="batchConfirmPanel"
        class="batch-confirm-panel glass-effect"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-confirm-title"
        aria-describedby="batch-confirm-description"
      >
        <div class="batch-confirm-header">
          <div class="batch-confirm-icon">
            <Download :size="24" />
          </div>
          <h2
            id="batch-confirm-title"
            class="batch-confirm-title"
          >
            {{ t('modals.batchAdded.title') }}
          </h2>
        </div>

        <div
          id="batch-confirm-description"
          class="batch-confirm-body"
        >
          <p class="batch-confirm-message">
            {{ messageText }}
          </p>
          <p class="batch-confirm-question">{{ t('modals.batchAdded.startDownloadNow') }}</p>
        </div>

        <div class="batch-confirm-actions">
          <button
            type="button"
            class="batch-confirm-btn batch-confirm-btn-cancel"
            @click="$emit('cancel')"
          >
            {{ t('modals.batchAdded.cancel') }}
          </button>
          <button
            type="button"
            class="batch-confirm-btn batch-confirm-btn-secondary"
            @click="$emit('review-queue')"
          >
            {{ t('modals.batchAdded.reviewQueue') }}
          </button>
          <button
            type="button"
            class="batch-confirm-btn batch-confirm-btn-primary"
            @click="$emit('start-download')"
          >
            {{ t('modals.batchAdded.startDownload') }}
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, toRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { Download } from 'lucide-vue-next';
import { useModalFocusTrap } from '../../composables/useModalFocusTrap';

const { t } = useI18n();

const props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  /** Número de archivos agregados */
  addedCount: {
    type: Number,
    default: 0,
  },
  /** Nombre de la carpeta (solo último segmento) cuando es una sola carpeta */
  folderLabel: {
    type: String,
    default: null,
  },
  /** Número de carpetas/orígenes distintos cuando son varios (0 o 1 = mensaje de una carpeta si folderLabel existe) */
  folderCount: {
    type: Number,
    default: 0,
  },
});

const emit = defineEmits(['start-download', 'review-queue', 'cancel']);

const messageText = computed(() => {
  const n = props.addedCount;
  if (n <= 0) return t('modals.batchAdded.noFilesAdded');

  const multipleFolders = props.folderCount > 1;
  if (multipleFolders) {
    return t('modals.batchAdded.addedFromFolders', {
      count: n,
      folderCount: props.folderCount,
    });
  }

  const folderName =
    props.folderLabel && props.folderLabel.trim() ? props.folderLabel.trim() : null;
  if (folderName) {
    return t('modals.batchAdded.addedFromFolder', { count: n, folderName });
  }

  return t('modals.batchAdded.addedToQueue', { count: n });
});

const batchConfirmPanel = ref<HTMLElement | null>(null);
useModalFocusTrap(batchConfirmPanel, toRef(props, 'show'), () => emit('cancel'));
</script>

<style scoped>
.batch-confirm-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-bg);
  z-index: 9998;
}

.batch-confirm-panel {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 90vw;
  max-width: 28.75rem;
  z-index: 9999;
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-2xl);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.batch-confirm-header {
  padding: var(--spacing-lg) var(--spacing-lg) 0;
  display: flex;
  align-items: center;
  gap: 0.875rem;
}

.batch-confirm-icon {
  flex-shrink: 0;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--primary-color-alpha-12);
  color: var(--primary-color);
}

.batch-confirm-title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.batch-confirm-body {
  padding: 1.25rem var(--spacing-lg);
}

.batch-confirm-message {
  margin: 0;
  font-size: var(--text-base);
  line-height: 1.55;
  color: var(--text-muted);
}

.batch-confirm-question {
  margin: 0.75rem 0 0;
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--text-primary);
}

.batch-confirm-actions {
  padding: var(--spacing-md) var(--spacing-lg) var(--spacing-lg);
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 0.625rem;
}

.batch-confirm-btn {
  padding: 0.625rem 1.125rem;
  border-radius: var(--radius-lg);
  font-size: var(--text-base);
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}

.batch-confirm-btn-cancel {
  background: transparent;
  color: var(--text-muted);
  border: 0.0625rem solid var(--border-color);
}

.batch-confirm-btn-cancel:hover {
  background: var(--bg-tertiary, rgba(255, 255, 255, 0.06));
  color: var(--text-primary);
}

.batch-confirm-btn-secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 0.0625rem solid var(--border-color);
}

.batch-confirm-btn-secondary:hover {
  background: var(--bg-tertiary, rgba(255, 255, 255, 0.08));
}

.batch-confirm-btn-primary {
  background: var(--primary-color);
  color: #fff;
}

.batch-confirm-btn-primary:hover {
  filter: brightness(1.1);
  box-shadow: 0 0.125rem 0.5rem var(--primary-color-alpha);
}
</style>
