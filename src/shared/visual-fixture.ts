import type {
  OfficialProviderPresetSummary,
  ProviderInput,
  QuotaBridge,
  QuotaMeter,
  QuotaProvider,
  QuotaSnapshot
} from "./types";
import "../styles/visual-fixture.css";

type VisualFixtureScenario = "default" | "empty" | "error" | "loading" | "one" | "two";

interface VisualFixtureMessage {
  type: "providers";
  providers: QuotaProvider[];
}

const CHECKED_AT = "2026-08-14T09:26:00.000Z";
const RESET_AT = "2026-08-15T00:00:00.000Z";

const PRESETS: OfficialProviderPresetSummary[] = [
  {
    id: "deepseek-api",
    name: "DeepSeek API",
    category: "api",
    categoryLabel: "官方 API",
    credentialLabel: "API Key",
    credentialPlaceholder: "sk-...",
    credentialHelp: "使用 DeepSeek 平台创建的 API Key。",
    defaultUnit: "CNY",
    supportsManualLimit: true,
    supportsCurrencyOverride: true
  },
  {
    id: "openrouter-credits",
    name: "OpenRouter Credits",
    category: "api",
    categoryLabel: "官方 API",
    credentialLabel: "API Key",
    credentialPlaceholder: "sk-or-...",
    credentialHelp: "使用 OpenRouter 账户的 API Key。",
    defaultUnit: "USD",
    supportsManualLimit: false,
    supportsCurrencyOverride: false
  },
  {
    id: "glm-coding-plan-cn",
    name: "智谱 GLM Coding Plan",
    category: "plan",
    categoryLabel: "Coding Plan",
    credentialLabel: "Token",
    credentialPlaceholder: "填写访问 Token",
    credentialHelp: "使用 Coding Plan 控制台中的访问凭据。",
    defaultUnit: "Tokens",
    supportsManualLimit: false,
    supportsCurrencyOverride: false
  },
  {
    id: "openai-organization",
    name: "OpenAI Organization",
    category: "admin",
    categoryLabel: "组织管理",
    credentialLabel: "Admin API Key",
    credentialPlaceholder: "sk-admin-...",
    credentialHelp: "需要组织管理员权限。",
    defaultUnit: "USD",
    supportsManualLimit: true,
    supportsCurrencyOverride: false
  }
];

function meter(
  id: string,
  label: string,
  remaining: number | null,
  used: number | null,
  limit: number | null,
  unit: string,
  kind: QuotaMeter["kind"] = "quota",
  aggregate = false
): QuotaMeter {
  return { id, label, remaining, used, limit, unit, kind, aggregate, resetAt: limit === null ? null : RESET_AT };
}

function provider(overrides: Partial<QuotaProvider> & Pick<QuotaProvider, "id" | "name">): QuotaProvider {
  const base: QuotaProvider = {
    id: overrides.id,
    mode: "official",
    name: overrides.name,
    officialPresetId: "deepseek-api",
    officialPresetName: "DeepSeek API",
    officialPresetAvailable: true,
    baseUrl: "",
    templateId: "openai-usage",
    requestPath: "",
    requestMethod: "GET",
    authPlacement: "header",
    requestHeaders: "",
    requestBody: "",
    jsonPaths: { balance: "", used: "", limit: "", resetAt: "", unit: "" },
    manualLimit: null,
    currencyOverride: "",
    defaultUnit: "USD",
    priceMultiplier: 1,
    refreshIntervalMinutes: 30,
    showInFloatingWindow: true,
    lastPrimaryMeterId: "primary",
    lastMeters: [meter("primary", "可用额度", 88.5, 31.5, 120, "CNY", "balance", true)],
    lastBalance: 88.5,
    lastLimit: 120,
    lastUsed: 31.5,
    lastResetAt: RESET_AT,
    lastUnit: "CNY",
    lastIsValid: true,
    lastCheckedAt: CHECKED_AT,
    lastError: "",
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: CHECKED_AT,
    hasApiKey: true
  };

  return { ...base, ...overrides };
}

function createProviders(): QuotaProvider[] {
  return [
    provider({
      id: "deepseek",
      name: "DeepSeek 主账户",
      lastMeters: [
        meter("primary", "人民币余额", 88.5, 31.5, 120, "CNY", "balance", true),
        meter("usd", "美元余额", 12.36, null, null, "USD", "balance", true)
      ]
    }),
    provider({
      id: "glm-plan",
      name: "GLM Coding Plan - 团队研发订阅",
      officialPresetId: "glm-coding-plan-cn",
      officialPresetName: "智谱 GLM Coding Plan",
      defaultUnit: "Tokens",
      lastPrimaryMeterId: "tokens",
      lastMeters: [
        meter("tokens", "Token 额度", 7500, 2500, 10000, "Tokens"),
        meter("search", "Web Search", 42, 8, 50, "次")
      ],
      lastBalance: 7500,
      lastLimit: 10000,
      lastUsed: 2500,
      lastUnit: "Tokens"
    }),
    provider({
      id: "relay-error",
      mode: "relay",
      name: "亚太中转站 / Production Gateway With A Very Long Name",
      officialPresetId: null,
      officialPresetName: null,
      baseUrl: "https://gateway.example.com",
      templateId: "custom",
      requestPath: "/v1/usage",
      requestHeaders: '{"Authorization":"Bearer {{token}}"}',
      jsonPaths: { balance: "data.balance", used: "", limit: "", resetAt: "", unit: "data.unit" },
      lastPrimaryMeterId: "primary",
      lastMeters: [meter("primary", "账户余额", 6.4, 13.6, 20, "USD", "balance", true)],
      lastBalance: 6.4,
      lastLimit: 20,
      lastUsed: 13.6,
      lastUnit: "USD",
      lastError: "请求超时，请检查网络或服务地址",
      lastIsValid: false
    }),
    provider({
      id: "pending",
      name: "OpenRouter 备用账户",
      officialPresetId: "openrouter-credits",
      officialPresetName: "OpenRouter Credits",
      lastPrimaryMeterId: null,
      lastMeters: [],
      lastBalance: null,
      lastLimit: null,
      lastUsed: null,
      lastResetAt: null,
      lastUnit: "USD",
      lastCheckedAt: null,
      lastIsValid: null
    })
  ];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function inputToProvider(input: ProviderInput, existing?: QuotaProvider): QuotaProvider {
  const now = CHECKED_AT;
  const preset = input.mode === "official" ? PRESETS.find((item) => item.id === input.officialPresetId) : null;
  const next = provider({
    ...(existing || {}),
    id: input.id || `fixture-${Date.now()}`,
    mode: input.mode,
    name: input.name || preset?.name || "未命名站点",
    officialPresetId: input.mode === "official" ? input.officialPresetId : null,
    officialPresetName: input.mode === "official" ? preset?.name || null : null,
    officialPresetAvailable: input.mode !== "official" || Boolean(preset),
    baseUrl: input.mode === "relay" ? input.baseUrl : "",
    templateId: input.mode === "relay" ? input.templateId : "openai-usage",
    requestPath: input.mode === "relay" ? input.requestPath : "",
    requestMethod: input.mode === "relay" ? input.requestMethod : "GET",
    authPlacement: input.mode === "relay" ? input.authPlacement : "header",
    requestHeaders: input.mode === "relay" ? input.requestHeaders : "",
    requestBody: input.mode === "relay" ? input.requestBody : "",
    jsonPaths:
      input.mode === "relay" ? clone(input.jsonPaths) : { balance: "", used: "", limit: "", resetAt: "", unit: "" },
    manualLimit: input.manualLimit,
    currencyOverride: input.mode === "official" ? input.currencyOverride : "",
    defaultUnit: input.mode === "relay" ? input.defaultUnit : preset?.defaultUnit || "USD",
    priceMultiplier: input.mode === "relay" ? input.priceMultiplier : 1,
    refreshIntervalMinutes: input.refreshIntervalMinutes,
    updatedAt: now,
    hasApiKey: true
  });

  return next;
}

export function installVisualFixture(rawScenario: string | null) {
  const supportedScenarios: VisualFixtureScenario[] = ["default", "empty", "error", "loading", "one", "two"];
  const scenario = supportedScenarios.includes(rawScenario as VisualFixtureScenario)
    ? (rawScenario as VisualFixtureScenario)
    : "default";
  const visualParams = new URLSearchParams(window.location.search);
  const visualTheme = visualParams.get("visual-theme");
  const visualContrast = visualParams.get("visual-contrast");
  const visualMaterial = visualParams.get("visual-material");
  const visualMotion = visualParams.get("visual-motion");
  const fixtureProviders = createProviders();
  let providers =
    scenario === "empty"
      ? []
      : scenario === "one"
        ? fixtureProviders.slice(0, 1)
        : scenario === "two"
          ? fixtureProviders.slice(0, 2)
          : fixtureProviders;
  const syncChannel =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel(`quota-dock-visual-fixture:${scenario}`)
      : null;

  syncChannel?.addEventListener("message", (event: MessageEvent<VisualFixtureMessage>) => {
    if (event.data?.type !== "providers" || !Array.isArray(event.data.providers)) {
      return;
    }

    providers = clone(event.data.providers);
    const syncProviders = window.__quotaSyncProviders;
    if (typeof syncProviders === "function") {
      void syncProviders();
    }
  });

  if (visualTheme === "dark" || visualTheme === "light") {
    document.documentElement.dataset.visualTheme = visualTheme;
    document.documentElement.dataset.theme = visualTheme;
  }
  if (visualContrast === "more") {
    document.documentElement.dataset.visualContrast = "more";
  }
  if (visualMaterial === "solid") {
    document.documentElement.dataset.visualMaterial = "solid";
  }
  if (visualMotion === "reduced") {
    document.documentElement.dataset.visualMotion = "reduced";
  }

  function waitForever<T>() {
    return new Promise<T>(() => {});
  }

  const bridge: QuotaBridge = {
    async getSyncState() {
      return scenario === "error" ? { state: 1, label: "等待同步" } : { state: 0, label: "已同步" };
    },
    async listOfficialProviderPresets() {
      return clone(PRESETS);
    },
    async listProviders() {
      if (scenario === "loading") {
        return waitForever<QuotaProvider[]>();
      }
      if (scenario === "error") {
        throw new Error("视觉测试：无法读取站点配置");
      }
      return clone(providers);
    },
    async saveProvider(input) {
      const existingIndex = providers.findIndex((item) => item.id === input.id);
      const saved = inputToProvider(input, existingIndex >= 0 ? providers[existingIndex] : undefined);
      if (existingIndex >= 0) {
        providers.splice(existingIndex, 1, saved);
      } else {
        providers.push(saved);
      }
      return clone(saved);
    },
    async setProviderFloatingVisibility(id, visible) {
      const current = providers.find((item) => item.id === id);
      if (!current) {
        throw new Error("站点不存在");
      }
      current.showInFloatingWindow = visible;
      current.updatedAt = CHECKED_AT;
      return clone(current);
    },
    async testProviderRequest() {
      return {
        data: {
          balance: 42.36,
          used: 57.64,
          limit: 100,
          unit: "USD",
          reset_at: RESET_AT,
          nested: { plan: "Professional", enabled: true }
        }
      };
    },
    async testOfficialProvider(): Promise<QuotaSnapshot> {
      return {
        primaryMeterId: "primary",
        meters: [meter("primary", "可用额度", 42.36, 57.64, 100, "USD", "balance", true)]
      };
    },
    async deleteProvider(id) {
      providers = providers.filter((item) => item.id !== id);
      return true;
    },
    async refreshProvider(id) {
      const current = providers.find((item) => item.id === id);
      if (!current) {
        throw new Error("站点不存在");
      }
      current.lastCheckedAt = CHECKED_AT;
      current.lastError = "";
      current.lastIsValid = true;
      return clone(current);
    },
    async refreshDueProviders() {
      if (scenario === "loading") {
        return waitForever<QuotaProvider[]>();
      }
      if (scenario === "error") {
        throw new Error("视觉测试：浮窗自动刷新失败");
      }
      return clone(providers);
    },
    async refreshAll() {
      return clone(providers);
    },
    async syncFloatingWindow() {
      syncChannel?.postMessage({ type: "providers", providers: clone(providers) } satisfies VisualFixtureMessage);
    },
    async openFloatingWindow() {
      return true;
    }
  };

  window.quotaBridge = bridge;
}
