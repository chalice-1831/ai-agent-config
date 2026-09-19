# /// script
# requires-python = ">=3.9"
# dependencies = ["tomlkit==0.15.1"]
# ///
"""Synchronize only repository-owned MCP definitions in a local Codex config."""

import argparse
from collections.abc import Mapping
from copy import deepcopy
from pathlib import Path
import os
import shutil
import stat
import sys
import tempfile

import tomlkit
from tomlkit.exceptions import ParseError


def read_document(path):
    if path.is_symlink():
        raise ValueError(f"Expected a local file, not a symlink: {path}")
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    try:
        return text, tomlkit.parse(text)
    except ParseError as error:
        # Do not print config text or credentials when reporting malformed TOML.
        raise ValueError(f"Invalid TOML: {path} ({type(error).__name__})") from error


def servers(document, label, only_mcp=False):
    if only_mcp and set(document) - {"mcp_servers"}:
        raise ValueError(f"{label} must contain only mcp_servers")
    result = document.get("mcp_servers", {})
    if not isinstance(result, Mapping):
        raise ValueError(f"{label}: mcp_servers must be a table")
    for name, definition in result.items():
        if not isinstance(definition, Mapping):
            raise ValueError(f"{label}: mcp_servers.{name} must be a table")
    return result


def merge_table(current, desired):
    """Change owned values in place to retain existing TOML trivia."""
    for key in list(current):
        if key not in desired:
            del current[key]
    for key, value in desired.items():
        if key in current and isinstance(current[key], Mapping) and isinstance(value, Mapping):
            merge_table(current[key], value)
        elif key not in current or current[key] != value:
            current[key] = deepcopy(value)


def compare(desired, current, previous):
    changes, conflicts, stale = [], [], []
    for name, definition in desired.items():
        if current.get(name) == definition:
            print(f"[OK] MCP {name}")
        elif name not in current and name not in previous:
            print(f"[MISSING] MCP {name}")
            changes.append(name)
        elif name in previous and current.get(name) == previous[name]:
            print(f"[UPDATE] MCP {name}")
            changes.append(name)
        else:
            print(f"[CONFLICT] MCP {name}: local definition differs; no automatic overwrite")
            conflicts.append(name)
    for name in previous:
        if name not in desired and name in current:
            print(f"[STALE] MCP {name}: no longer shared; kept locally")
            stale.append(name)
    return changes, conflicts, stale


def atomic_write(path, text, expected):
    # Refuse an observed concurrent edit rather than replacing another client's work.
    actual = path.read_text(encoding="utf-8") if path.exists() else ""
    if path.is_symlink() or actual != expected:
        raise ValueError(f"File changed during sync: {path}; retry after reviewing it")
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    fd, temporary = tempfile.mkstemp(prefix=".codex-sync-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(text)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def backup_config(target_dir, paths):
    existing = [path for path in paths if path.exists()]
    if not existing:
        return
    directory = target_dir / "backups"
    directory.mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix="codex.", dir=directory))
    for path in existing:
        destination = backup / path.relative_to(target_dir)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
    print(f"[BACKUP] {backup}")


def run(command, source, target_dir):
    if not source.is_file():
        raise ValueError(f"Missing MCP source: {source}")
    _, shared = read_document(source)
    config_path = target_dir / "config.toml"
    state_path = target_dir / ".config-sync" / "mcp.toml"
    config_text, config = read_document(config_path)
    state_text, state = read_document(state_path)
    desired = servers(shared, source, only_mcp=True)
    current = servers(config, config_path)
    previous = servers(state, state_path, only_mcp=True)
    changes, conflicts, stale = compare(desired, current, previous)
    if command == "diff":
        return int(bool(changes or conflicts or stale))
    if conflicts:
        print("[ERROR] Resolve the named MCP definitions locally, then rerun sync", file=sys.stderr)
        return 1
    for name, definition in desired.items():
        executable = definition.get("command")
        if definition.get("enabled", True) and executable and not shutil.which(executable):
            raise ValueError(f"MCP {name} requires an executable on PATH: {executable}")
    if changes:
        if "mcp_servers" not in config:
            config["mcp_servers"] = tomlkit.table()
        for name in changes:
            if name in config["mcp_servers"]:
                merge_table(config["mcp_servers"][name], desired[name])
            else:
                config["mcp_servers"][name] = deepcopy(desired[name])
    next_state = deepcopy(shared)
    for name in stale:
        next_state.setdefault("mcp_servers", tomlkit.table())[name] = deepcopy(previous[name])
    new_config = tomlkit.dumps(config)
    new_state = tomlkit.dumps(next_state)
    # Parse generated output before touching either file.
    tomlkit.parse(new_config)
    tomlkit.parse(new_state)
    config_changed = new_config != config_text
    state_changed = new_state != state_text
    if config_changed or state_changed:
        backup_config(target_dir, [config_path, state_path])
        if config_changed:
            atomic_write(config_path, new_config, config_text)
        if state_changed:
            atomic_write(state_path, new_state, state_text)
        print("[SYNC] Shared MCP definitions synchronized")
    else:
        print("[OK] MCP configuration is up to date")
    return int(bool(stale))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["sync", "diff"])
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        return run(args.command, args.source, args.target_dir)
    except (OSError, ValueError) as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
