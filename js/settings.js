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
    {
      id: "downloader.open_config",
      category: ["Hugging Face downloader", "Actions"],
      name: "Run Backup",
      defaultValue: null,
      type: () => {
        return $el("tr.hfd-settings-row", {
          children: [
            $el("td", {
              child: "<div>Run Backup to Hugging Face Repo</div>",
            }),
            $el("td", {
              child: $el("button", {
                class: "hfd-button",
                textContent: "Run Backup",
                onclick: async () => {
                  try {
                    const response = await fetch("/run-backup", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        repoName: app.settings.get("backup.repo_name"),
                      }),
                    });
                    const result = await response.json();
                    alert(result.message || "Backup completed successfully.");
                  } catch (error) {
                    console.error("Backup failed:", error);
                    alert("Backup failed. Check the console for details.");
                  }
                },
                style: {
                  fontSize: "14px",
                  display: "block",
                  marginTop: "5px",
                },
              }),
            }),
          ],
        });
      },
    }
  ],
});
