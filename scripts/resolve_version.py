import json
import re
import sys
from pathlib import Path


COMMIT_PATTERN = re.compile(r"[0-9a-f]{40}")


def _matches_pattern(pattern: str, version: str) -> bool:
    """Match a version key containing '*' without treating other glob syntax specially."""
    if "*" not in pattern:
        return False
    expression = re.escape(pattern).replace(r"\*", ".*")
    return re.fullmatch(expression, version) is not None


def resolve_version(version: str, versions: object) -> str:
    if not isinstance(versions, dict):
        raise ValueError("versions.json is not a table")

    if version in versions:
        commit = versions[version]
    else:
        matches = [
            (pattern, value)
            for pattern, value in versions.items()
            if isinstance(pattern, str) and _matches_pattern(pattern, version)
        ]
        if not matches:
            raise ValueError(f"No source commit is registered for version {version!r}")

        # Prefer the most specific pattern: the most literal characters, then
        # the fewest wildcards. A stable tie-break keeps resolution deterministic.
        pattern, commit = max(
            matches,
            key=lambda item: (
                len(item[0].replace("*", "")),
                -item[0].count("*"),
                item[0],
            ),
        )

    if not isinstance(commit, str) or not COMMIT_PATTERN.fullmatch(commit):
        raise ValueError(f"No valid source commit is registered for version {version!r}")
    return commit


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: resolve_version.py VERSION", file=sys.stderr)
        return 2
    try:
        with Path("versions.json").open(encoding="utf-8") as source:
            versions = json.load(source)
        print(resolve_version(sys.argv[1], versions))
        return 0
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
