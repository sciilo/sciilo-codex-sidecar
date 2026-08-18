#!/usr/bin/env bash
#
# Installs the Sciilo Codex sidecar as a machine-wide, standalone command.
#
#   ./install.sh                      from a checkout of this repository
#   ./install.sh --from <path|git>    from another checkout or a git remote
#
# The source is packed before it is installed. This is important: installing a
# local directory directly would create a link back to the checkout, and the
# command would stop working if that directory were moved or deleted.
#
# Nothing is written outside npm's own prefix. Pairing details are asked later
# by `sciilo-codex setup`.

set -euo pipefail

PACKAGE_NAME='@sciilo.ai/codex-sidecar'
COMMAND_NAME='sciilo-codex'
MIN_NODE_MAJOR=22
TEMP_DIR=''

main() {
  local source=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --from)
        source="${2-}"
        [ -n "$source" ] || fail '--from expects a path or a git URL.'
        shift 2
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        usage >&2
        fail "Unknown option: $1"
        ;;
    esac
  done

  require_tools
  [ -n "$source" ] || source="${SCIILO_CODEX_SOURCE:-$(local_package)}"
  [ -n "$source" ] || fail \
    'No package found next to this script. Pass --from <path|git URL>.'

  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sciilo-codex-install.XXXXXX")"
  trap cleanup EXIT

  local target="$source"
  if is_git_source "$source"; then
    target="$TEMP_DIR/source"
    clone "$source" "$target"
  elif [ ! -f "$target/package.json" ]; then
    fail "No package.json in $target."
  fi

  local archive_name archive
  say "Preparing a standalone package from $source"
  archive_name="$(cd "$target" && npm pack --silent --pack-destination "$TEMP_DIR")"
  archive="$TEMP_DIR/$archive_name"
  [ -f "$archive" ] || fail 'npm did not create the installation package.'

  say "Installing $PACKAGE_NAME"
  if ! npm install --global "$archive"; then
    fail 'Installation failed. Do not use sudo. Install Node.js for your user, reopen the terminal, and try again.'
  fi
  report "$@"
}

require_tools() {
  command -v node >/dev/null 2>&1 || fail 'Node.js is required. See https://nodejs.org.'
  command -v npm >/dev/null 2>&1 || fail 'npm is required; it ships with Node.js.'

  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    fail "Node.js $MIN_NODE_MAJOR or newer is required (found $(node -v))."
  fi
}

# The directory holding this script, when it is a checkout rather than a pipe.
local_package() {
  local self="${BASH_SOURCE[0]:-}"
  [ -n "$self" ] && [ -f "$self" ] || return 0
  local dir
  dir="$(cd "$(dirname "$self")" && pwd)"
  [ -f "$dir/package.json" ] && printf '%s' "$dir"
}

is_git_source() {
  case "$1" in
    git@*|*.git|http://*|https://*|ssh://*) return 0 ;;
    *) return 1 ;;
  esac
}

clone() {
  command -v git >/dev/null 2>&1 || fail 'git is required to install from a remote.'
  git clone --depth 1 --quiet "$1" "$2" >&2
}

report() {
  local binary
  binary="$(command -v "$COMMAND_NAME" || true)"
  if [ -z "$binary" ]; then
    local bin_dir
    bin_dir="$(npm prefix -g)/bin"
    say ''
    say "Installed, but $COMMAND_NAME is not on your PATH yet. Add it with:"
    say "  export PATH=\"$bin_dir:\$PATH\""
  else
    say ''
    say "Installed: $binary"
  fi

  say ''
  say 'Codex runtime: installed automatically with the sidecar.'
  say ''
  say 'Next steps:'
  say "  $COMMAND_NAME setup            pair with your Sciilo application"
  say "  cd ~/your-project && $COMMAND_NAME"
  say ''
  say 'The directory you start it from is the project it works on.'
}

usage() {
  cat <<USAGE
Usage: install.sh [--from <path|git URL>]

Installs $PACKAGE_NAME globally so that $COMMAND_NAME runs from any directory.

  --from <path|git URL>   Install from that checkout or remote instead of the
                          directory holding this script.
  -h, --help              Show this message.

Environment:
  SCIILO_CODEX_SOURCE   Same as --from.
USAGE
}

cleanup() {
  [ -z "$TEMP_DIR" ] || rm -rf -- "$TEMP_DIR"
}

say() { printf '%s\n' "$1"; }
fail() { printf 'install.sh: %s\n' "$1" >&2; exit 1; }

main "$@"
