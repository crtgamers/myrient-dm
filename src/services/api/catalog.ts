/**
 * API de catálogo: carga de DB, búsqueda, hijos, ancestros, nodo, fecha de actualización.
 * @module api/catalog
 */

import { getApi, apiLogger, API_ERRORS, GENERAL_ERRORS } from './internal';
import type { APIResponse } from './types';
import type { SearchOptions } from '../../types/preload';

export type CatalogSource = 'myrient' | 'lolroms';

/**
 * Carga la base de datos del catálogo indicado (Myrient o LoLROMs).
 * @param source - 'myrient' o 'lolroms'
 * @returns Respuesta con success; error si falla.
 */
export async function loadDatabase(source: CatalogSource): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return (await api.loadDatabase(source)) as APIResponse<unknown>;
  } catch (error) {
    apiLogger.error('Error cargando base de datos:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Cierra la base de datos del catálogo actual (vuelve a pantalla de inicio).
 */
export async function closeDatabase(): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return (await api.closeDatabase()) as APIResponse<unknown>;
  } catch (error) {
    apiLogger.error('Error cerrando base de datos:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Obtiene la fuente de catálogo actualmente cargada (null si ninguna).
 */
export async function getCurrentSource(): Promise<APIResponse<CatalogSource | null>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    const res = (await api.getCurrentSource()) as APIResponse<CatalogSource | null>;
    return res;
  } catch (error) {
    apiLogger.error('Error obteniendo fuente actual:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Busca en el catálogo por término (FTS o LIKE según backend).
 * @param term - Término de búsqueda.
 * @param options - Límite, offset, folderLimit, usePrefix, usePhrase, useOR, signal, etc.
 * @returns Respuesta con data (lista de nodos), total y hasMore; error si falla o API no disponible.
 */
export async function search(
  term: string,
  options: SearchOptions = {}
): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return await api.search(term, options);
  } catch (error) {
    apiLogger.error('Error en búsqueda:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Obtiene los hijos de un nodo del catálogo (paginado).
 * @param parentId - ID del nodo padre.
 * @param options - limit y offset para paginación.
 * @returns Respuesta con data (lista de nodos) y total; error si falla.
 */
export async function getChildren(
  parentId: number,
  options: { limit?: number; offset?: number } = {}
): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return await api.getChildren(parentId, options);
  } catch (error) {
    apiLogger.error('Error obteniendo hijos:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Obtiene la ruta de ancestros del nodo (para breadcrumb).
 * @param nodeId - ID del nodo.
 * @returns Respuesta con data (lista de { id, title, name }); error si falla.
 */
export async function getAncestors(nodeId: number): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return await api.getAncestors(nodeId);
  } catch (error) {
    apiLogger.error('Error obteniendo ancestros:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Obtiene información básica del nodo (id, parent_id, name, type).
 * @param nodeId - ID del nodo.
 * @returns Respuesta con data del nodo; error si no existe o falla.
 */
export async function getNodeInfo(nodeId: number): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return await api.getNodeInfo(nodeId);
  } catch (error) {
    apiLogger.error('Error obteniendo info de nodo:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}

/**
 * Obtiene la fecha de actualización del catálogo (modified_date de la raíz de carpetas).
 * @returns Respuesta con data (string de fecha) o error.
 */
export async function getDbUpdateDate(): Promise<APIResponse<unknown>> {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };
  try {
    return await api.getDbUpdateDate();
  } catch (error) {
    apiLogger.error('Error obteniendo fecha de actualización:', error);
    return { success: false, error: (error as Error).message || GENERAL_ERRORS.UNKNOWN };
  }
}
