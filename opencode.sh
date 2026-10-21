#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${TARGET_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
[[ "${TARGET_DIR}" = /* ]] || TARGET_DIR="${PWD}/${TARGET_DIR}"
EXTRA_FILES_VALUE="${EXTRA_FILES:-}"
BACKUP_DIR=""

FILES=("AGENTS.md" "AGENTS-compression-guide.md")
if [[ -n "${EXTRA_FILES_VALUE}" ]]; then
	# shellcheck disable=SC2206
	EXTRA_FILES_ARRAY=(${EXTRA_FILES_VALUE})
	FILES+=("${EXTRA_FILES_ARRAY[@]}")
fi

list_link_pairs() {
	local f
	for f in "${FILES[@]}"; do
		if [[ -e "${SOURCE_DIR}/${f}" ]]; then
			printf '%s\t%s\n' "${SOURCE_DIR}/${f}" "${TARGET_DIR}/$(basename "${f}")"
		fi
	done

	local opencode_dir="${SOURCE_DIR}/opencode"
	if [[ -d "${opencode_dir}" ]]; then
		shopt -s nullglob
		local opencode_files=("${opencode_dir}"/*.jsonc "${opencode_dir}"/*.json)
		shopt -u nullglob

		for f in "${opencode_files[@]}"; do
			printf '%s\t%s\n' "${f}" "${TARGET_DIR}/$(basename "${f}")"
		done

		local opencode_subdirs=("commands")
		local subdir
		for subdir in "${opencode_subdirs[@]}"; do
			if [[ -d "${opencode_dir}/${subdir}" ]]; then
				while IFS= read -r -d '' f; do
					local rel_path="${f#${opencode_dir}/}"
					printf '%s\t%s\n' "${f}" "${TARGET_DIR}/${rel_path}"
				done < <(find "${opencode_dir}/${subdir}" -type f -print0)
			fi
		done

		if [[ -d "${opencode_dir}/plugins" ]]; then
			while IFS= read -r -d '' f; do
				local rel_path="${f#${opencode_dir}/}"
				printf '%s\t%s\n' "${f}" "${TARGET_DIR}/${rel_path}"
			done < <(find "${opencode_dir}/plugins" -mindepth 1 -maxdepth 1 -type d -print0)
		fi
	fi
}

backup_file() {
	local target="$1" relative
	[[ -e "${target}" || -L "${target}" ]] || return 0
	if [[ -z "${BACKUP_DIR}" ]]; then
		mkdir -p -- "${TARGET_DIR}/backups"
		BACKUP_DIR="$(mktemp -d "${TARGET_DIR}/backups/opencode.XXXXXXXX")"
		echo "[BACKUP] ${BACKUP_DIR}"
	fi
	relative="${target#"${TARGET_DIR}/"}"
	mkdir -p -- "${BACKUP_DIR}/$(dirname -- "${relative}")"
	if [[ -L "${target}" && ! -e "${target}" ]]; then
		cp -P -- "${target}" "${BACKUP_DIR}/${relative}"
	elif [[ -d "${target}" && ! -L "${target}" ]]; then
		cp -a -- "${target}" "${BACKUP_DIR}/${relative}"
	else
		cp -pL -- "${target}" "${BACKUP_DIR}/${relative}"
	fi
}

preflight_links() {
	local src target
	while IFS=$'\t' read -r src target; do
		if [[ ! -e "${src}" || (-d "${target}" && ! -d "${src}") ]]; then
			echo "[ERROR] Missing source or directory at file target: ${src} -> ${target}" >&2
			return 2
		fi
	done < <(list_link_pairs)
}

link() {
	preflight_links
	local src target

	# Back up local files before replacing them with managed symlinks.
	while IFS=$'\t' read -r src target; do
		if [[ -L "${target}" && "$(readlink -- "${target}")" == "${src}" ]]; then
			continue
		fi
		backup_file "${target}"
	done < <(list_link_pairs)

	mkdir -p -- "${TARGET_DIR}"

	local src target
	while IFS=$'\t' read -r src target; do
		mkdir -p "$(dirname "${target}")"
		if [[ -L "${target}" && "$(readlink -- "${target}")" == "${src}" ]]; then
			echo "[OK] ${target}"
		else
			ln -sfn -- "${src}" "${target}"
			echo "[LINK] ${target} -> ${src}"
		fi
	done < <(list_link_pairs)
}

diff_cmd() {
	local has_diff=0
	local compared=0
	local src target

	while IFS=$'\t' read -r src target; do
		compared=1

		if [[ ! -e "${target}" && ! -L "${target}" ]]; then
			echo "[MISSING] ${target}"
			has_diff=1
			continue
		fi

		if [[ -L "${target}" ]]; then
			local target_realpath
			if target_realpath="$(realpath "${target}" 2>/dev/null)"; then
				if [[ "${target_realpath}" == "$(realpath "${src}")" ]]; then
					echo "[OK] ${target} -> ${src}"
				else
					echo "[DIFF] ${target}"
					echo "  expected link target: ${src}"
					echo "  actual link target:   ${target_realpath}"
					has_diff=1
				fi
			else
				echo "[BROKEN] ${target}"
				has_diff=1
			fi
			continue
		fi

		if command diff -u "${src}" "${target}"; then
			echo "[OK] ${target} matches ${src}"
		else
			echo "[DIFF] ${target} (expected a managed symlink)"
			has_diff=1
		fi
	done < <(list_link_pairs)

	if [[ "${compared}" -eq 0 ]]; then
		echo "No tracked source files found."
		return 0
	fi

	if [[ "${has_diff}" -eq 0 ]]; then
		echo "All tracked files are up to date."
	else
		echo "Differences detected."
	fi

	return "${has_diff}"
}

backup() {
	echo "backup not implemented yet"
}

usage() {
	cat <<'EOF'
Usage: ./opencode.sh <command>

Commands:
  link      Back up conflicts and create/update symlinks in TARGET_DIR
  diff      Check managed symlinks in TARGET_DIR
  backup    Placeholder command (not implemented)

Environment variables:
  TARGET_DIR   Default: ${XDG_CONFIG_HOME:-$HOME/.config}/opencode; relative paths use the current directory
  EXTRA_FILES  Optional space-separated extra files to link
EOF
}

main() {
	local cmd="${1:-}"

	case "${cmd}" in
	link)
		mkdir -p -- "${TARGET_DIR}/.config-sync"
		if ! mkdir -- "${TARGET_DIR}/.config-sync/lock" 2>/dev/null; then
			echo "[ERROR] Another operation holds ${TARGET_DIR}/.config-sync/lock" >&2
			exit 2
		fi
		trap 'rmdir -- "${TARGET_DIR}/.config-sync/lock"' EXIT
		link
		;;
	diff)
		diff_cmd
		;;
	backup)
		backup
		;;
	-h | --help | help)
		usage
		;;
	"")
		usage
		exit 1
		;;
	*)
		echo "Unknown command: ${cmd}" >&2
		usage
		exit 1
		;;
	esac
}

main "$@"
