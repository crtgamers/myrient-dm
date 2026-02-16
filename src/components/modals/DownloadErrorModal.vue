<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="error-modal-overlay glass-effect"
      @click.self="$emit('close')"
    />

    <Transition name="modal-scale">
      <div
        v-if="show && download"
        ref="panelRef"
        class="error-modal-panel glass-effect"
        role="dialog"
        aria-modal="true"
        aria-labelledby="error-modal-title"
        aria-describedby="error-modal-message"
      >
        <div class="error-modal-header">
          <div class="error-modal-icon">
            <AlertCircle :size="24" />
          </div>
          <h2
            id="error-modal-title"
            class="error-modal-title"
          >
            {{ t('modals.downloadError.title') }}
          </h2>
        </div>

        <div class="error-modal-body">
          <p
            v-if="download.title"
            class="error-modal-filename"
          >
            {{ download.title }}
          </p>
          <p
            id="error-modal-message"
            class="error-modal-message"
          >
            {{ errorMessage }}
          </p>
        </div>

        <div class="error-modal-actions">
          <button
            type="button"
            class="error-modal-btn error-modal-btn-close"
            @click="$emit('close')"
          >
            {{ t('common.close') }}
          </button>
          <button
            type="button"
            class="error-modal-btn error-modal-btn-retry"
            @click="$emit('retry', download.id)"
          >
            {{ t('downloadItem.retry') }}
          </button>
          <button
            type="button"
            class="error-modal-btn error-modal-btn-remove"
            @click="$emit('remove', download.id)"
          >
            {{ t('downloadItem.remove') }}
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, toRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertCircle } from 'lucide-vue-next';
import { useModalFocusTrap } from '../../composables/useModalFocusTrap';

const { t } = useI18n();

interface ErrorDownload {
  id: number;
  title?: string;
  error?: string;
  lastError?: string;
}

const props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  download: {
    type: Object as () => ErrorDownload | null,
    default: null,
  },
});

const emit = defineEmits(['close', 'retry', 'remove']);

const errorMessage = computed(() => {
  if (!props.download) return '';
  return props.download.error || props.download.lastError || 'Error desconocido';
});

const panelRef = ref<HTMLElement | null>(null);
useModalFocusTrap(panelRef, toRef(props, 'show'), () => emit('close'));
</script>

<style scoped>
.error-modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-bg);
  z-index: 9998;
}

.error-modal-panel {
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

.error-modal-header {
  padding: var(--spacing-lg) var(--spacing-lg) 0;
  display: flex;
  align-items: center;
  gap: 0.875rem;
}

.error-modal-icon {
  flex-shrink: 0;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--danger-color-alpha-22);
  color: var(--danger-color);
}

.error-modal-title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.error-modal-body {
  padding: 1.25rem var(--spacing-lg);
}

.error-modal-filename {
  margin: 0 0 0.5rem;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
}

.error-modal-message {
  margin: 0;
  font-size: var(--text-base);
  line-height: 1.55;
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-word;
}

.error-modal-actions {
  padding: var(--spacing-md) var(--spacing-lg) var(--spacing-lg);
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.error-modal-btn {
  padding: 0.625rem 1.25rem;
  border-radius: var(--radius-lg);
  font-size: var(--text-base);
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}

.error-modal-btn-close {
  background: var(--bg-secondary);
  color: var(--text-muted);
  border: 0.0625rem solid var(--border-color);
}

.error-modal-btn-close:hover {
  background: var(--bg-tertiary, rgba(255, 255, 255, 0.06));
  color: var(--text-primary);
}

.error-modal-btn-retry {
  background: var(--primary-color);
  color: #fff;
}

.error-modal-btn-retry:hover {
  filter: brightness(1.1);
  box-shadow: 0 0.125rem 0.5rem rgba(var(--info-color-rgb), 0.35);
}

.error-modal-btn-remove {
  background: rgba(239, 68, 68, 0.15);
  color: var(--danger-color);
  border: 0.0625rem solid var(--danger-color-alpha-35);
}

.error-modal-btn-remove:hover {
  background: var(--danger-color-alpha-22);
  color: var(--danger-color);
}
</style>
