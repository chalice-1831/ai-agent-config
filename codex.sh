#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${TARGET_DIR:-${CODEX_HOME:-$HOME/.codex}}"
[[ "${TARGET_DIR}" = /* ]] || TARGET_DIR="${PWD}/${TARGET_DIR}"
BACKUP_DIR=""

list_link_pairs() {
  local f
  for f in AGENTS.md AGENTS-compression-guide.md; do
    printf '%s\t%s\n' "${SOURCE_DIR}/${f}" "${TARGET_DIR}/${f}"
  done
  for f in "${SOURCE_DIR}"/codex/rules/*.rules; do
    printf '%s\t%s\n' "${f}" "${TARGET_DIR}/rules/$(basename -- "${f}")"
  done
}

backup_file() {
  local target="$1" relative
  [[ -e "${target}" || -L "${target}" ]] || return 0
  if [[ -z "${BACKUP_DIR}" ]]; then
    mkdir -p -- "${TARGET_DIR}/backups"
    BACKUP_DIR="$(mktemp -d "${TARGET_DIR}/backups/codex.XXXXXXXX")"
    echo "[BACKUP] ${BACKUP_DIR}"
  fi
  relative="${target#"${TARGET_DIR}/"}"
  mkdir -p -- "${BACKUP_DIR}/$(dirname -- "${relative}")"
  if [[ -L "${target}" && ! -e "${target}" ]]; then
    cp -P -- "${target}" "${BACKUP_DIR}/${relative}"
  else
    # Store file contents, so later edits through a source symlink cannot alter the backup.
    cp -pL -- "${target}" "${BACKUP_DIR}/${relative}"
  fi
}

preflight_links() {
  local src target
  if [[ -L "${TARGET_DIR}/rules" ]]; then
    echo "[ERROR] rules/ must be a directory, not a symlink" >&2
    return 2
  fi
  while IFS=$'\t' read -r src target; do
    if [[ ! -f "${src}" || -d "${target}" ]]; then
      echo "[ERROR] Missing source or directory at file target: ${src} -> ${target}" >&2
      return 2
    fi
  done < <(list_link_pairs)
}

link() {
  preflight_links
  local src target
  # Back up all conflicts before replacing any file.
  while IFS=$'\t' read -r src target; do
    if [[ -L "${target}" && "$(readlink -- "${target}")" == "${src}" ]]; then
      continue
    fi
    backup_file "${target}"
  done < <(list_link_pairs)
  mkdir -p -- "${TARGET_DIR}/rules"
  while IFS=$'\t' read -r src target; do
    if [[ -L "${target}" && "$(readlink -- "${target}")" == "${src}" ]]; then
      echo "[OK] ${target}"
    else
      ln -sfn -- "${src}" "${target}"
      echo "[LINK] ${target} -> ${src}"
    fi
  done < <(list_link_pairs)
}

diff_links() {
  local src target has_diff=0
  while IFS=$'\t' read -r src target; do
    if [[ -L "${target}" ]]; then
      if [[ ! -e "${target}" ]]; then
        echo "[BROKEN] ${target}"
        has_diff=1
      elif [[ "$(readlink -- "${target}")" == "${src}" ]]; then
        echo "[OK] ${target}"
      else
        echo "[DIFF] ${target} (link target differs)"
        has_diff=1
      fi
    elif [[ ! -e "${target}" ]]; then
      echo "[MISSING] ${target}"
      has_diff=1
    else
      echo "[DIFF] ${target} (expected a managed symlink)"
      has_diff=1
    fi
  done < <(list_link_pairs)
  return "${has_diff}"
}

mcp() {
  if ! command -v uv >/dev/null 2>&1; then
    echo "[ERROR] uv is required for MCP sync/diff; install it with mise install uv" >&2
    return 2
  fi
  UV_CACHE_DIR="${TARGET_DIR}/.config-sync/uv-cache" uv run --no-project --script "${SOURCE_DIR}/scripts/codex_mcp.py" \
    "$1" --source "${SOURCE_DIR}/codex/mcp.toml" --target-dir "${TARGET_DIR}"
}

diff_cmd() {
  local links_status=0 mcp_status=0
  diff_links || links_status=$?
  mcp diff || mcp_status=$?
  if [[ "${mcp_status}" -gt 1 ]]; then
    return "${mcp_status}"
  fi
  [[ "${links_status}" -eq 0 && "${mcp_status}" -eq 0 ]]
}

backup() {
  preflight_links
  local src target
  while IFS=$'\t' read -r src target; do
    backup_file "${target}"
  done < <(list_link_pairs)
  for target in config.toml .config-sync/mcp.toml; do
    if [[ -d "${TARGET_DIR}/${target}" ]]; then
      echo "[ERROR] Expected file: ${TARGET_DIR}/${target}" >&2
      return 2
    fi
    backup_file "${TARGET_DIR}/${target}"
  done
  [[ -n "${BACKUP_DIR}" ]] || echo "[OK] No managed files to back up"
}

usage() {
  cat <<'EOF'
Usage: ./codex.sh <command>

Commands:
  link      Back up conflicts and link shared instructions and global rules
  sync      Merge shared MCP definitions, preserving local configuration
  diff      Check managed links and MCP definitions (0: equal, 1: differs, 2: error)
  backup    Snapshot managed files and local config into TARGET_DIR/backups/

Environment variables:
  TARGET_DIR   Overrides CODEX_HOME (default: ~/.codex)

Shared instructions:
  link installs AGENTS.md and AGENTS-compression-guide.md from this repository
  into TARGET_DIR as symlinks. OpenCode's opencode.sh links the same source files.
  Edit the repository files once to share instructions between both clients.

On another machine:
  Clone or pull this repository, then run ./codex.sh link.
  To share with OpenCode too, run ./opencode.sh link from the repository root.
  Pull subsequent instruction changes on each machine; symlinks follow local files.

MCP sync/diff requires uv; the isolated TOMLKit dependency is pinned in the helper.
Project rules under .codex/rules/ are never installed globally.
EOF
}

main() {
  if [[ "$#" -ne 1 ]]; then
    usage
    return 2
  fi
  case "$1" in
  -h | --help | help) usage ;;
  diff) diff_cmd ;;
  link | sync | backup)
    # Serialize this script's writes; Codex itself does not use this lock.
    mkdir -p -- "${TARGET_DIR}/.config-sync"
    if ! mkdir -- "${TARGET_DIR}/.config-sync/lock" 2>/dev/null; then
      echo "[ERROR] Another operation holds ${TARGET_DIR}/.config-sync/lock" >&2
      return 2
    fi
    trap 'rmdir -- "${TARGET_DIR}/.config-sync/lock"' EXIT
    case "$1" in
    sync) mcp sync ;;
    link) link ;;
    backup) backup ;;
    esac
    ;;
  *)
    echo "Unknown command: $1" >&2
    usage
    return 2
    ;;
  esac
}

main "$@"
