#!/usr/bin/env bash
# OpenHarnes install — served from Vercel at https://openharnes.com/install
# Usage: curl -fsSL https://openharnes.com/install | bash
#
# Prefers npm (@openharnes/harnes). Falls back to the site tarball if npm
# publish is unreachable.
set -euo pipefail

BASE_URL="${HARNES_BASE_URL:-https://openharnes.com}"
INSTALL_DIR="${HARNES_INSTALL_DIR:-$HOME/.openharnes}"
BIN_DIR="${HARNES_BIN_DIR:-$HOME/.local/bin}"
TARBALL_URL="${HARNES_TARBALL_URL:-$BASE_URL/releases/harnes-latest.tgz}"
NPM_PKG="${HARNES_NPM_PKG:-@openharnes/harnes}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"
}

ensure_path() {
  mkdir -p "$BIN_DIR"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      info "add $BIN_DIR to your PATH"
      if [ "${SHELL:-}" = */zsh ] || [ -n "${ZSH_VERSION:-}" ]; then
        printf '\nexport PATH="%s:\$PATH"\n' "$BIN_DIR" >> "$HOME/.zshrc"
        info "appended PATH to ~/.zshrc — run: source ~/.zshrc"
      elif [ "${SHELL:-}" = */bash ] || [ -n "${BASH_VERSION:-}" ]; then
        printf '\nexport PATH="%s:\$PATH"\n' "$BIN_DIR" >> "$HOME/.bashrc"
        info "appended PATH to ~/.bashrc — run: source ~/.bashrc"
      fi
      export PATH="$BIN_DIR:$PATH"
      ;;
  esac
}

need curl
need node
need npm

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node.js 20+ required (found $(node -v))"
fi

bold "OpenHarnes — installing Harnes CLI"

METHOD="npm"
if npm install -g "$NPM_PKG" >/tmp/harnes-npm-install.log 2>&1; then
  NPM_ROOT="$(npm root -g)"
  CLI="$NPM_ROOT/@openharnes/harnes/dist/cli.js"
  if [ ! -f "$CLI" ]; then
    # scoped package path fallback
    CLI="$(node -p "require('path').join(require('child_process').execSync('npm root -g',{encoding:'utf8'}).trim(), '$NPM_PKG', 'dist/cli.js')")"
  fi
  [ -f "$CLI" ] || die "npm install succeeded but dist/cli.js missing"
  ensure_path
  WRAPPER="$BIN_DIR/harnes"
  cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec node "$CLI" "\$@"
EOF
  chmod +x "$WRAPPER"
  VERSION="$(node -p "require('$NPM_ROOT/@openharnes/harnes/package.json').version" 2>/dev/null || echo latest)"
else
  METHOD="tarball"
  info "npm install failed — falling back to $TARBALL_URL"
  need tar
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "$TARBALL_URL" -o "$TMP/harnes.tgz"
  tar -xzf "$TMP/harnes.tgz" -C "$TMP"
  SRC="$TMP/package"
  if [ ! -d "$SRC" ]; then
    SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)"
  fi
  [ -d "$SRC" ] || die "invalid release tarball (no package directory)"
  [ -f "$SRC/dist/cli.js" ] || die "release tarball missing dist/cli.js — rebuild on Vercel"
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  cp -R "$SRC"/. "$INSTALL_DIR"/
  ensure_path
  WRAPPER="$BIN_DIR/harnes"
  cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/dist/cli.js" "\$@"
EOF
  chmod +x "$WRAPPER"
  VERSION="$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || echo unknown)"
fi

bold "Installed"
printf '  method:  %s\n' "$METHOD"
printf '  version: %s\n' "$VERSION"
printf '  binary:  %s\n' "$WRAPPER"
printf '\n'
printf 'Quick start:\n'
printf '  harnes                 # persistent session (setup on first run)\n'
printf '  export OPENROUTER_API_KEY=sk-or-...\n'
printf '  harnes smoke\n'
printf '\n'
printf 'Harnes is the open coding agent.\n'
printf 'If /help looks stale, quit and rerun — or: hash -r && harnes\n'
