/**
 * @fileoverview Plugin de internacionalización (vue-i18n)
 * @module plugins/i18n
 *
 * Inicializa vue-i18n con:
 * - legacy: false (Composition API)
 * - Fallback en cadena: es-CL → es → en
 * - Carga lazy de mensajes por idioma
 *
 * El idioma inicial se resuelve en main.ts antes de montar la app:
 * 1. Idioma guardado por el usuario (ui-preferences.json)
 * 2. Idioma del sistema (Electron app.getLocale() o navigator.language)
 * 3. Por defecto: es (idioma principal del proyecto)
 */

import { createI18n } from 'vue-i18n';
import type { MessageSchema } from '../locales/schema';
import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE_MAP,
  type SupportedLocale,
  resolveSupportedLocale,
  loadLocaleMessages,
} from '../locales';

// Opciones con aserción para permitir messages vacío (carga lazy); los genéricos dan tipado fuerte a t() y locales
const i18n = createI18n<{ message: MessageSchema }, SupportedLocale, false>({
  legacy: false,
  locale: DEFAULT_LOCALE,
  fallbackLocale: FALLBACK_LOCALE_MAP as Record<string, string | readonly string[]>,
  messages: {},
  missingWarn: false,
  fallbackWarn: false,
} as any);

/**
 * Resuelve el locale inicial: guardado > sistema > es.
 * Debe llamarse antes de app.mount().
 *
 * @param systemLocale - Código del sistema (app.getLocale() o navigator.language)
 * @param savedLocale - Código guardado en ui-preferences (opcional)
 */
export function resolveInitialLocale(
  systemLocale: string,
  savedLocale?: string | null
): SupportedLocale {
  if (savedLocale && savedLocale.trim()) {
    return resolveSupportedLocale(savedLocale);
  }
  return resolveSupportedLocale(systemLocale);
}

/**
 * Inicializa el idioma de la app: carga mensajes del locale y lo activa.
 * Si el locale ya está cargado, solo lo activa.
 */
export async function setAppLocale(locale: SupportedLocale): Promise<void> {
  const global = i18n.global;
  if (!global.availableLocales.includes(locale)) {
    const messages = await loadLocaleMessages(locale);
    global.setLocaleMessage(locale, messages as MessageSchema);
  }
  global.locale.value = locale;
}

/**
 * Obtiene el locale actual (reactivo).
 */
export function getCurrentLocale(): SupportedLocale {
  return i18n.global.locale.value as SupportedLocale;
}

export { i18n };
export default i18n;
