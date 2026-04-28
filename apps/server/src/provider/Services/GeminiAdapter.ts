/**
 * GeminiAdapter - Gemini CLI implementation of the generic provider adapter contract.
 *
 * @module GeminiAdapter
 */
import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * GeminiAdapterShape - Service API for the Gemini provider adapter.
 */
export interface GeminiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "gemini";
}

/**
 * GeminiAdapter - Service tag for Gemini provider adapter operations.
 */
export class GeminiAdapter extends Context.Service<GeminiAdapter, GeminiAdapterShape>()(
  "t3/provider/Services/GeminiAdapter",
) {}
