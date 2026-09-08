"""
Pure parsing / normalization for the CreatED competition masterlist sheets.

No I/O, no Chroma, no network — everything here is a pure function so it can be
unit-tested against the messy real-world values in the India and US sheets.

The two sheets share one header set:

    Competition Name | Submission Day | Submission Month | Submission Year |
    Winner List (s) | Age/Grade | Registration open | Individual/team |
    Description | Submission Details | Subject/Domain | Notes |
    Prestige (1-5) | Selectivity (1-5) | Complexity (1-5) | Time Investment (1-5) |
    Total Score | Difficulty Level | Comments

Scoring columns are frequently blank — every parser here returns None rather than
a default, so "unscored" is never silently rendered as "scored 0".
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field, asdict
from typing import Any

# Fields that must NEVER reach a TOF response or the embedding document.
# The chatbot and the public matcher both read from the embedded document, so
# keeping these out of `build_document()` is the primary leak defence.
INTERNAL_FIELDS = ("winner_lists", "notes", "comments", "submission_details_internal")

MONTHS = {
    "jan": 1, "january": 1,
    "feb": 2, "february": 2,
    "mar": 3, "march": 3,
    "apr": 4, "april": 4,
    "may": 5,
    "jun": 6, "june": 6,
    "jul": 7, "july": 7,
    "aug": 8, "august": 8,
    "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10,
    "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}

DAYS_IN_MONTH = {1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30,
                 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31}

ROLLING_MARKERS = ("rolling", "ongoing", "continuous", "anytime", "year round", "year-round")
UNKNOWN_MARKERS = ("tba", "tbd", "tbc", "n/a", "na", "unknown", "-", "--", "?", "none", "nil")

# Canonical domain buckets. Anything unrecognised is kept verbatim (slugified),
# so a new subject in the sheet is never dropped — it just isn't canonicalised.
DOMAIN_ALIASES = {
    "ai": "ai", "artificial intelligence": "ai", "ml": "ai", "machine learning": "ai",
    "computer science": "computer-science", "cs": "computer-science", "coding": "computer-science",
    "programming": "computer-science", "software": "computer-science", "app development": "computer-science",
    "robotics": "robotics",
    "engineering": "engineering", "mechanical": "engineering", "electrical": "engineering",
    "biology": "biology", "life sciences": "biology", "biotech": "biology",
    "biotechnology": "biology", "bioinformatics": "biology", "medicine": "medicine",
    "health": "medicine", "healthcare": "medicine", "medical": "medicine",
    "chemistry": "chemistry", "physics": "physics", "astronomy": "physics",
    "maths": "mathematics", "math": "mathematics", "mathematics": "mathematics",
    "environment": "sustainability", "environmental science": "sustainability",
    "sustainability": "sustainability", "climate": "sustainability", "water": "sustainability",
    "energy": "sustainability", "agriculture": "sustainability",
    "business": "entrepreneurship", "entrepreneurship": "entrepreneurship",
    "startup": "entrepreneurship", "innovation": "entrepreneurship",
    "economics": "economics", "finance": "economics",
    "social impact": "social-impact", "social science": "social-sciences",
    "psychology": "psychology", "humanities": "humanities", "writing": "humanities",
    "design": "design", "art": "design", "multimedia": "design", "film": "design",
    "research": "research", "stem": "stem", "science": "science", "any": "open", "all": "open",
    "open": "open", "interdisciplinary": "open",
}

SPLIT_RE = re.compile(r"\s*(?:,|/|;|\||&|\band\b|\+)\s*", re.IGNORECASE)

# Region is a first-class tag on every document. A student states their country at
# signup, so retrieval filters on it directly rather than post-filtering results.
# Each sheet row becomes its own document, region-qualified — a competition listed
# in both sheets is two documents, because its eligibility text differs per sheet.
REGION_LABEL = {"IN": "India", "US": "USA"}


# --------------------------------------------------------------------------
# generic helpers
# --------------------------------------------------------------------------

def normalize_header(raw: str) -> str:
    """Header cells arrive with embedded newlines and stray quotes.

    '"Prestige (1-5)\\n"' -> 'prestige'
    'Winner List (s)'     -> 'winner_list_s'
    """
    s = unicodedata.normalize("NFKD", raw or "")
    s = s.replace("–", "-").replace("—", "-")   # en/em dash
    s = s.strip().strip('"').strip()
    s = re.sub(r"\(\s*1\s*-\s*5\s*\)", "", s)             # drop the (1-5) suffix
    s = re.sub(r"\s+", " ", s).strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return s


def clean(value: Any) -> str | None:
    """Trim a cell; blanks and placeholder markers become None."""
    if value is None:
        return None
    s = unicodedata.normalize("NFKC", str(value))
    s = s.replace(" ", " ")
    s = re.sub(r"\s+", " ", s).strip().strip('"').strip()
    if not s or s.lower() in UNKNOWN_MARKERS:
        return None
    return s


def slugify(value: str) -> str:
    s = unicodedata.normalize("NFKD", value or "")
    s = s.encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return re.sub(r"-{2,}", "-", s) or "unnamed"


def _ints(text: str) -> list[int]:
    return [int(n) for n in re.findall(r"\d+", text)]


# --------------------------------------------------------------------------
# field parsers
# --------------------------------------------------------------------------

def parse_month(value: Any) -> int | None:
    """'March' | 'Mar' | '3' | '03' -> 3."""
    s = clean(value)
    if s is None:
        return None
    s = s.lower().strip(".")
    if s in MONTHS:
        return MONTHS[s]
    if s.isdigit() and 1 <= int(s) <= 12:
        return int(s)
    for name, num in MONTHS.items():                       # 'mid-March', 'March 2026'
        if len(name) > 3 and name in s:
            return num
    return None


def parse_year(value: Any) -> int | None:
    s = clean(value)
    if s is None:
        return None
    nums = _ints(s)
    for n in nums:
        if 2000 <= n <= 2100:
            return n
        if 20 <= n <= 99:                                   # '26' -> 2026
            return 2000 + n
    return None


def parse_deadline(day: Any, month: Any, year: Any) -> dict:
    """Fold the three submission columns into one deadline shape.

    Returns date/text/rolling. A partial date (month + year, no day) is kept as a
    real month-precision value rather than being guessed to the 1st or discarded.
    """
    raw_parts = [clean(day), clean(month), clean(year)]
    raw = " ".join(p for p in raw_parts if p) or None
    blob = (raw or "").lower()

    if any(m in blob for m in ROLLING_MARKERS):
        return {"deadline_date": None, "deadline_month": None, "deadline_year": None,
                "deadline_text": raw, "is_rolling": True, "precision": "rolling"}

    m = parse_month(month)
    y = parse_year(year)
    d_clean = clean(day)
    d = None
    if d_clean:
        nums = _ints(d_clean)
        if nums and 1 <= nums[0] <= 31:
            d = nums[0]

    if y and m and d and d <= DAYS_IN_MONTH.get(m, 31):
        return {"deadline_date": f"{y:04d}-{m:02d}-{d:02d}", "deadline_month": m,
                "deadline_year": y, "deadline_text": raw, "is_rolling": False,
                "precision": "day"}
    if y and m:
        return {"deadline_date": None, "deadline_month": m, "deadline_year": y,
                "deadline_text": raw, "is_rolling": False, "precision": "month"}
    if y:
        return {"deadline_date": None, "deadline_month": None, "deadline_year": y,
                "deadline_text": raw, "is_rolling": False, "precision": "year"}
    return {"deadline_date": None, "deadline_month": None, "deadline_year": None,
            "deadline_text": raw, "is_rolling": False, "precision": "unknown"}


def parse_age_grade(value: Any) -> dict:
    """'Grades 9-12' | 'Class 8 onwards' | '13-18 years' | 'Under 19'."""
    raw = clean(value)
    out = {"grade_min": None, "grade_max": None, "age_min": None, "age_max": None,
           "eligibility_raw": raw}
    if raw is None:
        return out

    s = raw.lower()
    grade_ctx = any(w in s for w in ("grade", "class", "std", "year "))
    age_ctx = any(w in s for w in ("age", "year old", "years old", "yrs", "yo", "under", "below"))

    rng = re.search(r"(\d{1,2})\s*(?:-|–|—|to|through)\s*(\d{1,2})", s)
    if rng:
        lo, hi = int(rng.group(1)), int(rng.group(2))
        if lo > hi:
            lo, hi = hi, lo
        # 13-18 reads as ages; 6-12 reads as grades unless the text says otherwise
        if age_ctx and not grade_ctx:
            out["age_min"], out["age_max"] = lo, hi
        elif grade_ctx and not age_ctx:
            out["grade_min"], out["grade_max"] = lo, hi
        elif hi > 13 and lo >= 13:
            out["age_min"], out["age_max"] = lo, hi
        else:
            out["grade_min"], out["grade_max"] = lo, hi
        return out

    if re.search(r"\b(under|below|upto|up to|max|younger than)\b", s):
        nums = _ints(s)
        if nums:
            (out.__setitem__("age_max", nums[0]) if age_ctx or nums[0] > 13
             else out.__setitem__("grade_max", nums[0]))
        return out

    if re.search(r"\b(onwards|above|older than|min|and up|\+)\b", s):
        nums = _ints(s)
        if nums:
            (out.__setitem__("age_min", nums[0]) if age_ctx and not grade_ctx
             else out.__setitem__("grade_min", nums[0]))
        return out

    nums = _ints(s)
    if len(nums) == 1:
        if age_ctx and not grade_ctx:
            out["age_min"] = out["age_max"] = nums[0]
        elif grade_ctx:
            out["grade_min"] = out["grade_max"] = nums[0]
    return out


def parse_team(value: Any) -> dict:
    """'Individual' | 'Team (2-5)' | 'Individual or team' | 'Teams of up to 4'."""
    raw = clean(value)
    out = {"allows_individual": None, "allows_team": None,
           "team_min": None, "team_max": None, "team_raw": raw}
    if raw is None:
        return out

    s = raw.lower()
    has_ind = bool(re.search(r"\bindividual|\bsolo|\bsingle\b", s))
    has_team = bool(re.search(r"\bteam|\bgroup\b", s))
    out["allows_individual"] = has_ind or (not has_team)
    out["allows_team"] = has_team

    rng = re.search(r"(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})", s)
    if rng:
        out["team_min"], out["team_max"] = int(rng.group(1)), int(rng.group(2))
    else:
        cap = re.search(r"(?:up to|upto|max(?:imum)?(?: of)?|no more than)\s*(\d{1,2})", s)
        if cap:
            out["team_min"], out["team_max"] = 1, int(cap.group(1))
        elif has_team:
            nums = _ints(s)
            if nums:
                out["team_max"] = nums[0]
    if out["allows_individual"] and out["team_min"] is None:
        out["team_min"] = 1
    return out


def parse_registration(value: Any) -> dict:
    """The column mixes dates, statuses and prose — keep all three readings."""
    raw = clean(value)
    out = {"registration_status": None, "registration_text": raw}
    if raw is None:
        return out
    s = raw.lower()
    if any(m in s for m in ROLLING_MARKERS):
        out["registration_status"] = "ROLLING"
    elif re.search(r"\bclosed?\b|\bended\b|\bpassed\b", s):
        out["registration_status"] = "CLOSED"
    elif re.search(r"\bopen\b|\blive\b|\bnow\b|\byes\b", s):
        out["registration_status"] = "OPEN"
    elif re.search(r"\bnot yet\b|\bsoon\b|\bopens\b|\bno\b", s):
        out["registration_status"] = "NOT_YET_OPEN"
    else:
        out["registration_status"] = "UNKNOWN"
    return out


def parse_domains(value: Any) -> dict:
    raw = clean(value)
    if raw is None:
        return {"domains": [], "domains_raw": None}
    parts = [p.strip() for p in SPLIT_RE.split(raw) if p and p.strip()]
    domains: list[str] = []
    for p in parts:
        key = p.lower().strip(" .")
        canonical = DOMAIN_ALIASES.get(key)
        if canonical is None:
            # word-boundary match only — a naive substring test makes 'water' match
            # 'Underwater Basket Weaving' and quietly mislabels the domain
            for alias, target in DOMAIN_ALIASES.items():
                if len(alias) > 3 and re.search(rf"\b{re.escape(alias)}\b", key):
                    canonical = target
                    break
        domains.append(canonical or slugify(p))
    seen: list[str] = []
    for d in domains:
        if d and d not in seen:
            seen.append(d)
    return {"domains": seen, "domains_raw": raw}


def parse_score(value: Any) -> int | None:
    """1-5 scores. Blank stays None — these are missing for many competitions."""
    s = clean(value)
    if s is None:
        return None
    m = re.search(r"\d+(?:\.\d+)?", s)
    if not m:
        return None
    n = round(float(m.group()))
    return n if 1 <= n <= 5 else None


def parse_total_score(value: Any) -> int | None:
    s = clean(value)
    if s is None:
        return None
    m = re.search(r"\d+", s)
    if not m:
        return None
    n = int(m.group())
    return n if 0 <= n <= 20 else None


def parse_difficulty(value: Any) -> str | None:
    s = clean(value)
    if s is None:
        return None
    s = s.lower()
    if "easy" in s:
        return "EASY"
    if "med" in s:
        return "MEDIUM"
    if "hard" in s or "diff" in s:
        return "HARD"
    return None


def extract_urls(*values: Any) -> list[str]:
    urls: list[str] = []
    for v in values:
        if not v:
            continue
        for u in re.findall(r"https?://[^\s,;)\]]+", str(v)):
            u = u.rstrip(".,;)")
            if u not in urls:
                urls.append(u)
    return urls


# --------------------------------------------------------------------------
# record assembly
# --------------------------------------------------------------------------

@dataclass
class Competition:
    slug: str            # region-qualified document id, e.g. "iris-national-fair--in"
    base_slug: str       # region-free slug, groups the same competition across sheets
    name: str
    region: str          # "India" | "USA" — the retrieval tag
    region_code: str     # "IN" | "US"
    regions: list[str]
    source_sheets: list[str]
    description: str | None = None
    submission_details: str | None = None
    domains: list[str] = field(default_factory=list)
    domains_raw: str | None = None
    deadline_date: str | None = None
    deadline_month: int | None = None
    deadline_year: int | None = None
    deadline_text: str | None = None
    deadline_precision: str = "unknown"
    is_rolling: bool = False
    grade_min: int | None = None
    grade_max: int | None = None
    age_min: int | None = None
    age_max: int | None = None
    eligibility_raw: str | None = None
    allows_individual: bool | None = None
    allows_team: bool | None = None
    team_min: int | None = None
    team_max: int | None = None
    team_raw: str | None = None
    registration_status: str | None = None
    registration_text: str | None = None
    prestige: int | None = None
    selectivity: int | None = None
    complexity: int | None = None
    time_investment: int | None = None
    total_score: int | None = None
    difficulty: str | None = None
    official_urls: list[str] = field(default_factory=list)
    # --- internal, never embedded, never exposed to TOF ---
    winner_lists: str | None = None
    notes: str | None = None
    comments: str | None = None
    # --- provenance ---
    source_rows: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def row_to_competition(row: dict[str, Any], region: str, sheet: str) -> Competition | None:
    """Map one normalized-header row to a Competition. Returns None for blank rows."""
    name = clean(row.get("competition_name"))
    if not name:
        return None

    deadline = parse_deadline(row.get("submission_day"),
                              row.get("submission_month"),
                              row.get("submission_year"))
    eligibility = parse_age_grade(row.get("age_grade"))
    team = parse_team(row.get("individual_team"))
    registration = parse_registration(row.get("registration_open"))
    domains = parse_domains(row.get("subject_domain"))

    description = clean(row.get("description"))
    submission_details = clean(row.get("submission_details"))
    notes = clean(row.get("notes"))
    comments = clean(row.get("comments"))
    winners = clean(row.get("winner_list_s"))

    base_slug = slugify(name)
    comp = Competition(
        slug=f"{base_slug}--{region.lower()}",
        base_slug=base_slug,
        name=name,
        region=REGION_LABEL.get(region, region),
        region_code=region,
        regions=[region],
        source_sheets=[sheet],
        description=description,
        submission_details=submission_details,
        domains=domains["domains"],
        domains_raw=domains["domains_raw"],
        deadline_date=deadline["deadline_date"],
        deadline_month=deadline["deadline_month"],
        deadline_year=deadline["deadline_year"],
        deadline_text=deadline["deadline_text"],
        deadline_precision=deadline["precision"],
        is_rolling=deadline["is_rolling"],
        grade_min=eligibility["grade_min"],
        grade_max=eligibility["grade_max"],
        age_min=eligibility["age_min"],
        age_max=eligibility["age_max"],
        eligibility_raw=eligibility["eligibility_raw"],
        allows_individual=team["allows_individual"],
        allows_team=team["allows_team"],
        team_min=team["team_min"],
        team_max=team["team_max"],
        team_raw=team["team_raw"],
        registration_status=registration["registration_status"],
        registration_text=registration["registration_text"],
        prestige=parse_score(row.get("prestige")),
        selectivity=parse_score(row.get("selectivity")),
        complexity=parse_score(row.get("complexity")),
        time_investment=parse_score(row.get("time_investment")),
        total_score=parse_total_score(row.get("total_score_sum_of_the_above")
                                      or row.get("total_score")),
        difficulty=parse_difficulty(row.get("difficulty_level_easy_medium_hard")
                                    or row.get("difficulty_level")),
        official_urls=extract_urls(row.get("submission_details"), row.get("notes"),
                                   row.get("description"), row.get("registration_open")),
        winner_lists=winners,
        notes=notes,
        comments=comments,
        source_rows=[{k: v for k, v in row.items() if v not in (None, "")}],
    )

    if not comp.description:
        comp.warnings.append("no description — weak embedding, weak matching")
    if re.match(r"^https?://", name, re.IGNORECASE):
        comp.warnings.append("name is a URL — looks like a junk row, not a competition")
    if not comp.domains:
        comp.warnings.append("no subject/domain — will not survive domain prefiltering")
    if comp.deadline_precision == "unknown":
        comp.warnings.append("no parseable deadline — treated as AWAITING_VERIFICATION")
    # A missing official URL is no longer a blocker: verification searches the web
    # from the competition's own details and finds the source itself.
    if not comp.official_urls:
        comp.warnings.append("no official URL — verification will search for the source")
    if comp.prestige is None and comp.selectivity is None:
        comp.warnings.append("unscored — reranker falls back to semantic fit only")
    return comp


def merge(existing: Competition, incoming: Competition) -> Competition:
    """Same competition present in both sheets: union regions, fill gaps, keep both rows."""
    for r in incoming.regions:
        if r not in existing.regions:
            existing.regions.append(r)
    for s in incoming.source_sheets:
        if s not in existing.source_sheets:
            existing.source_sheets.append(s)
    for f in ("description", "submission_details", "deadline_date", "deadline_month",
              "deadline_year", "deadline_text", "grade_min", "grade_max", "age_min",
              "age_max", "eligibility_raw", "allows_individual", "allows_team",
              "team_min", "team_max", "team_raw", "registration_status",
              "registration_text", "prestige", "selectivity", "complexity",
              "time_investment", "total_score", "difficulty", "winner_lists",
              "notes", "comments", "domains_raw"):
        if getattr(existing, f) in (None, "") and getattr(incoming, f) not in (None, ""):
            setattr(existing, f, getattr(incoming, f))
    for d in incoming.domains:
        if d not in existing.domains:
            existing.domains.append(d)
    for u in incoming.official_urls:
        if u not in existing.official_urls:
            existing.official_urls.append(u)
    existing.source_rows.extend(incoming.source_rows)
    existing.warnings = [w for w in existing.warnings
                         if not (w.startswith("no description") and existing.description)]
    return existing


# --------------------------------------------------------------------------
# embedding document + chroma metadata
# --------------------------------------------------------------------------

def build_document(c: Competition) -> str:
    """The text that gets embedded.

    PUBLIC-SAFE ONLY. Winner lists, internal notes and internal comments are
    deliberately excluded: retrieval must not be able to surface private IP into
    a TOF report or a public chatbot answer.
    """
    lines = [c.name]

    if c.domains_raw:
        lines.append(f"Subject / domain: {c.domains_raw}")
    if c.description:
        lines.append(f"About: {c.description}")
    if c.submission_details:
        lines.append(f"What you submit: {c.submission_details}")

    who = []
    if c.eligibility_raw:
        who.append(c.eligibility_raw)
    if c.team_raw:
        who.append(c.team_raw)
    who.append(c.region)
    lines.append(f"Who can enter: {'; '.join(who)}")

    if c.is_rolling:
        lines.append("Deadline: rolling / ongoing")
    elif c.deadline_text:
        lines.append(f"Deadline: {c.deadline_text}")

    if c.registration_text:
        lines.append(f"Registration: {c.registration_text}")

    scored = [f"{label} {val}/5" for label, val in
              (("prestige", c.prestige), ("selectivity", c.selectivity),
               ("complexity", c.complexity), ("time investment", c.time_investment))
              if val is not None]
    if scored:
        lines.append("Profile: " + ", ".join(scored))
    if c.difficulty:
        lines.append(f"Difficulty: {c.difficulty.title()}")

    return "\n".join(lines)


# Chroma Cloud caps metadata at 32 keys per document. Everything here is a fixed
# key, so the count cannot grow with the data — an earlier version added one
# boolean per domain and blew the cap on competitions tagged with 5+ subjects.
MAX_METADATA_KEYS = 32


def build_metadata(c: Competition) -> dict:
    """Chroma metadata must be flat scalars (str/int/float/bool).

    This carries only the cheap prefilters used for candidate generation:
    region, and enough numeric context to debug a result set. Authoritative
    filtering (grade, team size, cycle, domain) happens in Postgres against the
    real row — Chroma narrows, SQL decides.

    `domains` is stored as a display string, not as filterable keys. 109 of 237
    competitions have no Subject/Domain cell at all, so filtering on it would
    hide most of the repository; the semantic query and the reranker carry
    domain relevance instead.
    """
    meta: dict[str, Any] = {
        "slug": c.slug,
        "base_slug": c.base_slug,
        "name": c.name,
        # the tag the app filters on at query time, from the student's signup country
        "region": c.region,
        "region_code": c.region_code,
        "domains": "|".join(c.domains) if c.domains else "",
        "is_rolling": bool(c.is_rolling),
        "deadline_precision": c.deadline_precision,
        "has_deadline": c.deadline_date is not None,
        "scored": c.prestige is not None or c.selectivity is not None,
        # False when the row carries nothing but a name. Such a document embeds
        # to near-noise: it matches weakly against everything and surfaces as a
        # candidate the reranker then has to caveat. Retrieval filters on this.
        "has_content": bool(c.description or c.submission_details or c.domains),
    }
    for key, val in (("grade_min", c.grade_min), ("grade_max", c.grade_max),
                     ("age_min", c.age_min), ("age_max", c.age_max),
                     ("team_min", c.team_min), ("team_max", c.team_max),
                     ("prestige", c.prestige), ("selectivity", c.selectivity),
                     ("complexity", c.complexity), ("time_investment", c.time_investment),
                     ("total_score", c.total_score), ("deadline_year", c.deadline_year),
                     ("deadline_month", c.deadline_month)):
        if val is not None:
            meta[key] = int(val)
    for key, val in (("difficulty", c.difficulty),
                     ("registration_status", c.registration_status)):
        if val:
            meta[key] = val

    # Fail here, with the competition named, rather than at the Chroma API with
    # an opaque quota error partway through an upsert batch.
    if len(meta) >= MAX_METADATA_KEYS:
        raise ValueError(
            f"{c.slug} would carry {len(meta) + 1} metadata keys (incl. content_hash); "
            f"Chroma Cloud allows {MAX_METADATA_KEYS}. Keys: {sorted(meta)}"
        )
    return meta


def document_hash(document: str, metadata: dict) -> str:
    """Re-embed only when the document or its filters actually changed."""
    payload = document + "\x00" + "\x00".join(
        f"{k}={metadata[k]}" for k in sorted(metadata) if k != "content_hash"
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
