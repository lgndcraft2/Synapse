"""The structured reformat prompt and the cleanup of what models return."""

import pytest

from app.services.ai import (
    _build_explain_prompt,
    _build_system_prompt,
    _strip_code_fences,
    clean_reformat_html,
    markdown_emphasis_to_html,
    reformat_output_budget,
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
        # Cut off at the output limit: keep everything, not just up to the
        # first complete block (which is how a long page came back as only
        # its "core argument").
        (
            '<div class="syn"><div class="syn-key"><p>Key</p></div><p>Second part, cut off mid',
            '<div class="syn"><div class="syn-key"><p>Key</p></div><p>Second part, cut off mid',
        ),
    ],
)
def test_clean_reformat_html(raw, expected):
    assert clean_reformat_html(raw) == expected


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("<p>A **key term** here</p>", "<p>A <strong>key term</strong> here</p>"),
        ("<p>A __key term__ here</p>", "<p>A <strong>key term</strong> here</p>"),
        ("<p>An *aside* and an _aside_</p>", "<p>An <em>aside</em> and an <em>aside</em></p>"),
        ("<p>***Both***</p>", "<p><strong><em>Both</em></strong></p>"),
        ("<p>**see *this***</p>", "<p><strong>see <em>this</em></strong></p>"),
        ("<p>**One** and **two**</p>", "<p><strong>One</strong> and <strong>two</strong></p>"),
        ("<li>**Term:** meaning</li>", "<li><strong>Term:</strong> meaning</li>"),
        # Not emphasis: arithmetic, mid-word marks, snake_case, lone markers.
        ("<p>2 * 3 * 4</p>", "<p>2 * 3 * 4</p>"),
        ("<p>a*b*c and snake_case_name</p>", "<p>a*b*c and snake_case_name</p>"),
        ("<p>* not a list</p>", "<p>* not a list</p>"),
        ("<p>** spaced **</p>", "<p>** spaced **</p>"),
        # Attributes and code are left exactly as written.
        ('<a href="/a_b_c/*x*">link</a>', '<a href="/a_b_c/*x*">link</a>'),
        ("<p><code>**kwargs</code> and <code>*args*</code></p>", "<p><code>**kwargs</code> and <code>*args*</code></p>"),
        ("<pre>_x_ <b>*y*</b></pre> *z*", "<pre>_x_ <b>*y*</b></pre> <em>z</em>"),
        ("<p>Already <strong>bold</strong></p>", "<p>Already <strong>bold</strong></p>"),
    ],
)
def test_markdown_emphasis_to_html(raw, expected):
    assert markdown_emphasis_to_html(raw) == expected


def test_reformat_and_explain_output_convert_markdown_emphasis():
    assert clean_reformat_html('```html\n<div class="syn"><p>**Key**</p></div>\n```') == (
        '<div class="syn"><p><strong>Key</strong></p></div>'
    )
    assert _strip_code_fences("```html\n<div><p>An *aside*</p></div>\n```") == (
        "<div><p>An <em>aside</em></p></div>"
    )


@pytest.mark.parametrize("chars, expected", [(0, 2000), (12000, 5600), (100000, 8192)])
def test_reformat_budget_follows_the_source(chars, expected):
    assert reformat_output_budget(chars) == expected
