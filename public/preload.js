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
    const {
      DEFAULT_REFRESH_CONCURRENCY,
      DEFAULT_STALE_AFTER_MINUTES,
      MCP_TOOL_NAMES,
      createHealthReport,
      createOverview,
      createRefreshBatch,
      createRefreshOutcome,
      normalizeHealthThresholds,
      projectProviderDetail,
      runBoundedTasks
    } = require("./libs/quota-mcp.js");

    const API_KEY_PREFIX = "quota-api-key/";
    const FLOATING_WINDOW_WIDTH = 360;
    const FLOATING_WINDOW_MIN_HEIGHT = 188;
    const FLOATING_WINDOW_FALLBACK_MAX_HEIGHT = 460;
    const FLOATING_WINDOW_MAX_HEIGHT_RATIO = 0.7;
    const FLOATING_WINDOW_LAYOUT_INTERVAL = 1000;
    const FLOATING_WINDOW_RADIUS = 22;
    const FLOATING_MEASURE_SCRIPT = `(() => {
      const shell = document.querySelector(".floating-shell");
      if (!shell) {
        return null;
      }

      const visibleChildren = (element) =>
        Array.from(element.children).filter((child) => window.getComputedStyle(child).display !== "none");
      const boxMetrics = (element) => {
        const style = window.getComputedStyle(element);
        const gap = Number.parseFloat(style.rowGap || style.gap) || 0;
        const padding =
          (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
        const border =
          (Number.parseFloat(style.borderTopWidth) || 0) +
          (Number.parseFloat(style.borderBottomWidth) || 0);
        return { gap, padding, border };
      };
      const naturalStackHeight = (element) => {
        const children = visibleChildren(element);
        const { gap, padding, border } = boxMetrics(element);
        const childHeight = children.reduce(
          (total, child) => total + child.getBoundingClientRect().height,
          0
        );
        return border + padding + childHeight + gap * Math.max(0, children.length - 1);
      };

      const shellChildren = visibleChildren(shell);
      const { gap, padding, border } = boxMetrics(shell);
      const contentHeight = shellChildren.reduce((total, child) => {
        const isFlexibleStack =
          child.classList.contains("floating-list") || child.classList.contains("floating-empty");
        return total + (isFlexibleStack ? naturalStackHeight(child) : child.getBoundingClientRect().height);
      }, 0);
      const screenInfo = window.screen || {};

      return {
        contentHeight: Math.ceil(border + padding + contentHeight + gap * Math.max(0, shellChildren.length - 1)),
        availableHeight: Number(screenInfo.availHeight),
        availableTop: Number(screenInfo.availTop)
      };
    })()`;
    const FLOATING_SYNC_SCRIPT = `(async () => {
      for (let attempt = 0; attempt < 20 && typeof window.__quotaSyncProviders !== "function"; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 25));
      }
      if (typeof window.__quotaSyncProviders === "function") {
        await window.__quotaSyncProviders();
      }
      await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
      return ${FLOATING_MEASURE_SCRIPT};
    })()`;
    const utoolsApi = typeof utools !== "undefined" ? utools : root.utools;
    let floatingWindow = null;
    let floatingLayoutTask = null;
    let floatingLayoutTimer = null;
    const providerRefreshFlights = new Map();

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

    function createRoundedWindowShape(width, height) {
      const radius = Math.min(FLOATING_WINDOW_RADIUS, Math.floor(width / 2), Math.floor(height / 2));
      const shape = [
        {
          x: 0,
          y: radius,
          width,
          height: Math.max(0, height - radius * 2)
        }
      ];

      for (let y = 0; y < radius; y += 1) {
        const distanceFromCenter = radius - y - 0.5;
        const inset = Math.ceil(radius - Math.sqrt(radius * radius - distanceFromCenter * distanceFromCenter));
        const rowWidth = Math.max(0, width - inset * 2);
        shape.push({ x: inset, y, width: rowWidth, height: 1 });
        shape.push({ x: inset, y: height - y - 1, width: rowWidth, height: 1 });
      }

      return shape;
    }

    function applyFloatingWindowShape(targetWindow, width, height) {
      if (!targetWindow || typeof targetWindow.setShape !== "function") {
        return false;
      }

      try {
        targetWindow.setShape(createRoundedWindowShape(width, height));
        return true;
      } catch (error) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[quota-dock] 系统窗口圆角不可用，已使用 CSS 圆角降级", error);
        }
        return false;
      }
    }

    function applyFloatingWindowSurface(targetWindow, width, height) {
      if (!targetWindow) {
        return;
      }

      try {
        if (typeof targetWindow.setBackgroundColor === "function") {
          targetWindow.setBackgroundColor("#00000000");
        }

        if (typeof targetWindow.setHasShadow === "function") {
          targetWindow.setHasShadow(false);
        }

        applyFloatingWindowShape(targetWindow, width, height);
      } catch (error) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[quota-dock] 浮窗透明圆角设置失败，已使用 CSS 圆角降级", error);
        }
      }
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
        showInFloatingWindow: doc.showInFloatingWindow !== false,
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
        showInFloatingWindow: existing ? existing.showInFloatingWindow !== false : true,
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

    async function setProviderFloatingVisibility(id, visible) {
      const providerId = String(id || "").trim();
      if (!providerId) {
        throw new Error("站点 ID 不能为空");
      }
      if (typeof visible !== "boolean") {
        throw new Error("浮窗展示状态无效");
      }

      const updatedDoc = await putProviderPatch(providerId, {
        showInFloatingWindow: visible,
        updatedAt: new Date().toISOString()
      });
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

    async function performProviderRefresh(id) {
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

    function refreshProvider(id) {
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

    function refreshItemFromDoc(doc) {
      return {
        id: idFromDoc(doc),
        name: String((doc && doc.name) || "未命名站点").trim() || "未命名站点"
      };
    }

    async function runProviderRefreshBatch(docs, scope, ctx) {
      const items = docs.map(refreshItemFromDoc);
      const taskResults = await runBoundedTasks(
        items,
        (item) => refreshProvider(item.id),
        {
          concurrency: DEFAULT_REFRESH_CONCURRENCY,
          onProgress: async ({ progress, total, item, result }) => {
            if (!ctx || typeof ctx.sendProgress !== "function") {
              return;
            }

            const outcome = createRefreshOutcome(result, {
              nowMs: Date.now(),
              staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES
            });
            const message = outcome.success
              ? `已刷新站点：${item.name}`
              : `站点刷新未成功：${item.name}`;
            await ctx.sendProgress({ progress, total, message: message.slice(0, 2000) });
          }
        }
      );

      return createRefreshBatch(scope, taskResults, {
        nowMs: Date.now(),
        staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES
      });
    }

    async function refreshDueProviders() {
      const now = Date.now();
      const docs = await listProviderDocs();
      const dueDocs = docs.filter((doc) => shouldRefreshProvider(doc, now));

      await runProviderRefreshBatch(dueDocs, "due");

      return listProviders();
    }

    async function refreshAll() {
      const docs = await listProviderDocs();

      await runProviderRefreshBatch(docs, "all");

      return listProviders();
    }

    function stopFloatingLayoutMonitor() {
      if (floatingLayoutTimer) {
        clearInterval(floatingLayoutTimer);
        floatingLayoutTimer = null;
      }
    }

    function isFloatingWindowOpen() {
      if (!floatingWindow) {
        return false;
      }

      try {
        return typeof floatingWindow.isDestroyed !== "function" || !floatingWindow.isDestroyed();
      } catch {
        return false;
      }
    }

    function resizeFloatingWindow(layout) {
      if (!floatingWindow || !layout) {
        return false;
      }

      const contentHeight = Number(layout.contentHeight);
      if (!Number.isFinite(contentHeight) || contentHeight <= 0) {
        return false;
      }

      const availableHeight = Number(layout.availableHeight);
      const availableTop = Number(layout.availableTop);
      const maxHeight = Number.isFinite(availableHeight) && availableHeight > 0
        ? Math.max(FLOATING_WINDOW_MIN_HEIGHT, Math.floor(availableHeight * FLOATING_WINDOW_MAX_HEIGHT_RATIO))
        : FLOATING_WINDOW_FALLBACK_MAX_HEIGHT;
      const targetHeight = Math.min(
        maxHeight,
        Math.max(FLOATING_WINDOW_MIN_HEIGHT, Math.ceil(contentHeight))
      );

      try {
        if (typeof floatingWindow.isDestroyed === "function" && floatingWindow.isDestroyed()) {
          return false;
        }

        const hasBoundsApi =
          typeof floatingWindow.getBounds === "function" && typeof floatingWindow.setBounds === "function";
        const currentBounds = hasBoundsApi ? floatingWindow.getBounds() : null;
        const nextBounds = currentBounds ? { ...currentBounds, width: FLOATING_WINDOW_WIDTH, height: targetHeight } : null;

        if (
          nextBounds &&
          Number.isFinite(availableTop) &&
          Number.isFinite(availableHeight) &&
          availableHeight > 0
        ) {
          const workAreaBottom = availableTop + availableHeight;
          nextBounds.y = Math.min(
            Math.max(nextBounds.y, availableTop),
            Math.max(availableTop, workAreaBottom - targetHeight)
          );
        }

        let changed = false;
        if (nextBounds) {
          changed =
            nextBounds.width !== currentBounds.width ||
            nextBounds.height !== currentBounds.height ||
            nextBounds.y !== currentBounds.y;
          if (changed) {
            floatingWindow.setBounds(nextBounds);
          }
        } else if (typeof floatingWindow.setSize === "function") {
          const actualSize = typeof floatingWindow.getSize === "function" ? floatingWindow.getSize() : null;
          changed =
            !Array.isArray(actualSize) ||
            actualSize[0] !== FLOATING_WINDOW_WIDTH ||
            actualSize[1] !== targetHeight;
          if (changed) {
            floatingWindow.setSize(FLOATING_WINDOW_WIDTH, targetHeight);
          }
        } else {
          return false;
        }

        if (changed) {
          applyFloatingWindowShape(floatingWindow, FLOATING_WINDOW_WIDTH, targetHeight);
        }

        return true;
      } catch (error) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[quota-dock] 同步浮窗高度失败", error);
        }
        return false;
      }
    }

    async function updateFloatingWindowLayout(script) {
      if (floatingLayoutTask) {
        await floatingLayoutTask.catch(() => null);
      }

      const task = (async () => {
        if (
          !floatingWindow ||
          (typeof floatingWindow.isDestroyed === "function" && floatingWindow.isDestroyed()) ||
          !floatingWindow.webContents ||
          typeof floatingWindow.webContents.executeJavaScript !== "function"
        ) {
          return null;
        }

        try {
          const layout = await floatingWindow.webContents.executeJavaScript(script);
          resizeFloatingWindow(layout);
          return layout;
        } catch (error) {
          if (typeof console !== "undefined" && console.warn) {
            console.warn("[quota-dock] 读取浮窗布局失败", error);
          }
          return null;
        }
      })();

      floatingLayoutTask = task;
      try {
        return await task;
      } finally {
        if (floatingLayoutTask === task) {
          floatingLayoutTask = null;
        }
      }
    }

    function startFloatingLayoutMonitor() {
      stopFloatingLayoutMonitor();
      floatingLayoutTimer = setInterval(() => {
        if (!floatingLayoutTask) {
          void updateFloatingWindowLayout(FLOATING_MEASURE_SCRIPT);
        }
      }, FLOATING_WINDOW_LAYOUT_INTERVAL);
      if (floatingLayoutTimer && typeof floatingLayoutTimer.unref === "function") {
        floatingLayoutTimer.unref();
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

      await updateFloatingWindowLayout(FLOATING_SYNC_SCRIPT);
    }

    async function openFloatingWindow() {
      const api = requireUtools();

      if (typeof api.createBrowserWindow !== "function") {
        throw new Error("当前 uTools 环境不支持创建浮窗");
      }

      if (isFloatingWindowOpen()) {
        await syncFloatingWindow();
        startFloatingLayoutMonitor();
        if (floatingWindow.show) {
          floatingWindow.show();
        }
        if (floatingWindow.focus) {
          floatingWindow.focus();
        }
        return true;
      }

      floatingWindow = null;
      let createdWindow = null;
      createdWindow = api.createBrowserWindow(
        "floating.html",
        {
          width: FLOATING_WINDOW_WIDTH,
          height: FLOATING_WINDOW_MIN_HEIGHT,
          title: "AI 额度浮窗",
          frame: false,
          resizable: false,
          closeable: true,
          minimizable: false,
          maximizable: false,
          skipTaskbar: true,
          alwaysOnTop: true,
          autoHideMenuBar: true,
          show: false,
          transparent: true,
          hasShadow: false,
          // CSS and setShape() own the corner clipping for transparent windows.
          roundedCorners: false,
          backgroundColor: "#00000000",
          webPreferences: {
            preload: path.join(__dirname, "preload.js")
          }
        },
        async () => {
          if (!createdWindow || floatingWindow !== createdWindow || !isFloatingWindowOpen()) {
            return;
          }
          applyFloatingWindowSurface(createdWindow, FLOATING_WINDOW_WIDTH, FLOATING_WINDOW_MIN_HEIGHT);
          await syncFloatingWindow();
          startFloatingLayoutMonitor();
          if (floatingWindow === createdWindow && createdWindow.show) {
            createdWindow.show();
          }
          if (floatingWindow === createdWindow && createdWindow.setAlwaysOnTop) {
            createdWindow.setAlwaysOnTop(true, "floating");
          }
        }
      );
      floatingWindow = createdWindow;

      if (createdWindow && createdWindow.on) {
        createdWindow.on("closed", () => {
          if (floatingWindow === createdWindow) {
            stopFloatingLayoutMonitor();
            floatingLayoutTask = null;
            floatingWindow = null;
          }
        });
      }

      return true;
    }

    async function closeFloatingWindow() {
      stopFloatingLayoutMonitor();

      if (!isFloatingWindowOpen()) {
        floatingWindow = null;
        floatingLayoutTask = null;
        return true;
      }

      const targetWindow = floatingWindow;
      floatingWindow = null;
      floatingLayoutTask = null;

      if (typeof targetWindow.close === "function") {
        await Promise.resolve(targetWindow.close());
      } else if (typeof targetWindow.destroy === "function") {
        await Promise.resolve(targetWindow.destroy());
      }

      return true;
    }

    function normalizeToolInput(input, allowedProperties) {
      const source = input === undefined || input === null ? {} : input;
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw new TypeError("工具输入必须是对象");
      }

      const allowed = new Set(allowedProperties);
      const unknownProperties = Object.keys(source).filter((key) => !allowed.has(key));
      if (unknownProperties.length > 0) {
        throw new TypeError(`工具输入包含未知字段：${unknownProperties.join(", ")}`);
      }
      return source;
    }

    function normalizeProviderId(value) {
      const providerId = typeof value === "string" ? value.trim() : "";
      if (!providerId || providerId.length > 256) {
        throw new TypeError("providerId 必须是长度不超过 256 的非空字符串");
      }
      return providerId;
    }

    async function getKnownProviderDoc(providerId) {
      const docs = await listProviderDocs();
      const doc = docs.find((item) => idFromDoc(item) === providerId);
      if (!doc) {
        throw new Error(`未知站点 ID：${providerId}`);
      }
      return doc;
    }

    async function selectRefreshDocs(input) {
      const source = normalizeToolInput(input, ["scope", "providerIds"]);
      const scope = source.scope;
      if (scope !== "due" && scope !== "all" && scope !== "selected") {
        throw new TypeError("scope 必须是 due、all 或 selected");
      }

      const docs = await listProviderDocs();
      if (scope === "all") {
        if (source.providerIds !== undefined) {
          throw new TypeError("providerIds 仅在 scope 为 selected 时可用");
        }
        return { scope, docs };
      }
      if (scope === "due") {
        if (source.providerIds !== undefined) {
          throw new TypeError("providerIds 仅在 scope 为 selected 时可用");
        }
        const now = Date.now();
        return { scope, docs: docs.filter((doc) => shouldRefreshProvider(doc, now)) };
      }

      if (!Array.isArray(source.providerIds) || source.providerIds.length === 0) {
        throw new TypeError("scope 为 selected 时 providerIds 必须是非空数组");
      }
      if (source.providerIds.length > 100) {
        throw new TypeError("providerIds 最多包含 100 个站点 ID");
      }

      const providerIds = source.providerIds.map(normalizeProviderId);
      if (new Set(providerIds).size !== providerIds.length) {
        throw new TypeError("providerIds 不能包含重复站点 ID");
      }

      const docsById = new Map(docs.map((doc) => [idFromDoc(doc), doc]));
      const unknownIds = providerIds.filter((providerId) => !docsById.has(providerId));
      if (unknownIds.length > 0) {
        throw new Error(`未知站点 ID：${unknownIds.join(", ")}`);
      }

      return {
        scope,
        docs: providerIds.map((providerId) => docsById.get(providerId))
      };
    }

    async function runMcpRefreshBatch(docs, scope, ctx) {
      const refresh = await runProviderRefreshBatch(docs, scope, ctx);
      await syncFloatingWindow();
      return refresh;
    }

    async function quotaOverviewTool(input, ctx) {
      normalizeToolInput(input, []);
      const docs = await listProviderDocs();
      const refresh = await runMcpRefreshBatch(docs, "all", ctx);
      const providers = await listProviders();
      return {
        ...createOverview(providers, {
          nowMs: Date.now(),
          staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES
        }),
        refresh
      };
    }

    async function quotaProviderDetailTool(input, ctx) {
      const source = normalizeToolInput(input, ["providerId"]);
      const providerId = normalizeProviderId(source.providerId);
      const doc = await getKnownProviderDoc(providerId);
      const refresh = await runMcpRefreshBatch([doc], "selected", ctx);
      const provider = (await listProviders()).find((item) => item.id === providerId);
      if (!provider) {
        throw new Error(`未知站点 ID：${providerId}`);
      }

      const nowMs = Date.now();
      return {
        generatedAt: new Date(nowMs).toISOString(),
        refresh,
        provider: projectProviderDetail(provider, {
          nowMs,
          staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES
        })
      };
    }

    async function quotaRefreshTool(input, ctx) {
      const selection = await selectRefreshDocs(input);
      const refresh = await runMcpRefreshBatch(selection.docs, selection.scope, ctx);
      return {
        generatedAt: new Date().toISOString(),
        ...refresh
      };
    }

    async function quotaHealthCheckTool(input, ctx) {
      const source = normalizeToolInput(input, ["remainingPercentBelow", "staleAfterMinutes"]);
      const thresholds = normalizeHealthThresholds(source);
      const docs = await listProviderDocs();
      const refresh = await runMcpRefreshBatch(docs, "all", ctx);
      const providers = await listProviders();
      return {
        ...createHealthReport(providers, thresholds, { nowMs: Date.now() }),
        refresh
      };
    }

    async function quotaSupportedPlatformsTool(input) {
      const source = normalizeToolInput(input, ["category"]);
      const category = source.category === undefined ? null : source.category;
      if (category !== null && category !== "api" && category !== "plan" && category !== "admin") {
        throw new TypeError("category 必须是 api、plan 或 admin");
      }

      const presets = await listPresetSummaries();
      const platforms = presets
        .filter((preset) => category === null || preset.category === category)
        .map((preset) => ({
          id: preset.id,
          name: preset.name,
          category: preset.category,
          categoryLabel: preset.categoryLabel,
          credentialLabel: preset.credentialLabel,
          credentialHelp: preset.credentialHelp,
          defaultUnit: preset.defaultUnit,
          supportsManualLimit: preset.supportsManualLimit,
          supportsCurrencyOverride: preset.supportsCurrencyOverride
        }));

      return {
        generatedAt: new Date().toISOString(),
        category,
        platformCount: platforms.length,
        platforms
      };
    }

    async function getFloatingToolState() {
      const providers = await listProviders();
      return {
        isOpen: isFloatingWindowOpen(),
        providers: providers.map((provider) => ({
          providerId: provider.id,
          name: provider.name,
          visible: provider.showInFloatingWindow !== false
        }))
      };
    }

    async function quotaFloatingWindowTool(input) {
      const source = normalizeToolInput(input, ["action"]);
      if (source.action !== "open" && source.action !== "close") {
        throw new TypeError("action 必须是 open 或 close");
      }

      if (source.action === "open") {
        await openFloatingWindow();
      } else {
        await closeFloatingWindow();
      }
      return getFloatingToolState();
    }

    async function quotaSetFloatingVisibilityTool(input) {
      const source = normalizeToolInput(input, ["providerId", "visible"]);
      const providerId = normalizeProviderId(source.providerId);
      if (typeof source.visible !== "boolean") {
        throw new TypeError("visible 必须是布尔值");
      }

      const provider = await setProviderFloatingVisibility(providerId, source.visible);
      await syncFloatingWindow();
      const state = await getFloatingToolState();
      return {
        ...state,
        provider: {
          providerId: provider.id,
          name: provider.name,
          visible: provider.showInFloatingWindow !== false
        }
      };
    }

    function isFloatingPreloadEntry() {
      const location = root && root.location;
      if (!location) {
        return false;
      }

      const pathname = String(location.pathname || "").replace(/\\/g, "/");
      return /(?:^|\/)floating\.html$/i.test(pathname);
    }

    function registerMcpTools() {
      if (
        isFloatingPreloadEntry() ||
        !utoolsApi ||
        typeof utoolsApi.registerTool !== "function"
      ) {
        return false;
      }

      const handlers = {
        quota_overview: quotaOverviewTool,
        quota_provider_detail: quotaProviderDetailTool,
        quota_refresh: quotaRefreshTool,
        quota_health_check: quotaHealthCheckTool,
        quota_supported_platforms: quotaSupportedPlatformsTool,
        quota_floating_window: quotaFloatingWindowTool,
        quota_set_floating_visibility: quotaSetFloatingVisibilityTool
      };

      for (const toolName of MCP_TOOL_NAMES) {
        utoolsApi.registerTool(toolName, handlers[toolName]);
      }
      return true;
    }

    root.quotaBridge = {
      getSyncState,
      listOfficialProviderPresets: listPresetSummaries,
      listProviders,
      saveProvider,
      setProviderFloatingVisibility,
      testProviderRequest,
      testOfficialProvider,
      deleteProvider,
      refreshProvider,
      refreshDueProviders,
      refreshAll,
      syncFloatingWindow,
      openFloatingWindow
    };
    registerMcpTools();
    root.__quotaPreloadReady = true;
    root.__quotaPreloadError = null;
  } catch (error) {
    exposePreloadError(error);
  }
})();
