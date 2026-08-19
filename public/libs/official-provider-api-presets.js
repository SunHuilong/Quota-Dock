"use strict";

const {
  asArray,
  balanceMeter,
  firstNumber,
  firstString,
  firstValue,
  requireNumber,
  simplePreset,
  singleBalanceSnapshot,
  slug
} = require("./official-provider-helpers.js");

function parseDeepSeek(response) {
  if (response && response.is_available === false) {
    throw new Error("DeepSeek 账户当前不可用");
  }
  const balances = asArray(response && response.balance_infos);
  if (!balances.length) {
    throw new Error("DeepSeek 响应缺少余额信息");
  }
  const meters = balances.map((item, index) => {
    const unit = String(item.currency || "CNY").trim().toUpperCase() || "CNY";
    return balanceMeter(
      `balance-${slug(unit, String(index + 1))}`,
      balances.length > 1 ? `${unit} 可用余额` : "可用余额",
      requireNumber(item.total_balance, "DeepSeek 余额"),
      unit
    );
  });
  return { primaryMeterId: meters[0].id, meters };
}

function parseKimi(response, unit) {
  return singleBalanceSnapshot(response, {
    paths: ["data.available_balance", "available_balance", "data.balance", "balance"],
    unit,
    label: "可用余额"
  });
}

function parseStepFun(response) {
  return singleBalanceSnapshot(response, {
    paths: ["data.balance", "data.available_balance", "data[0].balance", "accounts[0].balance", "account.balance", "balance"],
    unit: "CNY",
    label: "可用余额"
  });
}

function parseSiliconFlow(response, unit) {
  return singleBalanceSnapshot(response, {
    paths: ["data.balance", "data.totalBalance", "data.total_balance", "balance"],
    unit,
    label: "可用余额"
  });
}

function parse302Ai(response) {
  return singleBalanceSnapshot(response, {
    paths: ["data.balance", "balance", "data.available_balance", "available_balance", "data"],
    unit: "USD",
    label: "可用余额"
  });
}

function parseNovita(response) {
  return singleBalanceSnapshot(response, {
    paths: ["data.balance", "balance", "data.available_balance", "available_balance"],
    unit: "USD",
    multiplier: 1 / 10000,
    label: "可用余额"
  });
}

function parseOpenRouterKey(response) {
  const data = response && response.data ? response.data : response;
  const limit = firstNumber(data, ["limit"], "Key 总额度");
  const used = firstNumber(data, ["usage", "usage_monthly", "usage_daily"], "Key 已用额度");
  let remaining = firstNumber(data, ["limit_remaining", "remaining"], "Key 剩余额度");
  if (remaining === null && limit !== null && used !== null) {
    remaining = limit - used;
  }
  if (remaining === null && used === null) {
    throw new Error("OpenRouter 响应缺少 Key 额度信息");
  }
  return {
    primaryMeterId: "key-quota",
    meters: [
      {
        id: "key-quota",
        label: remaining === null ? "Key 已用额度" : "Key 剩余额度",
        kind: "quota",
        remaining,
        used,
        limit,
        unit: "USD",
        resetAt: firstString(data, ["reset_at", "limit_reset"], null),
        aggregate: false
      }
    ]
  };
}

function parseAiHubMix(response) {
  const remaining = requireNumber(
    firstValue(response, ["data.quota", "quota", "data.balance", "balance"]),
    "AIHubMix 余额"
  );
  return {
    primaryMeterId: "balance",
    meters: [balanceMeter("balance", "可用余额", remaining / 500000, "USD")]
  };
}

const API_PRESETS = [
  simplePreset({
    id: "deepseek-api",
    name: "DeepSeek API",
    category: "api",
    defaultUnit: "CNY",
    url: "https://api.deepseek.com/user/balance",
    parse: parseDeepSeek
  }),
  simplePreset({
    id: "kimi-api-cn",
    name: "Kimi API（国内）",
    category: "api",
    defaultUnit: "CNY",
    url: "https://api.moonshot.cn/v1/users/me/balance",
    parse: (response) => parseKimi(response, "CNY")
  }),
  simplePreset({
    id: "kimi-api-global",
    name: "Kimi API（国际）",
    category: "api",
    defaultUnit: "USD",
    url: "https://api.moonshot.ai/v1/users/me/balance",
    parse: (response) => parseKimi(response, "USD")
  }),
  simplePreset({
    id: "stepfun-api",
    name: "阶跃星辰 StepFun API",
    category: "api",
    defaultUnit: "CNY",
    url: "https://api.stepfun.com/v1/accounts",
    parse: parseStepFun
  }),
  simplePreset({
    id: "siliconflow-cn",
    name: "硅基流动（国内）",
    category: "api",
    defaultUnit: "CNY",
    url: "https://api.siliconflow.cn/v1/user/info",
    parse: (response) => parseSiliconFlow(response, "CNY")
  }),
  simplePreset({
    id: "siliconflow-global",
    name: "SiliconFlow（国际）",
    category: "api",
    defaultUnit: "USD",
    url: "https://api.siliconflow.com/v1/user/info",
    parse: (response) => parseSiliconFlow(response, "USD")
  }),
  simplePreset({
    id: "302ai",
    name: "302.AI",
    category: "api",
    defaultUnit: "USD",
    credentialHelp: "Key 需要开启余额查询权限",
    url: "https://api.302.ai/dashboard/balance",
    parse: parse302Ai
  }),
  simplePreset({
    id: "novita-ai",
    name: "Novita AI",
    category: "api",
    defaultUnit: "USD",
    url: "https://api.novita.ai/v3/user/balance",
    parse: parseNovita
  }),
  simplePreset({
    id: "openrouter-key",
    name: "OpenRouter API Key 额度",
    category: "api",
    defaultUnit: "USD",
    url: "https://openrouter.ai/api/v1/key",
    parse: parseOpenRouterKey
  }),
  simplePreset({
    id: "aihubmix",
    name: "AIHubMix",
    category: "api",
    defaultUnit: "USD",
    url: "https://aihubmix.com/api/user/self",
    parse: parseAiHubMix
  })
];

module.exports = { API_PRESETS };
