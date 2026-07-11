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
    const {
      AUTH_PLACEMENT_HEADER,
      BALANCE_ROUTE,
      DEFAULT_JSON_PATHS,
      DEFAULT_UNIT,
      REQUEST_TIMEOUT_MS,
      REQUEST_METHOD_GET,
      buildProviderRequestConfig,
      getDefaultAdvancedBodyText,
      getDefaultAdvancedHeadersText,
      getProviderTemplate,
      normalizeProviderInput,
      normalizeBodyForJson,
      normalizeTemplateId,
      parseProviderBalanceResponse,
      safeErrorMessage,
      shouldRefreshProvider,
      createResponseErrorMessage
    } = require("./libs/quota-core.js");

    const PROVIDER_PREFIX = "quota-provider/";
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

    function providerDocId(id) {
      return `${PROVIDER_PREFIX}${id}`;
    }

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

    function idFromDoc(doc) {
      return String(doc._id || "").slice(PROVIDER_PREFIX.length);
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

    function toRendererProvider(doc) {
      const api = requireUtools();
      const id = idFromDoc(doc);
      const templateId = normalizeTemplateId(doc.templateId, doc.mode);
      const template = getProviderTemplate(templateId);

      return {
        id,
        name: doc.name,
        baseUrl: doc.baseUrl,
        templateId,
        requestPath: doc.requestPath || template.requestPath || BALANCE_ROUTE,
        requestMethod: doc.requestMethod || template.requestMethod || REQUEST_METHOD_GET,
        authPlacement: doc.authPlacement || template.authPlacement || AUTH_PLACEMENT_HEADER,
        requestHeaders:
          doc.requestHeaders ||
          template.requestHeaders ||
          getDefaultAdvancedHeadersText(doc.authPlacement || AUTH_PLACEMENT_HEADER),
        requestBody:
          doc.requestBody ||
          template.requestBody ||
          getDefaultAdvancedBodyText(doc.authPlacement || AUTH_PLACEMENT_HEADER),
        jsonPaths: {
          ...DEFAULT_JSON_PATHS,
          ...template.jsonPaths,
          ...(doc.jsonPaths || {})
        },
        manualLimit: doc.manualLimit ?? null,
        defaultUnit: String(doc.defaultUnit || DEFAULT_UNIT).trim() || DEFAULT_UNIT,
        refreshIntervalMinutes: doc.refreshIntervalMinutes,
        lastBalance: doc.lastBalance ?? null,
        lastLimit: doc.lastLimit ?? null,
        lastUsed: doc.lastUsed ?? null,
        lastResetAt: doc.lastResetAt ?? null,
        lastUnit: String(doc.lastUnit || doc.defaultUnit || DEFAULT_UNIT).trim() || DEFAULT_UNIT,
        lastIsValid: doc.lastIsValid ?? null,
        lastCheckedAt: doc.lastCheckedAt ?? null,
        lastError: doc.lastError ?? "",
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        hasApiKey: Boolean(api.dbCryptoStorage.getItem(apiKeyStorageKey(id)))
      };
    }

    async function getProviderDoc(id) {
      const api = requireUtools();
      const doc = await api.db.promises.get(providerDocId(id));

      if (!doc || doc._deleted) {
        throw new Error("站点不存在");
      }

      return doc;
    }

    async function listProviderDocs() {
      const api = requireUtools();
      const docs = await api.db.promises.allDocs(PROVIDER_PREFIX);

      return docs
        .filter((doc) => doc && !doc._deleted)
        .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    }

    async function putProviderPatch(id, patch) {
      const api = requireUtools();
      const current = await getProviderDoc(id);
      const result = await api.db.promises.put({
        ...current,
        ...patch
      });
      assertDbResult(result, "保存站点");
      return getProviderDoc(id);
    }

    function createResponseError(message, detail) {
      return new Error(createResponseErrorMessage(message, detail));
    }

    function requestJson(config, timeoutMs) {
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
                reject(createResponseError("请求返回非成功状态", detail));
                return;
              }

              try {
                resolve(JSON.parse(normalizeBodyForJson(body)));
              } catch {
                reject(createResponseError("响应不是有效的 JSON", detail));
              }
            });
          }
        );

        request.on("error", reject);
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

    async function saveProvider(input) {
      const api = requireUtools();
      const id = input && input.id ? String(input.id) : createProviderId();
      const existing = input && input.id ? await getProviderDoc(id) : null;
      const normalized = normalizeProviderInput(input, { isUpdate: Boolean(existing) });
      const now = new Date().toISOString();

      const doc = {
        ...(existing || {}),
        _id: providerDocId(id),
        name: normalized.name,
        baseUrl: normalized.baseUrl,
        templateId: normalized.templateId,
        requestPath: normalized.requestPath,
        requestMethod: normalized.requestMethod,
        authPlacement: normalized.authPlacement,
        requestHeaders: normalized.requestHeaders,
        requestBody: normalized.requestBody,
        jsonPaths: normalized.jsonPaths,
        manualLimit: normalized.manualLimit,
        defaultUnit: normalized.defaultUnit,
        refreshIntervalMinutes: normalized.refreshIntervalMinutes,
        lastBalance: existing ? existing.lastBalance ?? null : null,
        lastLimit: existing ? existing.lastLimit ?? null : null,
        lastUsed: existing ? existing.lastUsed ?? null : null,
        lastResetAt: existing ? existing.lastResetAt ?? null : null,
        lastUnit: existing ? existing.lastUnit ?? normalized.defaultUnit : normalized.defaultUnit,
        lastIsValid: existing ? existing.lastIsValid ?? null : null,
        lastCheckedAt: existing ? existing.lastCheckedAt ?? null : null,
        lastError: existing ? existing.lastError ?? "" : "",
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now
      };

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

    async function deleteProvider(id) {
      const api = requireUtools();
      const doc = await getProviderDoc(id);
      const result = await api.db.promises.remove(doc);
      assertDbResult(result, "删除站点");

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
        const config = buildProviderRequestConfig(provider, apiKey);
        const response = await requestJson(config, REQUEST_TIMEOUT_MS);
        const extracted = parseProviderBalanceResponse(
          response,
          provider.jsonPaths,
          provider.manualLimit,
          provider.defaultUnit
        );
        const updatedDoc = await putProviderPatch(id, {
          lastBalance: extracted.remaining,
          lastLimit: extracted.limit,
          lastUsed: extracted.used,
          lastResetAt: extracted.resetAt,
          lastUnit: extracted.unit,
          lastIsValid: extracted.isValid,
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
      listProviders,
      saveProvider,
      testProviderRequest,
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
