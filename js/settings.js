import { app } from "../../../scripts/app.js";

app.registerExtension({
  name: "ComfyUI_HuggingFace_Downloader",
  settings: [
    {
      id: "downloader.hf_token",
      category: ["Hugging Face Download & Backup", "Tokens", "Hugging Face Token"],
      name: "Hugging Face Token",
      type: "password",
      defaultValue: "",
      tooltip: "Enter your Hugging Face token to enable downloads from gated repos.",
    },
    {
      id: "downloader.auto_open_missing_models_on_run",
      category: ["Hugging Face Download & Backup", "Auto download", "Auto-open on workflow-open and Run missing-model checks"],
      name: "Auto-open on workflow-open and Run missing-model checks",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "When ComfyUI detects missing models while opening a workflow or during Run validation, automatically open Auto-download and clear native missing-model highlights.",
      onChange: (newValue) => {
        console.log(`[HF Downloader] Auto-open on workflow-open and Run missing-model checks: ${Boolean(newValue)}`);
      },
    },
    {
      id: "downloader.disable_missing_model_red_frames",
      category: ["Hugging Face Download & Backup", "Appearance", "Disable missing models red frames"],
      name: "Disable missing models red frames",
      type: "boolean",
      defaultValue: false,
      tooltip: "If enabled, red error frames around nodes caused by missing model validations will be automatically cleared.",
    },
    {
      id: "downloader.top_menu_button_style",
      category: ["Hugging Face Download & Backup", "Appearance", "Top menu button"],
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
      category: ["Hugging Face Download & Backup", "Backup", "Hugging Face Repo for Backup"],
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
      category: ["Hugging Face Download & Backup", "Backup", "Limit Individual File Size"],
      name: "Limit Individual File Size (GB)",
      type: "number",
      defaultValue: 5,
      tooltip: "Maximum file size allowed for backup (in GB).",
      attrs: { min: 1, max: 100, step: 1 },
    },
  ],
});

// Dynamic widget visibility for Hugging Face Downloaders
app.registerExtension({
  name: "ComfyUI_HuggingFace_Downloader.DynamicVisibility",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "Hugging Face Download Model" && nodeData.name !== "Hugging Face Download Folder") {
      return;
    }

    const visibilityConditions = {};

    const processInputs = (inputs) => {
      if (!inputs) return;
      for (const [inputName, inputConfig] of Object.entries(inputs)) {
        if (Array.isArray(inputConfig) && inputConfig[1] && inputConfig[1].visible_if) {
          visibilityConditions[inputName] = inputConfig[1].visible_if;
        }
      }
    };

    processInputs(nodeData.input?.required);
    processInputs(nodeData.input?.optional);

    if (Object.keys(visibilityConditions).length > 0) {
      const onNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function() {
        const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
        const originalTypes = {};

        const updateVisibility = () => {
          let changed = false;
          for (const [targetName, condition] of Object.entries(visibilityConditions)) {
            const targetWidget = this.widgets.find(w => w.name === targetName);
            if (!targetWidget) continue;

            if (!(targetName in originalTypes)) {
              originalTypes[targetName] = targetWidget.type;
            }

            let allConditionsMet = true;
            for (const [condWidgetName, condValue] of Object.entries(condition)) {
              const condWidget = this.widgets.find(w => w.name === condWidgetName);
              if (!condWidget) {
                allConditionsMet = false;
                break;
              }

              if (condWidget.value !== condValue) {
                allConditionsMet = false;
                break;
              }
            }

            const newType = allConditionsMet ? originalTypes[targetName] : "hidden";
            if (targetWidget.type !== newType) {
              targetWidget.type = newType;
              changed = true;
            }
          }

          if (changed) {
            this.setSize([this.size[0], this.computeSize()[1]]);
            app.graph.setDirtyCanvas(true);
          }
        };

        // Bind callbacks to the trigger widgets
        for (const condition of Object.values(visibilityConditions)) {
          for (const condWidgetName of Object.keys(condition)) {
            const condWidget = this.widgets.find(w => w.name === condWidgetName);
            if (condWidget && !condWidget._visibilityHooked) {
              condWidget._visibilityHooked = true;
              const originalCallback = condWidget.callback;
              condWidget.callback = function() {
                const cbResult = originalCallback ? originalCallback.apply(this, arguments) : undefined;
                updateVisibility();
                return cbResult;
              };
            }
          }
        }

        // Initial update
        updateVisibility();

        // Hook configure
        const onConfigure = this.onConfigure;
        this.onConfigure = function() {
          const confResult = onConfigure ? onConfigure.apply(this, arguments) : undefined;
          updateVisibility();
          return confResult;
        };

        return r;
      };
    }
  }
});

