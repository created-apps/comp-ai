#!/usr/bin/env python3
"""
Read-only check: list every Chroma collection and its row count.

Run this FIRST, before delete_chroma.py, so you know exactly what's about to
be removed. Uses the same connection settings as ingest_competitions.py
(reads ingest/.env the same way).

    python check_chroma.py
"""
import os
from pathlib import Path


def _load_dotenv() -> None:
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

import chromadb

mode = os.getenv("CHROMA_MODE", "cloud")

if mode == "cloud":
    tenant = os.getenv("CHROMA_TENANT")
    database = os.getenv("CHROMA_DATABASE")
    api_key = os.getenv("CHROMA_API_KEY")
    missing = [n for n, v in (("CHROMA_TENANT", tenant), ("CHROMA_DATABASE", database), ("CHROMA_API_KEY", api_key)) if not v]
    if missing:
        raise SystemExit(f"error: CHROMA_MODE=cloud requires {', '.join(missing)} in ingest/.env")
    print(f"Connecting to Chroma Cloud (tenant={tenant}, database={database})")
    client = chromadb.CloudClient(tenant=tenant, database=database, api_key=api_key)
elif mode == "http":
    host = os.getenv("CHROMA_HOST", "localhost")
    port = int(os.getenv("CHROMA_PORT", "8000"))
    print(f"Connecting to Chroma HTTP ({host}:{port})")
    client = chromadb.HttpClient(host=host, port=port)
else:
    path = os.getenv("CHROMA_PATH", "../.chroma")
    print(f"Connecting to local persistent store ({path})")
    client = chromadb.PersistentClient(path=path)

collections = client.list_collections()
print(f"\n{len(collections)} collection(s) found:\n")
total = 0
for c in collections:
    name = c.name if hasattr(c, "name") else str(c)
    try:
        coll = client.get_collection(name)
        n = coll.count()
    except Exception as exc:  # noqa: BLE001
        n = f"<error: {exc}>"
    print(f"  - {name}: {n} documents")
    if isinstance(n, int):
        total += n

expected = os.getenv("CHROMA_COLLECTION", "competitions_v1")
print(f"\nBackend/ingest expect the collection named: '{expected}'")
print(f"Total documents across all collections: {total}")
