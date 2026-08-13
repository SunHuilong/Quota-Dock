"use strict";

(function initQuotaPreload() {
  const root = typeof window !== "undefined" ? window : globalThis;

  function exposePreloadError(error) {
    const message = error && error.message ? error.message : String(error || "未知 preload 错误");
    root.__quotaPreloadError = {
      message,
      stack: error && error.stack ? error.stack : ""
    };

    if (typeof console !== "undefined" && console.error) {
      console.error("[quota-dock] preload 初始化失败", error);
    }
  }

  try {
    const crypto = require("crypto");
    const http = require("http");
    const https = require("https");
    const path = require("path");
    const { URL } = require("url");
    const { createProviderStore } = require("./libs/provider-store.js");
    const {
      executeOfficialProvider,
      getOfficialProviderPreset,
      getOfficialProviderPresetSummary,
      listOfficialProviderPresets,
      normalizeOfficialProviderInput
    } = require("./libs/official-provider-presets.js");
    const {
      AUTH_PLACEMENT_HEADER,
      BALANCE_ROUTE,
      DEFAULT_JSON_PATHS,
      DEFAULT_PRICE_MULTIPLIER,
      DEFAULT_UNIT,
      PROVIDER_MODE_OFFICIAL,
      PROVIDER_MODE_RELAY,
      REQUEST_TIMEOUT_MS,
      REQUEST_METHOD_GET,
      buildProviderRequestConfig,
      getDefaultAdvancedBodyText,
      getDefaultAdvancedHeadersText,
      getProviderTemplate,
      normalizeProviderInput,
      normalizeBodyForJson,
      normalizeProviderMode,
      normalizeTemplateId,
      normalizeQuotaSnapshot,
      parseProviderBalanceResponse,
      quotaSnapshotFromLegacy,
      quotaSnapshotToLegacyFields,
      safeErrorMessage,
      shouldRefreshProvider,
      createResponseErrorMessage
    } = require("./libs/quota-core.js");

    const API_KEY_PREFIX = "quota-api-key/";
    const FLOATING_WINDOW_WIDTH = 360;
    const FLOATING_WINDOW_MIN_HEIGHT = 188;
    const FLOATING_WINDOW_PROVIDER_HEIGHT = 136;
    const FLOATING_WINDOW_MAX_HEIGHT = 460;
    const FLOATING_SYNC_SCRIPT =
      '(async () => typeof window.__quotaSyncProviders === "function" ? await window.__quotaSyncProviders() : null)()';

    const utoolsApi = typeof utools !== "undefined" ? utools : root.utools;
    let floatingWindow = null;

    function requireUtools() {
      if (!utoolsApi || !utoolsApi.db || !utoolsApi.db.promises) {
        throw new Error("当前环境未检测到 uTools 数据库 API");
      }

      if (!utoolsApi.dbCryptoStorage) {
        throw new Error("当前环境未检测到 uTools 加密存储 API");
      }

      return utoolsApi;
    }

    const {
      providerDocId,
      idFromDoc,
      getProviderDoc,
      listProviderDocs,
      putProviderPatch,
      deleteProviderDoc
    } = createProviderStore(() => requireUtools().db.promises);

    function getFloatingWindowHeight(providerCount) {
      return Math.min(
        FLOATING_WINDOW_MAX_HEIGHT,
        FLOATING_WINDOW_MIN_HEIGHT + Math.max(0, providerCount - 1) * FLOATING_WINDOW_PROVIDER_HEIGHT
      );
    }

    function isValidProviderCount(providerCount) {
      return Number.isSafeInteger(providerCount) && providerCount >= 0;
    }

    function apiKeyStorageKey(id) {
      return `${API_KEY_PREFIX}${id}`;
    }

    function createProviderId() {
      if (crypto.randomUUID) {
        return crypto.randomUUID();
      }

      return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    }

    function assertDbResult(result, action) {
      if (result && result.ok) {
        return;
      }

      const message = result && result.message ? result.message : `${action}失败`;
      throw new Error(message);
    }

    function getStoredSnapshot(doc) {
      const hasMeters = Array.isArray(doc.lastMeters) && doc.lastMeters.length > 0;
      const hasLegacyValues = [doc.lastBalance, doc.lastLimit, doc.lastUsed].some(
        (value) => value !== undefined && value !== null
      );

      if (!hasMeters && !hasLegacyValues) {
        return { primaryMeterId: "", meters: [] };
      }

      return quotaSnapshotFromLegacy(doc);
    }

    function toRendererProvider(doc) {
      const api = requireUtools();
      const id = idFromDoc(doc);
      const mode = normalizeProviderMode(doc.mode);
      const templateId = normalizeTemplateId(doc.templateId, doc.mode);
      const template = getProviderTemplate(templateId);
      const officialPreset = mode === PROVIDER_MODE_OFFICIAL ? getOfficialProviderPreset(doc.officialPresetId) : null;
      const officialSummary = officialPreset ? getOfficialProviderPresetSummary(officialPreset) : null;
      const snapshot = getStoredSnapshot(doc);
      const legacyFields = quotaSnapshotToLegacyFields(snapshot);

      return {
        id,
        mode,
        name: doc.name || (officialSummary && officialSummary.name) || "未命名站点",
        officialPresetId: mode === PROVIDER_MODE_OFFICIAL ? String(doc.officialPresetId || "") : null,
        officialPresetName: officialSummary ? officialSummary.name : null,
        officialPresetAvailable: mode !== PROVIDER_MODE_OFFICIAL || Boolean(officialPreset),
        baseUrl: mode === PROVIDER_MODE_RELAY ? doc.baseUrl : "",
        templateId,
        requestPath: mode === PROVIDER_MODE_RELAY ? doc.requestPath || template.requestPath || BALANCE_ROUTE : "",
        requestMethod:
          mode === PROVIDER_MODE_RELAY ? doc.requestMethod || template.requestMethod || REQUEST_METHOD_GET : REQUEST_METHOD_GET,
        authPlacement:
          mode === PROVIDER_MODE_RELAY ? doc.authPlacement || template.authPlacement || AUTH_PLACEMENT_HEADER : AUTH_PLACEMENT_HEADER,
        requestHeaders:
          mode === PROVIDER_MODE_RELAY
            ? doc.requestHeaders ||
              template.requestHeaders ||
              getDefaultAdvancedHeadersText(doc.authPlacement || AUTH_PLACEMENT_HEADER)
            : "",
        requestBody:
          mode === PROVIDER_MODE_RELAY
            ? doc.requestBody ||
              template.requestBody ||
              getDefaultAdvancedBodyText(doc.authPlacement || AUTH_PLACEMENT_HEADER)
            : "",
        jsonPaths:
          mode === PROVIDER_MODE_RELAY
            ? {
                ...DEFAULT_JSON_PATHS,
                ...template.jsonPaths,
                ...(doc.jsonPaths || {})
              }
            : { ...DEFAULT_JSON_PATHS },
        manualLimit: doc.manualLimit ?? null,
        currencyOverride: String(doc.currencyOverride || "").trim(),
        defaultUnit:
          String(
            mode === PROVIDER_MODE_OFFICIAL
              ? (officialSummary && officialSummary.defaultUnit) || doc.lastUnit || DEFAULT_UNIT
              : doc.defaultUnit || DEFAULT_UNIT
          ).trim() || DEFAULT_UNIT,
        priceMultiplier: mode === PROVIDER_MODE_RELAY ? doc.priceMultiplier ?? DEFAULT_PRICE_MULTIPLIER : 1,
        refreshIntervalMinutes: doc.refreshIntervalMinutes,
        lastPrimaryMeterId: legacyFields.lastPrimaryMeterId,
        lastMeters: legacyFields.lastMeters,
        lastBalance: legacyFields.lastBalance,
        lastLimit: legacyFields.lastLimit,
        lastUsed: legacyFields.lastUsed,
        lastResetAt: legacyFields.lastResetAt,
        lastUnit: legacyFields.lastUnit,
        lastIsValid: doc.lastIsValid ?? null,
        lastCheckedAt: doc.lastCheckedAt ?? null,
        lastError: doc.lastError ?? "",
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        hasApiKey: Boolean(api.dbCryptoStorage.getItem(apiKeyStorageKey(id)))
      };
    }

    function createResponseError(message, detail, sanitize) {
      if (sanitize) {
        const status = detail && detail.statusCode ? `（HTTP ${detail.statusCode}）` : "";
        return new Error(`${message}${status}`);
      }

      return new Error(createResponseErrorMessage(message, detail));
    }

    function requestJson(config, timeoutMs, options) {
      const sanitize = Boolean(options && options.sanitizeErrors);
      return new Promise((resolve, reject) => {
        const parsed = new URL(config.url);
        const client = parsed.protocol === "http:" ? http : https;

        const request = client.request(
          parsed,
          {
            method: config.method || "GET",
            headers: config.headers || {}
          },
          (response) => {
            const chunks = [];
            const detail = {
              url: config.url,
              statusCode: response.statusCode,
              contentType: response.headers["content-type"],
              body: ""
            };

            response.on("data", (chunk) => {
              chunks.push(Buffer.from(chunk));
            });

            response.on("end", () => {
              const body = Buffer.concat(chunks).toString("utf8");
              detail.body = body;

              if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                reject(createResponseError("请求返回非成功状态", detail, sanitize));
                return;
              }

              try {
                resolve(JSON.parse(normalizeBodyForJson(body)));
              } catch {
                reject(createResponseError("响应不是有效的 JSON", detail, sanitize));
              }
            });
          }
        );

        request.on("error", (error) => {
          if (sanitize) {
            const code = error && error.code ? `（${error.code}）` : "";
            reject(new Error(`网络请求失败${code}`));
            return;
          }
          reject(error);
        });
        request.setTimeout(timeoutMs, () => {
          request.destroy(new Error("请求超时"));
        });
        if (config.body) {
          request.write(config.body);
        }
        request.end();
      });
    }

    async function getSyncState() {
      const api = requireUtools();

      if (!api.db.promises.replicateStateFromCloud) {
        return {
          state: null,
          label: "当前版本不支持同步状态查询"
        };
      }

      const state = await api.db.promises.replicateStateFromCloud();
      const labels = {
        "-1": "未开启同步",
        "0": "已同步",
        "1": "同步中"
      };

      return {
        state,
        label: labels[String(state)] || "未知同步状态"
      };
    }

    async function listProviders() {
      const docs = await listProviderDocs();
      return docs.map(toRendererProvider);
    }

    async function listPresetSummaries() {
      return listOfficialProviderPresets();
    }

    function createPersistedBase(id, existing, normalized, now) {
      const snapshot = existing ? getStoredSnapshot(existing) : { primaryMeterId: "", meters: [] };
      const snapshotFields = quotaSnapshotToLegacyFields(snapshot);

      return {
        _id: providerDocId(id),
        ...(existing && existing._rev ? { _rev: existing._rev } : {}),
        mode: normalized.mode,
        name: normalized.name,
        manualLimit: normalized.manualLimit,
        refreshIntervalMinutes: normalized.refreshIntervalMinutes,
        ...snapshotFields,
        lastIsValid: existing ? existing.lastIsValid ?? null : null,
        lastCheckedAt: existing ? existing.lastCheckedAt ?? null : null,
        lastError: existing ? existing.lastError ?? "" : "",
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now
      };
    }

    async function saveProvider(input) {
      const api = requireUtools();
      const id = input && input.id ? String(input.id) : createProviderId();
      const existing = input && input.id ? await getProviderDoc(id) : null;
      const mode = normalizeProviderMode(input && input.mode);

      if (existing && normalizeProviderMode(existing.mode) !== mode) {
        throw new Error("站点模式不能在编辑时切换");
      }

      const normalized =
        mode === PROVIDER_MODE_OFFICIAL
          ? normalizeOfficialProviderInput(input, { isUpdate: Boolean(existing) })
          : { mode: PROVIDER_MODE_RELAY, ...normalizeProviderInput(input, { isUpdate: Boolean(existing) }) };
      const now = new Date().toISOString();
      let doc;

      if (mode === PROVIDER_MODE_OFFICIAL) {
        if (existing && existing.officialPresetId !== normalized.officialPresetId) {
          throw new Error("预设平台不能在编辑时切换");
        }
        doc = {
          ...createPersistedBase(id, existing, normalized, now),
          officialPresetId: normalized.officialPresetId,
          currencyOverride: normalized.currencyOverride
        };
      } else {
        doc = {
          ...createPersistedBase(id, existing, normalized, now),
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
        };
      }

      const result = await api.db.promises.put(doc);
      assertDbResult(result, "保存站点");

      if (normalized.apiKey) {
        api.dbCryptoStorage.setItem(apiKeyStorageKey(id), normalized.apiKey);
      }

      return toRendererProvider(await getProviderDoc(id));
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

      const config = buildProviderRequestConfig(normalized, apiKey);
      return requestJson(config, REQUEST_TIMEOUT_MS);
    }

    async function testOfficialProvider(input) {
      const api = requireUtools();
      const id = input && input.id ? String(input.id) : "";
      const existing = id ? await getProviderDoc(id) : null;
      if (existing && normalizeProviderMode(existing.mode) !== PROVIDER_MODE_OFFICIAL) {
        throw new Error("当前站点不是预设平台");
      }
      const normalized = normalizeOfficialProviderInput(input, { isUpdate: Boolean(existing) });
      if (existing && existing.officialPresetId !== normalized.officialPresetId) {
        throw new Error("预设平台不能在编辑时切换");
      }
      const apiKey = normalized.apiKey || (id ? api.dbCryptoStorage.getItem(apiKeyStorageKey(id)) : "");

      return executeOfficialProvider(
        normalized.officialPresetId,
        apiKey,
        (config) => requestJson(config, REQUEST_TIMEOUT_MS, { sanitizeErrors: true }),
        normalized
      );
    }

    async function deleteProvider(id) {
      const api = requireUtools();
      const deletion = await deleteProviderDoc(id);

      if (deletion.removeError && typeof console !== "undefined" && console.warn) {
        console.warn("[quota-dock] 删除标记已保存，但物理清理站点文档失败", deletion.removeError);
      }

      try {
        const apiKey = api.dbCryptoStorage.getItem(apiKeyStorageKey(id));
        if (apiKey) {
          await api.dbCryptoStorage.removeItem(apiKeyStorageKey(id));
        }
      } catch (error) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[quota-dock] 删除站点后清理 API Key 失败", error);
        }
      }

      await syncFloatingWindow();

      return true;
    }

    async function refreshProvider(id) {
      const api = requireUtools();
      const doc = await getProviderDoc(id);
      const apiKey = api.dbCryptoStorage.getItem(apiKeyStorageKey(id));
      const checkedAt = new Date().toISOString();

      if (!apiKey) {
        const failedDoc = await putProviderPatch(id, {
          lastCheckedAt: checkedAt,
          lastError: "缺少 API Key",
          updatedAt: checkedAt
        });
        return toRendererProvider(failedDoc);
      }

      try {
        const provider = toRendererProvider(doc);
        let snapshot;

        if (provider.mode === PROVIDER_MODE_OFFICIAL) {
          snapshot = await executeOfficialProvider(
            provider.officialPresetId,
            apiKey,
            (config) => requestJson(config, REQUEST_TIMEOUT_MS, { sanitizeErrors: true }),
            provider
          );
        } else {
          const config = buildProviderRequestConfig(provider, apiKey);
          const response = await requestJson(config, REQUEST_TIMEOUT_MS);
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

        const updatedDoc = await putProviderPatch(id, {
          ...quotaSnapshotToLegacyFields(snapshot),
          lastIsValid: true,
          lastCheckedAt: checkedAt,
          lastError: "",
          updatedAt: checkedAt
        });
        return toRendererProvider(updatedDoc);
      } catch (error) {
        const updatedDoc = await putProviderPatch(id, {
          lastCheckedAt: checkedAt,
          lastError: safeErrorMessage(error),
          updatedAt: checkedAt
        });
        return toRendererProvider(updatedDoc);
      }
    }

    async function refreshDueProviders() {
      const now = Date.now();
      const docs = await listProviderDocs();
      const dueDocs = docs.filter((doc) => shouldRefreshProvider(doc, now));

      for (const doc of dueDocs) {
        await refreshProvider(idFromDoc(doc));
      }

      return listProviders();
    }

    async function refreshAll() {
      const docs = await listProviderDocs();

      for (const doc of docs) {
        await refreshProvider(idFromDoc(doc));
      }

      return listProviders();
    }

    function resizeFloatingWindow(providerCount) {
      if (!isValidProviderCount(providerCount) || !floatingWindow || typeof floatingWindow.setSize !== "function") {
        return false;
      }

      const targetHeight = getFloatingWindowHeight(providerCount);

      try {
        if (typeof floatingWindow.isDestroyed === "function" && floatingWindow.isDestroyed()) {
          return false;
        }
        floatingWindow.setSize(FLOATING_WINDOW_WIDTH, targetHeight);

        if (
          typeof floatingWindow.getSize === "function" &&
          typeof floatingWindow.getBounds === "function" &&
          typeof floatingWindow.setBounds === "function"
        ) {
          const actualSize = floatingWindow.getSize();
          if (
            Array.isArray(actualSize) &&
            (actualSize[0] !== FLOATING_WINDOW_WIDTH || actualSize[1] !== targetHeight)
          ) {
            floatingWindow.setBounds({
              ...floatingWindow.getBounds(),
              width: FLOATING_WINDOW_WIDTH,
              height: targetHeight
            });
          }
        }

        return true;
      } catch (error) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[quota-dock] 同步浮窗高度失败", error);
        }
        return false;
      }
    }

    async function syncFloatingWindow() {
      if (!floatingWindow) {
        return;
      }

      try {
        if (typeof floatingWindow.isDestroyed === "function" && floatingWindow.isDestroyed()) {
          return;
        }
      } catch (error) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[quota-dock] 检查浮窗状态失败", error);
        }
        return;
      }

      let providerCount = null;

      try {
        if (floatingWindow.webContents && typeof floatingWindow.webContents.executeJavaScript === "function") {
          const renderedCount = await floatingWindow.webContents.executeJavaScript(FLOATING_SYNC_SCRIPT);
          if (isValidProviderCount(renderedCount)) {
            providerCount = renderedCount;
          }
        }
      } catch (error) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[quota-dock] 同步浮窗内容失败", error);
        }
      }

      if (providerCount === null) {
        try {
          providerCount = (await listProviderDocs()).length;
        } catch (error) {
          if (typeof console !== "undefined" && console.warn) {
            console.warn("[quota-dock] 读取浮窗站点数量失败", error);
          }
          return;
        }
      }

      resizeFloatingWindow(providerCount);
    }

    async function openFloatingWindow() {
      const api = requireUtools();

      if (typeof api.createBrowserWindow !== "function") {
        throw new Error("当前 uTools 环境不支持创建浮窗");
      }

      if (floatingWindow && (!floatingWindow.isDestroyed || !floatingWindow.isDestroyed())) {
        await syncFloatingWindow();
        if (floatingWindow.show) {
          floatingWindow.show();
        }
        if (floatingWindow.focus) {
          floatingWindow.focus();
        }
        return true;
      }

      const providerCount = (await listProviderDocs()).length;
      const floatingWindowHeight = getFloatingWindowHeight(providerCount);

      floatingWindow = api.createBrowserWindow(
        "floating.html",
        {
          width: FLOATING_WINDOW_WIDTH,
          height: floatingWindowHeight,
          title: "AI 额度浮窗",
          frame: false,
          resizable: false,
          closeable: true,
          minimizable: false,
          maximizable: false,
          skipTaskbar: true,
          alwaysOnTop: true,
          autoHideMenuBar: true,
          backgroundColor: "#f6f7fb",
          webPreferences: {
            preload: path.join(__dirname, "preload.js")
          }
        },
        () => {
          if (floatingWindow && floatingWindow.show) {
            floatingWindow.show();
          }
          if (floatingWindow && floatingWindow.setAlwaysOnTop) {
            floatingWindow.setAlwaysOnTop(true, "floating");
          }
        }
      );

      if (floatingWindow && floatingWindow.on) {
        floatingWindow.on("closed", () => {
          floatingWindow = null;
        });
      }

      return true;
    }

    root.__quotaPreloadReady = true;
    root.__quotaPreloadError = null;
    root.quotaBridge = {
      getSyncState,
      listOfficialProviderPresets: listPresetSummaries,
      listProviders,
      saveProvider,
      testProviderRequest,
      testOfficialProvider,
      deleteProvider,
      refreshProvider,
      refreshDueProviders,
      refreshAll,
      syncFloatingWindow,
      openFloatingWindow
    };
  } catch (error) {
    exposePreloadError(error);
  }
})();
