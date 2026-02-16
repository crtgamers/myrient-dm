<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="confirm-dialog-overlay glass-effect"
      @click.self="$emit('cancel')"
    />

    <Transition name="modal-scale">
      <div
        v-if="show"
        ref="confirmDialogPanel"
        class="confirm-dialog-panel glass-effect"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="messageId"
      >
        <div class="confirm-dialog-header">
          <div
            v-if="variant === 'warning'"
            class="confirm-dialog-icon confirm-dialog-icon-warning"
          >
            <AlertTriangle :size="24" />
          </div>
          <div
            v-else-if="variant === 'info'"
            class="confirm-dialog-icon confirm-dialog-icon-info"
          >
            <Info :size="24" />
          </div>
          <h2
            :id="titleId"
            class="confirm-dialog-title"
          >
            {{ displayTitle }}
          </h2>
        </div>

        <div class="confirm-dialog-body">
          <p
            :id="messageId"
            class="confirm-dialog-message"
          >
            {{ displayMessage }}
          </p>
        </div>

        <div class="confirm-dialog-actions">
          <button
            type="button"
            class="confirm-dialog-btn confirm-dialog-btn-cancel"
            @click="$emit('cancel')"
          >
            {{ displayCancelLabel }}
          </button>
          <button
            type="button"
            class="confirm-dialog-btn confirm-dialog-btn-confirm"
            @click="$emit('confirm')"
          >
            {{ displayConfirmLabel }}
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, toRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle, Info } from 'lucide-vue-next';
import { useModalFocusTrap } from '../../composables/useModalFocusTrap';

const { t } = useI18n();

const props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  title: {
    type: String,
    default: '',
  },
  message: {
    type: String,
    default: '',
  },
  confirmLabel: {
    type: String,
    default: '',
  },
  cancelLabel: {
    type: String,
    default: '',
  },
  variant: {
    type: String,
    default: 'warning',
    validator: (v: string) => ['warning', 'info'].includes(v),
  },
});

const emit = defineEmits(['confirm', 'cancel']);

const displayTitle = computed(() => props.title || t('modals.confirmDialog.defaultTitle'));
const displayMessage = computed(() => props.message || t('modals.confirmDialog.defaultMessage'));
const displayConfirmLabel = computed(
  () => props.confirmLabel || t('modals.confirmDialog.defaultConfirm')
);
const displayCancelLabel = computed(
  () => props.cancelLabel || t('modals.confirmDialog.defaultCancel')
);

const titleId = computed(() => 'confirm-dialog-title-' + Math.random().toString(36).slice(2, 9));
const messageId = computed(
  () => 'confirm-dialog-message-' + Math.random().toString(36).slice(2, 9)
);

const confirmDialogPanel = ref<HTMLElement | null>(null);
useModalFocusTrap(confirmDialogPanel, toRef(props, 'show'), () => emit('cancel'));
</script>

<style scoped>
.confirm-dialog-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-bg);
  z-index: 9998;
}

.confirm-dialog-panel {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 90vw;
  max-width: 27.5rem;
  z-index: 9999;
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-2xl);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.confirm-dialog-header {
  padding: var(--spacing-lg) var(--spacing-lg) 0;
  display: flex;
  align-items: center;
  gap: 0.875rem;
}

.confirm-dialog-icon {
  flex-shrink: 0;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.confirm-dialog-icon-warning {
  background: var(--warning-color-alpha-22);
  color: var(--warning-color);
}

.confirm-dialog-icon-info {
  background: var(--info-color-alpha-25);
  color: var(--primary-color);
}

.confirm-dialog-title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.confirm-dialog-body {
  padding: 1.25rem var(--spacing-lg);
}

.confirm-dialog-message {
  margin: 0;
  font-size: var(--text-base);
  line-height: 1.55;
  color: var(--text-muted);
  white-space: pre-line;
}

.confirm-dialog-actions {
  padding: var(--spacing-md) var(--spacing-lg) var(--spacing-lg);
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

.confirm-dialog-btn {
  padding: 0.625rem 1.25rem;
  border-radius: var(--radius-lg);
  font-size: var(--text-base);
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}

.confirm-dialog-btn-cancel {
  background: var(--bg-secondary);
  color: var(--text-muted);
  border: 0.0625rem solid var(--border-color);
}

.confirm-dialog-btn-cancel:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.confirm-dialog-btn-confirm {
  background: var(--primary-color);
  color: #fff;
}

.confirm-dialog-btn-confirm:hover {
  filter: brightness(1.1);
  box-shadow: 0 0.125rem 0.5rem rgba(var(--info-color-rgb), 0.35);
}
</style>
