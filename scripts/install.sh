#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: bash scripts/install.sh /path/to/llm_wiki" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$(cd "$1" && pwd)"

if [ ! -f "$TARGET/package.json" ] || [ ! -f "$TARGET/src-tauri/Cargo.toml" ]; then
  echo "The target path does not look like an llm_wiki checkout: $TARGET" >&2
  exit 1
fi

cd "$ROOT/plugin-files"
find . -type f | while read -r file; do
  rel="${file#./}"
  mkdir -p "$TARGET/$(dirname "$rel")"
  cp "$file" "$TARGET/$rel"
  echo "Copied $rel"
done

cd "$TARGET"
git apply --check "$ROOT/patches/llm-wiki-zotero-integration.patch"
git apply "$ROOT/patches/llm-wiki-zotero-integration.patch"
echo "LLM Wiki Zotero import plugin installed."
