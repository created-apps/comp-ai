# CreatED Competition AI — Unified Platform Plan

**Status:** plan only. No build until approved (both requirement docs mandate this).
**Date:** 2026-09-07

---

## 0. The core idea

One platform, one codebase, one competition repository, one recommendation engine.
The **only** runtime differentiator is a roster lookup:

```
signup/login email
      │
      ▼
enrolled_roster  ← synced from Google Sheet by a cron every 5 hours
      │
   ┌──┴───┐
 found   not found
   │        │
   ▼        ▼
ENROLLED   TOF
 flow      flow
```

Everything downstream — retrieval, ranking, report shape, gating, email journey —
is driven by a **persona policy object** keyed on that one boolean. There are not
two apps; there is one app with two policies.

---

## 1. Persona policy matrix

| Concern | TOF (`persona = TOF`) | Enrolled (`persona = ENROLLED`) |
|---|---|---|
| Entry | Public landing page, 2 inputs (domain + 1-sentence project) | JWT login (student / parent / internal) |
| Identity | Lead record, email-gated | User + Student + Program enrolment |
| Recommendations | 5–8, capped | ~5 strong-fit, dynamic count |
| First result | **CREST Gold Award always pinned #1** | No pin |
| Human approval | None (auto-generated, auto-emailed) | **Required** — internal review before client sees it |
| Selection | None | Client selects within program entitlement (1, 2, N) |
| Activation | None | Selected → Active → unlocks guidance/templates/tasks |
| Milestones | Not shown | Dynamic milestone list per competition, per cycle |
| Web verification | **Never** (no live web search) | Yes — verify official source before activation + periodically |
| Repository exposure | Locked; no browse/search; internal fields stripped | Full internal detail for activated comps |
| Repeat use | 1 report per email, resend original | Unlimited, versioned runs |
| Email | Flow 1 — 8-email nurture (Day 1,3,6,9,12,15,18,21) | Flow 2 — 5-email extension pathways |
| Output | Emailed report + on-page locked cards | Tracker cards (Rollout 1) → LMS pathway cards (Rollout 2) |
| **Competition AI chatbot** | Public-safe knowledge only, capped turns, no repository dumping | Full knowledge for *activated* competitions + the student's own milestones/tasks |

Implemented as `PersonaPolicy`:

```ts
type PersonaPolicy = {
  maxResults: number;            // TOF 8 | ENROLLED 5
  pinnedCompetitionSlugs: string[]; // TOF ['crest-gold'] | ENROLLED []
  requiresInternalApproval: boolean;
  allowsWebVerification: boolean;
  exposesInternalFields: boolean;
  oneReportPerEmail: boolean;
  emailJourney: 'TOF_NURTURE_8' | 'ENROLLED_EXTENSION_5';
  entitlementDriven: boolean;
  chatKnowledgeScope: 'PUBLIC' | 'ACTIVATED_INTERNAL';
  chatTurnLimit: number | null;       // TOF 10 per session | ENROLLED null
};
```

One resolver (`resolvePersona(email)`) and one policy table. No forked services.

---

## 2. Tech stack & repo layout

- **Frontend:** Next.js (App Router, TS, Tailwind, server actions off — talks to API over REST)
- **Backend:** Node + TypeScript, Fastify (or Express — Fastify preferred for schema validation + speed)
- **DB:** PostgreSQL + **Prisma** (recommendations stored as `Json`/jsonb)
- **Vector store:** **ChromaDB** (separate container, persistent volume), one collection per competition corpus
- **Auth:** plain **JWT** (access ~15m + refresh ~30d, HttpOnly cookie), bcrypt/argon2 password hash
- **Jobs:** BullMQ + Redis (cron + retries + dead-letter). Fallback: `node-cron` in a worker process if we want zero Redis.
- **LLM:** Claude (Anthropic SDK) for classification, reranking, report copy, milestone extraction
- **Email:** transactional provider (Resend/Postmark) for the report; Urja's tool receives the lead for nurture

```
comp-ai/
├─ apps/
│  ├─ web/                  # Next.js
│  └─ api/                  # Node + TS (Fastify)
│     ├─ src/modules/
│     │  ├─ auth/           # jwt, signup, login, persona resolution
│     │  ├─ roster/         # google sheet sync (cron 5h)
│     │  ├─ competitions/   # csv ingest, masterlist CRUD, milestones
│     │  ├─ retrieval/      # chroma client, embedding, hybrid search
│     │  ├─ recommend/      # filter → rank → LLM rerank → persist jsonb
│     │  ├─ review/         # internal approve/reject (enrolled)
│     │  ├─ entitlement/    # program allowance, selection, activation
│     │  ├─ verification/   # web re-verification + human approval
│     │  ├─ leads/          # TOF lead capture, one-report-per-email
│     │  ├─ chat/           # Competition AI: sessions, RAG tools, streaming
│     │  ├─ reports/        # render + email report
│     │  └─ jobs/           # bullmq queues + schedulers
│     └─ prisma/schema.prisma
├─ packages/
│  ├─ shared/               # zod schemas, types, persona policy
│  └─ ingest/               # CSV → Postgres → Chroma pipeline
└─ docker-compose.yml       # postgres, redis, chroma
```

---

## 3. Data model (Prisma sketch)

```prisma
enum Persona          { TOF ENROLLED }
enum Role             { STUDENT PARENT INTERNAL ADMIN }
enum RecStatus        { DRAFT PENDING_REVIEW APPROVED REJECTED DELIVERED }
enum ItemState        { RECOMMENDED APPROVED SELECTED ACTIVE ARCHIVED LOCKED }
enum MilestoneStatus  { UPCOMING OPEN CLOSED AWAITING_VERIFICATION VERIFIED }
enum VerifyStatus     { PENDING_REVIEW APPROVED REJECTED NO_CHANGE FAILED }

model User {
  id            String   @id @default(cuid())
  email         String   @unique
  passwordHash  String?
  role          Role     @default(STUDENT)
  persona       Persona                    // resolved at signup, re-resolved on each sync
  personaLockedAt DateTime?                // manual override support
  student       Student?
  createdAt     DateTime @default(now())
}

// mirror of the Google Sheet — the single source of "is this kid enrolled"
model EnrolledRosterEntry {
  id             String   @id @default(cuid())
  emailNormalized String  @unique          // lowercased, trimmed, gmail-dot-safe
  rawEmail       String
  studentName    String?
  parentEmail    String?
  programTypes   String[]                  // RBP, etc.
  programTrack   String?
  competitionAllowance Int?                // how many comps their package includes
  rawRow         Json                      // full sheet row, audit
  sheetRowId     String?
  syncRunId      String
  syncRun        SheetSyncRun @relation(fields: [syncRunId], references: [id])
  active         Boolean  @default(true)
}

model SheetSyncRun {
  id        String   @id @default(cuid())
  startedAt DateTime @default(now())
  finishedAt DateTime?
  rowsSeen  Int      @default(0)
  added     Int      @default(0)
  removed   Int      @default(0)
  status    String   // OK | PARTIAL | FAILED
  error     String?
  entries   EnrolledRosterEntry[]
}

model Student {
  id        String  @id @default(cuid())
  userId    String  @unique
  user      User    @relation(fields: [userId], references: [id])
  name      String
  grade     String?
  school    String?
  city      String?
  country   String?
  age       Int?
  phone     String?
  parentName String?
  parentEmail String?
  projects  Project[]
  enrolments ProgramEnrolment[]
}

model Project {
  id          String @id @default(cuid())
  studentId   String?
  leadId      String?                       // TOF projects belong to a Lead, not a Student
  name        String?
  domain      String                        // AI, Bio, Sustainability, ...
  description String                        // the 1-sentence (TOF) or full (enrolled) description
  maturity    String?                       // IDEA | RESEARCHED | PROTOTYPE | PAPER
  classification Json?                      // LLM output: tags, subdomains, type, depth
  runs        RecommendationRun[]
}

model ProgramEnrolment {
  id            String @id @default(cuid())
  studentId     String
  programName   String
  competitionAllowance Int                  // 1, 2, N — drives activation limit
  startsAt      DateTime?
  endsAt        DateTime?
}

// ---------- competition repository ----------
model Competition {
  id            String @id @default(cuid())
  slug          String @unique
  name          String
  shortDescription String
  officialUrl    String
  organiser      String?
  domains        String[]
  projectTypes   String[]                   // research | build | entrepreneurship | design
  eligibility    Json                       // { minGrade, maxGrade, minAge, maxAge, countries[], teamSizeMin/Max }
  prestige       Int?                       // 1-5
  selectivity    Int?                       // 1-5
  complexity     Int?
  timeInvestment String?
  currentCycle   String?                    // "2026"
  cycleActive    Boolean @default(true)
  publicSummary  String                     // safe-to-expose text (TOF)
  internalNotes  String?                    // NEVER exposed to TOF
  internalGuidanceUrl String?               // NEVER exposed to TOF
  winningSubmissions Json?                  // NEVER exposed to TOF
  lastVerifiedAt DateTime?
  verifiedBy     String?
  embeddingHash  String?                    // detect doc drift → re-embed
  milestones     CompetitionMilestone[]
  source         Json                       // original CSV row
}

// fully dynamic — no fixed Round1/Round2/Round3 columns
model CompetitionMilestone {
  id            String @id @default(cuid())
  competitionId String
  competition   Competition @relation(fields: [competitionId], references: [id])
  cycle         String                      // "2026"
  order         Int
  name          String                      // "Registration", "Shortlist", "Interview", "Final pitch"
  type          String?                     // REGISTRATION | SUBMISSION | ROUND | RESULT | EVENT
  dateStart     DateTime?
  dateEnd       DateTime?
  dateText      String?                     // "rolling", "TBA"
  status        MilestoneStatus @default(UPCOMING)
  activatesOnQualification Boolean @default(false)  // later rounds appear only once qualified
  sourceUrl     String?
  lastVerifiedAt DateTime?
  verifiedBy    String?
}

// ---------- recommendations (jsonb, as required) ----------
model RecommendationRun {
  id           String @id @default(cuid())
  projectId    String
  project      Project @relation(fields: [projectId], references: [id])
  persona      Persona
  status       RecStatus @default(DRAFT)
  payload      Json                         // ← the full generated recommendation set, jsonb
  engineVersion String
  modelId      String
  promptHash   String
  retrievalTrace Json                       // chroma ids, scores, filters applied — for debugging
  reviewedById String?
  reviewedAt   DateTime?
  reviewNotes  String?
  deliveredAt  DateTime?
  createdAt    DateTime @default(now())
  items        RecommendationItem[]
  @@index([projectId, createdAt])
}

// normalized mirror of payload rows, so we can query/join/enforce entitlement
model RecommendationItem {
  id            String @id @default(cuid())
  runId         String
  run           RecommendationRun @relation(fields: [runId], references: [id])
  competitionId String
  rank          Int
  score         Float
  reason        String                       // concise "why this fits"
  fitBucket     String?                      // REACH | TARGET | SAFETY
  state         ItemState @default(RECOMMENDED)
  detail        Json                         // per-item jsonb snapshot
  activatedAt   DateTime?
  @@unique([runId, competitionId])
}

// ---------- verification (enrolled only) ----------
model VerificationEvent {
  id            String @id @default(cuid())
  competitionId String
  milestoneId   String?
  trigger       String                       // PRE_ACTIVATION | PERIODIC | PRE_MILESTONE | MANUAL
  sourceUrl     String
  fetchedAt     DateTime @default(now())
  extracted     Json                         // what the LLM read off the official page
  diff          Json                         // proposed changes vs stored
  status        VerifyStatus @default(PENDING_REVIEW)
  reviewedById  String?
  reviewedAt    DateTime?
}

// ---------- TOF ----------
model Lead {
  id            String @id @default(cuid())
  emailNormalized String @unique             // enforces one-report-per-email
  email         String
  name          String
  phone         String?
  grade         String?
  school        String?
  city          String?
  country       String?
  source        String?
  firstReportRunId String?                   // resend this, never regenerate
  reportGeneratedAt DateTime?
  crmSyncedAt   DateTime?
  createdAt     DateTime @default(now())
}

model EmailSend {
  id         String @id @default(cuid())
  toEmail    String
  journey    String                          // TOF_NURTURE_8 | ENROLLED_EXTENSION_5
  step       Int
  scheduledAt DateTime
  sentAt     DateTime?
  status     String
  providerId String?
  @@index([toEmail, journey, step])
}

model AuditLog {
  id        String   @id @default(cuid())
  actorId   String?
  action    String                           // REC_APPROVED, COMP_ACTIVATED, DATE_UPDATED...
  entity    String
  entityId  String
  before    Json?
  after     Json?
  createdAt DateTime @default(now())
}
```

**Why both `payload` jsonb and normalized items:** the requirement is that every
generated recommendation is stored as jsonb — `payload` is the immutable, complete,
reproducible artifact (what the model produced, verbatim). `RecommendationItem` is a
derived index so entitlement, activation, and reporting can be enforced with SQL
instead of JSON gymnastics. Payload is never mutated; state lives on items.

---

## 4. Competition ingestion → ChromaDB

### 4.1 CSV ingest (`packages/ingest`)
1. Read masterlist CSV → validate each row with a zod schema → report rejects, never silently drop.
2. Upsert `Competition` by `slug` (slugified name + cycle). Keep raw row in `source`.
3. Parse milestone columns into `CompetitionMilestone` rows — **column-agnostic**: any
   column matching a milestone pattern becomes a milestone; unknown/extra rounds are fine.
4. Compute `embeddingHash = sha256(docText)`; only re-embed when it changes.

### 4.2 Document text (what goes into Chroma)
Only **public-safe** fields — internal notes/guidance/winning submissions are never embedded,
so they cannot leak through retrieval into a TOF response:

```
{name} ({organiser})
Domains: {domains}
Project types: {projectTypes}
Who it's for: grades {minGrade}-{maxGrade}, {countries}, team size {min}-{max}
What it rewards: {publicSummary}
Prestige {prestige}/5 · Selectivity {selectivity}/5 · Effort: {timeInvestment}
Cycle {currentCycle}
```

### 4.3 Chroma collection
- Collection: `competitions_v{n}` (versioned; re-index = new collection + atomic alias swap, no downtime).
- Embeddings: computed server-side by us (not Chroma's default) so the model is pinned and swappable.
- Metadata stored per doc for **hard prefiltering** in the `where` clause:
  `{ competitionId, slug, domains, projectTypes, minGrade, maxGrade, countries, teamSizeMax, cycleActive, deadlineEpoch, prestige, selectivity }`

---

## 5. Recommendation pipeline (shared by both personas)

```
project (domain + description)
   │
   ├─ 1. CLASSIFY (LLM)  → { subdomains[], projectType, maturity, keywords[], effortCapacity }
   │
   ├─ 2. RETRIEVE (Chroma)  query = embed(description + classification)
   │        where = { cycleActive: true, domains ∈ ..., } , n_results = 30
   │
   ├─ 3. HARD FILTER (SQL, authoritative)
   │        grade/age, geography, team size, cycle active, deadline not passed
   │        → anything failing a hard filter is dropped, never "soft-scored down"
   │
   ├─ 4. RERANK (LLM, structured output)
   │        soft signals: domain fit, project type fit, maturity fit,
   │                      prestige, selectivity, complexity, time investment
   │        → ranked list + one-sentence reason each + REACH/TARGET/SAFETY bucket
   │        → constrained to the candidate ids ONLY (cannot invent competitions)
   │
   ├─ 5. POLICY APPLY
   │        TOF: pin CREST Gold at #1, cap 5–8, strip internal fields
   │        ENROLLED: ~5, keep internal fields, status = PENDING_REVIEW
   │
   └─ 6. PERSIST  RecommendationRun.payload (jsonb) + items + retrievalTrace
```

**Anti-hallucination:** step 4 receives an id-keyed candidate list and must return ids.
Any id not in the candidate set is discarded before persistence. Nothing outside the
Masterlist can ever appear in a report.

**No web search in the TOF path** — enforced by `policy.allowsWebVerification === false`
at the service boundary, not by prompt instruction.

---

## 6. TOF flow (public matcher)

1. `/matcher` — one promise, two inputs: project domain (select) + one-sentence description.
2. `POST /api/public/match` → runs pipeline → returns:
   - **CREST Gold Award card, fully visible** (the free sample), deadline/rolling status read
     from the competition record so it's editable without a deploy.
   - N locked cards: name hidden or teased, blurred, "unlock with your details".
3. Lead gate form: name, email, phone, grade, school, city/country.
4. `POST /api/public/leads`:
   - normalize email → if a `Lead` with a `firstReportRunId` exists, **resend the original
     report**, do not regenerate (repository protection).
   - else attach the run to the lead, mark `DELIVERED`, email the 5–8 competition report immediately.
   - push lead + `source`, `reportGeneratedAt`, `hasUsedMatcher` into Urja's nurture sequence.
5. Schedule `TOF_NURTURE_8` (Days 1, 3, 6, 9, 12, 15, 18, 21) unless the CRM owns sending —
   decide at integration time (see open questions).

**Repository protection controls**
- No list/browse/search endpoint exists publicly. Only `POST /match` and `POST /leads`.
- Response DTO is an allowlist serializer; internal fields are physically absent, not just hidden.
- Cap enforced server-side (`min(policy.maxResults, 8)`).
- Rate limits: per IP, per email, per fingerprint; captcha-free but throttled.
- Locked cards return **no** competition name/url until the gate is passed.

---

## 7. Enrolled flow (Competition OS)

### 7.1 Recommendation → approval → selection → activation
1. AI produces run → `PENDING_REVIEW`.
2. **Internal console** (`/internal/reviews`): team sees candidates, reasons, retrieval trace,
   can drop/reorder/edit reasons, then Approve or Reject. Nothing reaches the client first.
3. Approved run is shown to the client (student/parent portal).
4. Client selects competitions — UI hard-blocks beyond `ProgramEnrolment.competitionAllowance`;
   API re-validates. Over-allowance items stay visible as `RECOMMENDED` with an upgrade prompt.
5. Selected → `ACTIVE`: written to the "Competitions Recommended"/active-support field,
   and only then do guidance, templates, tasks, deadline tracking and reminders unlock.

**Entitlement is enforced in one place** (`entitlement.assertCanActivate(studentId, runId)`)
so recommendation count and paid access can never drift into each other.

### 7.2 Dynamic milestones
- A competition has *any number* of milestones of *any type*; adding, renaming or removing
  one is data, never a migration.
- `getNextMilestone(activeItem)` drives reminders and LMS tasks.
- Milestones flagged `activatesOnQualification` stay hidden until the student is marked
  qualified — later rounds don't clutter the workflow from day one.

### 7.3 Web verification with human approval
Triggers: **pre-activation**, periodic sweep for active competitions, and again N days before
any upcoming milestone.

```
fetch officialUrl → LLM extract cycle + milestones (structured) → diff vs stored
   ├─ no change            → VerificationEvent NO_CHANGE, bump lastVerifiedAt
   ├─ change detected      → status PENDING_REVIEW, flagged in internal console
   │                         (stored dates are NEVER auto-overwritten)
   ├─ human approves       → diff applied, becomes new source of truth, AuditLog written
   └─ cannot verify / fetch fails → milestone status AWAITING_VERIFICATION (never guess)
```

### 7.4 LMS — Rollout 2 (tracker ships first)
The LMS integration is explicitly **second rollout**. Rollout 1 ships the full enrolled flow
against the tracker; nothing about the core changes when the LMS lands, because activation
writes to an **integration port**, not to a specific system:

- **`LmsSink` — Rollout 2:** each activated competition creates a pathway/card carrying name+cycle,
  current stage, next verified milestone + date, full dynamic timeline, current-stage
  submission requirements, official link, internal guidance links, status, student tasks,
  and a reminder schedule derived from the real milestone structure.
- **`SheetSink` — Rollout 1:** the same activation writes rows to the Master Sheet /
  Competition Tracker, keeps milestones + verification status there, and sends reminders by
  email/WhatsApp. **Stable competition + milestone ids are used from day one**, so migrating
  to the LMS later is a new adapter, not a rebuild.

`ActivationSink` interface with `SheetSink` (Rollout 1) and `LmsSink` (Rollout 2); config picks one.
Rollout 2 is an adapter plus a backfill script — no schema migration, no re-recommendation.

---

## 8. Competition AI — the chatbot

A conversational layer over the same competition knowledge base. Same corpus, same Chroma
collection, same anti-hallucination rules as the recommender — it is a second *interface*
to the repository, not a second source of truth.

### 8.1 What it is for
- **TOF:** "Is my daughter in grade 9 eligible for IRIS?", "What's the difference between
  CREST Gold and Silver?", "How long does a S.T. Yau submission take?" — answered from
  public-safe fields only, then steered toward the matcher / consultation CTA.
- **Enrolled:** "What do I need to submit for IRIS Round 1?", "When is my next deadline?",
  "How should I frame the abstract?" — answered with full internal CreatED guidance, but
  **only for competitions the student has activated**.

### 8.2 Architecture — tool-using agent, not a prompt-stuffed bot
The model gets a small tool surface and retrieves what it needs, so answers stay grounded
and the context stays small:

| Tool | TOF | Enrolled | Returns |
|---|---|---|---|
| `search_competitions(query, filters)` | ✅ (public fields) | ✅ (full) | Chroma semantic search + metadata prefilter |
| `get_competition(id)` | ✅ (public DTO) | ✅ (full DTO if activated, else public) | one record + milestones |
| `get_eligibility(id, studentContext)` | ✅ | ✅ | deterministic eligibility check, not an LLM guess |
| `get_my_recommendations()` | ❌ | ✅ | latest approved run |
| `get_my_milestones()` | ❌ | ✅ | next milestones + verification status for active comps |
| `get_guidance(id)` | ❌ | ✅ **activated only** | internal templates, checklists, past-cycle notes |

**The DTO layer is the security boundary, reused verbatim from §6/§7.** The chatbot cannot
return a field the REST API wouldn't return to that persona, because it calls the same
serializers. Prompt instructions are a second line of defence, never the first.

### 8.3 Grounding rules
- Answers must cite the competition record(s) they came from; the UI renders them as
  source chips linking to the official URL.
- If retrieval returns nothing relevant, the bot says so and offers the matcher or a
  consultation — **it never answers a competition question from model priors**. Enforced by
  a post-check: a response naming a competition not present in the turn's tool results is
  regenerated once, then falls back to the "I don't have that in our repository" reply.
- Dates are always read from the record with their `lastVerifiedAt`, and the bot surfaces
  staleness ("verified 3 weeks ago — confirm on the official site") rather than asserting.
- `AWAITING_VERIFICATION` milestones are reported as unverified, never as fact.

### 8.4 Repository protection (TOF)
The chatbot is the most obvious way to strip-mine the repository, so it is the most
constrained surface:
- Turn cap per anonymous session; per-IP and per-fingerprint rate limits.
- `search_competitions` returns at most 3 records per call and at most ~8 distinct
  competitions per session — the same cap as the report, tracked session-wide.
- Enumeration guard: a session whose queries look like a sweep ("list all", repeated
  broad queries, alphabetical probing) gets the lead gate instead of more results.
- Internal notes, guidance, winning submissions and winner analysis are **not embedded**
  (§4.2) and not reachable by any TOF tool — they cannot leak through retrieval.
- No competition ids or internal slugs in public responses.

### 8.5 Implementation notes
- **Model:** `claude-opus-5` with adaptive thinking (`thinking: {type: "adaptive"}`) and
  `output_config.effort` tuned per persona — `low`/`medium` for TOF Q&A, `high` for enrolled
  strategy questions. Streamed responses (`.stream()` + `getFinalMessage()`).
- **Loop:** the Anthropic TypeScript SDK's tool runner (`client.beta.messages.toolRunner`
  with `betaZodTool`) rather than a hand-written loop — the tools above are our own
  functions, and the per-turn hooks give us the approval/logging/cap-enforcement points.
- **Prompt caching:** system prompt + tool definitions are frozen and cached; only the
  conversation varies. Verify with `usage.cache_read_input_tokens`.
- **Persistence:** `ChatSession` + `ChatMessage` tables (message content and tool-call
  trace stored as jsonb), so conversations are auditable and a TOF session can be attached
  to a `Lead` retroactively when the gate is passed.
- **The bot does not create recommendations.** If a chat conversation warrants a full set,
  it triggers the §5 pipeline, which persists a normal `RecommendationRun` — one code path
  for every recommendation, one jsonb format, one approval gate.

```prisma
model ChatSession {
  id         String @id @default(cuid())
  userId     String?
  leadId     String?
  anonId     String?                       // pre-gate TOF sessions
  persona    Persona
  turnCount  Int     @default(0)
  competitionsSeen String[]                // session-wide exposure cap
  createdAt  DateTime @default(now())
  messages   ChatMessage[]
}

model ChatMessage {
  id         String @id @default(cuid())
  sessionId  String
  session    ChatSession @relation(fields: [sessionId], references: [id])
  role       String                        // user | assistant
  content    Json                          // content blocks, verbatim
  toolTrace  Json?                         // tool calls + results, for audit/debug
  citations  Json?
  createdAt  DateTime @default(now())
}
```

---

## 9. Google Sheet roster sync (the differentiator)

- Cron: **every 5 hours** (BullMQ repeatable job, `0 */5 * * *`), plus a manual "Sync now" button.
- Auth: Google service account with viewer access to the sheet (Sheets API v4).
- Read student email + parent email + program type + competition allowance columns.
- Normalize: lowercase, trim, strip `+tags`, collapse gmail dots — matching must not fail on formatting.
- Diff-based upsert into `EnrolledRosterEntry`; entries missing from the sheet are marked
  `active = false` (soft), never hard-deleted.
- After each sync, re-resolve persona for affected users:
  - not-enrolled → enrolled: **upgrade** the user, keep their TOF history, surface the enrolled UI.
  - enrolled → not-enrolled: do **not** silently downgrade an active student; flag for internal
    review (a sheet edit or an export glitch should never revoke paid access).
- Failure handling: a failed sync leaves the previous roster intact (last-known-good) and alerts;
  it never empties the roster.
- Match on **either** student or parent email — parents often sign up, not kids.

---

## 10. Auth (simple JWT)

- `POST /auth/signup` → create user, `persona = resolvePersona(email)` at that instant.
- `POST /auth/login` → access token (15m, in memory) + refresh token (30d, HttpOnly SameSite=Lax cookie).
- JWT claims: `sub`, `role`, `persona`, `ver` (bumped to force logout).
- Persona is re-checked from the DB on each request (claim is a hint, DB is authority) so a
  sheet sync takes effect without forcing re-login.
- Internal console behind `role ∈ {INTERNAL, ADMIN}`.
- TOF users are **not** required to have an account at all — the public matcher is anonymous
  until the lead gate. Signup exists for people who want a portal.

---

## 11. Jobs

| Job | Schedule | Purpose |
|---|---|---|
| `roster.sync` | every 5h | Google Sheet → `EnrolledRosterEntry`, persona re-resolution |
| `competitions.reindex` | on ingest / nightly | re-embed changed docs into Chroma |
| `verification.sweep` | nightly | re-verify active competitions |
| `verification.preMilestone` | daily | verify anything with a milestone in the next 14 days |
| `reminders.dispatch` | daily | student/team reminders off the real milestone structure |
| `email.journey` | hourly | send due `EmailSend` rows for both journeys |
| `leads.crmSync` | on create + retry | push lead into Urja's sequence |

---

## 12. Build phases

### Rollout 1 — the platform (no LMS)

**Phase 0 — foundation (infra + shape)**
monorepo, docker-compose (postgres/redis/chroma), Prisma schema + migrations, JWT auth,
persona resolver + policy table, health checks.

**Phase 1 — competition repository**
CSV ingest + zod validation, milestone parsing, admin CRUD, Chroma indexing, versioned
collection + alias swap. *Blocked on receiving the masterlist CSV — see §14.*

**Phase 2 — recommendation engine**
classify → retrieve → hard filter → LLM rerank → policy → persist jsonb + items +
retrieval trace. Golden-set eval harness (see §13).

**Phase 3 — TOF flow**
public matcher page, CREST pinning, locked cards, lead capture, one-report-per-email,
report rendering + immediate email, CRM handoff, rate limiting, DTO allowlist.

**Phase 4 — Enrolled flow**
internal review console, client portal, entitlement + selection + activation,
`ActivationSink` → `SheetSink` (Master Sheet / Competition Tracker).

**Phase 5 — verification + milestones**
official-source fetch, LLM extraction, diff, human approval queue, AWAITING_VERIFICATION
states, audit log, reminder scheduling off next milestone.

**Phase 6 — Competition AI chatbot**
tool surface over the existing DTOs, grounding + citation post-check, TOF caps and
enumeration guard, chat persistence, streaming UI on both sides.

**Phase 7 — email journeys**
8-email TOF nurture, 5-email enrolled extension (scope depends on the Urja decision, §14).

**Phase 8 — hardening**
observability, backup/restore of Chroma, load test the matcher and the chatbot,
abuse review, runbook.

### Rollout 2 — LMS

**Phase 9 — `LmsSink`**
pathway/card creation per activated competition, task + reminder sync, guidance link
surfacing, backfill of already-active competitions.

**Phase 10 — chatbot inside the LMS**
same chat service mounted in the LMS context, scoped to the pathway the student is viewing.

Rollout 2 needs no schema migration and no re-run of recommendations: stable competition
and milestone ids from Phase 1 mean the LMS reads what the tracker already holds.

---

## 13. Quality: how we know the recommendations are good

- **Golden set:** the existing 2026 Competition Tracker gives ~75 real student projects with
  human-chosen competitions (e.g. "S.T. Yau 2026, Crest, IRIS 2026"). Use it as a regression
  suite: measure recall@5 of the human choice, and diff on every prompt/model/embedding change.
- **Hard-filter tests:** an ineligible competition must never appear (grade, geography, team
  size, closed cycle) — unit-tested per rule.
- **Leak tests:** assert the TOF response DTO contains no internal field, for every competition —
  run against the chatbot's tool outputs too, since it shares the serializers.
- **Chatbot grounding tests:** a fixed question set where the answer is not in the corpus must
  produce the "not in our repository" reply, never a plausible invention; and a set of
  eligibility questions checked against the deterministic `get_eligibility` result.
- **Determinism:** pin model id + temperature 0 for reranking; store `promptHash` + `modelId`
  on every run so any output is reproducible and explainable.

---

## 14. Risks, dependencies, open questions

**Blocking (needed before Phase 1):**
1. **The competition masterlist CSV.** Not present in the working directory — I found the
   *student* tracker (`2026 Competition Tracker - IRIS 2026.csv`) and the Master Sheet, but not a
   competition-level file with eligibility, deadlines, official URLs and milestones. Please
   point me at it. Column semantics matter for milestone parsing.
2. **Google Sheet identity** — sheet id, tab, exact email column(s), and whether a
   "competitions included in package" column exists (entitlement depends on it; if absent we
   default to a per-program constant).
3. **LMS API** — now confirmed as Rollout 2, so not blocking. Still needed *before Rollout 2
   starts*: API surface, auth model, and whether pathway cards are created by API or by import.

**Non-blocking decisions to confirm:**
4. Who sends the nurture emails — our `email.journey` job, or Urja's tool once the lead lands?
   (Affects Phase 3/6 scope; recommend Urja owns nurture, we own the instant report.)
5. Embedding model choice + cost (corpus is small, so cost is negligible; latency matters more).
6. Whether an enrolled student's *parent* email should also unlock the enrolled flow (assumed yes).

**Technical risks:**
- *Official-site scraping is brittle.* Mitigated by never auto-overwriting, always producing a
  human-reviewable diff, and falling back to `AWAITING_VERIFICATION`. Sites that block bots get
  flagged for manual verification rather than silently failing.
- *Small corpus ⇒ semantic search alone under-performs.* Mitigated by hybrid retrieval
  (vector + metadata prefilter + keyword) and the LLM rerank stage.
- *Chroma persistence.* Chroma is a derived index, never the source of truth — Postgres is.
  Full rebuild from Postgres must be a single command.
- *Persona churn* from sheet edits — mitigated by never auto-downgrading an active student.

---

## 15. Definition of done (merged from both docs)

**TOF**
- Two inputs produce a match; CREST appears first; additional matches are locked behind lead
  capture; one email cannot mine the repository repeatedly; a 5–8 competition report is emailed;
  the lead enters the nurture flow.

**Enrolled**
- Several good-fit competitions are recommended without granting paid access to all of them;
  program entitlement controls how many can be activated; the client chooses which; only
  activated competitions unlock CreatED support materials; timelines support any number and type
  of milestone and can change over time; official sources re-verify dates with human approval
  before updates become authoritative; the workflow runs in the LMS *or* the contingency tracker.

**Competition AI chatbot**
- Answers competition questions grounded in the repository with citations; refuses rather than
  invents when the corpus has no answer; a TOF session cannot be used to enumerate the
  repository; an enrolled student gets internal guidance only for activated competitions.

**Unified**
- One signup path; the roster sync (every 5h) alone decides which experience a user sees;
  a user's persona flips correctly when the sheet changes; every generated recommendation set
  is persisted as jsonb and is reproducible.
