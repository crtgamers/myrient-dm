/**
 * @fileoverview Composable que agrupa la lógica de la cola de descargas: filtrado y watchers.
 * @module useQueueContent
 *
 * Envuelve useQueueFilter y añade watchers para:
 * - Limpiar filtro de cola al salir de la vista de descargas
 * - Resetear filtro cuando ya no hay descargas en ese estado
 */

import { watch } from 'vue';
import type { Ref } from 'vue';
import { useQueueFilter } from './useQueueFilter';

export interface UseQueueContentOptions<T> {
  /** Lista completa de descargas (de useDownloads) */
  allDownloads: Ref<T[]>;
  /** Indica si la vista de descargas está activa (de useDownloads.showingDownloads) */
  showingDownloads: Ref<boolean>;
}

/**
 * Cola de descargas con filtrado y watchers integrados.
 * Limpia queueStateFilter al salir de la vista y cuando el filtro seleccionado deja de ser válido.
 */
export function useQueueContent<
  T extends { state?: string; title?: string; name?: string; [key: string]: unknown },
>(options: UseQueueContentOptions<T>) {
  const { allDownloads, showingDownloads } = options;
  const queueFilter = useQueueFilter(allDownloads);
  const { queueStateFilter, availableQueueStateFilters } = queueFilter;

  // Limpiar filtro de cola al salir de la vista de descargas
  watch(showingDownloads, val => {
    if (!val) queueStateFilter.value = '';
  });

  // Si el estado seleccionado ya no tiene archivos (p. ej. último completado), volver a "Todos"
  watch(
    [queueStateFilter, availableQueueStateFilters],
    ([filter, available]) => {
      if (filter && Array.isArray(available) && !available.includes(filter)) {
        queueStateFilter.value = '';
      }
    },
    { deep: true }
  );

  return queueFilter;
}
