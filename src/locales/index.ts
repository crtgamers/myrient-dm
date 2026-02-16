/**
 * @fileoverview Sistema de internacionalización (i18n)
 * @module locales
 *
 * Estructura pensada para contribuidores:
 * - Cada idioma tiene su carpeta (en, es, es-CL) con common.json.
 * - Para añadir un idioma: copiar en/common.json a <código>/common.json y traducir.
 * - Claves semánticas (ej: common.errors.connectionError), no frases como key.
 * - Fallback: es-CL → es → en; es → en; en → en. Por defecto: es.
 */

/** Idioma por defecto cuando no hay preferencia guardada ni coincidencia con el sistema (español como idioma principal del proyecto). */
export const DEFAULT_LOCALE = 'es';

/** Idiomas soportados (códigos BCP 47). Orden: español primero, luego inglés. */
export const SUPPORTED_LOCALES = ['es', 'es-CL', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Etiquetas para mostrar en el selector de idioma (nombre del idioma en su propio idioma). */
export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  es: 'Español',
  'es-CL': 'Español (Chile)',
};

/**
 * Cadena de fallback por locale: si falta una key en el locale activo, se prueba en orden.
 * es-CL → es → en; es → en; en → en.
 */
export const FALLBACK_LOCALE_MAP: Record<
  SupportedLocale,
  SupportedLocale | readonly SupportedLocale[]
> = {
  en: 'en',
  es: 'en',
  'es-CL': ['es', 'en'],
};

/**
 * Normaliza un código de idioma del sistema (ej: en-US, es-CL) al código base
 * o variante soportada. No cambia el caso.
 */
export function normalizeLocale(code: string): string {
  const trimmed = (code || '').trim();
  if (!trimmed) return DEFAULT_LOCALE;
  const normalized = trimmed.replace(/_/g, '-');
  return normalized;
}

/**
 * Resuelve el locale a uno soportado, con fallback en cadena.
 * Prioridad: si está en SUPPORTED_LOCALES se usa; si no, se prueba el idioma base (es-AR → es).
 */
export function resolveSupportedLocale(locale: string): SupportedLocale {
  const n = normalizeLocale(locale);
  if (n === 'en' || n.startsWith('en-')) return 'en';
  if (n === 'es-CL') return 'es-CL';
  if (n === 'es' || n.startsWith('es-')) return 'es';
  return DEFAULT_LOCALE;
}

/**
 * Map estático de cargadores por path (Vite requiere rutas estáticas en build).
 * Uso: loadLocaleMessages('es') -> modules['./es/common.json']().
 */
const localeModules = import.meta.glob<{ default: Record<string, unknown> }>('./*/common.json');

/**
 * Carga los mensajes de un idioma (lazy load).
 * Los mensajes se cargan desde src/locales/<locale>/common.json.
 */
export async function loadLocaleMessages(
  locale: SupportedLocale
): Promise<Record<string, unknown>> {
  const path = `./${locale}/common.json`;
  const loader = localeModules[path];
  if (!loader) {
    console.warn(
      `[i18n] No loader for locale "${locale}" (path: ${path}), falling back to ${DEFAULT_LOCALE}`
    );
    if (locale === DEFAULT_LOCALE) return {};
    return loadLocaleMessages(DEFAULT_LOCALE);
  }
  try {
    const module = await loader();
    return (module.default ?? module) as Record<string, unknown>;
  } catch (err) {
    console.error(`[i18n] Failed to load locale "${locale}":`, err);
    if (locale === DEFAULT_LOCALE) return {};
    return loadLocaleMessages(DEFAULT_LOCALE);
  }
}
