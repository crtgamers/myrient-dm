/**
 * @fileoverview Punto de entrada del frontend Vue
 * @module src/main
 *
 * Orden de arranque:
 * 1. Resolver idioma inicial (guardado > sistema > en) y cargar mensajes i18n.
 * 2. Crear app Vue, registrar plugin i18n, configurar handlers globales y montar.
 */

import { createApp } from 'vue';
import App from './App.vue';
import logger from './utils/logger';
import { showErrorToast } from './utils/errorHandler';
import { getAppLocale, readConfigFile } from './services/api';
import { DEFAULT_LOCALE } from './locales';
import { resolveInitialLocale, setAppLocale, i18n } from './plugins/i18n';
import './style.css';

const vueLogger = logger.child('Vue');

async function resolveAndSetInitialLocale(): Promise<void> {
  let systemLocale = DEFAULT_LOCALE;
  try {
    if (typeof window !== 'undefined' && window.api) {
      const res = await getAppLocale();
      if (res.success && typeof res.data === 'string') systemLocale = res.data;
    } else if (typeof navigator !== 'undefined') {
      systemLocale = navigator.language || DEFAULT_LOCALE;
    }
  } catch {
    systemLocale =
      typeof navigator !== 'undefined' ? navigator.language || DEFAULT_LOCALE : DEFAULT_LOCALE;
  }

  let savedLocale: string | null = null;
  try {
    const prefs = await readConfigFile('ui-preferences.json');
    if (prefs.success && prefs.data && typeof prefs.data === 'object') {
      const locale = (prefs.data as { locale?: string }).locale;
      if (typeof locale === 'string') savedLocale = locale;
    }
  } catch {
    // Sin preferencia guardada
  }

  const initialLocale = resolveInitialLocale(systemLocale, savedLocale);
  await setAppLocale(initialLocale);
  vueLogger.info('i18n: locale inicial', initialLocale);
}

/** Aplica la clase de tema (light-mode) antes del primer paint para evitar flash. */
async function applyInitialTheme(): Promise<void> {
  try {
    const prefs = await readConfigFile('ui-preferences.json');
    if (prefs.success && prefs.data && typeof prefs.data === 'object') {
      const isDark = (prefs.data as { isDarkMode?: boolean }).isDarkMode;
      if (typeof document !== 'undefined') {
        document.body.classList.toggle('light-mode', isDark === false);
      }
    }
  } catch {
    /* Sin preferencia guardada; se mantiene tema por defecto (dark). */
  }
}

async function bootstrap(): Promise<void> {
  await resolveAndSetInitialLocale();
  await applyInitialTheme();

  const app = createApp(App);
  app.use(i18n);

  app.config.errorHandler = (err: unknown, instance: unknown, info: string): void => {
    vueLogger.error('Error en componente:', err);
    const comp = instance as { $?: { type?: { name?: string } } } | undefined;
    vueLogger.error('Componente:', comp?.$?.type?.name ?? 'Unknown');
    vueLogger.error('Info:', info);

    const t = i18n.global.t.bind(i18n.global);
    let errorTitle = t('errors.componentError');
    let errorMessage = t('errors.componentErrorHint');

    const message = err instanceof Error ? err.message : String(err ?? '');
    const msg = message.toLowerCase();

    if (msg.includes('network') || msg.includes('fetch') || msg.includes('http')) {
      errorTitle = t('errors.connectionError');
      errorMessage = t('errors.connectionErrorHint');
    } else if (msg.includes('timeout')) {
      errorTitle = t('errors.timeout');
      errorMessage = t('errors.timeoutHint');
    } else if (msg.includes('permission') || msg.includes('access')) {
      errorTitle = t('errors.permissionError');
      errorMessage = t('errors.permissionErrorHint');
    } else if (msg.includes('quota') || msg.includes('storage')) {
      errorTitle = t('errors.storageError');
      errorMessage = t('errors.storageErrorHint');
    } else if (msg.includes('cannot read') || msg.includes('undefined') || msg.includes('null')) {
      errorTitle = t('errors.dataError');
      errorMessage = t('errors.dataErrorHint');
    } else if (message) {
      errorMessage = `Error: ${message.substring(0, 150)}${message.length > 150 ? '...' : ''}`;
    }

    showErrorToast({
      title: errorTitle,
      message: errorMessage,
      type: 'error',
      duration: 8000,
    });
  };

  app.config.warnHandler = (msg: string, _instance: unknown, trace?: string): void => {
    vueLogger.warn('Advertencia:', msg);
    if (trace) vueLogger.warn('Trace:', trace);
  };

  app.mount('#app');
  vueLogger.info('Aplicación montada correctamente');

  setTimeout(() => {
    logger.initBackendListener();
  }, 100);
}

bootstrap().catch(err => {
  vueLogger.error('Error en arranque:', err);
});
