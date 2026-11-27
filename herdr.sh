#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${TARGET_DIR:-$HOME/.config/herdr}"
SOURCE_FILE="herdr.toml"
TARGET_FILE="${TARGET_DIR}/config.toml"

list_link_pairs() {
	if [[ -e "${SOURCE_FILE}" ]]; then
		printf '%s\t%s\n' "$(realpath "${SOURCE_FILE}")" "${TARGET_FILE}"
	fi
}

link() {
	mkdir -p "${TARGET_DIR}"

	local src target
	while IFS=$'\t' read -r src target; do
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
Usage: ./herdr.sh <command>

Commands:
  link      Create/update ~/.config/herdr/config.toml symlink
  diff      Compare herdr.toml with ~/.config/herdr/config.toml
  backup    Placeholder command (not implemented)

Environment variables:
  TARGET_DIR   Default: ~/.config/herdr
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
