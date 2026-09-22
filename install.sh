#!/bin/sh
# ml-dash installer for macOS and Linux.
#
#   curl -fsSL https://dl.dash.ml/install.sh | sh
#   curl -fsSL https://dl.dash.ml/install.sh | sh -s -- --version 0.1.0
#
# Options (flags or environment):
#   --version <v>       ML_DASH_VERSION       exact version, default: channel pointer
#   --channel <name>    ML_DASH_CHANNEL       latest (default) or stable
#   --install-dir <d>   ML_DASH_INSTALL_DIR   default: ~/.local/bin
#   --base-url <url>    ML_DASH_BASE_URL      default: https://dl.dash.ml
#
# Installs one self-contained binary: no Node, npm, Python or compiler is
# needed here or afterwards. Every download is checked against the sha256 in
# the release manifest before anything is written to the install directory,
# and a pinned --version installs the identical bytes on every machine.
set -eu

BASE_URL="${ML_DASH_BASE_URL:-https://dl.dash.ml}"
PREFIX="ml-dash-cli/releases"
CHANNEL="${ML_DASH_CHANNEL:-latest}"
VERSION="${ML_DASH_VERSION:-}"
INSTALL_DIR="${ML_DASH_INSTALL_DIR:-$HOME/.local/bin}"

while [ $# -gt 0 ]; do
    case "$1" in
        --version)     VERSION="${2:?--version needs a value}"; shift 2 ;;
        --channel)     CHANNEL="${2:?--channel needs a value}"; shift 2 ;;
        --install-dir) INSTALL_DIR="${2:?--install-dir needs a value}"; shift 2 ;;
        --base-url)    BASE_URL="${2:?--base-url needs a value}"; shift 2 ;;
        -h|--help)     sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done
BASE_URL="${BASE_URL%/}"

die() { echo "ml-dash install: $*" >&2; exit 1; }

# ── tools ────────────────────────────────────────────────────────────────────
if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
    fetch_stdout() { curl -fsSL --retry 3 "$1"; }
elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -qO "$2" "$1"; }
    fetch_stdout() { wget -qO- "$1"; }
else
    die "needs curl or wget"
fi

# No checksum tool means no way to tell a good download from a corrupted or
# substituted one, so the install stops rather than trusting the bytes.
if command -v sha256sum >/dev/null 2>&1; then
    sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
    sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v openssl >/dev/null 2>&1; then
    sha256() { openssl dgst -sha256 "$1" | sed 's/.*= *//'; }
else
    die "needs sha256sum, shasum or openssl to verify the download"
fi

# ── platform ─────────────────────────────────────────────────────────────────
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
    Darwin) os=darwin ;;
    Linux)  os=linux ;;
    *) die "unsupported OS '$os' — see $BASE_URL/$PREFIX for available builds" ;;
esac
case "$arch" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) die "unsupported architecture '$arch'" ;;
esac
PLATFORM="$os-$arch"
# glibc binaries do not start on musl systems (Alpine), so probe rather than
# assume: a wrong pick here fails at first run, not at install time.
if [ "$os" = linux ]; then
    if (ldd --version 2>&1 | grep -qi musl) || ls /lib/ld-musl-* >/dev/null 2>&1; then
        PLATFORM="$PLATFORM-musl"
    fi
fi

# ── version ──────────────────────────────────────────────────────────────────
if [ -z "$VERSION" ]; then
    VERSION="$(fetch_stdout "$BASE_URL/$PREFIX/$CHANNEL" | tr -d ' \t\r\n')" ||
        die "cannot read channel '$CHANNEL' from $BASE_URL/$PREFIX/$CHANNEL"
    [ -n "$VERSION" ] || die "channel '$CHANNEL' is empty"
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ml-dash-install.XXXXXX")" || die "cannot create a temp directory"
# Every exit path removes the download, including a failed or interrupted one.
trap 'rm -rf "$TMP"' EXIT
trap 'rm -rf "$TMP"; exit 130' INT
trap 'rm -rf "$TMP"; exit 143' TERM

echo "ml-dash $VERSION ($PLATFORM)"

REL="$BASE_URL/$PREFIX/$VERSION"
fetch "$REL/manifest.json" "$TMP/manifest.json" ||
    die "no manifest at $REL/manifest.json — is $VERSION a published version?"

# The manifest is small and pretty-printed by scripts/build-release.ts; awk
# keeps this dependency-free (no jq, no python) while still reading the real
# file name — Windows builds are ml-dash.exe and a hardcoded name would ship
# the wrong object.
read_field() {  # read_field <field>
    awk -v p="\"$PLATFORM\"" -v f="\"$1\"" '
        $1 == p ":" || $1 == p { inside = 1 }
        inside && $1 == f ":" { v = $2; gsub(/[",]/, "", v); print v; exit }
        inside && /^[ \t]*}/ { inside = 0 }
    ' "$TMP/manifest.json"
}
BINARY="$(read_field binary)"
WANT_SHA="$(read_field checksum)"
WANT_SIZE="$(read_field size)"
[ -n "$BINARY" ] && [ -n "$WANT_SHA" ] ||
    die "release $VERSION has no build for $PLATFORM"

echo "  downloading $REL/$PLATFORM/$BINARY"
fetch "$REL/$PLATFORM/$BINARY" "$TMP/$BINARY" || die "download failed"

GOT_SIZE="$(wc -c < "$TMP/$BINARY" | tr -d ' ')"
GOT_SHA="$(sha256 "$TMP/$BINARY")"
if [ -n "$WANT_SIZE" ] && [ "$GOT_SIZE" != "$WANT_SIZE" ]; then
    die "size mismatch: got $GOT_SIZE bytes, manifest says $WANT_SIZE"
fi
if [ "$GOT_SHA" != "$WANT_SHA" ]; then
    die "checksum mismatch: got $GOT_SHA, manifest says $WANT_SHA"
fi
echo "  sha256 ok"
chmod +x "$TMP/$BINARY"

# ── install ──────────────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR" || die "cannot create $INSTALL_DIR"
TARGET="$INSTALL_DIR/ml-dash"

# Another channel's ml-dash (npm, pipx, a package manager) is left exactly as
# it is: removing files this installer did not create would break whatever
# manages them. Reinstalling over an earlier run of this installer is fine —
# that is the same channel and the same path.
existing="$(command -v ml-dash 2>/dev/null || true)"
if [ -n "$existing" ] && [ "$existing" != "$TARGET" ]; then
    case "$existing" in
        *node_modules*|*/npm/*)     other="an npm install" ;;
        *site-packages*|*pipx*)     other="a pip/pipx install" ;;
        *)                          other="another install" ;;
    esac
    echo ""
    echo "  note: $other of ml-dash is already on your PATH at:"
    echo "          $existing"
    echo "        It has not been changed. Whichever comes first in PATH wins;"
    echo "        remove it with its own tool if you want this one to take over."
fi

# Staged in the install directory itself so the final step is a rename within
# one filesystem: either the old binary or the complete new one is at TARGET,
# never a half-written file, and never a running binary truncated mid-write.
STAGE="$INSTALL_DIR/.ml-dash.$$.tmp"
rm -f "$STAGE"
cp "$TMP/$BINARY" "$STAGE" || die "cannot write to $INSTALL_DIR"
chmod 755 "$STAGE"
mv -f "$STAGE" "$TARGET" || { rm -f "$STAGE"; die "cannot install to $TARGET"; }

echo ""
echo "  installed $TARGET"
case ":$PATH:" in
    *":$INSTALL_DIR:"*) "$TARGET" version >/dev/null 2>&1 && echo "  run: ml-dash --help" ;;
    *) echo "  $INSTALL_DIR is not in PATH — add it:"
       echo "      export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
