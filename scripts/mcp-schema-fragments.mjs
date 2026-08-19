const nullableNumber = { type: ["number", "null"] };
const nullableString = { type: ["string", "null"] };
const nonNegativeInteger = { type: "integer", minimum: 0 };
const providerStatus = {
  type: "string",
  enum: ["ok", "error", "unconfigured", "unavailable", "pending"]
};
const errorCode = {
  type: "string",
  enum: [
    "missing_credential",
    "preset_unavailable",
    "refresh_failed",
    "not_checked",
    "stale",
    "low_remaining"
  ]
};

function strictObject(properties, required = Object.keys(properties)) {
  return { type: "object", properties, required, additionalProperties: false };
}

const providerProperties = {
  id: { type: "string" },
  name: { type: "string" },
  mode: { type: "string", enum: ["relay", "official"] },
  officialPresetId: nullableString,
  officialPresetName: nullableString,
  credentialConfigured: { type: "boolean" },
  status: providerStatus,
  checkedAt: nullableString,
  stale: { type: "boolean" },
  floatingVisible: { type: "boolean" },
  primaryMeter: { anyOf: [{ $ref: "#/$defs/meter" }, { type: "null" }] },
  error: { anyOf: [{ $ref: "#/$defs/safeError" }, { type: "null" }] }
};

export const schemaDefs = {
  safeError: strictObject({ code: errorCode, message: { type: "string" } }),
  meter: strictObject({
    id: { type: "string" },
    label: { type: "string" },
    kind: { type: "string", enum: ["balance", "quota", "spend"] },
    remaining: nullableNumber,
    used: nullableNumber,
    limit: nullableNumber,
    unit: { type: "string" },
    resetAt: nullableString,
    remainingPercent: { ...nullableNumber, minimum: 0, maximum: 100 },
    aggregate: { type: "boolean" }
  }),
  providerSummary: strictObject(providerProperties),
  providerDetail: strictObject({
    ...providerProperties,
    meters: { type: "array", items: { $ref: "#/$defs/meter" } }
  }),
  statusCounts: strictObject({
    ok: nonNegativeInteger,
    error: nonNegativeInteger,
    unconfigured: nonNegativeInteger,
    unavailable: nonNegativeInteger,
    pending: nonNegativeInteger
  }),
  unitTotal: strictObject({ unit: { type: "string" }, total: { type: "number" } }),
  refreshOutcome: strictObject({
    providerId: { type: "string" },
    providerName: { type: "string" },
    success: { type: "boolean" },
    status: providerStatus,
    checkedAt: nullableString,
    error: { anyOf: [{ $ref: "#/$defs/safeError" }, { type: "null" }] }
  }),
  refreshBatch: strictObject({
    scope: { type: "string", enum: ["due", "all", "selected"] },
    requestedCount: nonNegativeInteger,
    successCount: nonNegativeInteger,
    failureCount: nonNegativeInteger,
    results: { type: "array", items: { $ref: "#/$defs/refreshOutcome" } }
  }),
  thresholds: strictObject({
    remainingPercentBelow: { type: "number", minimum: 0, maximum: 100 },
    staleAfterMinutes: { type: "number", exclusiveMinimum: 0, maximum: 525600 }
  }),
  healthIssue: strictObject({
    providerId: { type: "string" },
    providerName: { type: "string" },
    code: errorCode,
    severity: { type: "string", enum: ["error", "warning"] },
    message: { type: "string" },
    meterId: nullableString,
    meterLabel: nullableString,
    remainingPercent: { ...nullableNumber, minimum: 0, maximum: 100 }
  }),
  floatingProvider: strictObject({
    providerId: { type: "string" },
    name: { type: "string" },
    visible: { type: "boolean" }
  })
};

const dependencies = {
  providerSummary: ["meter", "safeError"],
  providerDetail: ["meter", "safeError"],
  refreshOutcome: ["safeError"],
  refreshBatch: ["refreshOutcome", "safeError"]
};

export function withSchemaDefs(schema, names) {
  const selected = new Set();
  function add(name) {
    if (selected.has(name)) {
      return;
    }
    selected.add(name);
    for (const dependency of dependencies[name] || []) {
      add(dependency);
    }
  }
  for (const name of names) {
    add(name);
  }
  return {
    ...schema,
    $defs: Object.fromEntries([...selected].map((name) => [name, schemaDefs[name]]))
  };
}

export { nonNegativeInteger, nullableString, strictObject };
