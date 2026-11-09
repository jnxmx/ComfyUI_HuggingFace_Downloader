import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

# Ensure ComfyUI and server environment mocks are in place for standalone testing
for mod_name in ["comfy_api", "comfy_api.latest", "folder_paths", "server", "aiohttp", "aiohttp.web"]:
    sys.modules.setdefault(mod_name, MagicMock())

# Add the parent directory containing the repo directory so package imports work
current_dir = os.path.dirname(os.path.abspath(__file__))
repo_dir = os.path.dirname(current_dir)
parent_dir = os.path.dirname(repo_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

import ComfyUI_HuggingFace_Downloader.downloader as dl


def _write(path, data=b"model-bytes"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


class TestMoveFileIntoPlace(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = os.path.join(self.tmp.name, "cache", "blob")
        self.dst = os.path.join(self.tmp.name, "models", "vae", "model.safetensors")
        _write(self.src, b"x" * 1000)
        os.makedirs(os.path.dirname(self.dst))

    def tearDown(self):
        self.tmp.cleanup()

    def test_same_filesystem_is_a_rename(self):
        inode = os.stat(self.src).st_ino
        self.assertTrue(dl._move_file_into_place(self.src, self.dst))
        self.assertFalse(os.path.exists(self.src))
        self.assertEqual(os.stat(self.dst).st_ino, inode)  # same file, no data copied

    def test_replaces_existing_placeholder(self):
        _write(self.dst, b"")  # the empty placeholder queue_download creates
        self.assertTrue(dl._move_file_into_place(self.src, self.dst))
        self.assertEqual(os.path.getsize(self.dst), 1000)

    def test_falls_back_to_copy_when_rename_refused(self):
        # Simulates a cross-drive move (EXDEV) or a locked file on Windows.
        with patch.object(dl.os, "replace", side_effect=OSError(18, "Invalid cross-device link")):
            self.assertFalse(dl._move_file_into_place(self.src, self.dst))
        self.assertFalse(os.path.exists(self.src))
        with open(self.dst, "rb") as f:
            self.assertEqual(f.read(), b"x" * 1000)

    def test_copy_fallback_can_be_cancelled(self):
        with patch.object(dl.os, "replace", side_effect=OSError(18, "Invalid cross-device link")):
            with self.assertRaises(InterruptedError):
                dl._move_file_into_place(self.src, self.dst, cancel_check=lambda: True)
        self.assertTrue(os.path.exists(self.src))  # source kept so nothing is lost


class TestRemoveCacheEntry(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = os.path.join(self.tmp.name, "hub")
        self.repo = os.path.join(self.cache, "models--Org--Repo")
        self.rev = os.path.join(self.repo, "snapshots", "abc123")
        patcher = patch.object(dl, "_get_hf_cache_dir", return_value=self.cache)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def _symlinked_entry(self, repo_path, blob_name):
        """Linux/macOS layout: snapshots/<rev>/<path> is a relative symlink into blobs/."""
        blob = os.path.join(self.repo, "blobs", blob_name)
        _write(blob)
        link = os.path.join(self.rev, *repo_path.split("/"))
        os.makedirs(os.path.dirname(link), exist_ok=True)
        os.symlink(os.path.relpath(blob, os.path.dirname(link)), link)
        return link, blob

    def test_removes_link_and_repo_when_last_file(self):
        link, blob = self._symlinked_entry("split_files/vae/wan_vae.safetensors", "b1")
        _write(os.path.join(self.repo, "refs", "main"), b"abc123")
        os.remove(os.path.realpath(link))  # the blob was moved out into models/
        dl._remove_cache_entry(link)
        self.assertFalse(os.path.lexists(link))
        self.assertFalse(os.path.exists(self.repo))

    def test_keeps_other_cached_files_of_the_repo(self):
        link, blob = self._symlinked_entry("split_files/vae/wan_vae.safetensors", "b1")
        other_link, other_blob = self._symlinked_entry("split_files/text_encoders/t5.safetensors", "b2")
        os.remove(blob)
        dl._remove_cache_entry(link)
        self.assertFalse(os.path.lexists(link))
        self.assertFalse(os.path.exists(os.path.join(self.rev, "split_files", "vae")))  # emptied folder removed
        self.assertTrue(os.path.exists(other_link))  # untouched
        self.assertTrue(os.path.exists(other_blob))

    def test_windows_layout_without_symlinks(self):
        # Without symlink support the real file sits in snapshots/ and was itself moved out.
        path = os.path.join(self.rev, "model.safetensors")
        os.makedirs(self.rev)
        dl._remove_cache_entry(path)  # file already gone; must not raise
        self.assertFalse(os.path.exists(self.repo))

    def test_repo_with_its_own_snapshots_folder(self):
        link, blob = self._symlinked_entry("snapshots/model.safetensors", "b1")
        other_link, _ = self._symlinked_entry("vae/v.safetensors", "b2")
        os.remove(blob)
        dl._remove_cache_entry(link)
        self.assertFalse(os.path.lexists(link))
        self.assertTrue(os.path.exists(other_link))
        self.assertTrue(os.path.isdir(os.path.join(self.repo, "snapshots", "abc123")))

    def test_ignores_paths_outside_the_cache(self):
        outside = os.path.join(self.tmp.name, "comfy_temp", "model.safetensors")
        _write(outside)
        dl._remove_cache_entry(outside)
        self.assertTrue(os.path.exists(outside))


if __name__ == "__main__":
    unittest.main()
