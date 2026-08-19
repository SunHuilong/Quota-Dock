import assert from "node:assert/strict";
import test from "node:test";
import { require } from "./helpers.mjs";

const {
  INVALID_SNAPSHOT_MESSAGE,
  LEGACY_INVALID_MESSAGE,
  PROVIDER_SCHEMA_VERSION,
  decodeProviderDocument,
  encodeProviderDocument
} = require("../../public/libs/provider-document.js");

const LEGACY_FIELDS = [
  "lastPrimaryMeterId",
  "lastMeters",
  "lastBalance",
  "lastUsed",
  "lastLimit",
  "lastResetAt",
  "lastUnit",
  "lastIsValid",
  "isValid"
];

test("v0 scalar documents migrate lazily to a v2 snapshot without mirror fields", () => {
  const decoded = decodeProviderDocument({
    _id: "quota-provider/v0",
    _rev: "1-old",
    mode: "standard",
    name: "Legacy relay",
    baseUrl: "https://relay.example.com",
    lastBalance: 66,
    lastUsed: 34,
    lastLimit: 100,
    lastUnit: "CNY",
    lastResetAt: "2026-08-17T00:00:00Z",
    lastIsValid: false,
    createdAt: "2026-01-01T00:00:00Z"
  });

  assert.equal(decoded.schemaVersion, 2);
  assert.equal(decoded.mode, "relay");
  assert.equal(decoded.templateId, "openai-usage");
  assert.equal(decoded.snapshot.meters[0].remaining, 66);
  assert.equal(decoded.snapshot.meters[0].unit, "CNY");
  assert.match(decoded.lastError, new RegExp(LEGACY_INVALID_MESSAGE));

  const encoded = encodeProviderDocument(decoded);
  assert.equal(encoded.schemaVersion, PROVIDER_SCHEMA_VERSION);
  assert.equal(encoded.snapshot.meters[0].remaining, 66);
  for (const field of LEGACY_FIELDS) {
    assert.equal(Object.hasOwn(encoded, field), false, field);
  }
});

test("advanced maps to relay custom while v1 meters remain authoritative", () => {
  const decoded = decodeProviderDocument({
    _id: "quota-provider/v1",
    mode: "advanced",
    name: "Advanced legacy",
    baseUrl: "https://relay.example.com",
    lastPrimaryMeterId: "tokens",
    lastMeters: [
      { id: "tokens", label: "Tokens", kind: "quota", remaining: 40, used: 60, limit: 100, unit: "Tokens" }
    ],
    lastBalance: 999,
    lastLimit: 1000,
    lastUnit: "USD"
  });
  assert.equal(decoded.mode, "relay");
  assert.equal(decoded.templateId, "custom");
  assert.equal(decoded.snapshot.primaryMeterId, "tokens");
  assert.equal(decoded.snapshot.meters[0].remaining, 40);
});

test("damaged v1 meters recover from scalars but damaged v2 snapshots never do", () => {
  const damagedV1 = decodeProviderDocument({
    _id: "quota-provider/damaged-v1",
    mode: "relay",
    lastMeters: [{ id: "broken", remaining: null, used: null, limit: 100 }],
    lastBalance: 12,
    lastLimit: 20,
    lastUnit: "USD"
  });
  assert.equal(damagedV1.snapshot.meters[0].remaining, 12);

  const damagedV2 = decodeProviderDocument({
    _id: "quota-provider/damaged-v2",
    schemaVersion: 2,
    mode: "relay",
    snapshot: { primaryMeterId: "broken", meters: [{ id: "broken", remaining: null, used: null }] },
    lastBalance: 99,
    lastLimit: 100,
    lastUnit: "USD"
  });
  assert.equal(damagedV2.snapshot, null);
  assert.match(damagedV2.lastError, new RegExp(INVALID_SNAPSHOT_MESSAGE));
});

test("unknown official presets and historical snapshots survive repeated migration", () => {
  const decoded = decodeProviderDocument({
    _id: "quota-provider/unknown-official",
    _rev: "4-cloud",
    mode: "official",
    officialPresetId: "retired-provider",
    templateId: "retired-relay-template",
    name: "Retired provider",
    currencyOverride: "EUR",
    lastMeters: [
      { id: "balance", label: "Balance", kind: "balance", remaining: 5, used: null, limit: null, unit: "EUR" }
    ],
    lastPrimaryMeterId: "balance",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z"
  });
  const firstWrite = encodeProviderDocument(decoded);
  const secondWrite = encodeProviderDocument(decodeProviderDocument(firstWrite));

  assert.equal(firstWrite.officialPresetId, "retired-provider");
  assert.equal(decoded.lastError, "");
  assert.equal(firstWrite.snapshot.meters[0].remaining, 5);
  assert.equal(firstWrite._id, "quota-provider/unknown-official");
  assert.equal(firstWrite._rev, "4-cloud");
  assert.deepEqual(secondWrite, firstWrite);
});

test("v2 encoder whitelists fields and keeps null snapshots stable", () => {
  const encoded = encodeProviderDocument({
    _id: "quota-provider/new",
    schemaVersion: 2,
    mode: "relay",
    name: "New",
    baseUrl: "https://relay.example.com",
    templateId: "custom",
    requestPath: "/v1/usage",
    requestMethod: "GET",
    authPlacement: "header",
    requestHeaders: "{}",
    requestBody: "",
    jsonPaths: { balance: "data.balance" },
    defaultUnit: "USD",
    priceMultiplier: 1,
    refreshIntervalMinutes: 30,
    showInFloatingWindow: true,
    snapshot: null,
    lastCheckedAt: null,
    lastError: "",
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
    apiKey: "must-not-persist",
    requestConfig: { secret: true },
    lastBalance: 10
  });
  assert.equal(encoded.snapshot, null);
  assert.equal(Object.hasOwn(encoded, "apiKey"), false);
  assert.equal(Object.hasOwn(encoded, "requestConfig"), false);
  assert.equal(Object.hasOwn(encoded, "lastBalance"), false);
});
