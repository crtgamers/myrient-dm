<template>
  <div class="init-screen">
    <div class="init-content">
      <div class="logo-animation">
        <div class="logo-circle">
          <img
            src="/logo.svg"
            alt="Myrient"
            class="logo-icon"
          />
        </div>
        <div class="logo-rings">
          <div class="ring ring-1"></div>
          <div class="ring ring-2"></div>
          <div class="ring ring-3"></div>
        </div>
      </div>
      <div class="brand-text">
        <h1 class="brand-title">{{ t('app.name') }}</h1>
        <p class="brand-subtitle">{{ t('app.subtitle') }}</p>
      </div>
      <div class="init-loader">
        <div class="loader-bar">
          <div class="loader-fill"></div>
        </div>
        <p class="loader-text">{{ statusMessage || t('init.starting') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

defineProps({
  statusMessage: {
    type: String,
    default: () => '', // El padre (App.vue) pasa siempre el mensaje traducido vía init.*
  },
});
</script>

<style scoped>
.init-screen {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--bg-main);
  z-index: 9999;
  overflow: hidden;
}

.init-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2rem;
  max-width: 18.75rem;
  width: 100%;
}

.logo-animation {
  position: relative;
  width: 7.5rem;
  height: 7.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.logo-circle {
  width: 5rem;
  height: 5rem;
  background: var(--primary-color);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  z-index: 2;
  box-shadow: 0 0 1.875rem var(--primary-color-alpha);
}

.logo-icon {
  width: 4rem;
  height: 4rem;
  object-fit: contain;
  /* Mismo color que Sidebar e index.html: logo blanco */
  filter: brightness(0) invert(1);
  animation: bounce 2s infinite ease-in-out;
}

.logo-rings {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ring {
  position: absolute;
  border: 0.125rem solid var(--primary-color);
  border-radius: 50%;
  opacity: 0;
  animation: ring-pulse 3s infinite cubic-bezier(0.215, 0.61, 0.355, 1);
}

.ring-1 {
  animation-delay: 0s;
}
.ring-2 {
  animation-delay: 1s;
}
.ring-3 {
  animation-delay: 2s;
}

@keyframes ring-pulse {
  0% {
    width: 3.75rem;
    height: 3.75rem;
    opacity: 0.5;
    border-width: 0.25rem;
  }
  100% {
    width: 8.75rem;
    height: 8.75rem;
    opacity: 0;
    border-width: 0.0625rem;
  }
}

@keyframes bounce {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-0.625rem);
  }
}

.brand-text {
  text-align: center;
}

.brand-title {
  font-size: 2rem;
  font-weight: 800;
  letter-spacing: 0.25rem;
  color: var(--primary-color);
  margin: 0;
  text-shadow: var(--primary-glow);
}

.brand-subtitle {
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.125rem;
  color: var(--text-secondary);
  margin-top: 0.5rem;
  opacity: 0.8;
}

.init-loader {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}

.loader-bar {
  width: 100%;
  height: 0.25rem;
  background: var(--bg-tertiary);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.loader-fill {
  height: 100%;
  width: 30%;
  background: var(--primary-color);
  border-radius: var(--radius-full);
  animation: loader-slide 2s infinite ease-in-out;
  box-shadow: 0 0 0.625rem var(--primary-color-alpha);
}

@keyframes loader-slide {
  0% {
    transform: translateX(-100%);
    width: 30%;
  }
  50% {
    width: 60%;
  }
  100% {
    transform: translateX(250%);
    width: 30%;
  }
}

.loader-text {
  font-size: 0.75rem;
  color: var(--text-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.0625rem;
}
</style>
