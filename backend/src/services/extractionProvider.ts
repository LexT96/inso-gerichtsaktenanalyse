/**
 * Unified extraction provider layer.
 * Supports: anthropic (direct), vertex (Google Cloud EU), openai (direct/Azure), langdock (EU proxy)
 *
 * Configure via EXTRACTION_PROVIDER env var:
 *   - "anthropic" (default) — direct Anthropic API, native PDF
 *   - "vertex"   — Google Vertex AI (EU Belgium), native PDF, needs GOOGLE_PROJECT_ID + auth
 *   - "openai"   — OpenAI/Azure, vision via images, needs OPENAI_API_KEY
 *   - "langdock"  — detected from ANTHROPIC_BASE_URL containing "langdock"
 */

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { config } from '../config';
import { logger } from '../utils/logger';

export type Provider = 'anthropic' | 'vertex' | 'openai' | 'langdock';

/** Detect the active provider from env vars */
export function detectProvider(): Provider {
  const explicit = process.env.EXTRACTION_PROVIDER?.toLowerCase();
  if (explicit === 'openai') return 'openai';
  if (explicit === 'vertex') return 'vertex';
  if (explicit === 'langdock') return 'langdock';
  if (config.ANTHROPIC_BASE_URL?.includes('langdock')) return 'langdock';
  return 'anthropic';
}

/** Does this provider support native PDF mode (type: "document")? */
export function supportsNativePdf(provider: Provider): boolean {
  // Langdock proxy does NOT support native PDF (document content type) — only text/image
  return provider === 'anthropic' || provider === 'vertex';
}

/**
 * Does the configured Anthropic client support native PDF (document content type)?
 * Use this for any pass that calls Claude directly (handwriting, PZU, slot filling),
 * regardless of what EXTRACTION_PROVIDER is set to for the base extraction.
 *
 * Direct Anthropic API and Vertex support PDF. Langdock proxy does not.
 *
 * Debug flag: set FORCE_NO_NATIVE_PDF=1 to simulate Langdock-style restriction
 * locally even when the actual baseURL is direct Anthropic. Useful for testing
 * the image-batched fallback paths against real APIs without needing Langdock
 * credentials.
 */
export function anthropicSupportsNativePdf(): boolean {
  if (process.env.FORCE_NO_NATIVE_PDF === '1') return false;
  if (process.env.GOOGLE_PROJECT_ID) return true; // Vertex
  return !config.ANTHROPIC_BASE_URL?.toLowerCase().includes('langdock');
}

/** Is this provider rate-limited (needs serialized calls)? */
export function isRateLimited(provider: Provider): boolean {
  // Langdock now has 200K TPM — no longer rate-limited
  return false;
}

// ─── Anthropic clients (direct + Vertex) ───

let anthropicClient: Anthropic | null = null;
let vertexClient: AnthropicVertex | null = null;

/** Get the Anthropic client (direct API or Langdock proxy) */
export function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: config.ANTHROPIC_API_KEY,
      ...(config.ANTHROPIC_BASE_URL ? { baseURL: config.ANTHROPIC_BASE_URL } : {}),
    });
  }
  return anthropicClient;
}

/** Get the Vertex AI client */
export function getVertexClient(): AnthropicVertex {
  if (!vertexClient) {
    const projectId = process.env.GOOGLE_PROJECT_ID;
    const region = process.env.GOOGLE_REGION || 'europe-west1';
    if (!projectId) throw new Error('GOOGLE_PROJECT_ID required for Vertex provider');

    vertexClient = new AnthropicVertex({ projectId, region });
    logger.info('Vertex AI client initialized', { projectId, region });
  }
  return vertexClient;
}

/**
 * Create a message using the appropriate Anthropic-compatible client.
 * Works for both direct Anthropic and Vertex AI (same API shape).
 */
export async function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  const provider = detectProvider();

  if (provider === 'vertex') {
    const client = getVertexClient();
    return client.messages.create(params) as Promise<Anthropic.Message>;
  }

  // anthropic or langdock — both use the Anthropic SDK
  const client = getAnthropicClient();
  return client.messages.create(params);
}

/**
 * Create a streaming message using the appropriate client.
 */
export async function createStreamingMessage(
  params: Anthropic.MessageCreateParamsStreaming
): Promise<AsyncIterable<Anthropic.MessageStreamEvent>> {
  const provider = detectProvider();

  if (provider === 'vertex') {
    const client = getVertexClient();
    return client.messages.create(params) as unknown as AsyncIterable<Anthropic.MessageStreamEvent>;
  }

  const client = getAnthropicClient();
  return client.messages.create(params) as unknown as AsyncIterable<Anthropic.MessageStreamEvent>;
}

/** Get the extraction model name for the current provider */
export function getExtractionModel(): string {
  const provider = detectProvider();
  if (provider === 'openai') return process.env.OPENAI_MODEL || 'gpt-5.4';
  return config.EXTRACTION_MODEL;
}

/** Get the utility model name (for verification, slot filling) */
export function getUtilityModel(): string {
  // Always use Anthropic for utility tasks (cheaper, works on all providers)
  return config.UTILITY_MODEL || 'claude-haiku-4-5-20251001';
}

/** Log the active provider configuration */
export function logProviderConfig(): void {
  const provider = detectProvider();
  const model = getExtractionModel();
  logger.info('Extraction provider configured', {
    provider,
    model,
    supportsNativePdf: supportsNativePdf(provider),
    rateLimited: isRateLimited(provider),
    ...(provider === 'vertex' ? { region: process.env.GOOGLE_REGION || 'europe-west1' } : {}),
    ...(provider === 'openai' ? { reasoning: process.env.OPENAI_REASONING_EFFORT || 'high' } : {}),
  });
}
