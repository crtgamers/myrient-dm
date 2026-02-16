<template>
  <div
    id="titlebar"
    class="titlebar glass-effect"
  >
    <div class="titlebar-content">
      <!-- En XS (≤640px): botón menú para abrir sidebar como drawer -->
      <button
        v-if="showDrawerToggle"
        class="back-btn menu-drawer-btn"
        :title="t('titlebar.openMenu')"
        :aria-label="t('nav.openMenu')"
        @click="$emit('open-drawer')"
      >
        <Menu :size="20" />
      </button>
      <button
        v-else-if="!isAtRoot"
        class="back-btn"
        :title="t('titlebar.back')"
        :aria-label="t('titlebar.backToParent')"
        @click="$emit('go-back')"
      >
        <ChevronLeft :size="20" />
      </button>

      <!-- Indicador de velocidad: clic abre panel de estadísticas -->
      <button
        type="button"
        class="speed-indicator glass-effect speed-indicator-btn"
        :class="{ 'has-active': activeDownloadCount > 0 }"
        :aria-label="
          activeDownloadCount > 0
            ? t('titlebar.speedIndicator', {
                name: currentDownloadName || t('downloads.downloading'),
                speed: averageDownloadSpeed.toFixed(2),
                count: activeDownloadCount,
              })
            : t('titlebar.viewStatistics')
        "
        :title="
          activeDownloadCount > 0
            ? t('titlebar.speedIndicator', {
                name: currentDownloadName || t('downloads.downloading'),
                speed: averageDownloadSpeed.toFixed(2),
                count: activeDownloadCount,
              }) +
              ' — ' +
              t('titlebar.viewStatistics')
            : t('titlebar.viewStatistics')
        "
        @click="$emit('open-statistics')"
      >
        <ArrowDownCircle
          :size="16"
          class="speed-icon"
          :class="{ pulse: activeDownloadCount > 0 }"
        />
        <div
          v-if="activeDownloadCount > 0"
          class="speed-info"
        >
          <span class="download-name scrolling-text">{{
            currentDownloadName || t('downloads.downloading')
          }}</span>
          <span class="speed-value">{{ averageDownloadSpeed.toFixed(2) }} MB/s</span>
        </div>
        <div
          v-else
          class="speed-info"
        >
          <span class="download-name">{{ t('titlebar.viewStatistics') }}</span>
          <span class="speed-value">0.00 MB/s</span>
        </div>
      </button>
    </div>

    <div class="brand">
      <span class="titlebar-title">{{ t('app.name') }}</span>
      <span class="titlebar-subtitle">{{ t('app.subtitle') }}</span>
    </div>

    <div class="titlebar-controls">
      <!-- Botones de control -->
      <button
        class="titlebar-btn theme-btn"
        :title="isDarkMode ? t('settings.lightMode') : t('settings.darkMode')"
        :aria-label="isDarkMode ? t('settings.switchToLight') : t('settings.switchToDark')"
        :aria-pressed="isDarkMode"
        @click="$emit('toggle-theme')"
      >
        <Sun
          v-if="isDarkMode"
          :size="18"
        />
        <Moon
          v-else
          :size="18"
        />
      </button>

      <button
        class="titlebar-btn logs-btn"
        :title="t('titlebar.logs')"
        :aria-label="t('settings.openLogs')"
        @click="$emit('open-logs')"
      >
        <Terminal :size="18" />
      </button>

      <button
        class="titlebar-btn settings-btn"
        :title="t('nav.settings')"
        :aria-label="t('titlebar.openSettings')"
        @click="$emit('open-settings')"
      >
        <Settings :size="18" />
      </button>

      <div class="window-actions">
        <button
          class="titlebar-btn window-btn minimize-btn"
          :title="t('common.minimize')"
          :aria-label="t('titlebar.minimizeWindow')"
          @click="minimizeWindow"
        >
          <Minus :size="16" />
        </button>

        <button
          class="titlebar-btn window-btn maximize-btn"
          :title="isMaximized ? t('common.restore') : t('common.maximize')"
          :aria-label="isMaximized ? t('titlebar.restoreWindow') : t('titlebar.maximizeWindow')"
          @click="maximizeWindow"
        >
          <Maximize2
            v-if="!isMaximized"
            :size="14"
          />
          <Minimize2
            v-else
            :size="14"
          />
        </button>

        <button
          class="titlebar-btn window-btn close-btn"
          :title="t('common.close')"
          :aria-label="t('titlebar.closeWindow')"
          @click="closeWindow"
        >
          <X :size="16" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  ChevronLeft,
  Menu,
  ArrowDownCircle,
  Sun,
  Moon,
  Terminal,
  Settings,
  Minus,
  Maximize2,
  Minimize2,
  X,
} from 'lucide-vue-next';
import {
  minimizeWindow as apiMinimize,
  maximizeWindow as apiMaximize,
  closeWindow as apiClose,
  getWindowIsMaximized,
} from '../../services/api';

const { t } = useI18n();

// Props (usados en template)
defineProps({
  isAtRoot: {
    type: Boolean,
    default: true,
  },
  locationPath: {
    type: String,
    default: '',
  },
  isDarkMode: {
    type: Boolean,
    default: true,
  },
  activeDownloadCount: {
    type: Number,
    default: 0,
  },
  currentDownloadName: {
    type: String,
    default: '',
  },
  averageDownloadSpeed: {
    type: Number,
    default: 0,
  },
  /** En XS (≤640px): mostrar botón para abrir sidebar como drawer */
  showDrawerToggle: {
    type: Boolean,
    default: false,
  },
});

// Emits
defineEmits([
  'go-back',
  'toggle-theme',
  'open-settings',
  'open-logs',
  'open-drawer',
  'open-statistics',
]);

// Estado local
const isMaximized = ref(false);

// Métodos de ventana
const minimizeWindow = () => {
  apiMinimize();
};

const maximizeWindow = () => {
  apiMaximize();
  isMaximized.value = !isMaximized.value;
};

const closeWindow = () => {
  apiClose();
};

onMounted(() => {
  setTimeout(() => {
    getWindowIsMaximized().then(maximized => {
      isMaximized.value = maximized;
    });
  }, 150);
});
</script>

<!-- Sin estilos - usa style.css global -->
