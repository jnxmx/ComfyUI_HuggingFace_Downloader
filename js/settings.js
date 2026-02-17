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
      id: "downloader.auto_open_missing_models_on_run",
      category: ["Hugging Face downloader", "Auto download", "Auto-open on native run model checks"],
      name: "Auto-open on native run model checks",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "After pressing Run, if native ComfyUI opens missing-models or reports model value-not-in-list validation errors, automatically open Auto-download.",
      onChange: (newValue) => {
        console.log(`[HF Downloader] Auto-open on native run model checks: ${Boolean(newValue)}`);
      },
    },
    {
      id: "downloader.model_explorer_enabled",
      category: ["Hugging Face downloader", "Model Explorer", "Enable Model Explorer"],
      name: "Enable Model Explorer",
      type: "boolean",
      defaultValue: false,
      experimental: true,
      icon: "beaker",
      tooltip:
        "Enable the new Model Explorer UI backed by unified popular-models.json with verified cloud/manager rows.",
      onChange: (newValue) => {
        console.log(`[HF Downloader] Model Explorer enabled: ${Boolean(newValue)}`);
      },
    },
    {
      id: "downloader.top_menu_button_style",
      category: ["Hugging Face downloader", "Appearance", "Top menu button"],
      name: "Top menu button",
      type: "combo",
      defaultValue: "default",
      tooltip: "Choose the Hugging Face top menu button style.",
      options: [
        { value: "default", text: "Default" },
        { value: "yellow", text: "Yellow" },
        { value: "disabled", text: "Disabled" }
      ]
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
