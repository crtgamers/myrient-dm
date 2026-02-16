<template>
  <button
    :class="[`btn-${type}`, { disabled: disabled }, 'download-action-btn']"
    :title="computedTitle"
    :aria-label="computedAriaLabel"
    :disabled="disabled"
    @click.stop="$emit('click')"
  >
    <span class="btn-icon">{{ icon }}</span>
    <span
      v-if="label"
      class="btn-label"
    >
      {{ label }}
    </span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps({
  type: {
    type: String,
    required: true,
    validator: (value: string) =>
      ['pause', 'resume', 'cancel', 'delete', 'retry', 'confirm', 'folder'].includes(value),
  },
  label: {
    type: String,
    default: '',
  },
  title: {
    type: String,
    default: '',
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  itemName: {
    type: String,
    default: '',
  },
});

defineEmits(['click']);

const icon = computed(() => {
  switch (props.type) {
    case 'pause':
      return '⏸';
    case 'resume':
      return '▶';
    case 'cancel':
      return '⏹';
    case 'delete':
      return '🗑️';
    case 'retry':
      return '🔄';
    case 'confirm':
      return '✓';
    case 'folder':
      return '📂';
    default:
      return '';
  }
});

const defaultTitle = computed(() => {
  switch (props.type) {
    case 'pause':
      return 'Pausar';
    case 'resume':
      return 'Reanudar';
    case 'cancel':
      return 'Detener';
    case 'delete':
      return 'Eliminar';
    case 'retry':
      return 'Reintentar';
    case 'confirm':
      return 'Confirmar';
    case 'folder':
      return 'Abrir carpeta';
    default:
      return '';
  }
});

const computedTitle = computed(() => {
  return props.title || `${defaultTitle.value} ${props.itemName ? props.itemName : ''}`;
});

const computedAriaLabel = computed(() => {
  return `${defaultTitle.value} ${props.itemName ? props.itemName : ''}`;
});
</script>

<style scoped>
.download-action-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  font-size: 1.1rem;
  border-radius: 0.25rem;
  transition:
    background-color 0.2s,
    transform 0.1s;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-color);
  opacity: 0.8;
}

.download-action-btn:hover:not(:disabled) {
  background-color: var(--surface-overlay-10);
  transform: scale(1.1);
  opacity: 1;
}

.download-action-btn:active:not(:disabled) {
  transform: scale(0.95);
}

.download-action-btn.disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* Colores por tipo (tokens) */
.btn-pause {
  color: var(--warning-color);
}
.btn-resume {
  color: var(--primary-color);
}
.btn-cancel {
  color: var(--danger-color);
}
.btn-delete {
  color: var(--text-secondary);
}
.btn-retry {
  color: var(--info-color);
}
.btn-confirm {
  color: var(--primary-color);
}
.btn-folder {
  color: var(--warning-color);
}

.btn-icon {
  line-height: 1;
}

.btn-label {
  margin-left: 0.375rem;
  font-size: 0.9rem;
}
</style>
