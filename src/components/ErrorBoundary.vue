<template>
  <div class="error-boundary-wrapper">
    <div
      v-if="hasError"
      class="error-boundary"
    >
      <div class="error-boundary-content">
        <div class="error-icon">⚠️</div>
        <h2 class="error-title">{{ t('errorBoundary.title') }}</h2>
        <p class="error-message">
          {{ errorMessage }}
        </p>

        <!-- Mostrar detalles del error en desarrollo -->
        <details
          v-if="isDev && errorDetails"
          class="error-details"
        >
          <summary>{{ t('errorBoundary.technicalDetails') }}</summary>
          <pre class="error-stack">{{ errorDetails }}</pre>
        </details>

        <div class="error-actions">
          <button
            class="error-button error-button-primary"
            :aria-label="t('errorBoundary.retryAfterError')"
            @click="handleRetry"
          >
            {{ t('errorBoundary.retry') }}
          </button>
          <button
            class="error-button error-button-secondary"
            :aria-label="t('errorBoundary.reloadPage')"
            @click="handleReload"
          >
            {{ t('errorBoundary.reload') }}
          </button>
          <button
            v-if="allowDismiss"
            class="error-button error-button-secondary"
            :aria-label="t('errorBoundary.continueAnyway')"
            @click="handleDismiss"
          >
            {{ t('errorBoundary.continueAnywayButton') }}
          </button>
        </div>
      </div>
    </div>
    <template v-else>
      <slot></slot>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onErrorCaptured, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import logger from '../utils/logger';

const { t } = useI18n();

const props = defineProps({
  /**
   * Mensaje de error personalizado para mostrar al usuario
   */
  fallbackMessage: {
    type: String,
    default: 'Ha ocurrido un error inesperado. Por favor, intenta nuevamente.',
  },
  /**
   * Si es true, permite cerrar el error y continuar (peligroso)
   */
  allowDismiss: {
    type: Boolean,
    default: false,
  },
  /**
   * Función de recuperación personalizada. Si retorna true, el error se considera recuperado
   */
  onError: {
    type: Function,
    default: null,
  },
  /**
   * Nombre del componente para logging
   */
  componentName: {
    type: String,
    default: 'Unknown',
  },
});

const emit = defineEmits(['error', 'retry', 'recovered']);

const hasError = ref(false);
const error = ref<Error | null>(null);
const errorInfo = ref<string | null>(null);
const retryCount = ref(0);
const maxRetries = 3;

const isDev = computed(() => import.meta.env.DEV);

const errorMessage = computed(() => {
  if (props.fallbackMessage) {
    return props.fallbackMessage;
  }

  if (error.value) {
    // Mensajes amigables basados en el tipo de error
    if (error.value.message) {
      const msg = error.value.message.toLowerCase();

      if (msg.includes('network') || msg.includes('fetch') || msg.includes('http')) {
        return 'Error de conexión. Verifica tu conexión a internet e intenta nuevamente.';
      }

      if (msg.includes('timeout')) {
        return 'La operación tardó demasiado. Por favor, intenta nuevamente.';
      }

      if (msg.includes('permission') || msg.includes('access')) {
        return 'No tienes permisos para realizar esta acción.';
      }

      if (msg.includes('quota') || msg.includes('storage')) {
        return 'No hay suficiente espacio de almacenamiento disponible.';
      }
    }

    return error.value.message || 'Ha ocurrido un error inesperado.';
  }

  return 'Ha ocurrido un error inesperado. Por favor, intenta nuevamente.';
});

const errorDetails = computed(() => {
  if (!error.value) return null;

  const details = [];
  if (error.value.message) details.push(`Mensaje: ${error.value.message}`);
  if (error.value.stack) details.push(`\nStack:\n${error.value.stack}`);
  if (errorInfo.value) details.push(`\nInfo: ${errorInfo.value}`);

  return details.join('\n');
});

/**
 * Captura errores en componentes hijos
 */
onErrorCaptured((err, instance, info) => {
  const boundaryLogger = logger.child(`ErrorBoundary:${props.componentName}`);

  boundaryLogger.error('Error capturado en ErrorBoundary:', {
    error: err,
    message: err?.message,
    stack: err?.stack,
    component: instance?.$?.type?.name || 'Unknown',
    info,
  });

  error.value = err;
  errorInfo.value = info;
  hasError.value = true;
  retryCount.value++;

  // Emitir evento de error
  emit('error', {
    error: err,
    instance,
    info,
    retryCount: retryCount.value,
  });

  // Intentar recuperación automática si hay función onError
  if (props.onError) {
    try {
      const recovered = props.onError(err, instance, info, retryCount.value);
      if (recovered === true || recovered === Promise.resolve(true)) {
        boundaryLogger.info('Error recuperado automáticamente por onError callback');
        handleRecovery();
        return false; // Prevenir propagación
      }
    } catch (recoveryError) {
      boundaryLogger.error('Error en función de recuperación:', recoveryError);
    }
  }

  // Recuperación automática para errores recuperables
  if (retryCount.value < maxRetries && isRecoverableError(err)) {
    boundaryLogger.info(
      `Error recuperable detectado. Reintentando automáticamente (${retryCount.value}/${maxRetries})...`
    );
    setTimeout(() => {
      handleRetry();
    }, 1000 * retryCount.value); // Backoff exponencial
    return false; // Prevenir propagación del error
  }

  // No prevenir propagación para errores críticos o después de max retries
  return true;
});

/**
 * Determina si un error es recuperable
 */
function isRecoverableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Error & { name?: string };
  const message = e.message?.toLowerCase() || '';
  const errorType = e.name?.toLowerCase() || '';

  // Errores de red son generalmente recuperables
  if (
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('connection') ||
    message.includes('timeout') ||
    errorType.includes('network')
  ) {
    return true;
  }

  // Errores de tipo pueden ser recuperables si son de validación
  if (
    errorType.includes('typeerror') &&
    (message.includes('undefined') || message.includes('null') || message.includes('cannot read'))
  ) {
    // Solo si no es un error crítico de estructura
    return !message.includes('render') && !message.includes('component');
  }

  // Por defecto, considerar no recuperable
  return false;
}

/**
 * Maneja el reintento
 */
function handleRetry() {
  const boundaryLogger = logger.child(`ErrorBoundary:${props.componentName}`);
  boundaryLogger.info('Reintentando después de error...');

  emit('retry', {
    error: error.value,
    retryCount: retryCount.value,
  });

  // Resetear estado
  handleRecovery();
}

/**
 * Maneja la recuperación (resetea el estado de error)
 */
function handleRecovery() {
  hasError.value = false;
  error.value = null;
  errorInfo.value = null;
  emit('recovered');
}

/**
 * Recarga la página
 */
function handleReload() {
  window.location.reload();
}

/**
 * Descarta el error y continúa (solo si allowDismiss es true)
 */
function handleDismiss() {
  if (!props.allowDismiss) return;

  const boundaryLogger = logger.child(`ErrorBoundary:${props.componentName}`);
  boundaryLogger.warn(
    'Usuario descartó error y continúa. Esto puede causar comportamiento inesperado.'
  );

  handleRecovery();
}

// Exponer método para resetear desde fuera
defineExpose({
  reset: handleRecovery,
  hasError: computed(() => hasError.value),
});
</script>

<style scoped>
.error-boundary {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 18.75rem;
  padding: 2.5rem 1.25rem;
  background: var(--bg-main);
  border-radius: 0.5rem;
  margin: 1.25rem;
  border: 0.125rem solid var(--danger-color);
}

.error-boundary-content {
  text-align: center;
  max-width: 31.25rem;
}

.error-icon {
  font-size: 4rem;
  margin-bottom: 1.25rem;
  animation: shake 0.5s ease-in-out;
}

@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-0.625rem);
  }
  75% {
    transform: translateX(0.625rem);
  }
}

.error-title {
  color: var(--danger-color);
  font-size: 1.5rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
}

.error-message {
  color: var(--text-secondary);
  font-size: 1rem;
  line-height: 1.6;
  margin-bottom: 1.5rem;
}

.error-details {
  margin: 1.25rem 0;
  text-align: left;
  background: var(--overlay-bg-10);
  border-radius: 0.25rem;
  padding: 0.75rem;
}

.error-details summary {
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
  margin-bottom: 0.5rem;
}

.error-details summary:hover {
  color: var(--text-primary);
}

.error-stack {
  color: var(--text-muted);
  font-size: 0.6875rem;
  font-family: 'Courier New', monospace;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-x: auto;
  max-height: 12.5rem;
  overflow-y: auto;
}

.error-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 1.5rem;
}

.error-button {
  padding: 0.625rem 1.25rem;
  border: none;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 7.5rem;
}

.error-button-primary {
  background: var(--success-color);
  color: white;
}

.error-button-primary:hover {
  background: var(--primary-color-hover);
  transform: translateY(-0.0625rem);
  box-shadow: 0 0.25rem 0.5rem var(--primary-color-alpha);
}

.error-button-secondary {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.error-button-secondary:hover {
  background: var(--bg-hover);
  transform: translateY(-0.0625rem);
  box-shadow: var(--shadow-md);
}

.error-button:active {
  transform: translateY(0);
}
</style>
