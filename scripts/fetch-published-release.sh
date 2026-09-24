#!/usr/bin/env bash
#
# Reconstruct release/<version>/ from a release that is already published,
# by downloading it back from the public URL and re-hashing every byte
# against that release's own manifest.
#
#   ./scripts/fetch-published-release.sh 0.1.1
#
# This exists for one situation: npm versions and R2 objects are immutable, so
# a release whose GitHub Release step failed cannot always be finished by
# rebuilding. `npm pack` includes README.md, so any commit that edits the
# README produces a different tarball and the rebuild is correctly refused as
# "already on the registry with DIFFERENT bytes" — which is what happened to
# 0.1.1 (run 35846188686). The published bytes are the only ones that can be
# attached to that Release, so they are fetched rather than remade.
#
# It writes nothing outside release/<version>/, uploads nothing, publishes
# nothing, moves no pointer and needs no credential. The manifest it trusts is
# the published one; every other file must match it exactly or this exits
# non-zero having produced an incomplete directory rather than a wrong one.
set -euo pipefail

PREFIX="ml-dash-cli/releases"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Same origin build-release.ts compiles into the installers. Not trusted
# blindly: the manifest names the host it was built for, and the two are
# compared below, so a stale default here fails loudly instead of quietly
# fetching from somewhere else.
BASE_URL="${ML_DASH_BASE_URL:-https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev}"
BASE_URL="${BASE_URL%/}"

VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "Usage: $0 <version>" >&2; exit 1; }
# release/<version>/ is a path, so the version has to be a plain component.
# Leading digit rather than a full semver: this only has to exclude `..` and
# anything with a separator in it, and the workflow already checks semver.
printf '%s' "$VERSION" | grep -Eq '^[0-9][0-9A-Za-z.+-]*$' ||
    { echo "'$VERSION' is not a plain version string." >&2; exit 1; }

REL="$ROOT/release/$VERSION"

sha_of()  { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }
size_of() { wc -c < "$1" | tr -d ' '; }
# Reads $MANIFEST, which is the temp copy until it has been checked and the
# release directory afterwards — same bytes either way.
mget()    { python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$MANIFEST" "$1"; }

# `?v=` busts any edge-cached 404 from before the object existed, the same way
# publish-release.sh's read-back does.
fetch() {  # fetch <url> <dest>
    curl -fsSL --retry 3 -o "$2" "$1?v=$(date +%s)"
}

# Downloads <url> to <dest> and keeps it only if it is exactly the file the
# manifest describes. Size is checked as well as sha256 because a truncated
# body and a wrong body are different failures worth telling apart.
fetch_verified() {  # fetch_verified <url> <dest> <sha256> <size>
    mkdir -p "$(dirname "$2")"
    fetch "$1" "$2" || { echo "  ✗ $1: cannot fetch" >&2; return 1; }
    local got_sha got_size
    got_sha="$(sha_of "$2")"; got_size="$(size_of "$2")"
    if [ "$got_sha" != "$3" ] || [ "$got_size" != "$4" ]; then
        echo "  ✗ $1" >&2
        echo "      sha256 $got_sha (manifest says $3)" >&2
        echo "      size   $got_size (manifest says $4)" >&2
        rm -f "$2"
        return 1
    fi
    echo "  ✓ $(basename "$2")"
}

echo "Fetching $VERSION from $BASE_URL/$PREFIX"

# The manifest lands in a temp file first, so a version that was never
# published leaves no empty release/<version>/ behind to be mistaken for one.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ml-dash-fetch.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fetch "$BASE_URL/$PREFIX/$VERSION/manifest.json" "$TMP/manifest.json" ||
    { echo "No published manifest for $VERSION — nothing to recover." >&2; exit 1; }
MANIFEST="$TMP/manifest.json"

# The manifest is the only file with nothing to check it against, so what can
# be checked about it is checked here: that it describes this version, that it
# was built for the host it was just fetched from, and that it names a real
# commit. Completeness — eight platforms, a tarball, both installers — is the
# workflow's existing manifest check, which runs against this file unchanged.
MANIFEST_VERSION="$(mget 'm["version"]')"
[ "$MANIFEST_VERSION" = "$VERSION" ] ||
    { echo "Published manifest says version $MANIFEST_VERSION, not $VERSION." >&2; exit 1; }
MANIFEST_PUBLIC="$(mget 'm.get("publicUrl","")')"
[ "$MANIFEST_PUBLIC" = "$BASE_URL" ] ||
    { echo "Manifest was built for $MANIFEST_PUBLIC but this fetched from $BASE_URL." >&2; exit 1; }
SRC_COMMIT="$(mget 'm["commit"]')"
printf '%s' "$SRC_COMMIT" | grep -Eq '^[0-9a-f]{40}$' ||
    { echo "Manifest commit '$SRC_COMMIT' is not a plain commit sha." >&2; exit 1; }
echo "  ✓ manifest.json — $VERSION, built from $SRC_COMMIT"

# Every output path below this line is built from strings in a manifest that
# was just fetched over the network — the platform keys, the binary names and
# the tarball name. `fetch_verified` does `mkdir -p` on the dirname it is
# given, so a manifest naming a platform `../..` or a binary
# `../../../../etc/cron.d/x` would write outside release/<version>/ before any
# checksum could object. The workflow's completeness check catches a wrong
# *set* of platforms, but it runs after the download, which is too late to
# matter here.
#
# So the names are pinned before the first write, to exactly what this project
# produces: the eight platform keys, the binary each implies, and the tarball
# name npm derives from the package name and version (`npm pack` strips the
# `@` and turns the `/` into `-`). Checksums and sizes are still verified
# afterwards exactly as before — this only decides *where* bytes may be
# written, not whether they are the right bytes. The installer names are
# literals in the loop below and are not manifest-controlled.
validate_manifest_names() {
    python3 - "$MANIFEST" "$VERSION" <<'PY'
import json, re, sys

manifest, version = json.load(open(sys.argv[1])), sys.argv[2]
WANT = {"darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64",
        "linux-x64-musl", "linux-arm64-musl", "windows-x64", "windows-arm64"}
bad = []

# Belt and braces. Exact-matching the whitelists below already excludes every
# one of these, but this is the property that actually matters, and it keeps
# holding if someone widens a whitelist later.
def unsafe(value):
    return ("/" in value or "\\" in value or value.startswith(".")
            or value in ("", ".", ".."))

platforms = manifest.get("platforms", {})
if set(platforms) != WANT:
    bad.append("platform keys are %s, not the eight this project builds"
               % sorted(platforms))
for platform, entry in sorted(platforms.items()):
    binary = entry.get("binary", "")
    expected = "ml-dash.exe" if platform.startswith("windows-") else "ml-dash"
    if binary != expected:
        bad.append("%s: binary is %r, expected %r" % (platform, binary, expected))
    if unsafe(platform) or unsafe(binary):
        bad.append("%s/%s: not a plain path component" % (platform, binary))

tarball = manifest.get("npm", {}).get("tarball", "")
expected = re.sub(r"^@", "", manifest.get("name", "")).replace("/", "-") + "-" + version + ".tgz"
if tarball != expected:
    bad.append("npm.tarball is %r, expected %r" % (tarball, expected))
if unsafe(tarball):
    bad.append("npm.tarball %r is not a plain filename" % tarball)

if bad:
    print("Published manifest names artifacts this script will not write:", file=sys.stderr)
    for line in bad:
        print("  - " + line, file=sys.stderr)
    sys.exit(1)
PY
}
validate_manifest_names || exit 1
echo "  ✓ 8 platform keys, binary names and tarball name are the expected ones"

# Nothing is written until the manifest has passed every check above, so a
# rejected manifest leaves no half-made release/<version>/ behind.
mkdir -p "$REL"
cp "$MANIFEST" "$REL/manifest.json"
MANIFEST="$REL/manifest.json"

python3 -c '
import json, sys
for platform, e in json.load(open(sys.argv[1]))["platforms"].items():
    print(platform, e["binary"], e["checksum"], e["size"])
' "$MANIFEST" | while read -r platform binary checksum size; do
    fetch_verified "$BASE_URL/$PREFIX/$VERSION/$platform/$binary" \
                   "$REL/$platform/$binary" "$checksum" "$size"
done || exit 1

TARBALL="$(mget 'm["npm"]["tarball"]')"
fetch_verified "$BASE_URL/$PREFIX/$VERSION/$TARBALL" "$REL/$TARBALL" \
               "$(mget 'm["npm"]["checksum"]')" "$(mget 'm["npm"]["size"]')" || exit 1

# Both published copies of each installer, at the exact URLs README and the
# docs tell people to pipe into a shell — the short one and the prefixed one.
# Checking both is what the full publish does, and it is what would catch a
# later release having overwritten one of them with different bytes.
for name in install.sh install.ps1; do
    want_sha="$(mget "m[\"installers\"][\"$name\"][\"checksum\"]")"
    want_size="$(mget "m[\"installers\"][\"$name\"][\"size\"]")"
    fetch_verified "$BASE_URL/$name"              "$REL/$name"          "$want_sha" "$want_size" || exit 1
    fetch_verified "$BASE_URL/ml-dash-cli/$name"  "$REL/.$name.prefixed" "$want_sha" "$want_size" || exit 1
    rm -f "$REL/.$name.prefixed"
done

# The tarball on R2 and the tarball on npm have to be the same artifact, or the
# Release would attach one while `npm install` served the other.
PKG_NAME="$(mget 'm["name"]')"
want_integrity="$(python3 -c '
import base64, hashlib, sys
print("sha512-" + base64.b64encode(hashlib.sha512(open(sys.argv[1], "rb").read()).digest()).decode())
' "$REL/$TARBALL")"
registry_integrity="$(npm view "$PKG_NAME@$VERSION" dist.integrity 2>/dev/null || true)"
[ -n "$registry_integrity" ] ||
    { echo "  ✗ $PKG_NAME@$VERSION is not on the registry — this is not a published release." >&2; exit 1; }
[ "$registry_integrity" = "$want_integrity" ] ||
    { echo "  ✗ npm has $PKG_NAME@$VERSION with different bytes than R2 serves" >&2
      echo "      registry: $registry_integrity" >&2
      echo "      R2:       $want_integrity" >&2; exit 1; }
echo "  ✓ npm $PKG_NAME@$VERSION integrity matches the tarball on R2"

echo ""
echo "release/$VERSION is the published release, verified byte-for-byte."
echo "Nothing was uploaded and no pointer was moved."
