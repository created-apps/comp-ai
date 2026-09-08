# Email worker

Sends the CreatED competition email flows. Subscribes to the Redis-backed
`emails` queue that the backend publishes to, renders the approved copy, and
delivers through SendGrid.

Runs as its own service. The backend never talks to SendGrid.

## Run it

```bash
cp .env.example .env      # REDIS_URL (same as the backend), SENDGRID_API_KEY, EMAIL_FROM
npm install
npm run dev
```

```bash
npm run preview           # render every email to preview/index.html, send nothing
npm test                  # rendering + merge-variable tests
```

## The flows

| Journey | Emails | Timing |
|---|---|---|
| `TOF_NURTURE_8` | 8 | Days 1, 3, 6, 9, 12, 15, 18, 21 |
| `ENROLLED_EXTENSION_5` | 5 | Days 1, 3, 6, 9, 13 |

Flow 2 step 4 (Day 9) is the one that merges the student's three saved
competitions from `EnrolledTopPicks`:

```
{{Competition 1}} / {{Why it fits 1}}
{{Competition 2}} / {{Why it fits 2}}
{{Competition 3}} / {{Why it fits 3}}
```

The source document numbers Flow 2's emails 1–5 but gives them timings of
Day 1, 9, 6, 3, 13. Sending in document order would deliver the Day 9 email
before the Day 3 one, so steps are ordered by actual timing; the mapping back to
the document's numbering is recorded in `backend/src/modules/email/journeys.ts`.

## Why a queue and not a direct send

BullMQ over Redis, not pub/sub. Pub/sub drops a message when no subscriber
happens to be connected — for a transactional email that means it is simply never
sent and nothing records that it was lost. BullMQ persists the job, retries with
exponential backoff, and keeps failures for inspection.

The backend schedules a whole sequence up front using per-job `delay`, so the
schedule survives a restart and there is no daily "who is due today" cron that
can quietly stop firing. Job ids are `journey:step:email`, which makes enqueueing
the same sequence twice a no-op rather than a duplicate send.

## Design notes

**One source, two parts.** Copy is authored as blocks (`templates/blocks.ts`) and
rendered to both HTML and plain text. A text part that disagrees with the HTML
part is a well-known way to land in spam, and this makes that impossible.

**A half-merged email never sends.** Templates declare `requires`. If a variable
is missing — most importantly `Competition 2` or `Competition 3` — rendering
throws and the job fails permanently rather than retrying. Copy with a blank
where a competition name should be is worse than an email that never arrives.

**No raw placeholders can escape.** `{{Student/Parent Name}}` falls back to the
parent name, then the student name, then "there". Unknown placeholders are
reported, never left in the output as literal `{{...}}`.

**Merge values are HTML-escaped.** Competition names come from a spreadsheet;
they are data, not markup.

**Permanent vs retryable failures are distinguished.** A SendGrid 400/401/403/413
throws `UnrecoverableError` — retrying a malformed payload or a bad address five
times over an hour achieves nothing. Everything else retries with backoff.

**`EMAIL_REDIRECT_TO` is the staging safety valve.** Set it and every message goes
to that inbox instead of the real recipient, with the intended address in the
subject. A copied production database then cannot email real families.

**Contract version.** `src/contract.ts` is a verbatim copy of
`backend/src/modules/email/contract.ts`. Change one, change both, and bump
`CONTRACT_VERSION` — a worker running older code fails the job loudly instead of
silently dropping new fields.
