"use strict";

const {
  bearerHeaders,
  firstNumber,
  firstString,
  firstValue,
  normalizeResetAt,
  rawAuthorizationHeaders,
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
    resetAt: normalizeResetAt(
      firstValue(item, ["reset_at", "resetAt", "end_time", "endTime", "next_reset_time", "nextResetTime"])
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

function percentageNumber(source, paths, label) {
  const value = firstValue(source, paths);
  if (value === null) {
    return null;
  }
  const number = Number(typeof value === "string" ? value.trim().replace(/%$/, "") : value);
  if (!Number.isFinite(number)) {
    throw new Error(`${label}不是有效数字`);
  }
  return number;
}

function miniMaxModelWindowMeter(item, itemIndex, window) {
  const model = firstString(item, ["model_name", "modelName", "model"], `模型 ${itemIndex + 1}`);
  const isWeekly = window === "weekly";
  const label = `${model} · ${isWeekly ? "每周额度" : "滚动窗口额度"}`;
  const total = firstNumber(
    item,
    [isWeekly ? "current_weekly_total_count" : "current_interval_total_count"],
    `${label}总额度`
  );
  let used = firstNumber(
    item,
    [isWeekly ? "current_weekly_usage_count" : "current_interval_usage_count"],
    `${label}已用额度`
  );
  const remainingPercent = percentageNumber(
    item,
    [isWeekly ? "current_weekly_remaining_percent" : "current_interval_remaining_percent"],
    `${label}剩余比例`
  );
  const status = firstNumber(
    item,
    [isWeekly ? "current_weekly_status" : "current_interval_status"],
    `${label}状态`
  );
  const unlimited = status === 3;
  let remaining = null;

  if (unlimited) {
    used = used === null ? 0 : used;
  } else if (total !== null && used !== null) {
    remaining = Math.max(0, total - used);
  } else if (total !== null && remainingPercent !== null) {
    remaining = Math.max(0, total * (remainingPercent / 100));
  }

  if (!unlimited && remaining === null && used === null) {
    return null;
  }

  return {
    id: `plan-${slug(model, String(itemIndex + 1))}-${window}`,
    label: unlimited ? `${label}（无限额度）` : label,
    kind: "quota",
    remaining,
    used,
    limit: unlimited ? null : total,
    unit: "次",
    resetAt: normalizeResetAt(
      firstValue(item, [isWeekly ? "weekly_end_time" : "end_time", isWeekly ? "weeklyEndTime" : "endTime"])
    ),
    aggregate: false
  };
}

function miniMaxModelMeters(response) {
  const items = [
    response && response.model_remains,
    response && response.data && response.data.model_remains
  ].find(Array.isArray) || [];
  return items.flatMap((item, index) =>
    [miniMaxModelWindowMeter(item, index, "interval"), miniMaxModelWindowMeter(item, index, "weekly")].filter(Boolean)
  );
}

function miniMaxTimeRangeResetAt(item) {
  const explicit = normalizeResetAt(firstValue(item, ["end_time", "endTime", "reset_at", "resetAt"]));
  if (explicit) {
    return explicit;
  }

  const range = firstString(item, ["time_range", "timeRange"], "");
  const separator = range.lastIndexOf(" - ");
  if (separator < 0) {
    return null;
  }
  let end = range.slice(separator + 3).trim();
  if (!/^\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(end)) {
    return null;
  }

  const utcMatch = end.match(/\s*\(UTC([+-])(\d{1,2})(?::?(\d{2}))?\)$/i);
  if (utcMatch) {
    const [, sign, hours, minutes = "00"] = utcMatch;
    end = end.replace(utcMatch[0], `${sign}${hours.padStart(2, "0")}:${minutes}`);
  } else if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(end)) {
    return null;
  }
  return normalizeResetAt(end.replace(/\//g, "-").replace(" ", "T"));
}

function miniMaxServiceMeter(item, index) {
  const service = firstString(item, ["service_type", "serviceType", "name"], `服务 ${index + 1}`);
  const window = firstString(item, ["window_type", "windowType"], "");
  const rawLimit = firstValue(item, ["limit", "total"]);
  const rawStatus = firstString(item, ["status"], "").toLowerCase();
  const unlimited = /unlimited|无限/.test(String(rawLimit || "").toLowerCase()) || rawStatus === "unlimited";
  let limit = unlimited ? null : firstNumber(item, ["limit", "total"], `${service}总额度`);
  let used = firstNumber(item, ["usage", "used"], `${service}已用额度`);
  const percent = percentageNumber(item, ["percent", "percentage"], `${service}已用比例`);

  if (!unlimited && used === null && limit !== null && percent !== null) {
    used = limit * (percent / 100);
  }
  if (!unlimited && limit === null && used !== null && percent !== null && percent > 0) {
    limit = used / (percent / 100);
  }
  const remaining = unlimited || limit === null || used === null ? null : Math.max(0, limit - used);
  if (used === null && remaining === null) {
    return null;
  }

  const label = window ? `${service} · ${window}` : service;
  return {
    id: `plan-service-${slug(`${service}-${window}`, String(index + 1))}`,
    label: unlimited ? `${label}（无限额度）` : label,
    kind: "quota",
    remaining,
    used: used === null && unlimited ? 0 : used,
    limit,
    unit: "次",
    resetAt: miniMaxTimeRangeResetAt(item),
    aggregate: false
  };
}

function miniMaxServiceMeters(response) {
  const items = [
    response && response.data && response.data.services,
    response && response.services
  ].find(Array.isArray) || [];
  return items.map(miniMaxServiceMeter).filter(Boolean);
}

function parseMiniMaxPlan(response) {
  const meters = miniMaxModelMeters(response);
  if (!meters.length) {
    meters.push(...miniMaxServiceMeters(response));
  }
  if (!meters.length) {
    meters.push(
      ...findQuotaItems(response)
        .map((item, index) => quotaItemMeter(item, index, "plan", "次"))
        .filter(Boolean)
    );
  }
  if (!meters.length) {
    const single = quotaItemMeter((response && response.data) || response, 0, "plan", "次");
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

function glmQuotaMeter(item, index) {
  const type = firstString(item, ["type", "quota_type", "quotaType"], "").toUpperCase();
  const unitCode = firstString(item, ["unit"], "");
  const resetAt = normalizeResetAt(
    firstValue(item, ["reset_at", "resetAt", "end_time", "endTime", "next_reset_time", "nextResetTime"])
  );

  if (type === "TOKENS_LIMIT" && (unitCode === "3" || unitCode === "6")) {
    const percentage = percentageNumber(item, ["percentage"], "Token 已用比例");
    if (percentage !== null) {
      const used = Math.max(0, percentage);
      const window = unitCode === "3" ? "5 小时" : "每周";
      return {
        id: `quota-token-${unitCode === "3" ? "5h" : "weekly"}`,
        label: `Token 额度（${window}）`,
        kind: "quota",
        remaining: Math.max(0, 100 - used),
        used,
        limit: 100,
        unit: "%",
        resetAt,
        aggregate: false
      };
    }
  }

  if (type === "TIME_LIMIT" && unitCode === "5") {
    const limit = firstNumber(item, ["usage", "limit", "total"], "MCP 总额度");
    const used = firstNumber(item, ["currentValue", "current_value", "used"], "MCP 已用额度");
    let remaining = firstNumber(item, ["remaining", "remain"], "MCP 剩余额度");
    if (remaining === null && limit !== null && used !== null) {
      remaining = limit - used;
    }
    if (remaining !== null || used !== null) {
      return {
        id: "quota-mcp-monthly",
        label: "MCP 额度（每月）",
        kind: "quota",
        remaining,
        used,
        limit,
        unit: "次",
        resetAt,
        aggregate: false
      };
    }
  }

  return quotaItemMeter(item, index, "quota", "次");
}

function parseGlmPlan(responses) {
  const quotaResponse = responses && responses.quota ? responses.quota : responses;
  const meters = findQuotaItems(quotaResponse)
    .map(glmQuotaMeter)
    .filter(Boolean);
  const usageSources = [
    { response: responses && responses.models, prefix: "model", unit: "Tokens" },
    { response: responses && responses.tools, prefix: "tool", unit: "次" }
  ];
  for (const source of usageSources) {
    collectUsageItems(source.response).forEach((item, index) => {
      const meter = quotaItemMeter(item, index, source.prefix, source.unit);
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

function formatLocalDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  ].join(" ");
}

function glmUsageUrl(baseUrl, path, now) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, now.getHours(), 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 59, 59, 999);
  const url = new URL(`${baseUrl}${path}`);
  url.searchParams.set("startTime", formatLocalDateTime(start));
  url.searchParams.set("endTime", formatLocalDateTime(end));
  return url.toString();
}

async function executeGlmPlan(preset, context) {
  const credential = String(context.apiKey || "").trim();
  const alreadyBearer = /^Bearer\s+/i.test(credential);
  const extraHeaders = { "Accept-Language": "en-US,en", "Content-Type": "application/json" };
  let headers = rawAuthorizationHeaders(credential, extraHeaders);
  const quotaUrl = `${preset.baseUrl}/api/monitor/usage/quota/limit`;
  let quota;

  try {
    quota = await context.requestJson({ url: quotaUrl, method: "GET", headers });
  } catch (error) {
    if (alreadyBearer || !error || ![401, 403].includes(error.statusCode)) {
      throw error;
    }
    headers = bearerHeaders(credential, extraHeaders);
    quota = await context.requestJson({ url: quotaUrl, method: "GET", headers });
  }

  const now = new Date();
  const [models, tools] = await Promise.all([
    context.requestJson({
      url: glmUsageUrl(preset.baseUrl, "/api/monitor/usage/model-usage", now),
      method: "GET",
      headers
    }),
    context.requestJson({
      url: glmUsageUrl(preset.baseUrl, "/api/monitor/usage/tool-usage", now),
      method: "GET",
      headers
    })
  ]);
  return parseGlmPlan({ models, tools, quota });
}

const PLAN_PRESETS = [
  simplePreset({
    id: "minimax-token-plan",
    name: "MiniMax Token Plan",
    category: "plan",
    defaultUnit: "次",
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
