<script setup lang="ts">
import {
  AlertTriangle,
  Clock3,
  Cloud,
  CloudOff,
  Loader2,
  MonitorUp,
  Plus,
  RefreshCw,
  Trash2,
  WalletCards
} from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { getQuotaBridge } from "../shared/bridge";
import { formatDateTime, formatQuotaValue, sumBalancesByUnit } from "../shared/format";
import { useGlassPointer } from "../shared/glass-pointer";
import type {
  OfficialProviderPresetSummary,
  ProviderTemplate,
  QuotaProvider,
  SyncState,
  TemplateId
} from "../shared/types";
import ProviderCard from "./components/ProviderCard.vue";
import ProviderEditor from "./components/ProviderEditor.vue";
import ThemeSwitcher from "./components/ThemeSwitcher.vue";

interface ProviderEditorHandle {
  openCreate(): void;
  edit(provider: QuotaProvider): void;
  closeIfEditing(providerId: string): void;
}

const bridge = getQuotaBridge();
const logoUrl = new URL("./logo.png", window.location.href).href;
const providers = ref<QuotaProvider[]>([]);
const providerTemplates = ref<ProviderTemplate[]>([]);
const officialPresets = ref<OfficialProviderPresetSummary[]>([]);
const syncState = ref<SyncState | null>(null);
const loading = ref(true);
const deleting = ref(false);
const refreshingAll = ref(false);
const refreshingDue = ref(false);
const errorMessage = ref("");
const refreshingIds = ref<string[]>([]);
const updatingFloatingVisibilityIds = ref<string[]>([]);
const pendingDeleteProvider = ref<QuotaProvider | null>(null);
const providerEditor = ref<ProviderEditorHandle | null>(null);
const providerCardSpans = reactive<Record<string, number>>({});
const isProviderMasonryReady = ref(false);
const providerCardElements = new Map<string, HTMLElement>();
const PROVIDER_MASONRY_GAP = 9;
let refreshTimer = 0;
let providerMasonryFrame = 0;
let providerResizeObserver: ResizeObserver | null = null;
let stopGlassPointer: (() => void) | null = null;

const providerCount = computed(() => providers.value.length);
const activeCount = computed(() => providers.value.filter((provider) => provider.status === "ok").length);
const balanceTotals = computed(() => sumBalancesByUnit(providers.value));
const lastCheckedAt = computed(() => {
  const timestamps = providers.value
    .map((provider) => (provider.lastCheckedAt ? Date.parse(provider.lastCheckedAt) : NaN))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
});
const syncTone = computed(() => {
  if (syncState.value?.state === 0) {
    return "ok";
  }
  return syncState.value?.state === 1 ? "warn" : "idle";
});

function setError(error: unknown, fallback: string) {
  errorMessage.value = error instanceof Error ? error.message : fallback;
}

function getTemplateName(templateId: TemplateId) {
  return providerTemplates.value.find((template) => template.id === templateId)?.name || "专业";
}

function openCreateModal() {
  errorMessage.value = "";
  providerEditor.value?.openCreate();
}

function editProvider(provider: QuotaProvider) {
  errorMessage.value = "";
  providerEditor.value?.edit(provider);
}

function requestDeleteProvider(provider: QuotaProvider) {
  pendingDeleteProvider.value = provider;
  errorMessage.value = "";
}

function closeDeleteDialog() {
  if (!deleting.value) {
    pendingDeleteProvider.value = null;
  }
}

function isRefreshing(id: string) {
  return refreshingIds.value.includes(id);
}

function setRefreshing(id: string, value: boolean) {
  refreshingIds.value = value
    ? [...new Set([...refreshingIds.value, id])]
    : refreshingIds.value.filter((item) => item !== id);
}

function isUpdatingFloatingVisibility(id: string) {
  return updatingFloatingVisibilityIds.value.includes(id);
}

function setUpdatingFloatingVisibility(id: string, value: boolean) {
  updatingFloatingVisibilityIds.value = value
    ? [...new Set([...updatingFloatingVisibilityIds.value, id])]
    : updatingFloatingVisibilityIds.value.filter((item) => item !== id);
}

async function loadSyncState() {
  try {
    syncState.value = await bridge.getSyncState();
  } catch (error) {
    syncState.value = {
      state: null,
      label: error instanceof Error ? error.message : "同步状态获取失败"
    };
  }
}

async function loadProviders() {
  providers.value = await bridge.listProviders();
}

async function refreshDueSilently() {
  if (refreshingDue.value || refreshingAll.value || refreshingIds.value.length || deleting.value) {
    return;
  }

  refreshingDue.value = true;
  try {
    const refreshedProviders = await bridge.refreshDueProviders();
    if (!deleting.value) {
      providers.value = refreshedProviders;
    }
  } catch (error) {
    if (!deleting.value) {
      setError(error, "自动刷新失败");
    }
  } finally {
    refreshingDue.value = false;
  }
}

async function bootstrap() {
  loading.value = true;
  errorMessage.value = "";
  try {
    const [, templates, presets, providerList] = await Promise.all([
      loadSyncState(),
      bridge.listProviderTemplates(),
      bridge.listOfficialProviderPresets(),
      bridge.listProviders()
    ]);
    providerTemplates.value = templates;
    officialPresets.value = presets;
    providers.value = providerList;
    await refreshDueSilently();
  } catch (error) {
    setError(error, "加载失败");
  } finally {
    loading.value = false;
  }
}

async function refreshProvider(provider: QuotaProvider) {
  setRefreshing(provider.id, true);
  errorMessage.value = "";
  try {
    const updated = await bridge.refreshProvider(provider.id);
    providers.value = providers.value.map((item) => (item.id === updated.id ? updated : item));
  } catch (error) {
    setError(error, "刷新失败");
  } finally {
    setRefreshing(provider.id, false);
  }
}

async function handleProviderSaved(savedProvider: QuotaProvider) {
  try {
    await loadProviders();
    await refreshProvider(
      providers.value.find((provider) => provider.id === savedProvider.id) || savedProvider
    );
  } catch (error) {
    setError(error, "保存后刷新失败");
  }
}

async function confirmDeleteProvider() {
  const provider = pendingDeleteProvider.value;
  if (!provider || deleting.value) {
    return;
  }

  deleting.value = true;
  errorMessage.value = "";
  try {
    await bridge.deleteProvider(provider.id);
    providers.value = providers.value.filter((item) => item.id !== provider.id);
    providerEditor.value?.closeIfEditing(provider.id);
    pendingDeleteProvider.value = null;
    try {
      await loadProviders();
    } catch (error) {
      const message = error instanceof Error ? error.message : "列表刷新失败";
      errorMessage.value = `删除成功，但列表刷新失败：${message}`;
    }
  } catch (error) {
    setError(error, "删除失败");
  } finally {
    deleting.value = false;
  }
}

async function refreshAll() {
  refreshingAll.value = true;
  errorMessage.value = "";
  try {
    providers.value = await bridge.refreshAll();
  } catch (error) {
    setError(error, "全部刷新失败");
  } finally {
    refreshingAll.value = false;
  }
}

async function openFloatingWindow() {
  errorMessage.value = "";
  try {
    await bridge.openFloatingWindow();
  } catch (error) {
    setError(error, "打开浮窗失败");
  }
}

async function toggleProviderFloatingVisibility(provider: QuotaProvider) {
  if (isUpdatingFloatingVisibility(provider.id)) {
    return;
  }

  const previousVisible = provider.showInFloatingWindow;
  const nextVisible = !previousVisible;
  setUpdatingFloatingVisibility(provider.id, true);
  errorMessage.value = "";
  providers.value = providers.value.map((item) =>
    item.id === provider.id ? { ...item, showInFloatingWindow: nextVisible } : item
  );

  try {
    const updated = await bridge.setProviderFloatingVisibility(provider.id, nextVisible);
    providers.value = providers.value.map((item) => (item.id === updated.id ? updated : item));
  } catch (error) {
    providers.value = providers.value.map((item) =>
      item.id === provider.id ? { ...item, showInFloatingWindow: previousVisible } : item
    );
    setError(error, "更新浮窗展示状态失败");
  } finally {
    setUpdatingFloatingVisibility(provider.id, false);
  }
}

function measureProviderMasonry() {
  providerMasonryFrame = 0;
  const activeIds = new Set(providers.value.map((provider) => provider.id));
  let measuredCount = 0;

  for (const provider of providers.value) {
    const element = providerCardElements.get(provider.id);
    if (!element?.isConnected) {
      continue;
    }
    const height = element.getBoundingClientRect().height;
    if (height <= 0) {
      continue;
    }
    providerCardSpans[provider.id] = Math.max(1, Math.ceil(height + PROVIDER_MASONRY_GAP));
    measuredCount += 1;
  }

  for (const providerId of Object.keys(providerCardSpans)) {
    if (!activeIds.has(providerId)) {
      delete providerCardSpans[providerId];
    }
  }
  isProviderMasonryReady.value = measuredCount === providers.value.length && measuredCount > 0;
}

function scheduleProviderMasonry() {
  if (!providerMasonryFrame) {
    providerMasonryFrame = window.requestAnimationFrame(measureProviderMasonry);
  }
}

function setProviderCardElement(providerId: string, element: unknown) {
  const previous = providerCardElements.get(providerId);
  const exposedElement =
    element && typeof element === "object" && "rootElement" in element
      ? (element as { rootElement?: unknown }).rootElement
      : null;
  const next = element instanceof HTMLElement
    ? element
    : exposedElement instanceof HTMLElement
      ? exposedElement
      : null;

  if (previous && previous !== next) {
    providerResizeObserver?.unobserve(previous);
    providerCardElements.delete(providerId);
  }
  if (next) {
    providerCardElements.set(providerId, next);
    providerResizeObserver?.observe(next);
  }
  if (providerCardElements.size !== providers.value.length) {
    isProviderMasonryReady.value = false;
  }
  scheduleProviderMasonry();
}

onMounted(() => {
  stopGlassPointer = useGlassPointer();
  providerResizeObserver = new ResizeObserver(scheduleProviderMasonry);
  for (const element of providerCardElements.values()) {
    providerResizeObserver.observe(element);
  }
  scheduleProviderMasonry();
  void bootstrap();
  refreshTimer = window.setInterval(() => {
    void refreshDueSilently();
  }, 60 * 1000);
});

onBeforeUnmount(() => {
  stopGlassPointer?.();
  providerResizeObserver?.disconnect();
  if (providerMasonryFrame) {
    window.cancelAnimationFrame(providerMasonryFrame);
  }
  window.clearInterval(refreshTimer);
});
</script>

<template>
  <main class="app-shell" data-glass-reactive>
    <section class="top-bar glass-surface">
      <div class="brand-block">
        <img class="brand-mark" :src="logoUrl" alt="" />
        <div class="brand-copy">
          <h1>Quota Dock</h1>
          <p>AI 额度看板 <span aria-hidden="true">·</span> {{ providerCount }} 个站点</p>
        </div>
      </div>
      <div class="header-actions">
        <div class="toolbar-group" aria-label="看板工具">
          <ThemeSwitcher />
          <button class="button button-ghost" type="button" @click="openFloatingWindow">
            <MonitorUp :size="16" />
            <span>浮窗</span>
          </button>
          <button class="button button-ghost" type="button" :disabled="refreshingAll || !providerCount" @click="refreshAll">
            <RefreshCw :size="16" :class="{ spinning: refreshingAll }" />
            <span>刷新</span>
          </button>
        </div>
        <button class="button button-primary" type="button" @click="openCreateModal">
          <Plus :size="16" />
          <span>添加站点</span>
        </button>
      </div>
    </section>

    <section class="summary-strip glass-surface" aria-label="额度概览">
      <article class="summary-chip">
        <span class="summary-label">总余额</span>
        <strong v-if="balanceTotals.length" class="summary-value summary-balance-values">
          <span v-for="item in balanceTotals" :key="item.unit">
            {{ formatQuotaValue(item.total) }} {{ item.unit }}
          </span>
        </strong>
        <strong v-else class="summary-value">--</strong>
      </article>
      <article class="summary-chip">
        <span class="summary-label">可用</span>
        <strong class="summary-value">{{ activeCount }} / {{ providerCount }}</strong>
      </article>
      <article class="summary-chip">
        <span class="summary-label">最近刷新</span>
        <strong class="summary-value">{{ formatDateTime(lastCheckedAt) }}</strong>
      </article>
      <article class="summary-chip" :class="`tone-${syncTone}`">
        <span class="summary-label">同步</span>
        <strong class="summary-value">
          <Cloud v-if="syncTone === 'ok'" :size="15" />
          <Clock3 v-else-if="syncTone === 'warn'" :size="15" />
          <CloudOff v-else :size="15" />
          {{ syncState?.label || "检查中" }}
        </strong>
      </article>
    </section>

    <p v-if="errorMessage" class="notice notice-error glass-surface" role="alert">
      <AlertTriangle :size="16" />
      {{ errorMessage }}
    </p>

    <section class="provider-panel" aria-label="站点额度列表">
      <div v-if="loading" class="empty-state glass-surface" aria-live="polite">
        <Loader2 :size="22" class="spinning" />
        <span>正在加载配置</span>
      </div>
      <div v-else-if="!providers.length" class="empty-state glass-surface">
        <span class="empty-state-icon"><WalletCards :size="27" /></span>
        <strong>还没有站点</strong>
        <span>添加一个平台，开始集中查看余额和额度。</span>
        <button class="button button-primary" type="button" @click="openCreateModal">
          <Plus :size="16" />
          添加站点
        </button>
      </div>
      <div v-else class="provider-list" :class="{ 'masonry-ready': isProviderMasonryReady }">
        <ProviderCard
          v-for="(provider, index) in providers"
          :key="provider.id"
          :ref="(element) => setProviderCardElement(provider.id, element)"
          :provider="provider"
          :template-name="getTemplateName(provider.templateId)"
          :refreshing="isRefreshing(provider.id)"
          :updating-floating-visibility="isUpdatingFloatingVisibility(provider.id)"
          :column="(index % 2) + 1"
          :row-span="providerCardSpans[provider.id] || 1"
          @refresh="refreshProvider(provider)"
          @edit="editProvider(provider)"
          @delete="requestDeleteProvider(provider)"
          @toggle-floating="toggleProviderFloatingVisibility(provider)"
        />
      </div>
    </section>

    <ProviderEditor
      ref="providerEditor"
      :provider-templates="providerTemplates"
      :official-presets="officialPresets"
      @saved="handleProviderSaved"
    />

    <teleport to="body">
      <Transition name="modal-fade">
        <div v-if="pendingDeleteProvider" class="modal-layer" @click.self="closeDeleteDialog">
          <section class="modal-card delete-modal glass-surface" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
            <div class="delete-icon"><Trash2 :size="24" /></div>
            <h2 id="delete-modal-title">删除站点</h2>
            <p>确认删除「{{ pendingDeleteProvider.name }}」？配置和加密保存的 API Key 会一起删除。</p>
            <div class="modal-actions">
              <button class="button button-ghost" type="button" :disabled="deleting" @click="closeDeleteDialog">取消</button>
              <button class="button button-danger" type="button" :disabled="deleting" @click="confirmDeleteProvider">
                <Loader2 v-if="deleting" :size="16" class="spinning" />
                <Trash2 v-else :size="16" />
                删除
              </button>
            </div>
          </section>
        </div>
      </Transition>
    </teleport>
  </main>
</template>
