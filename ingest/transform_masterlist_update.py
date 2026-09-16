#!/usr/bin/env python3
"""
Transform the cleaned "Jun-Dec 0826 Update" masterlist sheet into
`competitions.normalized.json` — the same contract `seed.ts` and Chroma
indexing already consume, extended with the 12 new masterlist-only fields
(see prisma migration 20260912000000_add_masterlist_columns).

This is a standalone reader for the NEW sheet's column shape (Official
Competition Name / Primary Domain / Submission Deadline as compound
date+time text, etc.) — different from the old India/US CSV shape
normalize.py's row_to_competition() parses. It reuses normalize.py's
parse_team / parse_age_grade / parse_domains / parse_score / parse_difficulty /
extract_urls / slugify / build_document / build_metadata / document_hash
UNCHANGED, so the embedding contract never drifts from what a future
CSV-based ingest would also produce.

Two defensive rules, both load-bearing for the whole point of this reload:

  1. A date is NEVER extracted from a cell containing caution language
     ("TBA", "not announced", "to verify", "do not use", "unconfirmed",
     "pending", ...) even if a date-shaped substring is sitting right there.
     The raw text is kept; the parsed date field stays null.
  2. "Verification Confidence" is itself a packed column (e.g. "High for
     programme existence; Low for 2026-27 deadline dates"). The full raw
     sentence is kept verbatim; a separate conservative overall rating
     (worst mentioned level wins) is derived only to decide, later, which
     rows get `current`/`lastVerifiedAt` set.

    python transform_masterlist_update.py --input "<path to cleaned xlsx>" \
        --out ../data/competitions.normalized.json
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any

import openpyxl

from normalize import (
    Competition,
    DAYS_IN_MONTH,
    MONTHS,
    build_document,
    build_metadata,
    clean,
    document_hash,
    extract_urls,
    parse_age_grade,
    parse_difficulty,
    parse_domains,
    parse_score,
    parse_team,
    slugify,
)

SHEET_NAME = "Jun-Dec 0826 Update"
SOURCE_LABEL = "Masterlist Competitions - Jun-Dec 0826 Update.xlsx"

CAUTION_MARKERS = (
    "tba", "tbd", "tbc", "not announced", "not yet announced", "not specified",
    "not yet specified", "to verify", "to be confirmed", "do not use",
    "unconfirmed", "pending", "need reconfirmation", "needs reconfirmation",
    "exact date", "no separate", "unavailable",
)

GLOBAL_MARKERS = ("worldwide", "global", "international", "any country", "any nationality")


# --------------------------------------------------------------------------
# defensive date parsing
# --------------------------------------------------------------------------

_DATE_RE = re.compile(
    r"(\d{1,2})[\s\-]+([A-Za-z]{3,9})\.?,?[\s\-]+(\d{4})"
)
_MONTH_YEAR_RE = re.compile(r"\b([A-Za-z]{3,9})\.?\s+(\d{4})\b")
_YEAR_RE = re.compile(r"\b(20\d{2})\b")


def _month_num(name: str) -> int | None:
    s = name.lower().strip(".")
    if s in MONTHS:
        return MONTHS[s]
    if s[:3] in MONTHS:
        return MONTHS[s[:3]]
    return None


def parse_free_text_date(value: Any) -> dict:
    """Parse a single free-text date cell defensively.

    Returns {date, month, year, precision, has_caution}. NEVER returns a date
    (any precision) when the text contains a caution marker — the caller must
    still keep the raw text for display, just not treat it as a real date.
    """
    raw = clean(value)
    out = {"date": None, "month": None, "year": None, "precision": "unknown",
           "has_caution": False, "raw": raw}
    if raw is None:
        return out

    low = raw.lower()
    if any(m in low for m in CAUTION_MARKERS):
        out["has_caution"] = True
        return out  # text preserved by caller; nothing parsed

    m = _DATE_RE.search(raw)
    if m:
        day, month_name, year = int(m.group(1)), m.group(2), int(m.group(3))
        month = _month_num(month_name)
        if month and 1 <= day <= DAYS_IN_MONTH.get(month, 31):
            out.update(date=f"{year:04d}-{month:02d}-{day:02d}", month=month,
                       year=year, precision="day")
            return out

    m = _MONTH_YEAR_RE.search(raw)
    if m:
        month = _month_num(m.group(1))
        year = int(m.group(2))
        if month:
            out.update(month=month, year=year, precision="month")
            return out

    m = _YEAR_RE.search(raw)
    if m:
        out.update(year=int(m.group(1)), precision="year")
        return out

    return out


def parse_date_cell(value: Any) -> dict:
    """A sheet cell that may be a real openpyxl datetime OR free text."""
    if isinstance(value, datetime):
        return {"date": value.strftime("%Y-%m-%d"), "month": value.month,
                "year": value.year, "precision": "day", "has_caution": False,
                "raw": value.strftime("%d %B %Y")}
    return parse_free_text_date(value)


# --------------------------------------------------------------------------
# region classification
# --------------------------------------------------------------------------

def classify_regions(geo_text: str | None) -> list[str]:
    """Which region(s) this competition should exist as a row for.

    Ambiguous/blank defaults to BOTH — under-including silently hides a real
    opportunity from a whole region, which is the worse failure mode; the app
    already scopes what a student sees by their own signup country.
    """
    if not geo_text:
        return ["IN", "US"]
    s = geo_text.lower()
    if any(m in s for m in GLOBAL_MARKERS):
        return ["IN", "US"]
    has_india = "india" in s
    has_us = bool(re.search(r"\bu\.?s\.?a?\b|\bunited states\b", s))
    if has_india and has_us:
        return ["IN", "US"]
    if has_india:
        return ["IN"]
    if has_us:
        return ["US"]
    return ["IN", "US"]


# --------------------------------------------------------------------------
# status + confidence
# --------------------------------------------------------------------------

def classify_status(text: str | None) -> str:
    if not text:
        return "UNKNOWN"
    low = text.strip().lower()
    if low.startswith("closed"):
        return "CLOSED"
    if low.startswith("open"):
        return "OPEN"
    if "paused" in low:
        return "PAUSED"
    if re.search(r"not currently open|applications not open|not yet open", low):
        return "NOT_YET_OPEN"
    if "rolling" in low:
        return "ROLLING"
    return "UNKNOWN"


def overall_confidence(text: str | None) -> str:
    """Worst mentioned level wins — deadline reliability is what matters."""
    if not text:
        return "LOW"
    low = text.lower()
    if "low" in low:
        return "LOW"
    if "medium" in low or "med" in low:
        return "MEDIUM"
    if "high" in low:
        return "HIGH"
    return "LOW"


# --------------------------------------------------------------------------
# sheet reading
# --------------------------------------------------------------------------

def read_sheet(path: Path, sheet: str | None = None) -> list[dict]:
    wb = openpyxl.load_workbook(path, data_only=True)
    if sheet:
        ws = wb[sheet]
    elif SHEET_NAME in wb.sheetnames:
        ws = wb[SHEET_NAME]
    else:
        candidates = [n for n in wb.sheetnames if n.startswith("Jun-Dec")]
        if not candidates:
            raise SystemExit(f"error: no sheet named '{SHEET_NAME}' or starting with 'Jun-Dec' found. "
                              f"Sheets present: {wb.sheetnames}. Pass --sheet explicitly.")
        ws = wb[candidates[0]]
    rows = list(ws.iter_rows(values_only=True))
    header = [str(h).strip() if h else "" for h in rows[0]]
    out = []
    for r in rows[1:]:
        if not r or not any(c not in (None, "") for c in r):
            continue
        row = dict(zip(header, r))
        if not row.get("Official Competition Name"):
            continue
        out.append(row)
    return out


def dedupe(rows: list[dict]) -> list[dict]:
    """Drop byte-for-byte identical rows (repeat entries in the sheet).
    Same-name-but-differing rows (e.g. Earth Partner Prize) are both kept.
    """
    seen: set[tuple] = set()
    out = []
    for r in rows:
        key = tuple(r.items())
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


# --------------------------------------------------------------------------
# row -> Competition (+ new fields)
# --------------------------------------------------------------------------

def build_records(row: dict, name_counts: Counter, warnings_out: list[str]) -> list[dict]:
    name = clean(row.get("Official Competition Name"))
    primary_domain = clean(row.get("Primary Domain"))
    secondary_domains_raw = clean(row.get("Secondary Domains"))
    domains_raw_combined = "; ".join(p for p in (primary_domain, secondary_domains_raw) if p) or None
    domains = parse_domains(domains_raw_combined)

    age_grade = parse_age_grade(row.get("Age / Grade Eligibility"))
    team = parse_team(row.get("Team Size / Entry Mode"))
    geo_raw = clean(row.get("Geographic Eligibility"))
    application_restrictions = clean(row.get("Application Restrictions"))
    minimum_project_stage = clean(row.get("Minimum Project Stage"))
    submission_type = clean(row.get("Submission Type"))
    required_deliverables = clean(row.get("Required Deliverables"))

    reg_opens = parse_date_cell(row.get("Registration Opens"))
    reg_deadline = parse_date_cell(row.get("Registration Deadline"))
    sub_deadline = parse_date_cell(row.get("Submission Deadline"))
    additional_round = clean(row.get("Additional Round / Final Deadlines"))

    status_clean = classify_status(row.get("Current Cycle Status"))
    status_notes = clean(row.get("Status Notes"))

    cycle = row.get("Cycle / Edition")
    cycle_str = str(int(cycle)) if isinstance(cycle, (int, float)) else clean(cycle)

    scores = {
        "prestige": parse_score(row.get("Prestige (1-5)")),
        "selectivity": parse_score(row.get("Selectivity (1-5)")),
        "complexity": parse_score(row.get("Complexity (1-5)")),
        "time_investment": parse_score(row.get("Time Investment (1-5)")),
    }
    score_vals = [v for v in scores.values() if v is not None]
    total_score = sum(score_vals) if len(score_vals) == 4 else None
    difficulty = parse_difficulty(row.get("Difficulty"))

    official_url = clean(row.get("Official URL"))
    source_urls_raw = clean(row.get("Source URLs"))
    source_urls = [u.strip() for u in (source_urls_raw or "").split("|") if u.strip()]
    official_urls: list[str] = []
    for u in ([official_url] if official_url else []) + source_urls + extract_urls(source_urls_raw):
        if u and u not in official_urls:
            official_urls.append(u)

    verification_confidence_raw = clean(row.get("Verification Confidence"))
    conf = overall_confidence(verification_confidence_raw)
    research_notes = clean(row.get("Research Notes"))

    # ---- slug disambiguation for same-name-but-different-content rows ----
    base = slugify(name)
    suffix = ""
    if name_counts[name] > 1:
        suffix = f"-{slugify(primary_domain or '')}" if primary_domain else ""
    base_slug = f"{base}{suffix}"

    regions = classify_regions(geo_raw)
    if len(regions) > 1 and not geo_raw:
        warnings_out.append(f"{name}: geographic eligibility blank — included in both regions by default")
    elif len(regions) > 1 and not any(m in (geo_raw or "").lower() for m in GLOBAL_MARKERS):
        warnings_out.append(f"{name}: geographic eligibility ambiguous ({geo_raw!r}) — included in both regions by default")

    registration_text_parts = [p for p in (
        f"Opens: {reg_opens['raw']}" if reg_opens["raw"] else None,
        f"Deadline: {reg_deadline['raw']}" if reg_deadline["raw"] else None,
    ) if p]
    registration_text = "; ".join(registration_text_parts) or None

    records = []
    for region_code in regions:
        region = {"IN": "India", "US": "USA"}[region_code]
        comp = Competition(
            slug=f"{base_slug}--{region_code.lower()}",
            base_slug=base_slug,
            name=name,
            region=region,
            region_code=region_code,
            regions=[region_code],
            source_sheets=[SOURCE_LABEL],
            description=required_deliverables,
            submission_details=required_deliverables,
            domains=domains["domains"],
            domains_raw=domains["domains_raw"],
            deadline_date=None if sub_deadline["has_caution"] else sub_deadline["date"],
            deadline_month=None if sub_deadline["has_caution"] else sub_deadline["month"],
            deadline_year=None if sub_deadline["has_caution"] else sub_deadline["year"],
            deadline_text=sub_deadline["raw"],
            deadline_precision="unknown" if sub_deadline["has_caution"] else sub_deadline["precision"],
            is_rolling=(sub_deadline["raw"] or "").lower().find("rolling") >= 0,
            grade_min=age_grade["grade_min"], grade_max=age_grade["grade_max"],
            age_min=age_grade["age_min"], age_max=age_grade["age_max"],
            eligibility_raw=age_grade["eligibility_raw"],
            allows_individual=team["allows_individual"], allows_team=team["allows_team"],
            team_min=team["team_min"], team_max=team["team_max"], team_raw=team["team_raw"],
            registration_status=status_clean,
            registration_text=registration_text,
            prestige=scores["prestige"], selectivity=scores["selectivity"],
            complexity=scores["complexity"], time_investment=scores["time_investment"],
            total_score=total_score,
            difficulty=difficulty,
            official_urls=official_urls,
            winner_lists=None,
            notes=None,
            comments=research_notes,
            source_rows=[{k: (v.isoformat() if isinstance(v, datetime) else v)
                          for k, v in row.items() if v not in (None, "")}],
        )

        if not comp.domains:
            comp.warnings.append("no subject/domain — will not survive domain prefiltering")
        if comp.deadline_precision == "unknown":
            comp.warnings.append("no parseable submission deadline — treated as AWAITING_VERIFICATION")
        if not comp.official_urls:
            comp.warnings.append("no official URL — verification will search for the source")
        if comp.prestige is None and comp.selectivity is None:
            comp.warnings.append("unscored — reranker falls back to semantic fit only")
        comp.warnings.append(f"verification confidence ({conf}): {verification_confidence_raw}")
        if conf == "LOW":
            comp.warnings.append("LOW verification confidence — dates not treated as certain")

        doc = build_document(comp)
        meta = build_metadata(comp)
        payload = {
            **comp.to_dict(),
            "cycle": cycle_str,
            "submission_type": submission_type,
            "primary_domain": primary_domain,
            "secondary_domains_raw": secondary_domains_raw,
            "additional_round_text": additional_round,
            "geographic_eligibility_raw": geo_raw,
            "application_restrictions": application_restrictions,
            "minimum_project_stage": minimum_project_stage,
            "registration_opens_text": reg_opens["raw"],
            "registration_opens_date": None if reg_opens["has_caution"] else reg_opens["date"],
            "registration_deadline_text": reg_deadline["raw"],
            "registration_deadline_date": None if reg_deadline["has_caution"] else reg_deadline["date"],
            "cycle_status_notes": status_notes,
            "verification_confidence": verification_confidence_raw,
            "_overall_confidence": conf,  # consumed by the follow-up SQL step, not by seed.ts
            "document": doc,
            "content_hash": document_hash(doc, meta),
        }
        records.append(payload)
    return records


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path, required=True, help="path to the cleaned Jun-Dec update .xlsx")
    ap.add_argument("--sheet", default=None, help="worksheet name (default: auto-detect)")
    ap.add_argument("--out", type=Path, default=Path("../data/competitions.normalized.json"))
    args = ap.parse_args()

    rows = dedupe(read_sheet(args.input, args.sheet))
    name_counts = Counter(clean(r.get("Official Competition Name")) for r in rows)

    warnings_out: list[str] = []
    all_records: list[dict] = []
    for row in rows:
        all_records.extend(build_records(row, name_counts, warnings_out))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps({"collection": "competitions_v1", "count": len(all_records),
                     "competitions": all_records}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # ---- report ----
    print("=" * 68)
    print("TRANSFORM REPORT")
    print("=" * 68)
    print(f"unique sheet rows (post-dedupe): {len(rows)}")
    print(f"output Competition rows (post region-split): {len(all_records)}")

    by_region = Counter(r["region"] for r in all_records)
    for r, n in by_region.most_common():
        print(f"  region {r:<6} {n}")

    dup_names = {n for n, c in name_counts.items() if c > 1}
    if dup_names:
        print(f"\nsame-name, differing-content rows kept separately ({len(dup_names)}):")
        for n in dup_names:
            print(f"  - {n}")

    precision = Counter(r["deadline_precision"] for r in all_records)
    print(f"\nsubmission deadline precision: {dict(precision)}")

    conf = Counter(r["_overall_confidence"] for r in all_records)
    print(f"verification confidence: {dict(conf)}")

    no_url = sum(1 for r in all_records if not r["official_urls"])
    print(f"\nrows with no official URL: {no_url}")
    print(f"rows flagged region-ambiguous: {sum(1 for w in warnings_out if 'ambiguous' in w or 'blank' in w)}")

    if warnings_out:
        print(f"\n{len(warnings_out)} region-classification notes (sample):")
        for w in warnings_out[:15]:
            print(f"  - {w}")

    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
