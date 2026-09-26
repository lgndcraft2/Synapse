"""The fixed, first-party avatar catalogue.

Avatar selection is intentionally not an upload feature.  Persisting a stable
catalogue key rather than an arbitrary URL prevents the profile endpoint from
becoming an image-hosting or tracking surface.
"""

AVATAR_IDS = frozenset(
    {
        "aurora",
        "bay",
        "cinder",
        "dune",
        "ember",
        "fern",
        "glacier",
        "harbor",
        "indigo",
        "juniper",
        "koi",
        "lilac",
        "moss",
        "nova",
        "ochre",
    }
)

AVATAR_PREFIX = "avatar:"


def avatar_url_for(avatar_id: str) -> str:
    """Return the opaque stored representation for an approved avatar."""
    return f"{AVATAR_PREFIX}{avatar_id}"
