#!/usr/bin/env bash
set -euo pipefail

COMMIT=$(python3 - <<'PY'
import json
import os
import re
import sys

versions = json.load(open("versions.json", encoding="utf-8"))
version = os.environ["VERSION"]
commit = versions.get(version)
if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
    sys.exit(f"No valid source commit is registered for version {version!r} in versions.json")
print(commit)
PY
)
echo "COMMIT=$COMMIT" >> "$GITHUB_ENV"

SOURCE_REPO=${SOURCE_REPO:-CihuyAkz/starling-extras}
TOOLS_REPO=${TOOLS_REPO:-CihuyAkz/starling-extras}
TOOLS=${TOOLS:-$COMMIT}

mkdir -p tools
for name in mod_build_sandbox.sh mod_build_server.py mod_build_once.py; do
  curl -fsS --retry 5 --retry-all-errors -o "tools/$name" \
    "https://raw.githubusercontent.com/${TOOLS_REPO}/${TOOLS}/packaging/android/${name}"
done

root=$HOME/modbuild
mkdir -p "$root/jobs" "$root/base"
git init -q "$root/source"
git -C "$root/source" fetch -q --depth 1 "https://github.com/${SOURCE_REPO}" "$COMMIT"
git -C "$root/source" checkout -q --detach FETCH_HEAD

cat > "$HOME/.profile" <<'PROFILE'
export ANDROID_HOME=$HOME/android
PROFILE
