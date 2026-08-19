"use strict";

const { meterRemainingPercent } = require("./quota-core.js");

const MCP_TOOL_NAMES = Object.freeze([
  "quota_overview",
  "quota_provider_detail",
  "quota_refresh",
  "quota_health_check",
  "quota_supported_platforms",
  "quota_floating_window",
  "quota_set_floating_visibility"
]);

const MCP_ERROR_CODES = Object.freeze([
  "missing_credential",
  "preset_unavailable",
  "refresh_failed",
  "not_checked",
  "stale",
  "low_remaining"
]);

const DEFAULT_REMAINING_PERCENT_BELOW = 20;
const DEFAULT_STALE_AFTER_MINUTES = 60;
const DEFAULT_REFRESH_CONCURRENCY = 3;

const SAFE_ERROR_MESSAGES = Object.freeze({
  missing_credential: "站点未配置查询凭证",
  preset_unavailable: "站点使用的官方预设当前不可用",
  refresh_failed: "站点额度刷新失败",
  not_checked: "站点尚未完成额度查询",
  stale: "站点额度数据已过期",
  low_remaining: "额度剩余比例低于阈值"
});

function finiteNumberOrNull(value) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
}

function isoDateOrNull(value) {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeNowMs(value) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function normalizeUnit(value) {
  return String(value || "USD").trim().toUpperCase() || "USD";
}

function safeError(code) {
  const normalizedCode = MCP_ERROR_CODES.includes(code) ? code : "refresh_failed";
  return {
    code: normalizedCode,
    message: SAFE_ERROR_MESSAGES[normalizedCode]
  };
}

function projectMeter(meter) {
  const source = meter && typeof meter === "object" ? meter : {};
  const kind = source.kind === "quota" || source.kind === "spend" ? source.kind : "balance";

  return {
    id: String(source.id || "meter").trim() || "meter",
    label: String(source.label || "可用额度").trim() || "可用额度",
    kind,
    remaining: finiteNumberOrNull(source.remaining),
    used: finiteNumberOrNull(source.used),
    limit: finiteNumberOrNull(source.limit),
    unit: normalizeUnit(source.unit),
    resetAt: isoDateOrNull(source.resetAt),
    remainingPercent: meterRemainingPercent(source),
    aggregate: Boolean(source.aggregate)
  };
}

function providerMeters(provider) {
  const source = provider && typeof provider === "object" ? provider : {};
  return source.snapshot && Array.isArray(source.snapshot.meters)
    ? source.snapshot.meters.map(projectMeter)
    : [];
}

function primaryMeter(provider, meters) {
  if (!meters.length) {
    return null;
  }

  const primaryId = String(
    (provider && provider.snapshot && provider.snapshot.primaryMeterId) || ""
  ).trim();
  return meters.find((meter) => meter.id === primaryId) || meters[0];
}

function providerIssueCode(provider) {
  const source = provider && typeof provider === "object" ? provider : {};

  return {
    unavailable: "preset_unavailable",
    unconfigured: "missing_credential",
    error: "refresh_failed",
    pending: "not_checked",
    ok: null
  }[source.status] ?? "not_checked";
}

function providerStatus(provider) {
  const status = provider && provider.status;
  return status === "ok" ||
    status === "error" ||
    status === "unconfigured" ||
    status === "unavailable" ||
    status === "pending"
    ? status
    : "pending";
}

function isProviderStale(provider, staleAfterMinutes, nowMs) {
  const checkedAt = isoDateOrNull(provider && provider.lastCheckedAt);
  if (!checkedAt) {
    return true;
  }

  return Date.parse(checkedAt) + staleAfterMinutes * 60 * 1000 < normalizeNowMs(nowMs);
}

function normalizeStaleAfterMinutes(value) {
  const number = value === undefined ? DEFAULT_STALE_AFTER_MINUTES : Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 525600) {
    throw new TypeError("staleAfterMinutes 必须是 0 到 525600 之间的正数");
  }
  return number;
}

function normalizeRemainingThreshold(value) {
  const number = value === undefined ? DEFAULT_REMAINING_PERCENT_BELOW : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new TypeError("remainingPercentBelow 必须是 0 到 100 之间的数字");
  }
  return number;
}

function normalizeHealthThresholds(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    remainingPercentBelow: normalizeRemainingThreshold(source.remainingPercentBelow),
    staleAfterMinutes: normalizeStaleAfterMinutes(source.staleAfterMinutes)
  };
}

function projectProviderSummary(provider, options) {
  const source = provider && typeof provider === "object" ? provider : {};
  const settings = options || {};
  const staleAfterMinutes = normalizeStaleAfterMinutes(settings.staleAfterMinutes);
  const meters = providerMeters(source);
  const issueCode = providerIssueCode(source);
  const mode = source.mode === "official" ? "official" : "relay";

  return {
    id: String(source.id || "").trim(),
    name: String(source.name || "未命名站点").trim() || "未命名站点",
    mode,
    officialPresetId: mode === "official" ? String(source.officialPresetId || "").trim() || null : null,
    officialPresetName: mode === "official" ? String(source.officialPresetName || "").trim() || null : null,
    credentialConfigured: Boolean(source.hasApiKey),
    status: providerStatus(source),
    checkedAt: isoDateOrNull(source.lastCheckedAt),
    stale: isProviderStale(source, staleAfterMinutes, settings.nowMs),
    floatingVisible: source.showInFloatingWindow !== false,
    primaryMeter: primaryMeter(source, meters),
    error: issueCode ? safeError(issueCode) : null
  };
}

function projectProviderDetail(provider, options) {
  const summary = projectProviderSummary(provider, options);
  return {
    ...summary,
    meters: providerMeters(provider)
  };
}

function sumBalancesByUnit(providers) {
  const totals = new Map();

  for (const provider of Array.isArray(providers) ? providers : []) {
    for (const meter of providerMeters(provider)) {
      if (meter.kind !== "balance" || !meter.aggregate || meter.remaining === null) {
        continue;
      }
      totals.set(meter.unit, (totals.get(meter.unit) || 0) + meter.remaining);
    }
  }

  return [...totals.entries()]
    .map(([unit, total]) => ({ unit, total }))
    .sort((left, right) => left.unit.localeCompare(right.unit));
}

function createStatusCounts(projectedProviders) {
  const counts = {
    ok: 0,
    error: 0,
    unconfigured: 0,
    unavailable: 0,
    pending: 0
  };

  for (const provider of projectedProviders) {
    if (Object.hasOwn(counts, provider.status)) {
      counts[provider.status] += 1;
    }
  }

  return counts;
}

function createOverview(providers, options) {
  const settings = options || {};
  const generatedAt = new Date(normalizeNowMs(settings.nowMs)).toISOString();
  const sourceProviders = Array.isArray(providers) ? providers : [];
  const projectedProviders = sourceProviders.map((provider) =>
    projectProviderSummary(provider, {
      nowMs: settings.nowMs,
      staleAfterMinutes: settings.staleAfterMinutes
    })
  );

  return {
    generatedAt,
    providerCount: projectedProviders.length,
    configuredCount: projectedProviders.filter((provider) => provider.credentialConfigured).length,
    statusCounts: createStatusCounts(projectedProviders),
    totalsByUnit: sumBalancesByUnit(sourceProviders),
    providers: projectedProviders
  };
}

function createHealthIssue(provider, code, details) {
  const extra = details || {};
  return {
    providerId: String(provider.id || "").trim(),
    providerName: String(provider.name || "未命名站点").trim() || "未命名站点",
    code,
    severity:
      code === "missing_credential" || code === "preset_unavailable" || code === "refresh_failed"
        ? "error"
        : "warning",
    message: SAFE_ERROR_MESSAGES[code],
    meterId: extra.meterId || null,
    meterLabel: extra.meterLabel || null,
    remainingPercent: finiteNumberOrNull(extra.remainingPercent)
  };
}

function createHealthReport(providers, input, options) {
  const thresholds = normalizeHealthThresholds(input);
  const settings = options || {};
  const nowMs = normalizeNowMs(settings.nowMs);
  const sourceProviders = Array.isArray(providers) ? providers : [];
  const issues = [];

  for (const provider of sourceProviders) {
    const issueCode = providerIssueCode(provider);
    if (issueCode) {
      issues.push(createHealthIssue(provider, issueCode));
    }

    const checkedAt = isoDateOrNull(provider && provider.lastCheckedAt);
    if (checkedAt && isProviderStale(provider, thresholds.staleAfterMinutes, nowMs)) {
      issues.push(createHealthIssue(provider, "stale"));
    }

    for (const meter of providerMeters(provider)) {
      if (meter.remainingPercent === null || meter.remainingPercent >= thresholds.remainingPercentBelow) {
        continue;
      }
      issues.push(
        createHealthIssue(provider, "low_remaining", {
          meterId: meter.id,
          meterLabel: meter.label,
          remainingPercent: meter.remainingPercent
        })
      );
    }
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    thresholds,
    healthy: issues.length === 0,
    issueCount: issues.length,
    issues,
    providers: sourceProviders.map((provider) =>
      projectProviderSummary(provider, {
        nowMs,
        staleAfterMinutes: thresholds.staleAfterMinutes
      })
    )
  };
}

async function runBoundedTasks(items, worker, options) {
  if (!Array.isArray(items)) {
    throw new TypeError("items 必须是数组");
  }
  if (typeof worker !== "function") {
    throw new TypeError("worker 必须是函数");
  }

  const settings = options || {};
  const requestedConcurrency = Number(settings.concurrency ?? DEFAULT_REFRESH_CONCURRENCY);
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency <= 0) {
    throw new TypeError("concurrency 必须是正整数");
  }

  const concurrency = Math.min(DEFAULT_REFRESH_CONCURRENCY, requestedConcurrency);
  const results = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;

  async function runNext() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      const item = items[index];
      let result;
      try {
        result = {
          index,
          item,
          fulfilled: true,
          value: await worker(item, index),
          error: null
        };
      } catch (error) {
        result = {
          index,
          item,
          fulfilled: false,
          value: null,
          error
        };
      }
      results[index] = result;
      completed += 1;

      if (typeof settings.onProgress === "function") {
        try {
          await settings.onProgress({
            progress: completed,
            total: items.length,
            item,
            result
          });
        } catch {
          // Progress reporting is best-effort and must not change refresh results.
        }
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
  return results;
}

function createRefreshOutcome(taskResult, options) {
  const settings = options || {};
  const item = taskResult && taskResult.item && typeof taskResult.item === "object" ? taskResult.item : {};
  const provider = taskResult && taskResult.fulfilled ? taskResult.value : null;
  const providerId = String((provider && provider.id) || item.id || item.providerId || "").trim();
  const providerName = String((provider && provider.name) || item.name || "未命名站点").trim() || "未命名站点";

  if (!taskResult || !taskResult.fulfilled || !provider) {
    return {
      providerId,
      providerName,
      success: false,
      status: "error",
      checkedAt: null,
      error: safeError("refresh_failed")
    };
  }

  const projection = projectProviderSummary(provider, settings);
  return {
    providerId: projection.id,
    providerName: projection.name,
    success: projection.error === null,
    status: projection.status,
    checkedAt: projection.checkedAt,
    error: projection.error
  };
}

function createRefreshBatch(scope, taskResults, options) {
  const normalizedScope = scope === "due" || scope === "selected" ? scope : "all";
  const results = (Array.isArray(taskResults) ? taskResults : []).map((result) =>
    createRefreshOutcome(result, options)
  );

  return {
    scope: normalizedScope,
    requestedCount: results.length,
    successCount: results.filter((result) => result.success).length,
    failureCount: results.filter((result) => !result.success).length,
    results
  };
}

module.exports = {
  MCP_TOOL_NAMES,
  DEFAULT_REMAINING_PERCENT_BELOW,
  DEFAULT_STALE_AFTER_MINUTES,
  DEFAULT_REFRESH_CONCURRENCY,
  normalizeHealthThresholds,
  projectProviderSummary,
  projectProviderDetail,
  createOverview,
  createHealthReport,
  runBoundedTasks,
  createRefreshOutcome,
  createRefreshBatch
};
