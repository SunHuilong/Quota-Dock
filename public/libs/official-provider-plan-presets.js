"use strict";

const {
  bearerHeaders,
  firstNumber,
  firstString,
  simplePreset,
  slug
} = require("./official-provider-helpers.js");

function quotaItemMeter(item, index, prefix, defaultUnit) {
  const label = firstString(
    item,
    ["label", "name", "model_name", "modelName", "model", "type", "quota_type", "quotaType"],
    `额度 ${index + 1}`
  );
  const limit = firstNumber(
    item,
    ["limit", "total", "total_count", "totalCount", "max", "maxValue", "quota"],
    `${label}总额度`
  );
  const used = firstNumber(
    item,
    ["used", "usage", "used_count", "usedCount", "current", "currentValue", "consumed"],
    `${label}已用额度`
  );
  let remaining = firstNumber(
    item,
    ["remaining", "remain", "remains", "remain_count", "remainCount", "left", "available"],
    `${label}剩余额度`
  );
  if (remaining === null && limit !== null && used !== null) {
    remaining = limit - used;
  }
  if (remaining === null && used === null) {
    return null;
  }
  return {
    id: `${prefix}-${slug(label, String(index + 1))}`,
    label,
    kind: "quota",
    remaining,
    used,
    limit,
    unit: firstString(item, ["unit", "unit_name", "unitName"], defaultUnit),
    resetAt: firstString(
      item,
      ["reset_at", "resetAt", "end_time", "endTime", "next_reset_time", "nextResetTime"],
      null
    ),
    aggregate: false
  };
}

function findQuotaItems(response) {
  const candidates = [
    response && response.data && response.data.remains,
    response && response.data && response.data.limits,
    response && response.data && response.data.quotas,
    response && response.data && response.data.model_remains,
    response && response.remains,
    response && response.limits,
    response && response.quotas,
    response && response.model_remains,
    response && response.data,
    response
  ];
  return candidates.find(Array.isArray) || [];
}

function parseMiniMaxPlan(response) {
  const items = findQuotaItems(response);
  const meters = items
    .map((item, index) => quotaItemMeter(item, index, "plan", "Tokens"))
    .filter(Boolean);
  if (!meters.length) {
    const single = quotaItemMeter((response && response.data) || response, 0, "plan", "Tokens");
    if (single) {
      meters.push(single);
    }
  }
  if (!meters.length) {
    throw new Error("MiniMax 响应缺少套餐额度信息");
  }
  return { primaryMeterId: meters[0].id, meters };
}

function collectUsageItems(response) {
  if (Array.isArray(response)) {
    return response;
  }
  const data = response && response.data !== undefined ? response.data : response;
  if (Array.isArray(data)) {
    return data;
  }
  if (!data || typeof data !== "object") {
    return [];
  }
  return [data.items, data.list, data.records, data.usage, data.usages, data.limits, data.quotas].find(Array.isArray) || [];
}

function parseGlmPlan(responses) {
  const quotaResponse = responses && responses.quota ? responses.quota : responses;
  const meters = findQuotaItems(quotaResponse)
    .map((item, index) => quotaItemMeter(item, index, "quota", "次"))
    .filter(Boolean);
  const usageSources = [
    { response: responses && responses.models, prefix: "model" },
    { response: responses && responses.tools, prefix: "tool" }
  ];
  for (const source of usageSources) {
    collectUsageItems(source.response).forEach((item, index) => {
      const meter = quotaItemMeter(item, index, source.prefix, "次");
      if (meter && !meters.some((existing) => existing.id === meter.id)) {
        meters.push(meter);
      }
    });
  }
  if (!meters.length) {
    const single = quotaItemMeter((quotaResponse && quotaResponse.data) || quotaResponse, 0, "quota", "次");
    if (single) {
      meters.push(single);
    }
  }
  if (!meters.length) {
    throw new Error("Coding Plan 响应缺少额度信息");
  }
  return { primaryMeterId: meters[0].id, meters };
}

async function executeGlmPlan(preset, context) {
  const headers = bearerHeaders(context.apiKey);
  const [models, tools, quota] = await Promise.all([
    context.requestJson({ url: `${preset.baseUrl}/api/monitor/usage/model-usage`, method: "GET", headers }),
    context.requestJson({ url: `${preset.baseUrl}/api/monitor/usage/tool-usage`, method: "GET", headers }),
    context.requestJson({ url: `${preset.baseUrl}/api/monitor/usage/quota/limit`, method: "GET", headers })
  ]);
  return parseGlmPlan({ models, tools, quota });
}

const PLAN_PRESETS = [
  simplePreset({
    id: "minimax-token-plan",
    name: "MiniMax Token Plan",
    category: "plan",
    defaultUnit: "Tokens",
    supportsManualLimit: false,
    url: "https://www.minimax.io/v1/token_plan/remains",
    parse: parseMiniMaxPlan
  }),
  {
    id: "glm-coding-plan-cn",
    name: "智谱 GLM Coding Plan（国内）",
    category: "plan",
    defaultUnit: "次",
    supportsManualLimit: false,
    baseUrl: "https://open.bigmodel.cn",
    parse: parseGlmPlan,
    async execute(context) {
      return executeGlmPlan(this, context);
    }
  },
  {
    id: "zai-coding-plan",
    name: "Z.AI Coding Plan（国际）",
    category: "plan",
    defaultUnit: "次",
    supportsManualLimit: false,
    baseUrl: "https://api.z.ai",
    parse: parseGlmPlan,
    async execute(context) {
      return executeGlmPlan(this, context);
    }
  }
];

module.exports = { PLAN_PRESETS };
