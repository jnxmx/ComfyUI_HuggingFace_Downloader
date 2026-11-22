import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

for mod_name in ["comfy_api", "comfy_api.latest", "folder_paths", "server", "aiohttp", "aiohttp.web"]:
    sys.modules.setdefault(mod_name, MagicMock())

current_dir = os.path.dirname(os.path.abspath(__file__))
repo_dir = os.path.dirname(current_dir)
parent_dir = os.path.dirname(repo_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

import ComfyUI_HuggingFace_Downloader.db_updater as db_updater


def _make_resp(raw_bytes: bytes):
    cm = MagicMock()
    cm.__enter__.return_value = io.BytesIO(raw_bytes)
    cm.__exit__.return_value = False
    return cm


class TestDbUpdater(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, "popular-models.json")
        self.ver_path = os.path.join(self.tmpdir.name, "db_version.json")

        self.old_db = json.dumps({"version": "2.0.0", "models": {"a.safetensors": {"url": "https://x"}}}).encode("utf-8")
        self.old_sha = hashlib.sha256(self.old_db).hexdigest()
        with open(self.db_path, "wb") as f:
            f.write(self.old_db)
        with open(self.ver_path, "w", encoding="utf-8") as f:
            json.dump({"schema_version": 1, "built_at": "2026-11-18T10:00:00+00:00", "sha256": self.old_sha}, f)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_up_to_date_skips_download(self):
        remote_manifest = json.dumps({
            "schema_version": 1,
            "built_at": "2026-11-18T10:00:00+00:00",
            "sha256": self.old_sha,
        }).encode("utf-8")

        with patch("urllib.request.urlopen", return_value=_make_resp(remote_manifest)) as mock_open:
            res = db_updater.check_and_update_database(db_path=self.db_path, version_path=self.ver_path)
            self.assertFalse(res["updated"])
            self.assertEqual(res["reason"], "up_to_date")
            self.assertEqual(mock_open.call_count, 1)

    def test_newer_remote_downloads_and_replaces_atomically(self):
        new_db = json.dumps({
            "version": "2.0.0",
            "models": {
                "a.safetensors": {"url": "https://x"},
                "b.safetensors": {"url": "https://y"},
            },
        }).encode("utf-8")
        new_sha = hashlib.sha256(new_db).hexdigest()
        remote_manifest = json.dumps({
            "schema_version": 1,
            "built_at": "2026-11-22T20:00:00+00:00",
            "row_count": 2,
            "sha256": new_sha,
        }).encode("utf-8")

        with patch("urllib.request.urlopen", side_effect=[_make_resp(remote_manifest), _make_resp(new_db)]), \
             patch.object(db_updater, "_invalidate_runtime_caches") as mock_inv:
            res = db_updater.check_and_update_database(db_path=self.db_path, version_path=self.ver_path)
            self.assertTrue(res["updated"])
            self.assertEqual(res["row_count"], 2)
            mock_inv.assert_called_once()

        with open(self.db_path, "rb") as f:
            self.assertEqual(f.read(), new_db)
        with open(self.ver_path, "r", encoding="utf-8") as f:
            self.assertEqual(json.load(f)["sha256"], new_sha)

    def test_older_remote_does_not_overwrite_newer_local(self):
        older_remote = json.dumps({
            "schema_version": 1,
            "built_at": "2026-11-10T10:00:00+00:00",
            "sha256": "deadbeef" * 8,
        }).encode("utf-8")

        with patch("urllib.request.urlopen", return_value=_make_resp(older_remote)) as mock_open:
            res = db_updater.check_and_update_database(db_path=self.db_path, version_path=self.ver_path)
            self.assertFalse(res["updated"])
            self.assertEqual(res["reason"], "up_to_date")
            self.assertEqual(mock_open.call_count, 1)

    def test_sha_mismatch_aborts_cleanly(self):
        new_db = json.dumps({"models": {"b.safetensors": {}}}).encode("utf-8")
        remote_manifest = json.dumps({
            "schema_version": 1,
            "built_at": "2026-11-22T20:00:00+00:00",
            "sha256": "0" * 64,
        }).encode("utf-8")

        with patch("urllib.request.urlopen", side_effect=[_make_resp(remote_manifest), _make_resp(new_db)]):
            res = db_updater.check_and_update_database(db_path=self.db_path, version_path=self.ver_path)
            self.assertFalse(res["updated"])
            self.assertEqual(res["reason"], "download_failed")

        with open(self.db_path, "rb") as f:
            self.assertEqual(f.read(), self.old_db)
        self.assertFalse(os.path.exists(f"{self.db_path}.tmp"))


if __name__ == "__main__":
    unittest.main()
