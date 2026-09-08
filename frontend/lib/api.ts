/**
 * API client for the Fastify backend.
 *
 * Access tokens live in memory only; the refresh token is an HttpOnly cookie the
 * browser never exposes to JS. A 401 triggers one silent refresh and one retry,
 * so a roster sync that flips someone's persona takes effect without a re-login.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type Persona = 'TOF' | 'ENROLLED';

export interface PersonaPolicy {
  maxResults: number;
  pinnedCompetitionSlugs: string[];
  requiresInternalApproval: boolean;
  allowsWebVerification: boolean;
  exposesInternalFields: boolean;
  oneReportPerEmail: boolean;
  emailJourney: string;
  entitlementDriven: boolean;
  chatKnowledgeScope: 'PUBLIC' | 'ACTIVATED_INTERNAL';
  chatTurnLimit: number | null;
  chatCompetitionExposureCap: number | null;
}

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  persona: Persona;
}

export interface Session {
  user: SessionUser;
  policy: PersonaPolicy;
}

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      // Only declare a JSON body when there actually is one. Sending
      // Content-Type: application/json with no body makes Fastify reject the
      // request with FST_ERR_CTP_EMPTY_JSON_BODY — which silently broke
      // /auth/refresh, /auth/logout and /admin/logout.
      ...(init.body != null ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });

  if (response.status === 401 && retry && path !== '/auth/refresh') {
    const refreshed = await refresh();
    if (refreshed) return request<T>(path, init, false);
  }

  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export async function refresh(): Promise<Session | null> {
  try {
    const data = await request<Session & { accessToken: string }>(
      '/auth/refresh',
      { method: 'POST' },
      false,
    );
    setAccessToken(data.accessToken);
    return { user: data.user, policy: data.policy };
  } catch {
    setAccessToken(null);
    return null;
  }
}

export type Country = 'US' | 'India' | 'Others';

/** Signup asks for as little as possible; the profile is taken at the lead gate. */
export interface SignupInput {
  email: string;
  password: string;
  name?: string;
}

export async function signup(input: SignupInput): Promise<Session> {
  const data = await request<Session & { accessToken: string }>('/auth/signup', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  setAccessToken(data.accessToken);
  return { user: data.user, policy: data.policy };
}

export async function login(input: { email: string; password: string }): Promise<Session> {
  const data = await request<Session & { accessToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  setAccessToken(data.accessToken);
  return { user: data.user, policy: data.policy };
}

export async function logout(): Promise<void> {
  await request('/auth/logout', { method: 'POST' }).catch(() => undefined);
  setAccessToken(null);
}

// ------------------------------------------------------------------ admin

export interface AdminUser {
  id: string;
  email: string;
  role: string;
  persona: Persona;
  personaLockedAt: string | null;
  createdAt: string;
  student: {
    id: string;
    name: string;
    grade: number | null;
    country: string | null;
    cosmicStudentId: string | null;
  } | null;
  rosterPersona: Persona;
  rosterReason: string;
  overridden: boolean;
  /** Enrolled students only — a TOF account selects nothing. */
  entitlement: Entitlement | null;
}

export interface AdminAssignment {
  id: string;
  status: AssignmentStatus;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string;
  cosmicEnrollmentId: string | null;
  competition: { name: string; slug: string };
  student: {
    id: string;
    name: string;
    cosmicStudentId: string | null;
    user: { email: string };
  };
}

export interface AdminReview {
  id: string
  createdAt: string
  itemCount: number
  studentName: string | null
  grade: number | null
  school: string | null
  projectName: string | null
}

export interface AdminReviewDetail {
  id: string
  status: string
  createdAt: string
  project: {
    name: string | null
    description: string
    domain: string | null
    student: { name: string; grade: number | null; school: string | null; country: string | null } | null
  }
  payload: RecommendationPayload
  retrievalTrace?: unknown
}

export interface AdminOverview {
  users: { tof: number; enrolled: number; overridden: number };
  rosterEntries: number;
  /** Roster rows with no Project Name — these can never produce picks. */
  rosterWithoutProject: number;
  studentsWithPicks: number;
  /** Recommendation sets waiting for a human — nothing reaches a family first. */
  pendingReviews: number;
  competitions: { total: number; byRegion: Record<string, number> };
  lastRosterSync: { startedAt: string; status: string; rowsSeen: number } | null;
  warning?: string;
}

export const admin = {
  login: (password: string) =>
    request<{ ok: true }>('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  session: () => request<{ ok: true }>('/admin/session'),
  logout: () => request<{ ok: true }>('/admin/logout', { method: 'POST' }),
  overview: () => request<AdminOverview>('/admin/overview'),
  users: (params: { q?: string; persona?: Persona }) => {
    const search = new URLSearchParams();
    if (params.q) search.set('q', params.q);
    if (params.persona) search.set('persona', params.persona);
    const qs = search.toString();
    return request<{ users: AdminUser[]; total: number }>(`/admin/users${qs ? `?${qs}` : ''}`);
  },
  reviews: () =>
    request<{ reviews: AdminReview[] }>('/admin/reviews'),
  review: (id: string) => request<AdminReviewDetail>(`/admin/reviews/${id}`),
  approveReview: (id: string, note?: string) =>
    request<{ run: { id: string; status: string } }>(`/admin/reviews/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify(note ? { note } : {}),
    }),
  rejectReview: (id: string, note?: string, regenerate = true) =>
    request<{
      run: { id: string; status: string }
      regenerating: boolean
      reason?: string
    }>(`/admin/reviews/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ ...(note ? { note } : {}), regenerate }),
    }),
  setAllowance: (studentId: string, allowance: number) =>
    request<{ entitlement: Entitlement }>(`/admin/students/${studentId}/allowance`, {
      method: 'PUT',
      body: JSON.stringify({ allowance }),
    }),
  setCosmicId: (studentId: string, cosmicStudentId: string | null) =>
    request<{ student: { id: string; cosmicStudentId: string | null } }>(
      `/admin/students/${studentId}/cosmic-id`,
      { method: 'PUT', body: JSON.stringify({ cosmicStudentId }) },
    ),
  assignments: (status?: AssignmentStatus) =>
    request<{ assignments: AdminAssignment[]; counts: Record<string, number> }>(
      `/admin/assignments${status ? `?status=${status}` : ''}`,
    ),
  retryAssignment: (id: string) =>
    request<{ outcome: { assignmentId: string; status: AssignmentStatus; detail?: string } }>(
      `/admin/assignments/${id}/retry`,
      { method: 'POST' },
    ),
  drainAssignments: () =>
    request<{ summary: { attempted: number; sent: number; waiting: number; failed: number } }>(
      '/admin/assignments/drain',
      { method: 'POST' },
    ),
  setPersona: (id: string, persona: Persona, followRoster = false) =>
    request<{ user: AdminUser }>(`/admin/users/${id}/persona`, {
      method: 'PATCH',
      body: JSON.stringify({ persona, followRoster }),
    }),
};

// ------------------------------------------------- projects + recommendations

export interface Project {
  id: string
  name: string | null
  domain: string
  description: string
}

export interface RecommendationCompetition {
  /** Present on an enrolled payload (the internal serializer), absent for TOF. */
  id?: string
  slug: string
  name: string
  description: string | null
  domains: string[]
  regions: string[]
  eligibility: string | null
  team: string | null
  deadline: {
    date: string | null
    text: string | null
    precision: string
    isRolling: boolean
    lastVerifiedAt: string | null
  }
  registrationStatus: string | null
  officialUrl: string | null
  prestige: number | null
  selectivity: number | null
  difficulty: 'EASY' | 'MEDIUM' | 'HARD' | null
}

export interface RecommendationItem {
  rank: number
  slug: string
  /** Null for a pinned competition the model never scored. */
  score: number | null
  reason: string
  fitBucket: 'REACH' | 'TARGET' | 'SAFETY'
  pinned: boolean
  /** False when the item was pinned rather than ranked — do not show a %. */
  ranked?: boolean
  competition: RecommendationCompetition | null
  /** Server-side redaction: everything but the free sample, before the gate. */
  locked?: true
}

export interface RecommendationPayload {
  engineVersion: string
  model: string
  persona: Persona
  generatedAt: string
  region: string | null
  classification: {
    domains: string[]
    projectType: string
    maturity: string
    summary: string
  }
  items: RecommendationItem[]
  reviewerNotes: string | null
}

export interface RecommendationRun {
  id: string
  status: 'DRAFT' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'DELIVERED'
  createdAt: string
  payload?: RecommendationPayload
  /** How many matches are withheld pending lead capture. */
  lockedCount?: number
}

export interface PendingProject {
  id: string
  name: string | null
  description: string
  createdAt: string
}

export const projects = {
  /** The project CreatED already holds for an enrolled student, if unconfirmed. */
  pendingConfirmation: () =>
    request<{ project: PendingProject | null }>('/projects/pending-confirmation'),
  confirm: (id: string) =>
    request<{ project: Project }>(`/projects/${id}/confirm`, { method: 'POST' }),
  dismiss: (id: string) =>
    request<{ project: Project }>(`/projects/${id}/dismiss`, { method: 'POST' }),
  create: (input: { name?: string; domain: string; description: string }) =>
    request<{ project: Project }>('/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  latestRun: (projectId: string) =>
    request<{ run: RecommendationRun | null }>(`/projects/${projectId}/recommendations`),
}

/** The details collected at the lead gate. */
export interface LeadDetails {
  name: string
  phone: string
  grade: number
  school: string
  city: string
  country: Country
}

export const leads = {
  status: () =>
    request<{ unlocked: boolean; runId: string | null; reportGeneratedAt: string | null }>(
      '/leads/me',
    ),
  unlock: (runId: string, details: LeadDetails) =>
    request<{ unlocked: true; resent: boolean; runId: string; message?: string }>(
      '/leads/report',
      { method: 'POST', body: JSON.stringify({ runId, ...details }) },
    ),
}

export interface ChatReply {
  sessionId: string
  reply: string
  /** Competition slugs the assistant drew on, for source chips. */
  sources: string[]
}

export const chat = {
  ask: (message: string, sessionId?: string) =>
    request<ChatReply>('/chat', {
      method: 'POST',
      body: JSON.stringify({ message, ...(sessionId ? { sessionId } : {}) }),
    }),
}

export const recommendations = {
  generate: (projectId: string) =>
    request<{
      runId: string
      status: string
      itemCount: number
      /** True when an existing report was returned instead of a new one. */
      reused?: boolean
      warning?: string
    }>('/recommendations', { method: 'POST', body: JSON.stringify({ projectId }) }),
  get: (id: string) => request<RecommendationRun>(`/recommendations/${id}`),
}

// ------------------------------------------------------ selection + workspace

export type AssignmentStatus =
  | 'READY'
  | 'WAITING_FOR_STUDENT'
  | 'WAITING_FOR_PROJECT'
  | 'SENT'
  | 'FAILED'

export interface Entitlement {
  /** How many competitions this student's program includes. */
  allowance: number
  used: number
  remaining: number
  /** True while the configured default applies and no allowance has been set. */
  isDefault: boolean
  /** Competition ids already active, so the UI can render them as chosen. */
  activeCompetitionIds: string[]
}

export interface MyCompetition {
  competition: RecommendationCompetition
  reason: string
  fitBucket: 'REACH' | 'TARGET' | 'SAFETY' | null
  activatedAt: string | null
  /** Where the assignment to COSMIC got to, in words the student can read. */
  workspace: { ready: boolean; status: string }
}

export const entitlement = {
  get: () => request<{ entitlement: Entitlement | null }>('/entitlement'),

  /** Confirm a selection. Entries may be competition ids or slugs. */
  select: (runId: string, competitionIds: string[]) =>
    request<{
      activated: { competitionId: string; slug: string; name: string; assignment: AssignmentStatus }[]
      alreadyActive: string[]
      entitlement: Entitlement
    }>(`/recommendations/${runId}/select`, {
      method: 'POST',
      body: JSON.stringify({ competitionIds }),
    }),

  mine: () => request<{ competitions: MyCompetition[] }>('/me/competitions'),
}
