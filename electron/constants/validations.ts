/**
 * @fileoverview Constantes de validación: límites numéricos y mensajes de error de validación.
 * @module constants/validations
 *
 * Usado en schemas Zod, utils/validation y en consultas a la BD (búsqueda, ID, título, ruta, nombre de archivo).
 */

// =====================
// LÍMITES NUMÉRICOS
// =====================

/** Longitud máxima de nombre de archivo (estándar en muchos sistemas de archivos). */
export const MAX_FILENAME_LENGTH = 255;

/** Longitud máxima de término de búsqueda (consistente con BD y validación). */
export const MAX_SEARCH_TERM_LENGTH = 100;

/** Longitud máxima de nombre de tabla SQLite (límite razonable para FTS). */
export const MAX_TABLE_NAME_LENGTH = 64;

// =====================
// VALIDACIONES DE BÚSQUEDA
// =====================

const SEARCH_VALIDATIONS: Record<string, string> = {
  TERM_MIN_LENGTH: 'El término de búsqueda debe tener al menos 2 caracteres',
  TERM_MAX_LENGTH: 'El término de búsqueda es demasiado largo',
};

// =====================
// VALIDACIONES DE ID
// =====================

const ID_VALIDATIONS: Record<string, string> = {
  MUST_BE_INTEGER: 'El ID debe ser un número entero',
  MUST_BE_POSITIVE: 'El ID debe ser positivo',
  DOWNLOAD_MUST_BE_INTEGER: 'El ID de descarga debe ser un número entero',
  DOWNLOAD_MUST_BE_POSITIVE: 'El ID de descarga debe ser positivo',
  DOWNLOAD_MUST_BE_POSITIVE_ALT: 'El ID debe ser un numero positivo',
};

// =====================
// VALIDACIONES DE TÍTULO
// =====================

const TITLE_VALIDATIONS: Record<string, string> = {
  CANNOT_BE_EMPTY: 'El título no puede estar vacío',
  TOO_LONG: 'El título es demasiado largo (máximo 500 caracteres)',
};

// =====================
// VALIDACIONES DE RUTA
// =====================

const PATH_VALIDATIONS: Record<string, string> = {
  TOO_LONG: 'La ruta es demasiado larga',
  NOT_A_DIRECTORY: 'La ruta existe pero no es un directorio',
};

// =====================
// VALIDACIONES DE ARCHIVO
// =====================

const FILE_VALIDATIONS: Record<string, string> = {
  FILENAME_CANNOT_BE_EMPTY: 'El nombre de archivo no puede estar vacío',
  FILENAME_TOO_LONG: 'El nombre de archivo es demasiado largo',
  FILENAME_INVALID_FORMAT:
    'El nombre de archivo debe terminar en .json y solo contener letras, números, guiones y guiones bajos',
};

// =====================
// VALIDACIONES DE DATOS
// =====================

const DATA_VALIDATIONS: Record<string, string> = {
  MUST_BE_SERIALIZABLE: 'Los datos deben ser serializables a JSON',
};

// =====================
// VALIDACIONES GENÉRICAS
// =====================

const GENERIC_VALIDATIONS: Record<string, string> = {
  VALIDATION_ERROR: 'Error de validación',
};

// =====================
// EXPORTACIÓN
// =====================

export interface ValidationsLimits {
  MAX_FILENAME_LENGTH: number;
  MAX_SEARCH_TERM_LENGTH: number;
  MAX_TABLE_NAME_LENGTH: number;
}

/** Objeto unificado de validaciones por categoría y LIMITS con valores numéricos. */
export const VALIDATIONS = {
  SEARCH: SEARCH_VALIDATIONS,
  ID: ID_VALIDATIONS,
  TITLE: TITLE_VALIDATIONS,
  PATH: PATH_VALIDATIONS,
  FILE: FILE_VALIDATIONS,
  DATA: DATA_VALIDATIONS,
  GENERIC: GENERIC_VALIDATIONS,
  LIMITS: {
    MAX_FILENAME_LENGTH,
    MAX_SEARCH_TERM_LENGTH,
    MAX_TABLE_NAME_LENGTH,
  } as ValidationsLimits,
};

export {
  SEARCH_VALIDATIONS,
  ID_VALIDATIONS,
  TITLE_VALIDATIONS,
  PATH_VALIDATIONS,
  FILE_VALIDATIONS,
  DATA_VALIDATIONS,
  GENERIC_VALIDATIONS,
};
