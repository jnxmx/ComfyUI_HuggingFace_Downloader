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
        this.baseSelect = null;
        this.precisionSelect = null;
        this.searchInput = null;
        this.installedOnlyToggle = null;
        this.baseWrap = null;
        this.precisionWrap = null;
        this.filterWrap = null;
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
                padding-right: 12px;
                gap: 0.5rem;
                align-items: center;
            }
            #hf-model-explorer-dialog .hf-me-left-title {
                flex: 1 1 auto;
                user-select: none;
                font-size: 1.5rem;
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
                gap: 0.5rem;
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
            #hf-model-explorer-dialog .hf-me-nav-icon {
                font-size: 0.75rem;
                color: var(--text-secondary, var(--descrip-text, #9aa4b6));
                flex: 0 0 auto;
            }
            #hf-model-explorer-dialog .hf-me-left-header-icon {
                font-size: 1rem;
                color: var(--base-foreground, var(--input-text, #e5e7eb));
                flex: 0 0 auto;
            }
            #hf-model-explorer-dialog .hf-me-nav-label {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            #hf-model-explorer-dialog .hf-me-nav-badge {
                margin-left: auto;
                min-width: 1.625rem;
                height: 1.625rem;
                border-radius: 0.45rem;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 0 0.35rem;
                background: color-mix(in srgb, var(--secondary-background, #2f3747) 88%, transparent);
                color: var(--text-secondary, var(--descrip-text, #9aa4b6));
                font-size: 0.86rem;
                line-height: 1;
                font-weight: 600;
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
                gap: 1rem;
                padding: 8px 24px 8px;
                flex-wrap: nowrap;
                flex-shrink: 0;
            }
            #hf-model-explorer-dialog .hf-me-filter-item {
                height: 40px;
                position: relative;
                display: inline-flex;
                align-items: center;
                border-radius: 0.5rem;
                background: var(--comfy-input-bg, #2b3242);
                color: var(--base-foreground, var(--input-text, #e5e7eb));
                border: 1px solid var(--border-default, #4b5563);
                transition: all 160ms ease;
                min-width: 10rem;
                max-width: 17rem;
            }
            #hf-model-explorer-dialog .hf-me-filter-item:focus-within {
                border-color: var(--node-component-border, var(--primary-background, #3b82f6));
            }
            #hf-model-explorer-dialog .hf-me-filter-select {
                appearance: none;
                border: none;
                outline: none;
                background: transparent;
                color: inherit;
                width: 100%;
                height: 100%;
                cursor: pointer;
                padding: 0 2rem 0 0.75rem;
                font-size: 0.9rem;
                font-weight: 500;
            }
            #hf-model-explorer-dialog .hf-me-filter-caret {
                position: absolute;
                right: 0.75rem;
                top: 50%;
                transform: translateY(-50%);
                color: var(--text-secondary, var(--descrip-text, #9aa4b6));
                pointer-events: none;
                font-size: 0.9rem;
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
                grid-template-columns: minmax(0, 1fr) minmax(72px, 104px) minmax(92px, 156px) auto;
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
                    grid-template-columns: minmax(0, 1fr) minmax(66px, 94px) minmax(80px, 128px) auto;
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
                <i class="icon-[comfy--ai-model] hf-me-left-header-icon" aria-hidden="true"></i>
                <h2 class="hf-me-left-title">Model Library</h2>
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
            <div id="hf-me-precision-wrap" class="hf-me-filter-item">
                <select id="hf-me-precision" class="hf-me-filter-select" aria-label="Precision"></select>
                <i class="pi pi-chevron-down hf-me-filter-caret" aria-hidden="true"></i>
            </div>
            <div id="hf-me-base-wrap" class="hf-me-filter-item">
                <select id="hf-me-base" class="hf-me-filter-select" aria-label="Base models"></select>
                <i class="pi pi-chevron-down hf-me-filter-caret" aria-hidden="true"></i>
            </div>
        `;
        mainPanel.appendChild(filterWrap);

        const installedOnlyRow = document.createElement("div");
        installedOnlyRow.id = "hf-me-installed-only-row";
        installedOnlyRow.className = "hf-me-toggle-row";
        installedOnlyRow.innerHTML = `
            <label class="hf-me-toggle-label">
                <span class="hf-me-installed-toggle p-toggleswitch p-component">
                    <input id="hf-me-installed-only" type="checkbox" class="p-toggleswitch-input" role="switch" aria-label="Show downloaded only" />
                    <span class="p-toggleswitch-slider"></span>
                </span>
                <span>Show downloaded only</span>
            </label>
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
        this.baseSelect = panel.querySelector("#hf-me-base");
        this.precisionSelect = panel.querySelector("#hf-me-precision");
        this.searchInput = panel.querySelector("#hf-me-search");
        this.installedOnlyToggle = panel.querySelector("#hf-me-installed-only");
        this.baseWrap = panel.querySelector("#hf-me-base-wrap");
        this.precisionWrap = panel.querySelector("#hf-me-precision-wrap");
        this.filterWrap = filterWrap;
        const toggleWrap = installedOnlyRow.querySelector(".hf-me-installed-toggle");
        const toggleInput = this.installedOnlyToggle;

        const updateSliderState = () => {
            if (!toggleWrap || !toggleInput) return;
            toggleWrap.classList.toggle("p-toggleswitch-checked", Boolean(toggleInput.checked));
        };
        if (toggleInput && toggleWrap) {
            toggleInput.addEventListener("focus", () => toggleWrap.classList.add("p-focus"));
            toggleInput.addEventListener("blur", () => toggleWrap.classList.remove("p-focus"));
            toggleInput.addEventListener("change", () => updateSliderState());
            updateSliderState();
        }

        this.baseSelect.onchange = async () => {
            this.filters.base = this.baseSelect.value;
            await this.refreshGroups();
        };
        this.precisionSelect.onchange = async () => {
            this.filters.precision = this.normalizePrecision(this.precisionSelect.value);
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
        let precisionOptions = [];
        try {
            const params = new URLSearchParams();
            if (this.filters.category) params.set("category", this.filters.category);
            if (this.filters.installedOnly) params.set("installed_only", "true");
            const resp = await this.fetchExplorer(`/filters?${params.toString()}`);
            if (!resp.ok) {
                this.renderSelectWithAny(this.baseSelect, [], "", "Base models");
                this.renderSelectWithAny(this.precisionSelect, [], "", "Precision");
                this.renderError(`Filters request failed (HTTP ${resp.status}).`);
                return;
            }
            const data = await resp.json();
            const bases = Array.isArray(data?.bases) ? data.bases : [];
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

            if (this.filters.precision) {
                const normalizedSelected = this.normalizePrecision(this.filters.precision);
                this.filters.precision = precisionOptions.includes(normalizedSelected) ? normalizedSelected : "";
            }

            this.renderSelectWithAny(this.baseSelect, bases, this.filters.base, "Base models");
            this.renderSelectWithAny(this.precisionSelect, precisionOptions, this.filters.precision, "Precision");
        } catch (error) {
            this.renderSelectWithAny(this.baseSelect, [], "", "Base models");
            this.renderSelectWithAny(this.precisionSelect, [], "", "Precision");
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
            this.filters.base = "";
            this.filters.precision = "";
        } else if (!precisionAllowed) {
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

        const createCategoryButton = (value, label, count, iconClass) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "hf-me-nav-item";
            if (value === this.filters.category) {
                button.classList.add("is-active");
            }
            button.innerHTML = `
                <i class="hf-me-nav-icon ${iconClass}" aria-hidden="true"></i>
                <span class="hf-me-nav-label">${escapeHtml(label)}</span>
                <span class="hf-me-nav-badge">${Number(count || 0)}</span>
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
        createCategoryButton("", "All categories", totalCount, "icon-[lucide--list]");

        const sortedCategories = [...this.categories].sort((a, b) =>
            String(a?.id || "").localeCompare(String(b?.id || ""))
        );
        for (const item of sortedCategories) {
            createCategoryButton(
                String(item?.id || ""),
                String(item?.id || ""),
                item?.count || 0,
                "icon-[lucide--folder]"
            );
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

    renderSelectWithAny(selectEl, values, selected, anyLabel = "Any") {
        if (!selectEl) return;
        selectEl.innerHTML = "";
        const any = document.createElement("option");
        any.value = "";
        any.textContent = anyLabel;
        any.selected = !selected;
        selectEl.appendChild(any);
        for (const value of values) {
            const optionValue = String(value);
            const option = document.createElement("option");
            option.value = optionValue;
            option.textContent = selectEl === this.precisionSelect ? this.formatPrecision(optionValue) : optionValue;
            option.selected = optionValue === String(selected || "");
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
