"use strict";

const {
  AUTH_PLACEMENT_HEADER,
  BALANCE_ROUTE,
  DEFAULT_JSON_PATHS,
  DEFAULT_PRICE_MULTIPLIER,
  DEFAULT_TEMPLATE_ID,
  DEFAULT_UNIT,
  PROVIDER_MODE_OFFICIAL,
  PROVIDER_MODE_RELAY,
  REQUEST_METHOD_GET,
  TEMPLATE_CUSTOM,
  clampRefreshInterval,
  getDefaultAdvancedBodyText,
  getDefaultAdvancedHeadersText,
  getProviderTemplate,
  getProviderTemplates,
  normalizeQuotaSnapshot
} = require("./quota-core.js");

const PROVIDER_SCHEMA_VERSION = 2;
const LEGACY_INVALID_MESSAGE = "历史额度记录标记为无效";
const INVALID_SNAPSHOT_MESSAGE = "额度快照数据损坏";

function stringValue(value, fallback) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  return text || fallback;
}

function finiteNumberOrNull(value) {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function combineErrors(...messages) {
  return [...new Set(messages.map((message) => String(message || "").trim()).filter(Boolean))].join("；");
}

function decodeLegacyMode(value) {
  const mode = String(value || "").trim().toLowerCase();

  if (!mode || mode === "standard" || mode === PROVIDER_MODE_RELAY) {
    return { mode: PROVIDER_MODE_RELAY, legacyTemplateId: DEFAULT_TEMPLATE_ID, error: "" };
  }
  if (mode === "advanced") {
    return { mode: PROVIDER_MODE_RELAY, legacyTemplateId: TEMPLATE_CUSTOM, error: "" };
  }
  if (mode === PROVIDER_MODE_OFFICIAL) {
    return { mode: PROVIDER_MODE_OFFICIAL, legacyTemplateId: DEFAULT_TEMPLATE_ID, error: "" };
  }

  return {
    mode: PROVIDER_MODE_RELAY,
    legacyTemplateId: TEMPLATE_CUSTOM,
    error: `未知站点模式：${mode}`
  };
}

function decodeTemplateId(value, legacyTemplateId) {
  const templateId = String(value || "").trim();
  const knownIds = new Set(getProviderTemplates().map((template) => template.id));

  if (knownIds.has(templateId)) {
    return { templateId, error: "" };
  }
  if (!templateId) {
    return { templateId: legacyTemplateId, error: "" };
  }

  return {
    templateId: TEMPLATE_CUSTOM,
    error: `未知专业模式模板：${templateId}`
  };
}

function normalizeStoredSnapshot(snapshot, defaultUnit) {
  return normalizeQuotaSnapshot(snapshot, { defaultUnit: defaultUnit || DEFAULT_UNIT });
}

function legacyScalarSnapshot(doc, defaultUnit) {
  const remaining = finiteNumberOrNull(doc.lastBalance);
  const used = finiteNumberOrNull(doc.lastUsed);
  const limit = finiteNumberOrNull(doc.lastLimit);

  if (remaining === null && used === null && limit === null) {
    return null;
  }

  return normalizeStoredSnapshot(
    {
      primaryMeterId: "balance",
      meters: [
        {
          id: "balance",
          label: "可用额度",
          kind: "balance",
          remaining,
          used,
          limit,
          unit: doc.lastUnit || defaultUnit || DEFAULT_UNIT,
          resetAt: doc.lastResetAt || null,
          aggregate: true
        }
      ]
    },
    defaultUnit
  );
}

function decodeSnapshot(doc, defaultUnit) {
  if (Number(doc.schemaVersion) === PROVIDER_SCHEMA_VERSION) {
    if (!doc.snapshot) {
      return { snapshot: null, error: "" };
    }
    try {
      return { snapshot: normalizeStoredSnapshot(doc.snapshot, defaultUnit), error: "" };
    } catch {
      return { snapshot: null, error: INVALID_SNAPSHOT_MESSAGE };
    }
  }

  if (doc.snapshot) {
    try {
      return { snapshot: normalizeStoredSnapshot(doc.snapshot, defaultUnit), error: "" };
    } catch {
      // Unversioned documents may contain an incomplete experimental snapshot.
    }
  }

  if (Array.isArray(doc.lastMeters) && doc.lastMeters.length) {
    try {
      return {
        snapshot: normalizeStoredSnapshot(
          { primaryMeterId: doc.lastPrimaryMeterId, meters: doc.lastMeters },
          defaultUnit
        ),
        error: ""
      };
    } catch {
      // v1 mirrored scalar fields are the final recovery source.
    }
  }

  try {
    return { snapshot: legacyScalarSnapshot(doc, defaultUnit), error: "" };
  } catch {
    return { snapshot: null, error: INVALID_SNAPSHOT_MESSAGE };
  }
}

function decodeProviderDocument(rawDocument) {
  const doc = rawDocument && typeof rawDocument === "object" ? rawDocument : {};
  const modeResult = decodeLegacyMode(doc.mode);
  const templateResult =
    modeResult.mode === PROVIDER_MODE_RELAY
      ? decodeTemplateId(doc.templateId, modeResult.legacyTemplateId)
      : { templateId: DEFAULT_TEMPLATE_ID, error: "" };
  const template = getProviderTemplate(templateResult.templateId);
  const defaultUnit = stringValue(doc.defaultUnit || doc.lastUnit, DEFAULT_UNIT);
  const snapshotResult = decodeSnapshot(doc, defaultUnit);
  const legacyValidityError = doc.lastIsValid === false && !doc.lastError ? LEGACY_INVALID_MESSAGE : "";
  const lastError = combineErrors(
    doc.lastError,
    legacyValidityError,
    modeResult.error,
    templateResult.error,
    snapshotResult.error
  );
  const common = {
    _id: stringValue(doc._id, ""),
    ...(doc._rev ? { _rev: doc._rev } : {}),
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    mode: modeResult.mode,
    name: stringValue(doc.name, "未命名站点"),
    manualLimit: finiteNumberOrNull(doc.manualLimit),
    refreshIntervalMinutes: clampRefreshInterval(doc.refreshIntervalMinutes),
    showInFloatingWindow: doc.showInFloatingWindow !== false,
    snapshot: snapshotResult.snapshot,
    lastCheckedAt: doc.lastCheckedAt ? String(doc.lastCheckedAt) : null,
    lastError,
    createdAt: stringValue(doc.createdAt || doc.updatedAt, ""),
    updatedAt: stringValue(doc.updatedAt || doc.createdAt, "")
  };

  if (modeResult.mode === PROVIDER_MODE_OFFICIAL) {
    return {
      ...common,
      officialPresetId: stringValue(doc.officialPresetId, ""),
      currencyOverride: stringValue(doc.currencyOverride, "").toUpperCase()
    };
  }

  const priceMultiplier = finiteNumberOrNull(doc.priceMultiplier);
  return {
    ...common,
    baseUrl: stringValue(doc.baseUrl, ""),
    templateId: templateResult.templateId,
    requestPath: stringValue(doc.requestPath, template.requestPath || BALANCE_ROUTE),
    requestMethod: stringValue(doc.requestMethod, template.requestMethod || REQUEST_METHOD_GET).toUpperCase(),
    authPlacement: stringValue(doc.authPlacement, template.authPlacement || AUTH_PLACEMENT_HEADER).toLowerCase(),
    requestHeaders: stringValue(
      doc.requestHeaders,
      template.requestHeaders || getDefaultAdvancedHeadersText(AUTH_PLACEMENT_HEADER)
    ),
    requestBody:
      doc.requestBody === undefined || doc.requestBody === null
        ? template.requestBody || getDefaultAdvancedBodyText(doc.authPlacement || AUTH_PLACEMENT_HEADER)
        : String(doc.requestBody),
    jsonPaths: {
      ...DEFAULT_JSON_PATHS,
      ...template.jsonPaths,
      ...(doc.jsonPaths && typeof doc.jsonPaths === "object" ? doc.jsonPaths : {})
    },
    defaultUnit,
    priceMultiplier: priceMultiplier !== null && priceMultiplier > 0 ? priceMultiplier : DEFAULT_PRICE_MULTIPLIER
  };
}

function encodeProviderDocument(provider) {
  const source = decodeProviderDocument({ ...provider, schemaVersion: PROVIDER_SCHEMA_VERSION });
  const common = {
    _id: source._id,
    ...(source._rev ? { _rev: source._rev } : {}),
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    mode: source.mode,
    name: source.name,
    manualLimit: source.manualLimit,
    refreshIntervalMinutes: source.refreshIntervalMinutes,
    showInFloatingWindow: source.showInFloatingWindow,
    snapshot: source.snapshot,
    lastCheckedAt: source.lastCheckedAt,
    lastError: source.lastError,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt
  };

  if (source.mode === PROVIDER_MODE_OFFICIAL) {
    return {
      ...common,
      officialPresetId: source.officialPresetId,
      currencyOverride: source.currencyOverride
    };
  }

  return {
    ...common,
    baseUrl: source.baseUrl,
    templateId: source.templateId,
    requestPath: source.requestPath,
    requestMethod: source.requestMethod,
    authPlacement: source.authPlacement,
    requestHeaders: source.requestHeaders,
    requestBody: source.requestBody,
    jsonPaths: source.jsonPaths,
    defaultUnit: source.defaultUnit,
    priceMultiplier: source.priceMultiplier
  };
}

module.exports = {
  PROVIDER_SCHEMA_VERSION,
  LEGACY_INVALID_MESSAGE,
  INVALID_SNAPSHOT_MESSAGE,
  decodeProviderDocument,
  encodeProviderDocument
};
