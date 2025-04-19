import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "ComfyUI_HuggingFace_Downloader",
    settings: [
        {
            id: "downloader.hf_token",
            name: "Hugging Face Token",
            type: "text",
            defaultValue: "",
            tooltip: "Enter your Hugging Face token",
            onChange: (newVal, oldVal) => {
                console.log(`Hugging Face token changed from ${oldVal} to ${newVal}`);
                try {
                    if (newVal) {
                        // Set the HF_TOKEN environment variable to the new value
                        window.process.env.HF_TOKEN = newVal;
                        console.log("HF_TOKEN environment variable updated.");
                    } else if (oldVal) {
                        // If the new value is empty, retain the old value
                        window.process.env.HF_TOKEN = oldVal;
                        console.log("HF_TOKEN environment variable retained.");
                    } else {
                        // If both new and old values are empty, use the existing environment variable
                        console.log("HF_TOKEN environment variable remains unchanged.");
                    }
                } catch (error) {
                    console.error("Failed to update HF_TOKEN environment variable:", error);
                }
            },
        },
    ],
});
