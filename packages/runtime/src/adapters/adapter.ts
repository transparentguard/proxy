/**
 * TransparentGuard Runtime — Provider Adapter Interface (Section 30 / Phase 10)
 */

import type { RequestPayload, ResponsePayload } from "../types.js";

export interface ProviderAuthConfig {
  readonly headerName: string;
  readonly headerFormat: string;
  readonly additionalHeaders?: Readonly<Record<string, string>>;
}

export interface ProviderRegionInfo {
  readonly regions: readonly string[];
  readonly jurisdiction: string;
  readonly trainingJurisdiction: string;
}

export interface ProviderAdapter {
  readonly providerId: string;
  readonly displayName: string;
  readonly auth: ProviderAuthConfig;
  readonly region: ProviderRegionInfo;
  readonly capabilities: readonly string[];
  readonly isOpenAICompat: boolean;

  normalizeRequest(raw: Record<string, unknown>): RequestPayload;
  denormalizeRequest(payload: RequestPayload, original: Record<string, unknown>): Record<string, unknown>;
  normalizeResponse(raw: Record<string, unknown>, model: string): ResponsePayload;
  denormalizeResponse(payload: ResponsePayload, original: Record<string, unknown>): Record<string, unknown>;
}
