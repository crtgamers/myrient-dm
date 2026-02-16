<template>
  <Teleport to="body">
    <!-- Overlay -->
    <div
      v-if="show"
      class="settings-overlay glass-effect"
      @click="$emit('close')"
    />

    <!-- Panel de settings -->
    <Transition name="modal-scale">
      <div
        v-if="show"
        ref="settingsPanel"
        class="settings-panel glass-effect"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
      >
        <div class="settings-header">
          <div class="header-title">
            <Settings :size="20" />
            <h2
              id="settings-dialog-title"
              class="settings-dialog-title"
            >
              {{ t('settings.title') }}
            </h2>
          </div>
          <button
            type="button"
            class="btn-close-panel"
            :aria-label="t('settings.close')"
            @click="$emit('close')"
          >
            <X :size="20" />
          </button>
        </div>

        <div class="settings-body">
          <!-- Sección Búsqueda -->
          <div class="settings-section">
            <div class="section-label">
              <Search :size="16" />
              <h3>{{ t('settings.search') }}</h3>
            </div>
            <div class="setting-card">
              <div class="setting-info">
                <label>{{ t('search.limitLabel') }}</label>
                <p>{{ t('search.limitDescription') }}</p>
              </div>
              <div class="settings-stepper">
                <button
                  class="stepper-btn"
                  :aria-label="t('common.decrease')"
                  :disabled="searchLimit <= 100"
                  @click="$emit('update:searchLimit', Math.max(100, searchLimit - 100))"
                >
                  <Minus
                    :size="14"
                    aria-hidden="true"
                  />
                </button>
                <input
                  type="number"
                  :value="searchLimit"
                  min="100"
                  max="1000"
                  step="100"
                  class="settings-input"
                  @input="onSearchLimitInput"
                />
                <button
                  class="stepper-btn"
                  :aria-label="t('common.increase')"
                  :disabled="searchLimit >= 1000"
                  @click="$emit('update:searchLimit', Math.min(1000, searchLimit + 100))"
                >
                  <Plus
                    :size="14"
                    aria-hidden="true"
                  />
                </button>
              </div>
            </div>
          </div>

          <!-- Sección Descargas -->
          <div class="settings-section">
            <div class="section-label">
              <Download :size="16" />
              <h3>{{ t('settings.downloads') }}</h3>
            </div>

            <div class="setting-card vertical">
              <div class="setting-info">
                <label>{{ t('settings.destinationFolder') }}</label>
                <p>{{ t('settings.destinationFolderHint') }}</p>
              </div>
              <div class="path-selector">
                <input
                  type="text"
                  :value="downloadPath"
                  class="settings-input path-display"
                  readonly
                />
                <button
                  class="action-btn-pill"
                  @click="$emit('select-folder')"
                >
                  <FolderOpen :size="14" />
                  {{ t('settings.change') }}
                </button>
              </div>
            </div>

            <!-- Turbo Descarga: una sola descarga activa, 100% ancho de banda -->
            <div class="setting-card toggle">
              <div class="setting-info">
                <label>{{ t('settingsExtra.turboDownload') }}</label>
                <p>{{ t('settingsExtra.turboDownloadHint') }}</p>
              </div>
              <input
                type="checkbox"
                :checked="turboDownload"
                class="ios-switch"
                @change="onTurboDownloadChange"
              />
            </div>

            <div
              class="setting-card"
              :class="{ 'setting-card--disabled': turboDownload }"
            >
              <div class="setting-info">
                <label>{{ t('settings.parallelDownloads') }}</label>
                <p>{{ t('settings.parallelDownloadsHint') }}</p>
              </div>
              <div class="settings-stepper">
                <button
                  class="stepper-btn"
                  :aria-label="t('common.decrease')"
                  :disabled="turboDownload || maxParallelDownloads <= 1"
                  @click="
                    $emit('update:maxParallelDownloads', Math.max(1, maxParallelDownloads - 1))
                  "
                >
                  <Minus
                    :size="14"
                    aria-hidden="true"
                  />
                </button>
                <input
                  type="number"
                  :value="maxParallelDownloads"
                  min="1"
                  max="3"
                  class="settings-input"
                  :disabled="turboDownload"
                  @input="onMaxParallelInput"
                />
                <button
                  class="stepper-btn"
                  :aria-label="t('common.increase')"
                  :disabled="turboDownload || maxParallelDownloads >= 3"
                  @click="
                    $emit('update:maxParallelDownloads', Math.min(3, maxParallelDownloads + 1))
                  "
                >
                  <Plus
                    :size="14"
                    aria-hidden="true"
                  />
                </button>
              </div>
            </div>

            <div class="setting-card">
              <div class="setting-info">
                <label>{{ t('settings.batchConfirmLabel') }}</label>
                <p>
                  {{
                    queueBatchConfirmThreshold === 0
                      ? t('settings.batchConfirmZero')
                      : t('settings.batchConfirmHintN', { n: queueBatchConfirmThreshold })
                  }}
                </p>
              </div>
              <div class="settings-stepper">
                <button
                  class="stepper-btn"
                  :aria-label="t('common.decrease')"
                  :disabled="queueBatchConfirmThreshold <= 0"
                  @click="emitQueueBatchThreshold(Math.max(0, queueBatchConfirmThreshold - 10))"
                >
                  <Minus
                    :size="14"
                    aria-hidden="true"
                  />
                </button>
                <input
                  type="number"
                  :value="queueBatchConfirmThreshold"
                  :min="0"
                  :max="queueBatchThresholdMax"
                  class="settings-input"
                  @input="onQueueBatchThresholdInput"
                />
                <button
                  class="stepper-btn"
                  :aria-label="t('common.increase')"
                  :disabled="queueBatchConfirmThreshold >= queueBatchThresholdMax"
                  @click="
                    emitQueueBatchThreshold(
                      Math.min(queueBatchThresholdMax, queueBatchConfirmThreshold + 10)
                    )
                  "
                >
                  <Plus
                    :size="14"
                    aria-hidden="true"
                  />
                </button>
              </div>
              <p
                v-if="queueBatchConfirmThreshold === 0"
                class="setting-hint"
              >
                {{ t('settings.valueZeroNoLimit') }}
              </p>
            </div>

            <!-- Desactivar descargas por chunks (solo descarga directa) -->
            <div class="setting-card toggle">
              <div class="setting-info">
                <label>{{ t('settingsExtra.useDirectDownloadOnly') }}</label>
                <p>{{ t('settingsExtra.useDirectDownloadOnlyHint') }}</p>
              </div>
              <input
                type="checkbox"
                :checked="disableChunkedDownloads"
                class="ios-switch"
                @change="onDisableChunkedDownloadsChange"
              />
            </div>

            <div
              class="setting-card"
              :class="{ 'setting-card--disabled': disableChunkedDownloads }"
            >
              <div class="setting-info">
                <label>{{ t('settingsExtra.concurrentChunks') }}</label>
                <p>{{ t('settingsExtra.concurrentChunksHint') }}</p>
              </div>
              <div class="settings-stepper">
                <button
                  class="stepper-btn"
                  :aria-label="t('common.decrease')"
                  :disabled="disableChunkedDownloads || maxConcurrentChunks <= 1"
                  @click="$emit('update:maxConcurrentChunks', Math.max(1, maxConcurrentChunks - 1))"
                >
                  <Minus
                    :size="14"
                    aria-hidden="true"
                  />
                </button>
                <input
                  type="number"
                  :value="maxConcurrentChunks"
                  min="1"
                  max="4"
                  class="settings-input"
                  :disabled="disableChunkedDownloads"
                  @input="onMaxChunksInput"
                />
                <button
                  class="stepper-btn"
                  :aria-label="t('common.increase')"
                  :disabled="disableChunkedDownloads || maxConcurrentChunks >= 4"
                  @click="$emit('update:maxConcurrentChunks', Math.min(4, maxConcurrentChunks + 1))"
                >
                  <Plus
                    :size="14"
                    aria-hidden="true"
                  />
                </button>
              </div>
            </div>

            <div
              class="setting-card"
              :class="{ 'setting-card--disabled': disableChunkedDownloads }"
            >
              <div class="setting-info">
                <label>{{ t('settingsExtra.retriesPerChunk') }}</label>
                <p>{{ t('settingsExtra.retriesPerChunkHint') }}</p>
              </div>
              <div class="settings-stepper">
                <button
                  class="stepper-btn"
                  :aria-label="t('common.decrease')"
                  :disabled="disableChunkedDownloads || maxChunkRetries <= 0"
                  @click="$emit('update:maxChunkRetries', Math.max(0, maxChunkRetries - 1))"
                >
                  <Minus
                    :size="14"
                    aria-hidden="true"
                  />
                </button>
                <input
                  type="number"
                  :value="maxChunkRetries"
                  min="0"
                  max="20"
                  class="settings-input"
                  :disabled="disableChunkedDownloads"
                  @input="onMaxChunkRetriesInput"
                />
                <button
                  class="stepper-btn"
                  :aria-label="t('common.increase')"
                  :disabled="disableChunkedDownloads || maxChunkRetries >= 20"
                  @click="$emit('update:maxChunkRetries', Math.min(20, maxChunkRetries + 1))"
                >
                  <Plus
                    :size="14"
                    aria-hidden="true"
                  />
                </button>
              </div>
            </div>

            <div
              class="setting-card"
              :class="{ 'setting-card--disabled': disableChunkedDownloads }"
            >
              <div class="setting-info">
                <label>{{ t('settingsExtra.chunkTimeout') }}</label>
                <p>
                  Tiempo máximo sin progreso antes de abortar un fragmento y reintentarlo (1–30
                  min).
                </p>
              </div>
              <div class="settings-stepper">
                <button
                  class="stepper-btn"
                  :aria-label="t('common.decrease')"
                  :disabled="disableChunkedDownloads || chunkOperationTimeoutMinutes <= 1"
                  @click="
                    $emit(
                      'update:chunkOperationTimeoutMinutes',
                      Math.max(1, chunkOperationTimeoutMinutes - 1)
                    )
                  "
                >
                  <Minus
                    :size="14"
                    aria-hidden="true"
                  />
                </button>
                <input
                  type="number"
                  :value="chunkOperationTimeoutMinutes"
                  min="1"
                  max="30"
                  class="settings-input"
                  :disabled="disableChunkedDownloads"
                  @input="onChunkTimeoutInput"
                />
                <button
                  class="stepper-btn"
                  :aria-label="t('common.increase')"
                  :disabled="disableChunkedDownloads || chunkOperationTimeoutMinutes >= 30"
                  @click="
                    $emit(
                      'update:chunkOperationTimeoutMinutes',
                      Math.min(30, chunkOperationTimeoutMinutes + 1)
                    )
                  "
                >
                  <Plus
                    :size="14"
                    aria-hidden="true"
                  />
                </button>
              </div>
            </div>

            <!-- Saltar verificación (aplica también a descarga directa) -->
            <div class="setting-card toggle">
              <div class="setting-info">
                <label>{{ t('settingsExtra.skipVerification') }}</label>
                <p>
                  No verificar tamaño ni hash al terminar; marcar la descarga como lista
                  directamente. Aplica a descargas por chunks y a descargas directas.
                </p>
              </div>
              <input
                type="checkbox"
                :checked="skipVerification"
                class="ios-switch"
                @change="onSkipVerificationChange"
              />
            </div>

            <!-- Calibrar conexión -->
            <div
              class="setting-card vertical calibration-card"
              :class="{ 'setting-card--disabled': disableChunkedDownloads }"
            >
              <div class="setting-info">
                <label>{{ t('settingsExtra.calibrate') }}</label>
                <p>{{ t('settingsExtra.calibrateHint') }}</p>
              </div>
              <div class="calibration-actions">
                <button
                  type="button"
                  class="action-btn-pill"
                  :disabled="calibrationLoading || disableChunkedDownloads"
                  @click="runCalibration"
                >
                  <span v-if="calibrationLoading">{{ t('settingsExtra.calibrating') }}</span>
                  <span v-else>{{ t('settingsExtra.runTest') }}</span>
                </button>
                <template v-if="calibrationResult">
                  <p
                    class="calibration-message"
                    :class="{ 'calibration-error': !calibrationResult.success }"
                  >
                    {{ calibrationResult.message }}
                  </p>
                  <ul
                    v-if="calibrationResult.details?.length"
                    class="calibration-details"
                  >
                    <li
                      v-for="(line, i) in calibrationResult.details"
                      :key="i"
                    >
                      {{ line }}
                    </li>
                  </ul>
                  <button
                    v-if="calibrationResult.success"
                    type="button"
                    class="action-btn-pill primary"
                    @click="applyCalibration"
                  >
                    {{ t('settingsExtra.applyRecommendation') }}
                  </button>
                </template>
              </div>
            </div>

            <div class="settings-grid">
              <div class="setting-card toggle">
                <div class="setting-info">
                  <label>{{ t('settingsExtra.preserveStructure') }}</label>
                  <p>{{ t('settingsExtra.preserveStructureHint') }}</p>
                </div>
                <input
                  type="checkbox"
                  :checked="preserveStructure"
                  class="ios-switch"
                  @change="onPreserveStructureChange"
                />
              </div>

              <div class="setting-card toggle">
                <div class="setting-info">
                  <label>{{ t('settingsExtra.autoResume') }}</label>
                  <p>{{ t('settingsExtra.autoResumeHint') }}</p>
                </div>
                <input
                  type="checkbox"
                  :checked="autoResumeDownloads"
                  class="ios-switch"
                  @change="onAutoResumeChange"
                />
              </div>
            </div>
          </div>

          <!-- Sección Almacenamiento -->
          <div class="settings-section">
            <div class="section-label">
              <Database :size="16" />
              <h3>{{ t('settingsExtra.maintenance') }}</h3>
            </div>

            <div class="setting-card vertical">
              <div class="setting-info">
                <label>{{ t('settingsExtra.programFolder') }}</label>
                <p>{{ t('settingsExtra.programFolderHint') }}</p>
              </div>
              <div class="path-selector">
                <input
                  type="text"
                  :value="userDataPath"
                  class="settings-input path-display"
                  readonly
                />
                <button
                  class="action-btn-pill"
                  :disabled="!userDataPath"
                  @click="openProgramFolder"
                >
                  <FolderOpen :size="14" />
                  {{ t('settingsExtra.openFolder') }}
                </button>
              </div>
            </div>

            <div class="settings-grid">
              <button
                class="action-card"
                @click="$emit('open-statistics')"
              >
                <Activity :size="18" />
                <div class="btn-labels">
                  <span>{{ t('settingsExtra.viewStatistics') }}</span>
                  <p>{{ t('settingsExtra.viewStatisticsHint') }}</p>
                </div>
              </button>
              <button
                class="danger-action-card"
                @click="$emit('clear-favorites')"
              >
                <Star :size="18" />
                <div class="btn-labels">
                  <span>{{ t('settingsExtra.clearFavorites') }}</span>
                  <p>{{ t('settingsExtra.favoritesCount', { count: favoritesCount }) }}</p>
                </div>
              </button>
              <button
                class="danger-action-card"
                @click="$emit('clear-history')"
              >
                <History :size="18" />
                <div class="btn-labels">
                  <span>{{ t('settingsExtra.clearHistory') }}</span>
                  <p>{{ t('settingsExtra.clearHistoryHint') }}</p>
                </div>
              </button>
            </div>
          </div>

          <!-- Sección Actualizaciones (solo en Electron empaquetado) -->
          <div
            v-if="updaterEnabled"
            class="settings-section"
          >
            <div class="section-label">
              <Download :size="16" />
              <h3>{{ t('settings.updates') }}</h3>
            </div>
            <div class="setting-card toggle">
              <div class="setting-info">
                <label>{{ t('settings.autoCheckUpdates') }}</label>
                <p>{{ t('settings.autoCheckUpdatesHint') }}</p>
              </div>
              <input
                type="checkbox"
                :checked="autoCheckUpdates"
                class="ios-switch"
                @change="onAutoCheckUpdatesChange"
              />
            </div>
            <div class="setting-card vertical">
              <div class="setting-info">
                <label>{{ t('settings.currentVersion') }}</label>
                <p>{{ appVersionDisplay }}</p>
              </div>
              <div class="path-selector">
                <button
                  type="button"
                  class="action-btn-pill"
                  :disabled="updateStatus === 'checking' || updateStatus === 'downloading'"
                  @click="doCheckForUpdates"
                >
                  {{
                    updateStatus === 'checking'
                      ? t('settings.checkingForUpdates')
                      : t('settings.checkForUpdates')
                  }}
                </button>
                <button
                  v-if="updateStatus === 'ready'"
                  type="button"
                  class="action-btn-pill primary"
                  @click="doQuitAndInstall"
                >
                  {{ t('settings.restartToInstall') }}
                </button>
              </div>
              <p
                v-if="updateStatusMessage"
                class="setting-hint"
                :class="{ 'calibration-error': updateStatus === 'error' }"
              >
                {{ updateStatusMessage }}
              </p>
              <p
                v-if="updateStatus === 'downloading' && updateDownloadPercent != null"
                class="setting-hint"
              >
                {{
                  t('settings.updateDownloading', { percent: Math.round(updateDownloadPercent) })
                }}
              </p>
            </div>
          </div>

          <!-- Sección Apariencia -->
          <div class="settings-section">
            <div class="section-label">
              <Palette :size="16" />
              <h3>{{ t('settings.appearance') }}</h3>
            </div>
            <div class="setting-card vertical">
              <div class="setting-info">
                <label>{{ t('settings.language') }}</label>
                <p>{{ t('settings.languageHint') }}</p>
              </div>
              <select
                :value="currentLocale"
                class="settings-select"
                :aria-label="t('settings.language')"
                @change="onLocaleChange"
              >
                <option
                  v-for="code in supportedLocales"
                  :key="code"
                  :value="code"
                >
                  {{ localeLabels[code] }}
                </option>
              </select>
            </div>
            <div class="setting-card vertical">
              <div class="setting-info">
                <label>{{ t('settings.motionPreference') }}</label>
                <p>{{ t('settings.motionPreferenceHint') }}</p>
              </div>
              <select
                :value="motionPreference"
                class="settings-select"
                :aria-label="t('settings.motionPreference')"
                @change="onMotionPreferenceChange"
              >
                <option value="auto">{{ t('settings.motionAuto') }}</option>
                <option value="reduce">{{ t('settings.motionReduce') }}</option>
                <option value="full">{{ t('settings.motionFull') }}</option>
              </select>
            </div>
            <div class="setting-card setting-card--color-accent">
              <div class="setting-info">
                <label>{{ t('settings.primaryColor') }}</label>
                <p>{{ t('settingsExtra.primaryColorHint') }}</p>
              </div>
              <div class="color-picker-modern">
                <button
                  v-for="(colorConfig, colorKey) in primaryColors"
                  :key="colorKey"
                  class="color-dot"
                  :class="{ active: primaryColor === colorKey }"
                  :style="{ backgroundColor: colorConfig.value }"
                  :title="getColorLabel(colorKey)"
                  :aria-label="getColorLabel(colorKey)"
                  @click="$emit('set-primary-color', colorKey)"
                />
              </div>
            </div>
          </div>

          <!-- Sección Rendimiento -->
          <div class="settings-section">
            <div class="section-label">
              <Activity :size="16" />
              <h3>{{ t('settings.performanceSection') }}</h3>
            </div>
            <div class="setting-card toggle">
              <div class="setting-info">
                <label>{{ t('settings.performanceMode') }}</label>
                <p>{{ t('settings.performanceModeHint') }}</p>
              </div>
              <input
                type="checkbox"
                :checked="performanceMode"
                class="ios-switch"
                :aria-label="t('settings.performanceMode')"
                @change="onPerformanceModeChange"
              />
            </div>
          </div>

          <!-- Sección Créditos -->
          <div class="settings-section">
            <div class="section-label">
              <Heart :size="16" />
              <h3>{{ t('settingsExtra.credits') }}</h3>
            </div>
            <div class="setting-card vertical credits-card">
              <p class="credits-label">{{ t('settingsExtra.authors') }}</p>
              <ul class="credits-list">
                <li>Bastian Aguirre (CRT Gamers Chile)</li>
                <li>Pablo M. Iglesias</li>
              </ul>
              <p class="credits-label">{{ t('settingsExtra.acknowledgements') }}</p>
              <ul class="credits-list">
                <li>El equipo de Myrient por ser el mejor sitio para descargar ROMs</li>
                <li>Erista por ser el mejor servidor del mundo</li>
                <li>Brand Evans por crear Myrient-Downloader</li>
                <li>A la gran Monstwitos por diseñar el logo de Myrient Download Manager</li>
              </ul>
              <p class="credits-donate">
                Recuerden donar al proyecto de Myrient
                <button
                  type="button"
                  class="credits-link"
                  @click="openDonateLink"
                >
                  https://myrient.erista.me/donate/
                </button>
                <br />
                Que sin ellos no no existira este proyecto. <br />Recuerden: <br />Si comprarlo no
                me hace dueño... Descargarlo no es robarlo.
              </p>
            </div>
          </div>
        </div>

        <div class="settings-footer">
          <p class="version">{{ t('settingsExtra.version', { version: appVersionDisplay }) }}</p>
          <button
            type="button"
            class="primary-btn save-settings-footer-btn"
            :aria-label="t('settingsExtra.saveChanges')"
            @click="handleSaveAndClose"
          >
            {{ t('settingsExtra.saveChanges') }}
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, toRef, computed, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useModalFocusTrap } from '../../composables/useModalFocusTrap';
import {
  PRIMARY_COLORS,
  QUEUE_BATCH_THRESHOLD_MIN,
  QUEUE_BATCH_THRESHOLD_MAX,
  useSettings,
} from '../../composables/useSettings';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, LOCALE_LABELS } from '../../locales';
import {
  X,
  Settings,
  Search,
  Download,
  FolderOpen,
  Database,
  Star,
  History,
  Palette,
  Minus,
  Plus,
  Heart,
  Activity,
} from 'lucide-vue-next';
import {
  getSuggestedTestFile,
  runConnectionTest,
  getUserDataPath,
  openUserDataFolder,
  openExternalUrl,
  getAppVersion,
  checkForUpdates,
  quitAndInstall,
} from '../../services/api';

const appVersion = ref('1.3.0');
const appVersionDisplay = computed(() => appVersion.value || '1.3.0');
const updaterEnabled = ref(typeof window !== 'undefined' && !!window.api?.getAppVersion);
type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'not-available';
const updateStatus = ref<UpdateStatus>('idle');
const updateStatusMessage = ref('');
const updateDownloadPercent = ref<number | null>(null);
let updateListenersCleanup: (() => void)[] = [];
const { t } = useI18n();
const { locale: savedLocale, setLocale } = useSettings();
const supportedLocales = SUPPORTED_LOCALES;
const localeLabels = LOCALE_LABELS;
const currentLocale = computed(() => savedLocale.value || DEFAULT_LOCALE);
function onLocaleChange(e: Event) {
  const value = (e.target as HTMLSelectElement)?.value;
  if (value) void setLocale(value);
}

function getColorLabel(colorKey: string): string {
  const i18nKey = 'settingsExtra.color' + (colorKey.charAt(0).toUpperCase() + colorKey.slice(1));
  return t(i18nKey);
}

const queueBatchThresholdMax = QUEUE_BATCH_THRESHOLD_MAX;

function clampQueueBatchThreshold(value: unknown): number {
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) return 0;
  if (n === 0) return 0;
  return Math.min(QUEUE_BATCH_THRESHOLD_MAX, Math.max(QUEUE_BATCH_THRESHOLD_MIN, Math.floor(n)));
}

function emitQueueBatchThreshold(value: unknown) {
  emit('update:queueBatchConfirmThreshold', clampQueueBatchThreshold(value));
}

function onQueueBatchThresholdInput(event: Event) {
  const raw = (event.target as HTMLInputElement | null)?.value;
  emit('update:queueBatchConfirmThreshold', clampQueueBatchThreshold(raw));
}

const userDataPath = ref('');

interface CalibrationResult {
  success: boolean;
  message: string;
  details: string[];
  recommendedMaxChunks?: number;
  recommendedMaxParallel?: number;
}

const calibrationLoading = ref(false);
const calibrationResult = ref<CalibrationResult | null>(null);

async function runCalibration() {
  calibrationResult.value = null;
  calibrationLoading.value = true;
  try {
    const fileRes = await getSuggestedTestFile();
    if (!fileRes.success || !fileRes.url || !fileRes.totalBytes) {
      calibrationResult.value = {
        success: false,
        message:
          fileRes.error ||
          'No hay archivos en el catálogo para probar. Navega a una carpeta con archivos.',
        details: [],
      };
      return;
    }
    const testRes = await runConnectionTest(fileRes.url, fileRes.totalBytes);
    if (testRes.success && testRes.data) {
      calibrationResult.value = {
        success: testRes.data.success,
        message: testRes.data.message,
        details: testRes.data.details || [],
        recommendedMaxChunks: testRes.data.recommendedMaxChunks,
        recommendedMaxParallel: testRes.data.recommendedMaxParallel,
      };
    } else {
      calibrationResult.value = {
        success: false,
        message: testRes.error || 'Error en la prueba de conexión.',
        details: testRes.data?.details || [],
      };
    }
  } catch (e: unknown) {
    calibrationResult.value = {
      success: false,
      message: (e instanceof Error ? e.message : String(e)) || 'Error al ejecutar la prueba.',
      details: [],
    };
  } finally {
    calibrationLoading.value = false;
  }
}

function applyCalibration() {
  const r = calibrationResult.value;
  if (!r?.success || r.recommendedMaxParallel == null || r.recommendedMaxChunks == null) return;
  emit('update:maxParallelDownloads', Math.max(1, Math.min(3, r.recommendedMaxParallel)));
  emit('update:maxConcurrentChunks', Math.max(1, Math.min(4, r.recommendedMaxChunks)));
}

// Props
const props = defineProps({
  show: { type: Boolean, required: true },
  searchLimit: { type: Number, default: 500 },
  downloadPath: { type: String, default: '' },
  preserveStructure: { type: Boolean, default: true },
  maxParallelDownloads: { type: Number, default: 3 },
  turboDownload: { type: Boolean, default: false },
  queueBatchConfirmThreshold: { type: Number, default: 25 },
  maxConcurrentChunks: { type: Number, default: 3 },
  maxChunkRetries: { type: Number, default: 3 },
  chunkOperationTimeoutMinutes: { type: Number, default: 5 },
  skipVerification: { type: Boolean, default: false },
  disableChunkedDownloads: { type: Boolean, default: true },
  showNotifications: { type: Boolean, default: true },
  autoResumeDownloads: { type: Boolean, default: true },
  maxHistoryInMemory: { type: Number, default: 100 },
  maxCompletedInMemory: { type: Number, default: 50 },
  maxFailedInMemory: { type: Number, default: 20 },
  favoritesCount: { type: Number, default: 0 },
  lastUpdateDate: { type: String, default: '' },
  cleanupStats: { type: Object, default: null },
  primaryColor: { type: String, default: 'green' },
  showChunkProgress: { type: Boolean, default: true },
  autoCheckUpdates: { type: Boolean, default: true },
  motionPreference: { type: String, default: 'full' },
  performanceMode: { type: Boolean, default: false },
});

const emit = defineEmits([
  'close',
  'update:searchLimit',
  'update:downloadPath',
  'update:preserveStructure',
  'update:maxParallelDownloads',
  'update:turboDownload',
  'update:queueBatchConfirmThreshold',
  'update:maxConcurrentChunks',
  'update:maxChunkRetries',
  'update:chunkOperationTimeoutMinutes',
  'update:skipVerification',
  'update:disableChunkedDownloads',
  'update:showNotifications',
  'update:autoResumeDownloads',
  'update:maxHistoryInMemory',
  'update:maxCompletedInMemory',
  'update:maxFailedInMemory',
  'update:showChunkProgress',
  'update:autoCheckUpdates',
  'update:motionPreference',
  'update:performanceMode',
  'save-settings',
  'select-folder',
  'clear-favorites',
  'clean-history',
  'clear-history',
  'set-primary-color',
  'open-statistics',
]);

function onSearchLimitInput(e: Event) {
  const v = (e.target as HTMLInputElement | null)?.value;
  emit('update:searchLimit', Math.min(1000, Math.max(100, Number(v) || 100)));
}
function onMaxParallelInput(e: Event) {
  const v = (e.target as HTMLInputElement | null)?.value;
  emit('update:maxParallelDownloads', Math.min(3, Math.max(1, Number(v) || 1)));
}
function onMaxChunksInput(e: Event) {
  const v = (e.target as HTMLInputElement | null)?.value;
  emit('update:maxConcurrentChunks', Math.min(4, Math.max(1, Number(v) || 1)));
}
function onMaxChunkRetriesInput(e: Event) {
  const v = (e.target as HTMLInputElement | null)?.value;
  emit('update:maxChunkRetries', Math.min(20, Math.max(0, Number(v) || 0)));
}
function onChunkTimeoutInput(e: Event) {
  const v = (e.target as HTMLInputElement | null)?.value;
  emit('update:chunkOperationTimeoutMinutes', Math.min(30, Math.max(1, Number(v) || 1)));
}
function onSkipVerificationChange(e: Event) {
  emit('update:skipVerification', (e.target as HTMLInputElement).checked);
}
function onTurboDownloadChange(e: Event) {
  emit('update:turboDownload', (e.target as HTMLInputElement).checked);
}
function onDisableChunkedDownloadsChange(e: Event) {
  emit('update:disableChunkedDownloads', (e.target as HTMLInputElement).checked);
}
function onPreserveStructureChange(e: Event) {
  emit('update:preserveStructure', (e.target as HTMLInputElement).checked);
}
function onAutoResumeChange(e: Event) {
  emit('update:autoResumeDownloads', (e.target as HTMLInputElement).checked);
}
function onAutoCheckUpdatesChange(e: Event) {
  emit('update:autoCheckUpdates', (e.target as HTMLInputElement).checked);
}
function onMotionPreferenceChange(e: Event) {
  const value = (e.target as HTMLSelectElement)?.value;
  if (value === 'auto' || value === 'reduce' || value === 'full') {
    emit('update:motionPreference', value);
  }
}
function onPerformanceModeChange(e: Event) {
  emit('update:performanceMode', (e.target as HTMLInputElement).checked);
}

const primaryColors = PRIMARY_COLORS;
const settingsPanel = ref<HTMLElement | null>(null);
useModalFocusTrap(settingsPanel, toRef(props, 'show'), () => emit('close'));

onUnmounted(() => {
  updateListenersCleanup.forEach(fn => fn());
  updateListenersCleanup = [];
});

function handleSaveAndClose() {
  emit('save-settings');
  emit('close');
}

async function loadAppVersion() {
  const res = await getAppVersion();
  if (res.success && res.data) appVersion.value = res.data;
}

function setupUpdateListeners() {
  if (typeof window === 'undefined' || !window.api?.on) return;
  updateListenersCleanup = [
    window.api.on('update-checking', () => {
      updateStatus.value = 'checking';
      updateStatusMessage.value = '';
      updateDownloadPercent.value = null;
    }),
    window.api.on('update-available', (payload: { version?: string }) => {
      updateStatus.value = 'available';
      updateStatusMessage.value = t('settings.updateAvailable', {
        version: payload?.version ?? '',
      });
      updateDownloadPercent.value = null;
    }),
    window.api.on('update-not-available', () => {
      updateStatus.value = 'not-available';
      updateStatusMessage.value = t('settings.noUpdateAvailable');
      updateDownloadPercent.value = null;
    }),
    window.api.on('update-download-progress', (payload: { percent?: number }) => {
      updateStatus.value = 'downloading';
      updateDownloadPercent.value = payload?.percent ?? null;
    }),
    window.api.on('update-downloaded', () => {
      updateStatus.value = 'ready';
      updateStatusMessage.value = t('settings.updateReady');
      updateDownloadPercent.value = null;
    }),
    window.api.on('update-error', (payload: { message?: string }) => {
      updateStatus.value = 'error';
      updateStatusMessage.value = t('settings.updateError', { message: payload?.message ?? '' });
      updateDownloadPercent.value = null;
    }),
  ];
}

async function doCheckForUpdates() {
  if (!updaterEnabled.value) return;
  updateStatus.value = 'checking';
  updateStatusMessage.value = '';
  const res = await checkForUpdates();
  if (!res.success && res.error && updateStatus.value === 'checking') {
    updateStatus.value = 'error';
    updateStatusMessage.value = t('settings.updateError', { message: res.error });
  }
}

async function doQuitAndInstall() {
  const res = await quitAndInstall();
  if (!res.success && res.error) {
    updateStatusMessage.value = res.error;
  }
}

watch(
  () => props.show,
  async val => {
    if (val) {
      const res = await getUserDataPath();
      if (res.success && res.path) userDataPath.value = res.path;
      if (updaterEnabled.value) {
        await loadAppVersion();
        setupUpdateListeners();
      }
    } else {
      updateListenersCleanup.forEach(fn => fn());
      updateListenersCleanup = [];
    }
  }
);

async function openProgramFolder() {
  const res = await openUserDataFolder();
  if (!res.success && res.error) {
    console.error('Error abriendo carpeta del programa:', res.error);
  }
}

const DONATE_URL = 'https://myrient.erista.me/donate/';

async function openDonateLink() {
  const res = await openExternalUrl(DONATE_URL);
  if (!res.success && res.error) {
    console.error('Error abriendo enlace de donación:', res.error);
  }
}
</script>

<!-- Sin estilos - usa style.css global -->
