import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const MAX_Z_INDEX = 10001;

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
        this.availableFilters = {
            base_models: [],
            types: [],
            precisions: []
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
        // Set default category
        if (this.categories.length > 0 && !this.categories.includes(this.filters.category)) {
            if (this.categories.includes("diffusion_models")) this.filters.category = "diffusion_models";
            else this.filters.category = this.categories[0];
        }

        this.createUI();
        // Initial fetch of filters and models
        await this.updateFiltersAndModels();
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

    async fetchFiltersForCategory() {
        try {
            const params = new URLSearchParams({ category: this.filters.category });
            const resp = await api.fetchApi(`/model_database/filters?${params.toString()}`);
            if (resp.ok) {
                this.availableFilters = await resp.json();
                this.updateFilterDropdowns();
            }
        } catch (e) {
            console.error("Failed to fetch filters", e);
        }
    }

    async updateFiltersAndModels() {
        await this.fetchFiltersForCategory();
        await this.fetchModels();
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
        this.filtersPanel = document.createElement("div");
        Object.assign(this.filtersPanel.style, {
            padding: "12px",
            borderBottom: "1px solid #333",
            display: "flex",
            gap: "12px",
            flexWrap: "wrap",
            alignItems: "center",
            backgroundColor: "#1f1f1f"
        });

        // Category Select
        this.categorySelect = this.createSelect("Category", this.categories, this.filters.category, async (val) => {
            this.filters.category = val;
            // Reset other filters when category changes
            this.filters.base_model = "any";
            this.filters.type = "any";
            this.filters.precision = "any";
            await this.updateFiltersAndModels();
        });
        this.filtersPanel.appendChild(this.categorySelect.wrapper);

        // Base Model Select
        this.baseModelSelect = this.createSelect("Base Model", ["any"], "any", (val) => {
            this.filters.base_model = val;
            this.fetchModels();
        });
        this.filtersPanel.appendChild(this.baseModelSelect.wrapper);

        // Type Filter
        this.typeSelect = this.createSelect("Type", ["any"], "any", (val) => {
            this.filters.type = val;
            this.fetchModels();
        });
        this.filtersPanel.appendChild(this.typeSelect.wrapper);

        // Precision Filter
        this.precisionSelect = this.createSelect("Precision", ["any"], "any", (val) => {
            this.filters.precision = val;
            this.fetchModels();
        });
        this.filtersPanel.appendChild(this.precisionSelect.wrapper);

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
        searchInput.placeholder = "Filter name...";
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
        this.filtersPanel.appendChild(searchWrapper);

        container.appendChild(this.filtersPanel);

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
            padding: "4px 20px 4px 8px",
            borderRadius: "4px",
            border: "1px solid #444",
            background: "#333",
            color: "#fff",
            cursor: "pointer",
            outline: "none",
            appearance: "auto"
        });

        this._populateSelect(sel, options, selected);

        sel.onchange = (e) => onChange(e.target.value);

        wrapper.appendChild(lbl);
        wrapper.appendChild(sel);

        return { wrapper, select: sel };
    }

    _populateSelect(selElement, options, selected) {
        selElement.innerHTML = "";
        options.forEach(opt => {
            const el = document.createElement("option");
            el.value = opt;
            el.textContent = opt;
            if (opt === selected) el.selected = true;
            selElement.appendChild(el);
        });
    }

    updateFilterDropdowns() {
        // Base Model
        const baseOpts = ["any", ...this.availableFilters.base_models];
        this._populateSelect(this.baseModelSelect.select, baseOpts, this.filters.base_model);
        this.baseModelSelect.wrapper.style.display = (baseOpts.length <= 1) ? "none" : "flex";

        // Type
        const typeOpts = ["any", ...this.availableFilters.types];
        this._populateSelect(this.typeSelect.select, typeOpts, this.filters.type);
        this.typeSelect.wrapper.style.display = (typeOpts.length <= 1) ? "none" : "flex";

        // Precision
        const precOpts = ["any", ...this.availableFilters.precisions];
        this._populateSelect(this.precisionSelect.select, precOpts, this.filters.precision);
        this.precisionSelect.wrapper.style.display = (precOpts.length <= 1) ? "none" : "flex";
    }

    renderModels() {
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

        const grouped = {};
        const precisionRegex = /[-_.]?(fp32|fp16|bf16|fp8|int8|int4|fp4|q[2-8]_|iq4_)[a-zA-Z0-9_]*$/i;

        this.models.forEach(model => {
            let name = model.filename;
            // Fuzzy grouping normalization: remove extension, precision, separators
            let base = name.replace(/\.[^/.]+$/, "");
            base = base.replace(precisionRegex, "");
            base = base.replace(/[-_]?(gguf|svdq)/i, "");

            // Normalize separators for grouping key
            const key = base.toLowerCase().replace(/[-_.]/g, " ").trim();

            if (!grouped[key]) grouped[key] = { name: base, items: [] };
            grouped[key].items.push(model);
        });

        const listContainer = document.createElement("div");
        listContainer.style.display = "flex";
        listContainer.style.flexDirection = "column";
        listContainer.style.gap = "8px";

        const sortedKeys = Object.keys(grouped).sort();

        sortedKeys.forEach(key => {
            const group = grouped[key];
            if (group.items.length === 1) {
                listContainer.appendChild(this.renderModelCard(group.items[0], false));
            } else {
                // Use the name from the first item as display name foundation, or the simplified base
                // Use Title Case for display if we normalized it down
                listContainer.appendChild(this.renderFolderCard(group.name, group.items));
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

        let sizeStr = "";
        if (model.size) {
            const gb = model.size / (1024 * 1024 * 1024);
            sizeStr = gb > 0.9 ? `${gb.toFixed(2)} GB` : `${(model.size / (1024 * 1024)).toFixed(0)} MB`;
        }

        const typeStr = model.type !== "unknown" ? model.type : "";
        const precStr = model.precision !== "unknown" ? model.precision : "";
        const baseStr = model.base_model && model.base_model !== "unknown" ? model.base_model : "";

        const tags = [baseStr, typeStr, precStr, sizeStr].filter(Boolean).join(" | ");
        metaEl.textContent = tags;

        nameCol.appendChild(nameEl);
        nameCol.appendChild(metaEl);
        info.appendChild(nameCol);

        if (model.installed) {
            const badge = document.createElement("span");
            badge.textContent = "Installed";
            Object.assign(badge.style, {
                backgroundColor: "#2f9e44",
                color: "white",
                padding: "2px 6px",
                borderRadius: "4px",
                fontSize: "10px",
                marginLeft: "8px",
                fontWeight: "bold"
            });
            // Try to put badge next to name
            nameEl.appendChild(badge);
        }

        card.appendChild(info);

        const actions = document.createElement("div");

        const dlBtn = document.createElement("button");
        const isInstalled = model.installed;

        dlBtn.textContent = isInstalled ? "Installed" : "Download";
        Object.assign(dlBtn.style, {
            padding: "6px 12px",
            backgroundColor: isInstalled ? "#37b24d" : "#228be6",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: isInstalled ? "default" : "pointer",
            fontSize: "12px",
            fontWeight: "600",
            opacity: isInstalled ? "0.7" : "1"
        });

        dlBtn.disabled = isInstalled;

        if (!isInstalled) {
            dlBtn.onmouseover = () => { if (!dlBtn.disabled) dlBtn.style.backgroundColor = "#1c7ed6"; };
            dlBtn.onmouseout = () => { if (!dlBtn.disabled) dlBtn.style.backgroundColor = "#228be6"; };

            dlBtn.onclick = (e) => {
                e.stopPropagation();
                this.triggerDownload(model, dlBtn);
            };
        }

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
