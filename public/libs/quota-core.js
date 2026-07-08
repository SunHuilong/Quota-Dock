"use strict";

const BALANCE_ROUTE = "/v1/usage";
const DEFAULT_UNIT = "USD";
const DEFAULT_REFRESH_MINUTES = 30;
const MIN_REFRESH_MINUTES = 1;
const MAX_REFRESH_MINUTES = 1440;
const REQUEST_TIMEOUT_MS = 15000;

function normalizeBaseUrl(rawValue) {
  const value = String(rawValue || "").trim();

  if (!value) {
    throw new Error("请填写中转站地址");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("中转站地址格式不正确");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("中转站地址仅支持 http 或 https");
  }

  if (!parsed.hostname) {
    throw new Error("中转站地址缺少域名");
  }

  if (parsed.username || parsed.password) {
    throw new Error("中转站地址不能包含用户名或密码");
  }

  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

function buildBalanceUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}${BALANCE_ROUTE}`;
}

function clampRefreshInterval(value) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return DEFAULT_REFRESH_MINUTES;
  }

  const rounded = Math.round(numberValue);
  return Math.min(MAX_REFRESH_MINUTES, Math.max(MIN_REFRESH_MINUTES, rounded));
}

function normalizeProviderInput(input, options) {
  const isUpdate = Boolean(options && options.isUpdate);
  const name = String(input && input.name ? input.name : "").trim();
  const apiKey = String(input && input.apiKey ? input.apiKey : "").trim();

  if (!name) {
    throw new Error("请填写名称");
  }

  if (!isUpdate && !apiKey) {
    throw new Error("请填写 API Key");
  }

  return {
    name,
    baseUrl: normalizeBaseUrl(input && input.baseUrl),
    apiKey,
    refreshIntervalMinutes: clampRefreshInterval(input && input.refreshIntervalMinutes)
  };
}

function parseBalanceResponse(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("响应不是有效的 JSON 对象");
  }

  let remaining;
  let limit;
  let used;
  let resetAt = null;

  if (response.subscription && typeof response.subscription === "object") {
    limit = Number(response.subscription.daily_limit_usd);
    used = Number(response.subscription.daily_usage_usd);
    remaining = limit - used;
  } else if (Array.isArray(response.rate_limits) && response.rate_limits.length > 0) {
    const quota = response.rate_limits[0] || {};
    limit = Number(quota.limit);
    used = Number(quota.used);
    remaining = Number(quota.remaining);
    resetAt = quota.reset_at || null;
  } else {
    throw new Error("响应缺少 subscription 或 rate_limits 字段");
  }

  if (!Number.isFinite(limit)) {
    throw new Error("总额度字段不是有效数字");
  }

  if (!Number.isFinite(used)) {
    throw new Error("已使用额度字段不是有效数字");
  }

  if (!Number.isFinite(remaining)) {
    throw new Error("剩余额度字段不是有效数字");
  }

  return {
    isValid: true,
    remaining,
    unit: response.unit || DEFAULT_UNIT,
    limit,
    used,
    resetAt
  };
}

function shouldRefreshProvider(provider, nowMs) {
  if (!provider || !provider.lastCheckedAt) {
    return true;
  }

  const lastCheckedAt = Date.parse(provider.lastCheckedAt);
  if (!Number.isFinite(lastCheckedAt)) {
    return true;
  }

  const interval = clampRefreshInterval(provider.refreshIntervalMinutes);
  return lastCheckedAt + interval * 60 * 1000 <= nowMs;
}

function safeErrorMessage(error) {
  if (!error) {
    return "未知错误";
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "未知错误";
}

function normalizeBodyForJson(body) {
  return String(body || "").replace(/^\uFEFF/, "").trim();
}

function summarizeResponseBody(body, maxLength) {
  const limit = Number.isFinite(Number(maxLength)) ? Number(maxLength) : 1000;
  const text = String(body || "").trim();

  if (!text) {
    return "空响应";
  }

  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function createResponseErrorMessage(message, detail) {
  const safeDetail = detail || {};
  return [
    message,
    `URL: ${safeDetail.url || "未知"}`,
    `Status: ${safeDetail.statusCode || "未知状态"}`,
    `Content-Type: ${safeDetail.contentType || "未提供"}`,
    `Body: ${summarizeResponseBody(safeDetail.body)}`
  ].join("\n");
}

module.exports = {
  BALANCE_ROUTE,
  DEFAULT_UNIT,
  DEFAULT_REFRESH_MINUTES,
  MIN_REFRESH_MINUTES,
  MAX_REFRESH_MINUTES,
  REQUEST_TIMEOUT_MS,
  normalizeBaseUrl,
  buildBalanceUrl,
  clampRefreshInterval,
  normalizeProviderInput,
  parseBalanceResponse,
  normalizeBodyForJson,
  summarizeResponseBody,
  createResponseErrorMessage,
  shouldRefreshProvider,
  safeErrorMessage
};
