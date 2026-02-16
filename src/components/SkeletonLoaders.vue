<template>
  <!-- Folder Skeleton -->
  <div
    v-if="type === 'folder'"
    class="folder-skeleton-grid"
  >
    <div
      v-for="i in count"
      :key="i"
      class="skeleton-card glass-effect"
    >
      <div class="skeleton skeleton-circle"></div>
      <div class="skeleton-info">
        <div class="skeleton skeleton-text short"></div>
        <div class="skeleton skeleton-text"></div>
      </div>
    </div>
  </div>

  <!-- Table Row Skeleton -->
  <div
    v-else-if="type === 'table'"
    class="table-skeleton"
  >
    <div class="skeleton-header glass-effect">
      <div
        v-for="i in 5"
        :key="i"
        class="skeleton skeleton-text"
      ></div>
    </div>
    <div
      v-for="i in count"
      :key="i"
      class="skeleton-row"
    >
      <div class="skeleton skeleton-checkbox"></div>
      <div class="skeleton skeleton-text name-skeleton"></div>
      <div class="skeleton skeleton-text date-skeleton"></div>
      <div class="skeleton skeleton-text size-skeleton"></div>
      <div class="skeleton skeleton-btn"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps({
  type: {
    type: String,
    required: true,
    validator: (val: string) => ['folder', 'table'].includes(val),
  },
  count: {
    type: Number,
    default: 6,
  },
});
</script>

<style scoped>
.folder-skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16.25rem, 1fr));
  gap: var(--spacing-md);
}

.skeleton-card {
  padding: 1rem;
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  gap: 1rem;
}

.skeleton-info {
  flex: 1;
}

.table-skeleton {
  width: 100%;
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.skeleton-header {
  display: grid;
  grid-template-columns: 3.125rem 1fr 7.5rem 6.25rem 7.5rem;
  padding: 0.875rem 1rem;
  gap: 1.25rem;
}

.skeleton-row {
  display: grid;
  grid-template-columns: 3.125rem 1fr 7.5rem 6.25rem 7.5rem;
  padding: 1rem;
  gap: 1.25rem;
  border-bottom: 0.0625rem solid var(--border-subtle);
}

.skeleton-checkbox {
  width: 1.25rem;
  height: 1.25rem;
}
.skeleton-btn {
  height: 2rem;
  border-radius: var(--radius-md);
}

.name-skeleton {
  height: 1rem;
  width: 80%;
}
.date-skeleton {
  height: 0.875rem;
  width: 60%;
}
.size-skeleton {
  height: 0.875rem;
  width: 40%;
}
</style>
