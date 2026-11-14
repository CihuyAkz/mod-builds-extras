import json
import re
import sys
from pathlib import Path


COMMIT_PATTERN = re.compile(r"[0-9a-f]{40}")


def resolve_version(version: str, versions: object) -> str:
    if not isinstance(versions, dict):
        raise ValueError("versions.json is not a table")
    commit = versions.get(version)
    if commit is None:
        commit = versions.get("*")
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
