"""Run with: uv run --no-project --with tomlkit==0.15.1 python -m unittest discover -s tests."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import tomlkit

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('codex_mcp', ROOT / 'scripts/codex_mcp.py')
mcp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mcp)


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.target = self.base / 'machine'
        self.target.mkdir()
        self.source = self.base / 'mcp.toml'
        self.source.write_text('[mcp_servers.docs]\ncommand = "echo"\nargs = ["one"]\n')

    def run_sync(self, command='sync'):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return mcp.run(command, self.source, self.target)

    def test_first_sync_preserves_local_and_is_idempotent(self):
        config = self.target / 'config.toml'
        original = '# local\nmodel = "local" # keep\n[mcp_servers.private]\nurl = "https://example.com"\n'
        config.write_text(original)
        self.assertEqual(self.run_sync(), 0)
        self.assertTrue(config.read_text().startswith(original))
        before = config.stat().st_mtime_ns
        self.assertEqual(self.run_sync(), 0)
        self.assertEqual(before, config.stat().st_mtime_ns)
        self.assertEqual(self.run_sync('diff'), 0)
        backups = list((self.target / 'backups').glob('*/config.toml'))
        self.assertEqual(backups[0].read_text(), original)
        shutil.copy2(backups[0], config)
        self.assertEqual(config.read_text(), original)

    def test_updates_and_removals_preserve_comments(self):
        self.run_sync()
        config = self.target / 'config.toml'
        config.write_text(config.read_text().replace('args =', '# local note\nargs ='))
        self.source.write_text(self.source.read_text().replace('one', 'two'))
        self.assertEqual(self.run_sync(), 0)
        self.assertIn('# local note', config.read_text())
        self.assertIn('two', config.read_text())
        self.source.write_text('[mcp_servers]\n')
        self.assertEqual(self.run_sync(), 1)
        self.assertIn('docs', tomlkit.parse(config.read_text())['mcp_servers'])
        config.write_text('[mcp_servers]\n')
        self.assertEqual(self.run_sync(), 0)
        self.assertEqual(self.run_sync('diff'), 0)

    def test_conflict_blocks_all_writes(self):
        config = self.target / 'config.toml'
        config.write_text('[mcp_servers.docs]\ncommand = "local"\n')
        self.source.write_text(self.source.read_text() + '[mcp_servers.other]\ncommand = "echo"\n')
        before = config.read_bytes()
        self.assertEqual(self.run_sync(), 1)
        self.assertEqual(config.read_bytes(), before)
        self.assertFalse((self.target / '.config-sync/mcp.toml').exists())

    def test_local_edit_or_deletion_is_conflict(self):
        self.run_sync()
        config = self.target / 'config.toml'
        config.write_text(config.read_text().replace('one', 'local'))
        self.assertEqual(self.run_sync(), 1)
        config.write_text('')
        self.assertEqual(self.run_sync(), 1)

    def test_malformed_or_symlink_config_rejected(self):
        config = self.target / 'config.toml'
        config.write_text('[bad')
        with self.assertRaises(ValueError):
            self.run_sync()
        config.unlink()
        config.symlink_to(self.source)
        with self.assertRaises(ValueError):
            self.run_sync()

    def test_missing_executable_does_not_write(self):
        self.source.write_text('[mcp_servers.docs]\ncommand = "codex-test-missing-executable"\n')
        with self.assertRaises(ValueError):
            self.run_sync()
        self.assertFalse((self.target / 'config.toml').exists())

    def shell(self, command, **env):
        return subprocess.run([str(ROOT / 'codex.sh'), command], cwd=self.base,
                              env={**os.environ, 'TARGET_DIR': str(self.target), **env},
                              text=True, capture_output=True)

    def test_links_conflicts_backup_and_scope(self):
        (self.target / 'AGENTS.md').write_text('local instructions')
        rules = self.target / 'rules'
        rules.mkdir()
        (rules / 'default.rules').write_text('# private')
        self.assertEqual(self.shell('link').returncode, 0)
        self.assertEqual((rules / 'default.rules').read_text(), '# private')
        self.assertEqual(len(list(rules.glob('*.rules'))), 12)
        self.assertFalse((rules / 'github-project.rules').exists())
        self.assertTrue((self.target / 'AGENTS.md').is_symlink())
        self.assertEqual(next((self.target / 'backups').glob('*/AGENTS.md')).read_text(), 'local instructions')
        count = len(list((self.target / 'backups').iterdir()))
        self.assertEqual(self.shell('link').returncode, 0)
        self.assertEqual(len(list((self.target / 'backups').iterdir())), count)
        self.assertEqual(self.shell('backup').returncode, 0)
        self.assertEqual(len(list((self.target / 'backups').iterdir())), count + 1)

    def test_preflight_blocks_partial_links(self):
        (self.target / 'rules').mkdir()
        (self.target / 'rules/git.rules').mkdir()
        self.assertEqual(self.shell('link').returncode, 2)
        self.assertFalse((self.target / 'AGENTS.md').exists())

    def test_target_precedence_and_lock(self):
        other = self.base / 'other'
        self.assertEqual(self.shell('link', CODEX_HOME=str(other)).returncode, 0)
        self.assertFalse(other.exists())
        lock = self.target / '.config-sync/lock'
        lock.mkdir()
        self.assertEqual(self.shell('link').returncode, 2)
        lock.rmdir()
        result = subprocess.run([str(ROOT / 'codex.sh'), 'link'], cwd=self.base,
                                env={k: v for k, v in {**os.environ, 'CODEX_HOME': str(other)}.items() if k != 'TARGET_DIR'},
                                capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertTrue((other / 'AGENTS.md').is_symlink())


if __name__ == '__main__':
    unittest.main()
