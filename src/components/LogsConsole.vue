<template>
  <Teleport to="body">
    <!-- Overlay -->
    <div
      v-if="show"
      class="logs-overlay"
      @click="$emit('close')"
    />

    <!-- Panel de consola lateral -->
    <Transition name="modal-scale">
      <div
        v-if="show"
        ref="logsPanel"
        class="logs-panel glass-effect"
        role="dialog"
        aria-modal="true"
      >
        <div class="logs-header">
          <div class="header-title">
            <Terminal :size="20" />
            <h2>{{ t('logs.title') }}</h2>
          </div>
          <div class="logs-header-actions">
            <button
              type="button"
              class="icon-action-btn"
              :title="t('logs.clearLogs')"
              :aria-label="t('logs.clearLogsAria')"
              @click="clearLogs"
            >
              <Trash2 :size="18" />
            </button>
            <button
              type="button"
              class="icon-action-btn"
              :title="t('logs.exportLogs')"
              :aria-label="t('logs.exportLogsAria')"
              @click="exportLogs"
            >
              <Download :size="18" />
            </button>
            <button
              type="button"
              class="btn-close-panel"
              :title="t('logs.closePanel')"
              :aria-label="t('logs.closeConsoleAria')"
              @click="$emit('close')"
            >
              <X :size="20" />
            </button>
          </div>
        </div>

        <!-- Filtros Rápidos -->
        <div class="logs-controls glass-effect">
          <div class="filter-group">
            <div class="select-wrapper">
              <select
                v-model="filters.level"
                class="modern-select mini"
              >
                <option value="">{{ t('logs.allLevels') }}</option>
                <option value="DEBUG">{{ t('logs.debug') }}</option>
                <option value="INFO">{{ t('logs.info') }}</option>
                <option value="WARN">{{ t('logs.warnings') }}</option>
                <option value="ERROR">{{ t('logs.errors') }}</option>
              </select>
              <ChevronDown
                :size="12"
                class="select-arrow"
              />
            </div>
          </div>

          <div class="filter-group">
            <div class="select-wrapper">
              <select
                v-model="filters.scope"
                class="modern-select mini"
              >
                <option value="">{{ t('logs.allModules') }}</option>
                <option
                  v-for="scope in availableScopes"
                  :key="scope"
                  :value="scope"
                >
                  {{ scope }}
                </option>
              </select>
              <ChevronDown
                :size="12"
                class="select-arrow"
              />
            </div>
          </div>

          <label class="auto-scroll-toggle">
            <input
              v-model="autoScroll"
              type="checkbox"
              class="ios-switch mini"
            />
            <span>{{ t('logs.autoScroll') }}</span>
          </label>
        </div>

        <!-- Cuerpo de logs tipo Terminal -->
        <div
          ref="logsContainer"
          class="logs-body"
        >
          <div
            v-for="(log, index) in filteredLogs"
            :key="index"
            :class="['log-entry', `log-${log.level.toLowerCase()}`]"
          >
            <div class="log-meta">
              <span class="log-time">{{ formatTime(log.timestamp) }}</span>
              <span class="log-level-badge">{{ log.level }}</span>
              <span
                v-if="log.scope"
                class="log-scope-tag"
                >{{ log.scope }}</span
              >
            </div>
            <div class="log-message">{{ formatMessage(log.message) }}</div>
          </div>

          <div
            v-if="filteredLogs.length === 0"
            class="empty-state mini"
          >
            <Terminal :size="32" />
            <p>{{ t('logs.noEvents') }}</p>
          </div>
        </div>

        <div class="logs-footer">
          <div class="stats">
            <span class="total">{{ filteredLogs.length }}</span>
            <span class="label">{{ t('logs.eventsInView') }}</span>
          </div>
          <div
            class="mode-badge"
            :class="{ dev: isDev }"
          >
            {{ isDev ? 'Development Mode' : 'Production Mode' }}
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, toRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { Terminal, Trash2, Download, X, ChevronDown } from 'lucide-vue-next';
import logger, { type LogEntry } from '../utils/logger';
import { useModalFocusTrap } from '../composables/useModalFocusTrap';

const { t } = useI18n();
const props = defineProps({
  show: { type: Boolean, default: false },
});

const emit = defineEmits(['close']);

const logsContainer = ref<HTMLElement | null>(null);
const logsPanel = ref<HTMLElement | null>(null);
useModalFocusTrap(logsPanel, toRef(props, 'show'), () => emit('close'));
const autoScroll = ref(true);

const filters = ref({ level: '', scope: '' });
const allLogs = ref<LogEntry[]>([]);
const isDev = import.meta.env.DEV;

let unsubscribe: (() => void) | null = null;

const loadLogs = () => {
  allLogs.value = logger.getLogs();
  unsubscribe = logger.onLog((newLog: LogEntry) => {
    allLogs.value.push(newLog);
    if (allLogs.value.length > 1000) allLogs.value.shift();
    if (autoScroll.value) nextTick(scrollToBottom);
  });
};

const availableScopes = computed(() => {
  const scopes = new Set<string>();
  allLogs.value.forEach(log => log.scope && scopes.add(log.scope));
  return Array.from(scopes).sort();
});

const filteredLogs = computed(() => {
  let logs = [...allLogs.value];
  if (filters.value.level) logs = logs.filter(l => l.level === filters.value.level);
  if (filters.value.scope) logs = logs.filter(l => l.scope === filters.value.scope);
  return logs;
});

const formatTime = (timestamp: string | number) => {
  const d = new Date(timestamp);
  return d.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
};

const formatMessage = (message: unknown) => {
  if (Array.isArray(message)) {
    return message
      .map(msg => {
        if (typeof msg === 'object' && msg !== null) {
          const m = msg as { type?: string; message?: string; stack?: string };
          if (m.type === 'error')
            return `Error: ${m.message ?? ''}${m.stack ? '\n' + m.stack : ''}`;
          return JSON.stringify(msg, null, 2);
        }
        return String(msg);
      })
      .join(' ');
  }
  return String(message);
};

const scrollToBottom = () => {
  const el = logsContainer.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
};

const clearLogs = () => {
  if (confirm('¿Limpiar historial de eventos?')) {
    logger.clearLogs();
    allLogs.value = [];
  }
};

const exportLogs = async () => {
  try {
    const dialogOptions = {
      title: t('logs.saveDialogTitle'),
      filterText: t('logs.saveDialogFilterText'),
      filterAll: t('logs.saveDialogFilterAll'),
      canceledMessage: t('logs.saveDialogCanceled'),
    };
    const result = await logger.saveLogsToFile(
      {
        level: filters.value.level || undefined,
        scope: filters.value.scope || undefined,
      },
      dialogOptions
    );
    if (result.success && result.path) {
      alert(t('logs.exportSuccess', { path: result.path }));
    } else if (!result.success && result.error) {
      alert(t('logs.exportError', { message: result.error }));
    }
  } catch (err) {
    alert(
      t('logs.exportFailed', {
        message: err instanceof Error ? err.message : String(err),
      })
    );
  }
};

watch(
  () => props.show,
  isOpen => {
    if (isOpen) nextTick(scrollToBottom);
  }
);

onMounted(() => {
  loadLogs();
  nextTick(scrollToBottom);
});

onUnmounted(() => {
  unsubscribe?.();
});
</script>

<style scoped>
.logs-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--overlay-bg-70);
  z-index: 9998;
}

.logs-panel {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 90vw;
  max-width: 75rem;
  height: 80vh;
  background: var(--bg-main);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  color: var(--text-primary);
  border: 0.0625rem solid var(--border-color);
}

.logs-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md);
  border-bottom: 0.0625rem solid var(--border-color);
}

.logs-header h2 {
  margin: 0;
  font-size: 1.25rem;
}

.logs-header-actions {
  display: flex;
  gap: var(--spacing-sm);
  align-items: center;
}

.btn-clear,
.btn-export {
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--bg-main);
  border: 0.0625rem solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 0.875rem;
  transition: background 0.2s;
}

.btn-clear:hover,
.btn-export:hover {
  background: var(--bg-hover);
}

.logs-controls {
  display: flex;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  border-bottom: 0.0625rem solid var(--border-color);
  flex-wrap: wrap;
}

.filter-group {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.filter-group label {
  font-size: 0.875rem;
  white-space: nowrap;
}

.checkbox-input {
  margin-right: var(--spacing-xs);
  cursor: pointer;
}

.logs-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-md);
  font-family: 'Courier New', monospace;
  font-size: 0.813rem;
  line-height: 1.6;
}

.log-entry {
  display: flex;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) 0;
  border-bottom: 0.0625rem solid var(--overlay-bg-05);
  word-break: break-word;
}

.log-entry:last-child {
  border-bottom: none;
}

.log-time {
  color: var(--text-secondary);
  min-width: 5.625rem;
  flex-shrink: 0;
}

.log-mode {
  color: var(--text-muted);
  min-width: 3.125rem;
  flex-shrink: 0;
  font-weight: 500;
}

.log-level {
  min-width: 3.75rem;
  flex-shrink: 0;
  font-weight: 600;
}

.log-debug .log-level {
  color: var(--text-muted);
}

.log-info .log-level {
  color: var(--success-color);
}

.log-warn .log-level {
  color: var(--warning-color);
}

.log-error .log-level {
  color: var(--danger-color);
}

.log-scope {
  color: var(--status-merging);
  min-width: 6.25rem;
  flex-shrink: 0;
  font-weight: 500;
}

.log-message {
  flex: 1;
  color: var(--text-primary);
}

.logs-empty {
  text-align: center;
  padding: var(--spacing-xl);
  color: var(--text-muted);
}

.logs-footer {
  padding: var(--spacing-md);
  border-top: 0.0625rem solid var(--border-color);
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.logs-count {
  font-weight: 500;
}
</style>
