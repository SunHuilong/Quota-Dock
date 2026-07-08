import type { QuotaProvider } from "./types";

export function formatBalance(provider: QuotaProvider): string {
  if (provider.lastBalance === null || provider.lastBalance === undefined) {
    return "--";
  }

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(provider.lastBalance);
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
    maximumFractionDigits: 4
  }).format(value);
}

export function quotaProgress(provider: QuotaProvider): number | null {
  if (
    provider.lastLimit === null ||
    provider.lastLimit === undefined ||
    provider.lastUsed === null ||
    provider.lastUsed === undefined ||
    provider.lastLimit <= 0
  ) {
    return null;
  }

  return Math.max(0, Math.min(100, (provider.lastUsed / provider.lastLimit) * 100));
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

export function sumBalance(providers: QuotaProvider[]): number {
  return providers.reduce((sum, provider) => {
    if (provider.lastBalance === null || provider.lastBalance === undefined || provider.lastError) {
      return sum;
    }

    return sum + provider.lastBalance;
  }, 0);
}
