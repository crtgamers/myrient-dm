/**
 * @fileoverview Tipos compartidos para búsqueda (IPC y servicios).
 * @module shared/types/search
 *
 * Fuente única de verdad para SearchOptions. Usado por SearchService (main), API del renderer e IPC.
 */

/**
 * Opciones de búsqueda en el catálogo local (base de datos extraída).
 * Algunos campos solo tienen efecto en el proceso main (folderLimit, includeTotalCount, scopeFolderId(s)).
 */
export interface SearchOptions {
  limit?: number;
  offset?: number;
  usePrefix?: boolean;
  usePhrase?: boolean;
  useOR?: boolean;
  /** Límite de carpetas en resultados (solo main) */
  folderLimit?: number;
  /** Incluir total de resultados (solo main) */
  includeTotalCount?: boolean;
  /** Si se define, limita los resultados a esta carpeta y todo su contenido (carpeta + hijos recursivos) */
  scopeFolderId?: number;
  /** Si se define, limita los resultados a las carpetas indicadas y todo su contenido (p. ej. solo favoritos) */
  scopeFolderIds?: number[];
}
