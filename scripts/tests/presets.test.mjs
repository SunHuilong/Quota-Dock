import assert from "node:assert/strict";
import test from "node:test";
import { require } from "./helpers.mjs";

const {
  executeOfficialProvider,
  listOfficialProviderPresets,
  normalizeOfficialProviderInput,
  parseOfficialProviderResponse
} = require("../../public/libs/official-provider-presets.js");

test("preset index preserves order and only exposes safe summaries", () => {
  const presets = listOfficialProviderPresets();
  assert.deepEqual(
    presets.map((preset) => preset.id),
    [
      "deepseek-api", "kimi-api-cn", "kimi-api-global", "stepfun-api", "siliconflow-cn",
      "siliconflow-global", "302ai", "novita-ai", "openrouter-key", "minimax-token-plan",
      "glm-coding-plan-cn", "zai-coding-plan", "xai-billing", "openai-organization",
      "anthropic-organization", "openrouter-credits", "aihubmix"
    ]
  );
  assert.ok(presets.every((preset) => !("url" in preset) && !("headers" in preset) && !("parse" in preset)));
  assert.equal(presets.find((preset) => preset.id === "xai-billing").credentialLabel, "Management Key");
  assert.equal(presets.find((preset) => preset.id === "openrouter-credits").credentialLabel, "Management Key");
  assert.equal(presets.find((preset) => preset.id === "aihubmix").credentialLabel, "System Access Token");
  assert.equal(presets.find((preset) => preset.id === "minimax-token-plan").defaultUnit, "次");
});

test("official input normalization applies preset capabilities", () => {
  assert.deepEqual(
    normalizeOfficialProviderInput({
      officialPresetId: "deepseek-api",
      name: "",
      apiKey: " key ",
      manualLimit: "100",
      currencyOverride: " cny ",
      refreshIntervalMinutes: 45
    }),
    {
      mode: "official",
      officialPresetId: "deepseek-api",
      name: "DeepSeek API",
      apiKey: "key",
      manualLimit: 100,
      currencyOverride: "CNY",
      refreshIntervalMinutes: 45
    }
  );
  const plan = normalizeOfficialProviderInput({
    officialPresetId: "minimax-token-plan",
    apiKey: "key",
    manualLimit: 100,
    currencyOverride: "USD",
    refreshIntervalMinutes: 30
  });
  assert.equal(plan.manualLimit, null);
  assert.equal(plan.currencyOverride, "");
  assert.throws(() => normalizeOfficialProviderInput({ officialPresetId: "missing", apiKey: "key" }), /不可用/);
});

test("api and plan parsers retain their provider-specific semantics", () => {
  const deepSeek = parseOfficialProviderResponse(
    "deepseek-api",
    {
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "88.5" },
        { currency: "USD", total_balance: "3.25" }
      ]
    },
    { manualLimit: 100 }
  );
  assert.equal(deepSeek.meters.length, 2);
  assert.equal(deepSeek.meters[0].limit, 100);

  const simpleFixtures = [
    ["kimi-api-cn", { data: { available_balance: "12.5" } }, 12.5, "CNY"],
    ["kimi-api-global", { data: { balance: 9 } }, 9, "USD"],
    ["stepfun-api", { data: { balance: "30" } }, 30, "CNY"],
    ["siliconflow-cn", { data: { balance: "42", totalBalance: "47" } }, 47, "CNY"],
    ["siliconflow-global", { data: { totalBalance: "7.5" } }, 7.5, "USD"],
    ["302ai", { data: { balance: 6 } }, 6, "USD"],
    ["novita-ai", { availableBalance: 123400 }, 12.34, "USD"],
    ["aihubmix", { data: { quota: 2500000 } }, 5, "USD"]
  ];
  for (const [id, fixture, remaining, unit] of simpleFixtures) {
    const snapshot = parseOfficialProviderResponse(id, fixture);
    assert.equal(snapshot.meters[0].remaining, remaining, id);
    assert.equal(snapshot.meters[0].unit, unit, id);
  }

  const key = parseOfficialProviderResponse("openrouter-key", {
    data: { limit: 20, usage: 99, usage_daily: 7, limit_reset: "daily" }
  });
  assert.deepEqual(
    [key.meters[0].remaining, key.meters[0].used, key.meters[0].limit, key.meters[0].aggregate],
    [13, 7, 20, false]
  );
  assert.equal(key.meters[0].resetAt, null);

  const keyWithExplicitRemaining = parseOfficialProviderResponse("openrouter-key", {
    data: {
      limit: 50,
      limit_remaining: 32,
      usage: 500,
      usage_weekly: 18,
      limit_reset: "weekly",
      reset_at: "2026-08-24T00:00:00Z"
    }
  });
  assert.deepEqual(
    [
      keyWithExplicitRemaining.meters[0].remaining,
      keyWithExplicitRemaining.meters[0].used,
      keyWithExplicitRemaining.meters[0].resetAt
    ],
    [32, 18, "2026-08-24T00:00:00.000Z"]
  );

  const minimaxLegacy = parseOfficialProviderResponse("minimax-token-plan", {
    data: { remains: [{ model_name: "MiniMax-M2", total_count: 1000, used_count: 250, remain_count: 750 }] }
  });
  assert.equal(minimaxLegacy.meters[0].remaining, 750);

  const minimax = parseOfficialProviderResponse("minimax-token-plan", {
    model_remains: [
      {
        model_name: "MiniMax-M2",
        end_time: 1787148000,
        current_interval_total_count: 1000,
        current_interval_usage_count: 250,
        current_interval_remaining_percent: 75,
        current_interval_status: 1,
        weekly_end_time: 1787580000,
        current_weekly_total_count: 10000,
        current_weekly_usage_count: 1250,
        current_weekly_status: 3
      }
    ]
  });
  assert.equal(minimax.meters.length, 2);
  assert.deepEqual(
    [minimax.meters[0].remaining, minimax.meters[0].used, minimax.meters[0].limit, minimax.meters[0].unit],
    [750, 250, 1000, "次"]
  );
  assert.equal(minimax.meters[0].resetAt, new Date(1787148000 * 1000).toISOString());
  assert.deepEqual(
    [minimax.meters[1].remaining, minimax.meters[1].used, minimax.meters[1].limit],
    [null, 1250, null]
  );
  assert.match(minimax.meters[1].label, /无限额度/);

  const minimaxServices = parseOfficialProviderResponse("minimax-token-plan", {
    data: {
      services: [
        {
          service_type: "Text Generation",
          window_type: "5 hours",
          time_range: "2026/08/19 10:00 - 2026/08/19 15:00 (UTC+8)",
          usage: 2,
          limit: 10
        },
        { service_type: "Image", window_type: "Today", usage: "5", limit: "50", percent: "10" }
      ]
    }
  });
  assert.deepEqual(
    minimaxServices.meters.map((meter) => [meter.label, meter.remaining, meter.used, meter.limit, meter.unit]),
    [
      ["Text Generation · 5 hours", 8, 2, 10, "次"],
      ["Image · Today", 45, 5, 50, "次"]
    ]
  );
  assert.equal(minimaxServices.meters[0].resetAt, "2026-08-19T07:00:00.000Z");
  assert.throws(
    () => parseOfficialProviderResponse("minimax-token-plan", { data: { services: [{ unknown: true }] } }),
    /缺少套餐额度信息/
  );

  const glmLegacy = parseOfficialProviderResponse("glm-coding-plan-cn", {
    quota: { data: { limits: [{ type: "TOKENS_LIMIT", limit: 10000, currentValue: 2500, remaining: 7500, unit: "Tokens" }] } },
    models: { data: { items: [{ modelName: "GLM-4.5", usage: 1200, unit: "Tokens" }] } },
    tools: { data: { items: [{ name: "Web Search", usage: 8, unit: "次" }] } }
  });
  assert.equal(glmLegacy.meters.length, 3);

  const glm = parseOfficialProviderResponse("glm-coding-plan-cn", {
    quota: {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, percentage: 25 },
          { type: "TOKENS_LIMIT", unit: 6, percentage: "40" },
          { type: "TIME_LIMIT", unit: 5, usage: 1000, currentValue: 125, remaining: 875 }
        ]
      }
    },
    models: { data: { items: [{ modelName: "GLM-5", usage: 1200, unit: "Tokens" }] } },
    tools: { data: { items: [{ name: "Web Search", usage: 8, unit: "次" }] } }
  });
  assert.equal(glm.meters.length, 5);
  assert.deepEqual(
    [glm.meters[0].label, glm.meters[0].remaining, glm.meters[0].used, glm.meters[0].limit, glm.meters[0].unit],
    ["Token 额度（5 小时）", 75, 25, 100, "%"]
  );
  assert.deepEqual(
    [glm.meters[1].label, glm.meters[1].remaining, glm.meters[1].used, glm.meters[1].limit],
    ["Token 额度（每周）", 60, 40, 100]
  );
  assert.deepEqual(
    [glm.meters[2].label, glm.meters[2].remaining, glm.meters[2].used, glm.meters[2].limit, glm.meters[2].unit],
    ["MCP 额度（每月）", 875, 125, 1000, "次"]
  );
});

test("api preset executors use current routes and provider-specific authorization", async () => {
  const novitaRequests = [];
  const novita = await executeOfficialProvider("novita-ai", "novita-key", async (config) => {
    novitaRequests.push(config);
    return { availableBalance: 25000 };
  });
  assert.equal(novita.meters[0].remaining, 2.5);
  assert.equal(novitaRequests[0].url, "https://api.novita.ai/openapi/v1/billing/balance/detail");
  assert.equal(novitaRequests[0].headers.Authorization, "Bearer novita-key");

  const aiHubMixRequests = [];
  const aiHubMix = await executeOfficialProvider("aihubmix", "fd-system-token", async (config) => {
    aiHubMixRequests.push(config);
    return { data: { quota: 1500000 } };
  });
  assert.equal(aiHubMix.meters[0].remaining, 3);
  assert.equal(aiHubMixRequests[0].headers.Authorization, "fd-system-token");
});

test("GLM executors add usage ranges and retry only authentication failures", async () => {
  const rawRequests = [];
  const rawSnapshot = await executeOfficialProvider("glm-coding-plan-cn", "glm-token", async (config) => {
    rawRequests.push(config);
    if (config.url.endsWith("/quota/limit")) {
      return { data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 20 }] } };
    }
    return { data: { items: [{ name: "Usage", usage: 2 }] } };
  });
  assert.equal(rawSnapshot.meters[0].remaining, 80);
  assert.equal(rawRequests.length, 3);
  assert.ok(rawRequests[0].url.endsWith("/quota/limit"));
  assert.ok(rawRequests.every((request) => request.headers.Authorization === "glm-token"));
  for (const request of rawRequests.slice(1)) {
    const url = new URL(request.url);
    assert.match(url.searchParams.get("startTime"), /^\d{4}-\d{2}-\d{2} \d{2}:00:00$/);
    assert.match(url.searchParams.get("endTime"), /^\d{4}-\d{2}-\d{2} \d{2}:59:59$/);
  }

  const fallbackRequests = [];
  let quotaAttempts = 0;
  await executeOfficialProvider("zai-coding-plan", "zai-token", async (config) => {
    fallbackRequests.push(config);
    if (config.url.endsWith("/quota/limit")) {
      quotaAttempts += 1;
      if (quotaAttempts === 1) {
        throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
      }
      return { data: { limits: [{ type: "TOKENS_LIMIT", unit: 6, percentage: 30 }] } };
    }
    return { data: { items: [] } };
  });
  assert.equal(fallbackRequests.length, 4);
  assert.equal(fallbackRequests[0].headers.Authorization, "zai-token");
  assert.ok(fallbackRequests.slice(1).every((request) => request.headers.Authorization === "Bearer zai-token"));

  const suppliedBearerRequests = [];
  await executeOfficialProvider("glm-coding-plan-cn", "Bearer supplied-token", async (config) => {
    suppliedBearerRequests.push(config);
    if (config.url.endsWith("/quota/limit")) {
      return { data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 10 }] } };
    }
    return { data: { items: [] } };
  });
  assert.equal(suppliedBearerRequests.length, 3);
  assert.ok(suppliedBearerRequests.every((request) => request.headers.Authorization === "Bearer supplied-token"));

  let nonAuthAttempts = 0;
  await assert.rejects(
    executeOfficialProvider("glm-coding-plan-cn", "glm-token", async () => {
      nonAuthAttempts += 1;
      throw Object.assign(new Error("server error"), { statusCode: 500 });
    }),
    /server error/
  );
  assert.equal(nonAuthAttempts, 1);
});

test("admin parsers and executors handle billing units and request sequences", async () => {
  const credits = parseOfficialProviderResponse("openrouter-credits", {
    data: { total_credits: 50, total_usage: 18.25 }
  });
  assert.equal(credits.meters[0].remaining, 31.75);

  const xai = parseOfficialProviderResponse("xai-billing", {
    prepaid: { total: { val: "-1250" } },
    preview: { effectiveSpendingLimit: "20000", coreInvoice: { totalWithCorr: { val: "3500" } } }
  });
  assert.deepEqual(
    [xai.meters[0].remaining, xai.meters[1].remaining, xai.meters[1].used, xai.meters[1].limit],
    [12.5, 165, 35, 200]
  );

  const openai = parseOfficialProviderResponse("openai-organization", {
    limit: { currency: "USD", threshold_amount: 10000 },
    costPages: [{ data: [{ results: [{ amount: { value: 12.5, currency: "usd" } }] }] }]
  });
  assert.deepEqual([openai.meters[0].remaining, openai.meters[0].used, openai.meters[0].limit], [87.5, 12.5, 100]);

  const anthropic = parseOfficialProviderResponse("anthropic-organization", [
    { data: [{ results: [{ amount: "350", currency: "USD" }, { amount: "125", currency: "USD" }] }] }
  ]);
  assert.equal(anthropic.meters[0].used, 4.75);

  const requestUrls = [];
  const executed = await executeOfficialProvider("xai-billing", "xai-management", async (config) => {
    requestUrls.push(config.url);
    if (config.url.endsWith("/validation")) {
      return { scope: "SCOPE_TEAM", scopeId: "team-123" };
    }
    if (config.url.endsWith("/prepaid/balance")) {
      return { total: { val: "-500" } };
    }
    return { effectiveSpendingLimit: "10000", coreInvoice: { totalWithCorr: { val: "2500" } } };
  });
  assert.equal(executed.meters[0].remaining, 5);
  assert.deepEqual(requestUrls, [
    "https://management-api.x.ai/auth/management-keys/validation",
    "https://management-api.x.ai/v1/billing/teams/team-123/prepaid/balance",
    "https://management-api.x.ai/v1/billing/teams/team-123/postpaid/invoice/preview"
  ]);
});

test("admin executors degrade optional limits and close the current UTC cost bucket", async () => {
  const openAiUrls = [];
  const openAi = await executeOfficialProvider("openai-organization", "sk-admin-test", async (config) => {
    openAiUrls.push(config.url);
    if (config.url.endsWith("/spend_limit")) {
      throw Object.assign(new Error("not available"), { statusCode: 404 });
    }
    const url = new URL(config.url);
    if (!url.searchParams.has("page")) {
      return {
        data: [{ results: [{ amount: { value: 12.5, currency: "usd" } }] }],
        has_more: true,
        next_page: "page-2"
      };
    }
    return { data: [{ results: [{ amount: { value: 2.5, currency: "usd" } }] }], has_more: false };
  });
  assert.deepEqual(
    [openAi.meters[0].label, openAi.meters[0].remaining, openAi.meters[0].used, openAi.meters[0].limit],
    ["本月已用", null, 15, null]
  );
  assert.equal(openAiUrls.length, 3);
  assert.match(openAiUrls[2], /page=page-2/);

  await assert.rejects(
    executeOfficialProvider("openai-organization", "sk-admin-test", async (config) => {
      if (config.url.endsWith("/spend_limit")) {
        return { currency: "USD", threshold_amount: 10000 };
      }
      throw new Error("costs unavailable");
    }),
    /costs unavailable/
  );

  const before = new Date();
  let anthropicRequest;
  const anthropic = await executeOfficialProvider("anthropic-organization", "sk-ant-admin01-test", async (config) => {
    anthropicRequest = config;
    return { data: [], has_more: false };
  });
  const after = new Date();
  assert.equal(anthropic.meters[0].used, 0);
  const anthropicUrl = new URL(anthropicRequest.url);
  const endingAt = new Date(anthropicUrl.searchParams.get("ending_at"));
  const expectedEndings = [before, after].map((date) =>
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
  );
  assert.ok(expectedEndings.includes(endingAt.getTime()));
  assert.equal(endingAt.getUTCHours(), 0);
  assert.equal(anthropicRequest.headers["x-api-key"], "sk-ant-admin01-test");
});
