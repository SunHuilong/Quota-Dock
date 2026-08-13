import type { QuotaMeter, QuotaProvider } from "./types";

export function primaryMeter(provider: QuotaProvider): QuotaMeter | null {
  if (provider.lastMeters.length) {
    return (
      provider.lastMeters.find((meter) => meter.id === provider.lastPrimaryMeterId) ||
      provider.lastMeters[0]
    );
  }

  if (provider.lastBalance === null && provider.lastUsed === null && provider.lastLimit === null) {
    return null;
  }

  return {
    id: "balance",
    label: "可用额度",
    kind: "balance",
    remaining: provider.lastBalance,
    used: provider.lastUsed,
    limit: provider.lastLimit,
    unit: provider.lastUnit || provider.defaultUnit || "USD",
    resetAt: provider.lastResetAt,
    aggregate: true
  };
}

export function meterDisplayValue(meter: QuotaMeter | null): number | null {
  if (!meter) {
    return null;
  }
  return meter.remaining ?? meter.used;
}

export function formatMeterValue(meter: QuotaMeter | null): string {
  return formatQuotaValue(meterDisplayValue(meter));
}

export function formatBalance(provider: QuotaProvider): string {
  return formatMeterValue(primaryMeter(provider));
}

export function formatDateTime(value: string | null): string {
  if (!value) {
    return "未查询";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "时间异常";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatTime(value: string | null): string {
  if (!value) {
    return "未查询";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "时间异常";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatQuotaValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(value);
}

export function meterProgress(meter: QuotaMeter | null): number | null {
  if (!meter || meter.limit === null || meter.limit <= 0) {
    return null;
  }

  const used = meter.used ?? (meter.remaining === null ? null : Math.max(0, meter.limit - meter.remaining));
  if (used === null) {
    return null;
  }

  return Math.max(0, Math.min(100, (used / meter.limit) * 100));
}

export function meterRemainingPercent(meter: QuotaMeter | null): number | null {
  const usedPercent = meterProgress(meter);
  return usedPercent === null ? null : 100 - usedPercent;
}

export function quotaProgress(provider: QuotaProvider): number | null {
  return meterProgress(primaryMeter(provider));
}

export function quotaRemainingPercent(provider: QuotaProvider): number | null {
  return meterRemainingPercent(primaryMeter(provider));
}

export function formatDomain(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.host + url.pathname.replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

export function providerStatus(provider: QuotaProvider): { text: string; tone: "ok" | "warn" | "error" | "idle" } {
  if (provider.mode === "official" && !provider.officialPresetAvailable) {
    return { text: "预设不可用", tone: "error" };
  }

  if (provider.lastError) {
    return { text: "异常", tone: "error" };
  }

  if (provider.lastIsValid === false) {
    return { text: "停用", tone: "warn" };
  }

  if (provider.lastCheckedAt) {
    return { text: "可用", tone: "ok" };
  }

  return { text: "待查询", tone: "idle" };
}

export interface BalanceTotal {
  unit: string;
  total: number;
}

export function sumBalancesByUnit(providers: QuotaProvider[]): BalanceTotal[] {
  const totals = new Map<string, number>();

  for (const provider of providers) {
    for (const meter of provider.lastMeters) {
      if (meter.kind !== "balance" || !meter.aggregate || meter.remaining === null) {
        continue;
      }
      const unit = String(meter.unit || "USD").trim().toUpperCase() || "USD";
      totals.set(unit, (totals.get(unit) || 0) + meter.remaining);
    }
  }

  return [...totals.entries()]
    .map(([unit, total]) => ({ unit, total }))
    .sort((a, b) => a.unit.localeCompare(b.unit));
}

export function sumBalance(providers: QuotaProvider[]): number {
  return sumBalancesByUnit(providers).reduce((sum, item) => sum + item.total, 0);
}
