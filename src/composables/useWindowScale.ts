/**
 * @fileoverview Composable para dimensiones de ventana y escalado opcional en Electron
 * @module composables/useWindowScale
 *
 * Throttle en resize (RESIZE_THROTTLE_MS) para evitar re-renders excesivos al redimensionar
 * la ventana de forma continua (auditoría performance U8).
 */

import { ref, computed, onMounted, onUnmounted } from 'vue';
import type { Ref, ComputedRef } from 'vue';

const SCALE_BELOW_WIDTH = 800;
/** Escala mínima para soporte CRT/320px: 320/800 = 0.4 */
const SCALE_MIN = 0.4;
/** Throttle para resize: reduce actualizaciones durante redimensionado continuo (ms). */
const RESIZE_THROTTLE_MS = 120;

/**
 * Composable de dimensiones de ventana y escalado para vistas pequeñas (por debajo de 800px de ancho).
 * Soporta hasta 320px de ancho (CRT) con escala mínima 0.4.
 * @returns width, height (Refs), scaleFactor, scaleWrapperStyle (para aplicar transform), useScaleWrapper.
 */
export function useWindowScale(): {
  width: Ref<number>;
  height: Ref<number>;
  scaleFactor: ComputedRef<number>;
  scaleWrapperStyle: ComputedRef<Partial<Record<string, string>>>;
  useScaleWrapper: ComputedRef<boolean>;
} {
  const width = ref(typeof window !== 'undefined' ? window.innerWidth : 1024);
  const height = ref(typeof window !== 'undefined' ? window.innerHeight : 768);

  function updateSize(): void {
    if (typeof window === 'undefined') return;
    width.value = window.innerWidth;
    height.value = window.innerHeight;
  }

  let resizeThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastResizeRun = 0;

  function throttledUpdateSize(): void {
    const now = Date.now();
    if (now - lastResizeRun >= RESIZE_THROTTLE_MS) {
      lastResizeRun = now;
      updateSize();
    } else if (resizeThrottleTimer === null) {
      resizeThrottleTimer = setTimeout(
        () => {
          resizeThrottleTimer = null;
          lastResizeRun = Date.now();
          updateSize();
        },
        RESIZE_THROTTLE_MS - (now - lastResizeRun)
      );
    }
  }

  const scaleFactor = computed(() => {
    const w = width.value;
    if (w >= SCALE_BELOW_WIDTH) return 1;
    if (w <= 0) return 1;
    const scale = w / SCALE_BELOW_WIDTH;
    return Math.max(SCALE_MIN, Math.min(1, scale));
  });

  const scaleWrapperStyle = computed((): Partial<Record<string, string>> => {
    const s = scaleFactor.value;
    if (s >= 1) return {};
    return {
      transform: `scale(${s})`,
      transformOrigin: '0 0',
      width: `${100 / s}%`,
      height: `${100 / s}%`,
      minHeight: `${100 / s}%`,
    };
  });

  const useScaleWrapper = computed(() => scaleFactor.value < 1);

  onMounted(() => {
    updateSize();
    window.addEventListener('resize', throttledUpdateSize);
  });

  onUnmounted(() => {
    window.removeEventListener('resize', throttledUpdateSize);
    if (resizeThrottleTimer !== null) {
      clearTimeout(resizeThrottleTimer);
      resizeThrottleTimer = null;
    }
  });

  return {
    width,
    height,
    scaleFactor,
    scaleWrapperStyle,
    useScaleWrapper,
  };
}

export default useWindowScale;
