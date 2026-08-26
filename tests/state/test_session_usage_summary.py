"""``get_session_usage_summary`` reports what actually served a session.

``sessions.model`` is the CONFIGURED model. After a provider fallback it is no
longer the model answering, so a UI that shows it reports a reassuring lie: a
room can run an entire session on a fallback provider with nothing on screen
saying so. This accessor reads ``session_model_usage``, which records the route
per real call.
"""

import sqlite3

from hermes_state import SessionDB


def _seed(db, session_id, rows):
    """Insert usage rows directly; ``_record_model_usage`` needs a live turn."""
    with sqlite3.connect(db.db_path) as conn:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, source) VALUES (?, 'test')",
            (session_id,),
        )
        for model, provider, calls, inp, out, cost, seen in rows:
            conn.execute(
                """INSERT INTO session_model_usage
                       (session_id, model, billing_provider, billing_base_url,
                        billing_mode, task, api_call_count, input_tokens,
                        output_tokens, cache_read_tokens, cache_write_tokens,
                        reasoning_tokens, estimated_cost_usd, actual_cost_usd,
                        first_seen, last_seen)
                   VALUES (?, ?, ?, '', '', '', ?, ?, ?, 0, 0, 0, ?, 0, ?, ?)""",
                (session_id, model, provider, calls, inp, out, cost, seen, seen),
            )
        conn.commit()


def test_returns_none_when_a_session_never_made_a_call(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    _seed(db, "s-empty", [])
    assert db.get_session_usage_summary("s-empty") is None


def test_reports_the_most_recent_route_not_the_busiest(tmp_path):
    """A late fallback is the thing worth surfacing, even if it served least.

    The dominant-route accessor answers "what mostly served this"; for catching
    a silent downgrade we need "what served it last".
    """
    db = SessionDB(db_path=tmp_path / "state.db")
    _seed(
        db,
        "s-fallback",
        [
            ("claude-sonnet-5", "anthropic", 40, 1000, 500, 0.5, 100),
            ("gemini-2.5-flash", "gemini", 2, 100, 50, 0.01, 200),
        ],
    )

    summary = db.get_session_usage_summary("s-fallback")

    assert summary["model"] == "gemini-2.5-flash"
    assert summary["provider"] == "gemini"
    assert summary["changed_route"] is True
    assert {m["model"] for m in summary["models"]} == {
        "claude-sonnet-5",
        "gemini-2.5-flash",
    }


def test_single_route_is_not_flagged_as_changed(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    _seed(db, "s-clean", [("claude-sonnet-5", "anthropic", 5, 100, 50, 0.02, 100)])

    summary = db.get_session_usage_summary("s-clean")

    assert summary["changed_route"] is False
    assert summary["model"] == "claude-sonnet-5"


def test_totals_sum_across_every_route(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    _seed(
        db,
        "s-totals",
        [
            ("a", "p1", 3, 1000, 200, 0.25, 100),
            ("b", "p2", 4, 500, 300, 0.75, 200),
        ],
    )

    summary = db.get_session_usage_summary("s-totals")

    assert summary["input_tokens"] == 1500
    assert summary["output_tokens"] == 500
    assert summary["api_call_count"] == 7
    assert summary["total_tokens"] == 2000
    assert summary["estimated_cost_usd"] == 1.0


def test_unknown_model_rows_are_ignored(tmp_path):
    """'unknown' is the placeholder written before a route resolves."""
    db = SessionDB(db_path=tmp_path / "state.db")
    _seed(
        db,
        "s-unknown",
        [
            ("unknown", "", 1, 10, 10, 0.0, 50),
            ("claude-sonnet-5", "anthropic", 2, 100, 50, 0.02, 100),
        ],
    )

    summary = db.get_session_usage_summary("s-unknown")

    assert summary["model"] == "claude-sonnet-5"
    assert summary["changed_route"] is False
