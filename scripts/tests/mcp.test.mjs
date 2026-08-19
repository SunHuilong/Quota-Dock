import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv from "ajv";
import { clone, projectedMeter, projectedProvider, require } from "./helpers.mjs";

const {
  DEFAULT_STALE_AFTER_MINUTES,
  createHealthReport,
  createOverview,
  createRefreshBatch,
  projectProviderDetail,
  projectProviderSummary
} = require("../../public/libs/quota-mcp.js");
const {
  createMcpHandlers,
  normalizeRefreshSelection,
  normalizeToolInput
} = require("../../public/libs/mcp-handlers.js");

const NOW = Date.parse("2026-08-16T02:00:00.000Z");

test("MCP projections reuse canonical status and meter percentage while redacting configuration", () => {
  const provider = projectedProvider({
    status: "error",
    lastError: "URL: https://secret.example.com/private/quota Body: sk-secret"
  });
  const detail = projectProviderDetail(provider, { nowMs: NOW, staleAfterMinutes: 60 });
  assert.equal(detail.status, "error");
  assert.equal(detail.error.code, "refresh_failed");
  assert.equal(detail.primaryMeter.remainingPercent, 25);
  assert.equal(detail.meters[0].remainingPercent, provider.snapshot.meters[0].remainingPercent);

  const serialized = JSON.stringify(detail);
  for (const secret of ["secret.example.com", "/private/quota", "sk-secret", "raw.private.balance"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  for (const field of ["baseUrl", "requestPath", "requestHeaders", "requestBody", "jsonPaths", "apiKey"]) {
    assert.equal(Object.hasOwn(detail, field), false, field);
  }
});

test("overview and health reports share status, primary meter, totals, and percentage rules", () => {
  const providers = [
    projectedProvider(),
    projectedProvider({
      id: "provider-2",
      name: "Second",
      status: "unconfigured",
      hasApiKey: false,
      snapshot: {
        primaryMeterId: "balance",
        meters: [projectedMeter({ remaining: 5, used: 95, remainingPercent: 5 })]
      }
    })
  ];
  const overview = createOverview(providers, { nowMs: NOW, staleAfterMinutes: 60 });
  assert.deepEqual(overview.statusCounts, {
    ok: 1,
    error: 0,
    unconfigured: 1,
    unavailable: 0,
    pending: 0
  });
  assert.deepEqual(overview.totalsByUnit, [{ unit: "USD", total: 30 }]);

  const health = createHealthReport(
    providers,
    { remainingPercentBelow: 10, staleAfterMinutes: 60 },
    { nowMs: NOW }
  );
  assert.ok(health.issues.some((issue) => issue.code === "missing_credential"));
  assert.ok(health.issues.some((issue) => issue.code === "low_remaining" && issue.remainingPercent === 5));
});

test("MCP input guards reject aliases, unknown fields, duplicates, and invalid selections", () => {
  assert.deepEqual(normalizeToolInput(undefined, []), {});
  assert.throws(() => normalizeToolInput({ extra: true }, []), /未知字段/);
  assert.throws(() => normalizeRefreshSelection({ scope: "selected", providerIds: [] }), /非空数组/);
  assert.throws(
    () => normalizeRefreshSelection({ scope: "selected", providerIds: ["one", "one"] }),
    /不能包含重复/
  );
  assert.throws(() => normalizeRefreshSelection({ scope: "all", providerIds: ["one"] }), /仅在/);
  assert.throws(() => normalizeRefreshSelection({ scope: "legacy" }), /due、all 或 selected/);
});

test("all seven real handler results validate against generated schemas with Ajv", async () => {
  const manifest = JSON.parse(readFileSync("public/plugin.json", "utf8"));
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: true });
  const providers = [
    projectedProvider(),
    projectedProvider({
      id: "provider-2",
      name: "Provider Two",
      status: "unconfigured",
      hasApiKey: false,
      snapshot: null,
      lastCheckedAt: null
    })
  ];
  const progressEvents = [];
  const quotaService = {
    async listProviders() {
      return clone(providers);
    },
    async getProvider(id) {
      const provider = providers.find((item) => item.id === id);
      if (!provider) {
        throw new Error(`未知站点 ID：${id}`);
      }
      return clone(provider);
    },
    async refreshBatch(scope, providerIds, ctx) {
      const selected =
        scope === "selected"
          ? providerIds.map((id) => providers.find((provider) => provider.id === id)).filter(Boolean)
          : providers;
      if (scope === "selected" && selected.length !== providerIds.length) {
        throw new Error("未知站点 ID");
      }
      const taskResults = selected.map((provider, index) => ({
        index,
        item: { id: provider.id, name: provider.name },
        fulfilled: true,
        value: clone(provider),
        error: null
      }));
      if (ctx?.sendProgress) {
        await ctx.sendProgress({ progress: selected.length, total: selected.length, message: "done" });
      }
      return createRefreshBatch(scope, taskResults, {
        nowMs: NOW,
        staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES
      });
    },
    async listOfficialProviderPresets() {
      return [
        {
          id: "deepseek-api",
          name: "DeepSeek API",
          category: "api",
          categoryLabel: "按量 API",
          credentialLabel: "API Key",
          credentialPlaceholder: "sk-...",
          credentialHelp: "",
          defaultUnit: "CNY",
          supportsManualLimit: true,
          supportsCurrencyOverride: true
        }
      ];
    },
    async setProviderFloatingVisibility(id, visible) {
      const provider = providers.find((item) => item.id === id);
      if (!provider) {
        throw new Error("未知站点 ID");
      }
      provider.showInFloatingWindow = visible;
      return clone(provider);
    }
  };
  let floatingOpen = true;
  const floatingController = {
    isOpen: () => floatingOpen,
    async open() {
      floatingOpen = true;
    },
    async close() {
      floatingOpen = false;
    }
  };
  const handlers = createMcpHandlers({ quotaService, floatingController, now: () => NOW });
  const inputs = {
    quota_overview: {},
    quota_provider_detail: { providerId: "provider-1" },
    quota_refresh: { scope: "selected", providerIds: ["provider-1"] },
    quota_health_check: { remainingPercentBelow: 20, staleAfterMinutes: 60 },
    quota_supported_platforms: { category: "api" },
    quota_floating_window: { action: "close" },
    quota_set_floating_visibility: { providerId: "provider-1", visible: false }
  };
  const ctx = { async sendProgress(event) { progressEvents.push(event); } };

  for (const [toolName, input] of Object.entries(inputs)) {
    const tool = manifest.tools[toolName];
    const validateInput = ajv.compile(tool.inputSchema);
    assert.equal(validateInput(input), true, `${toolName} input: ${ajv.errorsText(validateInput.errors)}`);
    const output = await handlers[toolName](input, ctx);
    const validateOutput = ajv.compile(tool.outputSchema);
    assert.equal(validateOutput(output), true, `${toolName} output: ${ajv.errorsText(validateOutput.errors)}`);
    const serialized = JSON.stringify(output);
    for (const secret of ["secret.example.com", "/private/quota", "sk-secret", "raw.private.balance"]) {
      assert.equal(serialized.includes(secret), false, `${toolName}: ${secret}`);
    }
  }
  assert.ok(progressEvents.length >= 4);
});
