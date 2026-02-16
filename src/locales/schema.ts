/**
 * @fileoverview Schema de mensajes i18n para tipado fuerte de keys
 * @module locales/schema
 *
 * Se infiere del idioma base (en) para que t() y $t() solo acepten keys válidas.
 */

import en from './en/common.json';

/** Estructura de mensajes del idioma base (en). Usado como genérico en createI18n. */
export type MessageSchema = typeof en;
