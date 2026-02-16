/**
 * Funciones puras de normalización para nodos del catálogo.
 *
 * Extraídas de database.ts para mejorar separación de responsabilidades
 * y permitir testing aislado.
 *
 * @module nodeNormalizer
 */

/** Nodo mínimo para normalización (compatible con NodeInfo de database.ts). */
export interface NormalizableNode {
  id: number;
  name?: string;
  title?: string;
  parent_id?: number | null;
  type?: string;
  size_bytes?: number | null;
  size?: string;
  url?: string | null;
  displayTitle?: string;
  breadcrumbPath?: string;
  fullPath?: string;
  modified_date?: number | null;
}

/** Normaliza un tipo crudo (Directory → folder, File → file). */
export function normalizeType(type: string | undefined): string {
  if (!type) return 'file';
  const lowerType = type.toLowerCase();
  if (lowerType === 'directory') return 'folder';
  if (lowerType === 'file') return 'file';
  return lowerType;
}

/** Formatea bytes en unidad legible (B / KiB / MiB / GiB). */
export function formatSize(sizeBytes: number | null | undefined): string {
  if (sizeBytes === null || sizeBytes === undefined) return '-';
  const bytes = Number(sizeBytes);
  if (isNaN(bytes) || bytes < 0) return '-';
  if (bytes === 0) return '0 B';
  const k = 1024;
  if (bytes < k) return `${bytes} B`;
  if (bytes < k * k) return `${(bytes / k).toFixed(1)} KiB`;
  if (bytes < k * k * k) return `${(bytes / (k * k)).toFixed(1)} MiB`;
  return `${(bytes / (k * k * k)).toFixed(1)} GiB`;
}

/**
 * Normaliza un nodo usando la tabla element_paths (pre-calculada).
 */
export function normalizeNodeWithPathsMap(
  item: NormalizableNode,
  pathData: { full_path: string; parent_path: string } | undefined
): NormalizableNode {
  const itemName = (item.name ?? item.title ?? '') as string;
  const cleanTitle = itemName.replace(/\/$/, '');
  const type = normalizeType(item.type);

  let displayTitle = cleanTitle;
  let breadcrumbPath = '';
  let fullPath = '';

  if (pathData) {
    if (type === 'folder') {
      displayTitle = pathData.full_path || cleanTitle;
      breadcrumbPath = (pathData.parent_path || '').replace(/ \/ /g, '/');
    } else {
      fullPath = (pathData.parent_path || '').replace(/ \/ /g, '/');
      displayTitle = cleanTitle;
    }
  }

  const formattedSize =
    item.size_bytes !== undefined ? formatSize(item.size_bytes) : (item.size ?? '-');

  return {
    ...item,
    name: cleanTitle,
    title: cleanTitle,
    displayTitle,
    breadcrumbPath,
    fullPath,
    type,
    size: formattedSize,
  };
}

/**
 * Normaliza un nodo recorriendo el mapa de ancestros (fallback cuando element_paths no está disponible).
 */
export function normalizeNodeWithAncestorMap(
  item: NormalizableNode,
  nodeMap: Map<number, { parent_id: number | null; name: string }>
): NormalizableNode {
  const itemName = (item.name ?? item.title ?? '') as string;
  const cleanTitle = itemName.replace(/\/$/, '');
  const type = normalizeType(item.type);

  let displayTitle = cleanTitle;
  let breadcrumbPath = '';
  let fullPath = '';
  const pathArray: string[] = [];
  let currentId = item.id;

  for (let i = 0; i < 100; i++) {
    const node = nodeMap.get(currentId);
    if (!node) break;
    pathArray.unshift(node.name ?? '');
    if (node.parent_id === 1 || node.parent_id == null) break;
    currentId = node.parent_id;
  }

  if (type === 'folder') {
    displayTitle = pathArray.join(' / ');
    if (pathArray.length > 1) breadcrumbPath = pathArray.slice(0, -1).join('/');
  } else if (type === 'file') {
    if (pathArray.length > 1) fullPath = pathArray.slice(0, -1).join('/');
  }

  const formattedSize =
    item.size_bytes !== undefined ? formatSize(item.size_bytes) : (item.size ?? '-');

  return {
    ...item,
    name: cleanTitle,
    title: cleanTitle,
    displayTitle,
    breadcrumbPath,
    fullPath,
    type,
    size: formattedSize,
  };
}
