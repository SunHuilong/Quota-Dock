import type {
  OfficialProviderInput,
  OfficialProviderPresetSummary,
  ProviderTemplate,
  ProviderInput,
  QuotaBridge,
  QuotaProvider,
  QuotaSnapshot,
  RelayProviderInput,
  SyncState
} from "./types";

const UNAVAILABLE_MESSAGE = "未检测到 uTools preload，请在 uTools 开发者工具中加载 dist 目录";

function getUnavailableMessage() {
  if (window.__quotaPreloadError?.message) {
    return `preload 加载失败：${window.__quotaPreloadError.message}`;
  }

  return UNAVAILABLE_MESSAGE;
}

function createUnavailableBridge(): QuotaBridge {
  const fail = async <T>(): Promise<T> => {
    throw new Error(getUnavailableMessage());
  };

  return {
    async getSyncState(): Promise<SyncState> {
      return {
        state: null,
        label: window.__quotaPreloadError ? "preload 加载失败" : "preload 未连接"
      };
    },
    listOfficialProviderPresets(): Promise<OfficialProviderPresetSummary[]> {
      return fail();
    },
    listProviderTemplates(): Promise<ProviderTemplate[]> {
      return fail();
    },
    listProviders(): Promise<QuotaProvider[]> {
      return fail();
    },
    saveProvider(_input: ProviderInput): Promise<QuotaProvider> {
      return fail();
    },
    setProviderFloatingVisibility(_id: string, _visible: boolean): Promise<QuotaProvider> {
      return fail();
    },
    testProviderRequest(_input: RelayProviderInput): Promise<unknown> {
      return fail();
    },
    testOfficialProvider(_input: OfficialProviderInput): Promise<QuotaSnapshot> {
      return fail();
    },
    deleteProvider(_id: string): Promise<boolean> {
      return fail();
    },
    refreshProvider(_id: string): Promise<QuotaProvider> {
      return fail();
    },
    refreshDueProviders(): Promise<QuotaProvider[]> {
      return fail();
    },
    refreshAll(): Promise<QuotaProvider[]> {
      return fail();
    },
    openFloatingWindow(): Promise<boolean> {
      return fail();
    }
  };
}

let unavailableBridge: QuotaBridge | null = null;

export function getQuotaBridge(): QuotaBridge {
  if (window.quotaBridge) {
    return window.quotaBridge;
  }

  unavailableBridge ||= createUnavailableBridge();
  return unavailableBridge;
}
