export type TemplateId = "openai-usage" | "rate-limits" | "custom";
export type RequestMethod = "GET" | "POST";
export type AuthPlacement = "header" | "body";
export type JsonPathKey = "balance" | "used" | "limit" | "resetAt" | "unit";

export interface JsonPathMap {
  balance: string;
  used: string;
  limit: string;
  resetAt: string;
  unit: string;
}

export interface QuotaProvider {
  id: string;
  name: string;
  baseUrl: string;
  templateId: TemplateId;
  requestPath: string;
  requestMethod: RequestMethod;
  authPlacement: AuthPlacement;
  requestHeaders: string;
  requestBody: string;
  jsonPaths: JsonPathMap;
  manualLimit: number | null;
  defaultUnit: string;
  refreshIntervalMinutes: number;
  lastBalance: number | null;
  lastLimit: number | null;
  lastUsed: number | null;
  lastResetAt: string | null;
  lastUnit: string | null;
  lastIsValid: boolean | null;
  lastCheckedAt: string | null;
  lastError: string;
  createdAt: string;
  updatedAt: string;
  hasApiKey: boolean;
}

export interface ProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  templateId: TemplateId;
  requestPath: string;
  requestMethod: RequestMethod;
  authPlacement: AuthPlacement;
  requestHeaders: string;
  requestBody: string;
  jsonPaths: JsonPathMap;
  manualLimit: number | null;
  defaultUnit: string;
  refreshIntervalMinutes: number;
}

export interface SyncState {
  state: number | null;
  label: string;
}

export interface QuotaBridge {
  getSyncState(): Promise<SyncState>;
  listProviders(): Promise<QuotaProvider[]>;
  saveProvider(input: ProviderInput): Promise<QuotaProvider>;
  testProviderRequest(input: ProviderInput): Promise<unknown>;
  deleteProvider(id: string): Promise<boolean>;
  refreshProvider(id: string): Promise<QuotaProvider>;
  refreshDueProviders(): Promise<QuotaProvider[]>;
  refreshAll(): Promise<QuotaProvider[]>;
  syncFloatingWindow(): Promise<void>;
  openFloatingWindow(): Promise<boolean>;
}
