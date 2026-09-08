# Competition ingest

Turns the two masterlist sheets (India + US) into a searchable Chroma collection
and a normalized JSON artifact the Node app seeds Postgres from.

## Run it

```bash
cd ingest
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# parse only — no Chroma, no embeddings. Start here on a new export.
python ingest_competitions.py \
  --india ../data/competitions_india.csv \
  --us    ../data/competitions_us.csv \
  --dry-run

# index for real — Chroma Cloud is the default target
export CHROMA_TENANT=... CHROMA_DATABASE=... CHROMA_API_KEY=...
python ingest_competitions.py \
  --india "../data/Masterlist Competitions - India.csv" \
  --us    "../data/Masterlist Competitions - US.csv"

# local alternatives
python ingest_competitions.py --india … --us … --chroma-mode http    # docker-compose
python ingest_competitions.py --india … --us … --chroma-mode local   # persistent dir
```

Always run `--dry-run` first after a fresh export from Sheets and read the data
quality report — it tells you which competitions will match badly and why,
before you spend embeddings on them.

## Flags

| Flag | Purpose |
|---|---|
| `--dry-run` | Parse + write JSON, skip Chroma entirely |
| `--reset` | Drop the collection and rebuild from scratch |
| `--force` | Re-embed everything, ignoring content hashes |
| `--collection` | Collection name (default `competitions_v1`) |
| `--embedding` | `default` (ONNX MiniLM, no torch) · `sentence-transformers` · `openai-compatible` |
| `--chroma-mode` | `cloud` (default) · `http` · `local` |
| `--chroma-tenant` / `--chroma-database` / `--chroma-api-key` | Chroma Cloud credentials (or env vars) |
| `--out` | Normalized JSON path (default `../data/competitions.normalized.json`) |

## Design notes

**Two outputs, one parser.** The script writes `competitions.normalized.json` *and*
indexes Chroma from the same in-memory records. The Prisma seed reads that JSON, so
Postgres and Chroma cannot drift apart — there is exactly one place where a sheet
cell becomes a field.

**Postgres is the source of truth; Chroma is a derived index.** Chroma can be
dropped and rebuilt from the sheets at any time with `--reset`. Nothing in the app
should ever read a fact from Chroma that isn't also in Postgres.

**Internal fields are never embedded.** `Winner List(s)`, `Notes` and `Comments` are
parsed and kept in the JSON for internal use, but excluded from `build_document()`.
This is the primary defence for the public matcher and the public chatbot: private IP
that isn't in the index cannot be retrieved out of it, whatever the prompt says.
`tests/test_normalize.py::test_internal_fields_never_reach_the_embedding_document`
pins that behaviour — don't delete it.

**Missing scores stay missing.** Prestige / Selectivity / Complexity / Time Investment
are blank for many competitions. Every parser returns `None` rather than a default, the
Chroma metadata omits the key entirely, and the report counts how many are unscored.
A zero would quietly rank a competition last; a `None` lets the reranker fall back to
semantic fit and say so.

**Deadlines carry precision.** `15/March/2026` becomes a date; `March/2026` stays
month-precision rather than being guessed to the 1st; `Rolling` is flagged; an
unparseable date becomes `unknown`, which maps to `AWAITING_VERIFICATION` downstream —
never a guess.

**A missing official URL is not a blocker.** Only 19 of 237 rows carry one. Verification
does a live web search from the competition's own details (name, region, subject,
eligibility, last known deadline) and finds the official source itself; a stored URL is
used as a hint, not a requirement.

**Hard filtering does not happen in Chroma.** Metadata carries region plus enough
numeric context to debug a result set. The authoritative eligibility check runs in
Postgres, as SQL. Chroma narrows, SQL decides.

**Metadata keys are fixed, never per-value.** Chroma Cloud caps metadata at 32 keys per
document. An earlier version added one `domain_<name>` boolean per domain, which blew the
quota on the 17 competitions tagged with 5+ subjects (ISEF has 11). Domains are now a single
delimited string and are not filtered on — 109 of 237 competitions have no Subject/Domain
cell at all, so filtering on it would hide most of the repository; the semantic query and
the reranker carry domain relevance instead. `build_metadata` raises if the key count ever
approaches the cap, so this fails locally with the competition named rather than mid-upsert
with a quota error.

**Every row is its own region-tagged document.** The Chroma id is region-qualified
(`crest-awards--in`, `crest-awards--us`) and carries a `region` tag of `India` or `USA`.
A student gives their country at signup, so retrieval filters on that tag directly.
A competition listed in both sheets stays two documents on purpose — the India and US
rows carry different eligibility text, and serving the wrong one would give a student
rules that don't apply to them. `base_slug` groups them when you need the union.

Duplicate rows *within* one sheet still merge, filling gaps from whichever row has the
value and keeping both source rows for audit.

## Tests

```bash
python -m pytest tests -q
```

`tests/fixtures/*.csv` reproduce the real header quirks — embedded newlines in the
`"Prestige (1–5)\n"` headers, en-dashes, trailing unnamed columns, blank rows, and a
competition present in both sheets.

## Re-indexing safely

Changing the embedding backend or the document template changes the vector space.
Don't upsert into the existing collection — bump the version and swap:

```bash
python ingest_competitions.py --india … --us … --collection competitions_v2 --reset
# point CHROMA_COLLECTION at competitions_v2, verify, then drop v1
```
