/**
 * @fileoverview Composable para gestión de favoritos (carpetas)
 * @module useFavorites
 */

import { ref, computed } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import { readConfigFile, writeConfigFile } from '../services/api';
import logger from '../utils/logger';

export interface FavoriteNode {
  id: number;
  title: string;
  type?: string;
  /** Fuente del favorito: myrient o lolroms. Por compatibilidad, favoritos antiguos pueden no tener source (se asume myrient). */
  source?: 'myrient' | 'lolroms';
}

const favorites = ref<FavoriteNode[]>([]);
const showingFavorites = ref(false);

/**
 * Composable de favoritos (carpetas): lista persistida en favorites.json, añadir/quitar y panel.
 * @returns favorites, showingFavorites, favoriteFolders, favoriteIds, loadFavorites, saveFavorites, isFavorite, toggleFavorite, addFavorite, removeFavorite, clearFavorites, toggleFavoritesPanel.
 */
export function useFavorites(): {
  favorites: Ref<FavoriteNode[]>;
  showingFavorites: Ref<boolean>;
  favoriteFolders: ComputedRef<FavoriteNode[]>;
  favoriteIds: ComputedRef<Set<number>>;
  getFavoriteIdsForSource: (_source: 'myrient' | 'lolroms' | null) => Set<number>;
  loadFavorites: () => Promise<void>;
  saveFavorites: () => Promise<void>;
  isFavorite: (_nodeId: number) => boolean;
  toggleFavorite: (
    _node:
      | FavoriteNode
      | { id: number; title?: string; type?: string; source?: 'myrient' | 'lolroms' },
    _currentSource?: 'myrient' | 'lolroms' | null
  ) => void;
  addFavorite: (_node: FavoriteNode | { id: number; title?: string; type?: string }) => void;
  removeFavorite: (_nodeId: number) => void;
  clearFavorites: () => void;
  toggleFavoritesPanel: () => void;
} {
  const favoriteFolders = computed(() => {
    return favorites.value.filter(f => f.type === 'folder');
  });

  const favoriteIds = computed(() => {
    return new Set(favorites.value.map(f => f.id));
  });

  /** IDs de favoritos para una fuente dada (para mostrar estrellas en la vista actual). */
  const getFavoriteIdsForSource = (source: 'myrient' | 'lolroms' | null): Set<number> => {
    if (!source) return new Set();
    return new Set(favorites.value.filter(f => (f.source ?? 'myrient') === source).map(f => f.id));
  };

  const loadFavorites = async (): Promise<void> => {
    try {
      const result = await readConfigFile('favorites.json');
      if (result.success && result.data) {
        favorites.value = Array.isArray(result.data) ? (result.data as FavoriteNode[]) : [];
      } else {
        favorites.value = [];
      }
    } catch (error) {
      logger.child('Favorites').error('Error cargando favoritos', error);
      favorites.value = [];
    }
  };

  const saveFavorites = async (): Promise<void> => {
    try {
      const plain = JSON.parse(JSON.stringify(favorites.value));
      await writeConfigFile('favorites.json', plain);
    } catch (error) {
      logger.child('Favorites').error('Error guardando favoritos', error);
    }
  };

  const isFavorite = (nodeId: number): boolean => {
    return favoriteIds.value.has(nodeId);
  };

  const toggleFavorite = (
    node:
      | FavoriteNode
      | { id: number; title?: string; type?: string; source?: 'myrient' | 'lolroms' },
    currentSource?: 'myrient' | 'lolroms' | null
  ): void => {
    if (!node?.id) {
      logger.child('Favorites').warn('Nodo inválido al intentar marcar como favorito', node);
      return;
    }

    const source =
      (node as { source?: 'myrient' | 'lolroms' }).source ?? currentSource ?? 'myrient';
    const index = favorites.value.findIndex(
      f => f.id === node.id && (f.source ?? 'myrient') === source
    );

    if (index >= 0) {
      favorites.value.splice(index, 1);
      logger.child('Favorites').info('Quitado de favoritos', {
        id: node.id,
        title: node.title,
        source,
      });
    } else {
      favorites.value.push({
        id: node.id,
        title: node.title ?? '',
        type: node.type ?? 'folder',
        source,
      });
      logger.child('Favorites').info('Añadido a favoritos', {
        id: node.id,
        title: node.title,
        source,
      });
    }

    void saveFavorites();
  };

  const addFavorite = (
    node: FavoriteNode | { id: number; title?: string; type?: string }
  ): void => {
    if (!isFavorite(node.id)) {
      toggleFavorite(node);
    }
  };

  const removeFavorite = (nodeId: number): void => {
    const index = favorites.value.findIndex(f => f.id === nodeId);
    if (index >= 0) {
      favorites.value.splice(index, 1);
      void saveFavorites();
    }
  };

  const clearFavorites = (): void => {
    favorites.value = [];
    void saveFavorites();
  };

  const toggleFavoritesPanel = (): void => {
    showingFavorites.value = !showingFavorites.value;
  };

  return {
    favorites,
    showingFavorites,
    favoriteFolders,
    favoriteIds,
    getFavoriteIdsForSource,
    loadFavorites,
    saveFavorites,
    isFavorite,
    toggleFavorite,
    addFavorite,
    removeFavorite,
    clearFavorites,
    toggleFavoritesPanel,
  };
}

export default useFavorites;
