import assert from "node:assert/strict";
import test from "node:test";
import {
  CryptoStorageMock,
  RevisionDbMock,
  createUtoolsMock,
  deferred,
  relayInput,
  require
} from "./helpers.mjs";

const { createProviderStore, DELETED_PROVIDER_PREFIX, PROVIDER_PREFIX } = require("../../public/libs/provider-store.js");
const { decodeProviderDocument } = require("../../public/libs/provider-document.js");
const { API_KEY_PREFIX, createQuotaService } = require("../../public/libs/quota-service.js");

test("store sorts providers, retries result-style conflicts, and caps retries", async () => {
  const db = new RevisionDbMock();
  const store = createProviderStore(() => db);
  await store.putNewProviderDoc({ _id: `${PROVIDER_PREFIX}second`, createdAt: "2026-08-16T02:00:00Z" });
  await store.putNewProviderDoc({ _id: `${PROVIDER_PREFIX}first`, createdAt: "2026-08-16T01:00:00Z" });
  assert.deepEqual((await store.listProviderDocs()).map(store.idFromDoc), ["first", "second"]);

  db.failNextPuts(`${PROVIDER_PREFIX}first`, 2);
  const updated = await store.putProviderPatch("first", { name: "Retried" });
  assert.equal(updated.name, "Retried");

  db.failNextPuts(`${PROVIDER_PREFIX}first`, 3);
  await assert.rejects(() => store.putProviderPatch("first", { name: "Never" }), /保存站点失败|conflict/);
});

test("deletion markers survive failed physical removal and hide stale restores", async () => {
  const db = new RevisionDbMock();
  const store = createProviderStore(() => db);
  await store.putNewProviderDoc({ _id: `${PROVIDER_PREFIX}gone`, name: "Gone" });
  db.failNextRemovals(`${PROVIDER_PREFIX}gone`, 3);
  const deletion = await store.deleteProviderDoc("gone");
  assert.equal(deletion.hardDeleted, false);
  assert.ok(await db.get(`${DELETED_PROVIDER_PREFIX}gone`));
  assert.deepEqual(await store.listProviderDocs(), []);

  db.forcePut({ _id: `${PROVIDER_PREFIX}gone`, name: "Cloud restore" });
  assert.deepEqual(await store.listProviderDocs(), []);
  await assert.rejects(() => store.getProviderDoc("gone"), /已删除/);
});

test("a write lazily upgrades legacy docs without losing credentials or snapshots", async () => {
  const db = new RevisionDbMock();
  const storage = new CryptoStorageMock();
  const utools = createUtoolsMock(db, storage);
  db.forcePut({
    _id: `${PROVIDER_PREFIX}legacy`,
    mode: "standard",
    name: "Legacy",
    baseUrl: "https://relay.example.com",
    lastBalance: 45,
    lastLimit: 100,
    lastUnit: "USD",
    refreshIntervalMinutes: 30,
    createdAt: "2025-01-01T00:00:00Z"
  });
  storage.setItem(`${API_KEY_PREFIX}legacy`, "secret-key");
  const service = createQuotaService({ utools, requestJson: async () => ({}) });

  await service.setProviderFloatingVisibility("legacy", false);
  const stored = await db.get(`${PROVIDER_PREFIX}legacy`);
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.snapshot.meters[0].remaining, 45);
  assert.equal(stored.showInFloatingWindow, false);
  assert.equal(storage.getItem(`${API_KEY_PREFIX}legacy`), "secret-key");
  for (const key of ["lastBalance", "lastLimit", "lastUnit", "lastMeters", "lastIsValid"]) {
    assert.equal(Object.hasOwn(stored, key), false, key);
  }
});

test("two services retry revision conflicts without losing independent configuration writes", async () => {
  const db = new RevisionDbMock();
  const storage = new CryptoStorageMock();
  const utools = createUtoolsMock(db, storage);
  const serviceA = createQuotaService({
    utools,
    requestJson: async () => ({}),
    createId: () => "shared",
    now: () => Date.parse("2026-08-16T01:00:00Z")
  });
  const serviceB = createQuotaService({
    utools,
    requestJson: async () => ({}),
    now: () => Date.parse("2026-08-16T01:01:00Z")
  });
  await serviceA.saveProvider(relayInput());

  await Promise.all([
    serviceA.saveProvider(relayInput({ id: "shared", name: "Renamed", apiKey: "" })),
    serviceB.setProviderFloatingVisibility("shared", false)
  ]);

  const stored = decodeProviderDocument(await db.get(`${PROVIDER_PREFIX}shared`));
  assert.equal(stored.name, "Renamed");
  assert.equal(stored.showInFloatingWindow, false);
  assert.equal(stored.schemaVersion, 2);
});

test("an older slow refresh cannot overwrite a newer completed refresh", async () => {
  const db = new RevisionDbMock();
  const storage = new CryptoStorageMock();
  const utools = createUtoolsMock(db, storage);
  const seed = createQuotaService({
    utools,
    requestJson: async () => ({}),
    createId: () => "timed",
    now: () => Date.parse("2026-08-16T01:00:00Z")
  });
  await seed.saveProvider(relayInput());

  const slowResponse = deferred();
  const slow = createQuotaService({
    utools,
    requestJson: () => slowResponse.promise,
    now: () => Date.parse("2026-08-16T02:00:00Z")
  });
  const fast = createQuotaService({
    utools,
    requestJson: async () => ({ data: { balance: 80, used: 20, limit: 100, unit: "USD" } }),
    now: () => Date.parse("2026-08-16T02:01:00Z")
  });

  const slowRefresh = slow.refreshProvider("timed");
  await new Promise((resolve) => setImmediate(resolve));
  const fastResult = await fast.refreshProvider("timed");
  assert.equal(fastResult.snapshot.meters[0].remaining, 80);
  slowResponse.resolve({ data: { balance: 10, used: 90, limit: 100, unit: "USD" } });
  const slowResult = await slowRefresh;
  assert.equal(slowResult.snapshot.meters[0].remaining, 80);

  const finalProvider = await fast.getProvider("timed");
  assert.equal(finalProvider.snapshot.meters[0].remaining, 80);
  assert.equal(finalProvider.lastCheckedAt, "2026-08-16T02:01:00.000Z");
});
