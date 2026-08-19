<script setup lang="ts">
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Plus,
  Save,
  Send,
  X
} from "@lucide/vue";
import { computed, reactive, ref } from "vue";
import { getQuotaBridge } from "../../shared/bridge";
import {
  formatMeterValue,
  formatQuotaValue,
  meterProgress,
  meterRemainingPercent
} from "../../shared/format";
import type {
  AuthPlacement,
  JsonPathKey,
  JsonPathMap,
  OfficialProviderInput,
  OfficialProviderPresetSummary,
  ProviderInput,
  ProviderMode,
  ProviderTemplate,
  QuotaMeter,
  QuotaProvider,
  QuotaSnapshot,
  RelayProviderInput,
  RequestMethod,
  TemplateId
} from "../../shared/types";

interface JsonLeaf {
  path: string;
  value: unknown;
  preview: string;
}

const props = defineProps<{
  providerTemplates: ProviderTemplate[];
  officialPresets: OfficialProviderPresetSummary[];
}>();

const emit = defineEmits<{
  saved: [provider: QuotaProvider];
}>();

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

const bridge = getQuotaBridge();
const isOpen = ref(false);
const saving = ref(false);
const showApiKey = ref(false);
const errorMessage = ref("");
const isTemplateConfigOpen = ref(false);
const isOptionalSettingsOpen = ref(false);
const isJsonPreviewOpen = ref(false);
const testingRequest = ref(false);
const testResponse = ref<unknown | null>(null);
const testSnapshot = ref<QuotaSnapshot | null>(null);
const testMessage = ref("");
const selectedJsonLeaf = ref<JsonLeaf | null>(null);

function createEmptyJsonPaths(): JsonPathMap {
  return { balance: "", used: "", limit: "", resetAt: "", unit: "" };
}

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
  () => props.officialPresets.find((preset) => preset.id === form.officialPresetId) || null
);
const officialPresetGroups = computed(() => {
  const groups = new Map<string, OfficialProviderPresetSummary[]>();
  for (const preset of props.officialPresets) {
    const items = groups.get(preset.categoryLabel) || [];
    items.push(preset);
    groups.set(preset.categoryLabel, items);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
});
const jsonLeaves = computed(() => (testResponse.value === null ? [] : flattenJson(testResponse.value)));
const testJsonText = computed(() =>
  testResponse.value === null ? "" : JSON.stringify(testResponse.value, null, 2)
);

function getTemplate(templateId: TemplateId) {
  return props.providerTemplates.find((template) => template.id === templateId) || props.providerTemplates[0] || null;
}

function resetTestResult() {
  testResponse.value = null;
  testSnapshot.value = null;
  testMessage.value = "";
  selectedJsonLeaf.value = null;
}

function applyTemplatePreset(templateId: TemplateId) {
  const template = getTemplate(templateId);
  if (!template) {
    return;
  }
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

function resetForm(mode: ProviderMode = "relay") {
  isJsonPreviewOpen.value = false;
  isOptionalSettingsOpen.value = false;
  form.id = "";
  form.mode = mode;
  form.name = "";
  form.officialPresetId = mode === "official" ? props.officialPresets[0]?.id || "" : "";
  form.baseUrl = "";
  form.apiKey = "";
  applyTemplatePreset("openai-usage");
  form.manualLimit = "";
  form.currencyOverride = "";
  form.refreshIntervalMinutes = 30;
  showApiKey.value = false;
  errorMessage.value = "";
  resetTestResult();
}

function openCreate() {
  resetForm("official");
  isOpen.value = true;
}

function switchCreateMode(mode: ProviderMode) {
  if (!isEditing.value && form.mode !== mode) {
    resetForm(mode);
  }
}

function close() {
  if (saving.value) {
    return;
  }
  isOpen.value = false;
  resetForm();
}

function edit(provider: QuotaProvider) {
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
  form.refreshIntervalMinutes = provider.refreshIntervalMinutes;
  isTemplateConfigOpen.value = form.templateId === "custom";
  showApiKey.value = false;
  errorMessage.value = "";
  resetTestResult();
  isOpen.value = true;
}

function closeIfEditing(providerId: string) {
  if (form.id === providerId) {
    isOpen.value = false;
    resetForm();
  }
}

function selectOfficialPreset(presetId: string) {
  if (form.officialPresetId !== presetId) {
    form.officialPresetId = presetId;
    form.manualLimit = "";
    form.currencyOverride = "";
    resetTestResult();
  }
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
  const common = {
    id: form.id || undefined,
    name: form.name,
    apiKey: form.apiKey,
    manualLimit: form.manualLimit === "" ? null : form.manualLimit,
    refreshIntervalMinutes: form.refreshIntervalMinutes
  };

  if (form.mode === "official") {
    return {
      ...common,
      mode: "official",
      officialPresetId: form.officialPresetId,
      currencyOverride: form.currencyOverride
    } satisfies OfficialProviderInput;
  }

  return {
    ...common,
    mode: "relay",
    baseUrl: form.baseUrl,
    templateId: form.templateId,
    requestPath: form.requestPath,
    requestMethod: form.requestMethod,
    authPlacement: form.authPlacement,
    requestHeaders: form.requestHeaders,
    requestBody: form.requestBody,
    jsonPaths: { ...form.jsonPaths },
    defaultUnit: form.defaultUnit,
    priceMultiplier: form.priceMultiplier
  } satisfies RelayProviderInput;
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
    return value.length
      ? value.flatMap((item, index) => flattenJson(item, appendJsonPath(path, index)))
      : [{ path: path || "$", value, preview: "[]" }];
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length
      ? entries.flatMap(([key, item]) => flattenJson(item, appendJsonPath(path, key)))
      : [{ path: path || "$", value, preview: "{}" }];
  }
  return [{ path: path || "$", value, preview: formatJsonPreview(value) }];
}

function getJsonPathPreview(key: JsonPathKey) {
  return jsonLeaves.value.find((leaf) => leaf.path === form.jsonPaths[key])?.preview || "--";
}

function updateManualLimit(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  form.manualLimit = value === "" ? "" : Number(value);
  if (value !== "") {
    form.jsonPaths.limit = "";
  }
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

function meterUsageText(meter: QuotaMeter) {
  if (meter.limit !== null && meter.used !== null) {
    return `已用 ${formatQuotaValue(meter.used)} / ${formatQuotaValue(meter.limit)}`;
  }
  return meter.used !== null && meter.remaining === null ? `已用 ${formatQuotaValue(meter.used)}` : "";
}

function setError(error: unknown, fallback: string) {
  errorMessage.value = error instanceof Error ? error.message : fallback;
}

async function saveProvider() {
  saving.value = true;
  errorMessage.value = "";
  try {
    const savedProvider = await bridge.saveProvider(buildProviderInput());
    isOpen.value = false;
    resetForm();
    emit("saved", savedProvider);
  } catch (error) {
    setError(error, "保存失败");
  } finally {
    saving.value = false;
  }
}

async function sendTestRequest() {
  testingRequest.value = true;
  errorMessage.value = "";
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
    setError(error, "发送失败");
  } finally {
    testingRequest.value = false;
  }
}

defineExpose({ openCreate, edit, closeIfEditing });
</script>

<template>
  <teleport to="body">
    <Transition name="modal-fade">
      <div v-if="isOpen" class="modal-layer" @click.self="close">
        <form
          class="modal-card provider-modal glass-surface"
          role="dialog"
          aria-modal="true"
          aria-labelledby="provider-modal-title"
          @submit.prevent="saveProvider"
        >
          <div class="provider-modal-scroll">
            <div class="modal-heading">
              <div>
                <p class="eyebrow">{{ form.mode === "official" ? "Preset Provider" : "Relay Provider" }}</p>
                <h2 id="provider-modal-title">{{ isEditing ? "编辑站点" : "添加站点" }}</h2>
              </div>
              <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="close">
                <X :size="18" />
              </button>
            </div>

            <div class="segmented-control create-mode-tabs" role="tablist" aria-label="站点类型">
              <button
                v-for="mode in (['official', 'relay'] as const)"
                :key="mode"
                class="segment-button"
                :class="{ active: form.mode === mode }"
                type="button"
                role="tab"
                :aria-selected="form.mode === mode"
                :disabled="isEditing"
                @click="switchCreateMode(mode)"
              >
                {{ mode === "official" ? "官方" : "专业模式" }}
              </button>
            </div>

            <section v-if="form.mode === 'official'" class="official-preset-picker" aria-labelledby="official-preset-label">
              <div class="official-preset-head"><span id="official-preset-label">提供商</span></div>
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
                <option v-for="template in providerTemplates" :key="template.id" :value="template.id">
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
                    <input v-model.number="form.manualLimit" type="number" min="0" step="any" autocomplete="off" placeholder="选填" />
                  </label>
                  <label v-if="selectedOfficialPreset?.supportsCurrencyOverride !== false" class="field compact-field">
                    <span>货币</span>
                    <input v-model.trim="form.currencyOverride" autocomplete="off" :placeholder="selectedOfficialPreset?.defaultUnit || 'USD'" />
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
                      <button v-for="method in (['GET', 'POST'] as const)" :key="method" class="segment-button" :class="{ active: form.requestMethod === method }" type="button" @click="setRequestMethod(method)">
                        {{ method }}
                      </button>
                    </div>
                  </div>
                  <div class="field compact-field">
                    <span>鉴权位置</span>
                    <div class="segmented-control">
                      <button v-for="placement in (['header', 'body'] as const)" :key="placement" class="segment-button" :class="{ active: form.authPlacement === placement }" type="button" @click="setAuthPlacement(placement)">
                        {{ placement === "header" ? "Header" : "Body" }}
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
                    <input v-model.number="form.priceMultiplier" type="number" min="0" step="any" autocomplete="off" placeholder="1" required />
                  </label>
                  <div v-for="key in JSON_PATH_KEYS" :key="key" class="field compact-field">
                    <span>{{ JSON_PATH_LABELS[key] }}路径</span>
                    <div class="path-control">
                      <span v-if="key === 'limit' && form.manualLimit !== ''" class="path-mode-status">当前使用手填总额度</span>
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
                      @click="selectedJsonLeaf = leaf"
                    >
                      <code>{{ leaf.path }}</code>
                      <span>{{ leaf.preview }}</span>
                    </button>
                  </div>
                  <div v-if="selectedJsonLeaf" class="json-path-actions">
                    <code>{{ selectedJsonLeaf.path }}</code>
                    <button v-for="key in JSON_PATH_KEYS" :key="key" class="button button-ghost" type="button" @click="setSelectedPath(key)">
                      设置为{{ JSON_PATH_LABELS[key] }}
                    </button>
                  </div>
                  <button class="json-preview-toggle" type="button" :aria-expanded="isJsonPreviewOpen" @click="isJsonPreviewOpen = !isJsonPreviewOpen">
                    <span>原始 JSON 响应</span>
                    <ChevronDown v-if="isJsonPreviewOpen" :size="16" />
                    <ChevronRight v-else :size="16" />
                  </button>
                  <pre v-if="isJsonPreviewOpen" class="json-preview">{{ testJsonText }}</pre>
                </section>
              </div>
            </section>

            <p v-if="errorMessage" class="notice notice-error" role="alert">
              <AlertTriangle :size="16" />
              {{ errorMessage }}
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
                <button class="button button-ghost" type="button" :disabled="saving" @click="close">取消</button>
                <button class="button button-primary" type="submit" :disabled="saving">
                  <Loader2 v-if="saving" :size="16" class="spinning" />
                  <Save v-else-if="isEditing" :size="16" />
                  <Plus v-else :size="16" />
                  {{ isEditing ? "保存" : "添加" }}
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </Transition>
  </teleport>
</template>
