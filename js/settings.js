import { app } from "../../scripts/app.js";

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
      onChange: async (newVal) => {
        const response = await fetch("/update-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: newVal }),
        });
        if (response.ok) {
          console.log(newVal ? "HF_TOKEN_FOR_HFD updated in .env file." : "HF_TOKEN_FOR_HFD removed from .env file.");
        } else {
          console.error("Failed to update HF_TOKEN_FOR_HFD.");
        }
      },
    },
    {
      id: "backup.repo_name",
      category: ["Hugging Face downloader", "Backup", "Hugging Face Repo for Backup"],
      name: "Hugging Face Repo for Backup",
      type: "text",
      defaultValue: "",
      tooltip: "Enter the Hugging Face repo name or parsable link.",
      onChange: (newVal, oldVal) => {
        console.log(`Repo changed from \"${oldVal}\" to \"${newVal}\"`);
      },
    },
    {
      id: "backup.file_size_limit",
      category: ["Hugging Face downloader", "Backup", "Limit Individual File Size"],
      name: "Limit Individual File Size (GB)",
      type: "number",
      defaultValue: 5,
      tooltip: "Maximum file size allowed for backup (in GB).",
      attrs: { min: 1, max: 100, step: 1 },
    },
  ],
});
