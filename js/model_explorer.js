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
const MODEL_EXPLORER_OTHER_CATEGORY_KEY = "__other__";
const MODEL_EXPLORER_DEFERRED_CATEGORY_ORDER = Object.freeze([
    "animatediff_models",
    "animatediff_motion_lora",
]);
const MODEL_EXPLORER_PRIMARY_CATEGORIES = new Set([
    "checkpoints",
    "configs",
    "controlnet",
    "clip",
    "clip_vision",
    "custom_nodes",
    "diffusers",
    "diffusion_models",
    "embeddings",
    "gligen",
    "hypernetworks",
    "ipadapter",
    "loras",
    "model_patches",
    "style_models",
    "text_encoders",
    "upscale_models",
    "vae",
    "vae_approx",
    "audio_encoders",
    "animatediff_models",
    "animatediff_motion_lora",
    "sams",
    "ultralytics",
    "depthanything",
    "photomaker",
    "prompt_expansion",
    "tokenizers",
    "unet",
    "onnx",
]);

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
    closeIconButton.className = "p-button p-component";
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
        this.baseControl = null;
        this.precisionControl = null;
        this.searchInput = null;
        this.installedOnlyToggle = null;
        this.baseWrap = null;
        this.precisionWrap = null;
        this.filterWrap = null;
        this.activeFilterPanel = null;
        this.otherCategoryIds = new Set();
        this.groups = [];
        this.categories = [];
        this.filters = { category: "", base: [], precision: [], search: "", installedOnly: false };
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
            #hf-model-explorer-dialog .hf-me-shell {
                display: grid;
                grid-template-columns: 14rem minmax(0, 1fr);
                height: 100%;
                width: 100%;
                overflow: hidden;
            }
            #hf-model-explorer-dialog .hf-me-left-panel {
                background: var(--modal-panel-background, var(--comfy-menu-bg, #1f2128));
                display: flex;
                flex-direction: column;
                height: 100%;
                overflow: hidden;
                border-right: 1px solid var(--interface-stroke, var(--border-color, var(--border-default, #3c4452)));
            }
            #hf-model-explorer-dialog .hf-me-left-header {
                display: flex;
                width: 100%;
                height: 72px;
                flex-shrink: 0;
                padding-left: 24px;
                padding-right: 24px;
                align-items: center;
            }
            #hf-model-explorer-dialog .hf-me-left-title {
                flex: 1 1 auto;
                user-select: none;
                font-size: 1.95rem;
                font-weight: 600;
                color: var(--base-foreground, var(--input-text, #e5e7eb));
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #hf-model-explorer-dialog .hf-me-left-scroll {
                display: flex;
                width: 100%;
                flex: 1 1 auto;
                min-height: 0;
                overflow-y: auto;
                gap: 0.25rem;
                flex-direction: column;
                background: var(--modal-panel-background, var(--comfy-menu-bg, #1f2128));
                padding: 0 0.75rem 0.75rem 0.75rem;
            }
            #hf-model-explorer-dialog .hf-me-nav-title {
                display: flex;
                align-items: center;
                margin: 0;
                padding: 1.25rem 0.75rem 0.25rem;
            }
            #hf-model-explorer-dialog .hf-me-nav-title-text {
                font-size: 0.75rem;
                font-weight: 700;
                text-transform: uppercase;
                color: var(--text-secondary, var(--descrip-text, #9aa4b6));
                letter-spacing: 0.04em;
            }
            #hf-model-explorer-dialog .hf-me-category-list {
                display: flex;
                flex-direction: column;
                gap: 0.15rem;
                min-height: 0;
            }
            #hf-model-explorer-dialog .hf-me-nav-item {
                appearance: none;
                border: none;
                background: transparent;
                width: 100%;
                display: flex;
                align-items: center;
                border-radius: 0.375rem;
                padding: 0.75rem 1rem;
                color: var(--base-foreground, var(--input-text, #e5e7eb));
                font-size: 0.875rem;
                font-weight: 500;
                text-align: left;
                cursor: pointer;
                transition: background-color 120ms ease;
                user-select: none;
            }
            #hf-model-explorer-dialog .hf-me-nav-item:hover {
                background: var(--interface-menu-component-surface-hovered, var(--secondary-background-hover, #3a4458));
            }
            #hf-model-explorer-dialog .hf-me-nav-item.is-active {
                background: var(--interface-menu-component-surface-selected, var(--secondary-background, #2f3747));
            }
            #hf-model-explorer-dialog .hf-me-nav-label {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                text-transform: none;
            }
            #hf-model-explorer-dialog .hf-me-main-panel {
                display: flex;
                flex-direction: column;
                background: var(--base-background, var(--comfy-menu-bg, #111319));
                overflow: hidden;
                min-width: 0;
                min-height: 0;
            }
            #hf-model-explorer-dialog .hf-me-main-header {
                width: 100%;
                height: 72px;
                padding: 0 24px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                flex-shrink: 0;
            }
            #hf-model-explorer-dialog .hf-me-search-wrap {
                display: flex;
                flex: 1 1 auto;
                min-width: 0;
                max-width: 100%;
            }
            #hf-model-explorer-dialog .hf-me-searchbox {
                position: relative;
                display: flex;
                width: min(38rem, 100%);
                align-items: center;
                gap: 0.5rem;
                background: var(--comfy-input-bg, #2b3242);
                color: var(--input-text);
                border-radius: 0.5rem;
                height: 40px;
                padding: 0.5rem 1rem;
            }
            #hf-model-explorer-dialog .hf-me-search-icon {
                color: var(--text-secondary, var(--descrip-text, #9aa4b6));
                font-size: 0.95rem;
                pointer-events: none;
                padding-left: 0.2rem;
            }
            #hf-model-explorer-dialog .hf-me-search-input {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                border: none;
                outline: none;
                background: transparent;
                color: var(--input-text);
                font-size: 0.96rem;
                padding-left: 2.55rem;
                padding-right: 0.75rem;
                box-sizing: border-box;
                border-radius: 0.5rem;
            }
            #hf-model-explorer-dialog .hf-me-search-input::placeholder {
                color: var(--text-secondary, var(--descrip-text, #9aa4b6));
            }
            #hf-model-explorer-dialog .hf-me-header-actions {
                display: flex;
                align-items: center;
                gap: 0.35rem;
                flex: 0 0 auto;
            }
            #hf-model-explorer-dialog .hf-me-close-btn {
                margin-left: 0;
            }
            #hf-model-explorer-dialog .hf-me-filter-row {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                padding: 8px 24px 8px;
                flex-wrap: nowrap;
                flex-shrink: 0;
            }
            #hf-model-explorer-dialog .hf-me-filter {
                position: relative;
                display: inline-block;
            }
            #hf-model-explorer-dialog .hf-me-filter-trigger {
                height: 40px;
                min-width: 170px;
                position: relative;
                display: inline-flex;
                align-items: center;
                justify-content: flex-start;
                gap: 0.5rem;
                border-radius: 0.5rem;
                background: var(--secondary-background, #2f3747);
                color: var(--base-foreground, var(--input-text, #e5e7eb));
                border: 2.5px solid transparent;
                transition: border-color 140ms ease, background-color 140ms ease;
                padding: 0 0.9rem 0 0.95rem;
                cursor: pointer;
                font-size: 0.92rem;
                font-weight: 500;
                text-align: left;
            }
            #hf-model-explorer-dialog .hf-me-filter-trigger:hover {
                background: var(--secondary-background-hover, #3a4458);
            }
            #hf-model-explorer-dialog .hf-me-filter.is-open .hf-me-filter-trigger,
            #hf-model-explorer-dialog .hf-me-filter.has-selection .hf-me-filter-trigger {
                border-color: var(--node-component-border, var(--primary-background, #3b82f6));
            }
            #hf-model-explorer-dialog .hf-me-filter-label {
                display: inline-flex;
                align-items: center;
                min-width: 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #hf-model-explorer-dialog .hf-me-filter-badge {
                pointer-events: none;
                position: absolute;
                top: -7px;
                right: -7px;
                width: 20px;
                height: 20px;
                border-radius: 999px;
                background: var(--primary-background, #2786e5);
                color: var(--base-foreground, #fff);
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 11px;
                font-weight: 700;
                line-height: 1;
            }
            #hf-model-explorer-dialog .hf-me-filter-caret {
                margin-left: auto;
                color: var(--text-secondary, var(--descrip-text, #9aa4b6));
                pointer-events: none;
                font-size: 0.9rem;
            }
            #hf-model-explorer-dialog .hf-me-filter-popover {
                position: absolute;
                top: calc(100% + 8px);
                left: 0;
                min-width: 22rem;
                max-width: 25rem;
                z-index: 7;
                border-radius: 0.75rem;
                border: 1px solid var(--border-default, #4b5563);
                background: var(--base-background, #111319);
                padding: 0.55rem;
                box-shadow: var(--shadow-interface, 0 12px 28px rgba(0, 0, 0, 0.45));
            }
            #hf-model-explorer-dialog .hf-me-filter-search {
                position: relative;
                width: 100%;
                height: 38px;
                border-radius: 0.5rem;
                border: 1px solid var(--border-default, #4b5563);
                background: var(--comfy-input-bg, #2b3242);
                margin-bottom: 0.65rem;
            }
            #hf-model-explorer-dialog .hf-me-filter-search-icon {
                position: absolute;
                left: 10px;
                top: 50%;
                transform: translateY(-50%);
                color: var(--text-secondary, var(--descrip-text, #9aa4b6));
                font-size: 0.95rem;
                pointer-events: none;
            }
            #hf-model-explorer-dialog .hf-me-filter-search-input {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                border: none;
                outline: none;
                background: transparent;
                color: var(--input-text);
                font-size: 0.9rem;
                border-radius: 0.5rem;
                padding: 0 0.55rem 0 2rem;
                box-sizing: border-box;
            }
            #hf-model-explorer-dialog .hf-me-filter-search-input::placeholder {
                color: var(--text-secondary, var(--descrip-text, #9aa4b6));
            }
            #hf-model-explorer-dialog .hf-me-filter-meta {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 0.5rem;
                padding: 0 0.3rem 0.35rem;
            }
            #hf-model-explorer-dialog .hf-me-filter-meta-text {
                font-size: 0.92rem;
                color: var(--base-foreground, var(--input-text, #e5e7eb));
                font-weight: 500;
            }
            #hf-model-explorer-dialog .hf-me-filter-clear-btn {
                appearance: none;
                border: none;
                background: transparent;
                color: var(--base-foreground, var(--input-text, #e5e7eb));
                font-size: 0.92rem;
                font-weight: 600;
                cursor: pointer;
                padding: 0.1rem 0.2rem;
            }
            #hf-model-explorer-dialog .hf-me-filter-clear-btn:hover {
                color: var(--primary-background, #2786e5);
            }
            #hf-model-explorer-dialog .hf-me-filter-divider {
                height: 1px;
                background: var(--border-default, #4b5563);
                margin: 0.4rem 0 0.5rem;
            }
            #hf-model-explorer-dialog .hf-me-filter-options {
                max-height: min(18rem, 45vh);
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 0.15rem;
            }
            #hf-model-explorer-dialog .hf-me-filter-option {
                appearance: none;
                border: none;
                width: 100%;
                display: flex;
                align-items: center;
                gap: 0.55rem;
                height: 38px;
                padding: 0 0.5rem;
                border-radius: 0.45rem;
                background: transparent;
                color: var(--base-foreground, var(--input-text, #e5e7eb));
                text-align: left;
                font-size: 0.92rem;
                cursor: pointer;
            }
            #hf-model-explorer-dialog .hf-me-filter-option:hover {
                background: var(--secondary-background-hover, #3a4458);
            }
            #hf-model-explorer-dialog .hf-me-filter-option-check {
                width: 18px;
                height: 18px;
                border-radius: 4px;
                background: var(--secondary-background, #2f3747);
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex: 0 0 auto;
                color: transparent;
                font-size: 10px;
            }
            #hf-model-explorer-dialog .hf-me-filter-option.is-selected .hf-me-filter-option-check {
                background: var(--primary-background, #2786e5);
                color: var(--base-foreground, #fff);
            }
            #hf-model-explorer-dialog .hf-me-filter-option-label {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            #hf-model-explorer-dialog .hf-me-filter-empty {
                padding: 0.35rem 0.5rem;
                color: var(--text-secondary, var(--descrip-text, #9aa4b6));
                font-size: 0.88rem;
            }
            #hf-model-explorer-dialog .hf-me-toggle-row {
                display: flex;
                align-items: center;
                gap: 0.75rem;
                padding: 0 24px 10px;
                border-bottom: 1px solid var(--interface-stroke, var(--border-color, var(--border-default, #3c4452)));
                flex-shrink: 0;
            }
            #hf-model-explorer-dialog .hf-me-toggle-label {
                display: inline-flex;
                align-items: center;
                gap: 0.75rem;
                cursor: pointer;
                user-select: none;
                color: var(--base-foreground, var(--input-text, #e5e7eb));
                font-size: 0.9rem;
                font-weight: 500;
            }
            #hf-model-explorer-dialog .hf-me-installed-toggle {
                flex: 0 0 auto;
                margin: 0;
                cursor: pointer;
            }
            #hf-model-explorer-dialog .hf-me-installed-toggle-wrap {
                margin: 0;
                cursor: pointer;
                flex: 0 0 auto;
            }
            #hf-model-explorer-dialog .hf-me-content-scroll {
                flex: 1 1 auto;
                overflow-y: auto;
                padding: 0 8px 12px 8px;
            }
            #hf-model-explorer-dialog .hf-me-body {
                min-height: 0;
                width: 100%;
                box-sizing: border-box;
                padding: 6px 0 10px;
                scrollbar-color: var(--secondary-background-hover, #3a4458) transparent;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            #hf-model-explorer-dialog .hf-me-row {
                display: grid;
                grid-template-columns: minmax(0, 1fr) 8rem 9.5rem 12rem;
                align-items: center;
                gap: 8px;
                min-height: 50px;
                border-radius: 12px;
                background: var(--secondary-background, #2f3747);
                padding: 5px 10px;
                transition: background-color 120ms ease;
                box-sizing: border-box;
                overflow: hidden;
            }
            #hf-model-explorer-dialog .hf-me-row:hover {
                background: var(--secondary-background-hover, #3a4458);
            }
            #hf-model-explorer-dialog .hf-me-main {
                min-width: 0;
                display: flex;
                flex-direction: column;
                gap: 1px;
            }
            #hf-model-explorer-dialog .hf-me-file {
                font-size: 1.05rem;
                font-weight: 600;
                line-height: 1.2;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                color: var(--base-foreground, var(--input-text, #e5e7eb));
            }
            #hf-model-explorer-dialog .hf-me-base {
                font-size: 0.63rem;
                line-height: 1.2;
                color: var(--text-secondary, var(--descrip-text, #9aa4b6));
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #hf-model-explorer-dialog .hf-me-installed {
                font-size: 0.62rem;
                color: #56d78f;
                font-weight: 700;
                line-height: 1.1;
                text-transform: uppercase;
            }
            #hf-model-explorer-dialog .hf-me-precision {
                font-size: 0.6rem;
                line-height: 1.1;
                letter-spacing: 0.02em;
                text-transform: uppercase;
                color: var(--text-secondary, var(--descrip-text, #9aa4b6));
                white-space: nowrap;
                text-align: left;
            }
            #hf-model-explorer-dialog .hf-me-category {
                font-size: 0.6rem;
                line-height: 1.1;
                color: var(--text-secondary, var(--descrip-text, #9aa4b6));
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                text-transform: none;
            }
            #hf-model-explorer-dialog .hf-me-actions {
                display: flex;
                align-items: center;
                justify-content: flex-end;
                gap: 6px;
                align-self: stretch;
                width: 100%;
            }
            #hf-model-explorer-dialog .hf-me-action-btn {
                position: relative;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 0.5rem;
                cursor: pointer;
                white-space: nowrap;
                appearance: none;
                border: none;
                border-radius: 0.5rem;
                text-align: center;
                min-height: 2.1rem;
                min-width: 5.4rem;
                padding: 0 0.85rem;
                font-size: 1rem;
                font-weight: 600;
                font-family: var(--font-inter, Inter, sans-serif);
                transition: background-color 120ms ease, opacity 120ms ease;
            }
            #hf-model-explorer-dialog .hf-me-action-btn:disabled {
                opacity: 0.6;
                cursor: default;
            }
            #hf-model-explorer-dialog .hf-me-action-btn--secondary {
                background: var(--secondary-background, #3a4458);
                color: var(--base-foreground, #e5e7eb);
            }
            #hf-model-explorer-dialog .hf-me-action-btn--secondary:hover:not(:disabled) {
                background: var(--secondary-background-hover, #4a5469);
            }
            #hf-model-explorer-dialog .hf-me-action-btn--primary {
                background: var(--primary-background, #2786e5);
                color: var(--base-foreground, #e5e7eb);
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
                padding: 22px 10px;
                color: var(--text-secondary, var(--descrip-text, #9aa4b6));
                font-size: 14px;
            }
            @media (max-width: 1200px) {
                #hf-model-explorer-dialog .hf-me-row {
                    grid-template-columns: minmax(0, 1fr) 7rem 8rem 10.8rem;
                }
            }
            @media (max-width: 1024px) {
                #hf-model-explorer-dialog .hf-me-shell {
                    grid-template-columns: minmax(0, 1fr);
                }
                #hf-model-explorer-dialog .hf-me-left-panel {
                    border-right: none;
                    border-bottom: 1px solid var(--interface-stroke, var(--border-color, var(--border-default, #3c4452)));
                    max-height: 230px;
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
            this.closeFilterPopover();
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
            width: "min(1600px, 100%)",
            maxHeight: "92vh",
            padding: "0",
        });
        panel.id = "hf-me-panel";
        const shell = document.createElement("div");
        shell.className = "hf-me-shell";
        panel.appendChild(shell);

        const leftPanel = document.createElement("nav");
        leftPanel.className = "hf-me-left-panel";
        leftPanel.innerHTML = `
            <header class="hf-me-left-header">
                <h2 class="hf-me-left-title">Model Explorer</h2>
            </header>
            <div class="hf-me-left-scroll">
                <div class="hf-me-nav-title">
                    <span class="hf-me-nav-title-text">By type</span>
                </div>
                <div id="hf-me-category-list" class="hf-me-category-list"></div>
            </div>
        `;
        shell.appendChild(leftPanel);

        const mainPanel = document.createElement("div");
        mainPanel.className = "hf-me-main-panel";
        shell.appendChild(mainPanel);

        const mainHeader = document.createElement("header");
        mainHeader.className = "hf-me-main-header";
        mainHeader.innerHTML = `
            <div class="hf-me-search-wrap">
                <div class="hf-me-searchbox">
                    <i class="hf-me-search-icon pi pi-search" aria-hidden="true"></i>
                    <input id="hf-me-search" class="hf-me-search-input" type="text" placeholder="Search..." />
                </div>
            </div>
        `;

        const headerActions = document.createElement("div");
        headerActions.className = "hf-me-header-actions";
        const closeIconButton = createDialogCloseIconButton(() => this.close());
        closeIconButton.classList.add("hf-me-close-btn");
        headerActions.appendChild(closeIconButton);
        mainHeader.appendChild(headerActions);
        mainPanel.appendChild(mainHeader);

        const filterWrap = document.createElement("div");
        filterWrap.className = "hf-me-filter-row";
        filterWrap.style.display = "none";
        filterWrap.innerHTML = `
            <div id="hf-me-precision-wrap" class="hf-me-filter" data-filter-key="precision">
                <button type="button" class="hf-me-filter-trigger" aria-label="Precision filter">
                    <span class="hf-me-filter-label">Precision</span>
                    <span class="hf-me-filter-badge" style="display:none;">0</span>
                    <i class="icon-[lucide--chevron-down] hf-me-filter-caret" aria-hidden="true"></i>
                </button>
                <div class="hf-me-filter-popover" style="display:none;">
                    <div class="hf-me-filter-search">
                        <i class="hf-me-filter-search-icon pi pi-search" aria-hidden="true"></i>
                        <input type="text" class="hf-me-filter-search-input" placeholder="Search..." />
                    </div>
                    <div class="hf-me-filter-meta">
                        <span class="hf-me-filter-meta-text">0 item selected</span>
                        <button type="button" class="hf-me-filter-clear-btn">Clear all</button>
                    </div>
                    <div class="hf-me-filter-divider"></div>
                    <div class="hf-me-filter-options"></div>
                </div>
            </div>
            <div id="hf-me-base-wrap" class="hf-me-filter" data-filter-key="base">
                <button type="button" class="hf-me-filter-trigger" aria-label="Base models filter">
                    <span class="hf-me-filter-label">Base models</span>
                    <span class="hf-me-filter-badge" style="display:none;">0</span>
                    <i class="icon-[lucide--chevron-down] hf-me-filter-caret" aria-hidden="true"></i>
                </button>
                <div class="hf-me-filter-popover" style="display:none;">
                    <div class="hf-me-filter-search">
                        <i class="hf-me-filter-search-icon pi pi-search" aria-hidden="true"></i>
                        <input type="text" class="hf-me-filter-search-input" placeholder="Search..." />
                    </div>
                    <div class="hf-me-filter-meta">
                        <span class="hf-me-filter-meta-text">0 item selected</span>
                        <button type="button" class="hf-me-filter-clear-btn">Clear all</button>
                    </div>
                    <div class="hf-me-filter-divider"></div>
                    <div class="hf-me-filter-options"></div>
                </div>
            </div>
        `;
        mainPanel.appendChild(filterWrap);

        const installedOnlyRow = document.createElement("div");
        installedOnlyRow.id = "hf-me-installed-only-row";
        installedOnlyRow.className = "hf-me-toggle-row";
        installedOnlyRow.innerHTML = `
            <div class="hf-me-toggle-label">
                <label class="hf-me-installed-toggle-wrap hf-manual-toggle p-toggleswitch p-component transition-transform active:scale-90">
                    <input id="hf-me-installed-only" type="checkbox" class="p-toggleswitch-input" role="switch" aria-label="Show downloaded only" />
                    <span class="p-toggleswitch-slider"></span>
                </label>
                <span>Show downloaded only</span>
            </div>
        `;
        mainPanel.appendChild(installedOnlyRow);

        const bodyScroll = document.createElement("div");
        bodyScroll.className = "hf-me-content-scroll";
        const body = document.createElement("div");
        body.id = "hf-me-body";
        body.className = "hf-me-body";
        bodyScroll.appendChild(body);
        mainPanel.appendChild(bodyScroll);

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        this.element = overlay;
        this.body = body;
        this.categoryList = panel.querySelector("#hf-me-category-list");
        this.baseControl = this.createFilterControl(panel.querySelector("#hf-me-base-wrap"), "base", "Base models");
        this.precisionControl = this.createFilterControl(panel.querySelector("#hf-me-precision-wrap"), "precision", "Precision");
        this.searchInput = panel.querySelector("#hf-me-search");
        this.installedOnlyToggle = panel.querySelector("#hf-me-installed-only");
        this.baseWrap = panel.querySelector("#hf-me-base-wrap");
        this.precisionWrap = panel.querySelector("#hf-me-precision-wrap");
        this.filterWrap = filterWrap;
        const toggleWrap = installedOnlyRow.querySelector(".hf-me-installed-toggle-wrap");
        const toggleInput = this.installedOnlyToggle;

        const updateSliderState = () => {
            if (!toggleWrap || !toggleInput) return;
            toggleWrap.classList.toggle("p-toggleswitch-checked", Boolean(toggleInput.checked));
            toggleInput.setAttribute("aria-checked", toggleInput.checked ? "true" : "false");
        };
        if (toggleInput && toggleWrap) {
            toggleInput.addEventListener("focus", () => toggleWrap.classList.add("p-focus"));
            toggleInput.addEventListener("blur", () => toggleWrap.classList.remove("p-focus"));
            toggleInput.addEventListener("change", () => updateSliderState());
            updateSliderState();
        }
        installedOnlyRow.addEventListener("click", (event) => {
            const target = event?.target;
            if (target === toggleInput || (toggleWrap && toggleWrap.contains(target))) {
                return;
            }
            if (!toggleInput) return;
            toggleInput.checked = !toggleInput.checked;
            toggleInput.dispatchEvent(new Event("change", { bubbles: true }));
        });

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

        document.addEventListener("click", (event) => {
            if (!this.element || this.element.style.display === "none") return;
            const target = event?.target;
            if (!(target instanceof Element)) return;
            if (target.closest(".hf-me-filter")) return;
            this.closeFilterPopover();
        });
    }

    async refreshAll() {
        await this.fetchCategories();
        await this.refreshFiltersAndGroups();
    }

    async refreshFiltersAndGroups() {
        await this.fetchFilters();
        await this.refreshGroups();
    }

    createFilterControl(root, key, label) {
        if (!root) return null;
        const trigger = root.querySelector(".hf-me-filter-trigger");
        const labelEl = root.querySelector(".hf-me-filter-label");
        const badgeEl = root.querySelector(".hf-me-filter-badge");
        const popover = root.querySelector(".hf-me-filter-popover");
        const searchInput = root.querySelector(".hf-me-filter-search-input");
        const metaText = root.querySelector(".hf-me-filter-meta-text");
        const clearBtn = root.querySelector(".hf-me-filter-clear-btn");
        const optionsEl = root.querySelector(".hf-me-filter-options");
        if (!trigger || !labelEl || !badgeEl || !popover || !searchInput || !metaText || !clearBtn || !optionsEl) {
            return null;
        }

        const control = {
            key,
            label,
            root,
            trigger,
            labelEl,
            badgeEl,
            popover,
            searchInput,
            metaText,
            clearBtn,
            optionsEl,
            options: [],
        };

        trigger.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const isOpen = popover.style.display !== "none";
            this.closeFilterPopover(isOpen ? null : key);
            if (!isOpen) {
                root.classList.add("is-open");
                popover.style.display = "block";
                searchInput.focus();
            }
        });

        searchInput.addEventListener("input", () => {
            this.renderFilterOptions(control);
        });

        clearBtn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!Array.isArray(this.filters[key]) || !this.filters[key].length) {
                return;
            }
            this.filters[key] = [];
            this.renderFilterControl(control);
            void this.refreshGroups();
        });

        optionsEl.addEventListener("click", (event) => {
            const target = event?.target;
            if (!(target instanceof Element)) return;
            const option = target.closest(".hf-me-filter-option");
            if (!option) return;
            const rawValue = String(option.getAttribute("data-value") || "").trim();
            if (!rawValue) return;
            const value = key === "precision" ? this.normalizePrecision(rawValue) : rawValue;
            if (!value) return;
            const current = Array.isArray(this.filters[key]) ? [...this.filters[key]] : [];
            const index = current.indexOf(value);
            if (index >= 0) {
                current.splice(index, 1);
            } else {
                current.push(value);
            }
            this.filters[key] = current;
            this.renderFilterControl(control);
            void this.refreshGroups();
        });

        return control;
    }

    closeFilterPopover(keepOpenKey = null) {
        const controls = [this.baseControl, this.precisionControl].filter(Boolean);
        controls.forEach((control) => {
            const shouldKeepOpen = keepOpenKey && control.key === keepOpenKey;
            if (shouldKeepOpen) {
                control.root.classList.add("is-open");
                control.popover.style.display = "block";
                this.activeFilterPanel = control.key;
            } else {
                control.root.classList.remove("is-open");
                control.popover.style.display = "none";
            }
        });
        if (!keepOpenKey) {
            this.activeFilterPanel = null;
        }
    }

    updateFilterOptions(key, options) {
        const control = key === "base" ? this.baseControl : this.precisionControl;
        if (!control) return;

        const seen = new Set();
        const normalized = [];
        for (const rawValue of Array.isArray(options) ? options : []) {
            const value = key === "precision"
                ? this.normalizePrecision(rawValue)
                : String(rawValue || "").trim();
            if (!value || (key === "precision" && value === "unknown")) continue;
            if (seen.has(value)) continue;
            seen.add(value);
            normalized.push(value);
        }

        control.options = normalized;
        const selected = Array.isArray(this.filters[key]) ? this.filters[key] : [];
        this.filters[key] = selected.filter((value) => normalized.includes(value));
        this.renderFilterControl(control);
    }

    renderFilterControl(control) {
        if (!control) return;
        const selected = Array.isArray(this.filters[control.key]) ? this.filters[control.key] : [];
        const count = selected.length;
        control.root.classList.toggle("has-selection", count > 0);
        control.badgeEl.style.display = count > 0 ? "inline-flex" : "none";
        control.badgeEl.textContent = String(count);

        if (count === 0) {
            control.labelEl.textContent = control.label;
        } else if (count === 1) {
            const value = selected[0];
            control.labelEl.textContent = control.key === "precision"
                ? this.formatPrecision(value)
                : value;
        } else {
            control.labelEl.textContent = `${control.label} (${count})`;
        }

        control.metaText.textContent = `${count} item selected`;
        this.renderFilterOptions(control);
    }

    renderFilterOptions(control) {
        if (!control) return;
        const query = String(control.searchInput.value || "").trim().toLowerCase();
        const selected = new Set(Array.isArray(this.filters[control.key]) ? this.filters[control.key] : []);
        const visibleOptions = control.options.filter((value) => {
            if (!query) return true;
            const label = control.key === "precision" ? this.formatPrecision(value) : String(value);
            return label.toLowerCase().includes(query);
        });
        if (!visibleOptions.length) {
            control.optionsEl.innerHTML = `<div class="hf-me-filter-empty">No items found</div>`;
            return;
        }
        control.optionsEl.innerHTML = visibleOptions
            .map((value) => {
                const isSelected = selected.has(value);
                const label = control.key === "precision" ? this.formatPrecision(value) : String(value);
                return `
                    <button type="button" class="hf-me-filter-option${isSelected ? " is-selected" : ""}" data-value="${escapeHtml(value)}">
                        <span class="hf-me-filter-option-check">${isSelected ? '<i class="icon-[lucide--check]" aria-hidden="true"></i>' : ""}</span>
                        <span class="hf-me-filter-option-label">${escapeHtml(label)}</span>
                    </button>
                `;
            })
            .join("");
    }

    normalizeCategoryId(value) {
        return String(value || "")
            .trim()
            .toLowerCase()
            .replaceAll(" ", "_");
    }

    formatCategoryLabel(value) {
        const normalized = this.normalizeCategoryId(value);
        if (!normalized) return "";
        if (normalized === MODEL_EXPLORER_OTHER_CATEGORY_KEY) {
            return "Other";
        }
        if (normalized === "animatediff_models") {
            return "Animatediff";
        }
        if (normalized === "animatediff_motion_lora") {
            return "Animatediff Loras";
        }
        return normalized
            .replaceAll("_", " ")
            .split(/\s+/)
            .filter(Boolean)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
    }

    isOtherCategory(categoryId) {
        const normalized = this.normalizeCategoryId(categoryId);
        if (!normalized) return false;
        if (this.otherCategoryIds.has(normalized)) return true;
        if (MODEL_EXPLORER_PRIMARY_CATEGORIES.has(normalized)) return false;
        if (MODEL_EXPLORER_DEFERRED_CATEGORY_ORDER.includes(normalized)) return false;
        return true;
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
            const categoryIds = new Set(this.categories.map((item) => this.normalizeCategoryId(item?.id)));
            const hasOtherCategory = this.categories.some((item) => this.isOtherCategory(item?.id));
            if (
                this.filters.category &&
                !categoryIds.has(this.normalizeCategoryId(this.filters.category)) &&
                !(this.filters.category === MODEL_EXPLORER_OTHER_CATEGORY_KEY && hasOtherCategory)
            ) {
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
        let precisionOptions = [];
        let baseOptions = [];
        try {
            const params = new URLSearchParams();
            if (this.filters.category && this.filters.category !== MODEL_EXPLORER_OTHER_CATEGORY_KEY) {
                params.set("category", this.filters.category);
            }
            if (this.filters.installedOnly) params.set("installed_only", "true");
            const resp = await this.fetchExplorer(`/filters?${params.toString()}`);
            if (!resp.ok) {
                this.updateFilterOptions("base", []);
                this.updateFilterOptions("precision", []);
                this.renderError(`Filters request failed (HTTP ${resp.status}).`);
                return;
            }
            const data = await resp.json();
            baseOptions = Array.isArray(data?.bases) ? data.bases : [];
            const precisions = Array.isArray(data?.precisions) ? data.precisions : [];
            const seenPrecisions = new Set();
            precisionOptions = [];
            for (const rawPrecision of precisions) {
                const normalizedPrecision = this.normalizePrecision(rawPrecision);
                if (!normalizedPrecision || normalizedPrecision === "unknown") continue;
                if (seenPrecisions.has(normalizedPrecision)) continue;
                seenPrecisions.add(normalizedPrecision);
                precisionOptions.push(normalizedPrecision);
            }
            this.updateFilterOptions("base", baseOptions);
            this.updateFilterOptions("precision", precisionOptions);
        } catch (error) {
            this.updateFilterOptions("base", []);
            this.updateFilterOptions("precision", []);
            this.renderError(`Failed to fetch filters: ${error}`);
        }
        const categoryKey = String(this.filters.category || "").toLowerCase();
        const filterAllowed = ["checkpoints", "diffusion_models", "loras", "controlnet"].includes(categoryKey);
        const precisionAllowed = filterAllowed && precisionOptions.length > 0;
        if (this.filterWrap) {
            this.filterWrap.style.display = filterAllowed ? "flex" : "none";
        }
        if (this.baseWrap) {
            this.baseWrap.style.display = filterAllowed ? "inline-flex" : "none";
        }
        if (this.precisionWrap) {
            this.precisionWrap.style.display = precisionAllowed ? "inline-flex" : "none";
        }
        if (!filterAllowed) {
            this.filters.base = [];
            this.filters.precision = [];
            if (this.baseControl) this.renderFilterControl(this.baseControl);
            if (this.precisionControl) this.renderFilterControl(this.precisionControl);
        } else if (!precisionAllowed) {
            this.filters.precision = [];
            if (this.precisionControl) this.renderFilterControl(this.precisionControl);
        }
    }

    async refreshGroups() {
        this.setLoading(true);
        try {
            const params = new URLSearchParams();
            const selectedBase = Array.isArray(this.filters.base) ? this.filters.base : [];
            const selectedPrecision = Array.isArray(this.filters.precision) ? this.filters.precision : [];
            if (this.filters.category && this.filters.category !== MODEL_EXPLORER_OTHER_CATEGORY_KEY) {
                params.set("category", this.filters.category);
            }
            if (selectedBase.length === 1) params.set("base", selectedBase[0]);
            if (selectedPrecision.length === 1) params.set("precision", selectedPrecision[0]);
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
            let groups = Array.isArray(data?.groups) ? data.groups : [];
            if (this.filters.category === MODEL_EXPLORER_OTHER_CATEGORY_KEY) {
                groups = groups.filter((group) => this.isOtherCategory(group?.category));
            }
            if (selectedBase.length) {
                const baseSet = new Set(selectedBase.map((value) => String(value || "").toLowerCase()));
                groups = groups.filter((group) => baseSet.has(String(group?.base || "").toLowerCase()));
            }
            if (selectedPrecision.length) {
                const precisionSet = new Set(selectedPrecision.map((value) => this.normalizePrecision(value)));
                groups = groups
                    .map((group) => {
                        const variants = Array.isArray(group?.variants) ? group.variants : [];
                        const filteredVariants = variants.filter((variant) =>
                            precisionSet.has(this.normalizePrecision(variant?.precision))
                        );
                        if (!filteredVariants.length) return null;
                        return { ...group, variants: filteredVariants };
                    })
                    .filter(Boolean);
            }
            this.groups = groups;
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

        const createCategoryButton = (value, label) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "hf-me-nav-item";
            if (value === this.filters.category) {
                button.classList.add("is-active");
            }
            button.innerHTML = `
                <span class="hf-me-nav-label">${escapeHtml(label)}</span>
            `;
            button.onclick = () => {
                if (this.filters.category === value) return;
                this.filters.category = value;
                this.filters.base = [];
                this.filters.precision = [];
                this.closeFilterPopover();
                this.renderCategorySelect();
                void this.refreshFiltersAndGroups();
            };
            this.categoryList.appendChild(button);
        };

        createCategoryButton("", "All Categories");

        const regularCategories = [];
        const deferredCategories = [];
        const otherCategories = [];
        for (const rawItem of this.categories) {
            const categoryId = this.normalizeCategoryId(rawItem?.id);
            if (!categoryId) continue;
            if (this.isOtherCategory(categoryId)) {
                otherCategories.push(categoryId);
                continue;
            }
            if (MODEL_EXPLORER_DEFERRED_CATEGORY_ORDER.includes(categoryId)) {
                deferredCategories.push(categoryId);
                continue;
            }
            regularCategories.push(categoryId);
        }

        const dedupe = (values) => [...new Set(values)];
        const sortedRegular = dedupe(regularCategories).sort((a, b) => a.localeCompare(b));
        const orderedDeferred = MODEL_EXPLORER_DEFERRED_CATEGORY_ORDER.filter((id) =>
            dedupe(deferredCategories).includes(id)
        );
        const ordered = [...sortedRegular, ...orderedDeferred];

        for (const categoryId of ordered) {
            createCategoryButton(categoryId, this.formatCategoryLabel(categoryId));
        }

        this.otherCategoryIds = new Set(dedupe(otherCategories));
        if (this.otherCategoryIds.size > 0) {
            createCategoryButton(MODEL_EXPLORER_OTHER_CATEGORY_KEY, "Other");
        }
    }

    normalizePrecision(value) {
        const normalized = String(value || "").trim().toLowerCase();
        if (!normalized) return "";
        if (normalized.startsWith("q")) return "gguf";
        return normalized;
    }

    formatPrecision(value) {
        const precision = this.normalizePrecision(value);
        if (!precision || precision === "unknown") return "";
        return precision.toUpperCase();
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
            const categoryHtml = escapeHtml(this.formatCategoryLabel(group.category || ""));
            const baseLabel = group.base ? escapeHtml(group.base) : "";
            const variants = Array.isArray(group.variants) ? group.variants : [];
            if (!variants.length) continue;

            const variantRows = variants
                .map((variant, index) => {
                    const filename = escapeHtml(variant.filename || "");
                    const normalizedPrecision = this.normalizePrecision(variant.precision);
                    const showPrecision = normalizedPrecision && normalizedPrecision !== "unknown";
                    const precision = showPrecision ? escapeHtml(this.formatPrecision(normalizedPrecision)) : "";
                    const installed = Boolean(variant.installed);
                    const variantKey = `${group.group_id}:${index}`;
                    const installedBadge = installed
                        ? `<span class="hf-me-installed">Installed</span>`
                        : "";
                    const actions = installed
                        ? `
                            <button class="hf-me-action-btn p-button p-component hf-me-action-btn--destructive" data-action="delete" data-key="${variantKey}">Delete</button>
                            <button class="hf-me-action-btn p-button p-component hf-me-action-btn--primary" data-action="use" data-key="${variantKey}">Use</button>
                          `
                        : `
                            <button class="hf-me-action-btn p-button p-component hf-me-action-btn--secondary" data-action="download" data-key="${variantKey}">Download</button>
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
