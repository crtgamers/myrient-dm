<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="confirm-dialog-overlay glass-effect"
      @click.self="handleCancel"
    />

    <Transition name="modal-scale">
      <div
        v-if="show && currentConfirmation"
        ref="overwriteDialogPanel"
        class="confirm-dialog-panel glass-effect overwrite-dialog-panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="bodyId"
      >
        <div class="confirm-dialog-header">
          <div class="confirm-dialog-icon confirm-dialog-icon-warning">
            <AlertTriangle :size="24" />
          </div>
          <h2
            :id="titleId"
            class="confirm-dialog-title"
          >
            {{ t('modals.overwrite.title') }}
          </h2>
        </div>

        <div
          :id="bodyId"
          class="confirm-dialog-body"
        >
          <p class="confirm-dialog-message confirm-dialog-filename">
            {{ currentConfirmation.title }}
          </p>
          <p class="confirm-dialog-message confirm-dialog-size">
            {{ getSizeComparison(currentConfirmation) }}
          </p>
          <p
            v-if="hasMultiple"
            class="confirm-dialog-extra"
          >
            {{ t('modals.overwrite.moreInQueue', { count: pendingCount - 1 }) }}
          </p>
        </div>

        <div class="confirm-dialog-actions overwrite-dialog-actions">
          <template v-if="hasMultiple">
            <button
              type="button"
              class="confirm-dialog-btn confirm-dialog-btn-cancel"
              @click="emit('cancelAll')"
            >
              {{ t('modals.overwrite.noToAll') }}
            </button>
            <button
              type="button"
              class="confirm-dialog-btn confirm-dialog-btn-skip"
              @click="handleCancel"
            >
              {{ t('modals.overwrite.skipThis') }}
            </button>
            <button
              type="button"
              class="confirm-dialog-btn confirm-dialog-btn-confirm"
              @click="handleConfirm"
            >
              {{ t('modals.overwrite.yesReplaceThis') }}
            </button>
            <button
              type="button"
              class="confirm-dialog-btn confirm-dialog-btn-confirm-all"
              @click="emit('confirmAll')"
            >
              {{ t('modals.overwrite.yesToAll') }}
            </button>
          </template>
          <template v-else>
            <button
              type="button"
              class="confirm-dialog-btn confirm-dialog-btn-cancel"
              @click="handleCancel"
            >
              {{ t('modals.overwrite.skip') }}
            </button>
            <button
              type="button"
              class="confirm-dialog-btn confirm-dialog-btn-confirm"
              @click="handleConfirm"
            >
              {{ t('modals.overwrite.yesReplace') }}
            </button>
          </template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle } from 'lucide-vue-next';
import { useModalFocusTrap } from '../../composables/useModalFocusTrap';

const { t } = useI18n();

export interface OverwriteConfirmationItem {
  id: number;
  title?: string;
  showNotification?: boolean;
  existingSize?: number;
  expectedSize?: number;
}

const props = defineProps({
  confirmations: {
    type: Array as PropType<OverwriteConfirmationItem[]>,
    default: () => [],
  },
});

const emit = defineEmits(['confirm', 'cancel', 'confirmAll', 'cancelAll']);

const visibleConfirmations = computed(() =>
  props.confirmations.filter(c => c.showNotification !== false)
);

const show = computed(() => visibleConfirmations.value.length > 0);

const currentConfirmation = computed(() => visibleConfirmations.value[0] ?? null);

const pendingCount = computed(() => visibleConfirmations.value.length);

const hasMultiple = computed(() => pendingCount.value > 1);

const titleId = computed(() => 'overwrite-dialog-title-' + Math.random().toString(36).slice(2, 9));
const bodyId = computed(() => 'overwrite-dialog-body-' + Math.random().toString(36).slice(2, 9));

function getSizeComparison(confirmation: OverwriteConfirmationItem) {
  const { existingSize, expectedSize } = confirmation;
  if (existingSize == null && expectedSize == null) return t('modals.overwrite.sizeUnknown');

  const formatSize = (bytes: number | null | undefined) => {
    if (bytes == null || bytes < 0) return '?';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const existing = existingSize ?? 0;
  const expected = expectedSize ?? 0;
  if (existing === 0 && expected === 0) return t('modals.overwrite.sizesUnavailable');

  const diff = existing - expected;
  const sizeStr = formatSize(existing);
  if (Math.abs(diff) < 1024) return t('modals.overwrite.sizesSimilar', { size: sizeStr });
  return diff > 0
    ? t('modals.overwrite.existingLarger', { size: sizeStr })
    : t('modals.overwrite.existingSmaller', { size: sizeStr });
}

function handleConfirm() {
  if (currentConfirmation.value) emit('confirm', currentConfirmation.value.id);
}

function handleCancel() {
  if (currentConfirmation.value) emit('cancel', currentConfirmation.value.id);
}

const overwriteDialogPanel = ref<HTMLElement | null>(null);
useModalFocusTrap(overwriteDialogPanel, show, () => handleCancel());
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

.overwrite-dialog-panel {
  max-width: 30rem;
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

.confirm-dialog-filename {
  font-weight: 600;
  color: var(--text-primary);
  word-break: break-all;
}

.confirm-dialog-size {
  margin-top: 0.375rem;
  font-size: 0.8125rem;
}

.confirm-dialog-extra {
  margin: 0.875rem 0 0;
  font-size: 0.8125rem;
  color: var(--text-muted);
}

.confirm-dialog-actions {
  padding: var(--spacing-md) var(--spacing-lg) var(--spacing-lg);
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

.overwrite-dialog-actions {
  flex-wrap: wrap;
}

.confirm-dialog-btn {
  padding: 0.625rem 1.125rem;
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
  background: var(--bg-tertiary, rgba(255, 255, 255, 0.06));
  color: var(--text-primary);
}

.confirm-dialog-btn-skip {
  background: var(--bg-secondary);
  color: var(--text-muted);
  border: 0.0625rem solid var(--border-color);
}

.confirm-dialog-btn-skip:hover {
  background: var(--bg-tertiary, rgba(255, 255, 255, 0.06));
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

.confirm-dialog-btn-confirm-all {
  background: var(--success-color);
  color: #fff;
}

.confirm-dialog-btn-confirm-all:hover {
  filter: brightness(1.1);
  box-shadow: 0 0.125rem 0.5rem var(--primary-color-alpha);
}
</style>
