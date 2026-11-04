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
import ComfyUI_HuggingFace_Downloader.web_api as web_api


class TestGatedRepoErrors(unittest.TestCase):

    def test_gated_error_with_token_includes_repo_link_and_agreement(self):
        """When user has a token but hasn't agreed on HF, format_download_error directs to agree to license."""
        raw_error = (
            "Cannot access gated repo for url https://huggingface.co/api/models/black-forest-labs/flux-3-image-klein-comfy. "
            "Access to model black-forest-labs/flux-3-image-klein-comfy is restricted and you are not in the authorized list. "
            "Visit https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy to ask for access."
        )
        msg = dl.format_download_error(raw_error, "black-forest-labs/flux-3-image-klein-comfy", token="hf_testtoken")

        self.assertIn("https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy", msg)
        self.assertIn("agreeing to its license", msg.lower())
        self.assertIn("license agreement", msg.lower())
        # Should not falsely claim token is missing or invalid when token is present
        self.assertNotIn("Invalid or missing Hugging Face token", msg)

    def test_gated_error_without_token_instructs_both_agreement_and_token(self):
        """When user has no token on a gated repo, format_download_error instructs agreement AND adding token."""
        raw_error = "Access to model black-forest-labs/flux-3-image-klein-comfy is restricted. You must have access to it and be authenticated to access it. 401 Client Error."
        msg = dl.format_download_error(raw_error, "black-forest-labs/flux-3-image-klein-comfy", token=None)

        self.assertIn("https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy", msg)
        self.assertIn("license", msg.lower())
        self.assertIn("add your hugging face token", msg.lower())

    def test_gated_takes_precedence_over_401(self):
        """Even if the error string contains '401' (e.g. from fallback stages), gated detection must win."""
        raw_error = "All download stages failed. Stage 1: Cannot access gated repo. Stage 2: 401 Client Error. Stage 3: 401 Unauthorized."
        msg = dl.format_download_error(raw_error, "black-forest-labs/flux-3-image-klein-comfy", token="hf_existing")

        self.assertIn("https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy", msg)
        self.assertIn("license", msg.lower())
        self.assertNotIn("Invalid or missing Hugging Face token", msg)

    def test_http_403_treated_as_gated_on_huggingface(self):
        """HTTP 403 Forbidden on Hugging Face indicates agreement/permission required."""
        raw_error = "403 Client Error: Forbidden for url: https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/resolve/main/flux3.safetensors"
        msg = dl.format_download_error(raw_error, "black-forest-labs/flux-3-image-klein-comfy", token="hf_mytoken")

        self.assertIn("https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy", msg)
        self.assertIn("license", msg.lower())

    def test_generic_401_without_gated_markers(self):
        """Genuine invalid token on non-gated repo shows token configuration message."""
        raw_error = "401 Client Error: Invalid credentials."
        msg = dl.format_download_error(raw_error, "some-org/open-model", token=None)

        self.assertIn("Invalid or missing Hugging Face token", msg)

    def test_classify_download_failure_gated_repo(self):
        """_classify_download_failure in web_api sets error_code to gated_repo and extracts repo url."""
        error_msg = (
            "The repository 'black-forest-labs/flux-3-image-klein-comfy' is gated and requires agreeing to its license.\n"
            "Please visit https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy to accept the model license agreement."
        )
        item = {
            "filename": "flux3.safetensors",
            "url": "https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/resolve/main/flux3.safetensors",
            "folder": "checkpoints"
        }
        res = web_api._classify_download_failure(item, error_msg)

        self.assertEqual(res.get("error_code"), "gated_repo")
        self.assertEqual(res.get("action_hint"), "accept_model_agreement")
        self.assertEqual(res.get("repo_id"), "black-forest-labs/flux-3-image-klein-comfy")
        self.assertEqual(res.get("repo_url"), "https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy")

    def test_extract_repo_id_from_error_quotes(self):
        """_extract_repo_id_from_error parses repo name from repository 'owner/name'."""
        msg = "The repository 'black-forest-labs/flux-3-image-klein-comfy' is gated."
        repo_id = web_api._extract_repo_id_from_error(msg)
        self.assertEqual(repo_id, "black-forest-labs/flux-3-image-klein-comfy")


if __name__ == "__main__":
    unittest.main()
