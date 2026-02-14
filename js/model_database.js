import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const MAX_Z_INDEX = 10001;

// Reuse styles or create new ones? 
// We should match the style of auto_download.js if possible.
// But this is a full dialog.

class ModelDatabaseDialog {
    constructor() {
        this.element = null;
        this.categories = [];
        this.models = [];
        this.svdqCompatibility = "unknown";
        this.filters = {
            category: "diffusion_models",
            base_model: "any",
            type: "any",
            precision: "any",
            search: ""
        };
        this.abortController = null;
    }

    async show() {
        if (this.element) {
            this.element.style.display = "flex";
            return;
        }

        // 1. Fetch initial data
        await this.fetchCategories();
        await this.fetchSVDQCompatibility();
        // Set default category if available, or keep default
        if (this.categories.length > 0 && !this.categories.includes(this.filters.category)) {
            // Try to find a good default or just pick first
            if (this.categories.includes("diffusion_models")) this.filters.category = "diffusion_models";
            else this.filters.category = this.categories[0];
        }

        this.createUI();
        await this.fetchModels();
    }

    async fetchCategories() {
        try {
            const resp = await api.fetchApi("/model_database/categories");
            if (resp.ok) {
                this.categories = await resp.json();
            }
        } catch (e) {
            console.error("Failed to fetch categories", e);
        }
    }

    async fetchSVDQCompatibility() {
        try {
            const resp = await api.fetchApi("/model_database/svdq_compatibility");
            if (resp.ok) {
                const data = await resp.json();
                this.svdqCompatibility = data.compatibility || "unknown";
            }
        } catch (e) {
            console.error("Failed to fetch SVDQ compatibility", e);
        }
    }

    async fetchModels() {
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();

        try {
            this.setLoading(true);
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(this.filters)) {
                if (v) params.append(k, v);
            }

            const resp = await api.fetchApi(`/model_database/models?${params.toString()}`, {
                signal: this.abortController.signal
            });

            if (resp.ok) {
                this.models = await resp.json();
                this.renderModels();
            }
        } catch (e) {
            if (e.name !== 'AbortError') {
                console.error("Failed to fetch models", e);
            }
        } finally {
            this.setLoading(false);
        }
    }

    createUI() {
        this.element = document.createElement("div");
        Object.assign(this.element.style, {
            position: "fixed",
            top: "0",
            left: "0",
            width: "100vw",
            height: "100vh",
            backgroundColor: "rgba(0, 0, 0, 0.6)",
            zIndex: MAX_Z_INDEX,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "Arial, sans-serif",
            color: "#eee"
        });

        const container = document.createElement("div");
        Object.assign(container.style, {
            width: "90%",
            maxWidth: "1200px",
            height: "85%",
            backgroundColor: "#222",
            borderRadius: "8px",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            overflow: "hidden"
        });

        // Header
        const header = document.createElement("div");
        Object.assign(header.style, {
            padding: "16px",
            borderBottom: "1px solid #333",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            backgroundColor: "#2a2a2a"
        });

        const title = document.createElement("h2");
        title.textContent = "Model Database";
        title.style.margin = "0";
        header.appendChild(title);

        const closeBtn = document.createElement("button");
        closeBtn.textContent = "✕";
        Object.assign(closeBtn.style, {
            background: "none",
            border: "none",
            color: "#fff",
            fontSize: "20px",
            cursor: "pointer"
        });
        closeBtn.onclick = () => this.utils_close();
        header.appendChild(closeBtn);
        container.appendChild(header);

        // Top Panel (Filters)
        const filtersPanel = document.createElement("div");
        Object.assign(filtersPanel.style, {
            padding: "12px",
            borderBottom: "1px solid #333",
            display: "flex",
            gap: "12px",
            flexWrap: "wrap",
            alignItems: "center",
            backgroundColor: "#1f1f1f"
        });

        // Category Select
        this.categorySelect = this.createSelect("Category", this.categories, this.filters.category, (val) => {
            this.filters.category = val;
            this.fetchModels();
        });
        filtersPanel.appendChild(this.categorySelect.wrapper);

        // Base Model Select (Hardcoded for now as we don't have API for it yet, or derived from current models?)
        // The user wants "Base Model" filter.
        // Let's populate it with common ones + "any"
        // In a real implementation this should probably be dynamic based on category.
        const baseModels = ["any", "SD1.5", "SDXL", "SD3", "Flux", "Pony", "Wan 2.1", "Hunyuan", "LTX", "PixArt", "AuraFlow", "Cosmos"];
        this.baseModelSelect = this.createSelect("Base Model", baseModels, "any", (val) => {
            this.filters.base_model = val;
            this.fetchModels();
        });
        filtersPanel.appendChild(this.baseModelSelect.wrapper);

        // Type Filter
        const types = ["any", "safetensors", "gguf", "svdq", "pt", "bin"];
        this.typeSelect = this.createSelect("Type", types, "any", (val) => {
            this.filters.type = val;
            this.fetchModels();
        });
        filtersPanel.appendChild(this.typeSelect.wrapper);

        // Precision Filter
        const precisions = ["any", "fp32", "fp16", "bf16", "fp8", "int8", "int4", "fp4", "Q8_0", "Q6_K", "Q5_K_M", "Q5_0", "Q4_K_M", "Q4_0", "IQ4_NL"];
        this.precisionSelect = this.createSelect("Precision", precisions, "any", (val) => {
            this.filters.precision = val;
            this.fetchModels();
        });
        filtersPanel.appendChild(this.precisionSelect.wrapper);

        // Search Box
        const searchWrapper = document.createElement("div");
        searchWrapper.style.display = "flex";
        searchWrapper.style.flexDirection = "column";
        const searchLabel = document.createElement("label");
        searchLabel.textContent = "Search";
        searchLabel.style.fontSize = "10px";
        searchLabel.style.marginBottom = "4px";
        searchLabel.style.color = "#888";

        const searchInput = document.createElement("input");
        searchInput.type = "text";
        searchInput.placeholder = "Filter by name...";
        Object.assign(searchInput.style, {
            padding: "4px 8px",
            borderRadius: "4px",
            border: "1px solid #444",
            background: "#333",
            color: "#fff",
            width: "200px"
        });
        let debounceTimer;
        searchInput.addEventListener("input", (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                this.filters.search = e.target.value;
                this.fetchModels();
            }, 300);
        });
        searchWrapper.appendChild(searchLabel);
        searchWrapper.appendChild(searchInput);
        filtersPanel.appendChild(searchWrapper);

        container.appendChild(filtersPanel);

        // Main Content (List)
        this.contentArea = document.createElement("div");
        Object.assign(this.contentArea.style, {
            flex: "1",
            overflowY: "auto",
            padding: "16px",
            position: "relative"
        });
        container.appendChild(this.contentArea);

        // Status/Loader overlay
        this.loader = document.createElement("div");
        this.loader.textContent = "Loading...";
        Object.assign(this.loader.style, {
            position: "absolute",
            top: "0", left: "0", right: "0", bottom: "0",
            backgroundColor: "rgba(0,0,0,0.5)",
            display: "none",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "10"
        });
        this.contentArea.appendChild(this.loader);


        this.element.appendChild(container);
        document.body.appendChild(this.element);

        // Close on outside click
        this.element.addEventListener("click", (e) => {
            if (e.target === this.element) this.utils_close();
        });
    }

    utils_close() {
        if (this.element) {
            this.element.style.display = "none";
        }
    }

    setLoading(isLoading) {
        if (this.loader) {
            this.loader.style.display = isLoading ? "flex" : "none";
        }
    }

    createSelect(label, options, selected, onChange) {
        const wrapper = document.createElement("div");
        wrapper.style.display = "flex";
        wrapper.style.flexDirection = "column";

        const lbl = document.createElement("label");
        lbl.textContent = label;
        lbl.style.fontSize = "10px";
        lbl.style.marginBottom = "4px";
        lbl.style.color = "#888";

        const sel = document.createElement("select");
        Object.assign(sel.style, {
            padding: "4px 20px 4px 8px", // extra padding for arrow
            borderRadius: "4px",
            border: "1px solid #444",
            background: "#333",
            color: "#fff",
            cursor: "pointer",
            outline: "none",
            appearance: "auto"
        });

        options.forEach(opt => {
            const el = document.createElement("option");
            el.value = opt;
            el.textContent = opt;
            if (opt === selected) el.selected = true;
            sel.appendChild(el);
        });

        sel.onchange = (e) => onChange(e.target.value);

        wrapper.appendChild(lbl);
        wrapper.appendChild(sel);

        return { wrapper, select: sel };
    }

    renderModels() {
        // Clear content but keep loader
        Array.from(this.contentArea.children).forEach(child => {
            if (child !== this.loader) this.contentArea.removeChild(child);
        });

        if (this.models.length === 0) {
            const empty = document.createElement("div");
            empty.textContent = "No models found matching filters.";
            empty.style.padding = "20px";
            empty.style.color = "#888";
            empty.style.textAlign = "center";
            this.contentArea.appendChild(empty);
            return;
        }

        // Apply grouping logic: Group by "Family" -> Folder
        // Heuristic: Simplify filename to find common prefix?
        // Or simplistic approach: just list them for now but support folder structure if implied?
        // User said: "catalogue is list of entries... each entry is folder where group different precision... If folder have only one version it shouldn't have folder sign"

        // Let's group by a "Stem" (removing extension, precision, type suffixes)
        // This is hard to do perfectly on frontend without metadata.
        // We'll use a simple heuristic:
        // 1. Remove extension
        // 2. Remove known suffixes (fp16, int4, q8_0, etc.)
        // 3. Remove "base" suffix if any?

        const grouped = {};

        const precisionRegex = /[-_.]?(fp32|fp16|bf16|fp8|int8|int4|fp4|q[2-8]_|iq4_)[a-zA-Z0-9_]*$/i;

        this.models.forEach(model => {
            let name = model.filename;
            // Remove extension
            name = name.replace(/\.[^/.]+$/, "");
            // Remove precision/quant suffix
            name = name.replace(precisionRegex, "");
            // Remove -gguf or -svdq markers
            name = name.replace(/[-_]?(gguf|svdq)/i, "");

            // Clean trail
            name = name.replace(/[-_]$/, "");

            if (!grouped[name]) grouped[name] = [];
            grouped[name].push(model);
        });

        const listContainer = document.createElement("div");
        listContainer.style.display = "flex";
        listContainer.style.flexDirection = "column";
        listContainer.style.gap = "8px";

        // Sort groups by name
        const sortedKeys = Object.keys(grouped).sort();

        sortedKeys.forEach(key => {
            const group = grouped[key];
            if (group.length === 1) {
                // Render single item
                listContainer.appendChild(this.renderModelCard(group[0], false));
            } else {
                // Render folder
                listContainer.appendChild(this.renderFolderCard(key, group));
            }
        });

        this.contentArea.appendChild(listContainer);
    }

    renderModelCard(model, isChild) {
        const card = document.createElement("div");
        Object.assign(card.style, {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 12px",
            backgroundColor: "#2e2e2e",
            borderRadius: "4px",
            border: "1px solid #3e3e3e"
        });
        if (isChild) {
            card.style.marginLeft = "24px";
            card.style.backgroundColor = "#252525";
        }

        const info = document.createElement("div");
        info.style.display = "flex";
        info.style.alignItems = "center";
        info.style.gap = "12px";

        const nameCol = document.createElement("div");

        const nameEl = document.createElement("div");
        nameEl.textContent = model.filename;
        nameEl.style.fontWeight = "bold";
        nameEl.style.fontSize = "14px";

        const metaEl = document.createElement("div");
        metaEl.style.fontSize = "11px";
        metaEl.style.color = "#aaa";
        metaEl.style.marginTop = "2px";

        // Size format
        let sizeStr = "";
        if (model.size) {
            const gb = model.size / (1024 * 1024 * 1024);
            sizeStr = gb > 0.9 ? `${gb.toFixed(2)} GB` : `${(model.size / (1024 * 1024)).toFixed(0)} MB`;
        }

        metaEl.textContent = `${model.type} | ${model.precision} ${sizeStr ? "| " + sizeStr : ""}`;

        nameCol.appendChild(nameEl);
        nameCol.appendChild(metaEl);

        info.appendChild(nameCol);
        card.appendChild(info);

        const actions = document.createElement("div");

        const dlBtn = document.createElement("button");
        dlBtn.textContent = "Download";
        Object.assign(dlBtn.style, {
            padding: "6px 12px",
            backgroundColor: "#228be6",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "12px",
            fontWeight: "600"
        });
        dlBtn.onmouseover = () => { if (!dlBtn.disabled) dlBtn.style.backgroundColor = "#1c7ed6"; };
        dlBtn.onmouseout = () => { if (!dlBtn.disabled) dlBtn.style.backgroundColor = "#228be6"; };

        dlBtn.onclick = (e) => {
            e.stopPropagation();
            this.triggerDownload(model, dlBtn);
        };

        actions.appendChild(dlBtn);
        card.appendChild(actions);

        return card;
    }

    renderFolderCard(name, group) {
        const wrapper = document.createElement("div");

        const header = document.createElement("div");
        Object.assign(header.style, {
            display: "flex",
            alignItems: "center",
            padding: "8px 12px",
            backgroundColor: "#333",
            borderRadius: "4px",
            border: "1px solid #444",
            cursor: "pointer",
            fontWeight: "bold"
        });

        const icon = document.createElement("span");
        icon.textContent = "📁";
        icon.style.marginRight = "8px";

        const label = document.createElement("span");
        label.textContent = `${name} (${group.length})`;

        const arrow = document.createElement("span");
        arrow.textContent = "▶";
        arrow.style.marginLeft = "auto";
        arrow.style.fontSize = "10px";
        arrow.style.color = "#888";

        header.appendChild(icon);
        header.appendChild(label);
        header.appendChild(arrow);

        const childrenContainer = document.createElement("div");
        childrenContainer.style.display = "none";
        childrenContainer.style.flexDirection = "column";
        childrenContainer.style.gap = "4px";
        childrenContainer.style.marginTop = "4px";

        group.forEach(model => {
            childrenContainer.appendChild(this.renderModelCard(model, true));
        });

        header.onclick = () => {
            const isExpanded = childrenContainer.style.display === "flex";
            childrenContainer.style.display = isExpanded ? "none" : "flex";
            arrow.textContent = isExpanded ? "▶" : "▼";
            header.style.backgroundColor = isExpanded ? "#333" : "#3e3e3e";
        };

        wrapper.appendChild(header);
        wrapper.appendChild(childrenContainer);

        return wrapper;
    }

    async triggerDownload(model, btn) {
        if (btn) {
            btn.textContent = "Queued";
            btn.disabled = true;
            btn.style.backgroundColor = "#9aa4b6";
            btn.style.cursor = "default";
        }

        const queueModel = {
            filename: model.filename,
            url: model.url,
            folder: model.directory
        };

        try {
            const resp = await fetch("/queue_download", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    models: [queueModel]
                })
            });

            if (resp.status !== 200) {
                const errText = await resp.text();
                console.error("Download failed:", errText);
                if (btn) {
                    btn.textContent = "Failed";
                    btn.style.backgroundColor = "#e03131";
                    setTimeout(() => {
                        btn.textContent = "Download";
                        btn.disabled = false;
                        btn.style.backgroundColor = "#228be6";
                        btn.style.cursor = "pointer";
                    }, 3000);
                }
                return;
            }

            console.log("Queued download for", model.filename);

        } catch (e) {
            console.error("Network error:", e);
            if (btn) {
                btn.textContent = "Error";
                btn.style.backgroundColor = "#e03131";
            }
        }
    }
}


export const modelDatabaseDialog = new ModelDatabaseDialog();
