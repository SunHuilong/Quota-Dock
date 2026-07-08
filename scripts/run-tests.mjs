import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildBalanceUrl,
  clampRefreshInterval,
  createResponseErrorMessage,
  normalizeBaseUrl,
  normalizeBodyForJson,
  parseBalanceResponse,
  summarizeResponseBody,
  shouldRefreshProvider
} = require("../public/libs/quota-core.js");

assert.equal(normalizeBaseUrl("https://gateway.example.com/"), "https://gateway.example.com");
assert.equal(
  buildBalanceUrl("https://gateway.example.com/api/"),
  "https://gateway.example.com/api/v1/usage"
);
assert.equal(clampRefreshInterval("0"), 1);
assert.equal(clampRefreshInterval("45"), 45);
assert.equal(clampRefreshInterval("9999"), 1440);

assert.deepEqual(
  parseBalanceResponse({
    subscription: {
      daily_limit_usd: 500,
      daily_usage_usd: 41.9891562
    },
    unit: "USD"
  }),
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
  parseBalanceResponse({
    rate_limits: [
      {
        limit: 300,
        remaining: 268.40942255,
        reset_at: "2026-07-09T00:00:00+08:00",
        used: 31.59057745
      }
    ]
  }),
  {
    isValid: true,
    remaining: 268.40942255,
    unit: "USD",
    limit: 300,
    used: 31.59057745,
    resetAt: "2026-07-09T00:00:00+08:00"
  }
);
assert.deepEqual(parseBalanceResponse({ subscription: { daily_limit_usd: 10, daily_usage_usd: 3 } }), {
  isValid: true,
  remaining: 7,
  unit: "USD",
  limit: 10,
  used: 3,
  resetAt: null
});
assert.throws(() => parseBalanceResponse({}), /subscription 或 rate_limits/);
assert.throws(() => parseBalanceResponse({ subscription: { daily_limit_usd: "abc", daily_usage_usd: 1 } }), /总额度/);
assert.throws(() => parseBalanceResponse({ subscription: { daily_limit_usd: 10, daily_usage_usd: "abc" } }), /已使用额度/);
assert.throws(() => parseBalanceResponse({ rate_limits: [{ limit: 10, used: 1, remaining: "abc" }] }), /剩余额度/);
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
