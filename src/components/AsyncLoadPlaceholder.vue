<template>
  <div
    class="async-loading-placeholder"
    role="status"
    aria-live="polite"
  >
    <span>{{ t('common.loading') }}</span>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>
