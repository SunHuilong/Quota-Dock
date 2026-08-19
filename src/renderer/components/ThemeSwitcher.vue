<script setup lang="ts">
import { Monitor, Moon, Sun } from "@lucide/vue";
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  getThemeMode,
  setThemeMode,
  subscribeThemeMode,
  type ThemeMode
} from "../../shared/theme";

const MODE_LABELS: Record<ThemeMode, string> = {
  system: "自动",
  light: "浅色",
  dark: "深色"
};

const rootElement = ref<HTMLElement | null>(null);
const mode = ref<ThemeMode>(getThemeMode());
const isOpen = ref(false);
let stopSubscription: (() => void) | null = null;

function chooseMode(nextMode: ThemeMode) {
  setThemeMode(nextMode);
  isOpen.value = false;
}

function handlePointerDown(event: PointerEvent) {
  if (isOpen.value && event.target instanceof Node && !rootElement.value?.contains(event.target)) {
    isOpen.value = false;
  }
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    isOpen.value = false;
  }
}

onMounted(() => {
  stopSubscription = subscribeThemeMode((nextMode) => {
    mode.value = nextMode;
  });
  document.addEventListener("pointerdown", handlePointerDown);
  document.addEventListener("keydown", handleKeyDown);
});

onBeforeUnmount(() => {
  stopSubscription?.();
  document.removeEventListener("pointerdown", handlePointerDown);
  document.removeEventListener("keydown", handleKeyDown);
});
</script>

<template>
  <div ref="rootElement" class="theme-switcher">
    <button
      class="icon-button theme-trigger"
      type="button"
      :title="`显示模式：${MODE_LABELS[mode]}`"
      :aria-label="`显示模式：${MODE_LABELS[mode]}`"
      aria-haspopup="true"
      :aria-expanded="isOpen"
      aria-controls="theme-mode-menu"
      @click="isOpen = !isOpen"
    >
      <Monitor v-if="mode === 'system'" :size="17" />
      <Sun v-else-if="mode === 'light'" :size="17" />
      <Moon v-else :size="17" />
    </button>
    <Transition name="theme-menu">
      <div v-if="isOpen" id="theme-mode-menu" class="theme-menu" role="group" aria-label="显示模式">
        <button
          v-for="item in ([
            { value: 'system', label: '自动', icon: Monitor },
            { value: 'light', label: '浅色', icon: Sun },
            { value: 'dark', label: '深色', icon: Moon }
          ] as const)"
          :key="item.value"
          class="theme-option"
          :class="{ active: mode === item.value }"
          type="button"
          :title="item.label"
          :aria-label="item.label"
          :aria-pressed="mode === item.value"
          @click="chooseMode(item.value)"
        >
          <component :is="item.icon" :size="17" />
        </button>
      </div>
    </Transition>
  </div>
</template>
