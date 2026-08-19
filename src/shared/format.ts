import type { QuotaMeter, QuotaProvider } from "./types";

export function primaryMeter(provider: QuotaProvider): QuotaMeter | null {
  if (!provider.snapshot?.meters.length) {
    return null;
  }
  return (
    provider.snapshot.meters.find((meter) => meter.id === provider.snapshot?.primaryMeterId) ||
    provider.snapshot.meters[0]
  );
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
  return meter?.remainingPercent === null || meter?.remainingPercent === undefined
    ? null
    : 100 - meter.remainingPercent;
}

export function meterRemainingPercent(meter: QuotaMeter | null): number | null {
  return meter?.remainingPercent ?? null;
}

export function quotaProgress(provider: QuotaProvider): number | null {
  return meterProgress(primaryMeter(provider));
}

export function quotaRemainingPercent(provider: QuotaProvider): number | null {
  return meterRemainingPercent(primaryMeter(provider));
}

export function providerStatus(provider: QuotaProvider): { text: string; tone: "ok" | "warn" | "error" | "idle" } {
  return ({
    ok: { text: "可用", tone: "ok" },
    error: { text: "异常", tone: "error" },
    unconfigured: { text: "未配置", tone: "warn" },
    unavailable: { text: "预设不可用", tone: "error" },
    pending: { text: "待查询", tone: "idle" }
  } as const)[provider.status];
}

export interface BalanceTotal {
  unit: string;
  total: number;
}

export function sumBalancesByUnit(providers: QuotaProvider[]): BalanceTotal[] {
  const totals = new Map<string, number>();

  for (const provider of providers) {
    for (const meter of provider.snapshot?.meters || []) {
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
