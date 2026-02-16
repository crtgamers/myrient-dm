<template>
  <div class="sidebar-wrapper">
    <!-- Overlay en XS: cierra el drawer al hacer clic -->
    <div
      v-if="isDrawerMode && drawerOpen"
      class="sidebar-drawer-overlay"
      aria-hidden="true"
      @click="$emit('close-drawer')"
    />
    <aside
      class="sidebar glass-effect"
      :class="{
        'sidebar--collapsed': isSidebarCollapsed,
        'sidebar--drawer-mode': isDrawerMode,
        'sidebar--drawer-open': drawerOpen,
      }"
      @mouseenter="isHovered = true"
      @mouseleave="isHovered = false"
    >
      <div class="sidebar__header">
        <button
          type="button"
          class="sidebar__logo"
          :title="t('nav.toggleMenu')"
          :aria-label="t('nav.openMenu')"
          @click="toggleSidebar"
        >
          <div class="sidebar__logo-icon">
            <img
              src="/logo.svg"
              alt=""
              class="sidebar__logo-img"
            />
          </div>
          <transition name="sidebar-text">
            <div
              v-if="!isSidebarCollapsed"
              class="sidebar__logo-text"
            >
              <span class="sidebar__logo-main">{{ t('app.name') }}</span>
              <span class="sidebar__logo-sub">{{ t('app.subtitle') }}</span>
            </div>
          </transition>
        </button>
      </div>

      <nav class="sidebar__nav">
        <div class="sidebar__nav-section">
          <div class="sidebar__section-header">
            <transition name="sidebar-text">
              <span
                v-if="!isSidebarCollapsed"
                class="sidebar__section-title"
                >{{ t('nav.main') }}</span
              >
            </transition>
          </div>
          <button
            class="sidebar__nav-item"
            :class="{ 'sidebar__nav-item--active': currentView === 'explore' }"
            :aria-label="currentView === 'explore' ? t('nav.home') : t('nav.explore')"
            :title="
              isSidebarCollapsed
                ? currentView === 'explore'
                  ? t('nav.home')
                  : t('nav.explore')
                : ''
            "
            @click="$emit('navigate', 'explore')"
          >
            <div class="sidebar__nav-icon">
              <Home
                :size="20"
                aria-hidden="true"
              />
            </div>
            <transition name="sidebar-text">
              <span
                v-if="!isSidebarCollapsed"
                class="sidebar__nav-label"
                >{{ currentView === 'explore' ? t('nav.home') : t('nav.explore') }}</span
              >
            </transition>
          </button>
          <button
            class="sidebar__nav-item"
            :class="{ 'sidebar__nav-item--active': currentView === 'favorites' }"
            :aria-label="t('nav.favorites')"
            :title="isSidebarCollapsed ? t('nav.favorites') : ''"
            @click="$emit('navigate', 'favorites')"
          >
            <div class="sidebar__nav-icon">
              <Star
                :size="20"
                aria-hidden="true"
              />
            </div>
            <transition name="sidebar-text">
              <span
                v-if="!isSidebarCollapsed"
                class="sidebar__nav-label"
                >{{ t('nav.favorites') }}</span
              >
            </transition>
          </button>
        </div>

        <div class="sidebar__nav-section">
          <div class="sidebar__section-header">
            <transition name="sidebar-text">
              <span
                v-if="!isSidebarCollapsed"
                class="sidebar__section-title"
                >{{ t('nav.transfers') }}</span
              >
            </transition>
          </div>
          <button
            class="sidebar__nav-item"
            :class="{ 'sidebar__nav-item--active': currentView === 'downloads' }"
            :aria-label="t('nav.queue')"
            :title="isSidebarCollapsed ? t('nav.queue') : ''"
            @click="$emit('navigate', 'downloads')"
          >
            <div class="sidebar__nav-icon">
              <DownloadCloud
                :size="20"
                aria-hidden="true"
              />
              <span
                v-if="activeDownloadCount > 0 && isSidebarCollapsed"
                class="sidebar__nav-badge sidebar__nav-badge--mini"
              >
                {{ activeDownloadCount }}
              </span>
            </div>
            <transition name="sidebar-text">
              <span
                v-if="!isSidebarCollapsed"
                class="sidebar__nav-label"
                >{{ t('nav.queue') }}</span
              >
            </transition>
            <span
              v-if="activeDownloadCount > 0 && !isSidebarCollapsed"
              class="sidebar__nav-badge"
            >
              {{ activeDownloadCount }}
            </span>
          </button>
        </div>

        <div class="sidebar__nav-section">
          <div class="sidebar__section-header">
            <transition name="sidebar-text">
              <span
                v-if="!isSidebarCollapsed"
                class="sidebar__section-title"
                >{{ t('nav.system') }}</span
              >
            </transition>
          </div>
          <button
            class="sidebar__nav-item"
            :aria-label="t('nav.logsConsole')"
            :title="isSidebarCollapsed ? t('nav.logsConsole') : ''"
            @click="$emit('open-logs')"
          >
            <div class="sidebar__nav-icon">
              <Terminal
                :size="20"
                aria-hidden="true"
              />
            </div>
            <transition name="sidebar-text">
              <span
                v-if="!isSidebarCollapsed"
                class="sidebar__nav-label"
                >{{ t('nav.logsConsole') }}</span
              >
            </transition>
          </button>
          <button
            class="sidebar__nav-item"
            :aria-label="t('nav.settings')"
            :title="isSidebarCollapsed ? t('nav.settings') : ''"
            @click="$emit('open-settings')"
          >
            <div class="sidebar__nav-icon">
              <Settings
                :size="20"
                aria-hidden="true"
              />
            </div>
            <transition name="sidebar-text">
              <span
                v-if="!isSidebarCollapsed"
                class="sidebar__nav-label"
                >{{ t('nav.settings') }}</span
              >
            </transition>
          </button>
        </div>
      </nav>

      <div class="sidebar__footer">
        <div
          class="sidebar__status"
          :title="isSidebarCollapsed ? t('nav.connectedToMyrient') : ''"
        >
          <div class="sidebar__status-indicator sidebar__status-indicator--online"></div>
          <transition name="sidebar-text">
            <span
              v-if="!isSidebarCollapsed"
              class="sidebar__status-text"
              >{{ t('nav.connectedToMyrient') }}</span
            >
          </transition>
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { Home, Star, DownloadCloud, Terminal, Settings } from 'lucide-vue-next';

const { t } = useI18n();
const props = defineProps({
  currentView: {
    type: String,
    default: 'explore',
  },
  activeDownloadCount: {
    type: Number,
    default: 0,
  },
  /** En breakpoint S o menor (ancho &lt; 961px) el sidebar se mantiene colapsado para liberar espacio */
  narrowViewport: {
    type: Boolean,
    default: false,
  },
  /** En XS (≤640px): modo drawer (overlay); el sidebar se muestra como panel deslizante */
  isDrawerMode: {
    type: Boolean,
    default: false,
  },
  /** En modo drawer: true = visible (abierto), false = oculto */
  drawerOpen: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(['navigate', 'open-logs', 'open-settings', 'close-drawer']);

const isPermanentlyCollapsed = ref(true); // Por defecto cerrado como pidió el usuario
const isHovered = ref(false);

const isSidebarCollapsed = computed(() => {
  if (props.isDrawerMode && props.drawerOpen) return false;
  if (props.narrowViewport) return true;
  return isPermanentlyCollapsed.value && !isHovered.value;
});

const toggleSidebar = () => {
  isPermanentlyCollapsed.value = !isPermanentlyCollapsed.value;
};

// Cerrar drawer con Escape (accesibilidad teclado)
function handleDrawerKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.isDrawerMode && props.drawerOpen) {
    emit('close-drawer');
  }
}

watch(
  () => props.drawerOpen && props.isDrawerMode,
  isOpen => {
    if (isOpen) {
      document.addEventListener('keydown', handleDrawerKeydown);
    } else {
      document.removeEventListener('keydown', handleDrawerKeydown);
    }
  },
  { immediate: true }
);

onUnmounted(() => {
  document.removeEventListener('keydown', handleDrawerKeydown);
});
</script>

<style scoped>
/* Slot fijo: ancho siempre colapsado para que main.content-area no se mueva (CLS). Expandido = overlay. */
.sidebar-wrapper {
  flex-shrink: 0;
  width: var(--sidebar-collapsed-width);
  min-width: var(--sidebar-collapsed-width);
}

.sidebar-wrapper:has(.sidebar.sidebar--drawer-mode) {
  width: 0;
  min-width: 0;
  overflow: visible;
}

.sidebar-drawer-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-bg);
  z-index: 399;
  cursor: pointer;
}

.sidebar {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  z-index: 100;
  border-right: 0.0625rem solid var(--border-color);
  overflow: hidden;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  contain: layout;
}

/* No drawer: siempre fixed para evitar salto de 1 frame al expandir; ancho con transición */
.sidebar:not(.sidebar--drawer-mode) {
  position: fixed;
  left: 0;
  top: var(--titlebar-height);
  bottom: 0;
  height: auto; /* entre top y bottom; evita que height:100% (100vh) empuje el footer fuera */
  z-index: 400;
  transition: width 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.sidebar:not(.sidebar--drawer-mode).sidebar--collapsed {
  width: var(--sidebar-collapsed-width);
}

.sidebar:not(.sidebar--drawer-mode):not(.sidebar--collapsed) {
  width: var(--sidebar-width);
  box-shadow: 0.25rem 0 1.25rem var(--overlay-bg-20);
}

.sidebar.sidebar--drawer-mode {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  width: var(--sidebar-width);
  height: 100%;
  transform: translateX(-100%);
  z-index: 400;
  transition: transform 0.2s ease;
  box-shadow: 0.25rem 0 1.25rem var(--overlay-bg-20);
}

.sidebar.sidebar--drawer-mode.sidebar--drawer-open {
  transform: translateX(0);
}

.sidebar.sidebar--collapsed .sidebar__header {
  padding-left: var(--spacing-sm);
  padding-right: var(--spacing-sm);
  gap: 0.25rem;
}

.sidebar.sidebar--collapsed .sidebar__nav-item {
  padding: 0.125rem;
}

.sidebar__header {
  padding: var(--spacing-lg) var(--spacing-md);
  height: 6.25rem;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.sidebar__logo {
  position: relative;
  display: flex;
  align-items: center;
  cursor: pointer;
  transition: all 0.2s;
  width: 100%;
  min-width: 2.75rem; /* Reserva espacio del icono para reducir CLS al colapsar */
  overflow: hidden;
  /* Reset botón para mantener apariencia y accesibilidad por teclado */
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
}

.sidebar__logo-icon {
  width: 2.75rem;
  height: 2.75rem;
  background: var(--primary-color);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-lg);
  box-shadow: var(--primary-glow);
  flex-shrink: 0;
  margin-left: 0.625rem;
}

.sidebar__logo-icon .sidebar__logo-img {
  width: 1.5rem;
  height: 1.5rem;
  object-fit: contain;
  /* Logo blanco: mismo filtro que InitializationScreen e index.html */
  filter: brightness(0) invert(1);
}

.sidebar__logo-text {
  display: flex;
  flex-direction: column;
  white-space: nowrap;
  margin-left: 0.875rem;
}

.sidebar__logo-main {
  font-weight: 900;
  font-size: var(--text-lg);
  letter-spacing: 0.0625rem;
  color: var(--text-primary);
  line-height: 1;
}

.sidebar__logo-sub {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.03125rem;
  color: var(--text-muted);
  font-weight: 600;
}

.sidebar__nav {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--spacing-md);
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  scrollbar-width: thin;
  scrollbar-color: var(--bg-tertiary) transparent;
}

/* Mismo estilo que las barras deslizantes globales (cuando la barra colapsada muestra scroll vertical) */
.sidebar__nav::-webkit-scrollbar {
  width: 0.625rem;
}

.sidebar__nav::-webkit-scrollbar-track {
  background: transparent;
}

.sidebar__nav::-webkit-scrollbar-thumb {
  background: var(--bg-tertiary);
  border: 3px solid transparent;
  background-clip: content-box;
  border-radius: var(--radius-full);
  transition: background 0.1s;
}

.sidebar__nav::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
  border: 2px solid transparent;
  background-clip: content-box;
}

.sidebar__nav-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.sidebar__section-header {
  position: relative;
  height: 1rem;
  display: flex;
  align-items: center;
  margin-bottom: var(--spacing-sm);
  overflow: hidden;
}

.sidebar__section-title {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.09375rem;
  color: var(--text-muted);
  font-weight: 800;
  padding-left: 0.875rem;
  white-space: nowrap;
  overflow: hidden;
}

.sidebar__nav-item {
  display: flex;
  align-items: center;
  padding: 0.625rem;
  min-height: 3.5rem; /* Evita CLS cuando el label hace leave con position:absolute */
  border-radius: var(--radius-lg);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-weight: 600;
  font-size: var(--text-base);
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  text-align: left;
  white-space: nowrap;
  width: 100%;
  position: relative;
  overflow: hidden;
}

.sidebar__nav-icon {
  width: 2.75rem;
  height: 2.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  position: relative;
}

.sidebar__nav-label {
  margin-left: 0.625rem;
  white-space: nowrap;
  overflow: hidden;
}

.sidebar__nav-item:hover {
  background: var(--bg-tertiary);
  color: var(--primary-color);
}

.sidebar__nav-item:hover .sidebar__nav-icon {
  transform: scale(1.1);
}

.sidebar__nav-item--active {
  background: var(--primary-color-alpha);
  color: var(--primary-color);
}

.sidebar__nav-item--active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 20%;
  height: 60%;
  width: 0.25rem;
  background: var(--primary-color);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

.sidebar__nav-badge {
  margin-left: auto;
  background: var(--primary-color);
  color: white;
  font-size: var(--text-xs);
  font-weight: 800;
  padding: 0.125rem var(--spacing-sm);
  border-radius: var(--radius-full);
}

.sidebar__nav-badge--mini {
  position: absolute;
  top: 0;
  right: 0.375rem;
  width: 1rem;
  height: 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-size: 0.5625rem;
  border: 0.125rem solid var(--bg-main);
  box-shadow: 0 0.125rem 0.25rem var(--overlay-bg-20);
  z-index: 5;
}

.sidebar__footer {
  padding: var(--spacing-lg) 1.25rem;
  border-top: 0.0625rem solid var(--border-color);
}

.sidebar__status {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.6875rem;
  color: var(--text-muted);
  font-weight: 600;
  white-space: nowrap;
  height: 1.5rem;
}

.sidebar__status-indicator {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  flex-shrink: 0;
  margin-left: var(--spacing-xs);
}

.sidebar__status-indicator--online {
  background: var(--success-color);
  box-shadow: 0 0 0.625rem var(--success-color);
}

/* Solo opacity para evitar CLS (sin cambiar ancho/position en layout) */
.sidebar-text-enter-active {
  transition: opacity 0.2s ease-out;
}

.sidebar-text-leave-active {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  visibility: hidden;
  transition: opacity 0.2s ease-out;
}

.sidebar-text-enter-from,
.sidebar-text-leave-to {
  opacity: 0;
}

.sidebar-text-enter-to,
.sidebar-text-leave-from {
  opacity: 1;
}
</style>
