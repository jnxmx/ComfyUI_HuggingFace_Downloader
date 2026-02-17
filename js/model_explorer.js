import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
const MODEL_EXPLORER_API_BASE = "/hf_downloader_model_explorer_v2";
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

const TEMPLATE_DIALOG_TOKENS = Object.freeze({
    surface: "var(--base-background, var(--interface-panel-surface, var(--comfy-menu-bg, #1f2128)))",
    panel: "var(--modal-panel-background, var(--base-background, var(--comfy-menu-bg, #1f2128)))",
    border: "var(--interface-stroke, var(--border-color, var(--border-default, #3c4452)))",
    text: "var(--input-text, var(--text-color, var(--p-text-color, #e5e7eb)))",
    shadow: "var(--shadow-interface, 0 12px 28px rgba(0, 0, 0, 0.45))",
});

const applyTemplateDialogOverlayStyle = (overlay, zIndex = 9100) => {
    Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        width: "100vw",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.5)",
        zIndex: String(zIndex),
        padding: "16px",
        boxSizing: "border-box",
    });
};

const applyTemplateDialogPanelStyle = (panel, sizeStyle = {}) => {
    panel.classList.add("base-widget-layout", "rounded-2xl", "overflow-hidden", "relative");
    Object.assign(panel.style, {
        background: TEMPLATE_DIALOG_TOKENS.surface,
        color: TEMPLATE_DIALOG_TOKENS.text,
        border: `1px solid ${TEMPLATE_DIALOG_TOKENS.border}`,
        borderRadius: "16px",
        boxShadow: TEMPLATE_DIALOG_TOKENS.shadow,
        display: "flex",
        flexDirection: "column",
        gap: "0",
        overflow: "hidden",
        fontFamily: "var(--font-inter, Inter, sans-serif)",
        ...sizeStyle,
    });
};

const createDialogCloseIconButton = (onClose) => {
    const closeIconButton = document.createElement("button");
    closeIconButton.type = "button";
    closeIconButton.innerHTML = "<i class=\"pi pi-times\"></i>";
    Object.assign(closeIconButton.style, {
        width: "40px",
        height: "40px",
        borderRadius: "10px",
        border: "none",
        background: "var(--modal-panel-background, var(--comfy-input-bg))",
        color: "var(--input-text)",
        fontSize: "14px",
        lineHeight: "1",
        cursor: "pointer",
        padding: "0",
        display: "grid",
        placeItems: "center",
        transition: "background-color 120ms ease, color 120ms ease",
        flexShrink: "0",
        flex: "0 0 40px",
        marginLeft: "auto",
        alignSelf: "center",
    });
    const closeIconGlyph = closeIconButton.querySelector("i");
    if (closeIconGlyph) {
        closeIconGlyph.style.fontSize = "18px";
        closeIconGlyph.style.lineHeight = "1";
    }
    closeIconButton.onmouseenter = () => {
        closeIconButton.style.background = "var(--secondary-background-hover)";
    };
    closeIconButton.onmouseleave = () => {
        closeIconButton.style.background = "var(--modal-panel-background, var(--comfy-input-bg))";
    };
    closeIconButton.onclick = () => {
        if (typeof onClose === "function") {
            onClose();
        }
    };
    return closeIconButton;
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
        this.categoryList = null;
        this.baseSelect = null;
        this.precisionSelect = null;
        this.searchInput = null;
        this.installedOnlyToggle = null;
        this.baseWrap = null;
        this.precisionWrap = null;
        this.groups = [];
        this.categories = [];
        this.filters = { category: "", base: "", precision: "", search: "", installedOnly: false };
        this.loading = false;
        this.searchTimer = null;
    }

    async fetchExplorer(pathAndQuery, init = {}) {
        return await fetchWithTimeout(`${MODEL_EXPLORER_API_BASE}${pathAndQuery}`, init);
    }

    ensureStyles() {
        const styleId = "hf-model-explorer-styles";
        if (document.getElementById(styleId)) return;
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
            #hf-model-explorer-dialog .hf-me-header {
                display: flex;
                align-items: center;
                gap: 8px;
                height: 88px;
                padding: 0 24px;
                flex-shrink: 0;
                border-bottom: 1px solid var(--interface-stroke, var(--border-color, var(--border-default, #3c4452)));
            }
            #hf-model-explorer-dialog .hf-me-title {
                letter-spacing: 0;
                color: var(--input-text);
                flex: 1;
                min-width: 0;
                font-family: Inter, Arial, sans-serif;
                font-size: 24px;
                font-weight: 600;
                line-height: 32px;
            }
            #hf-model-explorer-dialog .hf-me-content {
                display: grid;
                grid-template-columns: 242px minmax(0, 1fr);
                min-height: 0;
                flex: 1 1 auto;
                overflow: hidden;
            }
            #hf-model-explorer-dialog .hf-me-sidebar {
                display: flex;
                flex-direction: column;
                min-height: 0;
                padding: 14px 10px 12px;
                border-right: 1px solid var(--interface-stroke, var(--border-color, var(--border-default, #3c4452)));
                background: color-mix(in srgb, var(--modal-panel-background, var(--comfy-input-bg)) 82%, var(--base-background, #111319) 18%);
            }
            #hf-model-explorer-dialog .hf-me-sidebar-title {
                font-size: 30px;
                font-weight: 700;
                line-height: 1.15;
                color: var(--input-text);
                margin: 0 8px 12px;
            }
            #hf-model-explorer-dialog .hf-me-sidebar-group-label {
                color: var(--descrip-text, #9aa4b6);
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                font-weight: 600;
                margin: 6px 8px 8px;
            }
            #hf-model-explorer-dialog .hf-me-category-list {
                display: flex;
                flex-direction: column;
                gap: 4px;
                overflow: auto;
                min-height: 0;
                padding-right: 4px;
            }
            #hf-model-explorer-dialog .hf-me-category-item {
                appearance: none;
                border: 1px solid transparent;
                border-radius: 10px;
                background: transparent;
                color: var(--input-text);
                font-size: 15px;
                font-weight: 500;
                line-height: 1.2;
                text-align: left;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                min-height: 42px;
                padding: 0 12px;
                cursor: pointer;
                transition: background-color 120ms ease, border-color 120ms ease;
            }
            #hf-model-explorer-dialog .hf-me-category-item:hover {
                background: var(--secondary-background-hover, #3a4458);
            }
            #hf-model-explorer-dialog .hf-me-category-item.is-active {
                background: var(--secondary-background, #2f3747);
                border-color: var(--interface-stroke, var(--border-color, var(--border-default, #3c4452)));
            }
            #hf-model-explorer-dialog .hf-me-category-name {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            #hf-model-explorer-dialog .hf-me-category-count {
                color: var(--descrip-text, #9aa4b6);
                font-size: 12px;
                font-weight: 600;
                flex: 0 0 auto;
            }
            #hf-model-explorer-dialog .hf-me-main-pane {
                display: flex;
                flex-direction: column;
                min-width: 0;
                min-height: 0;
            }
            #hf-model-explorer-dialog .hf-me-search-wrap {
                padding: 14px 16px 10px;
            }
            #hf-model-explorer-dialog .hf-me-filters {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
                padding: 0 16px 10px;
                align-items: flex-end;
            }
            #hf-model-explorer-dialog .hf-me-field {
                display: flex;
                flex-direction: column;
                gap: 4px;
                min-width: 180px;
            }
            #hf-model-explorer-dialog .hf-me-field-label {
                color: var(--descrip-text, #9aa4b6);
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                font-weight: 600;
            }
            #hf-model-explorer-dialog .hf-me-input {
                background: var(--comfy-input-bg);
                border: 1px solid var(--border-default);
                color: var(--input-text);
                border-radius: 8px;
                height: 38px;
                padding: 0 10px;
                font-size: 14px;
                font-family: var(--font-inter, Inter, sans-serif);
                outline: none;
                box-sizing: border-box;
                width: 100%;
            }
            #hf-model-explorer-dialog .hf-me-input:focus {
                border-color: color-mix(in srgb, var(--primary-background, #3b82f6) 70%, var(--border-default, #3c4452) 30%);
                box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary-background, #3b82f6) 35%, transparent);
            }
            #hf-model-explorer-dialog .hf-me-toggle-row {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 6px 16px 12px;
                border-bottom: 1px solid var(--interface-stroke, var(--border-color, var(--border-default, #3c4452)));
                color: var(--descrip-text, #9aa4b6);
                font-size: 13px;
            }
            #hf-model-explorer-dialog .hf-me-toggle-label {
                display: inline-flex;
                align-items: center;
                gap: 10px;
                cursor: pointer;
                user-select: none;
            }
            #hf-model-explorer-dialog .hf-me-toggle.p-toggleswitch {
                position: relative;
                display: inline-block;
                width: 46px;
                height: 26px;
                vertical-align: middle;
                flex-shrink: 0;
            }
            #hf-model-explorer-dialog .hf-me-toggle .p-toggleswitch-input {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                margin: 0;
                opacity: 0;
                z-index: 1;
                cursor: pointer;
            }
            #hf-model-explorer-dialog .hf-me-toggle .p-toggleswitch-slider {
                position: absolute;
                inset: 0;
                border-radius: 999px;
                border: 1px solid var(--border-default, #4b5563);
                background: var(--secondary-background, #2a2f3a);
                transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
                box-sizing: border-box;
            }
            #hf-model-explorer-dialog .hf-me-toggle .p-toggleswitch-slider::before {
                content: "";
                position: absolute;
                top: 2px;
                left: 2px;
                width: 20px;
                height: 20px;
                border-radius: 999px;
                border: 1px solid color-mix(in srgb, var(--border-default, #4b5563) 85%, #000 15%);
                background: var(--comfy-input-bg, #1f2128);
                box-sizing: border-box;
                transition: transform 120ms ease, background-color 120ms ease, border-color 120ms ease;
            }
            #hf-model-explorer-dialog .hf-me-toggle.p-toggleswitch-checked .p-toggleswitch-slider {
                background: var(--primary-background, #3b82f6);
                border-color: var(--primary-background, #3b82f6);
            }
            #hf-model-explorer-dialog .hf-me-toggle.p-toggleswitch-checked .p-toggleswitch-slider::before {
                transform: translateX(20px);
                background: var(--comfy-menu-bg, #111319);
            }
            #hf-model-explorer-dialog .hf-me-toggle.p-focus .p-toggleswitch-slider {
                box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary-background, #3b82f6) 40%, transparent);
            }
            #hf-model-explorer-dialog .hf-me-body {
                padding: 12px 16px 18px;
                overflow: auto;
                display: flex;
                flex-direction: column;
                gap: 8px;
                min-height: 0;
                flex: 1 1 auto;
                font-size: 13px;
                line-height: 1.45;
                font-family: var(--font-inter, Inter, sans-serif);
                color: var(--base-foreground, #e5e7eb);
            }
            #hf-model-explorer-dialog .hf-me-row {
                display: grid;
                grid-template-columns: minmax(0, 1.55fr) minmax(86px, 0.45fr) minmax(130px, 0.55fr) 214px;
                align-items: center;
                gap: 8px;
                min-height: 48px;
                border-radius: 12px;
                border: 1px solid var(--interface-stroke, var(--border-color, var(--border-default, #3c4452)));
                background: var(--comfy-input-bg, #2b3242);
                padding: 4px 10px;
                box-sizing: border-box;
            }
            #hf-model-explorer-dialog .hf-me-main {
                min-width: 0;
                display: flex;
                flex-direction: column;
                justify-content: center;
                gap: 2px;
            }
            #hf-model-explorer-dialog .hf-me-file {
                font-size: 15px;
                font-weight: 600;
                line-height: 1.25;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #hf-model-explorer-dialog .hf-me-base {
                font-size: 12px;
                color: var(--descrip-text, #9aa4b6);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #hf-model-explorer-dialog .hf-me-installed {
                font-size: 11px;
                color: #56d78f;
                font-weight: 700;
                line-height: 1;
                letter-spacing: 0.02em;
                text-transform: uppercase;
            }
            #hf-model-explorer-dialog .hf-me-precision {
                font-size: 12px;
                color: var(--descrip-text, #9aa4b6);
                text-transform: uppercase;
                letter-spacing: 0.03em;
                white-space: nowrap;
            }
            #hf-model-explorer-dialog .hf-me-category {
                font-size: 12px;
                color: var(--descrip-text, #9aa4b6);
                text-transform: capitalize;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #hf-model-explorer-dialog .hf-me-actions {
                display: flex;
                align-items: center;
                justify-content: flex-end;
                gap: 8px;
                width: 100%;
                min-width: 0;
            }
            #hf-model-explorer-dialog .hf-me-action-btn {
                min-height: 38px;
                min-width: 94px;
                padding: 0.45rem 0.9rem;
                border-radius: 10px;
                border: none;
                color: var(--base-foreground);
                font-size: 14px;
                font-weight: 600;
                font-family: var(--font-inter, Inter, sans-serif);
                line-height: 1;
                cursor: pointer;
                box-shadow: none;
                transition: background-color 120ms ease, opacity 120ms ease;
                white-space: nowrap;
                display: inline-flex;
                align-items: center;
                justify-content: center;
            }
            #hf-model-explorer-dialog .hf-me-action-btn:disabled {
                opacity: 0.6;
                cursor: default;
            }
            #hf-model-explorer-dialog .hf-me-action-btn--secondary {
                background: var(--secondary-background, #3a4458);
                color: var(--base-foreground);
            }
            #hf-model-explorer-dialog .hf-me-action-btn--secondary:hover:not(:disabled) {
                background: var(--secondary-background-hover, #4a5469);
            }
            #hf-model-explorer-dialog .hf-me-action-btn--primary {
                background: var(--primary-background, #2786e5);
                color: var(--base-foreground);
            }
            #hf-model-explorer-dialog .hf-me-action-btn--primary:hover:not(:disabled) {
                background: var(--primary-background-hover, #3f98ef);
            }
            #hf-model-explorer-dialog .hf-me-action-btn--destructive {
                background: var(--destructive-background, #d24a4a);
                color: #fff;
            }
            #hf-model-explorer-dialog .hf-me-action-btn--destructive:hover:not(:disabled) {
                background: var(--destructive-background-hover, #dd5c5c);
            }
            #hf-model-explorer-dialog .hf-me-empty {
                padding: 30px;
                color: var(--descrip-text, #9aa4b6);
            }
            @media (max-width: 1024px) {
                #hf-model-explorer-dialog .hf-me-content {
                    grid-template-columns: minmax(0, 1fr);
                }
                #hf-model-explorer-dialog .hf-me-sidebar {
                    border-right: none;
                    border-bottom: 1px solid var(--interface-stroke, var(--border-color, var(--border-default, #3c4452)));
                    max-height: 220px;
                }
                #hf-model-explorer-dialog .hf-me-row {
                    grid-template-columns: minmax(0, 1fr) auto;
                    gap: 6px;
                }
                #hf-model-explorer-dialog .hf-me-main {
                    grid-column: 1;
                    grid-row: 1;
                }
                #hf-model-explorer-dialog .hf-me-precision {
                    grid-column: 1;
                    grid-row: 2;
                }
                #hf-model-explorer-dialog .hf-me-category {
                    grid-column: 1;
                    grid-row: 3;
                }
                #hf-model-explorer-dialog .hf-me-actions {
                    grid-column: 2;
                    grid-row: 1 / span 3;
                    align-self: center;
                }
            }
        `;
        document.head.appendChild(style);
    }

    async show() {
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
        this.ensureStyles();
        const overlay = document.createElement("div");
        overlay.id = "hf-model-explorer-dialog";
        applyTemplateDialogOverlayStyle(overlay, 9100);
        overlay.style.display = "none";
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                this.close();
            }
        });

        const panel = document.createElement("div");
        applyTemplateDialogPanelStyle(panel, {
            width: "min(1220px, 100%)",
            maxHeight: "92vh",
            padding: "0",
        });
        panel.id = "hf-me-panel";

        const headerWrap = document.createElement("div");
        headerWrap.className = "hf-me-header";

        const headerTitle = document.createElement("div");
        headerTitle.className = "hf-me-title";
        headerTitle.textContent = "Model Explorer";
        headerWrap.appendChild(headerTitle);

        const closeIconButton = createDialogCloseIconButton(() => this.close());
        headerWrap.appendChild(closeIconButton);
        panel.appendChild(headerWrap);

        const contentWrap = document.createElement("div");
        contentWrap.className = "hf-me-content";
        panel.appendChild(contentWrap);

        const sidebar = document.createElement("div");
        sidebar.className = "hf-me-sidebar";
        sidebar.innerHTML = `
            <div class="hf-me-sidebar-title">Model Library</div>
            <div class="hf-me-sidebar-group-label">By type</div>
            <div id="hf-me-category-list" class="hf-me-category-list"></div>
        `;
        contentWrap.appendChild(sidebar);

        const mainPane = document.createElement("div");
        mainPane.className = "hf-me-main-pane";
        contentWrap.appendChild(mainPane);

        const searchWrap = document.createElement("div");
        searchWrap.className = "hf-me-search-wrap";
        searchWrap.innerHTML = `<input id="hf-me-search" class="hf-me-input" type="text" placeholder="Search..." />`;
        mainPane.appendChild(searchWrap);

        const filterWrap = document.createElement("div");
        filterWrap.className = "hf-me-filters";
        filterWrap.innerHTML = `
            <label id="hf-me-precision-wrap" class="hf-me-field">
                <span class="hf-me-field-label">Precision</span>
                <select id="hf-me-precision" class="hf-me-input"></select>
            </label>
            <label id="hf-me-base-wrap" class="hf-me-field">
                <span class="hf-me-field-label">Base models</span>
                <select id="hf-me-base" class="hf-me-input"></select>
            </label>
        `;
        mainPane.appendChild(filterWrap);

        const installedOnlyRow = document.createElement("div");
        installedOnlyRow.id = "hf-me-installed-only-row";
        installedOnlyRow.className = "hf-me-toggle-row";
        mainPane.appendChild(installedOnlyRow);

        const toggleLabel = document.createElement("label");
        toggleLabel.className = "hf-me-toggle-label";

        const toggleWrap = document.createElement("span");
        toggleWrap.className = "hf-me-toggle p-toggleswitch p-component";

        const toggleInput = document.createElement("input");
        toggleInput.id = "hf-me-installed-only";
        toggleInput.type = "checkbox";
        toggleInput.className = "p-toggleswitch-input";
        toggleInput.setAttribute("role", "switch");
        toggleInput.setAttribute("aria-label", "Show downloaded only");

        const toggleSlider = document.createElement("span");
        toggleSlider.className = "p-toggleswitch-slider";

        toggleWrap.append(toggleInput, toggleSlider);
        toggleLabel.appendChild(toggleWrap);

        const toggleText = document.createElement("span");
        toggleText.textContent = "Show downloaded only";
        toggleLabel.appendChild(toggleText);
        installedOnlyRow.appendChild(toggleLabel);

        const updateSliderState = () => {
            toggleWrap.classList.toggle("p-toggleswitch-checked", Boolean(toggleInput.checked));
        };
        toggleInput.addEventListener("focus", () => toggleWrap.classList.add("p-focus"));
        toggleInput.addEventListener("blur", () => toggleWrap.classList.remove("p-focus"));
        toggleInput.addEventListener("change", () => updateSliderState());
        updateSliderState();

        const body = document.createElement("div");
        body.id = "hf-me-body";
        body.className = "hf-me-body";
        mainPane.appendChild(body);

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        this.element = overlay;
        this.body = body;
        this.categoryList = panel.querySelector("#hf-me-category-list");
        this.baseSelect = panel.querySelector("#hf-me-base");
        this.precisionSelect = panel.querySelector("#hf-me-precision");
        this.searchInput = panel.querySelector("#hf-me-search");
        this.installedOnlyToggle = toggleInput;
        this.baseWrap = panel.querySelector("#hf-me-base-wrap");
        this.precisionWrap = panel.querySelector("#hf-me-precision-wrap");
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
        if (this.installedOnlyToggle) {
            this.installedOnlyToggle.checked = this.filters.installedOnly;
            updateSliderState();
            this.installedOnlyToggle.onchange = async () => {
                this.filters.installedOnly = Boolean(this.installedOnlyToggle.checked);
                updateSliderState();
                await this.refreshFiltersAndGroups();
            };
        }
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
            if (this.filters.installedOnly) params.set("installed_only", "true");
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
        const categoryKey = String(this.filters.category || "").toLowerCase();
        const filterAllowed = ["checkpoints", "diffusion_models", "loras", "controlnet"].includes(categoryKey);
        this.baseWrap.style.display = filterAllowed ? "flex" : "none";
        this.precisionWrap.style.display = filterAllowed ? "flex" : "none";
        if (!filterAllowed) {
            this.filters.base = "";
            this.filters.precision = "";
        }
    }

    async refreshGroups() {
        this.setLoading(true);
        try {
            const params = new URLSearchParams();
            if (this.filters.category) params.set("category", this.filters.category);
            if (this.filters.base) params.set("base", this.filters.base);
            if (this.filters.precision) params.set("precision", this.filters.precision);
            if (this.filters.search) params.set("search", this.filters.search);
            if (this.filters.installedOnly) params.set("installed_only", "true");
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
        if (!this.categoryList) return;
        this.categoryList.innerHTML = "";

        const createCategoryButton = (value, label, count) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "hf-me-category-item";
            if (value === this.filters.category) {
                button.classList.add("is-active");
            }
            button.innerHTML = `
                <span class="hf-me-category-name">${escapeHtml(label)}</span>
                <span class="hf-me-category-count">${Number(count || 0)}</span>
            `;
            button.onclick = () => {
                if (this.filters.category === value) return;
                this.filters.category = value;
                this.filters.base = "";
                this.filters.precision = "";
                this.renderCategorySelect();
                void this.refreshFiltersAndGroups();
            };
            this.categoryList.appendChild(button);
        };

        const totalCount = this.categories.reduce((sum, item) => sum + Number(item?.count || 0), 0);
        createCategoryButton("", "All Models", totalCount);

        const sortedCategories = [...this.categories].sort((a, b) =>
            String(a?.id || "").localeCompare(String(b?.id || ""))
        );
        for (const item of sortedCategories) {
            createCategoryButton(String(item?.id || ""), String(item?.id || ""), item?.count || 0);
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
            this.body.innerHTML = `<div class="hf-me-empty">Loading Model Explorer...</div>`;
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
            this.body.innerHTML = `<div class="hf-me-empty">No models found for current filters.</div>`;
            return;
        }

        const rows = [];
        for (const group of this.groups) {
            const categoryHtml = escapeHtml(group.category || "");
            const baseLabel = group.base ? escapeHtml(group.base) : "";
            const variants = Array.isArray(group.variants) ? group.variants : [];
            if (!variants.length) continue;

            const variantRows = variants
                .map((variant, index) => {
                    const filename = escapeHtml(variant.filename || "");
                    const precisionRaw = String(variant.precision || "").trim().toLowerCase();
                    const showPrecision = precisionRaw && precisionRaw !== "unknown";
                    const precision = showPrecision ? escapeHtml(precisionRaw) : "";
                    const installed = Boolean(variant.installed);
                    const variantKey = `${group.group_id}:${index}`;
                    const installedBadge = installed
                        ? `<span class="hf-me-installed">Installed</span>`
                        : "";
                    const actions = installed
                        ? `
                            <button class="hf-me-action-btn hf-me-action-btn--destructive" data-action="delete" data-key="${variantKey}">Delete</button>
                            <button class="hf-me-action-btn hf-me-action-btn--primary" data-action="use" data-key="${variantKey}">Use</button>
                          `
                        : `
                            <button class="hf-me-action-btn hf-me-action-btn--secondary" data-action="download" data-key="${variantKey}">Download</button>
                          `;
                    const baseRow = baseLabel ? `<div class="hf-me-base">Base: ${baseLabel}</div>` : "";
                    const precisionColumn = showPrecision ? precision : "";

                    return `
                        <div class="hf-me-row">
                            <div class="hf-me-main">
                                <div class="hf-me-file">${filename}</div>
                                ${baseRow}
                                ${installedBadge}
                            </div>
                            <div class="hf-me-precision">${precisionColumn}</div>
                            <div class="hf-me-category">${categoryHtml}</div>
                            <div class="hf-me-actions">${actions}</div>
                        </div>
                    `;
                })
                .join("");
            if (variantRows) {
                rows.push(variantRows);
            }
        }
        if (!rows.length) {
            this.body.innerHTML = `<div class="hf-me-empty">No models found for current filters.</div>`;
        } else {
            this.body.innerHTML = rows.join("");
        }
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
                    folder: variant.directory || group.category,
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
