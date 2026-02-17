import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const MODEL_EXPLORER_SETTING_ID = "downloader.model_explorer_enabled";
const MODEL_EXPLORER_API_BASES = [
    "/hf_downloader_model_explorer_v2",
    "/hf_model_explorer",
    "/api/hf_downloader/model_explorer",
    "/api/model_explorer",
];
const MODEL_TO_NODE_STORE_IMPORT_CANDIDATES = [
    "../../../stores/modelToNodeStore.js",
    "/stores/modelToNodeStore.js",
    "../../../scripts/stores/modelToNodeStore.js",
    "/scripts/stores/modelToNodeStore.js",
];
const FALLBACK_NODE_PROVIDER_BY_CATEGORY = {
    checkpoints: { nodeType: "CheckpointLoaderSimple", key: "ckpt_name" },
    diffusion_models: { nodeType: "UNETLoader", key: "unet_name" },
    vae: { nodeType: "VAELoader", key: "vae_name" },
    loras: { nodeType: "LoraLoader", key: "lora_name" },
    controlnet: { nodeType: "ControlNetLoader", key: "control_net_name" },
    text_encoders: { nodeType: "CLIPLoader", key: "clip_name" },
    clip_vision: { nodeType: "CLIPVisionLoader", key: "clip_name" },
    upscale_models: { nodeType: "UpscaleModelLoader", key: "model_name" },
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchWithTimeout = async (url, init = {}, timeoutMs = 15000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout_${timeoutMs}`)), timeoutMs);
    try {
        return await api.fetchApi(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
};

const showToast = (options, type = "info") => {
    let payload = options;
    if (typeof options === "string") {
        payload = { detail: options, severity: type };
    }
    if (app?.extensionManager?.toast?.add) {
        app.extensionManager.toast.add({
            severity: payload.severity || type,
            summary: payload.summary,
            detail: payload.detail,
            life: payload.life,
        });
    }
};

const escapeHtml = (value) =>
    String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");

const isModelExplorerEnabled = () => {
    const settingsUi = app?.ui?.settings;
    if (!settingsUi?.getSettingValue) {
        return false;
    }
    return Boolean(settingsUi.getSettingValue(MODEL_EXPLORER_SETTING_ID));
};

let modelToNodeStorePromise = null;
const resolveModelToNodeStore = async () => {
    if (modelToNodeStorePromise) {
        return modelToNodeStorePromise;
    }
    modelToNodeStorePromise = (async () => {
        for (const candidate of MODEL_TO_NODE_STORE_IMPORT_CANDIDATES) {
            try {
                const mod = await import(candidate);
                const useStore = mod?.useModelToNodeStore;
                if (typeof useStore === "function") {
                    return useStore();
                }
            } catch (_) {
                // Continue to next candidate.
            }
        }
        return null;
    })();
    return modelToNodeStorePromise;
};

const placeNodeNearCanvasCenter = (node) => {
    const canvas = app?.canvas;
    if (!canvas || !node) return;
    try {
        const width = Number(canvas?.canvas?.width || 1600);
        const height = Number(canvas?.canvas?.height || 900);
        const scale = Number(canvas?.ds?.scale || 1);
        const offset = Array.isArray(canvas?.ds?.offset) ? canvas.ds.offset : [0, 0];
        node.pos = [
            width / (2 * scale) - Number(offset[0] || 0),
            height / (2 * scale) - Number(offset[1] || 0),
        ];
    } catch (_) {
        node.pos = [80, 80];
    }
};

const addModelNodeFromSelection = async (category, modelPath) => {
    const graph = app?.graph || app?.canvas?.graph;
    if (!graph || !globalThis?.LiteGraph?.createNode) {
        throw new Error("Graph/LiteGraph is not available.");
    }

    const modelToNodeStore = await resolveModelToNodeStore();
    let provider = null;
    if (modelToNodeStore?.getNodeProvider) {
        provider = modelToNodeStore.getNodeProvider(category);
    }
    if (!provider) {
        provider = FALLBACK_NODE_PROVIDER_BY_CATEGORY[category] || null;
    }
    if (!provider) {
        throw new Error(`No node provider for category "${category}".`);
    }

    const nodeType = provider?.nodeDef?.name || provider?.nodeType;
    const nodeDisplayName = provider?.nodeDef?.display_name;
    const widgetKey = provider?.key;
    if (!nodeType) {
        throw new Error(`Missing node type for category "${category}".`);
    }

    const node = globalThis.LiteGraph.createNode(nodeType, nodeDisplayName);
    if (!node) {
        throw new Error(`Failed to create node "${nodeType}".`);
    }

    if (widgetKey) {
        const widget = Array.isArray(node.widgets)
            ? node.widgets.find((w) => w?.name === widgetKey)
            : null;
        if (widget) {
            widget.value = modelPath;
        }
    }

    graph.add(node);
    placeNodeNearCanvasCenter(node);
    node.setDirtyCanvas?.(true, true);
    app?.canvas?.setDirty?.(true, true);
};

class ModelExplorerDialog {
    constructor() {
        this.element = null;
        this.body = null;
        this.categorySelect = null;
        this.baseSelect = null;
        this.precisionSelect = null;
        this.searchInput = null;
        this.groups = [];
        this.categories = [];
        this.filters = { category: "", base: "", precision: "", search: "" };
        this.loading = false;
        this.searchTimer = null;
        this.apiBase = "";
    }

    async fetchExplorer(pathAndQuery, init = {}) {
        const bases = this.apiBase
            ? [this.apiBase, ...MODEL_EXPLORER_API_BASES.filter((base) => base !== this.apiBase)]
            : [...MODEL_EXPLORER_API_BASES];
        let fallback404Response = null;
        let lastError = null;

        for (const base of bases) {
            try {
                const response = await fetchWithTimeout(`${base}${pathAndQuery}`, init);
                if (response.status === 404) {
                    fallback404Response = response;
                    continue;
                }
                this.apiBase = base;
                return response;
            } catch (error) {
                lastError = error;
            }
        }

        if (fallback404Response) {
            return fallback404Response;
        }
        throw lastError || new Error("Model Explorer API is unreachable.");
    }

    async show() {
        if (!isModelExplorerEnabled()) {
            showToast({
                severity: "warn",
                summary: "Model Explorer disabled",
                detail: "Enable Model Explorer in Settings first.",
            });
            return;
        }

        if (!this.element) {
            this.createUi();
        }
        this.element.style.display = "flex";
        try {
            await this.refreshAll();
        } catch (error) {
            this.renderError(`Failed to open Model Explorer: ${error}`);
        }
    }

    close() {
        if (this.element) {
            this.element.style.display = "none";
        }
    }

    createUi() {
        const overlay = document.createElement("div");
        Object.assign(overlay.style, {
            position: "fixed",
            inset: "0",
            background: "rgba(0,0,0,0.5)",
            zIndex: "9100",
            display: "none",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
        });
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                this.close();
            }
        });

        const panel = document.createElement("div");
        Object.assign(panel.style, {
            width: "min(1220px, 100%)",
            maxHeight: "92vh",
            background: "var(--base-background, var(--comfy-menu-bg, #1f2128))",
            border: "1px solid var(--border-default, #3c4452)",
            borderRadius: "16px",
            boxShadow: "0 12px 28px rgba(0,0,0,0.45)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            fontFamily: "var(--font-inter, Inter, sans-serif)",
        });

        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--border-default,#3c4452);">
                <div style="font-size:24px;font-weight:600;line-height:1.2;">Model Explorer</div>
                <button type="button" id="hf-model-explorer-close" style="width:40px;height:40px;border:none;border-radius:10px;background:var(--comfy-input-bg);color:var(--input-text);font-size:20px;cursor:pointer;">×</button>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:10px;padding:14px 22px;border-bottom:1px solid var(--border-default,#3c4452);align-items:end;">
                <label style="display:flex;flex-direction:column;gap:4px;min-width:200px;">
                    <span style="font-size:11px;color:var(--descrip-text,#9aa4b6);text-transform:uppercase;">Category</span>
                    <select id="hf-me-category" style="height:38px;border-radius:8px;border:1px solid var(--border-default);background:var(--comfy-input-bg);color:var(--input-text);padding:0 10px;"></select>
                </label>
                <label id="hf-me-base-wrap" style="display:flex;flex-direction:column;gap:4px;min-width:180px;">
                    <span style="font-size:11px;color:var(--descrip-text,#9aa4b6);text-transform:uppercase;">Base</span>
                    <select id="hf-me-base" style="height:38px;border-radius:8px;border:1px solid var(--border-default);background:var(--comfy-input-bg);color:var(--input-text);padding:0 10px;"></select>
                </label>
                <label style="display:flex;flex-direction:column;gap:4px;min-width:180px;">
                    <span style="font-size:11px;color:var(--descrip-text,#9aa4b6);text-transform:uppercase;">Precision</span>
                    <select id="hf-me-precision" style="height:38px;border-radius:8px;border:1px solid var(--border-default);background:var(--comfy-input-bg);color:var(--input-text);padding:0 10px;"></select>
                </label>
                <label style="display:flex;flex-direction:column;gap:4px;min-width:260px;flex:1;">
                    <span style="font-size:11px;color:var(--descrip-text,#9aa4b6);text-transform:uppercase;">Search</span>
                    <input id="hf-me-search" type="text" placeholder="Search models..." style="height:38px;border-radius:8px;border:1px solid var(--border-default);background:var(--comfy-input-bg);color:var(--input-text);padding:0 12px;" />
                </label>
            </div>
            <div id="hf-me-body" style="padding:14px 22px;overflow:auto;display:flex;flex-direction:column;gap:10px;min-height:260px;max-height:66vh;"></div>
        `;

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        this.element = overlay;
        this.body = panel.querySelector("#hf-me-body");
        this.categorySelect = panel.querySelector("#hf-me-category");
        this.baseSelect = panel.querySelector("#hf-me-base");
        this.precisionSelect = panel.querySelector("#hf-me-precision");
        this.searchInput = panel.querySelector("#hf-me-search");
        this.baseWrap = panel.querySelector("#hf-me-base-wrap");

        panel.querySelector("#hf-model-explorer-close").onclick = () => this.close();
        this.categorySelect.onchange = async () => {
            this.filters.category = this.categorySelect.value;
            this.filters.base = "";
            this.filters.precision = "";
            await this.refreshFiltersAndGroups();
        };
        this.baseSelect.onchange = async () => {
            this.filters.base = this.baseSelect.value;
            await this.refreshGroups();
        };
        this.precisionSelect.onchange = async () => {
            this.filters.precision = this.precisionSelect.value;
            await this.refreshGroups();
        };
        this.searchInput.oninput = () => {
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => {
                this.filters.search = this.searchInput.value.trim();
                void this.refreshGroups();
            }, 220);
        };
    }

    async refreshAll() {
        await this.fetchCategories();
        await this.refreshFiltersAndGroups();
    }

    async refreshFiltersAndGroups() {
        await this.fetchFilters();
        await this.refreshGroups();
    }

    async fetchCategories() {
        try {
            const resp = await this.fetchExplorer("/categories");
            if (!resp.ok) {
                this.categories = [];
                this.renderCategorySelect();
                this.renderError(`Categories request failed (HTTP ${resp.status}).`);
                return;
            }
            const data = await resp.json();
            this.categories = Array.isArray(data?.categories) ? data.categories : [];
            const categoryIds = new Set(this.categories.map((item) => String(item?.id || "")));
            if (this.filters.category && !categoryIds.has(this.filters.category)) {
                this.filters.category = "";
            }
            if (!this.filters.category && this.categories.length) {
                this.filters.category = String(this.categories[0]?.id || "");
            }
            this.renderCategorySelect();
        } catch (error) {
            this.categories = [];
            this.renderCategorySelect();
            this.renderError(`Failed to fetch categories: ${error}`);
        }
    }

    async fetchFilters() {
        try {
            const params = new URLSearchParams();
            if (this.filters.category) params.set("category", this.filters.category);
            const resp = await this.fetchExplorer(`/filters?${params.toString()}`);
            if (!resp.ok) {
                this.renderSelectWithAny(this.baseSelect, [], "");
                this.renderSelectWithAny(this.precisionSelect, [], "");
                this.renderError(`Filters request failed (HTTP ${resp.status}).`);
                return;
            }
            const data = await resp.json();
            const bases = Array.isArray(data?.bases) ? data.bases : [];
            const precisions = Array.isArray(data?.precisions) ? data.precisions : [];
            this.renderSelectWithAny(this.baseSelect, bases, this.filters.base);
            this.renderSelectWithAny(this.precisionSelect, precisions, this.filters.precision);
        } catch (error) {
            this.renderSelectWithAny(this.baseSelect, [], "");
            this.renderSelectWithAny(this.precisionSelect, [], "");
            this.renderError(`Failed to fetch filters: ${error}`);
        }
        const baseAllowed = ["checkpoints", "diffusion_models", "loras"].includes(this.filters.category);
        this.baseWrap.style.display = baseAllowed ? "flex" : "none";
        if (!baseAllowed) this.filters.base = "";
    }

    async refreshGroups() {
        this.setLoading(true);
        try {
            const params = new URLSearchParams();
            if (this.filters.category) params.set("category", this.filters.category);
            if (this.filters.base) params.set("base", this.filters.base);
            if (this.filters.precision) params.set("precision", this.filters.precision);
            if (this.filters.search) params.set("search", this.filters.search);
            params.set("installed_first", "true");
            params.set("offset", "0");
            params.set("limit", "300");
            const resp = await this.fetchExplorer(`/groups?${params.toString()}`);
            if (!resp.ok) {
                this.renderError(`Model Explorer groups failed (HTTP ${resp.status}).`);
                return;
            }
            const data = await resp.json();
            this.groups = Array.isArray(data?.groups) ? data.groups : [];
            this.renderGroups();
        } catch (error) {
            this.renderError(`Failed to fetch groups: ${error}`);
        } finally {
            this.setLoading(false);
        }
    }

    renderCategorySelect() {
        this.categorySelect.innerHTML = "";
        const allOption = document.createElement("option");
        allOption.value = "";
        allOption.textContent = "All categories";
        allOption.selected = !this.filters.category;
        this.categorySelect.appendChild(allOption);
        for (const item of this.categories) {
            const option = document.createElement("option");
            option.value = String(item.id || "");
            option.textContent = `${item.id} (${item.count})`;
            option.selected = option.value === this.filters.category;
            this.categorySelect.appendChild(option);
        }
    }

    renderSelectWithAny(selectEl, values, selected) {
        selectEl.innerHTML = "";
        const any = document.createElement("option");
        any.value = "";
        any.textContent = "Any";
        any.selected = !selected;
        selectEl.appendChild(any);
        for (const value of values) {
            const option = document.createElement("option");
            option.value = String(value);
            option.textContent = String(value);
            option.selected = option.value === selected;
            selectEl.appendChild(option);
        }
    }

    setLoading(isLoading) {
        this.loading = Boolean(isLoading);
        if (this.loading) {
            this.body.innerHTML = `<div style="padding:30px;color:var(--descrip-text,#9aa4b6);">Loading Model Explorer...</div>`;
        }
    }

    renderError(message) {
        this.body.innerHTML = `
            <div style="padding:20px;border:1px solid color-mix(in srgb, var(--destructive-background,#d44) 45%, var(--border-default,#3c4452) 55%);border-radius:10px;background:color-mix(in srgb, var(--comfy-input-bg,#2b3242) 86%, var(--destructive-background,#d44) 14%);color:var(--input-text,#e5e7eb);">
                <div style="font-size:14px;font-weight:700;margin-bottom:6px;">Model Explorer request failed</div>
                <div style="font-size:13px;line-height:1.35;color:var(--descrip-text,#c4c9d4);">${escapeHtml(message)}</div>
                <div style="font-size:12px;margin-top:10px;color:var(--descrip-text,#9aa4b6);">If backend routes were just changed, restart ComfyUI and reopen Model Explorer.</div>
            </div>
        `;
    }

    renderGroups() {
        if (!this.groups.length) {
            this.body.innerHTML = `<div style="padding:30px;color:var(--descrip-text,#9aa4b6);">No models found for current filters.</div>`;
            return;
        }

        const chunks = [];
        for (const group of this.groups) {
            const title = escapeHtml(group.group_name || "Model");
            const category = escapeHtml(group.category || "");
            const base = group.base ? `<span style="font-size:11px;color:#c8d2e0;">base: ${escapeHtml(group.base)}</span>` : "";
            const installedBadge = group.installed
                ? `<span style="font-size:11px;color:#56d78f;font-weight:700;">INSTALLED</span>`
                : "";

            const variantsHtml = (Array.isArray(group.variants) ? group.variants : [])
                .map((variant, index) => {
                    const filename = escapeHtml(variant.filename || "");
                    const precision = escapeHtml(variant.precision || "unknown");
                    const source = escapeHtml(variant.source || "");
                    const installed = Boolean(variant.installed);
                    const variantKey = `${group.group_id}:${index}`;
                    const actions = installed
                        ? `
                            <button data-action="use" data-key="${variantKey}" style="height:34px;padding:0 12px;border:none;border-radius:8px;background:var(--primary-background);color:var(--base-foreground);font-weight:600;cursor:pointer;">Use</button>
                            <button data-action="delete" data-key="${variantKey}" style="height:34px;padding:0 12px;border:none;border-radius:8px;background:var(--destructive-background,#e44);color:#fff;font-weight:600;cursor:pointer;">Delete</button>
                          `
                        : `
                            <button data-action="download" data-key="${variantKey}" style="height:34px;padding:0 12px;border:none;border-radius:8px;background:var(--secondary-background,#3a4458);color:var(--base-foreground);font-weight:600;cursor:pointer;">Download</button>
                          `;

                    return `
                        <div style="display:grid;grid-template-columns:minmax(340px,1.5fr) minmax(120px,0.5fr) minmax(160px,0.7fr) auto;gap:10px;align-items:center;padding:9px 10px;border-radius:8px;background:color-mix(in srgb, var(--comfy-input-bg) 88%, transparent);">
                            <div style="font-size:13px;line-height:1.25;word-break:break-word;">${filename}</div>
                            <div style="font-size:12px;color:var(--descrip-text,#9aa4b6);">${precision}</div>
                            <div style="font-size:12px;color:var(--descrip-text,#9aa4b6);">${source}</div>
                            <div style="display:flex;gap:8px;justify-content:flex-end;">${actions}</div>
                        </div>
                    `;
                })
                .join("");

            chunks.push(`
                <div style="border:1px solid var(--border-default,#3c4452);border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:8px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                        <div style="display:flex;flex-direction:column;gap:2px;">
                            <div style="font-size:15px;font-weight:700;line-height:1.2;">${title}</div>
                            <div style="display:flex;gap:10px;align-items:center;">${base}<span style="font-size:11px;color:#9aa4b6;">${category}</span></div>
                        </div>
                        ${installedBadge}
                    </div>
                    ${variantsHtml}
                </div>
            `);
        }
        this.body.innerHTML = chunks.join("");
        this.bindGroupActions();
    }

    findVariantByKey(key) {
        const [groupId, indexRaw] = String(key || "").split(":");
        const index = Number(indexRaw);
        if (!groupId || !Number.isFinite(index)) return null;
        const group = this.groups.find((g) => String(g.group_id) === groupId);
        if (!group) return null;
        const variant = Array.isArray(group.variants) ? group.variants[index] : null;
        if (!variant) return null;
        return { group, variant };
    }

    bindGroupActions() {
        const buttons = this.body.querySelectorAll("button[data-action][data-key]");
        buttons.forEach((button) => {
            button.onclick = async () => {
                const action = button.getAttribute("data-action");
                const key = button.getAttribute("data-key");
                const pair = this.findVariantByKey(key);
                if (!pair) return;
                if (action === "download") {
                    await this.downloadVariant(pair.group, pair.variant, button);
                } else if (action === "use") {
                    await this.useVariant(pair.group, pair.variant, button);
                } else if (action === "delete") {
                    await this.deleteVariant(pair.group, pair.variant, button);
                }
            };
        });
    }

    async downloadVariant(group, variant, button) {
        if (!variant?.url) {
            showToast({ severity: "warn", summary: "No URL", detail: "This model variant has no downloadable URL." });
            return;
        }
        button.disabled = true;
        button.textContent = "Queued";
        const payload = {
            models: [
                {
                    filename: variant.filename,
                    url: variant.url,
                    folder: group.category,
                },
            ],
        };
        const resp = await this.fetchExplorer("/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!resp.ok) {
            button.disabled = false;
            button.textContent = "Download";
            showToast({ severity: "error", summary: "Queue failed", detail: `HTTP ${resp.status}` });
            return;
        }
        showToast({ severity: "info", summary: "Queued", detail: `${variant.filename} queued for download.` });
        await wait(300);
        await this.refreshGroups();
    }

    async useVariant(group, variant, button) {
        button.disabled = true;
        button.textContent = "Using...";
        try {
            const resp = await this.fetchExplorer("/use", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filename: variant.filename,
                    category: group.category,
                }),
            });
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }
            const data = await resp.json();
            const modelPath = String(data?.model_path || "").trim();
            const category = String(data?.category || group.category || "").trim();
            if (!modelPath) {
                throw new Error("Missing model path from backend.");
            }
            await addModelNodeFromSelection(category, modelPath);
            showToast({
                severity: "success",
                summary: "Model node added",
                detail: `Inserted node with ${variant.filename}`,
            });
        } catch (error) {
            showToast({
                severity: "error",
                summary: "Use failed",
                detail: String(error),
            });
        } finally {
            button.disabled = false;
            button.textContent = "Use";
        }
    }

    async deleteVariant(group, variant, button) {
        const ok = window.confirm(`Delete local file for "${variant.filename}"?`);
        if (!ok) return;
        button.disabled = true;
        button.textContent = "Deleting...";
        try {
            const resp = await this.fetchExplorer("/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filename: variant.filename,
                    category: group.category,
                    model_path: variant.model_path,
                }),
            });
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }
            showToast({
                severity: "success",
                summary: "Deleted",
                detail: `${variant.filename} removed from local models.`,
            });
            await this.refreshGroups();
        } catch (error) {
            showToast({
                severity: "error",
                summary: "Delete failed",
                detail: String(error),
            });
            button.disabled = false;
            button.textContent = "Delete";
        }
    }
}

const modelExplorerDialog = new ModelExplorerDialog();

const registerGlobalAction = (name, fn) => {
    if (typeof window === "undefined") return;
    window.hfDownloader = window.hfDownloader || {};
    window.hfDownloader[name] = fn;
};

app.registerExtension({
    name: "hfModelExplorer",
    setup() {
        registerGlobalAction("showModelExplorer", () => {
            void modelExplorerDialog.show();
        });
    },
});
