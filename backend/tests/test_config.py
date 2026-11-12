"""Configuration stays anchored to the checkout after moving to a src layout."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from harness.core.config import load_config


class ConfigTests(unittest.TestCase):
    def test_default_root_is_independent_of_launch_directory(self):
        checkout = Path(__file__).resolve().parents[2]
        with patch.dict(os.environ, {}, clear=True):
            with patch('pathlib.Path.cwd', return_value=Path(tempfile.gettempdir())), patch('pathlib.Path.exists', return_value=False):
                config = load_config()
        self.assertEqual(config.root, checkout)
        # No alternate cwd-based state directory is silently created.
        self.assertEqual(config.data_dir.parent, checkout)

    def test_explicit_root_and_frontend_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / '.dev.vars').write_text(
                'SERVE_FRONTEND=false\nFRONTEND_DIST_DIR=custom-ui\n', encoding='utf-8')
            with patch.dict(os.environ, {}, clear=True):
                config = load_config(root)
            self.assertFalse(config.serve_frontend)
            self.assertEqual(config.frontend_dir, root / 'custom-ui')
            self.assertEqual(config.data_dir, root / '.assistant')

    def test_root_override_and_default_frontend_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            with patch.dict(os.environ, {'HARNESS_ROOT': str(root)}, clear=True):
                config = load_config()
            self.assertEqual(config.root, root)
            self.assertEqual(config.frontend_dir, root / 'frontend' / 'dist')
