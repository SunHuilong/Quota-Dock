export interface QuotaProvider {
  id: string;
  name: string;
  baseUrl: string;
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
  deleteProvider(id: string): Promise<boolean>;
  refreshProvider(id: string): Promise<QuotaProvider>;
  refreshDueProviders(): Promise<QuotaProvider[]>;
  refreshAll(): Promise<QuotaProvider[]>;
  openFloatingWindow(): Promise<boolean>;
}
