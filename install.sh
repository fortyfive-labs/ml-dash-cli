#!/bin/sh
# ml-dash installer for macOS and Linux.
#
#   curl -fsSL https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev/install.sh | sh
#   curl -fsSL https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev/install.sh | sh -s -- --version 0.1.0
#
# Options (flags or environment):
#   --version <v>       ML_DASH_VERSION       exact version, default: channel pointer
#   --channel <name>    ML_DASH_CHANNEL       latest (default) or stable
#   --install-dir <d>   ML_DASH_INSTALL_DIR   default: ~/.local/bin
#   --base-url <url>    ML_DASH_BASE_URL      default: the host this installer
#                                             was published on
#   --force                                   take over an install dir entry
#                                             this installer does not own
#
# Installs one self-contained binary: no Node, npm, Python or compiler is
# needed here or afterwards. Every download is checked against the sha256 in
# the release manifest before anything is written to the install directory,
# and a pinned --version installs the identical bytes on every machine.
set -eu

# Rewritten by scripts/build-release.ts to the host the release is served from,
# so an installer never fetches binaries from a different origin than the one
# it came from.
BASE_URL="${ML_DASH_BASE_URL:-https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev}"
PREFIX="ml-dash-cli/releases"
CHANNEL="${ML_DASH_CHANNEL:-latest}"
VERSION="${ML_DASH_VERSION:-}"
INSTALL_DIR="${ML_DASH_INSTALL_DIR:-$HOME/.local/bin}"
FORCE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --version)     VERSION="${2:?--version needs a value}"; shift 2 ;;
        --channel)     CHANNEL="${2:?--channel needs a value}"; shift 2 ;;
        --install-dir) INSTALL_DIR="${2:?--install-dir needs a value}"; shift 2 ;;
        --base-url)    BASE_URL="${2:?--base-url needs a value}"; shift 2 ;;
        --force)       FORCE=1; shift ;;
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
# STAGE is created later inside the install directory; naming it now means one
# cleanup handles both, so a failure or Ctrl-C between copy and rename cannot
# leave a stray .ml-dash.*.tmp sitting next to the real binary.
STAGE=""
cleanup() { rm -rf "$TMP"; [ -n "$STAGE" ] && rm -f "$STAGE"; return 0; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo "ml-dash $VERSION ($PLATFORM)"

REL="$BASE_URL/$PREFIX/$VERSION"
fetch "$REL/manifest.json" "$TMP/manifest.json" ||
    die "no manifest at $REL/manifest.json — is $VERSION a published version?"

# The manifest is small and pretty-printed by scripts/build-release.ts; awk
# keeps this dependency-free (no jq, no python) while still reading the real
# file name — Windows builds are ml-dash.exe and a hardcoded name would ship
# the wrong object.
read_field() {  # read_field <field>
    # `tr` puts every JSON token on its own line first, so the same awk reads a
    # pretty-printed manifest and a minified one alike — no jq, no python on
    # the installing machine. The binary name is read rather than assumed:
    # Windows builds are ml-dash.exe and a hardcoded name ships nothing.
    tr '{,' '\n\n' < "$TMP/manifest.json" | awk -v p="\"$PLATFORM\"" -v f="\"$1\"" '
        $1 == p ":" || $1 == p { inside = 1; next }
        inside && $1 == f ":" { v = $2; gsub(/[",]/, "", v); print v; exit }
        inside && /}/ { inside = 0 }
    '
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

# The verified bytes are not yet a working install: Bun's musl builds link
# against libstdc++.so.6 and libgcc_s.so.1, which a bare Alpine image does not
# ship, and a glibc image can be too old. Exec the staged binary now so that
# failure is reported here — installing first and letting `ml-dash` die on the
# user's next command is the exact "fails at first run, not at install time"
# outcome the platform probe above exists to prevent.
if ! smoke="$("$TMP/$BINARY" version 2>&1)"; then
    echo "ml-dash install: the downloaded binary does not run on this system:" >&2
    echo "$smoke" | sed 's/^/    /' >&2
    case "$PLATFORM" in
        *-musl)
            echo "" >&2
            echo "  This build needs libstdc++ and libgcc, which Alpine does not" >&2
            echo "  install by default:" >&2
            echo "      apk add --no-cache libstdc++" >&2
            ;;
    esac
    die "nothing was installed"
fi

# ── install ──────────────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR" || die "cannot create $INSTALL_DIR"
TARGET="$INSTALL_DIR/ml-dash"
# Written next to the binary after a successful install, and the only claim of
# ownership this installer trusts: it records the sha256 it put there, so an
# entry that has since been replaced by another tool no longer matches.
RECEIPT="$INSTALL_DIR/.ml-dash.receipt"

# An ml-dash from another channel (npm, pipx, a package manager) is reported
# and left exactly as it is — removing files this installer did not create
# would break whatever manages them.
existing="$(command -v ml-dash 2>/dev/null || true)"
if [ -n "$existing" ] && [ "$existing" != "$TARGET" ]; then
    case "$existing" in
        *node_modules*|*/npm/*)  other="an npm install" ;;
        *site-packages*|*pipx*)  other="a pip/pipx install" ;;
        *)                       other="another install" ;;
    esac
    echo ""
    echo "  note: $other of ml-dash is already on your PATH at:"
    echo "          $existing"
    echo "        It has not been changed. Whichever comes first in PATH wins;"
    echo "        remove it with its own tool if you want this one to take over."
fi

# The install path itself may be occupied by something this installer did not
# put there — ~/.local/bin is shared with pipx, npm prefixes and hand-written
# scripts. Matching paths proves nothing about who owns the file, so the check
# is against the receipt: same path AND the bytes still being the ones recorded
# there. Anything else (no receipt, a changed file, a symlink into another
# tool's store) is refused rather than overwritten.
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    owned=0
    if [ -L "$TARGET" ]; then
        conflict="$TARGET is a symlink to $(readlink "$TARGET" 2>/dev/null || echo '?')"
    elif [ ! -f "$RECEIPT" ]; then
        conflict="$TARGET already exists and has no install receipt"
    else
        recorded="$(sed -n 's/^sha256=//p' "$RECEIPT" | head -1)"
        if [ -n "$recorded" ] && [ "$recorded" = "$(sha256 "$TARGET")" ]; then
            owned=1
        else
            conflict="$TARGET has been modified or replaced since this installer wrote it"
        fi
    fi
    if [ "$owned" != "1" ] && [ "$FORCE" != "1" ]; then
        echo "" >&2
        echo "  refusing to overwrite: $conflict" >&2
        echo "  It was not installed by this installer, so removing it could break" >&2
        echo "  whatever owns it. Options:" >&2
        echo "    - install elsewhere:  --install-dir <dir>" >&2
        echo "    - remove it with the tool that installed it, then re-run" >&2
        echo "    - take it over anyway: --force" >&2
        exit 1
    fi
fi

# Staged inside the install directory so the final step is a rename within one
# filesystem: $TARGET is either the old binary or the complete new one, never a
# half-written file.
STAGE="$INSTALL_DIR/.ml-dash.$$.tmp"
rm -f "$STAGE"
cp "$TMP/$BINARY" "$STAGE" || die "cannot write to $INSTALL_DIR"
chmod 755 "$STAGE"
mv -f "$STAGE" "$TARGET" || die "cannot install to $TARGET"
STAGE=""   # renamed, not ours to delete any more

printf 'channel=r2\nversion=%s\nplatform=%s\nsha256=%s\nsource=%s\n' \
    "$VERSION" "$PLATFORM" "$GOT_SHA" "$REL/$PLATFORM/$BINARY" > "$RECEIPT" ||
    echo "  warning: could not write $RECEIPT; the next run will not recognise this install" >&2

echo ""
echo "  installed $TARGET"
case ":$PATH:" in
    *":$INSTALL_DIR:"*) "$TARGET" version >/dev/null 2>&1 && echo "  run: ml-dash --help" ;;
    *) echo "  $INSTALL_DIR is not in PATH — add it:"
       echo "      export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
