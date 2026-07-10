/// <reference types="vite/client" />

import type { QuotaBridge } from "./shared/types";

declare global {
  interface Window {
    quotaBridge?: QuotaBridge;
    __quotaSyncProviders?: () => Promise<number>;
    __quotaPreloadReady?: boolean;
    __quotaPreloadError?: {
      message: string;
      stack?: string;
    } | null;
  }
}
