export type ProviderMode = "relay" | "official";
export type TemplateId = "openai-usage" | "rate-limits" | "custom";
export type RequestMethod = "GET" | "POST";
export type AuthPlacement = "header" | "body";
export type JsonPathKey = "balance" | "used" | "limit" | "resetAt" | "unit";
export type QuotaMeterKind = "balance" | "quota" | "spend";
export type OfficialProviderCategory = "api" | "plan" | "admin";
export type ProviderStatus = "ok" | "error" | "unconfigured" | "unavailable" | "pending";

export interface JsonPathMap {
  balance: string;
  used: string;
  limit: string;
  resetAt: string;
  unit: string;
}

export interface QuotaMeter {
  id: string;
  label: string;
  kind: QuotaMeterKind;
  remaining: number | null;
  used: number | null;
  limit: number | null;
  unit: string;
  resetAt: string | null;
  remainingPercent: number | null;
  aggregate: boolean;
}

export interface QuotaSnapshot {
  primaryMeterId: string;
  meters: QuotaMeter[];
}

export interface OfficialProviderPresetSummary {
  id: string;
  name: string;
  category: OfficialProviderCategory;
  categoryLabel: string;
  credentialLabel: string;
  credentialPlaceholder: string;
  credentialHelp: string;
  defaultUnit: string;
  supportsManualLimit: boolean;
  supportsCurrencyOverride: boolean;
}

export interface ProviderTemplate {
  id: TemplateId;
  name: string;
  requestPath: string;
  requestMethod: RequestMethod;
  authPlacement: AuthPlacement;
  requestHeaders: string;
  requestBody: string;
  jsonPaths: JsonPathMap;
}

export interface QuotaProvider {
  id: string;
  mode: ProviderMode;
  name: string;
  officialPresetId: string | null;
  officialPresetName: string | null;
  officialPresetAvailable: boolean;
  baseUrl: string;
  templateId: TemplateId;
  requestPath: string;
  requestMethod: RequestMethod;
  authPlacement: AuthPlacement;
  requestHeaders: string;
  requestBody: string;
  jsonPaths: JsonPathMap;
  manualLimit: number | null;
  currencyOverride: string;
  defaultUnit: string;
  priceMultiplier: number;
  refreshIntervalMinutes: number;
  showInFloatingWindow: boolean;
  snapshot: QuotaSnapshot | null;
  status: ProviderStatus;
  lastCheckedAt: string | null;
  lastError: string;
  createdAt: string;
  updatedAt: string;
  hasApiKey: boolean;
}

interface ProviderInputBase {
  id?: string;
  mode: ProviderMode;
  name: string;
  apiKey?: string;
  manualLimit: number | null;
  refreshIntervalMinutes: number;
}

export interface RelayProviderInput extends ProviderInputBase {
  mode: "relay";
  baseUrl: string;
  templateId: TemplateId;
  requestPath: string;
  requestMethod: RequestMethod;
  authPlacement: AuthPlacement;
  requestHeaders: string;
  requestBody: string;
  jsonPaths: JsonPathMap;
  defaultUnit: string;
  priceMultiplier: number;
}

export interface OfficialProviderInput extends ProviderInputBase {
  mode: "official";
  officialPresetId: string;
  currencyOverride: string;
}

export type ProviderInput = RelayProviderInput | OfficialProviderInput;

export interface SyncState {
  state: number | null;
  label: string;
}

export interface QuotaBridge {
  getSyncState(): Promise<SyncState>;
  listProviderTemplates(): Promise<ProviderTemplate[]>;
  listOfficialProviderPresets(): Promise<OfficialProviderPresetSummary[]>;
  listProviders(): Promise<QuotaProvider[]>;
  saveProvider(input: ProviderInput): Promise<QuotaProvider>;
  setProviderFloatingVisibility(id: string, visible: boolean): Promise<QuotaProvider>;
  testProviderRequest(input: RelayProviderInput): Promise<unknown>;
  testOfficialProvider(input: OfficialProviderInput): Promise<QuotaSnapshot>;
  deleteProvider(id: string): Promise<boolean>;
  refreshProvider(id: string): Promise<QuotaProvider>;
  refreshDueProviders(): Promise<QuotaProvider[]>;
  refreshAll(): Promise<QuotaProvider[]>;
  openFloatingWindow(): Promise<boolean>;
}
