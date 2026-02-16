<template>
  <div class="toast-notifications">
    <TransitionGroup name="toast-slide">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="toast glass-effect"
        :class="[`toast-${toast.type}`]"
        :role="toast.type === 'error' ? 'alert' : 'status'"
        :aria-live="toast.type === 'error' ? 'assertive' : 'polite'"
        @click="removeToast(toast.id)"
      >
        <div class="toast-icon-box">
          <component
            :is="getIcon(toast.type ?? 'info')"
            :size="18"
          />
        </div>
        <div class="toast-content">
          <div class="toast-title">
            {{ toast.title }}
          </div>
          <div
            v-if="toast.message"
            class="toast-message"
          >
            {{ toast.message }}
          </div>
        </div>
        <button
          type="button"
          class="toast-close-btn"
          :aria-label="t('toast.closeNotification')"
          @click.stop="removeToast(toast.id)"
        >
          <X :size="14" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { Info, CheckCircle2, AlertTriangle, AlertOctagon, X } from 'lucide-vue-next';

const { t } = useI18n();

export interface ToastItem {
  id: string | number;
  type?: string;
  title?: string;
  message?: string;
  duration?: number;
}

// Props
defineProps({
  toasts: {
    type: Array as PropType<ToastItem[]>,
    default: () => [],
  },
});

// Emits
const emit = defineEmits(['remove']);

// Métodos
const removeToast = (id: string | number) => {
  emit('remove', id);
};

const getIcon = (type: string) => {
  switch (type) {
    case 'success':
      return CheckCircle2;
    case 'warning':
      return AlertTriangle;
    case 'error':
      return AlertOctagon;
    default:
      return Info;
  }
};
</script>

<style scoped>
.toast-notifications {
  position: fixed;
  bottom: 1.25rem;
  right: 1.25rem;
  z-index: 10001;
  display: flex;
  flex-direction: column-reverse;
  gap: 0.625rem;
  max-width: 25rem;
  pointer-events: none;
}

.toast {
  background: var(--bg-main);
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  box-shadow: var(--shadow-2xl);
  pointer-events: auto;
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  border-left: 0.25rem solid var(--success-color);
  min-width: 18.75rem;
  transition: all 0.3s ease;
}

.toast:hover {
  transform: translateX(-0.25rem);
  box-shadow: var(--shadow-2xl);
}

.toast-info {
  border-left-color: var(--info-color);
}

.toast-success {
  border-left-color: var(--success-color);
}

.toast-warning {
  border-left-color: var(--warning-color);
}

.toast-error {
  border-left-color: var(--danger-color);
}

.toast-icon {
  font-size: 1.25rem;
  flex-shrink: 0;
  margin-top: 0.125rem;
}

.toast-content {
  flex: 1;
  min-width: 0;
}

.toast-title {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 0.875rem;
  margin-bottom: 0.25rem;
}

.toast-message {
  color: var(--text-secondary);
  font-size: 0.75rem;
  line-height: 1.4;
}

.toast-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 1.25rem;
  cursor: pointer;
  padding: 0;
  width: 1.25rem;
  height: 1.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: color 0.2s;
  margin-top: -0.125rem;
}

.toast-close:hover {
  color: var(--text-primary);
}

/* Animaciones */
.toast-slide-enter-active {
  transition: all 0.3s ease-out;
}

.toast-slide-leave-active {
  transition: all 0.2s ease-in;
}

.toast-slide-enter-from {
  transform: translateX(25rem);
  opacity: 0;
}

.toast-slide-leave-to {
  transform: translateX(25rem);
  opacity: 0;
}
</style>
