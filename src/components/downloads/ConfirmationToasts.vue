<template>
  <div class="confirmation-notifications">
    <TransitionGroup name="toast-slide">
      <div
        v-for="confirmation in visibleConfirmations"
        :key="confirmation.id"
        class="confirmation-toast glass-effect"
      >
        <div class="toast-header">
          <AlertTriangle
            class="warn-icon"
            :size="18"
          />
          <span class="toast-label">{{ t('modals.overwrite.title') }}</span>
        </div>

        <div class="toast-body">
          <p class="filename">{{ confirmation.title }}</p>
          <p class="size-diff">{{ getSizeComparison(confirmation) }}</p>
        </div>

        <div class="toast-footer">
          <p class="question">{{ t('modals.overwrite.replaceExistingQuestion') }}</p>
          <div class="action-btns">
            <button
              class="confirm-btn"
              @click="$emit('confirm', confirmation.id)"
            >
              {{ t('modals.overwrite.yesReplace') }}
            </button>
            <button
              class="cancel-btn"
              @click="$emit('cancel', confirmation.id)"
            >
              {{ t('modals.overwrite.skip') }}
            </button>
          </div>
        </div>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle } from 'lucide-vue-next';

const { t } = useI18n();

export interface OverwriteConfirmationItem {
  id: number;
  title?: string;
  showNotification?: boolean;
  existingSize?: number;
  expectedSize?: number;
}

// Props
const props = defineProps({
  confirmations: {
    type: Array as PropType<OverwriteConfirmationItem[]>,
    required: true,
  },
});

// Emits
defineEmits(['confirm', 'cancel']);

// Computed
const visibleConfirmations = computed(() => {
  return (props.confirmations as OverwriteConfirmationItem[]).filter(
    (c: OverwriteConfirmationItem) => c.showNotification
  );
});

// Métodos
const getSizeComparison = (confirmation: OverwriteConfirmationItem) => {
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
  const sizeStr = formatSize(existing);
  const diff = existing - expected;
  if (Math.abs(diff) < 1024) return t('modals.overwrite.sizesSimilar', { size: sizeStr });
  return diff > 0
    ? t('modals.overwrite.existingLarger', { size: sizeStr })
    : t('modals.overwrite.existingSmaller', { size: sizeStr });
};
</script>
