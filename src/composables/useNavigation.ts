/**
 * @fileoverview Composable para navegación por carpetas en el catálogo
 * @module useNavigation
 *
 * loadChildren: cuando no es raíz, getChildren y getNodeInfo se ejecutan en paralelo (auditoría A2).
 */

import { ref, computed } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import { getChildren, getAncestors, getNodeInfo } from '../services/api';
import logger from '../utils/logger';

export interface CatalogNode {
  id: number;
  title?: string;
  type?: string;
  parent_id?: number;
  [key: string]: unknown;
}

const CHILDREN_PAGE_SIZE = 2000;
/** Al volver a la vista Inicio, mostrar solo los primeros N para evitar congelar la UI. */
const INITIAL_CHILDREN_DISPLAY = 1000;

const currentNodeId = ref(1);
const currentParentId = ref<number | null>(null);
const allChildren = ref<CatalogNode[]>([]);
const totalChildrenCount = ref<number | null>(null);
const loadingMoreChildren = ref(false);
const breadcrumbPath = ref<CatalogNode[]>([]);
const statusMessage = ref('');
/** Key i18n para el mensaje de estado (loading/error). Vacío cuando no hay mensaje. */
const statusMessageKey = ref('');
/** Parámetros para t(statusMessageKey, statusMessageParams). */
const statusMessageParams = ref<Record<string, unknown>>({});
const navigationHistory = ref<number[]>([]);

/**
 * Composable de navegación por el catálogo: nodo actual, hijos, breadcrumb, historial y acciones.
 * @returns Refs y computed (currentNodeId, allChildren, breadcrumbPath, folders, files, …) y funciones (loadChildren, navigateToNode, goToRoot, goBack, initNavigation, …).
 */
export function useNavigation(): {
  currentNodeId: Ref<number>;
  currentParentId: Ref<number | null>;
  allChildren: Ref<CatalogNode[]>;
  breadcrumbPath: Ref<CatalogNode[]>;
  statusMessage: Ref<string>;
  statusMessageKey: Ref<string>;
  statusMessageParams: Ref<Record<string, unknown>>;
  navigationHistory: Ref<number[]>;
  folders: ComputedRef<CatalogNode[]>;
  files: ComputedRef<CatalogNode[]>;
  locationPath: ComputedRef<string>;
  isAtRoot: ComputedRef<boolean>;
  canGoBack: ComputedRef<boolean>;
  hasMoreChildren: ComputedRef<boolean>;
  totalChildrenCount: Ref<number | null>;
  loadChildren: () => Promise<void>;
  loadBreadcrumb: () => Promise<void>;
  loadMoreChildren: () => Promise<void>;
  loadingMoreChildren: Ref<boolean>;
  navigateToNode: (_node: CatalogNode | { id: number }) => Promise<void>;
  navigateToId: (_nodeId: number) => Promise<void>;
  goToRoot: () => Promise<void>;
  goBack: () => Promise<void>;
  goBackInHistory: () => Promise<void>;
  clearHistory: () => void;
  initNavigation: () => Promise<void>;
  collapseToInitialPage: () => void;
} {
  const folders = computed(() => {
    return allChildren.value
      .filter(item => item.type === 'folder')
      .sort((a, b) => (a.title ?? '').toLowerCase().localeCompare((b.title ?? '').toLowerCase()));
  });

  const files = computed(() => {
    return allChildren.value.filter(item => item.type === 'file');
  });

  const locationPath = computed(() => {
    if (breadcrumbPath.value.length === 0) return '';
    return breadcrumbPath.value.map(n => n.title ?? '').join(' / ');
  });

  const isAtRoot = computed(() => currentNodeId.value === 1);

  const canGoBack = computed(() => {
    return currentNodeId.value !== 1 || navigationHistory.value.length > 0;
  });

  const hasMoreChildren = computed(() => {
    const total = totalChildrenCount.value;
    if (total == null) return false;
    return allChildren.value.length < total;
  });

  const loadChildren = async (): Promise<void> => {
    try {
      statusMessage.value = '';
      statusMessageKey.value = 'common.loading';
      statusMessageParams.value = {};
      totalChildrenCount.value = null;

      const nodeId = currentNodeId.value;
      const childrenPromise = getChildren(nodeId, {
        limit: CHILDREN_PAGE_SIZE,
        offset: 0,
      });

      // A2: cuando no estamos en raíz, getNodeInfo no depende de getChildren; ejecutar en paralelo.
      const [response, nodeInfoResponse] =
        nodeId !== 1
          ? await Promise.all([childrenPromise, getNodeInfo(nodeId)])
          : [await childrenPromise, null];

      if (response.success) {
        allChildren.value = (response.data as CatalogNode[]) ?? [];
        const res = response as { total?: number };
        totalChildrenCount.value = res.total ?? allChildren.value.length;

        if (nodeId !== 1 && nodeInfoResponse?.success && nodeInfoResponse?.data) {
          currentParentId.value =
            (nodeInfoResponse.data as { parent_id?: number }).parent_id ?? null;
        } else if (nodeId === 1) {
          currentParentId.value = null;
        }

        await loadBreadcrumb();
        statusMessageKey.value = '';
        statusMessageParams.value = {};
      } else {
        const detail = String(response.error ?? 'Unknown');
        statusMessageKey.value = 'errors.loadContentDetail';
        statusMessageParams.value = { detail };
      }
    } catch (error) {
      const detail = (error as Error).message;
      statusMessageKey.value = 'errors.loadContentDetail';
      statusMessageParams.value = { detail };
      logger.child('Navigation').error('Error cargando hijos', error);
    }
  };

  const loadMoreChildren = async (): Promise<void> => {
    if (!hasMoreChildren.value || loadingMoreChildren.value) return;
    try {
      loadingMoreChildren.value = true;
      const response = await getChildren(currentNodeId.value, {
        limit: CHILDREN_PAGE_SIZE,
        offset: allChildren.value.length,
      });
      if (response.success && Array.isArray(response.data) && response.data.length > 0) {
        allChildren.value = [...allChildren.value, ...(response.data as CatalogNode[])];
      }
    } catch (error) {
      logger.child('Navigation').error('Error cargando más hijos', error);
    } finally {
      loadingMoreChildren.value = false;
    }
  };

  const loadBreadcrumb = async (): Promise<void> => {
    if (currentNodeId.value === 1) {
      breadcrumbPath.value = [];
      return;
    }
    try {
      const response = await getAncestors(currentNodeId.value);
      if (response.success && response.data) {
        breadcrumbPath.value = response.data as CatalogNode[];
      }
    } catch (error) {
      logger.child('Navigation').error('Error cargando breadcrumb', error);
    }
  };

  const navigateToNode = async (node: CatalogNode | { id: number }): Promise<void> => {
    if (!node?.id) {
      logger.child('Navigation').warn('Nodo inválido para navegación', node);
      return;
    }
    if (currentNodeId.value !== node.id) {
      navigationHistory.value.push(currentNodeId.value);
      if (navigationHistory.value.length > 50) {
        navigationHistory.value.shift();
      }
    }
    currentNodeId.value = node.id;
    await loadChildren();
  };

  const navigateToId = async (nodeId: number): Promise<void> => {
    await navigateToNode({ id: nodeId });
  };

  const goToRoot = async (): Promise<void> => {
    if (currentNodeId.value !== 1) {
      navigationHistory.value.push(currentNodeId.value);
    }
    currentNodeId.value = 1;
    await loadChildren();
  };

  const goBack = async (): Promise<void> => {
    if (currentParentId.value != null) {
      await navigateToId(currentParentId.value);
    } else if (navigationHistory.value.length > 0) {
      const previousId = navigationHistory.value.pop()!;
      currentNodeId.value = previousId;
      await loadChildren();
    } else if (currentNodeId.value !== 1) {
      await goToRoot();
    }
  };

  const goBackInHistory = async (): Promise<void> => {
    if (navigationHistory.value.length > 0) {
      const previousId = navigationHistory.value.pop()!;
      currentNodeId.value = previousId;
      await loadChildren();
    }
  };

  const clearHistory = (): void => {
    navigationHistory.value = [];
  };

  const initNavigation = async (): Promise<void> => {
    currentNodeId.value = 1;
    await loadChildren();
  };

  /** Deja solo los primeros INITIAL_CHILDREN_DISPLAY hijos cargados (p. ej. al cambiar de vista a Inicio). */
  const collapseToInitialPage = (): void => {
    if (allChildren.value.length <= INITIAL_CHILDREN_DISPLAY) return;
    allChildren.value = allChildren.value.slice(0, INITIAL_CHILDREN_DISPLAY);
  };

  return {
    currentNodeId,
    currentParentId,
    allChildren,
    breadcrumbPath,
    statusMessage,
    statusMessageKey,
    statusMessageParams,
    navigationHistory,
    folders,
    files,
    locationPath,
    isAtRoot,
    canGoBack,
    hasMoreChildren,
    totalChildrenCount,
    loadChildren,
    loadBreadcrumb,
    loadMoreChildren,
    loadingMoreChildren,
    navigateToNode,
    navigateToId,
    goToRoot,
    goBack,
    goBackInHistory,
    clearHistory,
    initNavigation,
    collapseToInitialPage,
  };
}

export default useNavigation;
