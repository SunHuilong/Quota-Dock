"use strict";

const { API_PRESETS } = require("./official-provider-api-presets.js");
const { PLAN_PRESETS } = require("./official-provider-plan-presets.js");
const { ADMIN_PRESETS } = require("./official-provider-admin-presets.js");
const {
  clampRefreshInterval,
  normalizeCurrencyOverride,
  normalizeManualLimit,
  normalizeQuotaSnapshot
} = require("./quota-core.js");

const PRESET_ORDER = [
  "deepseek-api",
  "kimi-api-cn",
  "kimi-api-global",
  "stepfun-api",
  "siliconflow-cn",
  "siliconflow-global",
  "302ai",
  "novita-ai",
  "openrouter-key",
  "minimax-token-plan",
  "glm-coding-plan-cn",
  "zai-coding-plan",
  "xai-billing",
  "openai-organization",
  "anthropic-organization",
  "openrouter-credits",
  "aihubmix"
];
const presetsById = new Map(
  [...API_PRESETS, ...PLAN_PRESETS, ...ADMIN_PRESETS].map((preset) => [preset.id, preset])
);
const PRESETS = PRESET_ORDER.map((id) => presetsById.get(id)).filter(Boolean);
const CATEGORY_LABELS = {
  api: "按量 API",
  plan: "Coding / Token Plan",
  admin: "管理与账单"
};

function getOfficialProviderPreset(id) {
  return presetsById.get(String(id || "").trim()) || null;
}

function getOfficialProviderPresetSummary(preset) {
  return {
    id: preset.id,
    name: preset.name,
    category: preset.category,
    categoryLabel: CATEGORY_LABELS[preset.category],
    credentialLabel: preset.credentialLabel || "API Key",
    credentialPlaceholder: preset.credentialPlaceholder || "sk-...",
    credentialHelp: preset.credentialHelp || "",
    defaultUnit: preset.defaultUnit || "USD",
    supportsManualLimit: preset.supportsManualLimit !== false,
    supportsCurrencyOverride: preset.category !== "plan"
  };
}

function listOfficialProviderPresets() {
  return PRESETS.map(getOfficialProviderPresetSummary);
}

function normalizeOfficialProviderInput(input, options) {
  const source = input || {};
  const preset = getOfficialProviderPreset(source.officialPresetId);
  const isUpdate = Boolean(options && options.isUpdate);
  const apiKey = String(source.apiKey || "").trim();
  if (!preset) {
    throw new Error("所选预设平台不可用");
  }
  if (!isUpdate && !apiKey) {
    throw new Error(`请填写${preset.credentialLabel || "API Key"}`);
  }
  return {
    mode: "official",
    officialPresetId: preset.id,
    name: String(source.name || "").trim() || preset.name,
    apiKey,
    manualLimit: preset.supportsManualLimit === false ? null : normalizeManualLimit(source.manualLimit),
    currencyOverride: preset.category === "plan" ? "" : normalizeCurrencyOverride(source.currencyOverride),
    refreshIntervalMinutes: clampRefreshInterval(source.refreshIntervalMinutes)
  };
}

function finalizePresetSnapshot(preset, snapshot, settings) {
  return normalizeQuotaSnapshot(snapshot, {
    defaultUnit: preset.defaultUnit || "USD",
    manualLimit: preset.supportsManualLimit === false ? null : settings && settings.manualLimit,
    currencyOverride: preset.category === "plan" ? "" : settings && settings.currencyOverride
  });
}

function parseOfficialProviderResponse(presetId, response, settings) {
  const preset = getOfficialProviderPreset(presetId);
  if (!preset) {
    throw new Error("预设平台不可用");
  }
  return finalizePresetSnapshot(preset, preset.parse(response), settings || {});
}

async function executeOfficialProvider(presetId, apiKey, requestJson, settings) {
  const preset = getOfficialProviderPreset(presetId);
  const key = String(apiKey || "").trim();
  if (!preset) {
    throw new Error("预设平台不可用");
  }
  if (!key) {
    throw new Error(`请填写${preset.credentialLabel || "API Key"}`);
  }
  if (typeof requestJson !== "function") {
    throw new TypeError("requestJson 必须是函数");
  }
  const snapshot = await preset.execute({ apiKey: key, requestJson });
  return finalizePresetSnapshot(preset, snapshot, settings || {});
}

module.exports = {
  listOfficialProviderPresets,
  getOfficialProviderPreset,
  getOfficialProviderPresetSummary,
  normalizeOfficialProviderInput,
  parseOfficialProviderResponse,
  executeOfficialProvider
};
