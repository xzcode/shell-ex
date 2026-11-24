#!/usr/bin/env bash
# Build and publish the macOS Apple Silicon release without GitHub Actions.
# Usage: bash scripts/release_local_macos.sh
set -Eeuo pipefail

VERSION="0.3.2"
TAG="v${VERSION}"
REPO="xzcode/shell-ex"
TARGET="aarch64-apple-darwin"

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "Missing $1. Install it, then re-run."; }

[[ "$(uname -s)" == "Darwin" ]] || fail "This script must run on macOS."
[[ "$(uname -m)" == "arm64" ]] || fail "Requires an Apple Silicon Mac."
for executable in git node npm cargo rustc rustup xcode-select shasum python3; do need "$executable"; done
xcode-select -p >/dev/null 2>&1 || fail "Install Xcode Command Line Tools: xcode-select --install"

[[ -z "$(git status --porcelain)" ]] || fail "Working tree is not clean. Commit/stash local changes before publishing."
[[ "$(git branch --show-current)" == "master" ]] || fail "Switch to master to build the release."
git remote get-url origin >/dev/null || fail "Git origin remote is missing."
[[ "$(node -p "require('./apps/desktop/package.json').version")" == "$VERSION" ]] || fail "Wrong npm package version."
[[ "$(python3 -c "import json; print(json.load(open('apps/desktop/src-tauri/tauri.conf.json'))['version'])")" == "$VERSION" ]] || fail "Wrong Tauri version."
[[ "$(grep '^version = "' Cargo.toml | head -1)" == "version = \"$VERSION\"" ]] || fail "Wrong Rust workspace version."

SOURCE_SHA="$(git rev-parse HEAD)"
printf '\nShell EX %s, source %s\n' "$TAG" "$SOURCE_SHA"
printf 'Building Apple Silicon installer without GitHub Actions...\n'

rustup target add "$TARGET"
npm ci --prefix apps/desktop
(
  cd apps/desktop
  npm run tauri -- build --target "$TARGET" --bundles dmg
)

BUNDLE_DIR="target/$TARGET/release/bundle/dmg"
shopt -s nullglob
dmgs=("$BUNDLE_DIR"/*.dmg)
[[ "${#dmgs[@]}" == 1 ]] || fail "Expected one DMG in $BUNDLE_DIR, found ${#dmgs[@]}"
shopt -u nullglob

OUT="$ROOT/dist/releases/$TAG"
mkdir -p "$OUT"
FILENAME="Shell-EX_${VERSION}_aarch64-${SOURCE_SHA:0:12}.dmg"
cp "${dmgs[0]}" "$OUT/$FILENAME"
(
  cd "$OUT"
  shasum -a 256 "$FILENAME" > "$FILENAME.sha256"
)
cat > "$OUT/$FILENAME.build.json" <<EOF
{
  "version": "$VERSION",
  "tag": "$TAG",
  "sourceCommit": "$SOURCE_SHA",
  "target": "$TARGET",
  "platform": "macOS Apple Silicon",
  "bundle": "$FILENAME",
  "macosSigning": "ad-hoc",
  "notarized": false,
  "actionsUsed": false
}
EOF

printf '\nCreated: %s\n' "$OUT/$FILENAME"
cat "$OUT/$FILENAME.sha256"

if ! command -v gh >/dev/null 2>&1; then
  printf '\nBuild complete, GitHub Release not published: install GitHub CLI (brew install gh).\n'
  printf 'Then authenticate with: gh auth login\n'
  exit 2
fi
if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  printf '\nBuild complete, GitHub Release not published: gh auth login is required.\n'
  exit 2
fi

# Never silently replace an existing release asset or publish the wrong source.
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  EXISTING_SHA="$(gh api "repos/$REPO/git/ref/tags/$TAG" --jq '.object.sha')"
  [[ "$EXISTING_SHA" == "$SOURCE_SHA" ]] || fail "Existing tag $TAG points to a different source."
  gh release upload "$TAG" "$OUT/$FILENAME" "$OUT/$FILENAME.sha256" "$OUT/$FILENAME.build.json" --repo "$REPO"
else
  gh release create "$TAG" \
    "$OUT/$FILENAME" "$OUT/$FILENAME.sha256" "$OUT/$FILENAME.build.json" \
    --repo "$REPO" --target "$SOURCE_SHA" \
    --title "Shell EX $TAG" \
    --notes-file "$ROOT/docs/releases/v0.3.2.md" \
    --latest
fi

printf '\nPublished GitHub Release: https://github.com/%s/releases/tag/%s\n' "$REPO" "$TAG"
gh release view "$TAG" --repo "$REPO" --json tagName,isDraft,isPrerelease,assets,url \
  --jq '{tagName,isDraft,isPrerelease,assets:[.assets[].name],url}'
