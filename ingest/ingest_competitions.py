#!/usr/bin/env python3
"""
Ingest the CreatED competition masterlist sheets into ChromaDB.

    python ingest_competitions.py \
        --india ../data/competitions_india.csv \
        --us    ../data/competitions_us.csv

What it does
------------
1. Reads both CSVs, normalizing the messy headers (embedded newlines, en-dashes,
   trailing blank columns) to stable keys.
2. Parses each row into a Competition record (see normalize.py). Missing scores
   stay missing — never defaulted.
3. Merges competitions that appear in both sheets into one record with two regions.
4. Writes `competitions.normalized.json` — the single normalized artifact that the
   Node/Prisma seed also reads, so Postgres and Chroma can never drift apart.
5. Upserts into a versioned Chroma collection, embedding ONLY public-safe text and
   skipping documents whose content hash hasn't changed.
6. Prints a data-quality report: what will match badly, and why.

Run with --dry-run to do everything except touch Chroma (no chromadb install needed).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter
from pathlib import Path

def _load_dotenv() -> None:
    """Load ingest/.env so Chroma Cloud credentials do not have to be exported.

    Hand-rolled rather than pulling in python-dotenv: the format we need is
    KEY=value with optional quotes and # comments, and a real environment
    variable always wins over the file.
    """
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()

from normalize import (
    Competition,
    build_document,
    build_metadata,
    document_hash,
    merge,
    normalize_header,
    row_to_competition,
)

DEFAULT_COLLECTION = "competitions_v1"
BATCH_SIZE = 100


# --------------------------------------------------------------------------
# reading
# --------------------------------------------------------------------------

def read_sheet(path: Path, region: str) -> tuple[list[Competition], list[str]]:
    """Read one CSV into Competition records. Returns (records, problems)."""
    problems: list[str] = []
    if not path.exists():
        raise SystemExit(f"error: sheet not found: {path}")

    with path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        try:
            raw_header = next(reader)
        except StopIteration:
            raise SystemExit(f"error: {path} is empty")

        header = [normalize_header(h) for h in raw_header]
        # the sheets carry trailing unnamed columns; index them so nothing collides
        seen: Counter[str] = Counter()
        for i, h in enumerate(header):
            if not h:
                header[i] = f"_blank_{i}"
                continue
            seen[h] += 1
            if seen[h] > 1:
                header[i] = f"{h}_{seen[h]}"

        if "competition_name" not in header:
            raise SystemExit(
                f"error: {path} has no 'Competition Name' column.\n"
                f"       parsed headers: {[h for h in header if not h.startswith('_blank')]}"
            )

        records: list[Competition] = []
        for line_no, row in enumerate(reader, start=2):
            if not any(cell.strip() for cell in row):
                continue
            row_dict = dict(zip(header, row))
            try:
                comp = row_to_competition(row_dict, region=region, sheet=path.name)
            except Exception as exc:                      # never lose the whole sheet to one bad row
                problems.append(f"{path.name}:{line_no} failed to parse: {exc}")
                continue
            if comp is None:
                problems.append(f"{path.name}:{line_no} skipped: no competition name")
                continue
            records.append(comp)

    return records, problems


def collect(sources: list[tuple[Path, str]]) -> tuple[list[Competition], list[str]]:
    by_slug: dict[str, Competition] = {}
    order: list[str] = []
    problems: list[str] = []

    for path, region in sources:
        records, sheet_problems = read_sheet(path, region)
        problems.extend(sheet_problems)
        for comp in records:
            if comp.slug in by_slug:
                merge(by_slug[comp.slug], comp)
            else:
                by_slug[comp.slug] = comp
                order.append(comp.slug)

    return [by_slug[s] for s in order], problems


# --------------------------------------------------------------------------
# embedding function
# --------------------------------------------------------------------------

def get_embedding_function(kind: str):
    """Pinned and swappable — the embedding model is ours, not an implicit default.

    `default` uses Chroma's bundled ONNX MiniLM (384-dim): no torch, no CUDA, runs
    anywhere. `sentence-transformers` is the same family via torch, for when you
    want a different HF model. Switching backends changes vector dimensionality,
    so always pair a backend change with a new --collection version + --reset.
    """
    if kind == "default":
        from chromadb.utils import embedding_functions
        return embedding_functions.DefaultEmbeddingFunction(), "onnx-all-MiniLM-L6-v2"
    if kind == "sentence-transformers":
        from chromadb.utils import embedding_functions
        model = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
        return embedding_functions.SentenceTransformerEmbeddingFunction(model_name=model), model
    if kind == "openai-compatible":
        from chromadb.utils import embedding_functions
        model = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
        api_key = os.getenv("EMBEDDING_API_KEY")
        if not api_key:
            raise SystemExit("error: EMBEDDING_API_KEY is required for --embedding openai-compatible")
        return embedding_functions.OpenAIEmbeddingFunction(
            api_key=api_key, model_name=model,
            api_base=os.getenv("EMBEDDING_API_BASE") or None,
        ), model
    raise SystemExit(f"error: unknown embedding backend '{kind}'")


def get_client(args):
    """Chroma Cloud is the default target; local modes stay for offline work.

    Cloud needs all three of tenant / database / api key — a partial config is a
    hard error rather than a silent fall back to a local store, which would look
    like a successful ingest into nothing.
    """
    import chromadb

    if args.chroma_mode == "cloud":
        missing = [
            name for name, value in (
                ("CHROMA_TENANT", args.chroma_tenant),
                ("CHROMA_DATABASE", args.chroma_database),
                ("CHROMA_API_KEY", args.chroma_api_key),
            ) if not value
        ]
        if missing:
            raise SystemExit(
                "error: --chroma-mode cloud requires " + ", ".join(missing) +
                "\n       set them in the environment or pass --chroma-tenant / "
                "--chroma-database / --chroma-api-key"
            )
        print(f"  target: Chroma Cloud (tenant={args.chroma_tenant}, db={args.chroma_database})")
        return chromadb.CloudClient(
            tenant=args.chroma_tenant,
            database=args.chroma_database,
            api_key=args.chroma_api_key,
        )

    if args.chroma_mode == "http":
        print(f"  target: Chroma HTTP ({args.chroma_host}:{args.chroma_port})")
        return chromadb.HttpClient(host=args.chroma_host, port=args.chroma_port)

    print(f"  target: local persistent store ({args.chroma_path})")
    return chromadb.PersistentClient(path=args.chroma_path)


def get_collection(args, embedding_fn):
    client = get_client(args)

    if args.reset:
        try:
            client.delete_collection(args.collection)
            print(f"  dropped existing collection '{args.collection}'")
        except Exception:
            pass

    return client.get_or_create_collection(
        name=args.collection,
        embedding_function=embedding_fn,
        metadata={"hnsw:space": "cosine"},
    )


# --------------------------------------------------------------------------
# indexing
# --------------------------------------------------------------------------

def index(collection, comps: list[Competition], force: bool) -> dict:
    ids = [c.slug for c in comps]
    documents = [build_document(c) for c in comps]
    metadatas = [build_metadata(c) for c in comps]
    for meta, doc in zip(metadatas, documents):
        meta["content_hash"] = document_hash(doc, meta)

    existing_hashes: dict[str, str] = {}
    if not force:
        for i in range(0, len(ids), BATCH_SIZE):
            got = collection.get(ids=ids[i:i + BATCH_SIZE], include=["metadatas"])
            for cid, meta in zip(got.get("ids", []), got.get("metadatas", []) or []):
                if meta and meta.get("content_hash"):
                    existing_hashes[cid] = meta["content_hash"]

    changed = [i for i, cid in enumerate(ids)
               if force or existing_hashes.get(cid) != metadatas[i]["content_hash"]]
    unchanged = len(ids) - len(changed)

    for start in range(0, len(changed), BATCH_SIZE):
        chunk = changed[start:start + BATCH_SIZE]
        collection.upsert(
            ids=[ids[i] for i in chunk],
            documents=[documents[i] for i in chunk],
            metadatas=[metadatas[i] for i in chunk],
        )
        print(f"  embedded {min(start + len(chunk), len(changed))}/{len(changed)}")

    # anything in the collection that is no longer in the sheets
    all_ids = set(collection.get(include=[]).get("ids", []))
    stale = sorted(all_ids - set(ids))

    return {"upserted": len(changed), "unchanged": unchanged, "stale": stale}


# --------------------------------------------------------------------------
# reporting
# --------------------------------------------------------------------------

def report(comps: list[Competition], problems: list[str]) -> None:
    print("\n" + "=" * 68)
    print("DATA QUALITY REPORT")
    print("=" * 68)
    print(f"competitions:        {len(comps)}")

    regions = Counter(c.region for c in comps)
    for r, n in regions.most_common():
        print(f"  region {r:<10}     {n}")
    base = len({c.base_slug for c in comps})
    if base != len(comps):
        print(f"  ({len(comps) - base} listed in both sheets — one document per region)")

    def count(pred) -> int:
        return sum(1 for c in comps if pred(c))

    print(f"\nwith a full date:    {count(lambda c: c.deadline_precision == 'day')}")
    print(f"  month precision:   {count(lambda c: c.deadline_precision == 'month')}")
    print(f"  rolling:           {count(lambda c: c.is_rolling)}")
    print(f"  no usable date:    {count(lambda c: c.deadline_precision == 'unknown')}")
    unusable = [c for c in comps
                if not c.description and not c.submission_details and not c.domains]
    print(f"with description:    {count(lambda c: bool(c.description))}")
    print(f"UNUSABLE (name only):{len(unusable)}  ← excluded from ranking")
    for c in unusable[:10]:
        print(f"      · {c.name[:58]} ({c.region})")
    print(f"with domain(s):      {count(lambda c: bool(c.domains))}")
    print(f"with official URL:   {count(lambda c: bool(c.official_urls))}")
    print(f"with grade/age range:{count(lambda c: c.grade_min or c.age_min or c.grade_max or c.age_max)}")
    print(f"fully scored (4/4):  {count(lambda c: all(v is not None for v in (c.prestige, c.selectivity, c.complexity, c.time_investment)))}")
    print(f"entirely unscored:   {count(lambda c: all(v is None for v in (c.prestige, c.selectivity, c.complexity, c.time_investment)))}")

    domains = Counter(d for c in comps for d in c.domains)
    print(f"\ntop domains: " + ", ".join(f"{d} ({n})" for d, n in domains.most_common(12)))

    flagged = [c for c in comps if c.warnings]
    if flagged:
        print(f"\n{len(flagged)} competitions have warnings:")
        for c in flagged[:25]:
            print(f"  · {c.name}")
            for w in c.warnings:
                print(f"      - {w}")
        if len(flagged) > 25:
            print(f"  … and {len(flagged) - 25} more (see the JSON `warnings` field)")

    if problems:
        print(f"\n{len(problems)} rows had problems:")
        for p in problems[:20]:
            print(f"  · {p}")

    print("\nReminder: winner lists, notes and comments are stored in the JSON but are")
    print("NEVER embedded — they must not be reachable from a public search.")
    print("=" * 68 + "\n")


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--india", type=Path, help="path to the India competitions CSV")
    ap.add_argument("--us", type=Path, help="path to the US competitions CSV")
    ap.add_argument("--collection", default=os.getenv("CHROMA_COLLECTION", DEFAULT_COLLECTION))
    ap.add_argument("--chroma-mode", default=os.getenv("CHROMA_MODE", "cloud"),
                    choices=["cloud", "http", "local"],
                    help="cloud (default) | http (docker-compose) | local (persistent dir)")
    ap.add_argument("--chroma-tenant", default=os.getenv("CHROMA_TENANT"))
    ap.add_argument("--chroma-database", default=os.getenv("CHROMA_DATABASE"))
    ap.add_argument("--chroma-api-key", default=os.getenv("CHROMA_API_KEY"))
    ap.add_argument("--chroma-path", default=os.getenv("CHROMA_PATH", "../.chroma"),
                    help="local persistent path, for --chroma-mode local")
    ap.add_argument("--chroma-host", default=os.getenv("CHROMA_HOST", "localhost"),
                    help="for --chroma-mode http")
    ap.add_argument("--chroma-port", type=int, default=int(os.getenv("CHROMA_PORT", "8000")))
    ap.add_argument("--embedding", default=os.getenv("EMBEDDING_BACKEND", "default"),
                    choices=["default", "sentence-transformers", "openai-compatible"])
    ap.add_argument("--out", type=Path, default=Path("../data/competitions.normalized.json"))
    ap.add_argument("--reset", action="store_true", help="drop the collection before indexing")
    ap.add_argument("--force", action="store_true", help="re-embed even if the hash is unchanged")
    ap.add_argument("--dry-run", action="store_true", help="parse + write JSON, skip Chroma entirely")
    args = ap.parse_args()

    sources: list[tuple[Path, str]] = []
    if args.india:
        sources.append((args.india, "IN"))
    if args.us:
        sources.append((args.us, "US"))
    if not sources:
        ap.error("give at least one of --india / --us")

    print("Reading sheets…")
    comps, problems = collect(sources)
    if not comps:
        print("error: no competitions parsed — check the header row", file=sys.stderr)
        return 1
    print(f"  parsed {len(comps)} unique competitions from {len(sources)} sheet(s)")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "collection": args.collection,
        "count": len(comps),
        "competitions": [
            {**c.to_dict(),
             "document": build_document(c),
             "content_hash": document_hash(build_document(c), build_metadata(c))}
            for c in comps
        ],
    }
    args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  wrote {args.out}")

    if args.dry_run:
        print("\n--dry-run: skipping Chroma")
        report(comps, problems)
        return 0

    print(f"\nIndexing into Chroma collection '{args.collection}'…")
    embedding_fn, model_name = get_embedding_function(args.embedding)
    print(f"  embedding backend: {args.embedding} ({model_name})")
    collection = get_collection(args, embedding_fn)
    stats = index(collection, comps, force=args.force)

    print(f"\n  upserted:  {stats['upserted']}")
    print(f"  unchanged: {stats['unchanged']} (hash match, not re-embedded)")
    if stats["stale"]:
        print(f"  stale:     {len(stats['stale'])} ids in Chroma but not in the sheets:")
        for s in stats["stale"][:10]:
            print(f"      - {s}")
        print("             (not deleted automatically — rerun with --reset to rebuild)")
    print(f"  collection now holds {collection.count()} documents")

    report(comps, problems)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
