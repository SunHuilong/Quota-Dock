"use strict";

const {
  MCP_TOOL_NAMES,
  DEFAULT_STALE_AFTER_MINUTES,
  createHealthReport,
  createOverview,
  normalizeHealthThresholds,
  projectProviderDetail
} = require("./quota-mcp.js");

function normalizeToolInput(input, allowedProperties) {
  const source = input === undefined || input === null ? {} : input;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("工具输入必须是对象");
  }

  const allowed = new Set(allowedProperties);
  const unknownProperties = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknownProperties.length) {
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

function normalizeRefreshSelection(input) {
  const source = normalizeToolInput(input, ["scope", "providerIds"]);
  const scope = source.scope;
  if (scope !== "due" && scope !== "all" && scope !== "selected") {
    throw new TypeError("scope 必须是 due、all 或 selected");
  }

  if (scope !== "selected") {
    if (source.providerIds !== undefined) {
      throw new TypeError("providerIds 仅在 scope 为 selected 时可用");
    }
    return { scope, providerIds: undefined };
  }

  if (!Array.isArray(source.providerIds) || !source.providerIds.length) {
    throw new TypeError("scope 为 selected 时 providerIds 必须是非空数组");
  }
  if (source.providerIds.length > 100) {
    throw new TypeError("providerIds 最多包含 100 个站点 ID");
  }

  const providerIds = source.providerIds.map(normalizeProviderId);
  if (new Set(providerIds).size !== providerIds.length) {
    throw new TypeError("providerIds 不能包含重复站点 ID");
  }
  return { scope, providerIds };
}

function createMcpHandlers(options) {
  const settings = options || {};
  const quotaService = settings.quotaService;
  const floatingController = settings.floatingController;
  const now = typeof settings.now === "function" ? settings.now : () => Date.now();

  if (!quotaService) {
    throw new TypeError("quotaService 不能为空");
  }
  if (!floatingController) {
    throw new TypeError("floatingController 不能为空");
  }

  function currentOptions(extra) {
    return {
      nowMs: now(),
      staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES,
      ...(extra || {})
    };
  }

  async function quotaOverview(input, ctx) {
    normalizeToolInput(input, []);
    const refresh = await quotaService.refreshBatch("all", undefined, ctx);
    const providers = await quotaService.listProviders();
    return {
      ...createOverview(providers, currentOptions()),
      refresh
    };
  }

  async function quotaProviderDetail(input, ctx) {
    const source = normalizeToolInput(input, ["providerId"]);
    const providerId = normalizeProviderId(source.providerId);
    const refresh = await quotaService.refreshBatch("selected", [providerId], ctx);
    const provider = await quotaService.getProvider(providerId);
    const projectionOptions = currentOptions();
    return {
      generatedAt: new Date(projectionOptions.nowMs).toISOString(),
      refresh,
      provider: projectProviderDetail(provider, projectionOptions)
    };
  }

  async function quotaRefresh(input, ctx) {
    const selection = normalizeRefreshSelection(input);
    const refresh = await quotaService.refreshBatch(selection.scope, selection.providerIds, ctx);
    return {
      generatedAt: new Date(now()).toISOString(),
      ...refresh
    };
  }

  async function quotaHealthCheck(input, ctx) {
    const source = normalizeToolInput(input, ["remainingPercentBelow", "staleAfterMinutes"]);
    const thresholds = normalizeHealthThresholds(source);
    const refresh = await quotaService.refreshBatch("all", undefined, ctx);
    const providers = await quotaService.listProviders();
    return {
      ...createHealthReport(providers, thresholds, { nowMs: now() }),
      refresh
    };
  }

  async function quotaSupportedPlatforms(input) {
    const source = normalizeToolInput(input, ["category"]);
    const category = source.category === undefined ? null : source.category;
    if (category !== null && category !== "api" && category !== "plan" && category !== "admin") {
      throw new TypeError("category 必须是 api、plan 或 admin");
    }

    const presets = await quotaService.listOfficialProviderPresets();
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
      generatedAt: new Date(now()).toISOString(),
      category,
      platformCount: platforms.length,
      platforms
    };
  }

  async function getFloatingState() {
    const providers = await quotaService.listProviders();
    return {
      isOpen: floatingController.isOpen(),
      providers: providers.map((provider) => ({
        providerId: provider.id,
        name: provider.name,
        visible: provider.showInFloatingWindow !== false
      }))
    };
  }

  async function quotaFloatingWindow(input) {
    const source = normalizeToolInput(input, ["action"]);
    if (source.action !== "open" && source.action !== "close") {
      throw new TypeError("action 必须是 open 或 close");
    }

    if (source.action === "open") {
      await floatingController.open();
    } else {
      await floatingController.close();
    }
    return getFloatingState();
  }

  async function quotaSetFloatingVisibility(input) {
    const source = normalizeToolInput(input, ["providerId", "visible"]);
    const providerId = normalizeProviderId(source.providerId);
    if (typeof source.visible !== "boolean") {
      throw new TypeError("visible 必须是布尔值");
    }

    const provider = await quotaService.setProviderFloatingVisibility(providerId, source.visible);
    const state = await getFloatingState();
    return {
      ...state,
      provider: {
        providerId: provider.id,
        name: provider.name,
        visible: provider.showInFloatingWindow !== false
      }
    };
  }

  return {
    quota_overview: quotaOverview,
    quota_provider_detail: quotaProviderDetail,
    quota_refresh: quotaRefresh,
    quota_health_check: quotaHealthCheck,
    quota_supported_platforms: quotaSupportedPlatforms,
    quota_floating_window: quotaFloatingWindow,
    quota_set_floating_visibility: quotaSetFloatingVisibility
  };
}

function registerMcpHandlers(utoolsApi, handlers) {
  if (!utoolsApi || typeof utoolsApi.registerTool !== "function") {
    return false;
  }

  for (const toolName of MCP_TOOL_NAMES) {
    utoolsApi.registerTool(toolName, handlers[toolName]);
  }
  return true;
}

module.exports = {
  normalizeToolInput,
  normalizeProviderId,
  normalizeRefreshSelection,
  createMcpHandlers,
  registerMcpHandlers
};
