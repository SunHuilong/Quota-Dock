<script setup lang="ts">
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, WalletCards, X } from "@lucide/vue";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { getQuotaBridge } from "../shared/bridge";
import { formatBalance, formatDateTime, formatQuotaValue, formatTime, providerStatus, quotaProgress } from "../shared/format";
import type { QuotaProvider } from "../shared/types";

const bridge = getQuotaBridge();
const providers = ref<QuotaProvider[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const errorMessage = ref("");
let refreshTimer = 0;

function setError(error: unknown, fallback: string) {
  errorMessage.value = error instanceof Error ? error.message : fallback;
}

async function applyProviders(nextProviders: QuotaProvider[]) {
  providers.value = nextProviders;
  return nextProviders.length;
}

async function syncProviders() {
  errorMessage.value = "";
  try {
    return await applyProviders(await bridge.listProviders());
  } catch (error) {
    setError(error, "同步失败");
    return providers.value.length;
  }
}

async function loadDue() {
  try {
    await applyProviders(await bridge.refreshDueProviders());
  } catch (error) {
    setError(error, "自动刷新失败");
    try {
      await applyProviders(await bridge.listProviders());
    } catch {
      await applyProviders([]);
    }
  }
}

async function refreshAll() {
  refreshing.value = true;
  errorMessage.value = "";

  try {
    await applyProviders(await bridge.refreshAll());
  } catch (error) {
    setError(error, "刷新失败");
  } finally {
    refreshing.value = false;
  }
}

function closeWindow() {
  window.close();
}

onMounted(async () => {
  window.__quotaSyncProviders = syncProviders;
  loading.value = true;
  await loadDue();
  loading.value = false;
  refreshTimer = window.setInterval(() => {
    void loadDue();
  }, 60 * 1000);
});

onBeforeUnmount(() => {
  if (window.__quotaSyncProviders === syncProviders) {
    delete window.__quotaSyncProviders;
  }
  window.clearInterval(refreshTimer);
});
</script>

<template>
  <main class="floating-shell">
    <header class="floating-header">
      <div class="floating-title">
        <WalletCards :size="20" />
        <span>AI 额度</span>
      </div>
      <div class="floating-actions">
        <button class="icon-button compact no-drag" type="button" title="刷新" aria-label="刷新" :disabled="refreshing" @click="refreshAll">
          <RefreshCw :size="17" :class="{ spinning: refreshing }" />
        </button>
        <button class="icon-button compact no-drag" type="button" title="关闭" aria-label="关闭" @click="closeWindow">
          <X :size="17" />
        </button>
      </div>
    </header>

    <p v-if="errorMessage" class="floating-notice">
      <AlertTriangle :size="15" />
      {{ errorMessage }}
    </p>

    <section v-if="loading" class="floating-empty">
      <Loader2 :size="22" class="spinning" />
      <span>加载中</span>
    </section>

    <section v-else-if="!providers.length" class="floating-empty">
      <WalletCards :size="24" />
      <span>暂无站点</span>
    </section>

    <section v-else class="floating-list">
      <article v-for="provider in providers" :key="provider.id" class="floating-item">
        <div>
          <div class="floating-name-row">
            <strong>{{ provider.name }}</strong>
            <span class="dot-status" :class="`tone-${providerStatus(provider).tone}`">
              <CheckCircle2 v-if="providerStatus(provider).tone === 'ok'" :size="13" />
              <AlertTriangle v-else-if="providerStatus(provider).tone === 'error'" :size="13" />
              {{ providerStatus(provider).text }}
            </span>
          </div>
        </div>
        <div class="floating-balance">
          <strong>{{ formatBalance(provider) }}</strong>
          <span>{{ provider.lastUnit || "USD" }}</span>
        </div>
        <div v-if="quotaProgress(provider) !== null" class="quota-progress floating-quota-progress" aria-label="额度使用进度">
          <div class="quota-progress-text">
            <span>{{ formatQuotaValue(provider.lastUsed) }} / {{ formatQuotaValue(provider.lastLimit) }}</span>
            <strong>{{ quotaProgress(provider)?.toFixed(1) }}%</strong>
          </div>
          <div class="quota-progress-track">
            <span :style="{ width: `${quotaProgress(provider)}%` }"></span>
          </div>
          <div v-if="provider.lastResetAt" class="quota-reset-row">
            <span class="quota-reset-text">下次重置 {{ formatDateTime(provider.lastResetAt) }}</span>
          </div>
        </div>
        <small>更新：{{ formatTime(provider.lastCheckedAt) }}</small>
        <p v-if="provider.lastError" class="floating-error">{{ provider.lastError }}</p>
      </article>
    </section>
  </main>
</template>
