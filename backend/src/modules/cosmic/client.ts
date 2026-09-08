/**
 * Outbound client for COSMIC — the operational system where a student actually
 * works on a competition.
 *
 * Deliberately the mirror image of COSMIC's own SyncClient
 * (cosmic/backend/app/services/sync_client.py): sign in as a service account,
 * cache the JWT, retry three times with exponential backoff, drop the token and
 * re-auth on a 401. comp-ai authenticates as a COSMIC user with role=manager,
 * which is the same posture COSMIC already accepts from SYNC — no new auth
 * mechanism, no shared secret to rotate in two places.
 *
 * Nothing here throws into a request path that matters. A selection completes
 * whether or not COSMIC answers; the caller records the failure on the
 * assignment and the retry job picks it up.
 */

import { config } from '../../lib/config.js';

const LOGIN_PATH = '/api/v1/auth/login';
const BASE_PATH = '/api/v1/integrations/comp-ai';
const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;

export class CosmicError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** A 4xx is our fault and will fail identically on retry. */
    readonly terminal = false,
  ) {
    super(message);
    this.name = 'CosmicError';
  }
}

export interface CosmicTemplateInput {
  compAiSlug: string;
  name: string;
  description?: string | null;
  finalDeadline?: string | null;
  complianceWarning?: string | null;
}

export interface CosmicTemplateResult {
  template_id: string;
  slug: string;
  created: boolean;
}

export interface CosmicAssignInput {
  compAiSlug: string;
  competitionName: string;
  studentEmail: string;
  parentEmail?: string | null;
  studentName?: string | null;
  cosmicStudentId?: string | null;
  submissionDate?: string | null;
}

export interface CosmicAssignResult {
  /** `no_student` and `no_project` are queue states, not failures. */
  status: 'assigned' | 'already_assigned' | 'no_student' | 'no_project';
  student_id?: string | null;
  project_id?: string | null;
  template_id?: string | null;
  enrollment_id?: string | null;
  competition_id?: string | null;
  detail?: string | null;
}

export interface CosmicClient {
  upsertTemplate(input: CosmicTemplateInput): Promise<CosmicTemplateResult>;
  assign(input: CosmicAssignInput): Promise<CosmicAssignResult>;
}

/** Configured means: we know where COSMIC is and who we are there. */
export function cosmicConfigured(): boolean {
  return Boolean(
    config.COSMIC_API_URL && config.COSMIC_SERVICE_EMAIL && config.COSMIC_SERVICE_PASSWORD,
  );
}

let cachedToken: string | null = null;

/** Exposed for tests and for an admin-triggered re-auth. */
export function clearCosmicToken(): void {
  cachedToken = null;
}

async function login(): Promise<string> {
  const response = await fetch(`${config.COSMIC_API_URL}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: config.COSMIC_SERVICE_EMAIL,
      password: config.COSMIC_SERVICE_PASSWORD,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    // Bad service credentials will not fix themselves on retry.
    throw new CosmicError(
      `COSMIC sign-in failed (${response.status}) — check COSMIC_SERVICE_EMAIL / COSMIC_SERVICE_PASSWORD`,
      response.status,
      response.status < 500,
    );
  }

  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new CosmicError('COSMIC sign-in returned no access_token');
  return body.access_token;
}

async function request<T>(path: string, payload: unknown, method = 'POST'): Promise<T> {
  if (!cosmicConfigured()) {
    throw new CosmicError('COSMIC is not configured (COSMIC_API_URL and service credentials)', undefined, true);
  }

  let lastError: CosmicError = new CosmicError('no attempts made');

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      cachedToken ??= await login();

      const response = await fetch(`${config.COSMIC_API_URL}${BASE_PATH}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cachedToken}`,
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (response.status === 401) {
        // Expired or revoked — one re-auth, then try again.
        cachedToken = null;
        lastError = new CosmicError('COSMIC returned 401, re-authenticating', 401);
      } else if (response.ok) {
        return (await response.json()) as T;
      } else {
        const text = await response.text().catch(() => '');
        const terminal = response.status < 500;
        lastError = new CosmicError(
          `COSMIC ${method} ${path} failed (${response.status}) ${text.slice(0, 300)}`,
          response.status,
          terminal,
        );
        if (terminal) throw lastError;
      }
    } catch (err) {
      if (err instanceof CosmicError) {
        if (err.terminal) throw err;
        lastError = err;
      } else {
        lastError = new CosmicError(err instanceof Error ? err.message : 'COSMIC request failed');
      }
    }

    if (attempt < ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }

  throw lastError;
}

export const cosmicClient: CosmicClient = {
  upsertTemplate(input) {
    return request<CosmicTemplateResult>('/templates/upsert', {
      comp_ai_slug: input.compAiSlug,
      name: input.name,
      description: input.description ?? null,
      final_deadline: input.finalDeadline ?? null,
      compliance_warning: input.complianceWarning ?? null,
    });
  },

  assign(input) {
    return request<CosmicAssignResult>('/assign', {
      comp_ai_slug: input.compAiSlug,
      competition_name: input.competitionName,
      student_email: input.studentEmail,
      parent_email: input.parentEmail ?? null,
      student_name: input.studentName ?? null,
      cosmic_student_id: input.cosmicStudentId ?? null,
      submission_date: input.submissionDate ?? null,
    });
  },
};
