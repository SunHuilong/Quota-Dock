<script setup lang="ts">
import { AlertTriangle, CheckCircle2, Clock3, Pencil, RefreshCw, Trash2 } from "@lucide/vue";
import { computed, ref } from "vue";
import {
  formatBalance,
  formatDateTime,
  formatMeterValue,
  formatQuotaValue,
  formatTime,
  meterProgress,
  meterRemainingPercent,
  primaryMeter,
  providerStatus,
  quotaProgress,
  quotaRemainingPercent
} from "../../shared/format";
import type { QuotaMeter, QuotaProvider } from "../../shared/types";

const props = defineProps<{
  provider: QuotaProvider;
  templateName: string;
  refreshing: boolean;
  updatingFloatingVisibility: boolean;
  column: number;
  rowSpan: number;
}>();

defineEmits<{
  refresh: [];
  edit: [];
  delete: [];
  toggleFloating: [];
}>();

const rootElement = ref<HTMLElement | null>(null);
const mainMeter = computed(() => primaryMeter(props.provider));
const additionalMeters = computed(() =>
  (props.provider.snapshot?.meters || []).filter((meter) => meter.id !== mainMeter.value?.id)
);

function meterUsageText(meter: QuotaMeter) {
  if (meter.limit !== null && meter.used !== null) {
    return `已用 ${formatQuotaValue(meter.used)} / ${formatQuotaValue(meter.limit)}`;
  }
  if (meter.used !== null && meter.remaining === null) {
    return `已用 ${formatQuotaValue(meter.used)}`;
  }
  return "";
}

defineExpose({ rootElement });
</script>

<template>
  <article
    ref="rootElement"
    class="provider-item glass-surface"
    :style="{
      '--provider-column': column,
      '--provider-row-span': rowSpan
    }"
  >
    <div class="provider-main">
      <div class="provider-info">
        <div class="provider-title-row">
          <h3>{{ provider.name }}</h3>
          <span class="template-pill">
            {{ provider.mode === "official" ? provider.officialPresetName || "预设不可用" : templateName }}
          </span>
          <span class="status-pill provider-title-status" :class="`tone-${providerStatus(provider).tone}`">
            <CheckCircle2 v-if="providerStatus(provider).tone === 'ok'" :size="13" />
            <AlertTriangle v-else-if="providerStatus(provider).tone === 'error'" :size="13" />
            <Clock3 v-else :size="13" />
            {{ providerStatus(provider).text }}
          </span>
        </div>
        <p v-if="provider.lastError" class="provider-error">
          <AlertTriangle :size="14" />
          {{ provider.lastError }}
        </p>
        <div v-if="quotaProgress(provider) !== null" class="quota-progress" aria-label="额度使用进度">
          <div class="quota-progress-text">
            <span>已用 {{ formatQuotaValue(mainMeter?.used) }} / {{ formatQuotaValue(mainMeter?.limit) }}</span>
            <strong>{{ quotaRemainingPercent(provider)?.toFixed(1) }}%</strong>
          </div>
          <div class="quota-progress-row">
            <div class="quota-progress-track">
              <span :style="{ width: `${quotaProgress(provider)}%` }"></span>
            </div>
          </div>
          <div v-if="mainMeter?.resetAt" class="quota-reset-row">
            <span class="quota-reset-text">下次重置 {{ formatDateTime(mainMeter.resetAt) }}</span>
          </div>
        </div>

        <div v-if="additionalMeters.length" class="additional-meter-list">
          <div v-for="meter in additionalMeters" :key="meter.id" class="additional-meter">
            <div class="additional-meter-head">
              <span>{{ meter.label }}</span>
              <strong>{{ formatMeterValue(meter) }} <small>{{ meter.unit }}</small></strong>
            </div>
            <div v-if="meterProgress(meter) !== null" class="quota-progress compact-meter-progress">
              <div class="quota-progress-text">
                <span>{{ meterUsageText(meter) }}</span>
                <strong>{{ meterRemainingPercent(meter)?.toFixed(1) }}%</strong>
              </div>
              <div class="quota-progress-track">
                <span :style="{ width: `${meterProgress(meter)}%` }"></span>
              </div>
            </div>
            <span v-else-if="meterUsageText(meter)" class="meter-usage-only">{{ meterUsageText(meter) }}</span>
            <span v-if="meter.resetAt" class="quota-reset-text">下次重置 {{ formatDateTime(meter.resetAt) }}</span>
          </div>
        </div>
      </div>

      <div class="provider-side">
        <div class="provider-balance">
          <span class="provider-balance-label">{{ mainMeter?.label || "可用额度" }}</span>
          <strong>{{ formatBalance(provider) }}</strong>
          <div class="provider-balance-meta">
            <span class="provider-unit">{{ mainMeter?.unit || provider.defaultUnit || "USD" }}</span>
            <span class="provider-updated-time">{{ formatTime(provider.lastCheckedAt) }}</span>
            <button
              class="provider-refresh-button"
              type="button"
              title="刷新额度"
              aria-label="刷新额度"
              :disabled="refreshing"
              @click="$emit('refresh')"
            >
              <RefreshCw :size="13" :class="{ spinning: refreshing }" />
            </button>
          </div>
        </div>

        <div class="provider-actions">
          <button
            class="provider-floating-toggle"
            type="button"
            role="switch"
            :aria-checked="provider.showInFloatingWindow"
            :aria-label="provider.showInFloatingWindow ? '从浮窗隐藏' : '在浮窗展示'"
            :title="provider.showInFloatingWindow ? '从浮窗隐藏' : '在浮窗展示'"
            :disabled="updatingFloatingVisibility"
            @click="$emit('toggleFloating')"
          >
            <span>浮窗</span>
            <span class="provider-floating-switch" aria-hidden="true"></span>
          </button>
          <button class="icon-button" type="button" title="编辑" aria-label="编辑" @click="$emit('edit')">
            <Pencil :size="15" />
          </button>
          <button class="icon-button danger" type="button" title="删除" aria-label="删除" @click="$emit('delete')">
            <Trash2 :size="15" />
          </button>
        </div>
      </div>
    </div>
  </article>
</template>
