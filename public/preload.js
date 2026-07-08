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
      REQUEST_TIMEOUT_MS,
      buildBalanceUrl,
      normalizeProviderInput,
      normalizeBodyForJson,
      parseBalanceResponse,
      safeErrorMessage,
      shouldRefreshProvider,
      createResponseErrorMessage
    } = require("./libs/quota-core.js");

    const PROVIDER_PREFIX = "quota-provider/";
    const API_KEY_PREFIX = "quota-api-key/";

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

      return {
        id,
        name: doc.name,
        baseUrl: doc.baseUrl,
        refreshIntervalMinutes: doc.refreshIntervalMinutes,
        lastBalance: doc.lastBalance ?? null,
        lastLimit: doc.lastLimit ?? null,
        lastUsed: doc.lastUsed ?? null,
        lastResetAt: doc.lastResetAt ?? null,
        lastUnit: doc.lastUnit ?? "USD",
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
        throw new Error("中转站不存在");
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
      assertDbResult(result, "保存中转站");
      return getProviderDoc(id);
    }

    function createResponseError(message, detail) {
      return new Error(createResponseErrorMessage(message, detail));
    }

    function requestJson(url, apiKey, timeoutMs) {
      return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const client = parsed.protocol === "http:" ? http : https;

        const request = client.request(
          parsed,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "User-Agent": "cc-switch/1.0",
              Accept: "application/json"
            }
          },
          (response) => {
            const chunks = [];
            const detail = {
              url,
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
        refreshIntervalMinutes: normalized.refreshIntervalMinutes,
        lastBalance: existing ? existing.lastBalance ?? null : null,
        lastLimit: existing ? existing.lastLimit ?? null : null,
        lastUsed: existing ? existing.lastUsed ?? null : null,
        lastResetAt: existing ? existing.lastResetAt ?? null : null,
        lastUnit: existing ? existing.lastUnit ?? "USD" : "USD",
        lastIsValid: existing ? existing.lastIsValid ?? null : null,
        lastCheckedAt: existing ? existing.lastCheckedAt ?? null : null,
        lastError: existing ? existing.lastError ?? "" : "",
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now
      };

      const result = await api.db.promises.put(doc);
      assertDbResult(result, "保存中转站");

      if (normalized.apiKey) {
        api.dbCryptoStorage.setItem(apiKeyStorageKey(id), normalized.apiKey);
      }

      return toRendererProvider(await getProviderDoc(id));
    }

    async function deleteProvider(id) {
      const api = requireUtools();
      const doc = await getProviderDoc(id);
      const result = await api.db.promises.remove(doc);
      assertDbResult(result, "删除中转站");
      api.dbCryptoStorage.removeItem(apiKeyStorageKey(id));
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
        const response = await requestJson(buildBalanceUrl(doc.baseUrl), apiKey, REQUEST_TIMEOUT_MS);
        const extracted = parseBalanceResponse(response);
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

    async function openFloatingWindow() {
      const api = requireUtools();

      if (typeof api.createBrowserWindow !== "function") {
        throw new Error("当前 uTools 环境不支持创建浮窗");
      }

      if (floatingWindow && (!floatingWindow.isDestroyed || !floatingWindow.isDestroyed())) {
        if (floatingWindow.show) {
          floatingWindow.show();
        }
        if (floatingWindow.focus) {
          floatingWindow.focus();
        }
        return true;
      }

      floatingWindow = api.createBrowserWindow(
        "floating.html",
        {
          width: 360,
          height: 460,
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
      deleteProvider,
      refreshProvider,
      refreshDueProviders,
      refreshAll,
      openFloatingWindow
    };
  } catch (error) {
    exposePreloadError(error);
  }
})();
