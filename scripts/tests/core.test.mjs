import assert from "node:assert/strict";
import test from "node:test";
import { require } from "./helpers.mjs";

const core = require("../../public/libs/quota-core.js");

test("core normalizes URLs, modes, templates, and request configuration", () => {
  assert.equal(core.normalizeBaseUrl("https://example.com///"), "https://example.com");
  assert.equal(core.normalizeProviderMode(undefined), "relay");
  assert.equal(core.normalizeProviderMode("official"), "official");
  assert.throws(() => core.normalizeProviderMode("standard"), /relay 或 official/);
  assert.throws(() => core.normalizeProviderMode("advanced"), /relay 或 official/);
  assert.equal(core.normalizeTemplateId("not-a-template"), core.DEFAULT_TEMPLATE_ID);
  assert.deepEqual(
    core.getProviderTemplates().map((template) => template.id),
    ["openai-usage", "rate-limits", "custom"]
  );

  const normalized = core.normalizeProviderInput({
    name: "Relay",
    baseUrl: "https://relay.example.com/",
    apiKey: "secret",
    templateId: "custom",
    requestPath: "v1/quota",
    requestMethod: "POST",
    authPlacement: "body",
    requestHeaders: '{"Content-Type":"application/json"}',
    requestBody: '{"token":"{{token}}"}',
    jsonPaths: { balance: "data.balance" },
    defaultUnit: "usd",
    priceMultiplier: 2,
    refreshIntervalMinutes: 15
  });
  const request = core.buildProviderRequestConfig(normalized, "sk-private");
  assert.equal(request.url, "https://relay.example.com/v1/quota");
  assert.equal(request.method, "POST");
  assert.deepEqual(JSON.parse(request.body), { token: "sk-private" });
});

test("quota projection owns primary meter and remaining percentage rules", () => {
  const snapshot = core.normalizeQuotaSnapshot(
    {
      primaryMeterId: "quota",
      meters: [
        { id: "quota", remaining: null, used: 75, limit: 100, unit: "tokens", kind: "quota" },
        { id: "quota", remaining: 150, used: null, limit: 100, unit: "USD" }
      ]
    },
    { defaultUnit: "USD" }
  );
  assert.equal(snapshot.primaryMeterId, "quota");
  assert.equal(snapshot.meters[1].id, "quota-2");
  assert.equal(snapshot.meters[0].remaining, 25);

  const projected = core.projectQuotaSnapshot(snapshot, { defaultUnit: "USD" });
  assert.equal(projected.meters[0].remainingPercent, 25);
  assert.equal(projected.meters[1].remainingPercent, 100);
  assert.equal(core.meterRemainingPercent({ remaining: -2, used: null, limit: 10 }), 0);
  assert.equal(core.meterRemainingPercent({ remaining: null, used: 90, limit: 100 }), 10);
  assert.equal(core.meterRemainingPercent({ remaining: 1, used: null, limit: null }), null);
  assert.equal(core.getPrimaryQuotaMeter(projected).id, "quota");
});

test("provider status is computed once from runtime facts", () => {
  const configured = { mode: "relay", hasApiKey: true, officialPresetAvailable: true };
  assert.equal(core.getProviderStatus({ ...configured, lastCheckedAt: null, lastError: "" }), "pending");
  assert.equal(core.getProviderStatus({ ...configured, hasApiKey: false }), "unconfigured");
  assert.equal(core.getProviderStatus({ ...configured, lastCheckedAt: "2026-08-16", lastError: "boom" }), "error");
  assert.equal(core.getProviderStatus({ ...configured, lastCheckedAt: "2026-08-16", lastError: "" }), "ok");
  assert.equal(
    core.getProviderStatus({ ...configured, mode: "official", officialPresetAvailable: false }),
    "unavailable"
  );
});

test("relay response parsing returns canonical values without validity mirrors", () => {
  const result = core.parseProviderBalanceResponse(
    { data: { used: "40", limit: 100, unit: "usd", resetAt: "2026-08-17T00:00:00Z" } },
    {
      balance: "",
      used: "data.used",
      limit: "data.limit",
      unit: "data.unit",
      resetAt: "data.resetAt"
    },
    null,
    "USD",
    2
  );
  assert.deepEqual(result, {
    remaining: 120,
    used: 80,
    limit: 200,
    unit: "usd",
    resetAt: "2026-08-17T00:00:00Z"
  });
  assert.equal(Object.hasOwn(result, "isValid"), false);
  assert.equal(core.getJsonPathValue({ a: [{ b: 3 }] }, "a[0].b"), 3);
});

test("refresh due logic respects interval and failed checks", () => {
  const now = Date.parse("2026-08-16T02:00:00.000Z");
  assert.equal(core.shouldRefreshProvider({ lastCheckedAt: null, refreshIntervalMinutes: 30 }, now), true);
  assert.equal(
    core.shouldRefreshProvider(
      { lastCheckedAt: "2026-08-16T01:45:00.000Z", refreshIntervalMinutes: 30 },
      now
    ),
    false
  );
  assert.equal(
    core.shouldRefreshProvider(
      { lastCheckedAt: "2026-08-16T01:00:00.000Z", refreshIntervalMinutes: 30 },
      now
    ),
    true
  );
});
