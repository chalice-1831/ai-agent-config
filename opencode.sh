#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${TARGET_DIR:-$HOME/.config/opencode}"
EXTRA_FILES_VALUE="${EXTRA_FILES:-}"

FILES=("AGENTS.md" "AGENTS-compression-guide.md")
if [[ -n "${EXTRA_FILES_VALUE}" ]]; then
	# shellcheck disable=SC2206
	EXTRA_FILES_ARRAY=(${EXTRA_FILES_VALUE})
	FILES+=("${EXTRA_FILES_ARRAY[@]}")
fi

list_link_pairs() {
	local f
	for f in "${FILES[@]}"; do
		if [[ -e "${f}" ]]; then
			printf '%s\t%s\n' "$(realpath "${f}")" "${TARGET_DIR}/$(basename "${f}")"
		fi
	done

	local opencode_dir="./opencode"
	if [[ -d "${opencode_dir}" ]]; then
		shopt -s nullglob
		local opencode_files=("${opencode_dir}"/*.jsonc "${opencode_dir}"/*.json)
		shopt -u nullglob

		for f in "${opencode_files[@]}"; do
			printf '%s\t%s\n' "$(realpath "${f}")" "${TARGET_DIR}/$(basename "${f}")"
		done

		local opencode_subdirs=("plugins" "commands")
		local subdir
		for subdir in "${opencode_subdirs[@]}"; do
			if [[ -d "${opencode_dir}/${subdir}" ]]; then
				while IFS= read -r -d '' f; do
					local rel_path="${f#${opencode_dir}/}"
					printf '%s\t%s\n' "$(realpath "${f}")" "${TARGET_DIR}/${rel_path}"
				done < <(find "${opencode_dir}/${subdir}" -type f -print0)
			fi
		done
	fi
}

link() {
	mkdir -p "${TARGET_DIR}"

	local src target
	while IFS=$'\t' read -r src target; do
		mkdir -p "$(dirname "${target}")"
		ln -sfn "${src}" "${target}"
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
				if [[ "${target_realpath}" == "${src}" ]]; then
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
			echo "[DIFF] ${target} (expected content from ${src})"
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
  link      Create/update symlinks in TARGET_DIR
  diff      Compare source files with TARGET_DIR files/links
  backup    Placeholder command (not implemented)

Environment variables:
  TARGET_DIR   Default: ~/.config/opencode
  EXTRA_FILES  Optional space-separated extra files to link
EOF
}

main() {
	local cmd="${1:-}"

	case "${cmd}" in
	link)
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
