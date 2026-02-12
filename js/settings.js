import { app } from "../../../scripts/app.js";

app.registerExtension({
  name: "ComfyUI_HuggingFace_Downloader",
  settings: [
    {
      id: "downloader.hf_token",
      category: ["Hugging Face downloader", "Tokens", "Hugging Face Token"],
      name: "Hugging Face Token",
      type: "password",
      defaultValue: "",
      tooltip: "Enter your Hugging Face token to enable downloads from gated repos.",
    },
    {
      id: "downloader.model_library_backend_enabled",
      category: ["Hugging Face downloader", "Model Library", "Use as Model Library backend"],
      name: "Use as Model Library backend",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "Route native Model Library Asset API calls through this node pack backend (HuggingFace-only catalog + local installed-model discovery).",
      onChange: (newValue) => {
        console.log(`[HF Downloader] Model Library backend enabled: ${Boolean(newValue)}`);
      },
    },
    {
      id: "downloader.auto_open_missing_models_on_run",
      category: ["Hugging Face downloader", "Auto download", "Auto-open on native missing-models dialog"],
      name: "Auto-open on native missing-models dialog",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "After pressing Run, if native ComfyUI opens the missing-models dialog, automatically open Auto-download.",
      onChange: (newValue) => {
        console.log(`[HF Downloader] Auto-open on native missing-models dialog: ${Boolean(newValue)}`);
      },
    },
    {
      id: "downloaderbackup.repo_name",
      category: ["Hugging Face downloader", "Backup", "Hugging Face Repo for Backup"],
      name: "Hugging Face Repo for Backup",
      type: "text",
      defaultValue: "",
      tooltip: "Enter the Hugging Face repo name or parsable link.",
      onChange: (newValue, oldValue) => {
        console.log(`Repo changed from "${oldValue}" to "${newValue}"`);
      },
    },
    {
      id: "downloaderbackup.file_size_limit",
      category: ["Hugging Face downloader", "Backup", "Limit Individual File Size"],
      name: "Limit Individual File Size (GB)",
      type: "number",
      defaultValue: 5,
      tooltip: "Maximum file size allowed for backup (in GB).",
      attrs: { min: 1, max: 100, step: 1 },
    },
  ],
});
