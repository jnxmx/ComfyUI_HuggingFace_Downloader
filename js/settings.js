import { app } from "../../scripts/app.js";

const FORCE_MODEL_LIBRARY_SETTING_ID = "Comfy.Assets.UseAssetAPI";
const FORCE_MODEL_LIBRARY_MAX_ATTEMPTS = 40;
const FORCE_MODEL_LIBRARY_RETRY_MS = 500;

app.registerExtension({
  name: "ComfyUI_HuggingFace_Downloader",
  setup() {
    let attempts = 0;
    let timer = null;
    let modelLibraryLockListenerAttached = false;

    const stopRetryLoop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const forceEnableModelLibraryAssetView = async () => {
      attempts += 1;

      try {
        const settingsUi = app?.ui?.settings;
        if (!settingsUi) {
          if (attempts >= FORCE_MODEL_LIBRARY_MAX_ATTEMPTS) {
            stopRetryLoop();
          }
          return;
        }

        if (!modelLibraryLockListenerAttached) {
          settingsUi.addEventListener(
            `${FORCE_MODEL_LIBRARY_SETTING_ID}.change`,
            (event) => {
              const newValue = event?.detail?.value;
              if (newValue !== false) {
                return;
              }
              if (typeof settingsUi.setSettingValueAsync === "function") {
                void settingsUi.setSettingValueAsync(
                  FORCE_MODEL_LIBRARY_SETTING_ID,
                  true
                );
              } else if (typeof settingsUi.setSettingValue === "function") {
                settingsUi.setSettingValue(FORCE_MODEL_LIBRARY_SETTING_ID, true);
              }
              console.log(
                "[HF Downloader] Re-enabled Comfy.Assets.UseAssetAPI after attempted disable."
              );
            }
          );
          modelLibraryLockListenerAttached = true;
        }

        const currentValue = settingsUi.getSettingValue?.(
          FORCE_MODEL_LIBRARY_SETTING_ID
        );
        if (currentValue === true) {
          stopRetryLoop();
          return;
        }

        if (typeof settingsUi.setSettingValueAsync === "function") {
          await settingsUi.setSettingValueAsync(
            FORCE_MODEL_LIBRARY_SETTING_ID,
            true
          );
        } else if (typeof settingsUi.setSettingValue === "function") {
          settingsUi.setSettingValue(FORCE_MODEL_LIBRARY_SETTING_ID, true);
        } else {
          if (attempts >= FORCE_MODEL_LIBRARY_MAX_ATTEMPTS) {
            stopRetryLoop();
          }
          return;
        }

        console.log(
          "[HF Downloader] Forced Comfy.Assets.UseAssetAPI=true for model library."
        );

        stopRetryLoop();
      } catch (error) {
        if (attempts >= FORCE_MODEL_LIBRARY_MAX_ATTEMPTS) {
          console.warn(
            "[HF Downloader] Failed to force model library asset view:",
            error
          );
          stopRetryLoop();
        }
      }
    };

    void forceEnableModelLibraryAssetView();
    timer = setInterval(() => {
      void forceEnableModelLibraryAssetView();
    }, FORCE_MODEL_LIBRARY_RETRY_MS);
  },
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
      id: "downloaderbackup.repo_name",
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
      id: "downloaderbackup.file_size_limit",
      category: ["Hugging Face downloader", "Backup", "Limit Individual File Size"],
      name: "Limit Individual File Size (GB)",
      type: "number",
      defaultValue: 5,
      tooltip: "Maximum file size allowed for backup (in GB).",
      attrs: { min: 1, max: 100, step: 1 },
    }
  ],
});
