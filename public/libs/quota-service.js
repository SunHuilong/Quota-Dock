"use strict";

const crypto = require("crypto");
const {
  executeOfficialProvider,
  getOfficialProviderPreset,
  getOfficialProviderPresetSummary,
  listOfficialProviderPresets,
  normalizeOfficialProviderInput
} = require("./official-provider-presets.js");
const { createProviderStore } = require("./provider-store.js");
const { decodeProviderDocument, encodeProviderDocument } = require("./provider-document.js");
const {
  AUTH_PLACEMENT_HEADER,
  DEFAULT_JSON_PATHS,
  DEFAULT_PRICE_MULTIPLIER,
  DEFAULT_TEMPLATE_ID,
  DEFAULT_UNIT,
  PROVIDER_MODE_OFFICIAL,
  PROVIDER_MODE_RELAY,
  REQUEST_METHOD_GET,
  REQUEST_TIMEOUT_MS,
  buildProviderRequestConfig,
  getProviderStatus,
  getProviderTemplates,
  normalizeProviderInput,
  normalizeProviderMode,
  normalizeQuotaSnapshot,
  parseProviderBalanceResponse,
  projectQuotaSnapshot,
  safeErrorMessage,
  shouldRefreshProvider
} = require("./quota-core.js");
const {
  DEFAULT_REFRESH_CONCURRENCY,
  DEFAULT_STALE_AFTER_MINUTES,
  createRefreshBatch,
  createRefreshOutcome,
  runBoundedTasks
} = require("./quota-mcp.js");

const API_KEY_PREFIX = "quota-api-key/";

function createProviderId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createQuotaService(options) {
  const settings = options || {};
  const utoolsApi = settings.utools;
  const requestJson = settings.requestJson;
  const now = typeof settings.now === "function" ? settings.now : () => Date.now();
  const idFactory = typeof settings.createId === "function" ? settings.createId : createProviderId;
  const onProvidersChanged =
    typeof settings.onProvidersChanged === "function" ? settings.onProvidersChanged : async () => {};
  const providerRefreshFlights = new Map();
  const providerRefreshNotifications = new Map();

  if (typeof requestJson !== "function") {
    throw new TypeError("requestJson 必须是函数");
  }

  function requireUtools() {
    if (!utoolsApi || !utoolsApi.db || !utoolsApi.db.promises) {
      throw new Error("当前环境未检测到 uTools 数据库 API");
    }
    if (!utoolsApi.dbCryptoStorage) {
      throw new Error("当前环境未检测到 uTools 加密存储 API");
    }
    return utoolsApi;
  }

  const store = settings.providerStore || createProviderStore(() => requireUtools().db.promises);

  function apiKeyStorageKey(id) {
    return `${API_KEY_PREFIX}${id}`;
  }

  async function notifyProvidersChanged() {
    try {
      await onProvidersChanged();
    } catch (error) {
      console.warn("[quota-dock] 数据已更新，但浮窗同步失败", error);
    }
  }

  async function getSyncState() {
    const api = requireUtools();
    if (!api.db.promises.replicateStateFromCloud) {
      return { state: null, label: "当前版本不支持同步状态查询" };
    }

    const state = await api.db.promises.replicateStateFromCloud();
    const labels = { "-1": "未开启同步", "0": "已同步", "1": "同步中" };
    return { state, label: labels[String(state)] || "未知同步状态" };
  }

  async function listProviderTemplates() {
    return clone(getProviderTemplates());
  }

  async function listPresetSummaries() {
    return listOfficialProviderPresets();
  }

  function toRendererProvider(rawDoc) {
    const api = requireUtools();
    const doc = decodeProviderDocument(rawDoc);
    const id = store.idFromDoc(rawDoc);
    const officialPreset =
      doc.mode === PROVIDER_MODE_OFFICIAL ? getOfficialProviderPreset(doc.officialPresetId) : null;
    const officialSummary = officialPreset ? getOfficialProviderPresetSummary(officialPreset) : null;
    const primarySnapshotMeter =
      doc.snapshot && doc.snapshot.meters.find((meter) => meter.id === doc.snapshot.primaryMeterId);
    const defaultUnit =
      doc.mode === PROVIDER_MODE_OFFICIAL
        ? (officialSummary && officialSummary.defaultUnit) ||
          (primarySnapshotMeter && primarySnapshotMeter.unit) ||
          DEFAULT_UNIT
        : doc.defaultUnit || DEFAULT_UNIT;
    const hasApiKey = Boolean(api.dbCryptoStorage.getItem(apiKeyStorageKey(id)));
    const provider = {
      id,
      mode: doc.mode,
      name: doc.name || (officialSummary && officialSummary.name) || "未命名站点",
      officialPresetId: doc.mode === PROVIDER_MODE_OFFICIAL ? doc.officialPresetId : null,
      officialPresetName: officialSummary ? officialSummary.name : null,
      officialPresetAvailable: doc.mode !== PROVIDER_MODE_OFFICIAL || Boolean(officialPreset),
      baseUrl: doc.mode === PROVIDER_MODE_RELAY ? doc.baseUrl : "",
      templateId: doc.mode === PROVIDER_MODE_RELAY ? doc.templateId : DEFAULT_TEMPLATE_ID,
      requestPath: doc.mode === PROVIDER_MODE_RELAY ? doc.requestPath : "",
      requestMethod: doc.mode === PROVIDER_MODE_RELAY ? doc.requestMethod : REQUEST_METHOD_GET,
      authPlacement: doc.mode === PROVIDER_MODE_RELAY ? doc.authPlacement : AUTH_PLACEMENT_HEADER,
      requestHeaders: doc.mode === PROVIDER_MODE_RELAY ? doc.requestHeaders : "",
      requestBody: doc.mode === PROVIDER_MODE_RELAY ? doc.requestBody : "",
      jsonPaths: doc.mode === PROVIDER_MODE_RELAY ? { ...DEFAULT_JSON_PATHS, ...doc.jsonPaths } : { ...DEFAULT_JSON_PATHS },
      manualLimit: doc.manualLimit,
      currencyOverride: doc.mode === PROVIDER_MODE_OFFICIAL ? doc.currencyOverride : "",
      defaultUnit,
      priceMultiplier: doc.mode === PROVIDER_MODE_RELAY ? doc.priceMultiplier : DEFAULT_PRICE_MULTIPLIER,
      refreshIntervalMinutes: doc.refreshIntervalMinutes,
      showInFloatingWindow: doc.showInFloatingWindow,
      snapshot: doc.snapshot ? projectQuotaSnapshot(doc.snapshot, { defaultUnit }) : null,
      lastCheckedAt: doc.lastCheckedAt,
      lastError: doc.lastError,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      hasApiKey,
      status: "pending"
    };
    provider.status = getProviderStatus(provider);
    return provider;
  }

  async function listProviders() {
    const docs = await store.listProviderDocs();
    return docs.map(toRendererProvider);
  }

  async function getProvider(id) {
    return toRendererProvider(await store.getProviderDoc(id));
  }

  function createPersistedBase(id, existing, normalized, currentIso) {
    return {
      _id: store.providerDocId(id),
      ...(existing && existing._rev ? { _rev: existing._rev } : {}),
      mode: normalized.mode,
      name: normalized.name,
      manualLimit: normalized.manualLimit,
      refreshIntervalMinutes: normalized.refreshIntervalMinutes,
      showInFloatingWindow: existing ? existing.showInFloatingWindow : true,
      snapshot: existing ? existing.snapshot : null,
      lastCheckedAt: existing ? existing.lastCheckedAt : null,
      lastError: existing ? existing.lastError : "",
      createdAt: existing && existing.createdAt ? existing.createdAt : currentIso,
      updatedAt: currentIso
    };
  }

  async function saveProvider(input) {
    const api = requireUtools();
    const id = input && input.id ? String(input.id).trim() : idFactory();
    const rawMode = String((input && input.mode) || "").trim().toLowerCase();
    const mode = normalizeProviderMode(rawMode);
    const currentIso = new Date(now()).toISOString();
    let savedDoc;

    const buildDocument = (existingRaw) => {
      const existing = existingRaw ? decodeProviderDocument(existingRaw) : null;
      if (existing && existing.mode !== mode) {
        throw new Error("站点模式不能在编辑时切换");
      }

      const normalized =
        mode === PROVIDER_MODE_OFFICIAL
          ? normalizeOfficialProviderInput(input, { isUpdate: Boolean(existing) })
          : { mode: PROVIDER_MODE_RELAY, ...normalizeProviderInput(input, { isUpdate: Boolean(existing) }) };
      const base = createPersistedBase(id, existing, normalized, currentIso);

      if (mode === PROVIDER_MODE_OFFICIAL) {
        if (existing && existing.officialPresetId !== normalized.officialPresetId) {
          throw new Error("预设平台不能在编辑时切换");
        }
        return encodeProviderDocument({
          ...base,
          officialPresetId: normalized.officialPresetId,
          currencyOverride: normalized.currencyOverride
        });
      }

      return encodeProviderDocument({
        ...base,
        baseUrl: normalized.baseUrl,
        templateId: normalized.templateId,
        requestPath: normalized.requestPath,
        requestMethod: normalized.requestMethod,
        authPlacement: normalized.authPlacement,
        requestHeaders: normalized.requestHeaders,
        requestBody: normalized.requestBody,
        jsonPaths: normalized.jsonPaths,
        defaultUnit: normalized.defaultUnit,
        priceMultiplier: normalized.priceMultiplier
      });
    };

    if (input && input.id) {
      savedDoc = await store.updateProviderDoc(id, buildDocument);
    } else {
      savedDoc = await store.putNewProviderDoc(buildDocument(null));
    }

    const apiKey = String((input && input.apiKey) || "").trim();
    if (apiKey) {
      api.dbCryptoStorage.setItem(apiKeyStorageKey(id), apiKey);
    }

    await notifyProvidersChanged();
    return toRendererProvider(savedDoc);
  }

  async function setProviderFloatingVisibility(id, visible) {
    const providerId = String(id || "").trim();
    if (!providerId) {
      throw new Error("站点 ID 不能为空");
    }
    if (typeof visible !== "boolean") {
      throw new Error("浮窗展示状态无效");
    }

    const updatedDoc = await store.updateProviderDoc(providerId, (rawDoc) => {
      const doc = decodeProviderDocument(rawDoc);
      return encodeProviderDocument({
        ...doc,
        showInFloatingWindow: visible,
        updatedAt: new Date(now()).toISOString()
      });
    });
    await notifyProvidersChanged();
    return toRendererProvider(updatedDoc);
  }

  async function testProviderRequest(input) {
    const api = requireUtools();
    const id = input && input.id ? String(input.id) : "";
    const normalized = normalizeProviderInput(input, {
      isUpdate: Boolean(id),
      requireJsonPaths: false
    });
    const apiKey = normalized.apiKey || (id ? api.dbCryptoStorage.getItem(apiKeyStorageKey(id)) : "");

    if (!apiKey) {
      throw new Error("请填写 API Key");
    }

    return requestJson(buildProviderRequestConfig(normalized, apiKey), REQUEST_TIMEOUT_MS);
  }

  async function testOfficialProvider(input) {
    const api = requireUtools();
    const id = input && input.id ? String(input.id) : "";
    const existing = id ? decodeProviderDocument(await store.getProviderDoc(id)) : null;
    if (existing && existing.mode !== PROVIDER_MODE_OFFICIAL) {
      throw new Error("当前站点不是预设平台");
    }

    const normalized = normalizeOfficialProviderInput(input, { isUpdate: Boolean(existing) });
    if (existing && existing.officialPresetId !== normalized.officialPresetId) {
      throw new Error("预设平台不能在编辑时切换");
    }
    const apiKey = normalized.apiKey || (id ? api.dbCryptoStorage.getItem(apiKeyStorageKey(id)) : "");
    const snapshot = await executeOfficialProvider(
      normalized.officialPresetId,
      apiKey,
      (config) => requestJson(config, REQUEST_TIMEOUT_MS, { sanitizeErrors: true }),
      normalized
    );
    return projectQuotaSnapshot(snapshot, normalized);
  }

  async function deleteProvider(id) {
    const api = requireUtools();
    const deletion = await store.deleteProviderDoc(id);
    if (deletion.removeError) {
      console.warn("[quota-dock] 删除标记已保存，但物理清理站点文档失败", deletion.removeError);
    }

    try {
      if (api.dbCryptoStorage.getItem(apiKeyStorageKey(id))) {
        await api.dbCryptoStorage.removeItem(apiKeyStorageKey(id));
      }
    } catch (error) {
      console.warn("[quota-dock] 删除站点后清理 API Key 失败", error);
    }

    await notifyProvidersChanged();
    return true;
  }

  async function persistRefreshResult(id, checkedAt, patch) {
    return store.updateProviderDoc(id, (rawDoc) => {
      const current = decodeProviderDocument(rawDoc);
      if (timestamp(current.lastCheckedAt) > timestamp(checkedAt)) {
        return null;
      }
      return encodeProviderDocument({
        ...current,
        ...patch,
        lastCheckedAt: checkedAt,
        updatedAt: checkedAt
      });
    });
  }

  async function performProviderRefresh(id) {
    const api = requireUtools();
    const rawDoc = await store.getProviderDoc(id);
    const apiKey = api.dbCryptoStorage.getItem(apiKeyStorageKey(id));
    const checkedAt = new Date(now()).toISOString();

    if (!apiKey) {
      return toRendererProvider(
        await persistRefreshResult(id, checkedAt, { lastError: "缺少 API Key" })
      );
    }

    try {
      const provider = toRendererProvider(rawDoc);
      let snapshot;

      if (provider.mode === PROVIDER_MODE_OFFICIAL) {
        snapshot = await executeOfficialProvider(
          provider.officialPresetId,
          apiKey,
          (config) => requestJson(config, REQUEST_TIMEOUT_MS, { sanitizeErrors: true }),
          provider
        );
      } else {
        const response = await requestJson(
          buildProviderRequestConfig(provider, apiKey),
          REQUEST_TIMEOUT_MS
        );
        const extracted = parseProviderBalanceResponse(
          response,
          provider.jsonPaths,
          provider.manualLimit,
          provider.defaultUnit,
          provider.priceMultiplier
        );
        snapshot = normalizeQuotaSnapshot(
          {
            primaryMeterId: "balance",
            meters: [
              {
                id: "balance",
                label: "可用额度",
                kind: "balance",
                remaining: extracted.remaining,
                used: extracted.used,
                limit: extracted.limit,
                unit: extracted.unit,
                resetAt: extracted.resetAt,
                aggregate: true
              }
            ]
          },
          { defaultUnit: provider.defaultUnit }
        );
      }

      return toRendererProvider(
        await persistRefreshResult(id, checkedAt, { snapshot, lastError: "" })
      );
    } catch (error) {
      return toRendererProvider(
        await persistRefreshResult(id, checkedAt, { lastError: safeErrorMessage(error) })
      );
    }
  }

  function refreshProviderInternal(id) {
    const providerId = String(id || "").trim();
    if (!providerId) {
      return Promise.reject(new Error("站点 ID 不能为空"));
    }

    const existingFlight = providerRefreshFlights.get(providerId);
    if (existingFlight) {
      return existingFlight;
    }

    const flight = performProviderRefresh(providerId).finally(() => {
      if (providerRefreshFlights.get(providerId) === flight) {
        providerRefreshFlights.delete(providerId);
      }
    });
    providerRefreshFlights.set(providerId, flight);
    return flight;
  }

  function refreshProvider(id) {
    const providerId = String(id || "").trim();
    if (!providerId) {
      return Promise.reject(new Error("站点 ID 不能为空"));
    }

    const existingNotification = providerRefreshNotifications.get(providerId);
    if (existingNotification) {
      return existingNotification;
    }

    const notifiedFlight = (async () => {
      const provider = await refreshProviderInternal(providerId);
      await notifyProvidersChanged();
      return provider;
    })().finally(() => {
      if (providerRefreshNotifications.get(providerId) === notifiedFlight) {
        providerRefreshNotifications.delete(providerId);
      }
    });
    providerRefreshNotifications.set(providerId, notifiedFlight);
    return notifiedFlight;
  }

  function selectRefreshDocs(docs, scope, providerIds) {
    if (scope === "all") {
      return docs;
    }
    if (scope === "due") {
      const currentTime = now();
      return docs.filter((doc) => shouldRefreshProvider(decodeProviderDocument(doc), currentTime));
    }

    const ids = Array.isArray(providerIds) ? providerIds : [];
    const docsById = new Map(docs.map((doc) => [store.idFromDoc(doc), doc]));
    const unknownIds = ids.filter((id) => !docsById.has(id));
    if (unknownIds.length) {
      throw new Error(`未知站点 ID：${unknownIds.join(", ")}`);
    }
    return ids.map((id) => docsById.get(id));
  }

  async function refreshBatch(scope, providerIds, ctx) {
    const docs = selectRefreshDocs(await store.listProviderDocs(), scope, providerIds);
    const items = docs.map((doc) => ({
      id: store.idFromDoc(doc),
      name: String((doc && doc.name) || "未命名站点").trim() || "未命名站点"
    }));
    const taskResults = await runBoundedTasks(items, (item) => refreshProviderInternal(item.id), {
      concurrency: DEFAULT_REFRESH_CONCURRENCY,
      onProgress: async ({ progress, total, item, result }) => {
        if (!ctx || typeof ctx.sendProgress !== "function") {
          return;
        }
        const outcome = createRefreshOutcome(result, {
          nowMs: now(),
          staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES
        });
        const message = outcome.success ? `已刷新站点：${item.name}` : `站点刷新未成功：${item.name}`;
        await ctx.sendProgress({ progress, total, message: message.slice(0, 2000) });
      }
    });

    if (items.length) {
      await notifyProvidersChanged();
    }
    return createRefreshBatch(scope, taskResults, {
      nowMs: now(),
      staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES
    });
  }

  async function refreshDueProviders() {
    await refreshBatch("due");
    return listProviders();
  }

  async function refreshAll() {
    await refreshBatch("all");
    return listProviders();
  }

  return {
    getSyncState,
    listProviderTemplates,
    listOfficialProviderPresets: listPresetSummaries,
    listProviders,
    getProvider,
    saveProvider,
    setProviderFloatingVisibility,
    testProviderRequest,
    testOfficialProvider,
    deleteProvider,
    refreshProvider,
    refreshDueProviders,
    refreshAll,
    refreshBatch
  };
}

module.exports = {
  API_KEY_PREFIX,
  createQuotaService
};
