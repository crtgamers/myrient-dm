/**
 * Trampa de foco para diálogos y paneles modales (WCAG 2.4.3, 2.1.2).
 * Mantiene el foco dentro del contenedor con Tab/Shift+Tab y restaura el foco al cerrar.
 */
import type { Ref } from 'vue';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    el => el.offsetParent !== null && el.getAttribute('aria-hidden') !== 'true'
  );
}

export interface UseFocusTrapOptions {
  /** Selector del elemento que debe recibir el foco al abrir (p. ej. primer botón o "Cerrar") */
  initialFocusSelector?: string;
}

/**
 * Composable para trampa de foco en modales.
 * @param containerRef Ref del elemento que contiene los controles (el diálogo/panel).
 * @param options Opciones opcionales.
 * @returns activate() - Llama al abrir el modal; devuelve una función de limpieza que debe ejecutarse al cerrar.
 */
export function useFocusTrap(
  containerRef: Ref<HTMLElement | null>,
  options?: UseFocusTrapOptions
): { activate: () => (() => void) | undefined } {
  let previousActive: HTMLElement | null = null;
  let keydownHandler: ((_e: KeyboardEvent) => void) | null = null;

  function activate(): (() => void) | undefined {
    const el = containerRef.value;
    if (!el) return undefined;

    previousActive = document.activeElement as HTMLElement | null;
    const focusable = getFocusableElements(el);

    const first =
      options?.initialFocusSelector && el.querySelector<HTMLElement>(options.initialFocusSelector)
        ? el.querySelector<HTMLElement>(options.initialFocusSelector)
        : focusable[0];

    if (first) {
      requestAnimationFrame(() => {
        first.focus();
      });
    }

    keydownHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = getFocusableElements(el);
      if (list.length === 0) return;
      const current = document.activeElement as HTMLElement;
      let idx = list.indexOf(current);
      if (idx === -1) {
        e.preventDefault();
        list[0].focus();
        return;
      }
      const nextIdx = e.shiftKey
        ? idx <= 0
          ? list.length - 1
          : idx - 1
        : idx >= list.length - 1
          ? 0
          : idx + 1;
      list[nextIdx]?.focus();
      e.preventDefault();
    };

    el.addEventListener('keydown', keydownHandler);

    return () => {
      if (el && keydownHandler) {
        el.removeEventListener('keydown', keydownHandler);
      }
      keydownHandler = null;
      if (previousActive && typeof previousActive.focus === 'function') {
        previousActive.focus();
      }
    };
  }

  return { activate };
}
