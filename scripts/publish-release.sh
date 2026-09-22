#!/usr/bin/env bash
#
# Publish an already-built release: binaries to R2, the package to npm, and
# only then the channel pointers.
#
#   ./scripts/publish-release.sh 0.1.0                # R2 + npm, move `latest`
#   ./scripts/publish-release.sh 0.1.0 --stable       # also move `stable`
#   ./scripts/publish-release.sh 0.1.0 --no-npm
#   ./scripts/publish-release.sh 0.1.0 --no-pointer
#   ./scripts/publish-release.sh 0.1.0 --verify-only  # re-check, upload nothing
#
# This script never builds. It publishes exactly the artifacts already sitting
# in release/<version>/, after re-hashing each one against the manifest, so
# what ships is the build that was reviewed — not a fresh, unreviewed compile
# smuggled in by the publish step.
#
# Requires: wrangler auth (CLOUDFLARE_API_TOKEN with R2 write, or `wrangler
# login`) and `npm whoami` as a publisher of the package.
set -euo pipefail

BUCKET="${ML_DASH_R2_BUCKET:-dash-downloads}"
PREFIX="ml-dash-cli/releases"
# Reads go through the public URL — the same path an install takes — so
# verification exercises the domain and cache layer, not just the bucket API.
PUBLIC="${ML_DASH_PUBLIC_URL:-https://dl.dash.ml}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    echo "Usage: $0 <version> [--stable] [--no-pointer] [--no-npm] [--verify-only]" >&2
    exit 1
fi
shift

MOVE_LATEST=1; MOVE_STABLE=0; VERIFY_ONLY=0; PUBLISH_NPM=1
for arg in "$@"; do
    case "$arg" in
        --stable)      MOVE_STABLE=1 ;;
        --no-pointer)  MOVE_LATEST=0 ;;
        --no-npm)      PUBLISH_NPM=0 ;;
        --verify-only) VERIFY_ONLY=1 ;;
        *) echo "Unknown flag: $arg" >&2; exit 1 ;;
    esac
done

REL="$ROOT/release/$VERSION"
[ -f "$REL/manifest.json" ] ||
    { echo "No build at release/$VERSION — run: bun run scripts/build-release.ts" >&2; exit 1; }

wr() { npx --yes wrangler "$@"; }

# `while read` rather than `mapfile`: macOS ships bash 3.2.
manifest_rows() {  # platform binary checksum size, one per line
    python3 -c '
import json, sys
for platform, e in json.load(open(sys.argv[1]))["platforms"].items():
    print(platform, e["binary"], e["checksum"], e["size"])
' "$REL/manifest.json"
}

sha_of() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }

# ── 1. the local artifacts must be the ones the manifest describes ───────────
# Cheap, and it catches the case this whole script exists to prevent: a binary
# rebuilt or edited after review, sharing a version with the reviewed one.
check_local() {
    echo "Checking local artifacts in release/$VERSION"
    manifest_rows | while read -r platform binary checksum size; do
        src="$REL/$platform/$binary"
        [ -f "$src" ] || { echo "  ✗ manifest lists $platform/$binary but the file is missing" >&2; exit 1; }
        actual_size="$(wc -c < "$src" | tr -d ' ')"
        actual_sha="$(sha_of "$src")"
        if [ "$actual_size" != "$size" ] || [ "$actual_sha" != "$checksum" ]; then
            echo "  ✗ $platform/$binary does not match the manifest — rebuild, do not publish" >&2
            exit 1
        fi
        echo "  ✓ $platform/$binary"
    done || exit 1
}

# ── 2. read every uploaded byte back over the public URL ─────────────────────
# A successful wrangler exit is not evidence the bytes are fetchable: the
# object may be missing, truncated, or shadowed by an edge-cached 404 from an
# earlier failed attempt of the same version. The `?v=` query busts that cache;
# versioned objects are otherwise served as immutable.
verify_remote() {
    echo "Verifying $VERSION via $PUBLIC/$PREFIX"
    local vtmp stamp
    vtmp="$(mktemp -d)"; stamp="$(date +%s)"
    trap 'rm -rf "$vtmp"' RETURN
    if ! cmp -s <(curl -fsSL --retry 3 "$PUBLIC/$PREFIX/$VERSION/manifest.json?v=$stamp") "$REL/manifest.json"; then
        echo "  ✗ remote manifest.json is unreachable or differs from the local one" >&2
        exit 1
    fi
    echo "  ✓ manifest.json"
    manifest_rows | while read -r platform binary checksum size; do
        out="$vtmp/$platform-$binary"
        curl -fsSL --retry 3 -o "$out" "$PUBLIC/$PREFIX/$VERSION/$platform/$binary?v=$stamp" ||
            { echo "  ✗ $platform/$binary: download failed" >&2; exit 1; }
        actual_size="$(wc -c < "$out" | tr -d ' ')"
        actual_sha="$(sha_of "$out")"
        rm -f "$out"
        if [ "$actual_size" != "$size" ] || [ "$actual_sha" != "$checksum" ]; then
            echo "  ✗ $platform/$binary: remote bytes differ from the manifest (size $actual_size, sha $actual_sha)" >&2
            exit 1
        fi
        echo "  ✓ $platform/$binary"
    done || exit 1
}

if [ "$VERIFY_ONLY" = "1" ]; then
    check_local
    verify_remote
    echo ""
    echo "Release $VERSION verifies clean — nothing was uploaded or moved."
    exit 0
fi

check_local

IMMUTABLE="public, max-age=31536000, immutable"   # versioned objects never change
POINTER="public, max-age=60, must-revalidate"     # pointers decide new installs

put() {  # put <key> <file> <content-type> <cache-control>
    wr r2 object put "$BUCKET/$1" --file="$2" --content-type="$3" --cache-control="$4" --remote
}

echo ""
echo "Publishing ml-dash $VERSION to r2://$BUCKET/$PREFIX"
manifest_rows | while read -r platform binary checksum size; do
    echo "  → $platform/$binary"
    put "$PREFIX/$VERSION/$platform/$binary" "$REL/$platform/$binary" "application/octet-stream" "$IMMUTABLE"
done || exit 1

echo "  → manifest.json"
put "$PREFIX/$VERSION/manifest.json" "$REL/manifest.json" "application/json" "$IMMUTABLE"

echo "  → install.sh / install.ps1"
for script in install.sh install.ps1; do
    # Root copy keeps the headline command short; the prefixed copy leaves the
    # root free for another tool later without breaking pinned URLs.
    put "$script" "$ROOT/$script" "text/plain; charset=utf-8" "public, max-age=300"
    put "ml-dash-cli/$script" "$ROOT/$script" "text/plain; charset=utf-8" "public, max-age=300"
done

# The gate. No pointer moves, and npm does not publish, until everything
# uploaded reads back byte-for-byte over the public URL.
verify_remote

# ── npm ──────────────────────────────────────────────────────────────────────
# One ordinary JavaScript package: `bin/ml-dash.js` over `dist/`, running the
# same src/index.ts the binaries compile from. No per-platform subpackages —
# the eight compiled targets are the R2 channel's job, and duplicating them as
# npm packages would mean eight more immutable publishes to keep in sync for
# users who already have Node.
publish_npm() {
    echo ""
    echo "Publishing ml-dash@$VERSION to npm"
    local pkg_version
    pkg_version="$(python3 -c 'import json;print(json.load(open("'"$ROOT"'/package.json"))["version"])')"
    [ "$pkg_version" = "$VERSION" ] ||
        { echo "  ✗ package.json is $pkg_version but publishing $VERSION" >&2; exit 1; }

    if [ "$(npm view "ml-dash@$VERSION" version 2>/dev/null || true)" = "$VERSION" ]; then
        echo "  ✓ ml-dash@$VERSION is already on the registry — skipping"
        return 0
    fi

    # dist/ is what bin/ml-dash.js imports; publishing without it yields a
    # package that installs cleanly and fails on first run.
    (cd "$ROOT" && npm run build >/dev/null)
    [ -f "$ROOT/dist/index.js" ] || { echo "  ✗ dist/index.js missing after build" >&2; exit 1; }

    # Dry run first: the file list is the last chance to notice that `files`
    # in package.json is shipping too little or too much.
    (cd "$ROOT" && npm pack --dry-run)

    # One submission only. An error can follow an accepted upload, and npm
    # versions are immutable — retrying an uncertain publish cannot help, so
    # reconcile against the registry by hand instead.
    (cd "$ROOT" && npm publish --access public) ||
        { echo "  ✗ ml-dash@$VERSION outcome unresolved; check the registry before retrying. No retry here." >&2; exit 1; }

    published="$(npm view "ml-dash@$VERSION" version 2>/dev/null || true)"
    [ "$published" = "$VERSION" ] ||
        { echo "  ✗ registry does not report $VERSION after publish (got '${published:-<nothing>}')" >&2; exit 1; }
    echo "  ✓ ml-dash@$VERSION on the registry"
}

if [ "$PUBLISH_NPM" = "1" ]; then
    publish_npm
fi

# ── pointers, last ───────────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf '%s' "$VERSION" > "$TMP/pointer"

check_pointer() {  # check_pointer <channel>
    got="$(curl -fsSL "$PUBLIC/$PREFIX/$1?v=$(date +%s)" 2>/dev/null || true)"
    [ "$got" = "$VERSION" ] ||
        { echo "  ✗ $1 reads back as '${got:-<nothing>}', expected $VERSION" >&2; exit 1; }
    echo "  ✓ $1 = $VERSION"
}

echo ""
if [ "$MOVE_LATEST" = "1" ]; then
    echo "  → latest = $VERSION"
    put "$PREFIX/latest" "$TMP/pointer" "text/plain; charset=utf-8" "$POINTER"
    check_pointer latest
fi
if [ "$MOVE_STABLE" = "1" ]; then
    echo "  → stable = $VERSION"
    put "$PREFIX/stable" "$TMP/pointer" "text/plain; charset=utf-8" "$POINTER"
    check_pointer stable
fi

echo ""
echo "Published and verified. Try it with:"
echo "  curl -fsSL $PUBLIC/install.sh | sh"
