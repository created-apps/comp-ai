#!/usr/bin/env python3
"""
Index an already-built competitions.normalized.json into Chroma, reusing the
exact connection/embedding logic ingest_competitions.py already uses — no
duplicated Chroma client code.

Use this after transform_masterlist_update.py has written the JSON (instead
of ingest_competitions.py, which expects to parse a CSV itself).

    python index_from_normalized_json.py --json ../data/competitions.normalized.json
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import os
from pathlib import Path

from ingest_competitions import DEFAULT_COLLECTION, BATCH_SIZE, get_client, get_embedding_function, _load_dotenv
from normalize import Competition, build_document, build_metadata, document_hash

_load_dotenv()

COMPETITION_FIELDS = {f.name for f in dataclasses.fields(Competition)}


def record_to_competition(rec: dict) -> Competition:
    kwargs = {k: v for k, v in rec.items() if k in COMPETITION_FIELDS}
    return Competition(**kwargs)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", type=Path, default=Path("../data/competitions.normalized.json"))
    ap.add_argument("--collection", default=os.getenv("CHROMA_COLLECTION", DEFAULT_COLLECTION))
    ap.add_argument("--chroma-mode", default=os.getenv("CHROMA_MODE", "cloud"), choices=["cloud", "http", "local"])
    ap.add_argument("--chroma-tenant", default=os.getenv("CHROMA_TENANT"))
    ap.add_argument("--chroma-database", default=os.getenv("CHROMA_DATABASE"))
    ap.add_argument("--chroma-api-key", default=os.getenv("CHROMA_API_KEY"))
    ap.add_argument("--chroma-path", default=os.getenv("CHROMA_PATH", "../.chroma"))
    ap.add_argument("--chroma-host", default=os.getenv("CHROMA_HOST", "localhost"))
    ap.add_argument("--chroma-port", type=int, default=int(os.getenv("CHROMA_PORT", "8000")))
    ap.add_argument("--embedding", default=os.getenv("EMBEDDING_BACKEND", "default"))
    ap.add_argument("--reset", action="store_true", help="drop the collection before indexing")
    ap.add_argument("--force", action="store_true", help="re-embed even if the hash is unchanged")
    args = ap.parse_args()

    payload = json.loads(args.json.read_text(encoding="utf-8"))
    records = payload["competitions"]
    print(f"loaded {len(records)} records from {args.json}")

    comps = [record_to_competition(r) for r in records]
    ids = [c.slug for c in comps]
    documents = [build_document(c) for c in comps]
    metadatas = [build_metadata(c) for c in comps]
    for meta, doc in zip(metadatas, documents):
        meta["content_hash"] = document_hash(doc, meta)

    embedding_fn, model_name = get_embedding_function(args.embedding)
    print(f"embedding backend: {args.embedding} ({model_name})")
    collection = get_collection_local(args, embedding_fn)

    existing_hashes: dict[str, str] = {}
    if not args.force:
        for i in range(0, len(ids), BATCH_SIZE):
            got = collection.get(ids=ids[i:i + BATCH_SIZE], include=["metadatas"])
            for cid, meta in zip(got.get("ids", []), got.get("metadatas", []) or []):
                if meta and meta.get("content_hash"):
                    existing_hashes[cid] = meta["content_hash"]

    changed = [i for i, cid in enumerate(ids)
               if args.force or existing_hashes.get(cid) != metadatas[i]["content_hash"]]

    for start in range(0, len(changed), BATCH_SIZE):
        chunk = changed[start:start + BATCH_SIZE]
        collection.upsert(
            ids=[ids[i] for i in chunk],
            documents=[documents[i] for i in chunk],
            metadatas=[metadatas[i] for i in chunk],
        )
        print(f"  embedded {min(start + len(chunk), len(changed))}/{len(changed)}")

    print(f"\nupserted: {len(changed)}  unchanged: {len(ids) - len(changed)}")
    print(f"collection '{args.collection}' now holds {collection.count()} documents")
    return 0


def get_collection_local(args, embedding_fn):
    client = get_client(args)
    if args.reset:
        try:
            client.delete_collection(args.collection)
            print(f"  dropped existing collection '{args.collection}'")
        except Exception:
            pass
    return client.get_or_create_collection(
        name=args.collection, embedding_function=embedding_fn,
        metadata={"hnsw:space": "cosine"},
    )


if __name__ == "__main__":
    raise SystemExit(main())
