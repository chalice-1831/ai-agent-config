#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${TARGET_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}"
[[ "${TARGET_DIR}" = /* ]] || TARGET_DIR="${PWD}/${TARGET_DIR}"
BACKUP_DIR=""
STAGING_DIR=""

list_link_pairs() {
	local f
	for f in AGENTS.md AGENTS-compression-guide.md; do
		printf '%s\t%s\n' "${SOURCE_DIR}/${f}" "${TARGET_DIR}/${f}"
	done
	printf '%s\t%s\n' "${SOURCE_DIR}/pi/mcp-adapter.json" "${TARGET_DIR}/mcp-adapter.json"
	printf '%s\t%s\n' "${SOURCE_DIR}/pi/sol-pi.json" "${TARGET_DIR}/sol-pi.json"
	printf '%s\t%s\n' "${SOURCE_DIR}/pi/pi-permission-system.json" "${TARGET_DIR}/extensions/pi-permission-system/config.json"
	for f in "${SOURCE_DIR}"/pi/prompts/*.md; do
		printf '%s\t%s\n' "${f}" "${TARGET_DIR}/prompts/$(basename -- "${f}")"
	done
	for f in "${SOURCE_DIR}"/pi/extensions/*; do
		printf '%s\t%s\n' "${f}" "${TARGET_DIR}/extensions/$(basename -- "${f}")"
	done
}

backup_file() {
	local target="$1" relative
	[[ -e "${target}" || -L "${target}" ]] || return 0
	if [[ -z "${BACKUP_DIR}" ]]; then
		mkdir -p -- "${TARGET_DIR}/backups"
		BACKUP_DIR="$(mktemp -d "${TARGET_DIR}/backups/pi.XXXXXXXX")"
		echo "[BACKUP] ${BACKUP_DIR}"
	fi
	relative="${target#"${TARGET_DIR}/"}"
	mkdir -p -- "${BACKUP_DIR}/$(dirname -- "${relative}")"
	if [[ -L "${target}" && ! -e "${target}" ]]; then
		cp -P -- "${target}" "${BACKUP_DIR}/${relative}"
	elif [[ -d "${target}" ]]; then
		cp -RLp -- "${target}" "${BACKUP_DIR}/${relative}"
	else
		cp -pL -- "${target}" "${BACKUP_DIR}/${relative}"
	fi
}

preflight() {
	local dir src target
	for dir in "${TARGET_DIR}" "${TARGET_DIR}/extensions" "${TARGET_DIR}/extensions/pi-permission-system" "${TARGET_DIR}/prompts" "${TARGET_DIR}/.config-sync" "${TARGET_DIR}/backups"; do
		if [[ -L "${dir}" || (-e "${dir}" && ! -d "${dir}") ]]; then
			echo "[ERROR] Expected real directory: ${dir}" >&2
			return 2
		fi
	done
	while IFS=$'\t' read -r src target; do
		if [[ ! -e "${src}" || (-d "${target}" && ! -d "${src}") ]]; then
			echo "[ERROR] Missing source or directory at file target: ${src} -> ${target}" >&2
			return 2
		fi
	done < <(list_link_pairs)
	command -v node >/dev/null 2>&1 || {
		echo "[ERROR] Node.js is required" >&2
		return 2
	}
}

json_files() {
	node "${SOURCE_DIR}/scripts/pi_settings.mjs" "$1" --source "${SOURCE_DIR}/pi" --target-dir "${TARGET_DIR}" "${@:2}"
}

link() {
	local src target name
	STAGING_DIR="$(mktemp -d "${TARGET_DIR}/.config-sync/pi.XXXXXXXX")"
	json_files prepare --output-dir "${STAGING_DIR}"
	# Prepare JSON and back up every conflict before replacing managed files.
	while IFS=$'\t' read -r src target; do
		[[ -L "${target}" && "$(readlink -- "${target}")" == "${src}" ]] || backup_file "${target}"
	done < <(list_link_pairs)
	for name in settings.json models.json; do
		target="${TARGET_DIR}/${name}"
		if [[ -L "${target}" ]] || ! cmp -s "${STAGING_DIR}/${name}" "${target}"; then
			backup_file "${target}"
		fi
	done
	while IFS=$'\t' read -r src target; do
		mkdir -p -- "$(dirname -- "${target}")"
		if [[ -L "${target}" && "$(readlink -- "${target}")" == "${src}" ]]; then
			echo "[OK] ${target}"
		else
			if [[ -d "${target}" && ! -L "${target}" ]]; then
				rm -rf -- "${target}"
			fi
			ln -sfn -- "${src}" "${target}"
			echo "[LINK] ${target} -> ${src}"
		fi
	done < <(list_link_pairs)
	for name in settings.json models.json; do
		target="${TARGET_DIR}/${name}"
		if [[ ! -L "${target}" ]] && cmp -s "${STAGING_DIR}/${name}" "${target}"; then
			echo "[OK] ${target}"
		else
			# Remove a previous symlink rather than copying through it into its source.
			rm -f -- "${target}"
			cp -- "${STAGING_DIR}/${name}" "${target}"
			echo "[COPY] ${target}"
		fi
	done
}

diff_cmd() {
	local src target status=0 json_status=0
	while IFS=$'\t' read -r src target; do
		if [[ -L "${target}" && -e "${target}" && "$(readlink -- "${target}")" == "${src}" ]]; then
			echo "[OK] ${target}"
		else
			echo "[DIFF] ${target} (expected managed symlink)"
			status=1
		fi
	done < <(list_link_pairs)
	json_files diff || json_status=$?
	[[ "${json_status}" -le 1 ]] || return "${json_status}"
	[[ "${status}" -eq 0 && "${json_status}" -eq 0 ]]
}

cleanup() {
	[[ -z "${STAGING_DIR}" ]] || rm -rf -- "${STAGING_DIR}"
	rmdir -- "${TARGET_DIR}/.config-sync/lock"
}

usage() {
	cat <<'EOF'
Usage: ./pi.sh <link|diff>

  link   Back up conflicts, link static resources, and copy rendered local JSON
  diff   Read-only check (0: equal, 1: differs, 2: error)

Target: TARGET_DIR > PI_CODING_AGENT_DIR > ~/.pi/agent
Requires: Node.js, ANTHROPIC_BASE_URL and OPENAI_BASE_URL (exported HTTP(S) URLs)
Only base URLs are rendered. API keys remain runtime environment references.
Exit Pi before link. Package installation is separate: pi update --extensions.
See pi/README.md for setup, credentials, backups, and validation.
EOF
}

main() {
	if [[ "$#" -ne 1 ]]; then
		usage
		return 2
	fi
	case "$1" in
	-h | --help | help) usage ;;
	diff)
		preflight
		diff_cmd
		;;
	link)
		preflight
		umask 077
		mkdir -p -- "${TARGET_DIR}/.config-sync"
		if ! mkdir -- "${TARGET_DIR}/.config-sync/lock" 2>/dev/null; then
			echo "[ERROR] Another operation holds ${TARGET_DIR}/.config-sync/lock" >&2
			return 2
		fi
		trap cleanup EXIT
		link
		;;
	*)
		echo "Unknown command: $1" >&2
		usage
		return 2
		;;
	esac
}

main "$@"
