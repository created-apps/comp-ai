import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

/**
 * Shared Anthropic client.
 *
 * Two model-level choices apply across the recommendation pipeline:
 *
 *  - Adaptive thinking is on. Both stages are judgement calls over messy,
 *    partially-missing data, which is exactly where reasoning pays.
 *  - Effort is set per stage, not globally: classification is a cheap extraction
 *    job, reranking is the step whose quality the student actually feels.
 */
let client: Anthropic | null = null;

export function getClaude(): Anthropic {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set — the recommendation pipeline cannot run without it.',
    );
  }
  client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return client;
}

export const MODEL = config.CLAUDE_MODEL;

/** Bump when a prompt or pipeline stage changes, so old runs stay explainable. */
export const ENGINE_VERSION = '1.0.0';

/**
 * Claude may decline a request outright (HTTP 200, stop_reason "refusal").
 * Reading `content` without checking would look like an empty result rather than
 * a refusal, so every call site guards on this.
 */
export function assertNotRefused(message: { stop_reason?: string | null }): void {
  if (message.stop_reason === 'refusal') {
    throw new Error('Claude declined to complete this request.');
  }
}
