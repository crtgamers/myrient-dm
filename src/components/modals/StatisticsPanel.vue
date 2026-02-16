<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="stats-overlay glass-effect"
      @click="$emit('close')"
    />

    <Transition name="modal-scale">
      <div
        v-if="show"
        ref="statsPanelRef"
        class="stats-panel glass-effect"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stats-dialog-title"
      >
        <div class="stats-header">
          <div class="header-title">
            <Activity :size="20" />
            <h2
              id="stats-dialog-title"
              class="stats-dialog-title"
            >
              {{ t('stats.title') }}
            </h2>
          </div>
          <button
            type="button"
            class="btn-close-panel"
            :aria-label="t('stats.close')"
            @click="$emit('close')"
          >
            <X :size="20" />
          </button>
        </div>

        <div class="stats-body">
          <template v-if="error">
            <p class="stats-error">{{ error }}</p>
          </template>
          <template v-else-if="!metrics && loading">
            <div class="stats-loading">
              <Loader2
                class="stats-spinner"
                :size="32"
              />
              <p>{{ t('stats.loading') }}</p>
            </div>
          </template>
          <template v-else-if="!metrics">
            <p class="stats-empty">{{ t('stats.noData') }}</p>
          </template>
          <template v-else>
            <!-- Velocidad actual (desde título si hay descargas activas) -->
            <div
              v-if="typeof averageDownloadSpeed === 'number' && activeDownloadCount > 0"
              class="stats-section"
            >
              <div class="section-label">
                <TrendingUp :size="16" />
                <h3>{{ t('stats.currentSpeed') }}</h3>
              </div>
              <div class="stats-current-speed">
                <span class="stats-speed-value">{{ averageDownloadSpeed.toFixed(2) }} MB/s</span>
                <span class="stats-speed-label">{{
                  t('stats.activeDownloads', { count: activeDownloadCount })
                }}</span>
              </div>
            </div>

            <!-- Resumen de sesión -->
            <div class="stats-section">
              <div class="section-label">
                <BarChart3 :size="16" />
                <h3>{{ t('stats.sessionSummary') }}</h3>
              </div>
              <div class="stats-grid">
                <div class="stats-card">
                  <span class="stats-card-value">{{ (metrics.totalStarted as number) ?? 0 }}</span>
                  <span class="stats-card-label">{{ t('stats.started') }}</span>
                </div>
                <div class="stats-card">
                  <span class="stats-card-value">{{
                    (metrics.totalCompleted as number) ?? 0
                  }}</span>
                  <span class="stats-card-label">{{ t('stats.completed') }}</span>
                </div>
                <div class="stats-card">
                  <span class="stats-card-value">{{ (metrics.totalFailed as number) ?? 0 }}</span>
                  <span class="stats-card-label">{{ t('stats.failed') }}</span>
                </div>
                <div class="stats-card">
                  <span class="stats-card-value">{{
                    (metrics.activeDownloadsCount as number) ?? 0
                  }}</span>
                  <span class="stats-card-label">{{ t('stats.activeNow') }}</span>
                </div>
                <div class="stats-card">
                  <span class="stats-card-value">{{
                    formatBytes(metrics.totalBytesDownloaded as number)
                  }}</span>
                  <span class="stats-card-label">{{ t('stats.totalDownloaded') }}</span>
                </div>
                <div class="stats-card">
                  <span class="stats-card-value">{{
                    (metrics.totalTransientRetries as number) ?? 0
                  }}</span>
                  <span class="stats-card-label">{{ t('stats.transientRetries') }}</span>
                </div>
              </div>
              <p
                v-if="errorRate != null"
                class="stats-hint"
              >
                {{ t('stats.errorRate', { rate: (errorRate * 100).toFixed(1) }) }}
              </p>
            </div>

            <!-- Cola -->
            <div
              v-if="typeof metrics.queueDepth === 'number'"
              class="stats-section"
            >
              <div class="section-label">
                <ListOrdered :size="16" />
                <h3>{{ t('stats.queue') }}</h3>
              </div>
              <p class="stats-single-value">
                {{ t('stats.queuedDownloads', { count: metrics.queueDepth }) }}
              </p>
            </div>

            <!-- Latencia (percentiles) -->
            <div
              v-if="latencyPercentiles && (latencyPercentiles.p50Ms || latencyPercentiles.p95Ms)"
              class="stats-section"
            >
              <div class="section-label">
                <Clock :size="16" />
                <h3>{{ t('stats.latency') }}</h3>
              </div>
              <div class="stats-latency">
                <span v-if="latencyPercentiles.p50Ms">
                  {{ t('stats.p50') }}: {{ formatMs(latencyPercentiles.p50Ms) }}
                </span>
                <span v-if="latencyPercentiles.p95Ms">
                  {{ t('stats.p95') }}: {{ formatMs(latencyPercentiles.p95Ms) }}
                </span>
                <span v-if="latencyPercentiles.p99Ms">
                  {{ t('stats.p99') }}: {{ formatMs(latencyPercentiles.p99Ms) }}
                </span>
              </div>
            </div>

            <!-- Por host -->
            <div
              v-if="hostEntries.length > 0"
              class="stats-section"
            >
              <div class="section-label">
                <Globe :size="16" />
                <h3>{{ t('stats.byHost') }}</h3>
              </div>
              <div class="stats-table-wrap">
                <table class="stats-table">
                  <thead>
                    <tr>
                      <th>{{ t('stats.host') }}</th>
                      <th>{{ t('stats.speed') }}</th>
                      <th>{{ t('stats.completed') }}</th>
                      <th>{{ t('stats.errors') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="[host, hm] in hostEntries"
                      :key="host"
                    >
                      <td class="stats-cell-host">{{ host }}</td>
                      <td>{{ formatSpeed((hm as HostMetric).avgSpeedBps) }}</td>
                      <td>{{ (hm as HostMetric).completedCount }}</td>
                      <td>{{ (hm as HostMetric).errorCount }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Circuit breaker -->
            <div
              v-if="circuitBreakerEntries.length > 0"
              class="stats-section"
            >
              <div class="section-label">
                <Shield :size="16" />
                <h3>{{ t('stats.circuitBreaker') }}</h3>
              </div>
              <ul class="stats-list">
                <li
                  v-for="[host, state] in circuitBreakerEntries"
                  :key="host"
                >
                  <strong>{{ host }}</strong
                  >: {{ String(state) }}
                </li>
              </ul>
            </div>

            <!-- Buffer pool / Worker pool (opcional, diagnóstico) -->
            <div
              v-if="(metrics.bufferPool || metrics.workerPool) && showDiagnostics"
              class="stats-section"
            >
              <div class="section-label">
                <Cpu :size="16" />
                <h3>{{ t('stats.diagnostics') }}</h3>
              </div>
              <pre
                v-if="metrics.bufferPool"
                class="stats-pre"
                >{{ JSON.stringify(metrics.bufferPool, null, 2) }}</pre
              >
              <pre
                v-if="metrics.workerPool"
                class="stats-pre"
                >{{ JSON.stringify(metrics.workerPool, null, 2) }}</pre
              >
            </div>
          </template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted, computed, toRef } from 'vue';
import { useModalFocusTrap } from '../../composables/useModalFocusTrap';
import { useI18n } from 'vue-i18n';
import {
  Activity,
  X,
  Loader2,
  TrendingUp,
  BarChart3,
  ListOrdered,
  Clock,
  Globe,
  Shield,
  Cpu,
} from 'lucide-vue-next';
import { getSessionMetrics } from '../../services/api';

interface HostMetric {
  completedCount: number;
  errorCount: number;
  avgSpeedBps: number;
}

const props = withDefaults(
  defineProps<{
    show: boolean;
    /** Velocidad promedio actual (MB/s) cuando hay descargas activas */
    averageDownloadSpeed?: number;
    /** Número de descargas activas (para mostrar en el panel) */
    activeDownloadCount?: number;
    /** Mostrar sección de diagnóstico (buffer pool, worker pool) */
    showDiagnostics?: boolean;
  }>(),
  {
    averageDownloadSpeed: undefined,
    activeDownloadCount: 0,
    showDiagnostics: false,
  }
);

const emit = defineEmits<{ (_e: 'close'): void }>();

const { t } = useI18n();

const statsPanelRef = ref<HTMLElement | null>(null);
useModalFocusTrap(statsPanelRef, toRef(props, 'show'), () => emit('close'));
const metrics = ref<Record<string, unknown> | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

let refreshTimer: ReturnType<typeof setInterval> | null = null;
const REFRESH_MS = 2000;

async function fetchMetrics() {
  if (!props.show) return;
  loading.value = true;
  error.value = null;
  const res = await getSessionMetrics();
  loading.value = false;
  if (res.success && res.data !== undefined) {
    metrics.value = res.data as Record<string, unknown> | null;
  } else {
    metrics.value = null;
    error.value = res.error ?? t('stats.loadError');
  }
}

function formatBytes(bytes: number | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '0 B';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(2)} MB`;
}

function formatSpeed(bps: number | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return '—';
  const mbps = bps / (1024 * 1024);
  return `${mbps.toFixed(2)} MB/s`;
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

const errorRate = computed(() => {
  const m = metrics.value;
  if (!m) return null;
  const completed = (m.totalCompleted as number) ?? 0;
  const failed = (m.totalFailed as number) ?? 0;
  const total = completed + failed;
  return total > 0 ? failed / total : null;
});

const latencyPercentiles = computed(() => {
  return (
    (metrics.value?.latencyPercentiles as { p50Ms?: number; p95Ms?: number; p99Ms?: number }) ??
    null
  );
});

const hostEntries = computed(() => {
  const hosts = metrics.value?.hosts as Record<string, HostMetric> | undefined;
  if (!hosts || typeof hosts !== 'object') return [];
  return Object.entries(hosts)
    .filter(([, hm]) => hm && (hm.completedCount > 0 || hm.errorCount > 0))
    .sort(([, a], [, b]) => (b.avgSpeedBps ?? 0) - (a.avgSpeedBps ?? 0));
});

const circuitBreakerEntries = computed(() => {
  const cb = metrics.value?.circuitBreakerByHost as Record<string, string> | undefined;
  if (!cb || typeof cb !== 'object') return [];
  return Object.entries(cb);
});

watch(
  () => props.show,
  visible => {
    if (visible) {
      fetchMetrics();
      refreshTimer = setInterval(fetchMetrics, REFRESH_MS);
    } else {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    }
  },
  { immediate: true }
);

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
</script>

<style scoped>
.stats-overlay {
  position: fixed;
  inset: 0;
  z-index: 9998;
  background: var(--overlay-bg);
}

.stats-panel {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(92vw, 560px);
  max-height: 88vh;
  z-index: 9999;
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-2xl);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
}

.stats-header {
  padding: 1.25rem 1.5rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border-color);
}

.stats-dialog-title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 800;
  letter-spacing: -0.5px;
}

.stats-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.stats-loading,
.stats-error,
.stats-empty {
  text-align: center;
  color: var(--text-muted);
  padding: 2rem;
  margin: 0;
}

.stats-spinner {
  display: block;
  margin: 0 auto 0.75rem;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.stats-error {
  color: var(--danger-color);
}
.stats-current-speed {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.stats-speed-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--primary-color);
}
.stats-speed-label {
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 0.75rem;
}
.stats-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 1rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
}
.stats-card-value {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
}
.stats-card-label {
  font-size: 0.75rem;
  color: var(--text-muted);
  text-align: center;
}
.stats-hint {
  margin: 0.5rem 0 0;
  font-size: var(--text-sm);
  color: var(--text-muted);
}
.stats-single-value {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.stats-latency {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.stats-table-wrap {
  overflow-x: auto;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
}
.stats-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}
.stats-table th,
.stats-table td {
  padding: 0.5rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid var(--border-color);
}
.stats-table th {
  background: var(--bg-secondary);
  color: var(--text-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.stats-cell-host {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stats-list {
  margin: 0;
  padding-left: 1.25rem;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
.stats-list li {
  margin-bottom: 0.25rem;
}

.stats-pre {
  margin: 0;
  padding: 0.75rem;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  font-size: 0.75rem;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
