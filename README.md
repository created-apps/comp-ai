# CreatED Competition AI

One platform serving two flows. A cron syncs the enrolled-students Google Sheet every
5 hours; on signup the user's email is checked against that roster. A hit opens the
**Enrolled Competition OS**, a miss opens the **TOF matcher**. Same codebase, same
competition repository, same recommendation engine — one `PersonaPolicy` object
switches the behaviour.

See [PLAN.md](PLAN.md) for the full architecture, data model and rollout plan.

## Status

| Piece | State |
|---|---|
| Competition ingest → Chroma Cloud (region-tagged) | ✅ working, tested on the real sheets |
| Prisma schema (full domain) | ✅ written |
| Persona resolution + policy | ✅ working, tested |
| JWT auth (signup/login/refresh/me) | ✅ working |
| Roster sync + CSV import | ✅ written |
| Admin console `/admin` (persona toggle) | ✅ working |
| Competition DTO / leak boundary | ✅ written |
| Region-scoped retrieval client | ✅ written |
| Postgres seed from ingest JSON | ✅ written |
| Recommendation pipeline | ✅ built (classify → retrieve → filter → rerank → policy → jsonb) |
| Frontend wired to the pipeline | ✅ project form → run → results |
| Top-3 picks per enrolled student (6 columns) | ✅ nightly job |
| Email worker (Redis → SendGrid) | ✅ both flows, 13 emails |
| Auto-fire email journey on signup | ✅ persona picks the flow (Flow 2 gated on project name) |
| Sheet → student profile + project | ✅ in the 5-hourly roster sync |
| TOF lead-capture gate | ✅ server-side redaction + one report per email |
| Internal review console | ✅ queue + approve/reject, email-notified |
| Competition AI chatbot | ✅ enrolled only, tool-grounded |
| Web verification (search-based, no URL needed) | ✅ built, human-approval queue |
| Google Sheets roster cron (5h) | ✅ built (`npm run roster:sync` or in-process) |
| Entitlement + selection + activation | ✅ built (admin-set allowance, one enforcement point) |
| Auto-assignment to the kid in COSMIC | ✅ built (templates sync + queued assignment + retry) |
| LMS adapter | ⬜ Rollout 2 |

## Layout

Two independent projects, not a monorepo — each installs and deploys on its own:

```
backend/       Node + TypeScript + Fastify + Prisma   (port 4000)
frontend/      Next.js                                 (port 3000)
email-worker/  Redis queue consumer → SendGrid
ingest/        Python: CSV → normalized JSON → Chroma Cloud
data/          sheet exports (gitignored) + normalized JSON
```

## Getting started

Each project owns its own environment file — there is no shared root `.env`:

```bash
cp backend/.env.example      backend/.env       # DB, JWT secrets, Chroma, Anthropic key, ADMIN_PASSWORD
cp ingest/.env.example       ingest/.env        # Chroma Cloud credentials
cp email-worker/.env.example email-worker/.env  # SendGrid key, same REDIS_URL as the backend
cp frontend/.env.local.example frontend/.env.local

docker compose up -d                     # postgres + redis (Chroma is cloud-hosted)
```

`backend/.env` and `ingest/.env` must point at the **same** Chroma tenant, database and
collection — the ingest writes it, the backend reads it. Mismatched values fail as
"search returns nothing", with no error anywhere.

**1. Ingest the competition sheets.** Put the two exports in `data/`, then:

```bash
cd ingest
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python ingest_competitions.py \
  --india "../data/Masterlist Competitions - India.csv" \
  --us    "../data/Masterlist Competitions - US.csv" --dry-run
```

Read the data-quality report, then drop `--dry-run` to push to Chroma Cloud (reads
`CHROMA_TENANT` / `CHROMA_DATABASE` / `CHROMA_API_KEY`). Details in
[ingest/README.md](ingest/README.md).

**2. Set up the database, seed competitions, load the roster.**

```bash
cd backend
npm install
npx prisma migrate dev --name init
npm run seed:competitions -- ../data/competitions.normalized.json
npm run roster:import   -- "../data/<enrolled students export>.csv"   # from a CSV export
npm run roster:sync                                                   # or straight from Google Sheets
```

For the Sheets path, base64-encode the service account key into
`GOOGLE_SERVICE_ACCOUNT_JSON` and share the sheet with its `client_email`:

```bash
base64 -i service-account.json | tr -d '\n'
```

**3. Run the backend.**

```bash
npm run dev          # http://localhost:4000/health
npm test             # persona + policy tests
npm run typecheck
npm run db:status    # are any migrations unapplied?
```

**Changing `schema.prisma` always needs a migration.** `prisma generate` updates the
client's *types* only — code then compiles cleanly and fails at runtime with
"The column X does not exist in the current database". Run `npm run db:migrate` after
every schema edit. `/health` reports `pendingMigrations`, and the server logs an error at
boot when the database is behind.

**4. Run the frontend.**

```bash
cd frontend
npm install
cp .env.local.example .env.local     # NEXT_PUBLIC_API_URL=http://localhost:4000
npm run dev                          # http://localhost:3000
```

- `/` — one entry point; the session persona decides which flow renders
- `/login` — signup asks only for name, email and password
- `/admin` — internal console, gated by `ADMIN_PASSWORD`, toggles accounts between TOF and ENROLLED

**5. Run the email worker.**

```bash
cd email-worker
npm install
npm run preview      # render all 13 emails to preview/index.html, send nothing
npm run dev          # consume the queue and send via SendGrid
```

**6. Connect COSMIC, so a selected competition lands on the kid.**

COSMIC is the system the student actually works in. Selection in this app creates their
competition workspace there — but only once both sides are wired up.

In COSMIC (`/Users/sr/cosmic`): apply `migrations/add_comp_ai_integration.sql`, then create
a user with `role=manager` for this service. Its address and password go in `backend/.env`
here as `COSMIC_SERVICE_EMAIL` / `COSMIC_SERVICE_PASSWORD`.

```bash
cd backend
npm run cosmic:sync-templates    # every active competition → a COSMIC competition template
```

Then set `COSMIC_PUSH_ENABLED=true`. Until you do, selection still works and every
assignment queues; switching it on drains the backlog on the next tick of
`COSMIC_RETRY_CRON` (or from `/admin` → COSMIC assignments → "Push the queue now").

## Key files

```
backend/prisma/schema.prisma        full domain model
backend/src/lib/persona.ts          THE differentiator: roster lookup → policy
backend/src/modules/roster/sync.ts  roster diff + persona reconciliation, with guards
backend/src/modules/roster/google-sheets.ts  service account auth + Sheets read
backend/src/modules/admin/routes.ts admin API (password-gated persona toggle)
backend/src/modules/retrieval/      Chroma Cloud client, region-scoped search
backend/src/modules/competitions/   DTO leak boundary + Postgres seed
backend/src/modules/recommend/      the pipeline: classify · eligibility · rerank · policy
backend/src/modules/verification/   web-search verification + approval queue
backend/src/modules/recommend/top-picks.ts   nightly top-3 + why, for the email merge
backend/src/modules/entitlement/    allowance, selection, activation — one enforcement point
backend/src/modules/cosmic/         COSMIC client, assignment push, template sync, retry job
backend/src/modules/email/          queue publisher + journey timing
email-worker/src/templates/         the approved copy for both flows
email-worker/src/render.ts          blocks → HTML + text, with merge guards
frontend/components/project-form.tsx        two-input project capture
frontend/components/recommendation-list.tsx results, with TOF locking and enrolled selection
frontend/components/my-competitions.tsx     what the student activated, and whether it is set up
frontend/app/admin/page.tsx         admin console
frontend/lib/api.ts                 API client (in-memory token + silent refresh)
ingest/normalize.py                 all sheet parsing, unit-tested
```

## Four invariants worth knowing before you change anything

**Postgres is the source of truth. Chroma is a rebuildable index.** Nothing reads a
fact from Chroma that isn't in Postgres. `--reset` rebuilds the whole collection from
the sheets.

**`toPublicDto` is the leak boundary.** It is an allowlist, so a new column on
`Competition` is private by default. Winner lists, internal notes and comments are also
excluded from the embedded document, which means they aren't reachable by retrieval —
the public matcher and the public chatbot cannot surface them regardless of prompt.

**Chroma metadata keys are fixed, never per-value.** Cloud caps them at 32 per document.
Domains live in one delimited string, not as one boolean each, and domain is not a
retrieval filter — most competitions have no domain recorded, so filtering on it would
hide the repository rather than narrow it.

**Region is a retrieval tag, not a filter applied afterwards.** Each sheet row is its own
Chroma document with a region-qualified id (`crest-awards--in`) and a `region` tag of
`India` or `USA`. Students give their country at signup, so a competition listed in both
sheets never serves an Indian student the US listing's eligibility text.

**A stored official URL is not required.** Only 19 of 237 rows have one. Verification runs a
live web search from the competition's own details and finds the official source itself; a
stored URL is a hint. Nothing in the pipeline gates on it.

**Signup verifies against the live sheet, not just the mirror.** The roster table is
refreshed every five hours, so on its own it has a five-hour window where a student added
this morning would be handed the public flow. Signup checks the mirror first and, only on
a miss, asks the sheet itself — writing a hit straight back to the roster. It never blocks:
if Google is down, the local answer stands and the account is still created.

**Never put length or range limits in a structured-output schema.** The SDK validates the
model's response against the zod schema and throws, so a single `.max(320)` reason running
30 characters over discarded a whole run — seven good recommendations and ~35 seconds of
model work. Schemas describe shape, prompts ask for brevity, and `lib/clamp.ts` enforces
limits after parsing where being wrong costs nothing.

**The lead gate is enforced in the response body, not the UI.** Before a lead is captured,
a TOF response carries the free sample in full and strips every other match to a rank and a
fit bucket — no name, slug, deadline or reason. Hiding locked cards in CSS would have left
every match readable in devtools.

**Profile capture happens at the gate, not at signup.** Name, phone, grade, school, city and
country (US / India / Others) are asked for once the student has seen a real match worth
trading details for. The details are written to both the Lead and the Student, so country and
grade sharpen any later run for that account.

**A TOF report is generated once and then frozen.** After the first report is emailed, every
later sign-in loads that same run and `POST /recommendations` returns it instead of building
a new one. The copy in the inbox and the copy on screen must stay the same document, and
re-running would let one address mine the repository project by project.

**An enrolled signup is asked about the project we already hold.** The roster row carries a
Project Name and Description, so signup copies it onto the new account as a `SHEET` project
and the app asks "is this the project you want to continue with?" before matching anything.
Our record of what a student built is not the same as their decision about what to take
forward, so it stays unconfirmed until they say so. Dismissing it keeps the row (the sync
would recreate it anyway) but stops it driving recommendations or emails.

**Flow 2 never sends without a project name.** Four of its five emails name the project,
so the journey is deferred — not cancelled — until a real name exists in the database. It
starts automatically the moment one arrives, from the roster sync or from the app. Flow 1
has no such dependency.

**The sheet is the programme record; the app is the student's.** The roster sync writes
the student name, parent name and project from the sheet onto real accounts, but only
fills gaps — and it only ever touches projects marked `source: 'SHEET'`, so a project a
student wrote in the app is never overwritten by a stale row.

**A blank optional env var means unset.** `.env` files ship keys with empty values, so a
plain zod `.optional()` yields `""`, and `??` does not treat `""` as missing — that turned a
blank `EMAIL_REDIRECT_TO` into an empty recipient and a SendGrid 400. Both configs normalise
blank to `undefined`, so `??`, `||` and `!value` all agree.

**The backend publishes email; it never sends it.** SendGrid credentials exist only in
`email-worker`. A provider outage queues work instead of failing a signup, and an email
whose merge variables are incomplete fails permanently rather than reaching a family
half-filled.

**Rejecting regenerates, using the note as a correction.** The reviewer's note is fed to the
ranker on the replacement run — regenerating without it would produce the same list and earn
the same rejection. The classification is recomputed too, since "these are wrong" often means
the project was read wrongly. Capped at 5 runs per project: past that, something needs
editing rather than another roll.

**Nothing reaches a family until a person approves it.** An enrolled run is created
`PENDING_REVIEW`; the student sees "your matches are with the CreatED team" and the API
returns 409 rather than the payload. `INTERNAL_REVIEW_EMAILS` is emailed at that moment with a
"View competition details" button linking to `/admin/reviews/<id>` — a review queue nobody is
told about is a queue nobody opens, and the student waits indefinitely.

**Competition AI answers only from tool results.** It is a tool-using agent, not a prompt
stuffed with the repository, and every tool returns data through the same DTO serializers the
REST API uses — so it cannot surface a field the API would not. Enrolled students only: the
route refuses anyone else rather than serving a half-safe public variant.

**Retrieval is deterministic per project.** `k = 30` candidates from Chroma, hard-filtered in
SQL, then cut to the persona cap (5 enrolled / 8 TOF). The classification — which produces the
retrieval query — is computed once and stored on the project, so the same project retrieves the
same candidates every run. Pass `reclassify: true` after the project text changes.

**A row with nothing but a name is not recommendable.** Five masterlist rows have no
description, submission details or subject — one is a bare URL. Their embedded documents are
near-noise, so they match weakly against everything and surface as candidates the ranker can
only caveat ("thinly described … fit cannot be verified"). Eligibility rejects them
(`NO_CONTENT`), and anything the ranker scores under 35 is dropped rather than shown. Three
real matches beat eight with five apologies among them.

**Missing data stays missing.** Scores are blank for many competitions and deadlines are
often month-precision or rolling. Every parser returns null rather than a default, and
the deadline carries its own precision. A guessed date would end up in a student
reminder; `AWAITING_VERIFICATION` is the correct answer instead.

**Entitlement is counted per student, never per run.** A project can be re-run any number
of times, so counting selections against the run being viewed would hand out a fresh
allowance with every regeneration. `getEntitlement` counts distinct competitions in
`SELECTED`/`ACTIVE` across every run the student owns, and `selectCompetitions` is the only
place the limit is applied — recommendation count and paid access must not drift into each
other. The allowance itself is set by hand in `/admin`: the sheet's package column is not
reliably filled, and a wrong number either blocks a paying family or gives work away.

**Selection activates immediately; the internal gate already happened.** A student can only
select from an `APPROVED` run, which is the review a person already did. There is no second
human step between choosing and the workspace existing — but the endpoint re-checks the run
status, so a client pointed at a `PENDING_REVIEW` run cannot route around the gate.

**A competition is assigned to the kid in COSMIC, not just recorded here.** Activation
writes a `CompetitionAssignment` in the same transaction as the state change, and the push
to COSMIC creates both a `competition_enrollments` row (the student's submission workspace)
and a tracker row on their project. comp-ai signs in as a COSMIC user with `role=manager`,
the same posture COSMIC already accepts from SYNC.

**An assignment that cannot land yet waits; it never half-lands.** A kid with no project in
COSMIC gets nothing written there — an enrollment hangs off a project, so assigning without
one would create a workspace with nothing behind it. The row sits at `WAITING_FOR_PROJECT`
(or `WAITING_FOR_STUDENT` when no COSMIC student matches the address) and the retry cron
drains it once the project or the mapping exists. Waiting is not failing, so those states
retry indefinitely while a genuine transport failure stops at `COSMIC_MAX_ATTEMPTS`.

**COSMIC being down cannot cost a student their selection.** The push is fired after the
transaction commits and its failure is recorded on the assignment, never raised at the
student — the same rule the email module follows. With `COSMIC_PUSH_ENABLED=false` selection
works exactly as before and the queue drains when the integration is switched on.

**Every competition in the repository exists as a COSMIC template.** `npm run
cosmic:sync-templates` pushes them up front rather than creating one lazily during the
student's own request. The upsert is keyed on the comp-ai slug, so a competition someone
configured by hand in COSMIC (IRIS 2026) is linked to rather than duplicated, and its
requirement tree is never overwritten — an auto-created template gets a generic three-leaf
default instead, flagged `is_default` so a real tree can replace it.
