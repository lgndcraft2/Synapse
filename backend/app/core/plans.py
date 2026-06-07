from __future__ import annotations

FREE_PLAN = "free"
THINKER_LITE_PLAN = "thinker_lite"
DEEP_THINKER_PLAN = "deep_thinker"
INSTITUTIONAL_PLAN = "institutional"
LEGACY_PREMIUM_PLAN = "premium"

PAID_PLANS = {THINKER_LITE_PLAN, DEEP_THINKER_PLAN, INSTITUTIONAL_PLAN}
ACTIVE_PAID_PLANS = {THINKER_LITE_PLAN, DEEP_THINKER_PLAN}

PLAN_DISPLAY_NAMES = {
    FREE_PLAN: "Free",
    THINKER_LITE_PLAN: "Thinker Lite",
    DEEP_THINKER_PLAN: "Deep Thinker",
    INSTITUTIONAL_PLAN: "Institutional",
}

PLAN_ALIASES = {
    LEGACY_PREMIUM_PLAN: DEEP_THINKER_PLAN,
    "thinker-lite": THINKER_LITE_PLAN,
    "deep-thinker": DEEP_THINKER_PLAN,
}


def normalize_plan(plan: str | None) -> str:
    if not plan:
        return FREE_PLAN

    normalized = plan.strip().lower().replace(" ", "_").replace("-", "_")
    return PLAN_ALIASES.get(normalized, normalized)


def display_plan_name(plan: str | None) -> str:
    normalized = normalize_plan(plan)
    return PLAN_DISPLAY_NAMES.get(
        normalized,
        normalized.replace("_", " ").title(),
    )


def is_paid_plan(plan: str | None) -> bool:
    return normalize_plan(plan) in PAID_PLANS


def is_high_tier_plan(plan: str | None) -> bool:
    return normalize_plan(plan) in {DEEP_THINKER_PLAN, INSTITUTIONAL_PLAN}
