#!/usr/bin/env bash
#
# Publish an already-built release: artifacts to R2, the packed tarball to npm,
# and only then the channel pointers.
#
#   ./scripts/publish-release.sh 0.1.0                # R2 + npm, move `latest`
#   ./scripts/publish-release.sh 0.1.0 --stable       # also move `stable`
#   ./scripts/publish-release.sh 0.1.0 --no-npm
#   ./scripts/publish-release.sh 0.1.0 --no-pointer
#   ./scripts/publish-release.sh 0.1.0 --verify-only  # re-check, upload nothing
#
# This script produces nothing. No compile, no `npm run build`, no `npm pack`:
# it uploads the exact bytes in release/<version>/ after re-hashing each one
# against that release's manifest, and publishes the tarball packed at build
# time. An artifact rebuilt after review cannot ride out under the reviewed
# version, and a publish interrupted halfway can be re-run.
#
# Requires: wrangler auth (`npx wrangler login` or CLOUDFLARE_API_TOKEN with R2
# write) and `npm whoami` as a publisher of the package.
set -euo pipefail

BUCKET="${ML_DASH_R2_BUCKET:-dash-downloads}"
PREFIX="ml-dash-cli/releases"
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

# One temp directory for the whole run, removed on success, failure and
# interrupt alike — a failed verification must not leave hundreds of MB of
# downloaded binaries behind. Function-scoped RETURN traps were tried first and
# fight with this one; a single owner is the thing that reliably fires.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ml-dash-publish.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

mget() {  # mget <python-expression over the manifest dict `m`>
    python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$REL/manifest.json" "$1"
}
sha_of() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }
size_of() { wc -c < "$1" | tr -d ' '; }

# `while read` rather than `mapfile`: macOS ships bash 3.2.
manifest_rows() {  # platform binary checksum size
    python3 -c '
import json, sys
for platform, e in json.load(open(sys.argv[1]))["platforms"].items():
    print(platform, e["binary"], e["checksum"], e["size"])
' "$REL/manifest.json"
}

# The release states the host it was built for; publishing it somewhere else
# would ship installers whose baked-in base URL points at a different origin
# than the one serving them.
PUBLIC="$(mget 'm.get("publicUrl","")')"
if [ -n "${ML_DASH_PUBLIC_URL:-}" ] && [ "$ML_DASH_PUBLIC_URL" != "$PUBLIC" ]; then
    echo "Manifest was built for $PUBLIC but ML_DASH_PUBLIC_URL is $ML_DASH_PUBLIC_URL." >&2
    echo "Rebuild with --public-url=$ML_DASH_PUBLIC_URL rather than redirecting the upload." >&2
    exit 1
fi
[ -n "$PUBLIC" ] || { echo "Manifest has no publicUrl — rebuild with the current build script." >&2; exit 1; }

MANIFEST_VERSION="$(mget 'm["version"]')"
[ "$MANIFEST_VERSION" = "$VERSION" ] ||
    { echo "release/$VERSION/manifest.json says version $MANIFEST_VERSION" >&2; exit 1; }
PKG_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/package.json")"
[ "$PKG_VERSION" = "$VERSION" ] ||
    { echo "package.json is $PKG_VERSION but publishing $VERSION" >&2; exit 1; }
TARBALL="$(mget 'm["npm"]["tarball"]')"
# The tarball's own package.json is the version npm will register — a stale
# .tgz left in the release directory would otherwise publish a past build.
TGZ_VERSION="$(tar -xzOf "$REL/$TARBALL" package/package.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
[ "$TGZ_VERSION" = "$VERSION" ] ||
    { echo "$TARBALL contains version $TGZ_VERSION, not $VERSION" >&2; exit 1; }

# ── 1. local artifacts must be the ones the manifest describes ───────────────
check_local() {
    echo "Checking local artifacts in release/$VERSION"
    manifest_rows | while read -r platform binary checksum size; do
        src="$REL/$platform/$binary"
        [ -f "$src" ] || { echo "  ✗ manifest lists $platform/$binary but the file is missing" >&2; exit 1; }
        if [ "$(size_of "$src")" != "$size" ] || [ "$(sha_of "$src")" != "$checksum" ]; then
            echo "  ✗ $platform/$binary does not match the manifest — rebuild, do not publish" >&2
            exit 1
        fi
        echo "  ✓ $platform/$binary"
    done || exit 1
    for name in "$TARBALL" install.sh install.ps1; do
        key="m[\"npm\"]"; [ "$name" = "$TARBALL" ] || key="m[\"installers\"][\"$name\"]"
        want_sha="$(mget "$key[\"checksum\"]")"; want_size="$(mget "$key[\"size\"]")"
        if [ "$(size_of "$REL/$name")" != "$want_size" ] || [ "$(sha_of "$REL/$name")" != "$want_sha" ]; then
            echo "  ✗ $name does not match the manifest — rebuild, do not publish" >&2
            exit 1
        fi
        echo "  ✓ $name"
    done
}

# ── 2. read every published byte back over the public URL ────────────────────
# A successful wrangler exit is not evidence the bytes are fetchable: an object
# can be missing, truncated, or shadowed by an edge-cached 404 from an earlier
# failed attempt at the same version. `?v=` busts that cache; versioned objects
# are otherwise served as immutable.
remote_matches() {  # remote_matches <url> <sha> <size> — prints nothing, returns status
    local out="$TMP/probe.$$"
    curl -fsSL --retry 3 -o "$out" "$1?v=$(date +%s)" || { rm -f "$out"; return 1; }
    local got_sha got_size
    got_sha="$(sha_of "$out")"; got_size="$(size_of "$out")"
    rm -f "$out"
    [ "$got_sha" = "$2" ] && [ "$got_size" = "$3" ]
}

verify_remote() {
    echo "Verifying $VERSION via $PUBLIC/$PREFIX"
    if ! cmp -s <(curl -fsSL --retry 3 "$PUBLIC/$PREFIX/$VERSION/manifest.json?v=$(date +%s)") "$REL/manifest.json"; then
        echo "  ✗ remote manifest.json is unreachable or differs from the local one" >&2
        exit 1
    fi
    echo "  ✓ manifest.json"
    manifest_rows | while read -r platform binary checksum size; do
        remote_matches "$PUBLIC/$PREFIX/$VERSION/$platform/$binary" "$checksum" "$size" ||
            { echo "  ✗ $platform/$binary: missing or differs from the manifest" >&2; exit 1; }
        echo "  ✓ $platform/$binary"
    done || exit 1
    remote_matches "$PUBLIC/$PREFIX/$VERSION/$TARBALL" "$(mget 'm["npm"]["checksum"]')" "$(mget 'm["npm"]["size"]')" ||
        { echo "  ✗ $TARBALL: missing or differs from the manifest" >&2; exit 1; }
    echo "  ✓ $TARBALL"
    # Both copies of each installer, at the exact URLs README and docs tell
    # people to pipe into a shell. The root copy keeps the headline command
    # short; the prefixed copy leaves the root free for another tool later.
    for name in install.sh install.ps1; do
        want_sha="$(mget "m[\"installers\"][\"$name\"][\"checksum\"]")"
        want_size="$(mget "m[\"installers\"][\"$name\"][\"size\"]")"
        for url in "$PUBLIC/$name" "$PUBLIC/ml-dash-cli/$name"; do
            remote_matches "$url" "$want_sha" "$want_size" ||
                { echo "  ✗ $url: missing or differs from the built installer" >&2; exit 1; }
            echo "  ✓ $url"
        done
    done
}

if [ "$VERIFY_ONLY" = "1" ]; then
    check_local
    verify_remote
    echo ""
    echo "Release $VERSION verifies clean — nothing was uploaded or moved."
    exit 0
fi

check_local

# ── 3. an already-published version is immutable ─────────────────────────────
# Re-running after a half-finished publish must be safe; silently rewriting a
# version someone already installed must not be possible. The published
# manifest decides which case this is.
existing="$TMP/remote-manifest.json"
# Only a definite 404 means "not published yet". A connectivity error, a 403 or
# a 5xx tells us nothing about what is in the bucket, and treating those as
# absence is exactly how an immutable version gets silently rewritten — so they
# stop the run instead.
# curl exits non-zero and prints "000" when it never got a response; the
# `|| true` keeps `set -e` out of it, and anything that is not three digits is
# normalised to 000 rather than concatenated onto the status.
code="$(curl -s -o "$existing" -w '%{http_code}' "$PUBLIC/$PREFIX/$VERSION/manifest.json?v=$(date +%s)" || true)"
case "$code" in [0-9][0-9][0-9]) ;; *) code=000 ;; esac
case "$code" in
    404)
        : ;;   # first publish of this version
    200)
        if cmp -s "$existing" "$REL/manifest.json"; then
            echo "Version $VERSION is already published with these exact artifacts — resuming."
        else
            echo "Version $VERSION is already published with DIFFERENT artifacts." >&2
            echo "Versioned objects are immutable and installs pin them. Bump the version." >&2
            exit 1
        fi ;;
    000)
        echo "Cannot reach $PUBLIC to check whether $VERSION is already published." >&2
        echo "Refusing to upload: an unreachable host is not an empty one." >&2
        exit 1 ;;
    *)
        echo "Checking $PUBLIC/$PREFIX/$VERSION/manifest.json returned HTTP $code." >&2
        echo "Only 404 means 'not published'. Resolve this before uploading." >&2
        exit 1 ;;
esac

IMMUTABLE="public, max-age=31536000, immutable"   # versioned objects never change
POINTER="public, max-age=60, must-revalidate"     # pointers decide new installs

wr() { npx --yes wrangler "$@"; }
put() {  # put <key> <file> <content-type> <cache-control>
    wr r2 object put "$BUCKET/$1" --file="$2" --content-type="$3" --cache-control="$4" --remote
}

echo ""
echo "Publishing ml-dash $VERSION to r2://$BUCKET/$PREFIX"
manifest_rows | while read -r platform binary checksum size; do
    echo "  → $platform/$binary"
    put "$PREFIX/$VERSION/$platform/$binary" "$REL/$platform/$binary" "application/octet-stream" "$IMMUTABLE"
done || exit 1

echo "  → $TARBALL"
put "$PREFIX/$VERSION/$TARBALL" "$REL/$TARBALL" "application/gzip" "$IMMUTABLE"

echo "  → install.sh / install.ps1 (root + prefixed)"
for name in install.sh install.ps1; do
    put "$name" "$REL/$name" "text/plain; charset=utf-8" "public, max-age=300"
    put "ml-dash-cli/$name" "$REL/$name" "text/plain; charset=utf-8" "public, max-age=300"
done

echo "  → manifest.json"
put "$PREFIX/$VERSION/manifest.json" "$REL/manifest.json" "application/json" "$IMMUTABLE"

# The gate: npm does not publish and no pointer moves until every uploaded
# object — binaries, tarball, and both installer URLs — reads back correct.
verify_remote

# ── npm ──────────────────────────────────────────────────────────────────────
# One ordinary JavaScript package: bin/ml-dash.js over dist/, from the same
# src/index.ts the binaries compile from. No per-platform subpackages — the
# eight compiled targets are the R2 channel's job, and duplicating them on npm
# would mean eight more immutable publishes to keep in step.
publish_npm() {
    echo ""
    echo "Publishing ml-dash@$VERSION to npm"
    local local_integrity registry_integrity
    # The registry's dist.integrity is sha512-<base64> of the published tarball,
    # so compute it straight from the bytes on disk. Asking `npm pack` for it
    # would route the answer back through the packing code path this script
    # exists to stay out of.
    local_integrity="$(python3 -c '
import base64, hashlib, sys
print("sha512-" + base64.b64encode(hashlib.sha512(open(sys.argv[1], "rb").read()).digest()).decode())
' "$REL/$TARBALL")"
    registry_integrity="$(npm view "ml-dash@$VERSION" dist.integrity 2>/dev/null || true)"

    if [ -n "$registry_integrity" ]; then
        if [ "$registry_integrity" = "$local_integrity" ]; then
            echo "  ✓ ml-dash@$VERSION is on the registry with these exact bytes — skipping"
            return 0
        fi
        echo "  ✗ ml-dash@$VERSION is on the registry with DIFFERENT bytes" >&2
        echo "    registry: $registry_integrity" >&2
        echo "    local:    $local_integrity" >&2
        echo "    npm versions are immutable. Bump the version; do not republish." >&2
        exit 1
    fi

    # The tarball packed at build time, published as-is. `npm publish` on a
    # directory would re-pack whatever is on disk now — a different artifact
    # from the reviewed one.
    #
    # One submission only. An error can follow an accepted upload, and the
    # version is immutable, so a retry cannot help: reconcile by hand.
    npm publish --access public "$REL/$TARBALL" ||
        { echo "  ✗ ml-dash@$VERSION outcome unresolved; check the registry before retrying. No retry here." >&2; exit 1; }

    registry_integrity="$(npm view "ml-dash@$VERSION" dist.integrity 2>/dev/null || true)"
    [ "$registry_integrity" = "$local_integrity" ] ||
        { echo "  ✗ registry integrity after publish is '${registry_integrity:-<nothing>}', expected $local_integrity" >&2; exit 1; }
    echo "  ✓ ml-dash@$VERSION on the registry, integrity matches"
}

if [ "$PUBLISH_NPM" = "1" ]; then
    publish_npm
fi

# ── pointers, last ───────────────────────────────────────────────────────────
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
