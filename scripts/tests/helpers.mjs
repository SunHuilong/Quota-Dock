import { createRequire } from "node:module";

export const require = createRequire(import.meta.url);

export function clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export class RevisionDbMock {
  constructor() {
    this.docs = new Map();
    this.sequence = 0;
    this.putConflicts = new Map();
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
    const forcedConflicts = this.putConflicts.get(doc._id) || 0;
    if (forcedConflicts > 0) {
      this.putConflicts.set(doc._id, forcedConflicts - 1);
      return { ok: false, error: "conflict", status: 409 };
    }

    const current = this.docs.get(doc._id);
    if ((current && doc._rev !== current._rev) || (!current && doc._rev)) {
      return { ok: false, error: "conflict", status: 409 };
    }
    const stored = { ...clone(doc), _rev: this.nextRevision(current), _deleted: false };
    this.docs.set(doc._id, stored);
    return { id: doc._id, ok: true, rev: stored._rev };
  }

  async remove(doc) {
    const current = this.docs.get(doc._id);
    const forcedConflicts = this.removeConflicts.get(doc._id) || 0;
    if (forcedConflicts > 0) {
      this.removeConflicts.set(doc._id, forcedConflicts - 1);
      return { ok: false, error: "conflict", status: 409 };
    }
    if (!current || current._deleted || doc._rev !== current._rev) {
      return { ok: false, error: "conflict", status: 409 };
    }
    this.docs.set(doc._id, {
      ...current,
      _deleted: true,
      _rev: this.nextRevision(current)
    });
    return { id: doc._id, ok: true };
  }

  forcePut(doc) {
    const current = this.docs.get(doc._id);
    const stored = { ...clone(doc), _rev: this.nextRevision(current), _deleted: false };
    this.docs.set(doc._id, stored);
    return clone(stored);
  }

  failNextPuts(id, count = 1) {
    this.putConflicts.set(id, count);
  }

  failNextRemovals(id, count = 1) {
    this.removeConflicts.set(id, count);
  }
}

export class CryptoStorageMock {
  constructor(sharedValues = new Map()) {
    this.values = sharedValues;
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }

  async removeItem(key) {
    this.values.delete(key);
  }
}

export function createUtoolsMock(database = new RevisionDbMock(), storage = new CryptoStorageMock()) {
  const registeredTools = new Map();
  return {
    db: {
      promises: {
        get: database.get.bind(database),
        put: database.put.bind(database),
        remove: database.remove.bind(database),
        allDocs: database.allDocs.bind(database),
        async replicateStateFromCloud() {
          return 0;
        }
      }
    },
    dbCryptoStorage: storage,
    registerTool(name, handler) {
      registeredTools.set(name, handler);
    },
    registeredTools,
    database,
    storage
  };
}

export function relayInput(overrides = {}) {
  return {
    mode: "relay",
    name: "Relay One",
    baseUrl: "https://relay.example.com",
    apiKey: "sk-test",
    templateId: "custom",
    requestPath: "/v1/usage",
    requestMethod: "GET",
    authPlacement: "header",
    requestHeaders: '{"Authorization":"Bearer {{token}}","Accept":"application/json"}',
    requestBody: "",
    jsonPaths: {
      balance: "data.balance",
      used: "data.used",
      limit: "data.limit",
      resetAt: "",
      unit: "data.unit"
    },
    manualLimit: null,
    defaultUnit: "USD",
    priceMultiplier: 1,
    refreshIntervalMinutes: 30,
    ...overrides
  };
}

export function projectedMeter(overrides = {}) {
  return {
    id: "balance",
    label: "可用额度",
    kind: "balance",
    remaining: 25,
    used: 75,
    limit: 100,
    unit: "USD",
    resetAt: null,
    remainingPercent: 25,
    aggregate: true,
    ...overrides
  };
}

export function projectedProvider(overrides = {}) {
  return {
    id: "provider-1",
    mode: "relay",
    name: "Provider One",
    officialPresetId: null,
    officialPresetName: null,
    officialPresetAvailable: true,
    baseUrl: "https://secret.example.com",
    templateId: "custom",
    requestPath: "/private/quota",
    requestMethod: "GET",
    authPlacement: "header",
    requestHeaders: '{"Authorization":"Bearer sk-secret"}',
    requestBody: '{"token":"sk-secret"}',
    jsonPaths: { balance: "raw.private.balance", used: "", limit: "", resetAt: "", unit: "" },
    manualLimit: null,
    currencyOverride: "",
    defaultUnit: "USD",
    priceMultiplier: 1,
    refreshIntervalMinutes: 30,
    showInFloatingWindow: true,
    snapshot: { primaryMeterId: "balance", meters: [projectedMeter()] },
    status: "ok",
    lastCheckedAt: "2026-08-16T01:00:00.000Z",
    lastError: "",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-16T01:00:00.000Z",
    hasApiKey: true,
    ...overrides
  };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
