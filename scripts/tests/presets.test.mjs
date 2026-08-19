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
    ["siliconflow-cn", { data: { balance: "42" } }, 42, "CNY"],
    ["siliconflow-global", { data: { totalBalance: "7.5" } }, 7.5, "USD"],
    ["302ai", { data: { balance: 6 } }, 6, "USD"],
    ["novita-ai", { data: { balance: 123400 } }, 12.34, "USD"],
    ["aihubmix", { data: { quota: 2500000 } }, 5, "USD"]
  ];
  for (const [id, fixture, remaining, unit] of simpleFixtures) {
    const snapshot = parseOfficialProviderResponse(id, fixture);
    assert.equal(snapshot.meters[0].remaining, remaining, id);
    assert.equal(snapshot.meters[0].unit, unit, id);
  }

  const key = parseOfficialProviderResponse("openrouter-key", {
    data: { limit: 20, usage: 7, limit_remaining: 13 }
  });
  assert.deepEqual(
    [key.meters[0].remaining, key.meters[0].used, key.meters[0].limit, key.meters[0].aggregate],
    [13, 7, 20, false]
  );

  const minimax = parseOfficialProviderResponse("minimax-token-plan", {
    data: { remains: [{ model_name: "MiniMax-M2", total_count: 1000, used_count: 250, remain_count: 750 }] }
  });
  assert.equal(minimax.meters[0].remaining, 750);

  const glm = parseOfficialProviderResponse("glm-coding-plan-cn", {
    quota: { data: { limits: [{ type: "TOKENS_LIMIT", limit: 10000, currentValue: 2500, remaining: 7500, unit: "Tokens" }] } },
    models: { data: { items: [{ modelName: "GLM-4.5", usage: 1200, unit: "Tokens" }] } },
    tools: { data: { items: [{ name: "Web Search", usage: 8, unit: "次" }] } }
  });
  assert.equal(glm.meters.length, 3);
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
