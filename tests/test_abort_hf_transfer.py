import os
import sys
import unittest
from unittest.mock import MagicMock

# Ensure mocks for ComfyUI environment
for mod_name in ["comfy_api", "comfy_api.latest", "folder_paths", "server", "aiohttp", "aiohttp.web"]:
    sys.modules.setdefault(mod_name, MagicMock())

current_dir = os.path.dirname(os.path.abspath(__file__))
repo_dir = os.path.dirname(current_dir)
parent_dir = os.path.dirname(repo_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

import ComfyUI_HuggingFace_Downloader.downloader as dl


class TestAbortHfTransfer(unittest.TestCase):
    def test_abort_hf_transfer_does_not_leave_closed_httpx_client_cached(self):
        """abort_hf_transfer() must close the active session without caching a closed httpx.Client."""
        from huggingface_hub.utils._http import get_session

        first_client = get_session()
        dl.abort_hf_transfer()
        second_client = get_session()

        self.assertIsNot(first_client, second_client)
        self.assertFalse(getattr(second_client, "is_closed", False))

        # Calling abort_hf_transfer() again (e.g. cancel + repo cleanup) must still leave next client open
        dl.abort_hf_transfer()
        third_client = get_session()
        self.assertFalse(getattr(third_client, "is_closed", False))


if __name__ == "__main__":
    unittest.main()
