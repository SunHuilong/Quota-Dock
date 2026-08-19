"use strict";

const { getJsonPathValue } = require("./quota-core.js");

const DEFAULT_HEADERS = { Accept: "application/json" };

function bearerHeaders(apiKey, extraHeaders) {
  return {
    ...DEFAULT_HEADERS,
    Authorization: `Bearer ${apiKey}`,
    ...(extraHeaders || {})
  };
}

function apiKeyHeaders(apiKey, extraHeaders) {
  return {
    ...DEFAULT_HEADERS,
    "x-api-key": apiKey,
    ...(extraHeaders || {})
  };
}

function numberValue(value, label) {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${label}不是有效数字`);
  }
  return number;
}

function firstValue(source, paths) {
  for (const path of paths) {
    const value = getJsonPathValue(source, path);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function firstNumber(source, paths, label) {
  return numberValue(firstValue(source, paths), label);
}

function firstString(source, paths, fallback) {
  const value = firstValue(source, paths);
  return value === null ? fallback : String(value).trim() || fallback;
}

function requireNumber(value, label) {
  const number = numberValue(value, label);
  if (number === null) {
    throw new Error(`${label}缺失`);
  }
  return number;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function slug(value, fallback) {
  const result = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return result || fallback;
}

function balanceMeter(id, label, remaining, unit, extra) {
  return {
    id,
    label,
    kind: "balance",
    remaining,
    used: null,
    limit: null,
    unit,
    resetAt: null,
    aggregate: true,
    ...(extra || {})
  };
}

function singleBalanceSnapshot(response, options) {
  const remaining = requireNumber(firstValue(response, options.paths), "余额字段");
  return {
    primaryMeterId: "balance",
    meters: [
      balanceMeter(
        "balance",
        options.label || "可用余额",
        remaining * (options.multiplier || 1),
        options.unit
      )
    ]
  };
}

function simplePreset(definition) {
  return {
    ...definition,
    async execute(context) {
      const response = await context.requestJson({
        url: definition.url,
        method: "GET",
        headers: (definition.headers || bearerHeaders)(context.apiKey)
      });
      return definition.parse(response);
    }
  };
}

module.exports = {
  bearerHeaders,
  apiKeyHeaders,
  numberValue,
  firstValue,
  firstNumber,
  firstString,
  requireNumber,
  asArray,
  slug,
  balanceMeter,
  singleBalanceSnapshot,
  simplePreset
};
