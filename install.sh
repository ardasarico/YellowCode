#!/bin/sh
# Installs YellowCode: curl -fsSL https://raw.githubusercontent.com/ardasarico/YellowCode/main/install.sh | bash -s [stable|beta|<version>]
set -eu

REPO="ardasarico/YellowCode"
CHANNELS_URL="${YELLOWCODE_CHANNELS:-https://raw.githubusercontent.com/$REPO/main/release/channels.json}"
DOWNLOADS_URL="${YELLOWCODE_DOWNLOADS:-https://github.com/$REPO/releases/download}"
# YELLOWCODE_HOME relocates the folder, as it does for the app; a value that is not an absolute path is ignored.
case "${YELLOWCODE_HOME:-}" in
  /*) HOME_DIR="$YELLOWCODE_HOME" ;;
  *) HOME_DIR="$HOME/.yellowcode" ;;
esac
BIN_DIR="$HOME/.local/bin"
want="${1:-stable}"

# The terminal's own colors, and only when the output is a terminal.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
  esc=$(printf '\033')
  bold="${esc}[1m" dim="${esc}[2m" accent="${esc}[33m" good="${esc}[32m" bad="${esc}[31m" plain="${esc}[0m"
else
  esc="" bold="" dim="" accent="" good="" bad="" plain=""
fi

fail() {
  echo "  ${bad}✗${plain} yellowcode install: $1" >&2
  exit 1
}

step() {
  printf '  %s✓%s %-10s  %s%s%s\n' "$good" "$plain" "$1" "$dim" "$2" "$plain"
}

fetch() {
  curl -fsSL --retry 2 "$1" -o "$2" || fail "could not download $1"
}

megabytes() {
  awk -v bytes="$1" 'BEGIN { printf "%.1f", bytes / 1048576 }'
}

# Downloads like fetch, under a line that shows how far it is; the line is gone once it ends.
download() {
  if [ -z "$esc" ]; then
    fetch "$1" "$2"
    return
  fi
  total=$(curl -fsSLI "$1" 2>/dev/null | awk 'tolower($1) == "content-length:" { size = $2 } END { print size + 0 }')
  curl -fsSL --retry 2 "$1" -o "$2" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    got=0
    [ -f "$2" ] && got=$(wc -c <"$2")
    awk -v got="$got" -v total="$total" -v on="$accent" -v off="$dim" -v plain="$plain" 'BEGIN {
      if (total <= 0) { printf "\r\033[2K  %s%.1f MB%s", off, got / 1048576, plain; exit }
      filled = int(got * 30 / total)
      for (i = 0; i < 30; i++) bar = bar (i == 0 ? on : "") (i == filled ? plain off : "") "━"
      printf "\r\033[2K  %s%s  %s%.1f / %.1f MB%s", bar, plain, off, got / 1048576, total / 1048576, plain
    }'
    sleep 0.1
  done
  printf '\r\033[2K'
  wait "$pid" || fail "could not download $1"
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    sha256sum "$1" | cut -d ' ' -f 1
  fi
}

# 1 when $1 is a newer version than $2; a beta is older than the release it leads to.
newer() {
  awk -v a="$1" -v b="$2" 'function part(v, i, n) { split(v, n, /[.-]/); return n[i] + 0 }
    BEGIN {
      for (i = 1; i <= 3; i++) if (part(a, i) != part(b, i)) { print (part(a, i) > part(b, i)); exit }
      ab = index(a, "-beta."); bb = index(b, "-beta.")
      if (!ab || !bb) { print (!ab && bb ? 1 : 0); exit }
      print (substr(a, ab + 6) + 0 > substr(b, bb + 6) + 0)
    }'
}

# A field of a channel's entry in channels.json, which tools/release.ts writes with two-space indents.
field() {
  awk -v channel="$1" -v key="$2" '
    $0 ~ "^  \"" channel "\": \\{" { inside = 1; next }
    inside && /^  [}]/ { exit }
    inside && $0 ~ "\"" key "\": \"" { sub(".*\"" key "\": \"", ""); sub("\".*", ""); print; exit }
  ' "$3"
}

# The url or sha256 of a platform's file in a channel's entry.
asset() {
  awk -v channel="$1" -v platform="$2" -v key="$3" '
    $0 ~ "^  \"" channel "\": \\{" { inside = 1; next }
    inside && /^  [}]/ { exit }
    inside && $0 ~ "\"" platform "\": \\{" { found = 1; next }
    found && $0 ~ "\"" key "\": \"" { sub(".*\"" key "\": \"", ""); sub("\".*", ""); print; exit }
  ' "$4"
}

case "$(uname -s)" in
  Darwin) os=darwin system=macOS ;;
  Linux) os=linux system=Linux ;;
  *) fail "YellowCode runs on macOS and Linux; on Windows, install it in WSL" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) cpu=arm64 ;;
  x86_64 | amd64) cpu=x64 ;;
  *) fail "no build for $(uname -m)" ;;
esac
# A shell running under Rosetta reports x86_64 on an Apple silicon Mac.
if [ "$os" = darwin ] && [ "$cpu" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
  cpu=arm64
fi
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  fail "musl-based Linux (like Alpine) is not supported yet"
fi
platform="$os-$cpu"
file="yellowcode-$platform.tar.gz"

command -v curl >/dev/null 2>&1 || fail "needs curl"
mkdir -p "$HOME_DIR/versions" "$BIN_DIR"
work=$(mktemp -d "$HOME_DIR/.install-XXXXXX")
trap 'rm -rf "$work"' EXIT

case "$want" in
  stable | beta)
    channel="$want"
    fetch "$CHANNELS_URL" "$work/channels.json"
    pick=stable
    stable=$(field stable version "$work/channels.json")
    if [ "$want" = beta ]; then
      beta=$(field beta version "$work/channels.json")
      if [ -n "$beta" ] && { [ -z "$stable" ] || [ "$(newer "$beta" "$stable")" = 1 ]; }; then pick=beta; fi
    fi
    version=$(field "$pick" version "$work/channels.json")
    [ -n "$version" ] || fail "there is no $want release yet"
    url=$(asset "$pick" "$platform" url "$work/channels.json")
    expected=$(asset "$pick" "$platform" sha256 "$work/channels.json")
    ;;
  *)
    version="${want#v}"
    case "$version" in *-beta.*) channel=beta ;; *) channel=stable ;; esac
    url="$DOWNLOADS_URL/v$version/$file"
    fetch "$DOWNLOADS_URL/v$version/SHA256SUMS" "$work/SHA256SUMS"
    expected=$(awk -v name="$file" '$2 == name { print $1 }' "$work/SHA256SUMS")
    ;;
esac
[ -n "$expected" ] || fail "no checksum for $file in $version"

echo
echo "  ${accent}●${plain} ${bold}YellowCode $version${plain}  ${dim}$system $cpu · $channel${plain}"
echo
download "$url" "$work/$file"
step Downloaded "$(megabytes "$(wc -c <"$work/$file")") MB"
[ "$(sha256 "$work/$file")" = "$expected" ] || fail "$file does not match its checksum; nothing was installed"
mkdir "$work/unpacked"
tar -xzf "$work/$file" -C "$work/unpacked"
[ -f "$work/unpacked/yellowcode" ] || fail "$file holds no yellowcode binary"
chmod +x "$work/unpacked/yellowcode"
step Verified sha256

target="$HOME_DIR/versions/$version"
rm -rf "$target"
mv "$work/unpacked" "$target"
ln -s "$target/yellowcode" "$work/link"
mv -f "$work/link" "$BIN_DIR/yellowcode"
printf '{ "method": "script", "channel": "%s" }\n' "$channel" >"$HOME_DIR/install.json"

step Installed "~${BIN_DIR#"$HOME"}/yellowcode"
echo
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "  Run ${accent}yellowcode${plain} to start." ;;
  *)
    case "$(basename "${SHELL:-sh}")" in
      zsh) hint="echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc" ;;
      bash) hint="echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc" ;;
      fish) hint="fish_add_path ~/.local/bin" ;;
      *) hint="add $BIN_DIR to PATH in your shell's startup file" ;;
    esac
    echo "  ${accent}⚠${plain} ~${BIN_DIR#"$HOME"} is not on your PATH. To add it:"
    echo "    ${accent}$hint${plain}"
    ;;
esac
echo
