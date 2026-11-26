import os
import sys
import unittest
from unittest.mock import MagicMock, patch

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
        self.assertIn("license", res.get("action_message", "").lower())

    def test_classify_download_failure_needs_token_flag(self):
        """_classify_download_failure sets needs_token accurately from token/message."""
        item = {
            "filename": "ltx.safetensors",
            "url": "https://huggingface.co/Lightricks/LTX-2.5/resolve/main/ltx.safetensors",
            "folder": "diffusion_models",
        }
        with patch.object(web_api, "get_token", return_value="hf_valid"):
            res_with_token = web_api._classify_download_failure(
                item,
                "The repository 'Lightricks/LTX-2.5' is gated and requires agreeing to its license.",
            )
        self.assertFalse(res_with_token.get("needs_token"))
        self.assertEqual(
            res_with_token.get("action_message"),
            "Accept the license on Hugging Face, then retry.",
        )

        with patch.object(web_api, "get_token", return_value=None):
            res_no_token = web_api._classify_download_failure(
                item,
                "The repository 'Lightricks/LTX-2.5' is gated. Add your Hugging Face token.",
            )
        self.assertTrue(res_no_token.get("needs_token"))
        self.assertEqual(
            res_no_token.get("action_message"),
            "Add a Hugging Face token in Settings and accept the model license.",
        )

    def test_extract_repo_id_from_error_quotes(self):
        """_extract_repo_id_from_error parses repo name from repository 'owner/name'."""
        msg = "The repository 'black-forest-labs/flux-3-image-klein-comfy' is gated."
        repo_id = web_api._extract_repo_id_from_error(msg)
        self.assertEqual(repo_id, "black-forest-labs/flux-3-image-klein-comfy")

    def test_check_hf_repo_access_accessible_and_cached(self):
        """check_hf_repo_access caches ok results and bypasses cache on force_refresh."""
        dl._HF_ACCESS_CACHE.clear()
        mock_api = MagicMock()
        with patch.object(dl, "HfApi", return_value=mock_api):
            res1 = dl.check_hf_repo_access("Lightricks/LTX-2.5", token="hf_tok")
            res2 = dl.check_hf_repo_access("Lightricks/LTX-2.5", token="hf_tok")
            res3 = dl.check_hf_repo_access("Lightricks/LTX-2.5", token="hf_tok", force_refresh=True)

        self.assertTrue(res1["accessible"])
        self.assertFalse(res1["gated"])
        self.assertEqual(res1["status"], "ok")
        self.assertEqual(res2, res1)
        self.assertEqual(res3, res1)
        self.assertEqual(mock_api.auth_check.call_count, 2)

    def test_check_hf_repo_access_gated_with_and_without_token(self):
        """check_hf_repo_access reports gated=True and needs_token based on token presence."""
        from huggingface_hub.utils import GatedRepoError

        dl._HF_ACCESS_CACHE.clear()
        mock_resp = MagicMock()
        mock_resp.status_code = 403
        mock_resp.headers = {}
        gated_err = GatedRepoError("Cannot access gated repo", response=mock_resp)

        mock_api = MagicMock()
        mock_api.auth_check.side_effect = gated_err

        with patch.object(dl, "HfApi", return_value=mock_api):
            res_with_tok = dl.check_hf_repo_access("Lightricks/LTX-2.5", token="hf_tok")
            res_no_tok = dl.check_hf_repo_access("Lightricks/LTX-2.5", token="")

        self.assertFalse(res_with_tok["accessible"])
        self.assertTrue(res_with_tok["gated"])
        self.assertFalse(res_with_tok["needs_token"])
        self.assertEqual(res_with_tok["error_code"], "gated_repo")
        self.assertEqual(res_with_tok["repo_url"], "https://huggingface.co/Lightricks/LTX-2.5")

        self.assertFalse(res_no_tok["accessible"])
        self.assertTrue(res_no_tok["gated"])
        self.assertTrue(res_no_tok["needs_token"])

    def test_check_hf_repo_access_public_repo_with_restricted_token(self):
        """401 with token retries unauthenticated and marks public repos accessible."""
        dl._HF_ACCESS_CACHE.clear()
        mock_api = MagicMock()
        mock_api.auth_check.side_effect = [
            RuntimeError("401 Client Error: Invalid credentials"),
            None,
        ]

        with patch.object(dl, "HfApi", return_value=mock_api):
            res = dl.check_hf_repo_access("some-org/public-model", token="hf_restricted")

        self.assertTrue(res["accessible"])
        self.assertFalse(res["gated"])
        self.assertEqual(res["status"], "ok")
        self.assertEqual(mock_api.auth_check.call_count, 2)

    def test_check_hf_repo_access_transient_error_fails_open_without_caching(self):
        """Transient network errors fail open (accessible=True, status=unknown) without caching."""
        dl._HF_ACCESS_CACHE.clear()
        mock_api = MagicMock()
        mock_api.auth_check.side_effect = TimeoutError("Connection timed out")

        with patch.object(dl, "HfApi", return_value=mock_api):
            res1 = dl.check_hf_repo_access("some-org/model", token="hf_tok")
            res2 = dl.check_hf_repo_access("some-org/model", token="hf_tok")

        self.assertTrue(res1["accessible"])
        self.assertFalse(res1["gated"])
        self.assertEqual(res1["status"], "unknown")
        self.assertEqual(res2["status"], "unknown")
        self.assertEqual(mock_api.auth_check.call_count, 2)


if __name__ == "__main__":
    unittest.main()
