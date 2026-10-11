"""The structured reformat prompt and the cleanup of what models return."""

import pytest

from app.services.ai import (
    _build_explain_prompt,
    _build_system_prompt,
    clean_reformat_html,
)

PROFILE = {
    "profile_type": "load-reducer",
    "preferred_format": "bullet points",
    "chunk_size": "short",
    "needs_examples_first": True,
    "simplify_vocab": False,
    "max_nesting_depth": 2,
    "notes": "",
}


@pytest.mark.parametrize(
    "profile_type, expected, absent",
    [
        ("load-reducer", '"The key idea"', '"Remember"'),
        ("comprehension-gap", '"What this is really saying"', '"Part N of M'),
        ("hyperfocus", '"Remember"', '"The key idea"'),
    ],
)
def test_each_profile_gets_its_own_layout(profile_type, expected, absent):
    prompt = _build_system_prompt({**PROFILE, "profile_type": profile_type}, "No feedback.")
    assert expected in prompt
    assert absent not in prompt


def test_unknown_profile_falls_back_to_load_reducer():
    prompt = _build_system_prompt({**PROFILE, "profile_type": "unheard-of"}, "No feedback.")
    assert '"The key idea"' in prompt


def test_prompt_carries_the_contract_preferences_and_feedback():
    prompt = _build_system_prompt(
        {**PROFILE, "notes": "Short sentences please"}, "IMPORTANT: simplify further."
    )
    for block in ("syn-key", "syn-part", "syn-note", "syn-example", "syn-recap", "syn-label"):
        assert block in prompt
    assert 'Direct note from the user: "Short sentences please"' in prompt
    assert "IMPORTANT: simplify further." in prompt
    assert "<source_content>" in prompt


def test_reformat_prompt_drops_the_old_strategy_lines():
    # The layout recipe replaces them; keeping both gave conflicting rules
    # (e.g. one <mark> per section vs. once in the whole answer).
    prompt = _build_system_prompt(PROFILE, "No feedback.")
    assert "COGNITIVE STRATEGY" not in prompt


def test_explain_prompt_still_gets_the_strategy_and_note():
    prompt = _build_explain_prompt(
        {**PROFILE, "profile_type": "hyperfocus", "notes": "Be brief"}, "No feedback.", False, False
    )
    assert "COGNITIVE STRATEGY: Structure and retention" in prompt
    assert prompt.count('Direct note from the user: "Be brief"') == 1


@pytest.mark.parametrize(
    "raw, expected",
    [
        ('<div class="syn"><p>Hi</p></div>', '<div class="syn"><p>Hi</p></div>'),
        ('```html\n<div class="syn"><p>Hi</p></div>\n```', '<div class="syn"><p>Hi</p></div>'),
        ('Here you go:\n<div class="syn"><p>Hi</p></div>\nHope it helps', '<div class="syn"><p>Hi</p></div>'),
        ("```\nplain text\n```", "plain text"),
        ("", ""),
    ],
)
def test_clean_reformat_html(raw, expected):
    assert clean_reformat_html(raw) == expected
