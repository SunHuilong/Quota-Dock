<script setup lang="ts">
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Cloud,
  CloudOff,
  Eye,
  EyeOff,
  Info,
  Loader2,
  MonitorUp,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Send,
  Trash2,
  WalletCards,
  X
} from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { getQuotaBridge } from "../shared/bridge";
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
  quotaRemainingPercent,
  sumBalancesByUnit
} from "../shared/format";
import type {
  AuthPlacement,
  JsonPathKey,
  JsonPathMap,
  OfficialProviderInput,
  OfficialProviderPresetSummary,
  ProviderInput,
  ProviderMode,
  QuotaMeter,
  QuotaProvider,
  QuotaSnapshot,
  RelayProviderInput,
  RequestMethod,
  SyncState,
  TemplateId
} from "../shared/types";

interface JsonLeaf {
  path: string;
  value: unknown;
  preview: string;
}

interface TemplatePreset {
  id: TemplateId;
  name: string;
  requestPath: string;
  requestMethod: RequestMethod;
  authPlacement: AuthPlacement;
  requestHeaders: string;
  requestBody: string;
  jsonPaths: JsonPathMap;
}

const DEFAULT_REQUEST_PATH = "/v1/usage";
const DEFAULT_UNIT = "USD";
const DEFAULT_HEADER_HEADERS = `{
  "Authorization": "Bearer {{token}}",
  "Accept": "application/json"
}`;
const DEFAULT_BODY_HEADERS = `{
  "Accept": "application/json",
  "Content-Type": "application/json"
}`;
const DEFAULT_BODY_TEMPLATE = `{
  "token": "{{token}}"
}`;
const JSON_PATH_KEYS: JsonPathKey[] = ["balance", "used", "limit", "resetAt", "unit"];
const JSON_PATH_LABELS: Record<JsonPathKey, string> = {
  balance: "余额",
  used: "已用余额",
  limit: "总额度",
  resetAt: "重置时间",
  unit: "单位"
};
const TEMPLATE_PRESETS: TemplatePreset[] = [
  {
    id: "openai-usage",
    name: "Sub2API - 订阅",
    requestPath: DEFAULT_REQUEST_PATH,
    requestMethod: "GET",
    authPlacement: "header",
    requestHeaders: DEFAULT_HEADER_HEADERS,
    requestBody: "",
    jsonPaths: {
      balance: "",
      used: "subscription.daily_usage_usd",
      limit: "subscription.daily_limit_usd",
      resetAt: "",
      unit: ""
    }
  },
  {
    id: "rate-limits",
    name: "Sub2API - 刷新限额",
    requestPath: DEFAULT_REQUEST_PATH,
    requestMethod: "GET",
    authPlacement: "header",
    requestHeaders: DEFAULT_HEADER_HEADERS,
    requestBody: "",
    jsonPaths: {
      balance: "rate_limits[0].remaining",
      used: "rate_limits[0].used",
      limit: "rate_limits[0].limit",
      resetAt: "rate_limits[0].reset_at",
      unit: ""
    }
  },
  {
    id: "custom",
    name: "专业",
    requestPath: DEFAULT_REQUEST_PATH,
    requestMethod: "GET",
    authPlacement: "header",
    requestHeaders: DEFAULT_HEADER_HEADERS,
    requestBody: "",
    jsonPaths: createEmptyJsonPaths()
  }
];

const bridge = getQuotaBridge();
const providers = ref<QuotaProvider[]>([]);
const officialPresets = ref<OfficialProviderPresetSummary[]>([]);
const syncState = ref<SyncState | null>(null);
const loading = ref(true);
const saving = ref(false);
const deleting = ref(false);
const refreshingAll = ref(false);
const refreshingDue = ref(false);
const showApiKey = ref(false);
const errorMessage = ref("");
const providerFormErrorMessage = ref("");
const refreshingIds = ref<string[]>([]);
const isProviderModalOpen = ref(false);
const isTemplateConfigOpen = ref(false);
const isOptionalSettingsOpen = ref(false);
const isJsonPreviewOpen = ref(false);
const pendingDeleteProvider = ref<QuotaProvider | null>(null);
const testingRequest = ref(false);
const testResponse = ref<unknown | null>(null);
const testSnapshot = ref<QuotaSnapshot | null>(null);
const testMessage = ref("");
const selectedJsonLeaf = ref<JsonLeaf | null>(null);
let refreshTimer = 0;

const form = reactive({
  id: "",
  mode: "relay" as ProviderMode,
  name: "",
  officialPresetId: "",
  baseUrl: "",
  apiKey: "",
  templateId: "openai-usage" as TemplateId,
  requestPath: DEFAULT_REQUEST_PATH,
  requestMethod: "GET" as RequestMethod,
  authPlacement: "header" as AuthPlacement,
  requestHeaders: DEFAULT_HEADER_HEADERS,
  requestBody: "",
  jsonPaths: createEmptyJsonPaths(),
  manualLimit: "" as number | "",
  currencyOverride: "",
  defaultUnit: DEFAULT_UNIT,
  priceMultiplier: 1,
  refreshIntervalMinutes: 30
});

const isEditing = computed(() => Boolean(form.id));
const selectedOfficialPreset = computed(
  () => officialPresets.value.find((preset) => preset.id === form.officialPresetId) || null
);
const officialPresetGroups = computed(() => {
  const groups = new Map<string, OfficialProviderPresetSummary[]>();
  for (const preset of officialPresets.value) {
    const items = groups.get(preset.categoryLabel) || [];
    items.push(preset);
    groups.set(preset.categoryLabel, items);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
});
const providerCount = computed(() => providers.value.length);
const activeCount = computed(
  () =>
    providers.value.filter(
      (provider) =>
        provider.lastCheckedAt &&
        !provider.lastError &&
        provider.lastIsValid !== false &&
        (provider.mode !== "official" || provider.officialPresetAvailable)
    ).length
);
const balanceTotals = computed(() => sumBalancesByUnit(providers.value));
const lastCheckedAt = computed(() => {
  const timestamps = providers.value
    .map((provider) => (provider.lastCheckedAt ? Date.parse(provider.lastCheckedAt) : NaN))
    .filter((value) => Number.isFinite(value));

  if (!timestamps.length) {
    return null;
  }

  return new Date(Math.max(...timestamps)).toISOString();
});
const syncTone = computed(() => {
  if (syncState.value?.state === 0) {
    return "ok";
  }

  if (syncState.value?.state === 1) {
    return "warn";
  }

  return "idle";
});
const jsonLeaves = computed(() => (testResponse.value === null ? [] : flattenJson(testResponse.value)));
const testJsonText = computed(() => (testResponse.value === null ? "" : JSON.stringify(testResponse.value, null, 2)));

function createEmptyJsonPaths(): JsonPathMap {
  return {
    balance: "",
    used: "",
    limit: "",
    resetAt: "",
    unit: ""
  };
}

function getTemplatePreset(templateId: TemplateId) {
  return TEMPLATE_PRESETS.find((template) => template.id === templateId) || TEMPLATE_PRESETS[0];
}

function getTemplateName(templateId: TemplateId) {
  return getTemplatePreset(templateId).name;
}

function applyTemplatePreset(templateId: TemplateId) {
  const template = getTemplatePreset(templateId);
  form.templateId = template.id;
  form.requestPath = template.requestPath;
  form.requestMethod = template.requestMethod;
  form.authPlacement = template.authPlacement;
  form.requestHeaders = template.requestHeaders;
  form.requestBody = template.requestBody;
  Object.assign(form.jsonPaths, createEmptyJsonPaths(), template.jsonPaths);
  form.manualLimit = "";
  form.defaultUnit = DEFAULT_UNIT;
  form.priceMultiplier = 1;
  isTemplateConfigOpen.value = template.id === "custom";
  resetTestResult();
}

function defaultHeadersForAuth(authPlacement: AuthPlacement) {
  return authPlacement === "body" ? DEFAULT_BODY_HEADERS : DEFAULT_HEADER_HEADERS;
}

function defaultBodyForAuth(authPlacement: AuthPlacement) {
  return authPlacement === "body" ? DEFAULT_BODY_TEMPLATE : "";
}

function setError(error: unknown, fallback: string) {
  errorMessage.value = error instanceof Error ? error.message : fallback;
}

function setProviderFormError(error: unknown, fallback: string) {
  providerFormErrorMessage.value = error instanceof Error ? error.message : fallback;
}

function resetTestResult() {
  testResponse.value = null;
  testSnapshot.value = null;
  testMessage.value = "";
  selectedJsonLeaf.value = null;
}

function isJsonPathRequired(key: JsonPathKey) {
  const hasManualLimit = form.manualLimit !== "";

  if (key === "balance") {
    return (!form.jsonPaths.limit && !hasManualLimit) || !form.jsonPaths.used;
  }

  if (key === "limit") {
    return !form.jsonPaths.balance && !hasManualLimit;
  }

  return key === "used" && !form.jsonPaths.balance;
}

function resetForm(mode: ProviderMode = "relay") {
  isJsonPreviewOpen.value = false;
  isOptionalSettingsOpen.value = false;
  form.id = "";
  form.mode = mode;
  form.name = "";
  form.officialPresetId = mode === "official" ? officialPresets.value[0]?.id || "" : "";
  form.baseUrl = "";
  form.apiKey = "";
  applyTemplatePreset("openai-usage");
  form.manualLimit = "";
  form.currencyOverride = "";
  form.refreshIntervalMinutes = 30;
  showApiKey.value = false;
  providerFormErrorMessage.value = "";
  resetTestResult();
}

function openCreateModal() {
  resetForm("official");
  errorMessage.value = "";
  isProviderModalOpen.value = true;
}

function switchCreateMode(mode: ProviderMode) {
  if (isEditing.value || form.mode === mode) {
    return;
  }

  resetForm(mode);
}

function closeProviderModal() {
  if (saving.value) {
    return;
  }

  isProviderModalOpen.value = false;
  resetForm();
}

function editProvider(provider: QuotaProvider) {
  isJsonPreviewOpen.value = false;
  form.id = provider.id;
  form.mode = provider.mode;
  form.name = provider.name;
  form.officialPresetId = provider.officialPresetId || "";
  form.baseUrl = provider.baseUrl;
  form.apiKey = "";
  form.templateId = provider.templateId || "openai-usage";
  form.requestPath = provider.requestPath || DEFAULT_REQUEST_PATH;
  form.requestMethod = provider.requestMethod || "GET";
  form.authPlacement = provider.authPlacement || "header";
  form.requestHeaders = provider.requestHeaders || defaultHeadersForAuth(form.authPlacement);
  form.requestBody = provider.requestBody || defaultBodyForAuth(form.authPlacement);
  Object.assign(form.jsonPaths, createEmptyJsonPaths(), provider.jsonPaths || {});
  form.manualLimit = provider.manualLimit ?? "";
  form.currencyOverride = provider.currencyOverride || "";
  form.defaultUnit = provider.defaultUnit || DEFAULT_UNIT;
  form.priceMultiplier = provider.priceMultiplier ?? 1;
  isTemplateConfigOpen.value = form.templateId === "custom";
  form.refreshIntervalMinutes = provider.refreshIntervalMinutes;
  showApiKey.value = false;
  errorMessage.value = "";
  providerFormErrorMessage.value = "";
  resetTestResult();
  isProviderModalOpen.value = true;
}

function applyOfficialPreset() {
  form.manualLimit = "";
  form.currencyOverride = "";
  resetTestResult();
}

function selectOfficialPreset(presetId: string) {
  if (form.officialPresetId === presetId) {
    return;
  }

  form.officialPresetId = presetId;
  applyOfficialPreset();
}

function requestDeleteProvider(provider: QuotaProvider) {
  pendingDeleteProvider.value = provider;
  errorMessage.value = "";
}

function closeDeleteDialog() {
  if (deleting.value) {
    return;
  }

  pendingDeleteProvider.value = null;
}

function isRefreshing(id: string) {
  return refreshingIds.value.includes(id);
}

function setRefreshing(id: string, value: boolean) {
  refreshingIds.value = value
    ? [...new Set([...refreshingIds.value, id])]
    : refreshingIds.value.filter((item) => item !== id);
}

function setRequestMethod(method: RequestMethod) {
  form.requestMethod = method;
  if (method === "GET" && form.authPlacement === "body") {
    form.authPlacement = "header";
    form.requestHeaders = defaultHeadersForAuth("header");
    form.requestBody = "";
  }
  if (method === "POST" && !form.requestBody) {
    form.requestBody = defaultBodyForAuth(form.authPlacement);
  }
  resetTestResult();
}

function setAuthPlacement(authPlacement: AuthPlacement) {
  form.authPlacement = authPlacement;
  if (authPlacement === "body") {
    form.requestMethod = "POST";
  }
  form.requestHeaders = defaultHeadersForAuth(authPlacement);
  form.requestBody = defaultBodyForAuth(authPlacement);
  resetTestResult();
}

function buildProviderInput(): ProviderInput {
  if (form.mode === "official") {
    const input: OfficialProviderInput = {
      id: form.id || undefined,
      mode: "official",
      name: form.name,
      officialPresetId: form.officialPresetId,
      apiKey: form.apiKey,
      manualLimit: form.manualLimit === "" ? null : form.manualLimit,
      currencyOverride: form.currencyOverride,
      refreshIntervalMinutes: form.refreshIntervalMinutes
    };
    return input;
  }

  const input: RelayProviderInput = {
    id: form.id || undefined,
    mode: "relay",
    name: form.name,
    baseUrl: form.baseUrl,
    apiKey: form.apiKey,
    templateId: form.templateId,
    requestPath: form.requestPath,
    requestMethod: form.requestMethod,
    authPlacement: form.authPlacement,
    requestHeaders: form.requestHeaders,
    requestBody: form.requestBody,
    jsonPaths: { ...form.jsonPaths },
    manualLimit: form.manualLimit === "" ? null : form.manualLimit,
    defaultUnit: form.defaultUnit,
    priceMultiplier: form.priceMultiplier,
    refreshIntervalMinutes: form.refreshIntervalMinutes
  };
  return input;
}

function getPrimaryMeter(provider: QuotaProvider) {
  return primaryMeter(provider);
}

function additionalMeters(provider: QuotaProvider) {
  const primaryId = getPrimaryMeter(provider)?.id;
  return provider.lastMeters.filter((meter) => meter.id !== primaryId);
}

function meterUsageText(meter: QuotaMeter) {
  if (meter.limit !== null && meter.used !== null) {
    return `已用 ${formatQuotaValue(meter.used)} / ${formatQuotaValue(meter.limit)}`;
  }
  if (meter.used !== null && meter.remaining === null) {
    return `已用 ${formatQuotaValue(meter.used)}`;
  }
  return "";
}

function formatJsonPreview(value: unknown) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const text = raw === undefined ? String(value) : raw;
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function appendJsonPath(parentPath: string, segment: string | number) {
  if (typeof segment === "number") {
    return `${parentPath}[${segment}]`;
  }

  if (/^[A-Za-z_$][\w$]*$/.test(segment)) {
    return parentPath ? `${parentPath}.${segment}` : segment;
  }

  return `${parentPath}[${JSON.stringify(segment)}]`;
}

function flattenJson(value: unknown, path = ""): JsonLeaf[] {
  if (Array.isArray(value)) {
    if (!value.length) {
      return [{ path: path || "$", value, preview: "[]" }];
    }

    return value.flatMap((item, index) => flattenJson(item, appendJsonPath(path, index)));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) {
      return [{ path: path || "$", value, preview: "{}" }];
    }

    return entries.flatMap(([key, item]) => flattenJson(item, appendJsonPath(path, key)));
  }

  return [{ path: path || "$", value, preview: formatJsonPreview(value) }];
}

function getJsonPathPreview(key: JsonPathKey) {
  const path = form.jsonPaths[key];
  return jsonLeaves.value.find((leaf) => leaf.path === path)?.preview || "--";
}

function updateManualLimit(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  form.manualLimit = value === "" ? "" : Number(value);

  if (value !== "") {
    form.jsonPaths.limit = "";
  }
}

function selectJsonLeaf(leaf: JsonLeaf) {
  selectedJsonLeaf.value = leaf;
}

function setSelectedPath(target: JsonPathKey) {
  if (!selectedJsonLeaf.value) {
    return;
  }

  if (target === "limit") {
    form.manualLimit = "";
  }

  if (target === "unit") {
    const unit = String(selectedJsonLeaf.value.value ?? "").trim();
    if (unit) {
      form.defaultUnit = unit;
    }
  }

  form.jsonPaths[target] = selectedJsonLeaf.value.path;
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

async function loadOfficialPresets() {
  officialPresets.value = await bridge.listOfficialProviderPresets();
}

async function refreshDueSilently() {
  if (refreshingDue.value || refreshingAll.value || refreshingIds.value.length > 0 || deleting.value) {
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
    await Promise.all([loadSyncState(), loadOfficialPresets(), loadProviders()]);
    await refreshDueSilently();
  } catch (error) {
    setError(error, "加载失败");
  } finally {
    loading.value = false;
  }
}

async function saveProvider() {
  saving.value = true;
  providerFormErrorMessage.value = "";

  try {
    const savedProvider = await bridge.saveProvider(buildProviderInput());
    isProviderModalOpen.value = false;
    resetForm();
    await loadProviders();
    await refreshProvider(savedProvider);
  } catch (error) {
    setProviderFormError(error, "保存失败");
  } finally {
    saving.value = false;
  }
}

async function sendTestRequest() {
  testingRequest.value = true;
  providerFormErrorMessage.value = "";
  testMessage.value = "";
  selectedJsonLeaf.value = null;

  try {
    const input = buildProviderInput();
    if (input.mode === "official") {
      testResponse.value = null;
      testSnapshot.value = await bridge.testOfficialProvider(input);
      testMessage.value = "额度查询成功";
    } else {
      testSnapshot.value = null;
      testResponse.value = await bridge.testProviderRequest(input);
      testMessage.value = "已获取 JSON 响应";
    }
  } catch (error) {
    testResponse.value = null;
    testSnapshot.value = null;
    setProviderFormError(error, "发送失败");
  } finally {
    testingRequest.value = false;
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
    if (form.id === provider.id) {
      resetForm();
      isProviderModalOpen.value = false;
    }
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

async function refreshProvider(provider: QuotaProvider) {
  setRefreshing(provider.id, true);
  errorMessage.value = "";

  try {
    const updated = await bridge.refreshProvider(provider.id);
    providers.value = providers.value.map((item) => (item.id === updated.id ? updated : item));
    await bridge.syncFloatingWindow();
  } catch (error) {
    setError(error, "刷新失败");
  } finally {
    setRefreshing(provider.id, false);
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

onMounted(() => {
  void bootstrap();
  refreshTimer = window.setInterval(() => {
    void refreshDueSilently();
  }, 60 * 1000);
});

onBeforeUnmount(() => {
  window.clearInterval(refreshTimer);
});
</script>

<template>
  <main class="app-shell">
    <section class="top-bar">
      <div class="brand-block compact-brand">
        <div>
          <h1>AI 额度查询</h1>
          <p>{{ providerCount }} 个站点</p>
        </div>
      </div>
      <div class="header-actions">
        <button class="button button-ghost" type="button" @click="openFloatingWindow">
          <MonitorUp :size="16" />
          浮窗
        </button>
        <button class="button button-ghost" type="button" :disabled="refreshingAll || !providerCount" @click="refreshAll">
          <RefreshCw :size="16" :class="{ spinning: refreshingAll }" />
          刷新
        </button>
        <button class="button button-primary" type="button" @click="openCreateModal">
          <Plus :size="16" />
          添加站点
        </button>
      </div>
    </section>

    <section class="summary-strip" aria-label="额度概览">
      <article class="summary-chip">
        <span>总余额</span>
        <strong v-if="balanceTotals.length" class="summary-balance-values">
          <span v-for="item in balanceTotals" :key="item.unit">
            {{ formatQuotaValue(item.total) }} {{ item.unit }}
          </span>
        </strong>
        <strong v-else>--</strong>
      </article>
      <article class="summary-chip">
        <span>可用</span>
        <strong>{{ activeCount }} / {{ providerCount }}</strong>
      </article>
      <article class="summary-chip">
        <span>最近刷新</span>
        <strong>{{ formatDateTime(lastCheckedAt) }}</strong>
      </article>
      <article class="summary-chip" :class="`tone-${syncTone}`">
        <span>同步</span>
        <strong>
          <Cloud v-if="syncTone === 'ok'" :size="15" />
          <Clock3 v-else-if="syncTone === 'warn'" :size="15" />
          <CloudOff v-else :size="15" />
          {{ syncState?.label || "检查中" }}
        </strong>
      </article>
    </section>

    <p v-if="errorMessage" class="notice notice-error">
      <AlertTriangle :size="16" />
      {{ errorMessage }}
    </p>

    <section class="provider-panel">
      <div v-if="loading" class="empty-state">
        <Loader2 :size="22" class="spinning" />
        <span>正在加载配置</span>
      </div>

      <div v-else-if="!providers.length" class="empty-state">
        <WalletCards :size="26" />
        <span>还没有站点</span>
        <button class="button button-primary" type="button" @click="openCreateModal">
          <Plus :size="16" />
          添加站点
        </button>
      </div>

      <div v-else class="provider-list">
        <article v-for="provider in providers" :key="provider.id" class="provider-item">
          <div class="provider-main">
            <div class="provider-info">
              <div class="provider-title-row">
                <h3>{{ provider.name }}</h3>
                <span class="template-pill">
                  {{ provider.mode === "official" ? provider.officialPresetName || "预设不可用" : getTemplateName(provider.templateId) }}
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
                  <span>已用 {{ formatQuotaValue(provider.lastUsed) }} / {{ formatQuotaValue(provider.lastLimit) }}</span>
                  <strong>{{ quotaRemainingPercent(provider)?.toFixed(1) }}%</strong>
                </div>
                <div class="quota-progress-row">
                  <div class="quota-progress-track">
                    <span :style="{ width: `${quotaProgress(provider)}%` }"></span>
                  </div>
                </div>
                <div v-if="provider.lastResetAt" class="quota-reset-row">
                  <span class="quota-reset-text">下次重置 {{ formatDateTime(provider.lastResetAt) }}</span>
                </div>
              </div>

              <div v-if="additionalMeters(provider).length" class="additional-meter-list">
                <div v-for="meter in additionalMeters(provider)" :key="meter.id" class="additional-meter">
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
                <span class="provider-balance-label">{{ getPrimaryMeter(provider)?.label || "可用额度" }}</span>
                <strong>{{ formatBalance(provider) }}</strong>
                <div class="provider-balance-meta">
                  <span class="provider-unit">
                    {{ getPrimaryMeter(provider)?.unit || provider.lastUnit || provider.defaultUnit || "USD" }}
                  </span>
                  <span class="provider-updated-time">{{ formatTime(provider.lastCheckedAt) }}</span>
                  <button
                    class="provider-refresh-button"
                    type="button"
                    title="刷新额度"
                    aria-label="刷新额度"
                    :disabled="isRefreshing(provider.id)"
                    @click="refreshProvider(provider)"
                  >
                    <RefreshCw :size="13" :class="{ spinning: isRefreshing(provider.id) }" />
                  </button>
                </div>
              </div>

              <div class="provider-actions">
                <button class="icon-button" type="button" title="编辑" aria-label="编辑" @click="editProvider(provider)">
                  <Pencil :size="15" />
                </button>
                <button class="icon-button danger" type="button" title="删除" aria-label="删除" @click="requestDeleteProvider(provider)">
                  <Trash2 :size="15" />
                </button>
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>

    <teleport to="body">
      <div v-if="isProviderModalOpen" class="modal-layer" @click.self="closeProviderModal">
        <form class="modal-card provider-modal" @submit.prevent="saveProvider">
          <div class="modal-heading">
            <div>
              <p class="eyebrow">{{ form.mode === "official" ? "Preset Provider" : "Relay Provider" }}</p>
              <h2>{{ isEditing ? "编辑站点" : "添加站点" }}</h2>
            </div>
            <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeProviderModal">
              <X :size="18" />
            </button>
          </div>

          <div class="segmented-control create-mode-tabs" role="tablist" aria-label="站点类型">
            <button
              class="segment-button"
              :class="{ active: form.mode === 'official' }"
              type="button"
              role="tab"
              :aria-selected="form.mode === 'official'"
              :disabled="isEditing"
              @click="switchCreateMode('official')"
            >
              官方
            </button>
            <button
              class="segment-button"
              :class="{ active: form.mode === 'relay' }"
              type="button"
              role="tab"
              :aria-selected="form.mode === 'relay'"
              :disabled="isEditing"
              @click="switchCreateMode('relay')"
            >
              专业模式
            </button>
          </div>

          <section v-if="form.mode === 'official'" class="official-preset-picker" aria-labelledby="official-preset-label">
            <div class="official-preset-head">
              <span id="official-preset-label">提供商</span>
            </div>
            <div class="official-preset-groups" role="radiogroup" aria-labelledby="official-preset-label">
              <div v-if="form.officialPresetId && !selectedOfficialPreset" class="preset-option-list">
                <button class="preset-option active" type="button" role="radio" aria-checked="true" disabled>
                  <span>预设不可用</span>
                  <AlertTriangle :size="15" />
                </button>
              </div>
              <section v-for="group in officialPresetGroups" :key="group.label" class="preset-group">
                <h3>{{ group.label }}</h3>
                <div class="preset-option-list">
                  <button
                    v-for="preset in group.items"
                    :key="preset.id"
                    class="preset-option"
                    :class="{ active: form.officialPresetId === preset.id }"
                    type="button"
                    role="radio"
                    :aria-checked="form.officialPresetId === preset.id"
                    :disabled="isEditing"
                    @click="selectOfficialPreset(preset.id)"
                  >
                    <span>{{ preset.name }}</span>
                    <CheckCircle2 v-if="form.officialPresetId === preset.id" :size="15" />
                  </button>
                </div>
              </section>
            </div>
          </section>

          <div v-if="form.mode === 'relay'" class="form-row name-interval-row">
            <label class="field name-field compact-field">
              <span>名称</span>
              <input v-model.trim="form.name" autocomplete="off" placeholder="例如：主用站点" required />
            </label>

            <label class="field interval-field compact-field">
              <span>更新间隔</span>
              <div class="interval-row">
                <input v-model.number="form.refreshIntervalMinutes" type="number" min="1" max="1440" required />
                <span>分钟</span>
              </div>
            </label>
          </div>

          <div v-if="form.mode === 'relay'" class="field">
            <span>模板</span>
            <select v-model="form.templateId" @change="applyTemplatePreset(form.templateId)">
              <option v-for="template in TEMPLATE_PRESETS" :key="template.id" :value="template.id">
                {{ template.name }}
              </option>
            </select>
          </div>

          <label v-if="form.mode === 'relay'" class="field">
            <span>Base URL</span>
            <input v-model.trim="form.baseUrl" autocomplete="off" placeholder="https://api.example.com" required />
          </label>

          <label class="field">
            <span>{{ form.mode === "official" ? selectedOfficialPreset?.credentialLabel || "API Key" : "API Key" }}</span>
            <div class="secret-input">
              <input
                v-model.trim="form.apiKey"
                :type="showApiKey ? 'text' : 'password'"
                autocomplete="off"
                :placeholder="isEditing ? '留空则保持原 Key' : form.mode === 'official' ? selectedOfficialPreset?.credentialPlaceholder || 'sk-...' : 'sk-...'"
                :required="!isEditing"
              />
              <button class="icon-button" type="button" title="显示或隐藏 API Key" aria-label="显示或隐藏 API Key" @click="showApiKey = !showApiKey">
                <EyeOff v-if="showApiKey" :size="18" />
                <Eye v-else :size="18" />
              </button>
            </div>
            <small v-if="form.mode === 'official' && selectedOfficialPreset?.credentialHelp" class="field-help">
              {{ selectedOfficialPreset.credentialHelp }}
            </small>
          </label>

          <section
            v-if="form.mode === 'official'"
            class="template-config official-options"
            :class="{ collapsed: !isOptionalSettingsOpen }"
          >
            <button
              class="template-config-toggle"
              type="button"
              :aria-expanded="isOptionalSettingsOpen"
              title="展开或收起可选设置"
              @click="isOptionalSettingsOpen = !isOptionalSettingsOpen"
            >
              <span>可选设置</span>
              <ChevronDown v-if="isOptionalSettingsOpen" :size="17" />
              <ChevronRight v-else :size="17" />
            </button>

            <div v-if="isOptionalSettingsOpen" class="template-config-body">
              <label class="field">
                <span>别名</span>
                <input v-model.trim="form.name" autocomplete="off" :placeholder="selectedOfficialPreset?.name || '使用提供商名称'" />
              </label>

              <div class="form-row two-columns official-option-grid">
                <label v-if="selectedOfficialPreset?.supportsManualLimit !== false" class="field compact-field">
                  <span>总额度</span>
                  <input
                    v-model.number="form.manualLimit"
                    type="number"
                    min="0"
                    step="any"
                    autocomplete="off"
                    placeholder="选填"
                  />
                </label>

                <label v-if="selectedOfficialPreset?.supportsCurrencyOverride !== false" class="field compact-field">
                  <span>货币</span>
                  <input
                    v-model.trim="form.currencyOverride"
                    autocomplete="off"
                    :placeholder="selectedOfficialPreset?.defaultUnit || 'USD'"
                  />
                </label>

                <label class="field compact-field">
                  <span>更新间隔</span>
                  <div class="interval-row">
                    <input v-model.number="form.refreshIntervalMinutes" type="number" min="1" max="1440" required />
                    <span>分钟</span>
                  </div>
                </label>
              </div>
            </div>
          </section>

          <section v-if="form.mode === 'official' && testSnapshot" class="official-test-result">
            <div class="json-result-head">
              <strong>查询结果</strong>
              <span>{{ testSnapshot.meters.length }} 项额度</span>
            </div>
            <div class="official-test-meter-list">
              <div v-for="meter in testSnapshot.meters" :key="meter.id" class="official-test-meter">
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
              </div>
            </div>
          </section>

          <section v-if="form.mode === 'relay'" class="template-config" :class="{ collapsed: !isTemplateConfigOpen }">
            <button
              class="template-config-toggle"
              type="button"
              :aria-expanded="isTemplateConfigOpen"
              title="展开或收起路由与响应配置"
              @click="isTemplateConfigOpen = !isTemplateConfigOpen"
            >
              <span>路由与响应配置</span>
              <ChevronDown v-if="isTemplateConfigOpen" :size="17" />
              <ChevronRight v-else :size="17" />
            </button>

            <div v-if="isTemplateConfigOpen" class="template-config-body">
              <label class="field">
                <span>Path</span>
                <input v-model.trim="form.requestPath" autocomplete="off" placeholder="/v1/usage" required />
              </label>

              <div class="form-row two-columns">
                <div class="field compact-field">
                  <span>请求方式</span>
                  <div class="segmented-control">
                    <button
                      class="segment-button"
                      :class="{ active: form.requestMethod === 'GET' }"
                      type="button"
                      @click="setRequestMethod('GET')"
                    >
                      GET
                    </button>
                    <button
                      class="segment-button"
                      :class="{ active: form.requestMethod === 'POST' }"
                      type="button"
                      @click="setRequestMethod('POST')"
                    >
                      POST
                    </button>
                  </div>
                </div>

                <div class="field compact-field">
                  <span>鉴权位置</span>
                  <div class="segmented-control">
                    <button
                      class="segment-button"
                      :class="{ active: form.authPlacement === 'header' }"
                      type="button"
                      @click="setAuthPlacement('header')"
                    >
                      Header
                    </button>
                    <button
                      class="segment-button"
                      :class="{ active: form.authPlacement === 'body' }"
                      type="button"
                      @click="setAuthPlacement('body')"
                    >
                      Body
                    </button>
                  </div>
                </div>
              </div>

              <label class="field">
                <span>Headers JSON</span>
                <textarea v-model.trim="form.requestHeaders" spellcheck="false" rows="4" required />
              </label>

              <label v-if="form.requestMethod === 'POST'" class="field">
                <span>Body JSON</span>
                <textarea v-model.trim="form.requestBody" spellcheck="false" rows="4" />
              </label>

              <p class="path-preview-note">
                <Info :size="14" />
                <span>右侧路径预览来自测试响应，实际数据会在刷新时实时获取。</span>
              </p>

              <div class="path-map">
                <label class="field compact-field">
                  <span>价格倍率</span>
                  <input
                    v-model.number="form.priceMultiplier"
                    type="number"
                    min="0"
                    step="any"
                    autocomplete="off"
                    placeholder="1"
                    required
                  />
                </label>

                <div v-for="key in JSON_PATH_KEYS" :key="key" class="field compact-field">
                  <span>{{ JSON_PATH_LABELS[key] }}路径</span>
                  <div class="path-control">
                    <span v-if="key === 'limit' && form.manualLimit !== ''" class="path-mode-status">
                      当前使用手填总额度
                    </span>
                    <input
                      v-else
                      v-model.trim="form.jsonPaths[key]"
                      :class="{ 'path-mode-input': key === 'unit' && !form.jsonPaths.unit }"
                      autocomplete="off"
                      :aria-label="`${JSON_PATH_LABELS[key]}路径`"
                      :placeholder="key === 'unit' && !form.jsonPaths.unit ? '当前使用手填单位' : ''"
                      :required="isJsonPathRequired(key)"
                    />
                    <input
                      v-if="key === 'limit'"
                      :value="form.manualLimit"
                      class="path-value path-value-input"
                      type="number"
                      step="any"
                      autocomplete="off"
                      aria-label="手填总额度"
                      :placeholder="getJsonPathPreview(key)"
                      @input="updateManualLimit"
                    />
                    <input
                      v-else-if="key === 'unit'"
                      v-model.trim="form.defaultUnit"
                      class="path-value path-value-input"
                      type="text"
                      autocomplete="off"
                      aria-label="默认单位"
                      :placeholder="getJsonPathPreview(key)"
                      required
                    />
                    <span v-else class="path-value path-value-preview" :title="getJsonPathPreview(key)">
                      {{ getJsonPathPreview(key) }}
                    </span>
                  </div>
                </div>
              </div>

              <section v-if="testResponse !== null" class="json-result">
                <div class="json-result-head">
                  <strong>JSON 响应</strong>
                  <span>{{ jsonLeaves.length }} 个参数</span>
                </div>

                <div class="json-leaf-list">
                  <button
                    v-for="leaf in jsonLeaves"
                    :key="leaf.path"
                    class="json-leaf"
                    :class="{ selected: selectedJsonLeaf?.path === leaf.path }"
                    type="button"
                    @click="selectJsonLeaf(leaf)"
                  >
                    <code>{{ leaf.path }}</code>
                    <span>{{ leaf.preview }}</span>
                  </button>
                </div>

                <div v-if="selectedJsonLeaf" class="json-path-actions">
                  <code>{{ selectedJsonLeaf.path }}</code>
                  <button
                    v-for="key in JSON_PATH_KEYS"
                    :key="key"
                    class="button button-ghost"
                    type="button"
                    @click="setSelectedPath(key)"
                  >
                    设置为{{ JSON_PATH_LABELS[key] }}
                  </button>
                </div>

                <button
                  class="json-preview-toggle"
                  type="button"
                  :aria-expanded="isJsonPreviewOpen"
                  @click="isJsonPreviewOpen = !isJsonPreviewOpen"
                >
                  <span>原始 JSON 响应</span>
                  <ChevronDown v-if="isJsonPreviewOpen" :size="16" />
                  <ChevronRight v-else :size="16" />
                </button>
                <pre v-if="isJsonPreviewOpen" class="json-preview">{{ testJsonText }}</pre>
              </section>
            </div>
          </section>

          <p v-if="providerFormErrorMessage" class="notice notice-error" role="alert">
            <AlertTriangle :size="16" />
            {{ providerFormErrorMessage }}
          </p>

          <div class="modal-actions provider-modal-actions">
            <div class="test-request-row">
              <button class="button button-ghost" type="button" :disabled="testingRequest" @click="sendTestRequest">
                <Loader2 v-if="testingRequest" :size="16" class="spinning" />
                <Send v-else :size="16" />
                测试
              </button>
              <span v-if="testMessage" class="test-message">{{ testMessage }}</span>
            </div>
            <div class="modal-action-group">
              <button class="button button-ghost" type="button" :disabled="saving" @click="closeProviderModal">取消</button>
              <button class="button button-primary" type="submit" :disabled="saving">
                <Loader2 v-if="saving" :size="16" class="spinning" />
                <Save v-else-if="isEditing" :size="16" />
                <Plus v-else :size="16" />
                {{ isEditing ? "保存" : "添加" }}
              </button>
            </div>
          </div>
        </form>
      </div>

      <div v-if="pendingDeleteProvider" class="modal-layer" @click.self="closeDeleteDialog">
        <section class="modal-card delete-modal">
          <div class="delete-icon">
            <Trash2 :size="24" />
          </div>
          <h2>删除站点</h2>
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
    </teleport>
  </main>
</template>
