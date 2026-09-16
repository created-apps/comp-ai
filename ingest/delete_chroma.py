#!/usr/bin/env python3
"""
Delete Chroma collection(s) entirely — the Chroma equivalent of the Postgres
clean sweep. There is no rollback for this; run check_chroma.py first and
confirm what you're about to remove.

Deletes only the collection(s) you name. By default, deletes just the one
collection the app actually uses (CHROMA_COLLECTION / 'competitions_v1').

    python delete_chroma.py                     # delete the configured collection
    python delete_chroma.py --all                # delete every collection found
    python delete_chroma.py --collection foo_v2  # delete a specific one
"""
import argparse
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


def get_client():
    mode = os.getenv("CHROMA_MODE", "cloud")
    if mode == "cloud":
        tenant = os.getenv("CHROMA_TENANT")
        database = os.getenv("CHROMA_DATABASE")
        api_key = os.getenv("CHROMA_API_KEY")
        missing = [n for n, v in (("CHROMA_TENANT", tenant), ("CHROMA_DATABASE", database), ("CHROMA_API_KEY", api_key)) if not v]
        if missing:
            raise SystemExit(f"error: CHROMA_MODE=cloud requires {', '.join(missing)} in ingest/.env")
        print(f"Connecting to Chroma Cloud (tenant={tenant}, database={database})")
        return chromadb.CloudClient(tenant=tenant, database=database, api_key=api_key)
    if mode == "http":
        host = os.getenv("CHROMA_HOST", "localhost")
        port = int(os.getenv("CHROMA_PORT", "8000"))
        print(f"Connecting to Chroma HTTP ({host}:{port})")
        return chromadb.HttpClient(host=host, port=port)
    path = os.getenv("CHROMA_PATH", "../.chroma")
    print(f"Connecting to local persistent store ({path})")
    return chromadb.PersistentClient(path=path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all", action="store_true", help="delete every collection found, not just the configured one")
    ap.add_argument("--collection", help="delete this specific collection name instead of the configured default")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = ap.parse_args()

    client = get_client()

    if args.all:
        targets = [c.name if hasattr(c, "name") else str(c) for c in client.list_collections()]
    elif args.collection:
        targets = [args.collection]
    else:
        targets = [os.getenv("CHROMA_COLLECTION", "competitions_v1")]

    if not targets:
        print("Nothing to delete — no collections matched.")
        return 0

    print("About to delete these collection(s):")
    for t in targets:
        try:
            n = client.get_collection(t).count()
            print(f"  - {t} ({n} documents)")
        except Exception:
            print(f"  - {t} (could not read count — may not exist)")

    if not args.yes:
        confirm = input("\nType DELETE to proceed: ")
        if confirm != "DELETE":
            print("Aborted — nothing was deleted.")
            return 1

    for t in targets:
        try:
            client.delete_collection(t)
            print(f"  deleted: {t}")
        except Exception as exc:  # noqa: BLE001
            print(f"  could not delete {t}: {exc}")

    print("\nDone. Run check_chroma.py again to confirm.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
