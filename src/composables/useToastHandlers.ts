/**
 * @fileoverview Composable para handlers de eventos que muestran toasts (descargas, chunks, merge).
 * @module useToastHandlers
 *
 * Gestiona los event listeners para download-completed, chunk-failed, download-failed-merge
 * y muestra notificaciones toast al usuario según configuración.
 */

import { onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useToasts } from './useToasts';
import { useSettings } from './useSettings';

/**
 * Composable para handlers de toast en eventos de descarga.
 * Registra listeners en mount y los limpia en unmount.
 */
export function useToastHandlers(): void {
  const { t } = useI18n();
  const { showToast } = useToasts();
  const { showNotifications } = useSettings();

  const handleDownloadCompleted = (event: Event): void => {
    const e = event as CustomEvent<{ title: string }>;
    const { title } = e.detail;
    if (showNotifications.value) {
      showToast({
        title: t('success.downloadCompleted'),
        message: title,
        type: 'success',
        duration: 5000,
      });
    }
  };

  const handleChunkFailed = (event: Event): void => {
    const e = event as CustomEvent<{ chunkIndex?: number; error?: string; willRetry?: boolean }>;
    const { chunkIndex, error, willRetry } = e.detail || {};
    if (!showNotifications.value) return;
    const fragmentNum = typeof chunkIndex === 'number' ? chunkIndex + 1 : '?';
    showToast({
      title: willRetry ? t('downloads.chunkFailedRetry') : t('downloads.chunkFailed'),
      message: willRetry
        ? t('downloads.chunkFailedMessage', { num: fragmentNum, error: error || 'Error' })
        : t('downloads.chunkFailedNoRetry', { num: fragmentNum, error: error || 'Error' }),
      type: willRetry ? 'warning' : 'error',
      duration: willRetry ? 5000 : 8000,
    });
  };

  const handleDownloadFailedMerge = (event: Event): void => {
    const e = event as CustomEvent<{ id?: number; error?: string }>;
    const { error } = e.detail || {};
    if (!showNotifications.value) return;
    showToast({
      title: t('downloads.mergeError'),
      message: `${error || 'Error'}. ${t('downloads.mergeErrorHint')}`,
      type: 'warning',
      duration: 8000,
    });
  };

  onMounted(() => {
    window.addEventListener('download-completed', handleDownloadCompleted);
    window.addEventListener('chunk-failed', handleChunkFailed);
    window.addEventListener('download-failed-merge', handleDownloadFailedMerge);
  });

  onUnmounted(() => {
    window.removeEventListener('download-completed', handleDownloadCompleted);
    window.removeEventListener('chunk-failed', handleChunkFailed);
    window.removeEventListener('download-failed-merge', handleDownloadFailedMerge);
  });
}
