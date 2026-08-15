import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  normalizeQuotaSnapshot,
  normalizeProviderInput,
  normalizeRequestPath,
  parseProviderBalanceResponse,
  parseJsonPath,
  summarizeResponseBody,
  shouldRefreshProvider
} = require("../public/libs/quota-core.js");
const {
  executeOfficialProvider,
  listOfficialProviderPresets,
  normalizeOfficialProviderInput,
  parseOfficialProviderResponse
} = require("../public/libs/official-provider-presets.js");
const {
  PROVIDER_PREFIX,
  DELETED_PROVIDER_PREFIX,
  createProviderStore
} = require("../public/libs/provider-store.js");
const {
  DEFAULT_REFRESH_CONCURRENCY,
  DEFAULT_REMAINING_PERCENT_BELOW,
  DEFAULT_STALE_AFTER_MINUTES,
  MCP_ERROR_CODES,
  MCP_TOOL_NAMES,
  createHealthReport,
  createOverview,
  createRefreshBatch,
  meterRemainingPercent,
  normalizeHealthThresholds,
  projectProviderDetail,
  runBoundedTasks
} = require("../public/libs/quota-mcp.js");

function clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

class RevisionDbMock {
  constructor() {
    this.docs = new Map();
    this.sequence = 0;
    this.removeConflicts = new Map();
  }

  nextRevision(current) {
    const generation = current ? Number.parseInt(String(current._rev || "0"), 10) + 1 : 1;
    this.sequence += 1;
    return `${generation}-mock-${this.sequence}`;
  }

  async get(id) {
    const doc = this.docs.get(id);
    return doc && !doc._deleted ? clone(doc) : null;
  }

  async allDocs(prefix) {
    return [...this.docs.values()]
      .filter((doc) => doc._id.startsWith(prefix) && !doc._deleted)
      .map(clone);
  }

  async put(doc) {
    const current = this.docs.get(doc._id);

    if ((current && doc._rev !== current._rev) || (!current && doc._rev)) {
      return { ok: false, message: "conflict" };
    }

    const stored = {
      ...clone(doc),
      _rev: this.nextRevision(current)
    };
    this.docs.set(doc._id, stored);
    return { id: doc._id, ok: true, rev: stored._rev };
  }

  async remove(doc) {
    const current = this.docs.get(doc._id);
    const remainingConflicts = this.removeConflicts.get(doc._id) || 0;

    if (remainingConflicts > 0 && current && !current._deleted) {
      this.removeConflicts.set(doc._id, remainingConflicts - 1);
      this.forceRestore({ ...current, conflictWrite: remainingConflicts });
      return { ok: false, message: "conflict" };
    }

    if (!current || current._deleted || doc._rev !== current._rev) {
      return { ok: false, message: "conflict" };
    }

    const deleted = {
      ...current,
      _deleted: true,
      _rev: this.nextRevision(current)
    };
    this.docs.set(doc._id, deleted);
    return { id: doc._id, ok: true, rev: deleted._rev };
  }

  forceRestore(doc) {
    const current = this.docs.get(doc._id);
    this.docs.set(doc._id, {
      ...clone(doc),
      _rev: this.nextRevision(current),
      _deleted: false
    });
  }

  failNextRemovals(id, count) {
    this.removeConflicts.set(id, count);
  }
}

const MCP_NOW = Date.parse("2026-07-08T10:00:00.000Z");

function mcpProvider(overrides = {}) {
  return {
    id: "provider-1",
    mode: "relay",
    name: "Provider One",
    officialPresetId: null,
    officialPresetName: null,
    officialPresetAvailable: true,
    baseUrl: "https://secret.example.com",
    requestPath: "/private/quota",
    requestHeaders: '{"Authorization":"Bearer sk-secret"}',
    requestBody: '{"token":"sk-secret"}',
    jsonPaths: { balance: "raw.private.balance" },
    rawResponse: { token: "sk-secret", body: "private upstream body" },
    hasApiKey: true,
    showInFloatingWindow: true,
    lastPrimaryMeterId: "usd-balance",
    lastMeters: [
      {
        id: "usd-balance",
        label: "USD balance",
        kind: "balance",
        remaining: 10,
        used: 90,
        limit: 100,
        unit: "USD",
        resetAt: "2026-07-09T00:00:00.000Z",
        aggregate: true
      },
      {
        id: "cny-balance",
        label: "CNY balance",
        kind: "balance",
        remaining: 20,
        used: null,
        limit: null,
        unit: "CNY",
        resetAt: null,
        aggregate: true
      },
      {
        id: "requests",
        label: "Requests",
        kind: "quota",
        remaining: 50,
        used: 50,
        limit: 100,
        unit: "Requests",
        resetAt: null,
        aggregate: true
      }
    ],
    lastBalance: 10,
    lastUsed: 90,
    lastLimit: 100,
    lastUnit: "USD",
    lastResetAt: "2026-07-09T00:00:00.000Z",
    lastIsValid: true,
    lastCheckedAt: "2026-07-08T09:45:00.000Z",
    lastError: "",
    ...overrides
  };
}

const safeProviderDetail = projectProviderDetail(
  mcpProvider({
    lastError:
      "URL: https://secret.example.com/private/quota\nBody: {\"token\":\"sk-secret\",\"detail\":\"private upstream body\"}"
  }),
  { nowMs: MCP_NOW }
);
assert.equal(safeProviderDetail.status, "error");
assert.equal(safeProviderDetail.error.code, "refresh_failed");
assert.equal(safeProviderDetail.primaryMeter.id, "usd-balance");
assert.equal(safeProviderDetail.primaryMeter.remainingPercent, 10);
const serializedSafeProvider = JSON.stringify(safeProviderDetail);
for (const forbiddenValue of [
  "https://secret.example.com",
  "/private/quota",
  "sk-secret",
  "raw.private.balance",
  "private upstream body"
]) {
  assert.equal(serializedSafeProvider.includes(forbiddenValue), false, forbiddenValue);
}
for (const forbiddenField of [
  "baseUrl",
  "requestPath",
  "requestHeaders",
  "requestBody",
  "jsonPaths",
  "rawResponse",
  "apiKey"
]) {
  assert.equal(Object.hasOwn(safeProviderDetail, forbiddenField), false, forbiddenField);
}

assert.equal(meterRemainingPercent({ remaining: null, used: 90, limit: 100 }), 10);
assert.equal(meterRemainingPercent({ remaining: 1, used: null, limit: null }), null);
assert.deepEqual(normalizeHealthThresholds({}), {
  remainingPercentBelow: DEFAULT_REMAINING_PERCENT_BELOW,
  staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES
});
assert.throws(() => normalizeHealthThresholds({ remainingPercentBelow: -1 }), /remainingPercentBelow/);
assert.throws(() => normalizeHealthThresholds({ remainingPercentBelow: 101 }), /remainingPercentBelow/);
assert.throws(() => normalizeHealthThresholds({ staleAfterMinutes: 0 }), /staleAfterMinutes/);

const overviewProjection = createOverview(
  [
    mcpProvider(),
    mcpProvider({
      id: "provider-2",
      name: "Provider Two",
      lastPrimaryMeterId: "eur-quota",
      lastMeters: [
        {
          id: "usd-balance-2",
          label: "USD balance",
          kind: "balance",
          remaining: 2.5,
          used: null,
          limit: null,
          unit: "usd",
          resetAt: null,
          aggregate: true
        },
        {
          id: "eur-quota",
          label: "EUR quota",
          kind: "quota",
          remaining: 5,
          used: 5,
          limit: 10,
          unit: "EUR",
          resetAt: null,
          aggregate: false
        }
      ]
    })
  ],
  { nowMs: MCP_NOW }
);
assert.deepEqual(overviewProjection.totalsByUnit, [
  { unit: "CNY", total: 20 },
  { unit: "USD", total: 12.5 }
]);
assert.equal(overviewProjection.providers[1].primaryMeter.id, "eur-quota");
assert.equal(overviewProjection.statusCounts.ok, 2);

const healthProviders = [
  mcpProvider({ id: "missing", name: "Missing", hasApiKey: false, lastCheckedAt: null }),
  mcpProvider({
    id: "unavailable",
    name: "Unavailable",
    mode: "official",
    officialPresetId: "retired",
    officialPresetName: null,
    officialPresetAvailable: false,
    lastCheckedAt: null
  }),
  mcpProvider({ id: "failed", name: "Failed", lastError: "URL: secret\nBody: secret" }),
  mcpProvider({ id: "pending", name: "Pending", lastCheckedAt: null }),
  mcpProvider({ id: "stale", name: "Stale", lastCheckedAt: "2026-07-08T08:00:00.000Z" }),
  mcpProvider({
    id: "low",
    name: "Low",
    lastMeters: [
      {
        id: "low-meter",
        label: "Low meter",
        kind: "quota",
        remaining: 10,
        used: 90,
        limit: 100,
        unit: "Requests",
        resetAt: null,
        aggregate: false
      }
    ],
    lastPrimaryMeterId: "low-meter"
  }),
  mcpProvider({
    id: "no-limit",
    name: "No limit",
    lastMeters: [
      {
        id: "no-limit-meter",
        label: "No limit meter",
        kind: "balance",
        remaining: 1,
        used: null,
        limit: null,
        unit: "USD",
        resetAt: null,
        aggregate: false
      }
    ],
    lastPrimaryMeterId: "no-limit-meter"
  })
];
const healthProjection = createHealthReport(healthProviders, {}, { nowMs: MCP_NOW });
assert.equal(healthProjection.healthy, false);
assert.deepEqual(
  [...new Set(healthProjection.issues.map((issue) => issue.code))].sort(),
  [...MCP_ERROR_CODES].sort()
);
assert.equal(
  healthProjection.issues.some(
    (issue) => issue.code === "low_remaining" && issue.providerId === "no-limit"
  ),
  false
);
assert.equal(
  healthProjection.issues.find((issue) => issue.code === "low_remaining").remainingPercent,
  10
);
const customHealthProjection = createHealthReport(
  [healthProviders.find((provider) => provider.id === "low")],
  { remainingPercentBelow: 5, staleAfterMinutes: 180 },
  { nowMs: MCP_NOW }
);
assert.equal(customHealthProjection.healthy, true);

let activeRefreshes = 0;
let peakRefreshes = 0;
const progressUpdates = [];
const boundedResults = await runBoundedTasks(
  [0, 1, 2, 3, 4, 5, 6],
  async (item) => {
    activeRefreshes += 1;
    peakRefreshes = Math.max(peakRefreshes, activeRefreshes);
    try {
      await new Promise((resolve) => setTimeout(resolve, 4 + (item % 3)));
      if (item === 3) {
        throw new Error("upstream URL and Body must stay internal");
      }
      return item * 2;
    } finally {
      activeRefreshes -= 1;
    }
  },
  {
    concurrency: 20,
    async onProgress(update) {
      progressUpdates.push({ progress: update.progress, total: update.total });
      if (update.progress === 2) {
        throw new Error("progress channel unavailable");
      }
    }
  }
);
assert.equal(DEFAULT_REFRESH_CONCURRENCY, 3);
assert.equal(peakRefreshes, 3);
assert.equal(boundedResults.length, 7);
assert.equal(boundedResults.filter((result) => result.fulfilled).length, 6);
assert.deepEqual(
  progressUpdates.map((update) => update.progress),
  [1, 2, 3, 4, 5, 6, 7]
);
assert.ok(progressUpdates.every((update) => update.total === 7));

const partialRefreshTasks = await runBoundedTasks(
  [
    { id: "success-1", name: "Success 1" },
    { id: "failure", name: "Failure" },
    { id: "success-2", name: "Success 2" }
  ],
  async (item) => {
    if (item.id === "failure") {
      throw new Error("URL: https://private.invalid\nBody: private body");
    }
    return mcpProvider({ id: item.id, name: item.name });
  },
  { concurrency: 3 }
);
const partialRefreshBatch = createRefreshBatch("all", partialRefreshTasks, { nowMs: MCP_NOW });
assert.equal(partialRefreshBatch.successCount, 2);
assert.equal(partialRefreshBatch.failureCount, 1);
assert.equal(partialRefreshBatch.results[1].error.code, "refresh_failed");
assert.equal(JSON.stringify(partialRefreshBatch).includes("private.invalid"), false);

function assertStrictObjectSchemas(schema, path = "schema") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return;
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("object")) {
    assert.equal(schema.additionalProperties, false, `${path} must reject additional properties`);
  }
  for (const [propertyName, propertySchema] of Object.entries(schema.properties || {})) {
    assertStrictObjectSchemas(propertySchema, `${path}.properties.${propertyName}`);
  }
  for (const [definitionName, definitionSchema] of Object.entries(schema.$defs || {})) {
    assertStrictObjectSchemas(definitionSchema, `${path}.$defs.${definitionName}`);
  }
  if (schema.items) {
    assertStrictObjectSchemas(schema.items, `${path}.items`);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    for (const [index, childSchema] of (schema[keyword] || []).entries()) {
      assertStrictObjectSchemas(childSchema, `${path}.${keyword}[${index}]`);
    }
  }
}

function collectSchemaPropertyNames(schema, result = new Set()) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return result;
  }
  for (const [propertyName, propertySchema] of Object.entries(schema.properties || {})) {
    result.add(propertyName);
    collectSchemaPropertyNames(propertySchema, result);
  }
  for (const definitionSchema of Object.values(schema.$defs || {})) {
    collectSchemaPropertyNames(definitionSchema, result);
  }
  if (schema.items) {
    collectSchemaPropertyNames(schema.items, result);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    for (const childSchema of schema[keyword] || []) {
      collectSchemaPropertyNames(childSchema, result);
    }
  }
  return result;
}

const pluginManifest = JSON.parse(
  readFileSync(new URL("../public/plugin.json", import.meta.url), "utf8")
);
assert.equal(pluginManifest.version, "0.2.0");
assert.match(pluginManifest.description, /MCP/);
assert.deepEqual(Object.keys(pluginManifest.tools), MCP_TOOL_NAMES);
for (const [toolName, definition] of Object.entries(pluginManifest.tools)) {
  assert.ok(definition.description.length > 0 && definition.description.length <= 500, toolName);
  assert.equal(definition.inputSchema.type, "object", `${toolName} input schema`);
  assert.equal(definition.outputSchema.type, "object", `${toolName} output schema`);
  assertStrictObjectSchemas(definition.inputSchema, `${toolName}.inputSchema`);
  assertStrictObjectSchemas(definition.outputSchema, `${toolName}.outputSchema`);

  const outputProperties = collectSchemaPropertyNames(definition.outputSchema);
  for (const forbiddenField of [
    "apiKey",
    "baseUrl",
    "requestPath",
    "requestHeaders",
    "requestBody",
    "jsonPaths",
    "rawResponse"
  ]) {
    assert.equal(outputProperties.has(forbiddenField), false, `${toolName}.${forbiddenField}`);
  }
}

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
assert.equal(openAiProvider.manualLimit, null);
assert.equal(openAiProvider.defaultUnit, "USD");
assert.equal(openAiProvider.priceMultiplier, 1);

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
assert.deepEqual(parseProviderBalanceResponse({ balance: 12 }, { balance: "balance" }, 100), {
  isValid: true,
  remaining: 12,
  unit: "USD",
  limit: 100,
  used: 88,
  resetAt: null
});
assert.deepEqual(parseProviderBalanceResponse({ balance: 12 }, { balance: "balance" }, null, "CNY"), {
  isValid: true,
  remaining: 12,
  unit: "CNY",
  limit: null,
  used: null,
  resetAt: null
});
assert.deepEqual(
  parseProviderBalanceResponse(
    { balance: 7000, used: 3000, limit: 10000 },
    { balance: "balance", used: "used", limit: "limit" },
    null,
    "USD",
    0.001
  ),
  {
    isValid: true,
    remaining: 7,
    unit: "USD",
    limit: 10,
    used: 3,
    resetAt: null
  }
);
assert.deepEqual(
  parseProviderBalanceResponse({ balance: 12000 }, { balance: "balance" }, 12000, "USD", 0.001),
  {
    isValid: true,
    remaining: 12,
    unit: "USD",
    limit: 12,
    used: 0,
    resetAt: null
  }
);
assert.deepEqual(
  parseProviderBalanceResponse({ balance: 12000 }, { balance: "balance" }, 10000, "USD", 0.001),
  {
    isValid: true,
    remaining: 12,
    unit: "USD",
    limit: 10,
    used: 0,
    resetAt: null
  }
);
assert.deepEqual(
  parseProviderBalanceResponse(
    { balance: 12, unit: "EUR" },
    { balance: "balance", unit: "unit" },
    null,
    "CNY"
  ),
  {
    isValid: true,
    remaining: 12,
    unit: "EUR",
    limit: null,
    used: null,
    resetAt: null
  }
);
assert.deepEqual(
  parseProviderBalanceResponse({ balance: 12, limit: 80 }, { balance: "balance", limit: "limit" }, 100),
  {
    isValid: true,
    remaining: 12,
    unit: "USD",
    limit: 100,
    used: 88,
    resetAt: null
  }
);
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
const manualLimitProvider = normalizeProviderInput({
  name: "manual limit",
  baseUrl: "https://gateway.example.com",
  apiKey: "sk-test",
  templateId: TEMPLATE_CUSTOM,
  requestPath: "/quota",
  requestMethod: "GET",
  authPlacement: "header",
  requestHeaders: "{}",
  jsonPaths: { balance: "data.balance", limit: "data.limit" },
  manualLimit: "100.5",
  defaultUnit: " CNY ",
  refreshIntervalMinutes: 5
});
assert.equal(manualLimitProvider.manualLimit, 100.5);
assert.equal(manualLimitProvider.jsonPaths.limit, "");
assert.equal(manualLimitProvider.defaultUnit, "CNY");
assert.equal(
  normalizeProviderInput({
    name: "scaled",
    baseUrl: "https://gateway.example.com",
    apiKey: "sk-test",
    templateId: TEMPLATE_CUSTOM,
    requestPath: "/quota",
    requestMethod: "GET",
    authPlacement: "header",
    requestHeaders: "{}",
    jsonPaths: { balance: "data.balance" },
    priceMultiplier: "0.001",
    refreshIntervalMinutes: 5
  }).priceMultiplier,
  0.001
);
assert.throws(
  () =>
    normalizeProviderInput({
      name: "invalid multiplier",
      baseUrl: "https://gateway.example.com",
      apiKey: "sk-test",
      templateId: TEMPLATE_CUSTOM,
      requestPath: "/quota",
      requestMethod: "GET",
      authPlacement: "header",
      requestHeaders: "{}",
      jsonPaths: { balance: "data.balance" },
      priceMultiplier: 0,
      refreshIntervalMinutes: 5
    }),
  /价格倍率/
);
assert.throws(
  () =>
    normalizeProviderInput({
      name: "invalid manual limit",
      baseUrl: "https://gateway.example.com",
      apiKey: "sk-test",
      templateId: TEMPLATE_CUSTOM,
      requestPath: "/quota",
      requestMethod: "GET",
      authPlacement: "header",
      requestHeaders: "{}",
      jsonPaths: { balance: "data.balance" },
      manualLimit: 0,
      refreshIntervalMinutes: 5
    }),
  /备用总额度/
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

const presetSummaries = listOfficialProviderPresets();
assert.deepEqual(
  presetSummaries.map((preset) => preset.id),
  [
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
  ]
);
assert.ok(presetSummaries.every((preset) => !("url" in preset) && !("headers" in preset)));
assert.equal(presetSummaries.find((preset) => preset.id === "xai-billing").credentialLabel, "Management Key");
assert.equal(presetSummaries.find((preset) => preset.id === "openai-organization").credentialLabel, "Admin API Key");

assert.deepEqual(
  normalizeOfficialProviderInput({
    mode: "official",
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
assert.throws(
  () =>
    normalizeOfficialProviderInput({
      mode: "official",
      officialPresetId: "missing",
      apiKey: "key"
    }),
  /预设平台不可用/
);

const serverLimitSnapshot = normalizeQuotaSnapshot(
  {
    primaryMeterId: "quota",
    meters: [
      {
        id: "quota",
        label: "额度",
        kind: "quota",
        remaining: 20,
        used: 30,
        limit: 50,
        unit: "USD",
        resetAt: null,
        aggregate: false
      }
    ]
  },
  { manualLimit: 100, currencyOverride: "CNY" }
);
assert.equal(serverLimitSnapshot.meters[0].limit, 50);
assert.equal(serverLimitSnapshot.meters[0].unit, "CNY");

const deepSeekSnapshot = parseOfficialProviderResponse(
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
assert.equal(deepSeekSnapshot.meters.length, 2);
assert.equal(deepSeekSnapshot.meters[0].remaining, 88.5);
assert.equal(deepSeekSnapshot.meters[0].limit, 100);
assert.equal(deepSeekSnapshot.meters[1].unit, "USD");

const simplePresetFixtures = [
  ["kimi-api-cn", { data: { available_balance: "12.5" } }, 12.5, "CNY"],
  ["kimi-api-global", { data: { balance: 9 } }, 9, "USD"],
  ["stepfun-api", { data: { balance: "30" } }, 30, "CNY"],
  ["siliconflow-cn", { data: { balance: "42" } }, 42, "CNY"],
  ["siliconflow-global", { data: { totalBalance: "7.5" } }, 7.5, "USD"],
  ["302ai", { data: { balance: 6 } }, 6, "USD"],
  ["novita-ai", { data: { balance: 123400 } }, 12.34, "USD"],
  ["aihubmix", { data: { quota: 2500000 } }, 5, "USD"]
];
for (const [presetId, fixture, expectedRemaining, expectedUnit] of simplePresetFixtures) {
  const snapshot = parseOfficialProviderResponse(presetId, fixture);
  assert.equal(snapshot.meters[0].remaining, expectedRemaining, presetId);
  assert.equal(snapshot.meters[0].unit, expectedUnit, presetId);
}

const openRouterKeySnapshot = parseOfficialProviderResponse("openrouter-key", {
  data: { limit: 20, usage: 7, limit_remaining: 13 }
});
assert.deepEqual(
  {
    kind: openRouterKeySnapshot.meters[0].kind,
    remaining: openRouterKeySnapshot.meters[0].remaining,
    used: openRouterKeySnapshot.meters[0].used,
    limit: openRouterKeySnapshot.meters[0].limit,
    aggregate: openRouterKeySnapshot.meters[0].aggregate
  },
  { kind: "quota", remaining: 13, used: 7, limit: 20, aggregate: false }
);

const openRouterCreditsSnapshot = parseOfficialProviderResponse("openrouter-credits", {
  data: { total_credits: 50, total_usage: 18.25 }
});
assert.equal(openRouterCreditsSnapshot.meters[0].remaining, 31.75);
assert.equal(openRouterCreditsSnapshot.meters[0].aggregate, true);

const miniMaxSnapshot = parseOfficialProviderResponse("minimax-token-plan", {
  data: {
    remains: [
      { model_name: "MiniMax-M2", total_count: 1000, used_count: 250, remain_count: 750 },
      { model_name: "MiniMax-M2-fast", total_count: 500, remain_count: 400 }
    ]
  }
});
assert.equal(miniMaxSnapshot.meters.length, 2);
assert.equal(miniMaxSnapshot.meters[0].remaining, 750);
assert.equal(miniMaxSnapshot.meters[0].aggregate, false);
assert.equal(
  normalizeOfficialProviderInput({
    mode: "official",
    officialPresetId: "minimax-token-plan",
    apiKey: "key",
    manualLimit: 100,
    currencyOverride: "USD",
    refreshIntervalMinutes: 30
  }).currencyOverride,
  ""
);

const glmSnapshot = parseOfficialProviderResponse("glm-coding-plan-cn", {
  quota: {
    data: {
      limits: [
        { type: "TOKENS_LIMIT", limit: 10000, currentValue: 2500, remaining: 7500, unit: "Tokens" }
      ]
    }
  },
  models: { data: { items: [{ modelName: "GLM-4.5", usage: 1200, unit: "Tokens" }] } },
  tools: { data: { items: [{ name: "Web Search", usage: 8, unit: "次" }] } }
});
assert.equal(glmSnapshot.meters.length, 3);
assert.equal(glmSnapshot.meters[0].remaining, 7500);

const xaiSnapshot = parseOfficialProviderResponse("xai-billing", {
  prepaid: { total: { val: "-1250" } },
  preview: {
    effectiveSpendingLimit: "20000",
    coreInvoice: { totalWithCorr: { val: "3500" } }
  }
});
assert.equal(xaiSnapshot.meters[0].remaining, 12.5);
assert.deepEqual(
  [xaiSnapshot.meters[1].remaining, xaiSnapshot.meters[1].used, xaiSnapshot.meters[1].limit],
  [165, 35, 200]
);

const openAiOrganizationSnapshot = parseOfficialProviderResponse("openai-organization", {
  limit: { currency: "USD", threshold_amount: 10000 },
  costPages: [
    { data: [{ results: [{ amount: { value: 12.5, currency: "usd" } }] }] },
    { data: [{ results: [{ amount: { value: 7.25, currency: "usd" } }] }] }
  ]
});
assert.deepEqual(
  [
    openAiOrganizationSnapshot.meters[0].remaining,
    openAiOrganizationSnapshot.meters[0].used,
    openAiOrganizationSnapshot.meters[0].limit
  ],
  [80.25, 19.75, 100]
);
assert.equal(openAiOrganizationSnapshot.meters[0].aggregate, false);

const anthropicSnapshot = parseOfficialProviderResponse("anthropic-organization", [
  { data: [{ results: [{ amount: "350", currency: "USD" }, { amount: "125", currency: "USD" }] }] }
]);
assert.equal(anthropicSnapshot.meters[0].used, 4.75);
assert.equal(anthropicSnapshot.meters[0].remaining, null);

const recordedRequests = [];
const executedDeepSeek = await executeOfficialProvider(
  "deepseek-api",
  "sk-test",
  async (config) => {
    recordedRequests.push(config);
    return { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "10" }] };
  },
  {}
);
assert.equal(executedDeepSeek.meters[0].remaining, 10);
assert.equal(recordedRequests[0].url, "https://api.deepseek.com/user/balance");
assert.equal(recordedRequests[0].headers.Authorization, "Bearer sk-test");

const xaiRequestUrls = [];
const executedXai = await executeOfficialProvider("xai-billing", "xai-management", async (config) => {
  xaiRequestUrls.push(config.url);
  if (config.url.endsWith("/auth/management-keys/validation")) {
    return { scope: "SCOPE_TEAM", scopeId: "team-123" };
  }
  if (config.url.endsWith("/prepaid/balance")) {
    return { total: { val: "-500" } };
  }
  return { effectiveSpendingLimit: "10000", coreInvoice: { totalWithCorr: { val: "2500" } } };
});
assert.equal(executedXai.meters[0].remaining, 5);
assert.deepEqual(xaiRequestUrls, [
  "https://management-api.x.ai/auth/management-keys/validation",
  "https://management-api.x.ai/v1/billing/teams/team-123/prepaid/balance",
  "https://management-api.x.ai/v1/billing/teams/team-123/postpaid/invoice/preview"
]);

const revisionDb = new RevisionDbMock();
const providerStore = createProviderStore(() => revisionDb);
const providerDocs = [
  { id: "first", createdAt: "2026-07-08T09:00:00.000Z", lastBalance: 10 },
  { id: "second", createdAt: "2026-07-08T09:01:00.000Z", lastBalance: 20 },
  { id: "third", createdAt: "2026-07-08T09:02:00.000Z", lastBalance: 30 }
];

for (const provider of providerDocs) {
  const result = await revisionDb.put({
    _id: `${PROVIDER_PREFIX}${provider.id}`,
    ...provider
  });
  assert.equal(result.ok, true);
}

assert.deepEqual((await providerStore.listProviderDocs()).map(providerStore.idFromDoc), ["first", "second", "third"]);

const secondDocId = `${PROVIDER_PREFIX}second`;
revisionDb.failNextRemovals(secondDocId, 10);
const deletion = await providerStore.deleteProviderDoc("second");
assert.equal(deletion.hardDeleted, false);
assert.match(deletion.removeError.message, /conflict/);
assert.ok(await revisionDb.get(`${DELETED_PROVIDER_PREFIX}second`));
assert.deepEqual((await providerStore.listProviderDocs()).map(providerStore.idFromDoc), ["first", "third"]);

revisionDb.forceRestore({
  _id: secondDocId,
  id: "second",
  createdAt: "2026-07-08T09:01:00.000Z",
  lastBalance: 99
});
assert.ok(await revisionDb.get(secondDocId));
assert.deepEqual((await providerStore.listProviderDocs()).map(providerStore.idFromDoc), ["first", "third"]);
await assert.rejects(() => providerStore.getProviderDoc("second"), /站点已删除/);
await assert.rejects(() => providerStore.putProviderPatch("second", { lastBalance: 100 }), /站点已删除/);

revisionDb.failNextRemovals(secondDocId, 0);
const repeatedDeletion = await providerStore.deleteProviderDoc("second");
assert.equal(repeatedDeletion.hardDeleted, true);
assert.equal(await revisionDb.get(secondDocId), null);
assert.deepEqual((await providerStore.listProviderDocs()).map(providerStore.idFromDoc), ["first", "third"]);

const preloadDb = new RevisionDbMock();
const encryptedValues = new Map();
let floatingWindowOptions = null;
let floatingWindowReady = null;
let floatingWindowClosed = null;
let floatingLayoutResponse = { contentHeight: 240, availableHeight: 1000, availableTop: 0 };
let floatingBounds = { x: 120, y: 720, width: 360, height: 188 };
let floatingDestroyed = false;
let floatingCreateCount = 0;
const floatingWindowCalls = [];
const registeredTools = new Map();
const floatingWindowMock = {
  focus() {
    floatingWindowCalls.push(["focus"]);
  },
  isDestroyed() {
    return floatingDestroyed;
  },
  on(event, listener) {
    if (event === "closed") {
      floatingWindowClosed = listener;
    }
  },
  getBounds() {
    return { ...floatingBounds };
  },
  setBounds(nextBounds) {
    floatingBounds = { ...floatingBounds, ...nextBounds };
    floatingWindowCalls.push(["setBounds", { ...floatingBounds }]);
  },
  getSize() {
    return [floatingBounds.width, floatingBounds.height];
  },
  setSize(width, height) {
    floatingBounds = { ...floatingBounds, width, height };
    floatingWindowCalls.push(["setSize", width, height]);
  },
  webContents: {
    async executeJavaScript(script) {
      floatingWindowCalls.push(["executeJavaScript", script]);
      return floatingLayoutResponse;
    }
  },
  setAlwaysOnTop(enabled, level) {
    floatingWindowCalls.push(["setAlwaysOnTop", enabled, level]);
  },
  setBackgroundColor(color) {
    floatingWindowCalls.push(["setBackgroundColor", color]);
  },
  setBackgroundMaterial(material) {
    floatingWindowCalls.push(["setBackgroundMaterial", material]);
  },
  setHasShadow(enabled) {
    floatingWindowCalls.push(["setHasShadow", enabled]);
  },
  setShape(rectangles) {
    floatingWindowCalls.push(["setShape", rectangles]);
  },
  setVibrancy(material) {
    floatingWindowCalls.push(["setVibrancy", material]);
  },
  show() {
    floatingWindowCalls.push(["show"]);
  },
  close() {
    floatingWindowCalls.push(["close"]);
    floatingDestroyed = true;
    const closedListener = floatingWindowClosed;
    floatingWindowClosed = null;
    closedListener?.();
  }
};
const previousWindow = globalThis.window;
const previousUtools = globalThis.utools;
globalThis.window = { location: { pathname: "/index.html" } };
globalThis.utools = {
  db: { promises: preloadDb },
  dbCryptoStorage: {
    getItem(key) {
      return encryptedValues.get(key) || "";
    },
    setItem(key, value) {
      encryptedValues.set(key, value);
    },
    async removeItem(key) {
      encryptedValues.delete(key);
    }
  },
  registerTool(name, handler) {
    assert.equal(typeof handler, "function");
    assert.equal(registeredTools.has(name), false, `duplicate registration: ${name}`);
    registeredTools.set(name, handler);
  },
  createBrowserWindow(_entry, options, ready) {
    floatingCreateCount += 1;
    floatingDestroyed = false;
    floatingWindowOptions = options;
    floatingWindowReady = ready;
    floatingBounds = { ...floatingBounds, width: options.width, height: options.height };
    return floatingWindowMock;
  }
};

require("../public/preload.js");
const preloadBridge = globalThis.window.quotaBridge;
assert.ok(preloadBridge);
assert.equal(globalThis.window.__quotaPreloadReady, true);
assert.equal(globalThis.window.__quotaPreloadError, null);
assert.deepEqual([...registeredTools.keys()], MCP_TOOL_NAMES);
assert.ok((await preloadBridge.listOfficialProviderPresets()).length >= 17);

await preloadBridge.openFloatingWindow();
assert.equal(floatingWindowOptions.transparent, true);
assert.equal(floatingWindowOptions.hasShadow, false);
assert.equal(floatingWindowOptions.roundedCorners, false);
assert.equal(floatingWindowOptions.backgroundColor, "#00000000");
assert.equal(floatingWindowOptions.show, false);
assert.equal(typeof floatingWindowReady, "function");
await floatingWindowReady();
assert.ok(floatingWindowCalls.some((call) => call[0] === "setBackgroundColor" && call[1] === "#00000000"));
assert.ok(floatingWindowCalls.some((call) => call[0] === "setHasShadow" && call[1] === false));
assert.equal(floatingBounds.height, 240);
const shapeCall = floatingWindowCalls.filter((call) => call[0] === "setShape").at(-1);
assert.ok(shapeCall);
assert.ok(shapeCall[1].length > 1);
assert.ok(shapeCall[1].every((rect) => rect.width > 0 && rect.height > 0));
assert.ok(!floatingWindowCalls.some((call) => call[0] === "setBackgroundMaterial"));
assert.ok(!floatingWindowCalls.some((call) => call[0] === "setVibrancy"));

floatingLayoutResponse = { contentHeight: 900, availableHeight: 800, availableTop: 0 };
await preloadBridge.syncFloatingWindow();
assert.equal(floatingBounds.height, 560);
assert.equal(floatingBounds.y, 240);

floatingLayoutResponse = { contentHeight: 210, availableHeight: 1000, availableTop: 0 };
await preloadBridge.syncFloatingWindow();
assert.equal(floatingBounds.height, 210);
assert.equal(floatingBounds.y, 240);

floatingLayoutResponse = { contentHeight: 100, availableHeight: 1000, availableTop: 0 };
await preloadBridge.syncFloatingWindow();
assert.equal(floatingBounds.height, 188);
assert.equal(floatingBounds.y, 240);

const boundsBeforeInvalidLayout = { ...floatingBounds };
floatingLayoutResponse = null;
await preloadBridge.syncFloatingWindow();
assert.deepEqual(floatingBounds, boundsBeforeInvalidLayout);

floatingDestroyed = true;
floatingLayoutResponse = { contentHeight: 300, availableHeight: 1000, availableTop: 0 };
await preloadBridge.syncFloatingWindow();
assert.deepEqual(floatingBounds, boundsBeforeInvalidLayout);
floatingDestroyed = false;
floatingWindowClosed?.();

const savedOfficial = await preloadBridge.saveProvider({
  mode: "official",
  name: "",
  officialPresetId: "deepseek-api",
  apiKey: "sk-official",
  manualLimit: null,
  currencyOverride: "",
  refreshIntervalMinutes: 30
});
assert.equal(savedOfficial.mode, "official");
assert.equal(savedOfficial.name, "DeepSeek API");
assert.equal(savedOfficial.baseUrl, "");
assert.equal(savedOfficial.hasApiKey, true);
assert.equal(savedOfficial.showInFloatingWindow, true);

const hiddenOfficial = await preloadBridge.setProviderFloatingVisibility(savedOfficial.id, false);
assert.equal(hiddenOfficial.showInFloatingWindow, false);
assert.equal((await preloadDb.get(`${PROVIDER_PREFIX}${savedOfficial.id}`)).showInFloatingWindow, false);

const resavedHiddenOfficial = await preloadBridge.saveProvider({
  id: savedOfficial.id,
  mode: "official",
  name: "DeepSeek API",
  officialPresetId: "deepseek-api",
  apiKey: "",
  manualLimit: null,
  currencyOverride: "",
  refreshIntervalMinutes: 30
});
assert.equal(resavedHiddenOfficial.showInFloatingWindow, false);
await assert.rejects(
  () => preloadBridge.setProviderFloatingVisibility(savedOfficial.id, "false"),
  /浮窗展示状态无效/
);

const persistedOfficial = (await preloadDb.allDocs(PROVIDER_PREFIX)).find(
  (doc) => doc._id === `${PROVIDER_PREFIX}${savedOfficial.id}`
);
for (const forbiddenField of [
  "baseUrl",
  "templateId",
  "requestPath",
  "requestMethod",
  "authPlacement",
  "requestHeaders",
  "requestBody",
  "jsonPaths",
  "defaultUnit",
  "priceMultiplier"
]) {
  assert.equal(Object.hasOwn(persistedOfficial, forbiddenField), false, forbiddenField);
}

await preloadDb.put({
  _id: `${PROVIDER_PREFIX}legacy-relay`,
  name: "Legacy relay",
  baseUrl: "https://gateway.example.com",
  templateId: "custom",
  requestPath: "/quota",
  requestMethod: "GET",
  authPlacement: "header",
  requestHeaders: "{}",
  requestBody: "",
  jsonPaths: { balance: "balance" },
  manualLimit: null,
  defaultUnit: "CNY",
  priceMultiplier: 1,
  refreshIntervalMinutes: 30,
  lastBalance: 66,
  lastLimit: 100,
  lastUsed: 34,
  lastResetAt: null,
  lastUnit: "CNY",
  lastCheckedAt: "2026-07-08T10:00:00.000Z",
  lastError: "",
  createdAt: "2026-07-08T09:00:00.000Z",
  updatedAt: "2026-07-08T10:00:00.000Z"
});
await preloadDb.put({
  _id: `${PROVIDER_PREFIX}unknown-official`,
  mode: "official",
  name: "Retired preset",
  officialPresetId: "retired-provider",
  refreshIntervalMinutes: 30,
  lastPrimaryMeterId: "balance",
  lastMeters: [
    {
      id: "balance",
      label: "可用余额",
      kind: "balance",
      remaining: 5,
      used: null,
      limit: null,
      unit: "USD",
      resetAt: null,
      aggregate: true
    }
  ],
  lastCheckedAt: "2026-07-08T10:00:00.000Z",
  lastError: "",
  createdAt: "2026-07-08T09:30:00.000Z",
  updatedAt: "2026-07-08T10:00:00.000Z"
});

const migratedProviders = await preloadBridge.listProviders();
const migratedRelay = migratedProviders.find((provider) => provider.id === "legacy-relay");
assert.equal(migratedRelay.mode, "relay");
assert.equal(migratedRelay.lastMeters[0].remaining, 66);
assert.equal(migratedRelay.lastMeters[0].unit, "CNY");
assert.equal(migratedRelay.showInFloatingWindow, true);
const unknownOfficial = migratedProviders.find((provider) => provider.id === "unknown-official");
assert.equal(unknownOfficial.mode, "official");
assert.equal(unknownOfficial.officialPresetAvailable, false);
assert.equal(unknownOfficial.lastMeters[0].remaining, 5);
assert.equal(unknownOfficial.showInFloatingWindow, true);

const sequenceBeforeSingleFlight = preloadDb.sequence;
const [singleFlightFirst, singleFlightSecond] = await Promise.all([
  preloadBridge.refreshProvider("legacy-relay"),
  preloadBridge.refreshProvider("legacy-relay")
]);
assert.equal(singleFlightFirst.lastCheckedAt, singleFlightSecond.lastCheckedAt);
assert.equal(preloadDb.sequence, sequenceBeforeSingleFlight + 1);
await preloadBridge.refreshProvider("legacy-relay");
assert.equal(preloadDb.sequence, sequenceBeforeSingleFlight + 2);

const supportedPlatformsTool = registeredTools.get("quota_supported_platforms");
const supportedPlatforms = await supportedPlatformsTool({ category: "plan" }, {});
assert.ok(supportedPlatforms.platformCount > 0);
assert.ok(supportedPlatforms.platforms.every((platform) => platform.category === "plan"));
const serializedPlatforms = JSON.stringify(supportedPlatforms);
assert.equal(serializedPlatforms.includes("https://"), false);
assert.equal(serializedPlatforms.includes("credentialPlaceholder"), false);
await assert.rejects(() => supportedPlatformsTool({ category: "unknown" }, {}), /category/);

const refreshTool = registeredTools.get("quota_refresh");
const sequenceBeforeUnknownSelection = preloadDb.sequence;
await assert.rejects(
  () => refreshTool({ scope: "selected", providerIds: ["missing-provider"] }, {}),
  /未知站点 ID/
);
assert.equal(preloadDb.sequence, sequenceBeforeUnknownSelection);
await assert.rejects(
  () => refreshTool({ scope: "selected", providerIds: ["legacy-relay", "legacy-relay"] }, {}),
  /重复站点 ID/
);
await assert.rejects(
  () => refreshTool({ scope: "all", providerIds: ["legacy-relay"] }, {}),
  /仅在 scope 为 selected/
);

const detailTool = registeredTools.get("quota_provider_detail");
const legacyDetail = await detailTool({ providerId: "legacy-relay" }, {});
assert.equal(legacyDetail.provider.id, "legacy-relay");
assert.equal(legacyDetail.provider.credentialConfigured, false);
assert.equal(legacyDetail.provider.error.code, "missing_credential");
assert.equal(legacyDetail.provider.meters[0].remaining, 66);
assert.equal(JSON.stringify(legacyDetail).includes("gateway.example.com"), false);
assert.equal(JSON.stringify(legacyDetail).includes("requestPath"), false);

encryptedValues.delete(`quota-api-key/${savedOfficial.id}`);
const overviewProgress = [];
const overviewTool = registeredTools.get("quota_overview");
const mcpOverview = await overviewTool(
  {},
  {
    async sendProgress(update) {
      overviewProgress.push(update);
      if (update.progress === 2) {
        throw new Error("progress transport unavailable");
      }
    }
  }
);
assert.equal(mcpOverview.providerCount, 3);
assert.equal(mcpOverview.refresh.requestedCount, 3);
assert.equal(mcpOverview.refresh.failureCount, 3);
assert.deepEqual(
  overviewProgress.map((update) => update.progress),
  [1, 2, 3]
);
assert.ok(overviewProgress.every((update) => update.total === 3));
const serializedOverview = JSON.stringify(mcpOverview);
assert.equal(serializedOverview.includes("sk-official"), false);
assert.equal(serializedOverview.includes("gateway.example.com"), false);
assert.equal(serializedOverview.includes("requestHeaders"), false);

const dueRefresh = await refreshTool({ scope: "due" }, {});
assert.equal(dueRefresh.scope, "due");
assert.equal(dueRefresh.requestedCount, 0);
const selectedRefresh = await refreshTool(
  { scope: "selected", providerIds: ["legacy-relay"] },
  {}
);
assert.equal(selectedRefresh.scope, "selected");
assert.equal(selectedRefresh.requestedCount, 1);
assert.equal(selectedRefresh.failureCount, 1);
const allRefresh = await refreshTool({ scope: "all" }, {});
assert.equal(allRefresh.scope, "all");
assert.equal(allRefresh.requestedCount, 3);
assert.equal(allRefresh.failureCount, 3);

const healthTool = registeredTools.get("quota_health_check");
const mcpHealth = await healthTool({}, {});
assert.deepEqual(mcpHealth.thresholds, {
  remainingPercentBelow: 20,
  staleAfterMinutes: 60
});
assert.equal(mcpHealth.healthy, false);
assert.ok(mcpHealth.issues.some((issue) => issue.code === "missing_credential"));
assert.ok(mcpHealth.issues.some((issue) => issue.code === "preset_unavailable"));

const floatingTool = registeredTools.get("quota_floating_window");
const visibilityTool = registeredTools.get("quota_set_floating_visibility");
const createCountBeforeMcpOpen = floatingCreateCount;
const openedFloatingState = await floatingTool({ action: "open" }, {});
assert.equal(openedFloatingState.isOpen, true);
assert.equal(floatingCreateCount, createCountBeforeMcpOpen + 1);
await floatingWindowReady();
const syncCallsBeforeVisibility = floatingWindowCalls.filter(
  (call) => call[0] === "executeJavaScript"
).length;
const visibleState = await visibilityTool(
  { providerId: savedOfficial.id, visible: true },
  {}
);
assert.equal(visibleState.isOpen, true);
assert.equal(visibleState.provider.providerId, savedOfficial.id);
assert.equal(visibleState.provider.visible, true);
assert.equal(
  (await preloadDb.get(`${PROVIDER_PREFIX}${savedOfficial.id}`)).showInFloatingWindow,
  true
);
assert.ok(
  floatingWindowCalls.filter((call) => call[0] === "executeJavaScript").length >
    syncCallsBeforeVisibility
);
await assert.rejects(
  () => visibilityTool({ providerId: "missing-provider", visible: true }, {}),
  /站点不存在/
);

const closeCallsBefore = floatingWindowCalls.filter((call) => call[0] === "close").length;
const closedFloatingState = await floatingTool({ action: "close" }, {});
assert.equal(closedFloatingState.isOpen, false);
assert.equal(
  floatingWindowCalls.filter((call) => call[0] === "close").length,
  closeCallsBefore + 1
);
const repeatedCloseState = await floatingTool({ action: "close" }, {});
assert.equal(repeatedCloseState.isOpen, false);
assert.equal(
  floatingWindowCalls.filter((call) => call[0] === "close").length,
  closeCallsBefore + 1
);
await assert.rejects(() => floatingTool({ action: "toggle" }, {}), /action/);
await assert.rejects(
  () => overviewTool({ includeSecrets: true }, {}),
  /未知字段/
);

const preloadModulePath = require.resolve("../public/preload.js");
delete require.cache[preloadModulePath];
const floatingPreloadRegistrations = [];
globalThis.window = { location: { pathname: "/dist/floating.html" } };
globalThis.utools = {
  db: { promises: new RevisionDbMock() },
  dbCryptoStorage: {
    getItem() {
      return "";
    },
    setItem() {},
    removeItem() {}
  },
  registerTool(name) {
    floatingPreloadRegistrations.push(name);
  }
};
require("../public/preload.js");
assert.equal(globalThis.window.__quotaPreloadReady, true);
assert.ok(globalThis.window.quotaBridge);
assert.deepEqual(floatingPreloadRegistrations, []);

delete require.cache[preloadModulePath];
const legacyPreloadDb = new RevisionDbMock();
globalThis.window = { location: { pathname: "/index.html" } };
globalThis.utools = {
  db: { promises: legacyPreloadDb },
  dbCryptoStorage: {
    getItem() {
      return "";
    },
    setItem() {},
    removeItem() {}
  }
};
require("../public/preload.js");
assert.equal(globalThis.window.__quotaPreloadReady, true);
assert.equal(globalThis.window.__quotaPreloadError, null);
assert.deepEqual(await globalThis.window.quotaBridge.listProviders(), []);

delete require.cache[preloadModulePath];
const unavailableApiTools = new Map();
globalThis.window = { location: { pathname: "/index.html" } };
globalThis.utools = {
  registerTool(name, handler) {
    unavailableApiTools.set(name, handler);
  }
};
require("../public/preload.js");
assert.equal(globalThis.window.__quotaPreloadReady, true);
assert.deepEqual([...unavailableApiTools.keys()], MCP_TOOL_NAMES);
await assert.rejects(
  () => unavailableApiTools.get("quota_overview")({}, {}),
  /数据库 API/
);

if (previousWindow === undefined) {
  delete globalThis.window;
} else {
  globalThis.window = previousWindow;
}
if (previousUtools === undefined) {
  delete globalThis.utools;
} else {
  globalThis.utools = previousUtools;
}

console.log("Core quota, MCP, official preset, migration, and provider deletion tests passed");
