"use strict";

const {
  apiKeyHeaders,
  asArray,
  balanceMeter,
  bearerHeaders,
  firstNumber,
  firstString,
  firstValue,
  requireNumber,
  simplePreset
} = require("./official-provider-helpers.js");

function parseOpenRouterCredits(response) {
  const data = response && response.data ? response.data : response;
  const limit = requireNumber(firstValue(data, ["total_credits", "totalCredits"]), "累计充值额度");
  const used = requireNumber(firstValue(data, ["total_usage", "totalUsage"]), "累计已用额度");
  return {
    primaryMeterId: "account-credits",
    meters: [balanceMeter("account-credits", "账户余额", limit - used, "USD", { used, limit })]
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

const ADMIN_PRESETS = [
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
      const now = new Date();
      const startTime = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
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
      const pages = [];
      let page = "";
      do {
        const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
        url.searchParams.set("starting_at", start.toISOString());
        url.searchParams.set("ending_at", now.toISOString());
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
  })
];

module.exports = { ADMIN_PRESETS };
