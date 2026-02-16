/**
 * @fileoverview Composable para virtual scrolling optimizado
 * @module useVirtualScroll
 *
 * U6: no re-observar elementos ya observados (Set observedIndicesForIO), limitar ResizeObservers
 * activos (solo primeras N filas visibles), menos umbrales en IntersectionObserver para menos callbacks.
 */

import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import logger from '../utils/logger';

/** Máximo de ResizeObservers por fila; solo las primeras N filas visibles miden altura (U6). */
const MAX_RESIZE_OBSERVERS = 12;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface VirtualScrollRange {
  start: number;
  end: number;
  total: number;
  timestamp?: number;
}

export type VirtualScrollVisibleItem<T = unknown> = {
  _virtualIndex: number;
  _actualIndex: number;
  [key: string]: unknown;
} & T;

export interface UseVirtualScrollOptions<T = unknown> {
  items?: Ref<T[]>;
  containerRef?: Ref<HTMLElement | null>;
  itemHeight?: number;
  overscan?: number;
  minItemsToVirtualize?: number;
  enabled?: boolean;
  useIntersectionObserver?: boolean;
}

export interface UseVirtualScrollReturn<T = unknown> {
  scrollTop: Ref<number>;
  containerHeight: Ref<number>;
  measuredRowHeight: Ref<number>;
  shouldVirtualize: ComputedRef<boolean>;
  visibleRange: ComputedRef<VirtualScrollRange>;
  visibleItems: ComputedRef<VirtualScrollVisibleItem<T>[]>;
  topSpacerHeight: ComputedRef<number>;
  bottomSpacerHeight: ComputedRef<number>;
  totalHeight: ComputedRef<string | number>;
  scrollbarThumbHeight: ComputedRef<number>;
  scrollbarThumbPosition: ComputedRef<number>;
  handleScroll: () => void;
  measureRowHeight: () => void;
  scrollToIndex: (_index: number, _align?: 'start' | 'center' | 'end') => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  observeElement: (_element: Element, _index: number) => void;
  unobserveElement: (_element: Element) => void;
  cleanup: () => void;
  _validatedRange: Ref<VirtualScrollRange | null>;
  _visibleIndices: Ref<Set<number>>;
  _itemHeights: Ref<Map<number, number>>;
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

/**
 * Composable de virtual scrolling: solo renderiza los ítems visibles en el contenedor.
 * @param options - items (Ref), containerRef, itemHeight, overscan, minItemsToVirtualize, enabled, useIntersectionObserver.
 * @returns scrollTop, visibleRange, visibleItems, topSpacerHeight, bottomSpacerHeight, handleScroll, scrollToIndex, measureRowHeight, cleanup, etc.
 */
export function useVirtualScroll<T = unknown>(
  options: UseVirtualScrollOptions<T> = {}
): UseVirtualScrollReturn<T> {
  const {
    items: itemsOption = ref([]) as Ref<T[]>,
    containerRef: containerRefOption = ref(null) as Ref<HTMLElement | null>,
    itemHeight = 50,
    overscan = 5,
    minItemsToVirtualize = 50,
    enabled = true,
    useIntersectionObserver: useIntersectionObserverOption = true,
  } = options;

  const items = itemsOption;
  const containerRef = containerRefOption;

  const scrollTop = ref(0);
  const containerHeight = ref(0);
  const measuredRowHeight = ref(itemHeight);
  const hasStableMeasurement = ref(false);

  const visibleIndices = ref(new Set<number>());
  const itemHeights = ref(new Map<number, number>());
  const validatedRange = ref<VirtualScrollRange | null>(null);

  const ROW_HEIGHT_ESTIMATE = itemHeight;
  const OVERSCAN = overscan;
  const MIN_ITEMS_TO_VIRTUALIZE = minItemsToVirtualize;
  const ENABLED = enabled;
  const USE_INTERSECTION =
    useIntersectionObserverOption &&
    typeof window !== 'undefined' &&
    'IntersectionObserver' in window;
  const SCROLL_THRESHOLD = itemHeight * 0.5;

  const shouldVirtualize = computed(() => {
    const itemsValue = items.value;
    const containerValue = containerRef.value;
    return (
      ENABLED &&
      Array.isArray(itemsValue) &&
      itemsValue.length >= MIN_ITEMS_TO_VIRTUALIZE &&
      containerValue !== null &&
      containerValue !== undefined
    );
  });

  const estimatedRange = computed((): VirtualScrollRange => {
    if (!shouldVirtualize.value) {
      return { start: 0, end: items.value.length, total: items.value.length };
    }
    if (containerHeight.value <= 0 || containerHeight.value < itemHeight) {
      const minVisibleItems = Math.max(20, OVERSCAN * 4);
      const end = Math.min(items.value.length, minVisibleItems);
      return { start: 0, end, total: items.value.length };
    }
    const start = Math.max(0, Math.floor(scrollTop.value / measuredRowHeight.value) - OVERSCAN);
    const end = Math.min(
      items.value.length,
      Math.ceil((scrollTop.value + containerHeight.value) / measuredRowHeight.value) + OVERSCAN
    );
    return { start, end, total: items.value.length };
  });

  const visibleRange = computed((): VirtualScrollRange => {
    if (!shouldVirtualize.value) {
      return { start: 0, end: items.value.length, total: items.value.length };
    }
    if (validatedRange.value && USE_INTERSECTION) {
      const { start, end, timestamp } = validatedRange.value;
      const isRecent = timestamp != null && Date.now() - timestamp < 500;
      const estimated = estimatedRange.value;
      if (isRecent || (start >= estimated.start - OVERSCAN && end <= estimated.end + OVERSCAN)) {
        return { start, end, total: items.value.length };
      }
    }
    return estimatedRange.value;
  });

  const visibleItems = computed((): VirtualScrollVisibleItem<T>[] => {
    const { start, end } = visibleRange.value;
    return items.value.slice(start, end).map((item, index) => ({
      ...(item as object),
      _virtualIndex: start + index,
      _actualIndex: start + index,
    })) as VirtualScrollVisibleItem<T>[];
  });

  const topSpacerHeight = computed(() => {
    if (!shouldVirtualize.value) return 0;
    return visibleRange.value.start * measuredRowHeight.value;
  });

  const bottomSpacerHeight = computed(() => {
    if (!shouldVirtualize.value) return 0;
    const { end, total } = visibleRange.value;
    return (total - end) * measuredRowHeight.value;
  });

  const totalHeight = computed(() => {
    if (!shouldVirtualize.value) return 'auto';
    return `${items.value.length * measuredRowHeight.value}px`;
  });

  let rafId: number | null = null;
  let lastScrollTop = 0;
  let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

  const handleScroll = (): void => {
    if (!containerRef.value || !shouldVirtualize.value) return;
    const currentScrollTop = containerRef.value.scrollTop;
    const scrollDelta = Math.abs(currentScrollTop - lastScrollTop);
    if (scrollDelta < SCROLL_THRESHOLD && rafId !== null) return;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      scrollTop.value = currentScrollTop;
      lastScrollTop = currentScrollTop;
      rafId = null;
      if (scrollDelta > SCROLL_THRESHOLD && USE_INTERSECTION) {
        if (scrollDelta > measuredRowHeight.value * 3) {
          validatedRange.value = null;
        }
      }
    });
  };

  const updateValidatedRange = (): void => {
    if (visibleIndices.value.size === 0) {
      validatedRange.value = null;
      return;
    }
    const indices = Array.from(visibleIndices.value).sort((a, b) => a - b);
    const minIndex = Math.max(0, indices[0] - OVERSCAN);
    const maxIndex = Math.min(items.value.length - 1, indices[indices.length - 1] + OVERSCAN);
    validatedRange.value = {
      start: minIndex,
      end: maxIndex + 1,
      total: items.value.length,
      timestamp: Date.now(),
    };
  };

  const updateAverageHeight = (): void => {
    if (itemHeights.value.size < 2) return;
    const heights = Array.from(itemHeights.value.values());
    const average = heights.reduce((a, b) => a + b, 0) / heights.length;
    if (average < ROW_HEIGHT_ESTIMATE * 0.3 || average > ROW_HEIGHT_ESTIMATE * 3) {
      return;
    }
    const heightDifference = Math.abs(average - measuredRowHeight.value);
    if (heightDifference > 5) {
      if (!hasStableMeasurement.value) {
        measuredRowHeight.value = Math.round(average);
        hasStableMeasurement.value = true;
      } else {
        if (average <= measuredRowHeight.value || heightDifference > 15) {
          measuredRowHeight.value = Math.round(average);
        }
      }
    }
  };

  const observeItemHeight = (element: Element, index: number): void => {
    if (typeof window === 'undefined' || !window.ResizeObserver || !element) return;
    const observers = itemResizeObservers;
    if (observers.has(index)) {
      observers.get(index)!.disconnect();
    }
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const height = entry.contentRect.height;
        if (height > 0 && height < 500) {
          const oldHeight = itemHeights.value.get(index);
          if (!oldHeight || Math.abs(oldHeight - height) > 3) {
            itemHeights.value.set(index, height);
            updateAverageHeight();
          }
        }
      }
    });
    observer.observe(element);
    observers.set(index, observer);
  };

  let resizeObserver: ResizeObserver | null = null;
  let intersectionObserver: IntersectionObserver | null = null;
  const itemResizeObservers = new Map<number, ResizeObserver>();
  /** Índices ya pasados a IntersectionObserver.observe(); evita re-observar (U6). */
  const observedIndicesForIO = new Set<number>();

  const handleIntersections = (entries: IntersectionObserverEntry[]): void => {
    let hasChanges = false;
    const rangeStart = visibleRange.value.start;
    const resizeLimit = rangeStart + MAX_RESIZE_OBSERVERS;
    entries.forEach(entry => {
      const index = parseInt((entry.target as HTMLElement).dataset.virtualIndex ?? '', 10);
      if (isNaN(index) || index < 0 || index >= items.value.length) return;
      if (entry.isIntersecting) {
        visibleIndices.value.add(index);
        hasChanges = true;
        const height = (entry.target as HTMLElement).offsetHeight;
        if (height > 0 && height < 500) {
          const cachedHeight = itemHeights.value.get(index);
          if (!cachedHeight || Math.abs(cachedHeight - height) > 3) {
            itemHeights.value.set(index, height);
            updateAverageHeight();
            if (index < resizeLimit) observeItemHeight(entry.target, index);
          }
        }
      } else {
        if (visibleIndices.value.has(index)) {
          visibleIndices.value.delete(index);
          hasChanges = true;
        }
      }
    });
    if (hasChanges && visibleIndices.value.size > 0) {
      updateValidatedRange();
    }
  };

  const measureRowHeight = (): void => {
    if (!containerRef.value || !shouldVirtualize.value) return;
    nextTick(() => {
      const container = containerRef.value;
      if (!container) return;
      const rows = container.querySelectorAll('[data-virtual-index]');
      if (rows.length === 0) return;
      const rowsToMeasure = Math.min(Math.max(3, rows.length), 10);
      let totalHeightSum = 0;
      let validMeasurements = 0;
      for (let i = 0; i < rowsToMeasure && i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        const height = rect.height;
        if (height > 0 && height < 200 && height >= ROW_HEIGHT_ESTIMATE * 0.5) {
          totalHeightSum += height;
          validMeasurements++;
        }
      }
      if (validMeasurements >= 2) {
        const averageHeight = totalHeightSum / validMeasurements;
        const heightDifference = Math.abs(averageHeight - measuredRowHeight.value);
        if (!hasStableMeasurement.value) {
          if (
            averageHeight >= ROW_HEIGHT_ESTIMATE * 0.5 &&
            averageHeight <= ROW_HEIGHT_ESTIMATE * 2
          ) {
            measuredRowHeight.value = Math.round(averageHeight);
            hasStableMeasurement.value = true;
          }
        } else {
          const shouldUpdate =
            (averageHeight <= measuredRowHeight.value && heightDifference > 3) ||
            (heightDifference > 15 &&
              averageHeight >= ROW_HEIGHT_ESTIMATE * 0.5 &&
              averageHeight <= ROW_HEIGHT_ESTIMATE * 2);
          if (shouldUpdate) {
            measuredRowHeight.value = Math.round(averageHeight);
          }
        }
      }
    });
  };

  const scrollbarThumbHeight = computed(() => {
    if (!shouldVirtualize.value || !containerRef.value) return 0;
    const { total } = visibleRange.value;
    const viewportRatio = containerHeight.value / (total * measuredRowHeight.value);
    return Math.max(20, containerHeight.value * viewportRatio);
  });

  const scrollbarThumbPosition = computed(() => {
    if (!shouldVirtualize.value || !containerRef.value) return 0;
    const { total } = visibleRange.value;
    const maxScroll = total * measuredRowHeight.value - containerHeight.value;
    if (maxScroll <= 0) return 0;
    const scrollRatio = scrollTop.value / maxScroll;
    return scrollRatio * (containerHeight.value - scrollbarThumbHeight.value);
  });

  const initIntersectionObserver = (): void => {
    if (!USE_INTERSECTION || !containerRef.value || intersectionObserver) return;
    try {
      intersectionObserver = new IntersectionObserver(handleIntersections, {
        root: containerRef.value,
        rootMargin: `${OVERSCAN * measuredRowHeight.value}px`,
        threshold: [0, 0.5, 1],
      });
    } catch (error) {
      logger.child('VirtualScroll').warn('Error inicializando IntersectionObserver', error);
    }
  };

  const cleanupIntersectionObserver = (): void => {
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }
    observedIndicesForIO.clear();
    visibleIndices.value.clear();
    validatedRange.value = null;
  };

  const initObservers = (): void => {
    if (!containerRef.value) return;
    if (typeof window !== 'undefined' && window.ResizeObserver) {
      let lastContainerHeight = containerHeight.value;
      resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          const newHeight = entry.contentRect.height;
          if (Math.abs(newHeight - lastContainerHeight) > 50) {
            cleanupIntersectionObserver();
            nextTick(() => initIntersectionObserver());
          }
          containerHeight.value = newHeight;
          lastContainerHeight = newHeight;
        }
      });
      resizeObserver.observe(containerRef.value);
    }
    initIntersectionObserver();
    watch(
      () => items.value.length,
      (newLen, oldLen) => {
        if (shouldVirtualize.value) {
          if (Math.abs((newLen ?? 0) - (oldLen ?? 0)) > 10) {
            hasStableMeasurement.value = false;
            visibleIndices.value.clear();
            validatedRange.value = null;
            if ((newLen ?? 0) < (oldLen ?? 0)) {
              itemHeights.value.forEach((_, idx) => {
                if (idx >= (newLen ?? 0)) {
                  itemHeights.value.delete(idx);
                  if (itemResizeObservers.has(idx)) {
                    itemResizeObservers.get(idx)!.disconnect();
                    itemResizeObservers.delete(idx);
                  }
                }
              });
            }
          }
          nextTick(() => measureRowHeight());
        }
      },
      { immediate: false }
    );
  };

  const observeElement = (element: Element, index: number): void => {
    if (!USE_INTERSECTION || !intersectionObserver || !element) return;
    if (observedIndicesForIO.has(index)) return;
    (element as HTMLElement).dataset.virtualIndex = index.toString();
    intersectionObserver.observe(element);
    observedIndicesForIO.add(index);
    const rangeStart = visibleRange.value.start;
    if (index < rangeStart + MAX_RESIZE_OBSERVERS && !itemHeights.value.has(index)) {
      nextTick(() => observeItemHeight(element, index));
    }
  };

  const unobserveElement = (element: Element): void => {
    if (intersectionObserver && element) {
      intersectionObserver.unobserve(element);
    }
    const index = parseInt((element as HTMLElement)?.dataset?.virtualIndex ?? '', 10);
    if (!isNaN(index)) {
      observedIndicesForIO.delete(index);
      if (itemResizeObservers.has(index)) {
        itemResizeObservers.get(index)!.disconnect();
        itemResizeObservers.delete(index);
      }
    }
  };

  const scrollToIndex = (index: number, align: 'start' | 'center' | 'end' = 'start'): void => {
    if (!containerRef.value || !shouldVirtualize.value) return;
    const targetScrollTop = index * measuredRowHeight.value;
    const maxScroll = items.value.length * measuredRowHeight.value - containerHeight.value;
    let finalScrollTop = Math.max(0, Math.min(targetScrollTop, maxScroll));
    if (align === 'center') {
      finalScrollTop = Math.max(0, finalScrollTop - containerHeight.value / 2);
    } else if (align === 'end') {
      finalScrollTop = Math.max(0, finalScrollTop - containerHeight.value);
    }
    containerRef.value.scrollTop = finalScrollTop;
    scrollTop.value = finalScrollTop;
  };

  const scrollToTop = (): void => scrollToIndex(0);
  const scrollToBottom = (): void => {
    if (!shouldVirtualize.value) return;
    scrollToIndex(items.value.length - 1, 'end');
  };

  const cleanup = (): void => {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    cleanupIntersectionObserver();
    itemResizeObservers.forEach(observer => observer.disconnect());
    itemResizeObservers.clear();
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
      scrollTimeout = null;
    }
  };

  const autoObserveElements = (): void => {
    if (!USE_INTERSECTION || !intersectionObserver || !containerRef.value) return;
    nextTick(() => {
      const container = containerRef.value;
      if (!container) return;
      const { start, end } = visibleRange.value;
      for (const idx of observedIndicesForIO) {
        if (idx < start || idx >= end) observedIndicesForIO.delete(idx);
      }
      const elements = container.querySelectorAll('[data-virtual-index]');
      elements.forEach(element => {
        const index = parseInt((element as HTMLElement).dataset.virtualIndex ?? '', 10);
        if (
          !isNaN(index) &&
          index >= 0 &&
          index < items.value.length &&
          !observedIndicesForIO.has(index)
        ) {
          observeElement(element, index);
        }
      });
    });
  };

  watch(
    visibleItems,
    () => {
      if (USE_INTERSECTION) autoObserveElements();
    },
    { flush: 'post' }
  );

  onMounted(() => {
    if (containerRef.value) {
      containerHeight.value = containerRef.value.clientHeight;
      initObservers();
      measureRowHeight();
      if (USE_INTERSECTION) {
        nextTick(() => autoObserveElements());
      }
    }
  });

  onUnmounted(() => {
    cleanup();
  });

  return {
    scrollTop,
    containerHeight,
    measuredRowHeight,
    shouldVirtualize,
    visibleRange,
    visibleItems,
    topSpacerHeight,
    bottomSpacerHeight,
    totalHeight,
    scrollbarThumbHeight,
    scrollbarThumbPosition,
    handleScroll,
    measureRowHeight,
    scrollToIndex,
    scrollToTop,
    scrollToBottom,
    observeElement,
    unobserveElement,
    cleanup,
    _validatedRange: validatedRange,
    _visibleIndices: visibleIndices,
    _itemHeights: itemHeights,
  };
}
