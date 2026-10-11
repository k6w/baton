#!/bin/sh
# Install Baton: curl -fsSL https://raw.githubusercontent.com/k6w/baton/main/install.sh | sh
#
#   BATON_VERSION=0.2.0   install that version (default: latest release)
#   BATON_INSTALL_DIR=…   where the binary goes (default: ~/.local/bin)
#   BATON_REPO=owner/name GitHub repository to download from
#   BATON_DOWNLOAD_BASE=… mirror holding v<version>/<archive> and v<version>/SHA256SUMS
#
# Downloads the release archive for this OS/CPU from GitHub, verifies its SHA-256 against the
# release's SHA256SUMS, and puts `baton` on your PATH. Nothing else is touched.
set -eu

REPO="${BATON_REPO:-k6w/baton}"
DIR="${BATON_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${BATON_VERSION:-}"

say() { printf '%s\n' "$*"; }
die() { printf 'baton install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

fetch() { # url → stdout
  if have curl; then curl -fsSL --retry 3 "$1"
  elif have wget; then wget -qO- "$1"
  else die "needs curl or wget"; fi
}

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) die "on Windows, run this in PowerShell instead:  irm https://k6w.github.io/baton/install.ps1 | iex" ;;
  *) die "unsupported OS: $os" ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "unsupported CPU: $arch" ;;
esac
# Apple Silicon running this shell under Rosetta: get the native build
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
target="$os-$arch"
# musl (Alpine): only x64 has a musl build
if [ "$os" = linux ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; }; then
  [ "$arch" = x64 ] || die "no musl build for $arch yet"
  target="linux-x64-musl"
  musl_note="Alpine: baton needs  apk add libstdc++ libgcc"
fi

if [ -z "$VERSION" ]; then
  # releases/latest redirects to .../tag/vX.Y.Z: no API call, so no API rate limit
  if have curl; then
    VERSION=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null | sed -n 's#.*/tag/v\{0,1\}##p')
  fi
  if [ -z "$VERSION" ]; then
    VERSION=$(fetch "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)
  fi
  [ -n "$VERSION" ] || die "could not find the latest release of $REPO"
fi
VERSION=${VERSION#v}
base="${BATON_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download}/v$VERSION"
archive="baton-$target.tar.gz"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
say "Downloading Baton $VERSION ($target)…"
fetch "$base/$archive" >"$tmp/$archive" || die "download failed: $base/$archive"
fetch "$base/SHA256SUMS" >"$tmp/SHA256SUMS" || die "download failed: $base/SHA256SUMS"

want=$(grep " $archive\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
[ -n "$want" ] || die "$archive is not listed in SHA256SUMS"
if have sha256sum; then got=$(sha256sum "$tmp/$archive" | cut -d' ' -f1)
elif have shasum; then got=$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)
else die "needs sha256sum or shasum to verify the download"; fi
[ "$got" = "$want" ] || die "checksum mismatch for $archive (expected $want, got $got)"

tar -xzf "$tmp/$archive" -C "$tmp"
mkdir -p "$DIR"
# replace atomically: a running baton keeps its old inode
cp "$tmp/baton-$target/baton" "$DIR/.baton.new"
chmod 755 "$DIR/.baton.new"
mv -f "$DIR/.baton.new" "$DIR/baton"

say "Installed baton $VERSION → $DIR/baton"
[ -n "${musl_note:-}" ] && say "$musl_note"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *)
    say ""
    say "$DIR is not on your PATH. Add it:"
    say "  echo 'export PATH=\"$DIR:\$PATH\"' >> ~/.$(basename "${SHELL:-sh}")rc"
    ;;
esac
say ""
say "Next: cd into a project and run  baton"
say "      (baton doctor shows which agents it found)"
