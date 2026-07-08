import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  AUTH_PLACEMENT_BODY,
  TEMPLATE_CUSTOM,
  TEMPLATE_OPENAI_USAGE,
  TEMPLATE_RATE_LIMITS,
  buildProviderRequestConfig,
  buildAdvancedUrl,
  clampRefreshInterval,
  createResponseErrorMessage,
  getJsonPathValue,
  getProviderTemplate,
  getProviderTemplates,
  normalizeBaseUrl,
  normalizeBodyForJson,
  normalizeProviderInput,
  normalizeRequestPath,
  parseProviderBalanceResponse,
  parseJsonPath,
  summarizeResponseBody,
  shouldRefreshProvider
} = require("../public/libs/quota-core.js");

assert.equal(normalizeBaseUrl("https://gateway.example.com/"), "https://gateway.example.com");
assert.equal(normalizeRequestPath("quota/check?type=daily"), "/quota/check?type=daily");
assert.equal(buildAdvancedUrl("https://gateway.example.com/api/", "/quota/check"), "https://gateway.example.com/api/quota/check");
assert.throws(() => normalizeRequestPath("https://gateway.example.com/quota"), /只填写路径/);
assert.equal(clampRefreshInterval("0"), 1);
assert.equal(clampRefreshInterval("45"), 45);
assert.equal(clampRefreshInterval("9999"), 1440);

assert.deepEqual(
  getProviderTemplates().map((template) => template.id),
  [TEMPLATE_OPENAI_USAGE, TEMPLATE_RATE_LIMITS, TEMPLATE_CUSTOM]
);
assert.equal(getProviderTemplate(TEMPLATE_OPENAI_USAGE).jsonPaths.limit, "subscription.daily_limit_usd");
assert.equal(getProviderTemplate(TEMPLATE_RATE_LIMITS).jsonPaths.balance, "rate_limits[0].remaining");

const openAiProvider = normalizeProviderInput({
  name: "openai",
  baseUrl: "https://gateway.example.com",
  apiKey: "sk-test",
  templateId: TEMPLATE_OPENAI_USAGE,
  refreshIntervalMinutes: 30
});
assert.equal(openAiProvider.templateId, TEMPLATE_OPENAI_USAGE);
assert.equal(openAiProvider.requestPath, "/v1/usage");
assert.equal(openAiProvider.jsonPaths.balance, "");
assert.equal(openAiProvider.jsonPaths.limit, "subscription.daily_limit_usd");
assert.equal(openAiProvider.jsonPaths.used, "subscription.daily_usage_usd");

const legacyStandardProvider = normalizeProviderInput({
  name: "legacy",
  baseUrl: "https://gateway.example.com",
  apiKey: "sk-test",
  mode: "standard",
  refreshIntervalMinutes: 30
});
assert.equal(legacyStandardProvider.templateId, TEMPLATE_OPENAI_USAGE);
assert.equal(legacyStandardProvider.jsonPaths.limit, "subscription.daily_limit_usd");

const legacyAdvancedProvider = normalizeProviderInput(
  {
    name: "legacy advanced",
    baseUrl: "https://gateway.example.com",
    apiKey: "sk-test",
    mode: "advanced",
    requestPath: "/quota",
    requestMethod: "GET",
    authPlacement: "header",
    requestHeaders: "{}",
    jsonPaths: {},
    refreshIntervalMinutes: 5
  },
  { requireJsonPaths: false }
);
assert.equal(legacyAdvancedProvider.templateId, TEMPLATE_CUSTOM);
assert.equal(legacyAdvancedProvider.requestPath, "/quota");

assert.deepEqual(parseJsonPath("data.items[0].quota.remaining"), ["data", "items", 0, "quota", "remaining"]);
assert.deepEqual(parseJsonPath("$[0][\"quota.balance\"]"), [0, "quota.balance"]);
assert.equal(
  getJsonPathValue(
    {
      data: {
        items: [
          {
            quota: {
              remaining: "42.5"
            }
          }
        ]
      }
    },
    "data.items[0].quota.remaining"
  ),
  "42.5"
);

assert.deepEqual(
  parseProviderBalanceResponse(
    {
      subscription: {
        daily_limit_usd: 500,
        daily_usage_usd: 41.9891562
      }
    },
    getProviderTemplate(TEMPLATE_OPENAI_USAGE).jsonPaths
  ),
  {
    isValid: true,
    remaining: 458.0108438,
    unit: "USD",
    limit: 500,
    used: 41.9891562,
    resetAt: null
  }
);
assert.deepEqual(
  parseProviderBalanceResponse(
    {
      rate_limits: [
        {
          limit: 300,
          remaining: 268.40942255,
          reset_at: "2026-07-09T00:00:00+08:00",
          used: 31.59057745
        }
      ]
    },
    getProviderTemplate(TEMPLATE_RATE_LIMITS).jsonPaths
  ),
  {
    isValid: true,
    remaining: 268.40942255,
    unit: "USD",
    limit: 300,
    used: 31.59057745,
    resetAt: "2026-07-09T00:00:00+08:00"
  }
);
assert.deepEqual(parseProviderBalanceResponse({ balance: 12 }, { balance: "balance" }), {
  isValid: true,
  remaining: 12,
  unit: "USD",
  limit: null,
  used: null,
  resetAt: null
});
assert.throws(() => parseProviderBalanceResponse({ balance: "abc" }, { balance: "balance" }), /余额字段/);
assert.throws(() => parseProviderBalanceResponse({ data: {} }, { balance: "data.balance" }), /余额字段路径未找到/);
assert.throws(() => parseProviderBalanceResponse({ data: {} }, {}), /余额字段路径/);

assert.equal(
  normalizeProviderInput({
    name: "custom",
    baseUrl: "https://gateway.example.com",
    apiKey: "sk-test",
    templateId: TEMPLATE_CUSTOM,
    requestPath: "/quota",
    requestMethod: "POST",
    authPlacement: "body",
    requestHeaders: "{\"Content-Type\":\"application/json\"}",
    requestBody: "{\"token\":\"{{token}}\"}",
    jsonPaths: { balance: "data.balance" },
    refreshIntervalMinutes: 5
  }).jsonPaths.balance,
  "data.balance"
);
assert.throws(
  () =>
    normalizeProviderInput({
      name: "custom",
      baseUrl: "https://gateway.example.com",
      apiKey: "sk-test",
      templateId: TEMPLATE_CUSTOM,
      requestPath: "/quota",
      requestMethod: "GET",
      authPlacement: "header",
      requestHeaders: "{}",
      jsonPaths: {},
      refreshIntervalMinutes: 5
    }),
  /余额字段/
);
assert.throws(
  () =>
    normalizeProviderInput(
      {
        name: "custom",
        baseUrl: "https://gateway.example.com",
        apiKey: "sk-test",
        templateId: TEMPLATE_CUSTOM,
        requestPath: "/quota",
        requestMethod: "GET",
        authPlacement: "body",
        requestHeaders: "{}",
        jsonPaths: {},
        refreshIntervalMinutes: 5
      },
      { requireJsonPaths: false }
    ),
  /POST/
);
assert.deepEqual(
  buildProviderRequestConfig(
    {
      baseUrl: "https://gateway.example.com",
      requestPath: "/quota",
      requestMethod: "POST",
      authPlacement: AUTH_PLACEMENT_BODY,
      requestHeaders: "{\"X-Token\":\"{{token}}\"}",
      requestBody: "{\"token\":\"{{ token }}\",\"scope\":\"quota\"}"
    },
    "sk-test"
  ),
  {
    url: "https://gateway.example.com/quota",
    method: "POST",
    headers: {
      "X-Token": "sk-test",
      "User-Agent": "cc-switch/1.0",
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: "{\"token\":\"sk-test\",\"scope\":\"quota\"}"
  }
);
assert.equal(normalizeBodyForJson("\uFEFF {\"ok\": 1}\n"), "{\"ok\": 1}");
assert.equal(summarizeResponseBody(""), "空响应");
assert.equal(summarizeResponseBody("abcdef", 3), "abc...");
assert.equal(
  createResponseErrorMessage("响应不是有效的 JSON", {
    url: "https://gateway.example.com/v1/usage",
    statusCode: 200,
    contentType: "text/html",
    body: "<!doctype html><title>error</title>"
  }),
  [
    "响应不是有效的 JSON",
    "URL: https://gateway.example.com/v1/usage",
    "Status: 200",
    "Content-Type: text/html",
    "Body: <!doctype html><title>error</title>"
  ].join("\n")
);

const now = Date.parse("2026-07-08T10:00:00.000Z");
assert.equal(shouldRefreshProvider({ refreshIntervalMinutes: 30, lastCheckedAt: null }, now), true);
assert.equal(
  shouldRefreshProvider(
    { refreshIntervalMinutes: 30, lastCheckedAt: "2026-07-08T09:29:59.000Z" },
    now
  ),
  true
);
assert.equal(
  shouldRefreshProvider(
    { refreshIntervalMinutes: 30, lastCheckedAt: "2026-07-08T09:45:00.000Z" },
    now
  ),
  false
);

console.log("Core quota tests passed");
