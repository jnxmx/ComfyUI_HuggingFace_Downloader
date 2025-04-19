import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "ComfyUI_HuggingFace_Downloader",
    settings: [
        {
            id: "downloader.hf_token",
            category: ['Hugging Face downloader', 'Tokens', 'Hugging Face Token'],
            name: "Hugging Face Token",
            type: "password",
            defaultValue: "",
            tooltip: "Enter your Hugging Face token to enable downloads from gated repos",
            onChange: (newVal, oldVal) => {
                console.log(`Hugging Face token changed.`);
                if (newVal) {
                    // Set the HF_TOKEN environment variable
                    try {
                        window.process.env.HF_TOKEN = newVal;
                        console.log("HF_TOKEN environment variable updated.");
                    } catch (error) {
                        console.error("Failed to update HF_TOKEN environment variable:", error);
                    }
                }
            },
        },
        {
            id: "backup.folders_to_backup",
            category: ['Hugging Face downloader', 'Backup', 'Folders to Backup'],
            name: "Folders to Backup",
            type: () => {
                return $el("tr.folders-to-backup-row", {
                    children: [
                        $el("td", {
                            child: "Folders to Backup",
                        }),
                        $el("td", {
                            child: $el("textarea.folders-to-backup-textarea", {
                                attrs: {
                                    rows: 5,
                                    cols: 50,
                                    placeholder: "Enter folders to backup, one per line...",
                                },
                                value: app.extensionManager.setting.get("backup.folders_to_backup"),
                                events: {
                                    input: (e) => {
                                        app.extensionManager.setting.set("backup.folders_to_backup", e.target.value);
                                    },
                                },
                            }),
                        }),
                    ],
                });
            },
        },
        {
            id: "backup.repo_name",
            category: ['Hugging Face downloader', 'Backup', 'Hugging Face Repo for Backup'],
            name: "Hugging Face Repo for Backup",
            type: "text",
            defaultValue: "",
            tooltip: "Enter the Hugging Face repo name or parsable link.",
            onChange: (newVal, oldVal) => {
                console.log(`Hugging Face repo changed from ${oldVal} to ${newVal}`);
            },
        },
        {
            id: "backup.file_size_limit",
            category: ['Hugging Face downloader', 'Backup', 'Limit Individual File Size'],
            name: "Limit Individual File Size (GB)",
            type: "number",
            defaultValue: 5,
            tooltip: "Set the maximum size for individual files in GB.",
            attrs: {
                min: 1,
                max: 50,
                step: 1,
            },
        },
        {
            id: "backup.backup_button",
            category: ['Hugging Face downloader', 'Backup', 'Actions'],
            name: "Backup to Hugging Face (overwrite)",
            type: () => {
                return $el("tr.backup-comfyui-settings-row", {
                    children: [
                        $el("td", {
                            child: "Backup to Hugging Face (overwrite)",
                        }),
                        $el("td", {
                            child: $el('button.backup-button.-blue[text="Backup"]', {
                                events: {
                                    click: async () => {
                                        console.log("Backup to Hugging Face initiated.");
                                        try {
                                            const folders = app.extensionManager.setting.get("backup.folders_to_backup").split("\n");
                                            const repo = app.extensionManager.setting.get("backup.repo_name");
                                            const sizeLimit = app.extensionManager.setting.get("backup.file_size_limit");
                                            const { backup_to_huggingface } = await import("./backup.py");
                                            await backup_to_huggingface(repo, folders, sizeLimit);
                                        } catch (error) {
                                            console.error("Backup failed:", error);
                                        }
                                    },
                                },
                            }),
                        }),
                    ],
                });
            },
        },
        {
            id: "backup.restore_button",
            category: ['Hugging Face downloader', 'Backup', 'Actions'],
            name: "Restore from Hugging Face",
            type: () => {
                return $el("tr.restore-comfyui-settings-row", {
                    children: [
                        $el("td", {
                            child: "Restore from Hugging Face",
                        }),
                        $el("td", {
                            child: $el('button.restore-button.-blue[text="Restore"]', {
                                events: {
                                    click: async () => {
                                        console.log("Restore from Hugging Face initiated.");
                                        try {
                                            const repo = app.extensionManager.setting.get("backup.repo_name");
                                            const { restore_from_huggingface } = await import("./backup.py");
                                            await restore_from_huggingface(repo);
                                        } catch (error) {
                                            console.error("Restore failed:", error);
                                        }
                                    },
                                },
                            }),
                        }),
                    ],
                });
            },
        },
    ],
});
