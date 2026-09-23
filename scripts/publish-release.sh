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
#   ./scripts/publish-release.sh 0.1.0 --precheck-npm # decide npm feasibility, touch nothing
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
    echo "Usage: $0 <version> [--stable] [--no-pointer] [--no-npm] [--verify-only] [--precheck-npm]" >&2
    exit 1
fi
shift

MOVE_LATEST=1; MOVE_STABLE=0; VERIFY_ONLY=0; PUBLISH_NPM=1; PRECHECK_NPM=0
for arg in "$@"; do
    case "$arg" in
        --stable)       MOVE_STABLE=1 ;;
        --no-pointer)   MOVE_LATEST=0 ;;
        --no-npm)       PUBLISH_NPM=0 ;;
        --verify-only)  VERIFY_ONLY=1 ;;
        --precheck-npm) PRECHECK_NPM=1 ;;
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
# The npm name comes from package.json and from the manifest, never from a
# literal in here. `ml-dash` is not publishable as an unscoped name (see the
# similarity check below), so the name this ships under is expected to change
# to a scoped one — and a hard-coded string would then silently query and
# report the wrong package while publishing the right one.
PKG_NAME="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$ROOT/package.json")"
MANIFEST_NAME="$(mget 'm.get("name","")')"
[ "$MANIFEST_NAME" = "$PKG_NAME" ] ||
    { echo "manifest was built for package '$MANIFEST_NAME' but package.json says '$PKG_NAME'" >&2; exit 1; }
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

# ── npm feasibility, decided before a single byte reaches R2 ─────────────────
# The publish order is R2 first, npm second. That is right — a pointer must not
# move to binaries nobody can fetch — but it means an npm failure lands *after*
# the bucket has been written, which is the half-published state this whole
# script is shaped against. So everything about npm that can be known without
# publishing is settled here, first.
#
# Read over plain HTTP rather than through `npm view`, for the same reason the
# R2 immutability probe does: `npm view` exits non-zero for "no such package"
# and for "the registry is unreachable" alike, and treating the second as the
# first is how a first publish gets attempted with no credential and half a
# release already uploaded.
local_integrity() {  # sha512-<base64> of the packed tarball, as npm records it
    python3 -c '
import base64, hashlib, sys
print("sha512-" + base64.b64encode(hashlib.sha512(open(sys.argv[1], "rb").read()).digest()).decode())
' "$REL/$TARBALL"
}

npm_precheck() {
    local encoded body code exists published want
    # The integrity below is only meaningful if the tarball on disk is the one
    # the manifest describes. check_local proves that for every artifact, but
    # --precheck-npm deliberately runs without it (re-hashing ~700 MB of
    # binaries to answer a question about npm is the wrong trade), so the one
    # file this function reads is checked here.
    if [ "$(size_of "$REL/$TARBALL")" != "$(mget 'm["npm"]["size"]')" ] ||
       [ "$(sha_of "$REL/$TARBALL")" != "$(mget 'm["npm"]["checksum"]')" ]; then
        echo "  ✗ $TARBALL does not match the manifest — rebuild, do not publish" >&2
        exit 1
    fi

    # @scope/name must be percent-encoded for the registry document URL.
    encoded="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$PKG_NAME")"
    body="$TMP/registry.json"
    code="$(curl -s -o "$body" -w '%{http_code}' "https://registry.npmjs.org/$encoded" || true)"
    case "$code" in [0-9][0-9][0-9]) ;; *) code=000 ;; esac

    case "$code" in
        200) exists=1 ;;
        404) exists=0 ;;
        *)
            echo "  ✗ registry.npmjs.org returned HTTP $code for $PKG_NAME." >&2
            echo "    Only 404 means 'no such package'. Refusing to start a publish blind." >&2
            exit 1 ;;
    esac

    want="$(local_integrity)"

    if [ "$exists" = "1" ]; then
        published="$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
print(d.get("versions", {}).get(sys.argv[2], {}).get("dist", {}).get("integrity", ""))
' "$body" "$VERSION")"
        if [ -n "$published" ]; then
            if [ "$published" = "$want" ]; then
                echo "  ✓ $PKG_NAME@$VERSION is already on the registry with these exact bytes"
                echo "    (the npm step will verify and skip; a re-run is safe)"
                return 0
            fi
            echo "  ✗ $PKG_NAME@$VERSION is on the registry with DIFFERENT bytes" >&2
            echo "    npm versions are immutable. Bump the version; do not republish." >&2
            exit 1
        fi
        # Package exists, this version does not.
        if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
            echo "  ✓ $PKG_NAME exists, $VERSION is new, NPM_TOKEN is present"
            return 0
        fi
        # Without a token the only remaining path is trusted publishing, and
        # whether a trusted publisher is configured is not readable from any
        # endpoint this script can reach — the registry exposes no such field.
        # Guessing wrong costs a fully uploaded R2 release plus a failed npm
        # publish, so the default is to stop. ML_DASH_NPM_TRUSTED=1 is how a
        # human who has looked at the package's settings page says so.
        if [ -n "${ML_DASH_NPM_TRUSTED:-}" ]; then
            echo "  ✓ $PKG_NAME exists, $VERSION is new, proceeding on ML_DASH_NPM_TRUSTED"
            echo "    (trusted publishing is asserted, not verified — nothing can verify it from here)"
            return 0
        fi
        echo "  ✗ $PKG_NAME@$VERSION would be a new version published with no NPM_TOKEN." >&2
        echo "    That can only work if a trusted publisher is configured for this" >&2
        echo "    workflow, and no registry endpoint reports whether it is. Either set" >&2
        echo "    NPM_TOKEN, or confirm the trusted publisher on npmjs.com and re-run" >&2
        echo "    with ML_DASH_NPM_TRUSTED=1." >&2
        exit 1
    fi

    # ── package does not exist: a first publish ──────────────────────────────
    # Trusted publishing cannot be configured for a name that has never been
    # published — the settings page it is configured on does not exist yet
    # (npm/cli#8544). So a token is required here with no override.
    if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
        echo "  ✗ $PKG_NAME has never been published, so this is a first publish." >&2
        echo "    Trusted publishing cannot be configured for a package that does not" >&2
        echo "    exist yet, so NPM_TOKEN is required and no override applies." >&2
        exit 1
    fi

    # npm refuses an unscoped new name that differs from an existing one only
    # by punctuation ("Package name too similar to existing package X"). It is
    # a server-side heuristic with no API, so this cannot be a complete check —
    # but the common case is exact: strip `-`, `_` and `.` and see whether that
    # package is taken. Catching it here costs nothing; missing it costs a
    # fully uploaded R2 release followed by an E403 from npm.
    case "$PKG_NAME" in
        @*) ;;   # scoped names are exempt from the similarity rule entirely
        *)
            local collapsed collapsed_code
            collapsed="$(printf '%s' "$PKG_NAME" | tr -d '._-')"
            if [ "$collapsed" != "$PKG_NAME" ]; then
                collapsed_code="$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$collapsed" || true)"
                if [ "$collapsed_code" = "200" ]; then
                    echo "  ✗ npm will refuse the new unscoped name '$PKG_NAME': '$collapsed' is" >&2
                    echo "    already published, and npm rejects a new name that differs from an" >&2
                    echo "    existing one only by punctuation (E403, 'too similar')." >&2
                    echo "    Publish under a scope instead — scoped names are exempt." >&2
                    exit 1
                fi
            fi
            echo "  ! $PKG_NAME is unscoped and unpublished. npm's similarity check runs" 
            echo "    server-side and cannot be fully predicted from here; the obvious"
            echo "    collision was checked and is clear." ;;
    esac

    echo "  ✓ first publish of $PKG_NAME@$VERSION, NPM_TOKEN is present"
}

if [ "$PRECHECK_NPM" = "1" ]; then
    echo "Checking whether $PKG_NAME@$VERSION can be published to npm"
    npm_precheck
    echo ""
    echo "npm precheck passed — nothing was uploaded, published or moved."
    exit 0
fi

if [ "$VERIFY_ONLY" = "1" ]; then
    check_local
    verify_remote
    echo ""
    echo "Release $VERSION verifies clean — nothing was uploaded or moved."
    exit 0
fi

check_local

# Before R2, not after: an npm problem discovered after the bucket is written
# is a half-published release. Skipped only when npm is explicitly out of scope
# for this run.
if [ "$PUBLISH_NPM" = "1" ]; then
    echo ""
    echo "Checking whether $PKG_NAME@$VERSION can be published to npm"
    npm_precheck
fi

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

# Pinnable so CI cannot have a publish change behaviour because wrangler
# shipped a release; unpinned by default, which is what a local run has always
# used. CI sets ML_DASH_WRANGLER to an exact version.
WRANGLER="${ML_DASH_WRANGLER:-wrangler}"
wr() { npx --yes "$WRANGLER" "$@"; }
put() {  # put <key> <file> <content-type> <cache-control>
    wr r2 object put "$BUCKET/$1" --file="$2" --content-type="$3" --cache-control="$4" --remote
}

echo ""
echo "Publishing $PKG_NAME $VERSION to r2://$BUCKET/$PREFIX"
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
    echo "Publishing $PKG_NAME@$VERSION to npm"
    local want registry_integrity
    # The registry's dist.integrity is sha512-<base64> of the published tarball,
    # computed straight from the bytes on disk by local_integrity(). Asking
    # `npm pack` for it would route the answer back through the packing code
    # path this script exists to stay out of. One implementation, shared with
    # the precheck, so the two cannot come to different conclusions.
    want="$(local_integrity)"
    registry_integrity="$(npm view "$PKG_NAME@$VERSION" dist.integrity 2>/dev/null || true)"

    if [ -n "$registry_integrity" ]; then
        if [ "$registry_integrity" = "$want" ]; then
            echo "  ✓ $PKG_NAME@$VERSION is on the registry with these exact bytes — skipping"
            return 0
        fi
        echo "  ✗ $PKG_NAME@$VERSION is on the registry with DIFFERENT bytes" >&2
        echo "    registry: $registry_integrity" >&2
        echo "    local:    $want" >&2
        echo "    npm versions are immutable. Bump the version; do not republish." >&2
        exit 1
    fi

    # The tarball packed at build time, published as-is. `npm publish` on a
    # directory would re-pack whatever is on disk now — a different artifact
    # from the reviewed one.
    #
    # One submission only. An error can follow an accepted upload, and the
    # version is immutable, so a retry cannot help: reconcile by hand.
    # --provenance only when a token is what authenticated us: trusted
    # publishing attaches provenance on its own, and passing the flag without
    # an OIDC-capable context is an error rather than a downgrade. CI sets
    # ML_DASH_NPM_PROVENANCE=1 exactly when it supplied NODE_AUTH_TOKEN; a
    # local run leaves it unset and publishes without an attestation, which is
    # the honest outcome for a laptop that cannot produce one.
    local provenance=()
    if [ -n "${ML_DASH_NPM_PROVENANCE:-}" ]; then provenance=(--provenance); fi

    npm publish --access public "${provenance[@]+"${provenance[@]}"}" "$REL/$TARBALL" ||
        { echo "  ✗ $PKG_NAME@$VERSION outcome unresolved; check the registry before retrying. No retry here." >&2; exit 1; }

    registry_integrity="$(npm view "$PKG_NAME@$VERSION" dist.integrity 2>/dev/null || true)"
    [ "$registry_integrity" = "$want" ] ||
        { echo "  ✗ registry integrity after publish is '${registry_integrity:-<nothing>}', expected $want" >&2; exit 1; }
    echo "  ✓ $PKG_NAME@$VERSION on the registry, integrity matches"
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
