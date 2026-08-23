"""OAuth system-prompt tool-name sanitization.

Anthropic Pro/Max OAuth bills against plan limits only when the request looks
like Claude Code. Tool *schemas* are already rewritten to ``mcp__*`` on the
OAuth wire (GH-25255), but the billing classifier ALSO scans system-prompt
prose. Bare Hermes tool identifiers in that prose
(``skill_manage``, ``session_search``, …) flip the request onto the unpaid
\"extra usage\" pool and surface as:

    HTTP 400 You're out of extra usage. Add more at claude.ai/settings/usage

This module pins the system-text rewrite that aligns prose mentions with the
wire names.
"""
from __future__ import annotations

from agent.anthropic_adapter import (
    _oauth_sanitize_system_text,
    build_anthropic_kwargs,
)


def test_oauth_sanitize_rewrites_snake_case_tool_mentions():
    src = (
        "save the approach as a skill with skill_manage so you can reuse it. "
        "use session_search to recall past transcripts. "
        "load it with skill_view(name)."
    )
    out = _oauth_sanitize_system_text(src)
    assert "skill_manage" not in out or "mcp__skill_manage" in out
    assert "mcp__skill_manage" in out
    assert "mcp__session_search" in out
    assert "mcp__skill_view" in out
    # bare forms must not remain as identifiers
    assert " with skill_manage " not in f" {out} "
    assert " use session_search " not in f" {out} "


def test_oauth_sanitize_preserves_english_single_word_tools():
    src = (
        "You have persistent memory across sessions. "
        "Don't repeat a stale patch. "
        "Use `terminal` for git and `memory` for facts."
    )
    out = _oauth_sanitize_system_text(src)
    # prose stays intact
    assert "persistent memory across" in out
    assert "stale patch" in out
    # backtick tool refs are aligned to the wire name
    assert "`mcp__terminal`" in out
    assert "`mcp__memory`" in out
    assert "`terminal`" not in out
    assert "`memory`" not in out


def test_oauth_sanitize_product_names():
    src = "Hermes Agent by Nous Research (hermes-agent) helps you."
    out = _oauth_sanitize_system_text(src)
    assert "Hermes Agent" not in out
    assert "Nous Research" not in out
    assert "hermes-agent" not in out
    assert "Claude Code" in out
    assert "Anthropic" in out
    assert "claude-code" in out


def test_build_anthropic_kwargs_oauth_sanitizes_system_tool_mentions():
    kwargs = build_anthropic_kwargs(
        model="claude-sonnet-4-6",
        messages=[
            {
                "role": "system",
                "content": (
                    "You are Hermes Agent by Nous Research. "
                    "Call skill_manage and session_search when needed. "
                    "Use `terminal` for shell."
                ),
            },
            {"role": "user", "content": "hi"},
        ],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "skill_manage",
                    "description": "x",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "session_search",
                    "description": "y",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "terminal",
                    "description": "z",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
        ],
        max_tokens=64,
        reasoning_config=None,
        is_oauth=True,
    )

    system = kwargs["system"]
    assert isinstance(system, list)
    # Claude Code identity first
    assert system[0]["text"].startswith("You are Claude Code")
    joined = "\n".join(b.get("text", "") for b in system if isinstance(b, dict))
    assert "Hermes Agent" not in joined
    assert "Nous Research" not in joined
    assert "mcp__skill_manage" in joined
    assert "mcp__session_search" in joined
    assert "`mcp__terminal`" in joined
    # wire tool schemas also prefixed
    assert sorted(t["name"] for t in kwargs["tools"]) == [
        "mcp__session_search",
        "mcp__skill_manage",
        "mcp__terminal",
    ]


def test_build_anthropic_kwargs_oauth_sanitizes_tool_descriptions_and_schemas():
    kwargs = build_anthropic_kwargs(
        model="claude-sonnet-4-6",
        messages=[{"role": "user", "content": "hi"}],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "skill_manage",
                    "description": (
                        "Manage skills. Prefer session_search for history and "
                        "skill_view to load content."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "hint": {
                                "type": "string",
                                "description": "Mention session_search if needed.",
                            }
                        },
                    },
                },
            },
        ],
        max_tokens=64,
        reasoning_config=None,
        is_oauth=True,
    )
    tool = kwargs["tools"][0]
    assert tool["name"] == "mcp__skill_manage"
    assert "mcp__session_search" in tool["description"]
    assert "mcp__skill_view" in tool["description"]
    # bare ids must not remain as identifiers in description
    assert " session_search " not in f" {tool['description']} "
    assert " skill_view " not in f" {tool['description']} "
    schema_blob = str(tool["input_schema"])
    assert "mcp__session_search" in schema_blob
    assert "session_search" not in schema_blob.replace("mcp__session_search", "")


def test_build_anthropic_kwargs_non_oauth_leaves_system_tool_names():
    kwargs = build_anthropic_kwargs(
        model="claude-sonnet-4-6",
        messages=[
            {
                "role": "system",
                "content": "Call skill_manage. Hermes Agent.",
            },
            {"role": "user", "content": "hi"},
        ],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "skill_manage",
                    "description": "x",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
        ],
        max_tokens=64,
        reasoning_config=None,
        is_oauth=False,
    )
    system = kwargs["system"]
    joined = system if isinstance(system, str) else "\n".join(
        b.get("text", "") if isinstance(b, dict) else str(b) for b in (system or [])
    )
    assert "skill_manage" in joined
    assert "mcp__skill_manage" not in joined
    assert kwargs["tools"][0]["name"] == "skill_manage"
