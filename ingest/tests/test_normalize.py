"""Parser tests against the messy value shapes the real sheets contain."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from normalize import (  # noqa: E402
    build_document,
    build_metadata,
    merge,
    normalize_header,
    parse_age_grade,
    parse_deadline,
    parse_difficulty,
    parse_domains,
    parse_month,
    parse_registration,
    parse_score,
    parse_team,
    row_to_competition,
    slugify,
)


def test_normalize_header_handles_quotes_newlines_and_endash():
    assert normalize_header('"Prestige (1–5)\n"') == "prestige"
    assert normalize_header("Time Investment (1–5)") == "time_investment"
    assert normalize_header("Winner List (s)") == "winner_list_s"
    assert normalize_header("Age/Grade") == "age_grade"
    assert normalize_header("Total Score (sum of the above)") == "total_score_sum_of_the_above"
    assert normalize_header("Difficulty Level (Easy / Medium / Hard)") == \
        "difficulty_level_easy_medium_hard"
    assert normalize_header("   ") == ""


def test_parse_month_forms():
    assert parse_month("March") == 3
    assert parse_month("Mar") == 3
    assert parse_month("3") == 3
    assert parse_month("03") == 3
    assert parse_month("mid-September") == 9
    assert parse_month("") is None
    assert parse_month("TBA") is None


def test_parse_deadline_precision_levels():
    full = parse_deadline("15", "March", "2026")
    assert full["deadline_date"] == "2026-03-15" and full["precision"] == "day"

    month_only = parse_deadline("", "March", "2026")
    assert month_only["deadline_date"] is None
    assert (month_only["deadline_month"], month_only["deadline_year"]) == (3, 2026)
    assert month_only["precision"] == "month"

    rolling = parse_deadline("", "Rolling", "")
    assert rolling["is_rolling"] and rolling["precision"] == "rolling"

    nothing = parse_deadline("", "", "")
    assert nothing["precision"] == "unknown" and nothing["deadline_text"] is None

    # an impossible day must not fabricate a date
    bad = parse_deadline("31", "February", "2026")
    assert bad["deadline_date"] is None and bad["precision"] == "month"


def test_parse_age_grade_variants():
    assert parse_age_grade("Grades 9-12")["grade_min"] == 9
    assert parse_age_grade("Grades 9-12")["grade_max"] == 12
    assert parse_age_grade("13-18 years")["age_min"] == 13
    assert parse_age_grade("13-18 years")["age_max"] == 18
    assert parse_age_grade("Class 8 onwards")["grade_min"] == 8
    assert parse_age_grade("Under 19")["age_max"] == 19
    assert parse_age_grade("")["eligibility_raw"] is None
    # reversed range is normalised, not dropped
    assert parse_age_grade("Grades 12-9")["grade_min"] == 9


def test_parse_team_variants():
    solo = parse_team("Individual")
    assert solo["allows_individual"] and not solo["allows_team"]

    team = parse_team("Team (2-5)")
    assert team["allows_team"] and team["team_min"] == 2 and team["team_max"] == 5

    either = parse_team("Individual or team")
    assert either["allows_individual"] and either["allows_team"]

    capped = parse_team("Teams of up to 4")
    assert capped["team_max"] == 4


def test_parse_scores_missing_stays_none():
    assert parse_score("4") == 4
    assert parse_score("4.2") == 4
    assert parse_score("") is None
    assert parse_score("N/A") is None
    assert parse_score("7") is None          # out of the 1-5 range
    assert parse_difficulty("Hard") == "HARD"
    assert parse_difficulty("medium ") == "MEDIUM"
    assert parse_difficulty("") is None


def test_parse_domains_canonicalises_and_keeps_unknowns():
    d = parse_domains("AI, Environmental Science / Robotics")
    assert d["domains"] == ["ai", "sustainability", "robotics"]
    assert parse_domains("Underwater Basket Weaving")["domains"] == ["underwater-basket-weaving"]
    assert parse_domains("")["domains"] == []


def test_parse_registration_statuses():
    assert parse_registration("Open")["registration_status"] == "OPEN"
    assert parse_registration("Closed")["registration_status"] == "CLOSED"
    assert parse_registration("Rolling")["registration_status"] == "ROLLING"
    assert parse_registration("")["registration_status"] is None


def _row(**over):
    base = {
        "competition_name": "IRIS National Fair",
        "submission_day": "15",
        "submission_month": "March",
        "submission_year": "2026",
        "winner_list_s": "https://iris.example/winners-2025",
        "age_grade": "Grades 9-12",
        "registration_open": "Open",
        "individual_team": "Individual or team (up to 3)",
        "description": "India's national science and engineering fair.",
        "submission_details": "Abstract, report and poster via https://iris.example/apply",
        "subject_domain": "Science, Engineering",
        "notes": "Internal: our students placed top-100 twice.",
        "prestige": "5",
        "selectivity": "4",
        "complexity": "",
        "time_investment": "",
        "total_score": "",
        "difficulty_level_easy_medium_hard": "Hard",
        "comments": "Priya owns this relationship.",
    }
    base.update(over)
    return base


def test_row_to_competition_end_to_end():
    c = row_to_competition(_row(), region="IN", sheet="india.csv")
    assert c.base_slug == slugify("IRIS National Fair") == "iris-national-fair"
    # the document id is region-qualified so retrieval can filter on the tag
    assert c.slug == "iris-national-fair--in"
    assert c.region == "India" and c.region_code == "IN"
    assert c.deadline_date == "2026-03-15"
    assert c.grade_min == 9 and c.grade_max == 12
    assert c.prestige == 5 and c.complexity is None
    assert c.difficulty == "HARD"
    assert "https://iris.example/apply" in c.official_urls
    assert c.regions == ["IN"]
    # partially-scored competitions must be flagged, not silently zero-filled
    assert any("unscored" in w for w in c.warnings) is False   # prestige present
    assert row_to_competition({"competition_name": ""}, "IN", "india.csv") is None


def test_internal_fields_never_reach_the_embedding_document():
    c = row_to_competition(_row(), region="IN", sheet="india.csv")
    doc = build_document(c)
    assert "Internal:" not in doc
    assert "Priya" not in doc
    assert "winners-2025" not in doc
    # but they are still captured for internal use
    assert c.notes and c.comments and c.winner_lists
    # public content is present
    assert "IRIS National Fair" in doc and "national science and engineering fair" in doc


def test_chroma_metadata_is_flat_scalars_only():
    c = row_to_competition(_row(), region="IN", sheet="india.csv")
    meta = build_metadata(c)
    assert all(isinstance(v, (str, int, float, bool)) for v in meta.values()), meta
    assert meta["domains"] == "science|engineering"
    assert meta["region"] == "India" and meta["region_code"] == "IN"
    assert "complexity" not in meta          # missing score omitted, not zeroed


def test_metadata_key_count_cannot_grow_with_the_data():
    """Chroma Cloud caps metadata at 32 keys. Every key must be fixed, so a
    competition tagged with many subjects cannot blow the quota."""
    from normalize import MAX_METADATA_KEYS

    many_domains = row_to_competition(
        _row(subject_domain="Science, Engineering, AI, Robotics, Physics, Chemistry, "
                            "Biology, Mathematics, Sustainability, Design, Medicine"),
        region="IN", sheet="india.csv",
    )
    assert len(many_domains.domains) >= 10
    meta = build_metadata(many_domains)
    # +1 for content_hash, added at index time
    assert len(meta) + 1 <= MAX_METADATA_KEYS, sorted(meta)


def test_same_competition_in_both_sheets_stays_two_documents():
    """A competition in both sheets is two docs with different ids and tags, so a
    student in India never retrieves the US listing's eligibility text."""
    india = row_to_competition(_row(), "IN", "india.csv")
    us = row_to_competition(_row(), "US", "us.csv")
    assert india.slug != us.slug
    assert india.base_slug == us.base_slug
    assert (india.region, us.region) == ("India", "USA")


def test_merge_fills_gaps_for_duplicate_rows_within_one_sheet():
    a = row_to_competition(_row(complexity="", description=""), "IN", "india.csv")
    b = row_to_competition(_row(complexity="3", description="Global fair."), "IN", "india.csv")
    merged = merge(a, b)
    assert merged.complexity == 3
    assert merged.description == "Global fair."
    assert len(merged.source_rows) == 2
