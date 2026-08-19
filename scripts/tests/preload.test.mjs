import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  CryptoStorageMock,
  RevisionDbMock,
  createUtoolsMock,
  deferred,
  relayInput,
  require
} from "./helpers.mjs";

const { createQuotaService } = require("../../public/libs/quota-service.js");
const { MCP_TOOL_NAMES } = require("../../public/libs/quota-mcp.js");

test("runtime synchronizes floating state once per mutation and once per batch", async () => {
  const db = new RevisionDbMock();
  const storage = new CryptoStorageMock();
  const utools = createUtoolsMock(db, storage);
  let now = Date.parse("2026-08-16T01:00:00Z");
  let syncCount = 0;
  let requestCount = 0;
  let nextId = 1;
  const service = createQuotaService({
    utools,
    now: () => now,
    createId: () => `provider-${nextId++}`,
    onProvidersChanged: async () => {
      syncCount += 1;
    },
    requestJson: async () => {
      requestCount += 1;
      return { data: { balance: 80, used: 20, limit: 100, unit: "USD" } };
    }
  });
  const first = await service.saveProvider(relayInput({ name: "First" }));
  await service.saveProvider(relayInput({ name: "Second" }));

  syncCount = 0;
  await service.refreshProvider(first.id);
  assert.equal(syncCount, 1, "single refresh");

  now += 31 * 60 * 1000;
  syncCount = 0;
  requestCount = 0;
  await service.refreshDueProviders();
  assert.equal(syncCount, 1, "due batch");
  assert.equal(requestCount, 2);

  syncCount = 0;
  requestCount = 0;
  await service.refreshAll();
  assert.equal(syncCount, 1, "all batch");
  assert.equal(requestCount, 2);

  syncCount = 0;
  requestCount = 0;
  await service.refreshBatch("selected", [first.id], { sendProgress: async () => {} });
  assert.equal(syncCount, 1, "MCP batch");
  assert.equal(requestCount, 1);

  syncCount = 0;
  await service.setProviderFloatingVisibility(first.id, false);
  assert.equal(syncCount, 1, "visibility write");

  syncCount = 0;
  await service.deleteProvider(first.id);
  assert.equal(syncCount, 1, "delete");
});

test("single-flight refresh performs one request for concurrent callers", async () => {
  const db = new RevisionDbMock();
  const storage = new CryptoStorageMock();
  const utools = createUtoolsMock(db, storage);
  const response = deferred();
  let requestCount = 0;
  let syncCount = 0;
  const service = createQuotaService({
    utools,
    createId: () => "single-flight",
    onProvidersChanged: async () => {
      syncCount += 1;
    },
    requestJson: () => {
      requestCount += 1;
      return response.promise;
    }
  });
  await service.saveProvider(relayInput());
  syncCount = 0;
  const first = service.refreshProvider("single-flight");
  const second = service.refreshProvider("single-flight");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestCount, 1);
  response.resolve({ data: { balance: 50, used: 50, limit: 100, unit: "USD" } });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult.snapshot, secondResult.snapshot);
  assert.equal(syncCount, 1);
});

function executePreload(pathname) {
  const preloadPath = resolve("public/preload.js");
  const preloadRequire = createRequire(preloadPath);
  const utools = createUtoolsMock();
  const window = { location: { pathname }, utools };
  const context = {
    window,
    console,
    require: preloadRequire,
    __dirname: resolve("public"),
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(readFileSync(preloadPath, "utf8"), context, { filename: preloadPath });
  return { window, utools };
}

test("main preload exposes the v2 bridge and registers exactly seven MCP tools", async () => {
  const { window, utools } = executePreload("/index.html");
  assert.equal(window.__quotaPreloadReady, true);
  assert.equal(window.__quotaPreloadError, null);
  assert.deepEqual([...utools.registeredTools.keys()], [...MCP_TOOL_NAMES]);
  assert.equal(typeof window.quotaBridge.listProviderTemplates, "function");
  assert.equal(typeof window.quotaBridge.syncFloatingWindow, "undefined");
  const templates = window.quotaBridge.listProviderTemplates();
  assert.equal(typeof templates.then, "function");
  assert.equal((await templates).length, 3);
});

test("floating preload keeps its independent bridge but does not register MCP tools", () => {
  const { window, utools } = executePreload("C:/plugin/floating.html");
  assert.equal(window.__quotaPreloadReady, true);
  assert.equal(typeof window.quotaBridge.refreshDueProviders, "function");
  assert.equal(utools.registeredTools.size, 0);
});
