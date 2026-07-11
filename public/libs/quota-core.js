"use strict";

const BALANCE_ROUTE = "/v1/usage";
const DEFAULT_UNIT = "USD";
const DEFAULT_REFRESH_MINUTES = 30;
const MIN_REFRESH_MINUTES = 1;
const MAX_REFRESH_MINUTES = 1440;
const REQUEST_TIMEOUT_MS = 15000;
const TEMPLATE_OPENAI_USAGE = "openai-usage";
const TEMPLATE_RATE_LIMITS = "rate-limits";
const TEMPLATE_CUSTOM = "custom";
const DEFAULT_TEMPLATE_ID = TEMPLATE_OPENAI_USAGE;
const REQUEST_METHOD_GET = "GET";
const REQUEST_METHOD_POST = "POST";
const AUTH_PLACEMENT_HEADER = "header";
const AUTH_PLACEMENT_BODY = "body";
const DEFAULT_JSON_PATHS = {
  balance: "",
  used: "",
  limit: "",
  resetAt: "",
  unit: ""
};

function normalizeBaseUrl(rawValue) {
  const value = String(rawValue || "").trim();

  if (!value) {
    throw new Error("请填写站点地址");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("站点地址格式不正确");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("站点地址仅支持 http 或 https");
  }

  if (!parsed.hostname) {
    throw new Error("站点地址缺少域名");
  }

  if (parsed.username || parsed.password) {
    throw new Error("站点地址不能包含用户名或密码");
  }

  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

function buildBalanceUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}${BALANCE_ROUTE}`;
}

function normalizeRequestMethod(value) {
  const method = String(value || REQUEST_METHOD_GET)
    .trim()
    .toUpperCase();

  if (method !== REQUEST_METHOD_GET && method !== REQUEST_METHOD_POST) {
    throw new Error("请求方式仅支持 GET 或 POST");
  }

  return method;
}

function normalizeAuthPlacement(value) {
  const placement = String(value || AUTH_PLACEMENT_HEADER)
    .trim()
    .toLowerCase();

  if (placement !== AUTH_PLACEMENT_HEADER && placement !== AUTH_PLACEMENT_BODY) {
    throw new Error("鉴权位置仅支持 Header 或 Body");
  }

  return placement;
}

function normalizeRequestPath(rawValue) {
  const value = String(rawValue || "").trim();

  if (!value) {
    throw new Error("请填写请求 Path");
  }

  if (/^https?:\/\//i.test(value) || value.startsWith("//")) {
    throw new Error("请求 Path 只填写路径，不要填写完整 URL");
  }

  return value.startsWith("/") ? value : `/${value}`;
}

function buildAdvancedUrl(baseUrl, requestPath) {
  return `${normalizeBaseUrl(baseUrl)}${normalizeRequestPath(requestPath)}`;
}

function clampRefreshInterval(value) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return DEFAULT_REFRESH_MINUTES;
  }

  const rounded = Math.round(numberValue);
  return Math.min(MAX_REFRESH_MINUTES, Math.max(MIN_REFRESH_MINUTES, rounded));
}

function normalizeManualLimit(value) {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return null;
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error("备用总额度必须是大于 0 的数字");
  }

  return numberValue;
}

function normalizeDefaultUnit(value) {
  return String(value || DEFAULT_UNIT).trim() || DEFAULT_UNIT;
}

function defaultAdvancedHeaders(authPlacement) {
  const placement = normalizeAuthPlacement(authPlacement);
  const headers = {
    Accept: "application/json"
  };

  if (placement === AUTH_PLACEMENT_HEADER) {
    headers.Authorization = "Bearer {{token}}";
  } else {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

function getDefaultAdvancedHeadersText(authPlacement) {
  return JSON.stringify(defaultAdvancedHeaders(authPlacement), null, 2);
}

function getDefaultAdvancedBodyText(authPlacement) {
  return normalizeAuthPlacement(authPlacement) === AUTH_PLACEMENT_BODY
    ? JSON.stringify({ token: "{{token}}" }, null, 2)
    : "";
}

function createTemplate(template) {
  return {
    ...template,
    jsonPaths: normalizeJsonPaths(template.jsonPaths)
  };
}

function getProviderTemplates() {
  return [
    createTemplate({
      id: TEMPLATE_OPENAI_USAGE,
      name: "Sub2API - 订阅",
      requestPath: BALANCE_ROUTE,
      requestMethod: REQUEST_METHOD_GET,
      authPlacement: AUTH_PLACEMENT_HEADER,
      requestHeaders: getDefaultAdvancedHeadersText(AUTH_PLACEMENT_HEADER),
      requestBody: "",
      jsonPaths: {
        used: "subscription.daily_usage_usd",
        limit: "subscription.daily_limit_usd"
      }
    }),
    createTemplate({
      id: TEMPLATE_RATE_LIMITS,
      name: "Sub2API - 刷新限额",
      requestPath: BALANCE_ROUTE,
      requestMethod: REQUEST_METHOD_GET,
      authPlacement: AUTH_PLACEMENT_HEADER,
      requestHeaders: getDefaultAdvancedHeadersText(AUTH_PLACEMENT_HEADER),
      requestBody: "",
      jsonPaths: {
        balance: "rate_limits[0].remaining",
        used: "rate_limits[0].used",
        limit: "rate_limits[0].limit",
        resetAt: "rate_limits[0].reset_at"
      }
    }),
    createTemplate({
      id: TEMPLATE_CUSTOM,
      name: "专业",
      requestPath: BALANCE_ROUTE,
      requestMethod: REQUEST_METHOD_GET,
      authPlacement: AUTH_PLACEMENT_HEADER,
      requestHeaders: getDefaultAdvancedHeadersText(AUTH_PLACEMENT_HEADER),
      requestBody: "",
      jsonPaths: DEFAULT_JSON_PATHS
    })
  ];
}

function normalizeTemplateId(value, legacyMode) {
  const templateId = String(value || "").trim();

  if (templateId === TEMPLATE_OPENAI_USAGE || templateId === TEMPLATE_RATE_LIMITS || templateId === TEMPLATE_CUSTOM) {
    return templateId;
  }

  return legacyMode === "advanced" ? TEMPLATE_CUSTOM : DEFAULT_TEMPLATE_ID;
}

function getProviderTemplate(templateId) {
  const normalizedTemplateId = normalizeTemplateId(templateId);
  return getProviderTemplates().find((template) => template.id === normalizedTemplateId) || getProviderTemplates()[0];
}

function normalizeBodyForJson(body) {
  return String(body || "").replace(/^\uFEFF/, "").trim();
}

function parseJsonText(rawValue, label) {
  try {
    return JSON.parse(normalizeBodyForJson(rawValue));
  } catch {
    throw new Error(`${label} 不是有效的 JSON`);
  }
}

function parseJsonObjectText(rawValue, fallbackObject, label) {
  const text = String(rawValue || "").trim();
  const parsed = text ? parseJsonText(text, label) : fallbackObject;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }

  return parsed;
}

function normalizeJsonTemplateText(rawValue, fallbackText, label, options) {
  const text = String(rawValue || "").trim() || fallbackText || "";

  if (!text) {
    return "";
  }

  const parsed = parseJsonText(text, label);
  if (options && options.requireObject && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }

  return text;
}

function normalizeJsonPaths(jsonPaths) {
  const source = jsonPaths && typeof jsonPaths === "object" && !Array.isArray(jsonPaths) ? jsonPaths : {};

  return {
    balance: String(source.balance || "").trim(),
    used: String(source.used || "").trim(),
    limit: String(source.limit || "").trim(),
    resetAt: String(source.resetAt || "").trim(),
    unit: String(source.unit || "").trim()
  };
}

function normalizeProviderInput(input, options) {
  const isUpdate = Boolean(options && options.isUpdate);
  const requireJsonPaths = !options || options.requireJsonPaths !== false;
  const name = String(input && input.name ? input.name : "").trim();
  const apiKey = String(input && input.apiKey ? input.apiKey : "").trim();
  const templateId = normalizeTemplateId(input && input.templateId, input && input.mode);
  const template = getProviderTemplate(templateId);
  const requestMethod = normalizeRequestMethod((input && input.requestMethod) || template.requestMethod);
  const authPlacement = normalizeAuthPlacement((input && input.authPlacement) || template.authPlacement);
  const requestPath = normalizeRequestPath((input && input.requestPath) || template.requestPath);
  const requestHeaders = normalizeJsonTemplateText(
    input && input.requestHeaders,
    template.requestHeaders || getDefaultAdvancedHeadersText(authPlacement),
    "Headers",
    { requireObject: true }
  );
  const requestBody = normalizeJsonTemplateText(
    input && input.requestBody,
    requestMethod === REQUEST_METHOD_POST ? template.requestBody || getDefaultAdvancedBodyText(authPlacement) : "",
    "Body"
  );
  const jsonPaths = normalizeJsonPaths({
    ...template.jsonPaths,
    ...((input && input.jsonPaths) || {})
  });
  const manualLimit = normalizeManualLimit(input && input.manualLimit);
  const defaultUnit = normalizeDefaultUnit(input && input.defaultUnit);

  if (manualLimit !== null) {
    jsonPaths.limit = "";
  }

  if (!name) {
    throw new Error("请填写名称");
  }

  if (!isUpdate && !apiKey) {
    throw new Error("请填写 API Key");
  }

  if (authPlacement === AUTH_PLACEMENT_BODY && requestMethod !== REQUEST_METHOD_POST) {
    throw new Error("Token 放在 Body 时请求方式必须是 POST");
  }

  if (requireJsonPaths && !jsonPaths.balance && ((!jsonPaths.limit && manualLimit === null) || !jsonPaths.used)) {
    throw new Error("请设置余额字段路径，或同时设置已用余额路径与总额度路径/备用总额度");
  }

  return {
    name,
    baseUrl: normalizeBaseUrl(input && input.baseUrl),
    apiKey,
    refreshIntervalMinutes: clampRefreshInterval(input && input.refreshIntervalMinutes),
    templateId,
    requestPath,
    requestMethod,
    authPlacement,
    requestHeaders,
    requestBody,
    jsonPaths,
    manualLimit,
    defaultUnit
  };
}

function findBracketEnd(path, startIndex) {
  let quote = "";
  let escaped = false;

  for (let index = startIndex; index < path.length; index += 1) {
    const character = path[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = "";
      }
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }

    if (character === "]") {
      return index;
    }
  }

  return -1;
}

function parseBracketPathSegment(rawSegment) {
  const segment = rawSegment.trim();

  if (!segment) {
    throw new Error("JSON 路径包含空片段");
  }

  if (/^(0|[1-9]\d*)$/.test(segment)) {
    return Number(segment);
  }

  if (segment.startsWith("\"") && segment.endsWith("\"")) {
    try {
      return JSON.parse(segment);
    } catch {
      throw new Error("JSON 路径字符串片段格式不正确");
    }
  }

  if (segment.startsWith("'") && segment.endsWith("'")) {
    return segment.slice(1, -1).replace(/\\'/g, "'");
  }

  return segment;
}

function parseJsonPath(path) {
  let text = String(path || "").trim();
  const segments = [];
  let index = 0;

  if (!text || text === "$") {
    return segments;
  }

  if (text.startsWith("$.")) {
    text = text.slice(2);
  } else if (text.startsWith("$")) {
    text = text.slice(1);
  }

  while (index < text.length) {
    const character = text[index];

    if (character === ".") {
      index += 1;
      continue;
    }

    if (character === "[") {
      const endIndex = findBracketEnd(text, index + 1);
      if (endIndex === -1) {
        throw new Error("JSON 路径缺少 ]");
      }

      segments.push(parseBracketPathSegment(text.slice(index + 1, endIndex)));
      index = endIndex + 1;
      continue;
    }

    const startIndex = index;
    while (index < text.length && text[index] !== "." && text[index] !== "[") {
      index += 1;
    }

    const segment = text.slice(startIndex, index);
    if (!segment) {
      throw new Error("JSON 路径包含空片段");
    }
    segments.push(segment);
  }

  return segments;
}

function getJsonPathValue(source, path) {
  const segments = parseJsonPath(path);
  let current = source;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[segment];
      continue;
    }

    if (typeof current !== "object") {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function readJsonPathValue(response, path, label) {
  if (!path) {
    return undefined;
  }

  const value = getJsonPathValue(response, path);
  if (value === undefined) {
    throw new Error(`${label}路径未找到`);
  }

  return value;
}

function toFiniteNumber(value, label) {
  if (typeof value === "string" && !value.trim()) {
    throw new Error(`${label}不是有效数字`);
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new Error(`${label}不是有效数字`);
  }

  return numberValue;
}

function optionalNumberFromPath(response, path, label) {
  const value = readJsonPathValue(response, path, label);
  return value === undefined || value === null ? null : toFiniteNumber(value, label);
}

function optionalStringFromPath(response, path, label) {
  const value = readJsonPathValue(response, path, label);
  return value === undefined || value === null || value === "" ? null : String(value);
}

function parseProviderBalanceResponse(response, jsonPaths, manualLimitValue, defaultUnitValue) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("响应不是有效的 JSON 对象");
  }

  const paths = normalizeJsonPaths(jsonPaths);
  const manualLimit = normalizeManualLimit(manualLimitValue);
  const limit = manualLimit ?? optionalNumberFromPath(response, paths.limit, "总额度字段");
  let used = optionalNumberFromPath(response, paths.used, "已用余额字段");
  let remaining;

  if (paths.balance) {
    remaining = toFiniteNumber(readJsonPathValue(response, paths.balance, "余额字段"), "余额字段");
  } else if (limit !== null && used !== null) {
    remaining = limit - used;
  } else {
    throw new Error("请设置余额字段路径，或同时设置总额度和已用余额路径");
  }

  if (used === null && limit !== null) {
    used = limit - remaining;
  }

  return {
    isValid: true,
    remaining,
    unit: optionalStringFromPath(response, paths.unit, "单位字段") || normalizeDefaultUnit(defaultUnitValue),
    limit,
    used,
    resetAt: optionalStringFromPath(response, paths.resetAt, "重置时间字段")
  };
}

function replaceTokenTemplates(value, apiKey) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*token\s*\}\}/g, apiKey);
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceTokenTemplates(item, apiKey));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceTokenTemplates(item, apiKey)])
    );
  }

  return value;
}

function hasHeader(headers, name) {
  const normalizedName = String(name).toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName);
}

function buildProviderRequestConfig(provider, apiKey) {
  const authPlacement = normalizeAuthPlacement(provider && provider.authPlacement);
  const method = normalizeRequestMethod(provider && provider.requestMethod);
  const headers = replaceTokenTemplates(
    parseJsonObjectText(provider && provider.requestHeaders, defaultAdvancedHeaders(authPlacement), "Headers"),
    apiKey
  );
  let body = null;

  if (!hasHeader(headers, "User-Agent")) {
    headers["User-Agent"] = "cc-switch/1.0";
  }

  if (!hasHeader(headers, "Accept")) {
    headers.Accept = "application/json";
  }

  if (method === REQUEST_METHOD_POST) {
    const bodyText = String(provider && provider.requestBody ? provider.requestBody : getDefaultAdvancedBodyText(authPlacement)).trim();

    if (bodyText) {
      const parsedBody = replaceTokenTemplates(parseJsonText(bodyText, "Body"), apiKey);
      body = JSON.stringify(parsedBody);

      if (!hasHeader(headers, "Content-Type")) {
        headers["Content-Type"] = "application/json";
      }
    }
  }

  return {
    url: buildAdvancedUrl(provider && provider.baseUrl, provider && provider.requestPath),
    method,
    headers,
    body
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
  TEMPLATE_OPENAI_USAGE,
  TEMPLATE_RATE_LIMITS,
  TEMPLATE_CUSTOM,
  DEFAULT_TEMPLATE_ID,
  REQUEST_METHOD_GET,
  REQUEST_METHOD_POST,
  AUTH_PLACEMENT_HEADER,
  AUTH_PLACEMENT_BODY,
  DEFAULT_JSON_PATHS,
  getProviderTemplates,
  getProviderTemplate,
  normalizeTemplateId,
  normalizeBaseUrl,
  buildBalanceUrl,
  normalizeRequestMethod,
  normalizeAuthPlacement,
  normalizeRequestPath,
  buildAdvancedUrl,
  clampRefreshInterval,
  getDefaultAdvancedHeadersText,
  getDefaultAdvancedBodyText,
  normalizeJsonPaths,
  normalizeProviderInput,
  parseJsonPath,
  getJsonPathValue,
  parseProviderBalanceResponse,
  buildProviderRequestConfig,
  normalizeBodyForJson,
  summarizeResponseBody,
  createResponseErrorMessage,
  shouldRefreshProvider,
  safeErrorMessage
};
