/**
 * @fileoverview Composable para notificaciones toast
 * @module useToasts
 */

import { ref, type Ref } from 'vue';

export interface ToastItem {
  id: number;
  title: string;
  message: string;
  type: string;
  duration: number;
}

export interface ToastOptions {
  title?: string;
  message?: string;
  type?: string;
  duration?: number;
}

const toasts = ref<ToastItem[]>([]);
let toastIdCounter = 0;
const MAX_TOASTS = 6;

/**
 * Composable de notificaciones toast: cola en memoria, mostrar con duración y eliminar.
 * @returns toasts (Ref), showToast(options), removeToast(id), clearToasts().
 */
export function useToasts(): {
  toasts: Ref<ToastItem[]>;
  showToast: (_options: ToastOptions) => number;
  removeToast: (_id: number) => void;
  clearToasts: () => void;
} {
  const showToast = (options: ToastOptions): number => {
    if (toasts.value.length >= MAX_TOASTS) {
      toasts.value.shift();
    }
    const id = ++toastIdCounter;
    const toast: ToastItem = {
      id,
      title: options.title ?? 'Notificación',
      message: options.message ?? '',
      type: options.type ?? 'info',
      duration: options.duration !== undefined ? options.duration : 5000,
    };
    toasts.value.push(toast);
    if (toast.duration > 0) {
      setTimeout(() => removeToast(id), toast.duration);
    }
    return id;
  };

  const removeToast = (id: number): void => {
    const index = toasts.value.findIndex(t => t.id === id);
    if (index >= 0) toasts.value.splice(index, 1);
  };

  const clearToasts = (): void => {
    toasts.value = [];
  };

  return { toasts, showToast, removeToast, clearToasts };
}

export default useToasts;
