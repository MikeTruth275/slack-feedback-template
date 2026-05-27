
"""
Helper module to load repository default tags from catalog-info.yaml.
These tags are applied to all taggable cloud resources.
"""

import json
from pathlib import Path

import yaml


def load_repo_tags() -> dict[str, str]:
    """
    Load default tags from catalog-info.yaml for AWS resources.

    Returns a dict with:
    - All scalar key/value pairs from spec (type, lifecycle, owner, system)
    - repo: from metadata.annotations["github.com/project-slug"]
    - managed_by: "pulumi"
    """
    catalog_path = Path(__file__).parent / "catalog-info.yaml"

    with open(catalog_path, "r") as f:
        data = yaml.safe_load(f)

    tags: dict[str, str] = {}

    # Extract spec block tags
    spec = data.get("spec", {})
    for key, value in spec.items():
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            tags[str(key)] = str(value)
        else:
            # Non-scalar values: convert to compact JSON string
            tags[str(key)] = json.dumps(value, separators=(",", ":"))

    # Add repo tag from annotations
    annotations = data.get("metadata", {}).get("annotations", {})
    repo_slug = annotations.get("github.com/project-slug")
    if repo_slug:
        tags["repo"] = str(repo_slug)

    # Add managed_by tag
    tags["managed_by"] = "pulumi"

    return tags


def merge_tags(base: dict[str, str], extra: dict[str, str] | None) -> dict[str, str]:
    """Merge base tags with extra tags. Extra tags override base on key collisions."""
    return {**base, **(extra or {})}


