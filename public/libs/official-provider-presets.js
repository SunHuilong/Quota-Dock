"use strict";

const {
  clampRefreshInterval,
  getJsonPathValue,
  normalizeCurrencyOverride,
  normalizeManualLimit,
  normalizeQuotaSnapshot
} = require("./quota-core.js");

const DEFAULT_HEADERS = {
  Accept: "application/json"
};

function bearerHeaders(apiKey, extraHeaders) {
  return {
    ...DEFAULT_HEADERS,
    Authorization: `Bearer ${apiKey}`,
    ...(extraHeaders || {})
  };
}

function apiKeyHeaders(apiKey, extraHeaders) {
  return {
    ...DEFAULT_HEADERS,
    "x-api-key": apiKey,
    ...(extraHeaders || {})
  };
}

function numberValue(value, label) {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${label}不是有效数字`);
  }
  return number;
}

function firstValue(source, paths) {
  for (const path of paths) {
    const value = getJsonPathValue(source, path);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function firstNumber(source, paths, label) {
  return numberValue(firstValue(source, paths), label);
}

function firstString(source, paths, fallback) {
  const value = firstValue(source, paths);
  return value === null ? fallback : String(value).trim() || fallback;
}

function requireNumber(value, label) {
  const number = numberValue(value, label);
  if (number === null) {
    throw new Error(`${label}缺失`);
  }
  return number;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function slug(value, fallback) {
  const result = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return result || fallback;
}

function balanceMeter(id, label, remaining, unit, extra) {
  return {
    id,
    label,
    kind: "balance",
    remaining,
    used: null,
    limit: null,
    unit,
    resetAt: null,
    aggregate: true,
    ...(extra || {})
  };
}

function singleBalanceSnapshot(response, options) {
  const remaining = requireNumber(firstValue(response, options.paths), "余额字段");
  return {
    primaryMeterId: "balance",
    meters: [
      balanceMeter("balance", options.label || "可用余额", remaining * (options.multiplier || 1), options.unit)
    ]
  };
}

function parseDeepSeek(response) {
  if (response && response.is_available === false) {
    throw new Error("DeepSeek 账户当前不可用");
  }

  const balances = asArray(response && response.balance_infos);
  if (!balances.length) {
    throw new Error("DeepSeek 响应缺少余额信息");
  }

  const meters = balances.map((item, index) => {
    const unit = String(item.currency || "CNY").trim().toUpperCase() || "CNY";
    return balanceMeter(
      `balance-${slug(unit, String(index + 1))}`,
      balances.length > 1 ? `${unit} 可用余额` : "可用余额",
      requireNumber(item.total_balance, "DeepSeek 余额"),
      unit
    );
  });

  return { primaryMeterId: meters[0].id, meters };
}

function parseKimi(response, unit) {
  return singleBalanceSnapshot(response, {
    paths: ["data.available_balance", "available_balance", "data.balance", "balance"],
    unit,
    label: "可用余额"
  });
}

function parseStepFun(response) {
  return singleBalanceSnapshot(response, {
    paths: ["data.balance", "data.available_balance", "data[0].balance", "accounts[0].balance", "account.balance", "balance"],
    unit: "CNY",
    label: "可用余额"
  });
}

function parseSiliconFlow(response, unit) {
  return singleBalanceSnapshot(response, {
    paths: ["data.balance", "data.totalBalance", "data.total_balance", "balance"],
    unit,
    label: "可用余额"
  });
}

function parse302Ai(response) {
  return singleBalanceSnapshot(response, {
    paths: ["data.balance", "balance", "data.available_balance", "available_balance", "data"],
    unit: "USD",
    label: "可用余额"
  });
}

function parseNovita(response) {
  return singleBalanceSnapshot(response, {
    paths: ["data.balance", "balance", "data.available_balance", "available_balance"],
    unit: "USD",
    multiplier: 1 / 10000,
    label: "可用余额"
  });
}

function parseOpenRouterKey(response) {
  const data = response && response.data ? response.data : response;
  const limit = firstNumber(data, ["limit"], "Key 总额度");
  const used = firstNumber(data, ["usage", "usage_monthly", "usage_daily"], "Key 已用额度");
  let remaining = firstNumber(data, ["limit_remaining", "remaining"], "Key 剩余额度");

  if (remaining === null && limit !== null && used !== null) {
    remaining = limit - used;
  }
  if (remaining === null && used === null) {
    throw new Error("OpenRouter 响应缺少 Key 额度信息");
  }

  return {
    primaryMeterId: "key-quota",
    meters: [
      {
        id: "key-quota",
        label: remaining === null ? "Key 已用额度" : "Key 剩余额度",
        kind: "quota",
        remaining,
        used,
        limit,
        unit: "USD",
        resetAt: firstString(data, ["reset_at", "limit_reset"], null),
        aggregate: false
      }
    ]
  };
}

function parseOpenRouterCredits(response) {
  const data = response && response.data ? response.data : response;
  const limit = requireNumber(firstValue(data, ["total_credits", "totalCredits"]), "累计充值额度");
  const used = requireNumber(firstValue(data, ["total_usage", "totalUsage"]), "累计已用额度");
  return {
    primaryMeterId: "account-credits",
    meters: [
      balanceMeter("account-credits", "账户余额", limit - used, "USD", {
        used,
        limit
      })
    ]
  };
}

function quotaItemMeter(item, index, prefix, defaultUnit) {
  const label = firstString(
    item,
    ["label", "name", "model_name", "modelName", "model", "type", "quota_type", "quotaType"],
    `额度 ${index + 1}`
  );
  const limit = firstNumber(item, ["limit", "total", "total_count", "totalCount", "max", "maxValue", "quota"], `${label}总额度`);
  const used = firstNumber(item, ["used", "usage", "used_count", "usedCount", "current", "currentValue", "consumed"], `${label}已用额度`);
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
    resetAt: firstString(item, ["reset_at", "resetAt", "end_time", "endTime", "next_reset_time", "nextResetTime"], null),
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
  const meters = items.map((item, index) => quotaItemMeter(item, index, "plan", "Tokens")).filter(Boolean);
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
  const quotaItems = findQuotaItems(quotaResponse);
  const meters = quotaItems.map((item, index) => quotaItemMeter(item, index, "quota", "次")).filter(Boolean);

  const usageSources = [
    { response: responses && responses.models, prefix: "model", fallback: "模型用量" },
    { response: responses && responses.tools, prefix: "tool", fallback: "工具用量" }
  ];

  for (const source of usageSources) {
    const items = collectUsageItems(source.response);
    items.forEach((item, index) => {
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

function parseAiHubMix(response) {
  const remaining = requireNumber(
    firstValue(response, ["data.quota", "quota", "data.balance", "balance"]),
    "AIHubMix 余额"
  );
  return {
    primaryMeterId: "balance",
    meters: [balanceMeter("balance", "可用余额", remaining / 500000, "USD")]
  };
}

function parseXaiBilling(responses) {
  const prepaidRaw = firstNumber(responses.prepaid, ["total.val", "total"], "预付余额");
  const preview = responses.preview || {};
  const limitRaw = firstNumber(preview, ["effectiveSpendingLimit"], "后付费上限");
  const usedRaw = firstNumber(
    preview,
    ["coreInvoice.totalWithCorr.val", "coreInvoice.amountAfterVat", "coreInvoice.amountBeforeVat"],
    "后付费已用额度"
  );
  const meters = [];

  if (prepaidRaw !== null) {
    meters.push(balanceMeter("prepaid", "预付余额", Math.abs(prepaidRaw) / 100, "USD"));
  }
  if (limitRaw !== null || usedRaw !== null) {
    const limit = limitRaw === null ? null : limitRaw / 100;
    const used = usedRaw === null ? null : usedRaw / 100;
    meters.push({
      id: "postpaid",
      label: "本月后付费额度",
      kind: "spend",
      remaining: limit !== null && used !== null ? limit - used : null,
      used,
      limit,
      unit: "USD",
      resetAt: null,
      aggregate: false
    });
  }
  if (!meters.length) {
    throw new Error("xAI 响应缺少账单额度信息");
  }
  return { primaryMeterId: meters[0].id, meters };
}

function sumOpenAiCosts(pages) {
  let used = 0;
  let unit = "USD";
  for (const page of pages) {
    for (const bucket of asArray(page && page.data)) {
      for (const result of asArray(bucket && bucket.results)) {
        const value = firstNumber(result, ["amount.value"], "OpenAI 费用");
        if (value !== null) {
          used += value;
        }
        unit = firstString(result, ["amount.currency"], unit).toUpperCase();
      }
    }
  }
  return { used, unit };
}

function parseOpenAiOrganization(responses) {
  const limitRaw = firstNumber(responses.limit, ["threshold_amount"], "OpenAI 组织额度");
  const costs = sumOpenAiCosts(asArray(responses.costPages));
  const limit = limitRaw === null ? null : limitRaw / 100;
  return {
    primaryMeterId: "monthly-spend",
    meters: [
      {
        id: "monthly-spend",
        label: limit === null ? "本月已用" : "本月可用额度",
        kind: "spend",
        remaining: limit === null ? null : limit - costs.used,
        used: costs.used,
        limit,
        unit: firstString(responses.limit, ["currency"], costs.unit).toUpperCase(),
        resetAt: null,
        aggregate: false
      }
    ]
  };
}

function parseAnthropicOrganization(pages) {
  let used = 0;
  let unit = "USD";
  for (const page of pages) {
    for (const bucket of asArray(page && page.data)) {
      const results = asArray(bucket && bucket.results).length ? bucket.results : [bucket];
      for (const result of results) {
        const amount = firstNumber(result, ["amount", "amount.value", "cost"], "Anthropic 费用");
        if (amount !== null) {
          used += amount / 100;
        }
        unit = firstString(result, ["currency", "amount.currency"], unit).toUpperCase();
      }
    }
  }
  return {
    primaryMeterId: "monthly-spend",
    meters: [
      {
        id: "monthly-spend",
        label: "本月已用",
        kind: "spend",
        remaining: null,
        used,
        limit: null,
        unit,
        resetAt: null,
        aggregate: false
      }
    ]
  };
}

function simplePreset(definition) {
  return {
    ...definition,
    async execute(context) {
      const response = await context.requestJson({
        url: definition.url,
        method: "GET",
        headers: (definition.headers || bearerHeaders)(context.apiKey)
      });
      return definition.parse(response);
    }
  };
}

const PRESETS = [
  simplePreset({
    id: "deepseek-api",
    name: "DeepSeek API",
    category: "api",
    defaultUnit: "CNY",
    url: "https://api.deepseek.com/user/balance",
    parse: parseDeepSeek
  }),
  simplePreset({
    id: "kimi-api-cn",
    name: "Kimi API（国内）",
    category: "api",
    defaultUnit: "CNY",
    url: "https://api.moonshot.cn/v1/users/me/balance",
    parse: (response) => parseKimi(response, "CNY")
  }),
  simplePreset({
    id: "kimi-api-global",
    name: "Kimi API（国际）",
    category: "api",
    defaultUnit: "USD",
    url: "https://api.moonshot.ai/v1/users/me/balance",
    parse: (response) => parseKimi(response, "USD")
  }),
  simplePreset({
    id: "stepfun-api",
    name: "阶跃星辰 StepFun API",
    category: "api",
    defaultUnit: "CNY",
    url: "https://api.stepfun.com/v1/accounts",
    parse: parseStepFun
  }),
  simplePreset({
    id: "siliconflow-cn",
    name: "硅基流动（国内）",
    category: "api",
    defaultUnit: "CNY",
    url: "https://api.siliconflow.cn/v1/user/info",
    parse: (response) => parseSiliconFlow(response, "CNY")
  }),
  simplePreset({
    id: "siliconflow-global",
    name: "SiliconFlow（国际）",
    category: "api",
    defaultUnit: "USD",
    url: "https://api.siliconflow.com/v1/user/info",
    parse: (response) => parseSiliconFlow(response, "USD")
  }),
  simplePreset({
    id: "302ai",
    name: "302.AI",
    category: "api",
    defaultUnit: "USD",
    credentialHelp: "Key 需要开启余额查询权限",
    url: "https://api.302.ai/dashboard/balance",
    parse: parse302Ai
  }),
  simplePreset({
    id: "novita-ai",
    name: "Novita AI",
    category: "api",
    defaultUnit: "USD",
    url: "https://api.novita.ai/v3/user/balance",
    parse: parseNovita
  }),
  simplePreset({
    id: "openrouter-key",
    name: "OpenRouter API Key 额度",
    category: "api",
    defaultUnit: "USD",
    url: "https://openrouter.ai/api/v1/key",
    parse: parseOpenRouterKey
  }),
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
  },
  {
    id: "xai-billing",
    name: "xAI / Grok 账单",
    category: "admin",
    defaultUnit: "USD",
    credentialLabel: "Management Key",
    credentialPlaceholder: "xai-...",
    credentialHelp: "需要 Team 范围及账单读取权限的 Management Key",
    parse: parseXaiBilling,
    async execute(context) {
      const headers = bearerHeaders(context.apiKey);
      const validation = await context.requestJson({
        url: "https://management-api.x.ai/auth/management-keys/validation",
        method: "GET",
        headers
      });
      const teamId = firstString(
        validation,
        validation && validation.scope === "SCOPE_TEAM" ? ["teamId", "scopeId"] : ["teamId"],
        ""
      );
      if (!teamId) {
        throw new Error("请使用 Team 范围的 xAI Management Key");
      }
      const encodedTeamId = encodeURIComponent(teamId);
      const [prepaid, preview] = await Promise.all([
        context.requestJson({
          url: `https://management-api.x.ai/v1/billing/teams/${encodedTeamId}/prepaid/balance`,
          method: "GET",
          headers
        }),
        context.requestJson({
          url: `https://management-api.x.ai/v1/billing/teams/${encodedTeamId}/postpaid/invoice/preview`,
          method: "GET",
          headers
        })
      ]);
      return parseXaiBilling({ prepaid, preview });
    }
  },
  {
    id: "openai-organization",
    name: "OpenAI Organization",
    category: "admin",
    defaultUnit: "USD",
    credentialLabel: "Admin API Key",
    credentialPlaceholder: "sk-admin-...",
    credentialHelp: "普通 Project API Key 无法查询组织账单",
    parse: parseOpenAiOrganization,
    async execute(context) {
      const headers = bearerHeaders(context.apiKey);
      const limit = await context.requestJson({
        url: "https://api.openai.com/v1/organization/spend_limit",
        method: "GET",
        headers
      });
      const startTime = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) / 1000);
      const costPages = [];
      let page = "";
      do {
        const url = new URL("https://api.openai.com/v1/organization/costs");
        url.searchParams.set("start_time", String(startTime));
        url.searchParams.set("limit", "31");
        if (page) {
          url.searchParams.set("page", page);
        }
        const response = await context.requestJson({ url: url.toString(), method: "GET", headers });
        costPages.push(response);
        page = response && response.has_more && response.next_page ? String(response.next_page) : "";
      } while (page && costPages.length < 100);
      return parseOpenAiOrganization({ limit, costPages });
    }
  },
  {
    id: "anthropic-organization",
    name: "Anthropic Organization",
    category: "admin",
    defaultUnit: "USD",
    credentialLabel: "Admin API Key",
    credentialPlaceholder: "sk-ant-admin01-...",
    credentialHelp: "普通 Workspace API Key 无法查询组织费用",
    parse: parseAnthropicOrganization,
    async execute(context) {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end = now;
      const pages = [];
      let page = "";
      do {
        const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
        url.searchParams.set("starting_at", start.toISOString());
        url.searchParams.set("ending_at", end.toISOString());
        url.searchParams.set("bucket_width", "1d");
        url.searchParams.set("limit", "31");
        if (page) {
          url.searchParams.set("page", page);
        }
        const response = await context.requestJson({
          url: url.toString(),
          method: "GET",
          headers: apiKeyHeaders(context.apiKey, { "anthropic-version": "2023-06-01" })
        });
        pages.push(response);
        page = response && response.has_more && response.next_page ? String(response.next_page) : "";
      } while (page && pages.length < 100);
      return parseAnthropicOrganization(pages);
    }
  },
  simplePreset({
    id: "openrouter-credits",
    name: "OpenRouter Account Credits",
    category: "admin",
    defaultUnit: "USD",
    url: "https://openrouter.ai/api/v1/credits",
    parse: parseOpenRouterCredits
  }),
  simplePreset({
    id: "aihubmix",
    name: "AIHubMix",
    category: "api",
    defaultUnit: "USD",
    url: "https://aihubmix.com/api/user/self",
    parse: parseAiHubMix
  })
];

async function executeGlmPlan(preset, context) {
  const headers = bearerHeaders(context.apiKey);
  const [models, tools, quota] = await Promise.all([
    context.requestJson({ url: `${preset.baseUrl}/api/monitor/usage/model-usage`, method: "GET", headers }),
    context.requestJson({ url: `${preset.baseUrl}/api/monitor/usage/tool-usage`, method: "GET", headers }),
    context.requestJson({ url: `${preset.baseUrl}/api/monitor/usage/quota/limit`, method: "GET", headers })
  ]);
  return parseGlmPlan({ models, tools, quota });
}

const CATEGORY_LABELS = {
  api: "按量 API",
  plan: "Coding / Token Plan",
  admin: "管理与账单"
};

function getOfficialProviderPreset(id) {
  return PRESETS.find((preset) => preset.id === String(id || "").trim()) || null;
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
