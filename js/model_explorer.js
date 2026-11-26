import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { showUnifiedImportModelDialog } from "./import_model_dialog.js";
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
const GGUF_NODE_PROVIDER_CANDIDATES_BY_CATEGORY = {
    diffusion_models: [
        { nodeType: "UNETLoaderGGUF", key: "unet_name" },
        { nodeType: "UnetLoaderGGUF", key: "unet_name" },
    ],
    checkpoints: [
        { nodeType: "UNETLoaderGGUF", key: "unet_name" },
        { nodeType: "UnetLoaderGGUF", key: "unet_name" },
    ],
    text_encoders: [
        { nodeType: "CLIPLoaderGGUF", key: "clip_name" },
        { nodeType: "DualCLIPLoaderGGUF", key: "clip_name1" },
        { nodeType: "TripleCLIPLoaderGGUF", key: "clip_name1" },
    ],
};
const MODEL_EXPLORER_OTHER_CATEGORY_KEY = "__other__";
const MODEL_EXPLORER_DEFERRED_CATEGORY_ORDER = Object.freeze([
    "animatediff_models",
    "animatediff_motion_lora",
]);
const MODEL_EXPLORER_PRIMARY_CATEGORIES = new Set([
    "checkpoints",
    "controlnet",
    "clip_vision",
    "diffusion_models",
    "ipadapter",
    "latent_upscale_models",
    "loras",
    "model_patches",
    "style_models",
    "text_encoders",
    "upscale_models",
    "vae",
    "vae_approx",
    "animatediff_models",
    "animatediff_motion_lora",
    "frame_interpolation",
    "background_removal",
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
    const life = payload.life ?? 5000;
    const closable = payload.closable ?? true;
    if (app?.extensionManager?.toast?.add) {
        app.extensionManager.toast.add({
            severity: payload.severity || type,
            summary: payload.summary,
            detail: payload.detail,
            life,
            closable,
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

const NATIVE_SCROLLBAR_CLASS_CANDIDATES = Object.freeze([]);
let detectedNativeScrollbarClasses = null;

const applyNativeScrollbarClasses = (el) => {
    if (!el || !el.classList || typeof document === "undefined") return;
    if (!detectedNativeScrollbarClasses) {
        detectedNativeScrollbarClasses = NATIVE_SCROLLBAR_CLASS_CANDIDATES.filter((className) =>
            Boolean(document.querySelector(`.${className}`))
        );
    }
    for (const className of detectedNativeScrollbarClasses) {
        el.classList.add(className);
    }
};

const TEMPLATE_DIALOG_TOKENS = Object.freeze({
    surface: "var(--background, #171718)",
    panel: "var(--card, #262729)",
    border: "var(--border, #494a50)",
    text: "var(--foreground, #ffffff)",
    shadow: "0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -4px rgba(0, 0, 0, 0.5)",
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
        background: "rgba(0, 0, 0, 0.45)",
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
        fontFamily: 'var(--font-inter, "Inter", sans-serif)',
        ...sizeStyle,
    });
};

const ensureManualToggleStyles = () => {
    const styleId = "hf-manual-toggle-styles";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
        .hf-manual-toggle.p-toggleswitch {
            position: relative;
            display: inline-flex;
            align-items: center;
            width: 52px;
            height: 32px;
            margin: 0;
            cursor: pointer;
            user-select: none;
            vertical-align: middle;
            flex: 0 0 auto;
        }
        .hf-manual-toggle .p-toggleswitch-input {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            margin: 0;
            opacity: 0;
            cursor: pointer;
            z-index: 2;
        }
        .hf-manual-toggle .p-toggleswitch-slider {
            position: relative;
            display: block;
            width: 100%;
            height: 100%;
            border-radius: 999px;
            border: 1px solid var(--border, #494a50);
            background: var(--secondary, #262729);
            box-sizing: border-box;
            transition: background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
        }
        .hf-manual-toggle .p-toggleswitch-slider::before {
            content: "";
            position: absolute;
            top: 50%;
            left: 3px;
            width: 24px;
            height: 24px;
            border-radius: 999px;
            transform: translateY(-50%);
            background: var(--muted, #3c3d42);
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
            transition: transform 140ms ease, background-color 140ms ease;
        }
        .hf-manual-toggle.p-toggleswitch-checked .p-toggleswitch-slider {
            background: var(--primary, #0b8ce9);
            border-color: var(--primary, #0b8ce9);
        }
        .hf-manual-toggle.p-toggleswitch-checked .p-toggleswitch-slider::before {
            transform: translate(20px, -50%);
            background: var(--foreground, #ffffff);
        }
        .hf-manual-toggle.p-focus .p-toggleswitch-slider {
            box-shadow: 0 0 0 1px var(--ring, #8a8a8a);
        }
    `;
    document.head.appendChild(style);
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

const createConfirmDialogButton = (label, tone = "default") => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = "p-button p-component hf-me-confirm-btn";
    if (tone === "success") {
        button.classList.add("p-button-success");
    } else if (tone === "primary") {
        button.classList.add("hf-btn-primary");
    } else if (tone === "danger") {
        button.classList.add("p-button-danger");
    }
    return button;
};

const showConfirmDialog = ({
    title = "Please confirm",
    message = "",
    confirmLabel = "Confirm",
    confirmTone = "primary",
    cancelLabel = "Cancel",
} = {}) =>
    new Promise((resolve) => {
        const existing = document.getElementById("hf-model-explorer-confirm-dialog");
        if (existing) existing.remove();

        const overlay = document.createElement("div");
        overlay.id = "hf-model-explorer-confirm-dialog";
        applyTemplateDialogOverlayStyle(overlay, 10001);

        const panel = document.createElement("div");
        applyTemplateDialogPanelStyle(panel, {
            minWidth: "360px",
            maxWidth: "560px",
            width: "min(560px, 100%)",
            padding: "24px",
            gap: "14px",
        });

        const heading = document.createElement("div");
        heading.textContent = title;
        Object.assign(heading.style, {
            fontFamily: "Inter, Arial, sans-serif",
            fontSize: "20px",
            fontWeight: "600",
            lineHeight: "1.25",
            color: "var(--input-text)",
        });

        const detail = document.createElement("div");
        detail.textContent = message;
        Object.assign(detail.style, {
            fontSize: "14px",
            lineHeight: "1.4",
            color: "var(--descrip-text, #c4c9d4)",
        });

        const actions = document.createElement("div");
        Object.assign(actions.style, {
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            marginTop: "4px",
        });

        let settled = false;
        const onKeyDown = (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                settle(false);
            }
        };
        const settle = (value) => {
            if (settled) return;
            settled = true;
            document.removeEventListener("keydown", onKeyDown);
            overlay.remove();
            resolve(Boolean(value));
        };

        const cancelBtn = createConfirmDialogButton(cancelLabel, "default");
        cancelBtn.onclick = () => settle(false);

        const confirmBtn = createConfirmDialogButton(confirmLabel, confirmTone);
        confirmBtn.onclick = () => settle(true);

        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);

        panel.appendChild(heading);
        panel.appendChild(detail);
        panel.appendChild(actions);
        overlay.appendChild(panel);

        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                settle(false);
            }
        });

        document.addEventListener("keydown", onKeyDown);

        document.body.appendChild(overlay);
        confirmBtn.focus();
    });

const showMoveFolderDialog = ({
    filename = "",
    currentFolder = "",
    folders = [],
} = {}) =>
    new Promise((resolve) => {
        const existing = document.getElementById("hf-model-explorer-move-dialog");
        if (existing) existing.remove();

        const overlay = document.createElement("div");
        overlay.id = "hf-model-explorer-move-dialog";
        applyTemplateDialogOverlayStyle(overlay, 10001);

        const panel = document.createElement("div");
        applyTemplateDialogPanelStyle(panel, {
            minWidth: "380px",
            maxWidth: "520px",
            width: "min(520px, 100%)",
            padding: "24px",
            gap: "14px",
        });

        const heading = document.createElement("div");
        heading.textContent = "Move model";
        Object.assign(heading.style, {
            fontFamily: "Inter, Arial, sans-serif",
            fontSize: "20px",
            fontWeight: "600",
            lineHeight: "1.25",
            color: "var(--input-text)",
        });

        const detail = document.createElement("div");
        detail.textContent = currentFolder
            ? `Move "${filename}" from "${currentFolder}" to:`
            : `Move "${filename}" to:`;
        Object.assign(detail.style, {
            fontSize: "14px",
            lineHeight: "1.4",
            color: "var(--descrip-text, #c4c9d4)",
            wordBreak: "break-word",
        });

        const applyFieldFocusStyle = (el) => {
            el.addEventListener("focus", () => {
                el.style.borderColor = "var(--ring, #8a8a8a)";
            });
            el.addEventListener("blur", () => {
                el.style.borderColor = "var(--border, #494a50)";
            });
        };

        const select = document.createElement("select");
        Object.assign(select.style, {
            width: "100%",
            height: "40px",
            borderRadius: "8px",
            border: "1px solid var(--border, #494a50)",
            background: "var(--secondary, #262729)",
            color: "var(--foreground, #ffffff)",
            padding: "0 10px",
            fontSize: "14px",
            fontFamily: 'var(--font-inter, "Inter", sans-serif)',
            outline: "none",
            boxSizing: "border-box",
            transition: "border-color 150ms ease",
        });
        applyFieldFocusStyle(select);

        const uniqueFolders = [...new Set((Array.isArray(folders) ? folders : []).map((f) => String(f || "").trim()).filter(Boolean))];
        if (currentFolder && !uniqueFolders.includes(currentFolder)) {
            uniqueFolders.unshift(currentFolder);
        }
        uniqueFolders.sort((a, b) => a.localeCompare(b));

        for (const folder of uniqueFolders) {
            const opt = document.createElement("option");
            opt.value = folder;
            opt.textContent = folder === currentFolder ? `${folder} (current)` : folder;
            select.appendChild(opt);
        }

        const customOpt = document.createElement("option");
        customOpt.value = "__custom__";
        customOpt.textContent = "Custom folder...";
        select.appendChild(customOpt);

        const defaultFolder = uniqueFolders.find((f) => f !== currentFolder) || currentFolder || "__custom__";
        select.value = defaultFolder;

        const customInput = document.createElement("input");
        customInput.type = "text";
        customInput.placeholder = "e.g. loras/wan or background_removal";
        Object.assign(customInput.style, {
            display: select.value === "__custom__" ? "block" : "none",
            width: "100%",
            height: "40px",
            borderRadius: "8px",
            border: "1px solid var(--border, #494a50)",
            background: "var(--secondary, #262729)",
            color: "var(--foreground, #ffffff)",
            padding: "0 10px",
            fontSize: "14px",
            fontFamily: 'var(--font-inter, "Inter", sans-serif)',
            outline: "none",
            boxSizing: "border-box",
            transition: "border-color 150ms ease",
        });
        applyFieldFocusStyle(customInput);

        select.addEventListener("change", () => {
            const isCustom = select.value === "__custom__";
            customInput.style.display = isCustom ? "block" : "none";
            if (isCustom) customInput.focus();
        });

        const actions = document.createElement("div");
        Object.assign(actions.style, {
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            marginTop: "4px",
        });

        let settled = false;
        const onKeyDown = (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                settle(null);
            } else if (event.key === "Enter" && document.activeElement === customInput) {
                event.preventDefault();
                submit();
            }
        };
        const settle = (value) => {
            if (settled) return;
            settled = true;
            document.removeEventListener("keydown", onKeyDown);
            overlay.remove();
            resolve(value);
        };
        const submit = () => {
            const chosen = select.value === "__custom__" ? customInput.value.trim() : select.value.trim();
            if (!chosen) {
                customInput.focus();
                return;
            }
            settle(chosen);
        };

        const cancelBtn = createConfirmDialogButton("Cancel", "default");
        cancelBtn.onclick = () => settle(null);

        const moveBtn = createConfirmDialogButton("Move", "primary");
        moveBtn.onclick = submit;

        actions.appendChild(cancelBtn);
        actions.appendChild(moveBtn);

        panel.appendChild(heading);
        panel.appendChild(detail);
        panel.appendChild(select);
        panel.appendChild(customInput);
        panel.appendChild(actions);
        overlay.appendChild(panel);

        let pointerDownOnBackdrop = false;
        overlay.addEventListener("pointerdown", (event) => {
            pointerDownOnBackdrop = event.target === overlay;
        });
        overlay.addEventListener("click", (event) => {
            if (pointerDownOnBackdrop && event.target === overlay) {
                settle(null);
            }
            pointerDownOnBackdrop = false;
        });

        document.addEventListener("keydown", onKeyDown);
        document.body.appendChild(overlay);
        select.focus();
    });

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

const isGgufModelSelection = (modelPath, nodeHint = null) => {
    if (nodeHint && typeof nodeHint === "object") {
        if (nodeHint.is_gguf === true) return true;
        const hintType = String(nodeHint.type || "").trim().toLowerCase();
        const hintManagerType = String(nodeHint.manager_type || "").trim().toLowerCase();
        if (hintType === "gguf" || hintType === "gguf_model" || hintManagerType === "gguf") {
            return true;
        }
    }
    return String(modelPath || "").trim().toLowerCase().endsWith(".gguf");
};

const normalizeProviderCandidate = (provider) => {
    if (!provider || typeof provider !== "object") return null;
    const nodeType = String(provider?.nodeDef?.name || provider?.nodeType || "").trim();
    if (!nodeType) return null;
    return {
        nodeType,
        nodeDisplayName: provider?.nodeDef?.display_name || null,
        widgetKey: String(provider?.key || "").trim() || null,
    };
};

const assignModelPathToNode = (node, modelPath, preferredWidgetKey = null) => {
    if (!node || !Array.isArray(node.widgets)) return false;

    const widgetByName = (name) => node.widgets.find((w) => String(w?.name || "").trim() === name);

    const setWidgetValue = (widget) => {
        if (!widget) return false;
        widget.value = modelPath;
        return true;
    };

    if (preferredWidgetKey && setWidgetValue(widgetByName(preferredWidgetKey))) {
        return true;
    }

    const fallbackKeys = [
        "unet_name",
        "ckpt_name",
        "model_name",
        "clip_name",
        "clip_name1",
        "vae_name",
        "lora_name",
        "control_net_name",
    ];
    for (const key of fallbackKeys) {
        if (setWidgetValue(widgetByName(key))) {
            return true;
        }
    }
    return false;
};

const addModelNodeFromSelection = async (category, modelPath, nodeHint = null) => {
    const graph = app?.graph || app?.canvas?.graph;
    if (!graph || !globalThis?.LiteGraph?.createNode) {
        throw new Error("Graph/LiteGraph is not available.");
    }

    const modelToNodeStore = await resolveModelToNodeStore();
    const isGguf = isGgufModelSelection(modelPath, nodeHint);
    const candidates = [];
    if (isGguf) {
        const ggufCandidates = GGUF_NODE_PROVIDER_CANDIDATES_BY_CATEGORY[category] || [];
        candidates.push(...ggufCandidates);
    }

    if (modelToNodeStore?.getNodeProvider) {
        const storeProvider = modelToNodeStore.getNodeProvider(category);
        if (storeProvider) {
            candidates.push(storeProvider);
        }
    }

    const fallback = FALLBACK_NODE_PROVIDER_BY_CATEGORY[category] || null;
    if (fallback) {
        candidates.push(fallback);
    }

    const normalizedCandidates = [];
    const seenNodeTypes = new Set();
    for (const provider of candidates) {
        const normalized = normalizeProviderCandidate(provider);
        if (!normalized) continue;
        const key = normalized.nodeType.toLowerCase();
        if (seenNodeTypes.has(key)) continue;
        seenNodeTypes.add(key);
        normalizedCandidates.push(normalized);
    }

    if (!normalizedCandidates.length) {
        throw new Error(`No node provider for category "${category}".`);
    }

    let chosenNode = null;
    let chosenNodeType = "";
    let chosenWidgetKey = null;
    for (const candidate of normalizedCandidates) {
        const node = globalThis.LiteGraph.createNode(candidate.nodeType, candidate.nodeDisplayName || undefined);
        if (!node) continue;
        chosenNode = node;
        chosenNodeType = candidate.nodeType;
        chosenWidgetKey = candidate.widgetKey;
        break;
    }

    if (!chosenNode) {
        const ggufSuffix = isGguf
            ? ' (install/enable ComfyUI-GGUF nodes like "UNETLoaderGGUF")'
            : "";
        throw new Error(`Failed to create a compatible loader node for "${category}"${ggufSuffix}.`);
    }

    assignModelPathToNode(chosenNode, modelPath, chosenWidgetKey);

    graph.add(chosenNode);
    placeNodeNearCanvasCenter(chosenNode);
    chosenNode.setDirtyCanvas?.(true, true);
    app?.canvas?.setDirty?.(true, true);
    return chosenNodeType;
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
        this.pendingFilterSelectionRefresh = false;
        this.otherCategoryIds = new Set();
        this.groups = [];
        this.categories = [];
        this.filters = { category: "", base: [], precision: [], search: "", installedOnly: false };
        this.loading = false;
        this.searchTimer = null;
    }

    async fetchExplorer(pathAndQuery, init = {}, timeoutMs = 15000) {
        return await fetchWithTimeout(`${MODEL_EXPLORER_API_BASE}${pathAndQuery}`, init, timeoutMs);
    }

    ensureStyles() {
        ensureManualToggleStyles();
        const styleId = "hf-model-explorer-styles";
        if (document.getElementById(styleId)) return;
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
            #hf-me-panel {
                width: min(90vw, 1280px);
                height: 80vh;
                max-height: 1026px;
                min-height: 520px;
                border-radius: 16px;
                border: 1px solid var(--border, #494a50);
                background: var(--background, #171718);
                color: var(--foreground, #ffffff);
            }
            @media (min-width: 1450px) {
                #hf-me-panel {
                    width: min(90vw, 1724px);
                }
            }
            #hf-model-explorer-dialog .hf-me-shell {
                display: grid;
                grid-template-columns: 14rem minmax(0, 1fr);
                height: 100%;
                width: 100%;
                overflow: hidden;
            }
            #hf-model-explorer-dialog .hf-me-left-panel {
                background: var(--card, #262729);
                display: flex;
                flex-direction: column;
                height: 100%;
                overflow: hidden;
                border-right: none;
            }
            #hf-model-explorer-dialog .hf-me-left-header {
                display: flex;
                width: 100%;
                height: 72px;
                flex-shrink: 0;
                padding: 0 12px 0 24px;
                gap: 8px;
                align-items: center;
                box-sizing: border-box;
            }
            #hf-model-explorer-dialog .hf-me-left-title-icon {
                font-size: 16px;
                color: var(--foreground, #ffffff);
                flex-shrink: 0;
            }
            #hf-model-explorer-dialog .hf-me-left-title {
                margin: 0;
                flex: 1 1 auto;
                user-select: none;
                font-family: var(--font-inter, "Inter", sans-serif);
                font-size: 16px;
                font-weight: 600;
                line-height: 24px;
                color: var(--foreground, #ffffff);
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
                scrollbar-width: none;
                gap: 4px;
                flex-direction: column;
                background: var(--card, #262729);
                padding: 0 12px 12px;
                box-sizing: border-box;
            }
            #hf-model-explorer-dialog .hf-me-left-scroll::-webkit-scrollbar {
                width: 1px;
                display: none;
            }
            #hf-model-explorer-dialog .hf-me-left-scroll::-webkit-scrollbar-thumb {
                background-color: transparent;
            }
            #hf-model-explorer-dialog .hf-me-nav-title {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin: 0;
                padding: 20px 12px 0;
                height: 36px;
                box-sizing: border-box;
                flex-shrink: 0;
            }
            #hf-model-explorer-dialog .hf-me-nav-title-text {
                margin: 0;
                font-size: 12px;
                line-height: 16px;
                font-weight: 700;
                text-transform: uppercase;
                color: var(--muted-foreground, #8a8a8a);
            }
            #hf-model-explorer-dialog .hf-me-category-list {
                display: flex;
                flex-direction: column;
                gap: 4px;
                min-height: 0;
            }
            #hf-model-explorer-dialog .hf-me-nav-item {
                appearance: none;
                border: none;
                background: transparent;
                width: 100%;
                height: 44px;
                display: flex;
                align-items: center;
                gap: 8px;
                border-radius: 6px;
                padding: 12px;
                color: var(--foreground, #ffffff);
                font-family: var(--font-inter, "Inter", sans-serif);
                font-size: 14px;
                line-height: 20px;
                font-weight: 400;
                text-align: left;
                cursor: pointer;
                transition: background-color 150ms ease, color 150ms ease;
                user-select: none;
                box-sizing: border-box;
                flex-shrink: 0;
            }
            #hf-model-explorer-dialog .hf-me-nav-item:hover {
                background: var(--accent, #313235);
            }
            #hf-model-explorer-dialog .hf-me-nav-item.is-active {
                background: var(--muted, #3c3d42);
            }
            #hf-model-explorer-dialog .hf-me-nav-item.is-active:hover {
                background: var(--muted, #3c3d42);
            }
            #hf-model-explorer-dialog .hf-me-nav-icon {
                color: var(--foreground, #ffffff);
                flex-shrink: 0;
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
                background: var(--background, #171718);
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
                box-sizing: border-box;
            }
            #hf-model-explorer-dialog .hf-me-search-wrap {
                display: flex;
                flex: 1 1 auto;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                min-width: 0;
            }
            #hf-model-explorer-dialog .hf-me-hfsearch-btn {
                appearance: none;
                height: 40px;
                padding: 8px 16px;
                border-radius: 8px;
                border: none;
                background: var(--secondary, #262729);
                color: var(--foreground, #ffffff);
                font-family: var(--font-inter, "Inter", sans-serif);
                font-size: 14px;
                font-weight: 500;
                line-height: 20px;
                cursor: pointer;
                white-space: nowrap;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                flex: 0 0 auto;
                transition: background-color 150ms ease;
            }
            #hf-model-explorer-dialog .hf-me-hfsearch-btn:hover {
                background: var(--accent, #313235);
            }
            #hf-model-explorer-dialog .hf-me-hfsearch-btn[hidden] {
                display: none;
            }
            #hf-model-explorer-dialog .hf-me-hfsearch-banner {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                padding: 10px 16px;
                border-radius: 12px;
                background: var(--card, #262729);
                border: 1px solid var(--border, #494a50);
                color: var(--foreground, #ffffff);
                font-family: var(--font-inter, "Inter", sans-serif);
                font-size: 13px;
                line-height: 18px;
            }
            #hf-model-explorer-dialog .hf-me-hfsearch-banner-title {
                display: flex;
                align-items: center;
                gap: 8px;
                min-width: 0;
                font-weight: 500;
            }
            #hf-model-explorer-dialog .hf-me-tag--link {
                color: var(--primary, #0b8ce9);
                text-decoration: none;
            }
            #hf-model-explorer-dialog .hf-me-tag--link:hover {
                text-decoration: underline;
            }
            #hf-model-explorer-dialog .hf-me-tag--priority {
                background: rgba(34, 197, 94, 0.16);
                color: #86efac;
            }
            #hf-model-explorer-dialog .hf-me-searchbox {
                position: relative;
                display: flex;
                flex: 1 1 auto;
                max-width: 32rem;
                min-width: 0;
                align-items: center;
                background: var(--secondary, #262729);
                color: var(--foreground, #ffffff);
                border-radius: 8px;
                border: none;
                height: 40px;
                padding: 8px;
                box-sizing: border-box;
                transition: box-shadow 150ms ease, background-color 150ms ease;
            }
            #hf-model-explorer-dialog .hf-me-searchbox:focus-within {
                box-shadow: 0 0 0 1px var(--ring, #8a8a8a);
            }
            #hf-model-explorer-dialog .hf-me-search-icon {
                position: absolute;
                left: 10px;
                color: var(--foreground, #ffffff);
                pointer-events: none;
            }
            #hf-model-explorer-dialog .hf-me-search-input {
                width: 100%;
                height: 100%;
                border: none;
                outline: none;
                background: transparent;
                color: var(--foreground, #ffffff);
                font-family: var(--font-inter, "Inter", sans-serif);
                font-size: 12px;
                line-height: 16px;
                padding: 0 28px 0 32px;
                box-sizing: border-box;
                border-radius: 8px;
            }
            #hf-model-explorer-dialog .hf-me-search-input::placeholder {
                color: var(--muted-foreground, #8a8a8a);
            }
            #hf-model-explorer-dialog .hf-me-search-clear {
                position: absolute;
                right: 6px;
                width: 24px;
                height: 24px;
                border: none;
                border-radius: 6px;
                background: transparent;
                color: var(--muted-foreground, #8a8a8a);
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                padding: 0;
            }
            #hf-model-explorer-dialog .hf-me-search-clear:hover {
                background: var(--accent, #313235);
                color: var(--foreground, #ffffff);
            }
            #hf-model-explorer-dialog .hf-me-header-actions {
                display: flex;
                align-items: center;
                gap: 8px;
                flex: 0 0 auto;
            }
            #hf-model-explorer-dialog .hf-me-import-btn {
                appearance: none;
                border: none;
                height: 40px;
                padding: 8px 16px;
                border-radius: 8px;
                background: var(--primary, #0b8ce9);
                color: var(--foreground, #ffffff);
                font-family: var(--font-inter, "Inter", sans-serif);
                font-size: 14px;
                font-weight: 500;
                line-height: 20px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                cursor: pointer;
                white-space: nowrap;
                transition: background-color 150ms ease;
            }
            #hf-model-explorer-dialog .hf-me-import-btn:hover {
                background: color-mix(in srgb, var(--primary, #0b8ce9) 90%, black);
            }
            #hf-model-explorer-dialog .hf-me-native-close-btn {
                appearance: none;
                border: none;
                width: 40px;
                height: 40px;
                border-radius: 8px;
                background: var(--secondary, #262729);
                color: var(--foreground, #ffffff);
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: background-color 150ms ease;
                flex-shrink: 0;
                padding: 0;
            }
            #hf-model-explorer-dialog .hf-me-native-close-btn:hover {
                background: var(--accent, #313235);
            }
            #hf-model-explorer-dialog .hf-me-filter-row {
                display: flex;
                align-items: center;
                gap: 16px;
                padding: 0;
                flex-wrap: nowrap;
                flex-shrink: 0;
            }
            #hf-model-explorer-dialog .hf-me-filter {
                position: relative;
                display: inline-block;
            }
            #hf-model-explorer-dialog .hf-me-filter-trigger {
                height: 40px;
                min-width: 128px;
                position: relative;
                display: inline-flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                border-radius: 8px;
                background: var(--secondary, #262729);
                color: var(--foreground, #ffffff);
                border: 2.5px solid transparent;
                transition: all 200ms ease-in-out;
                padding: 0 10px 0 12px;
                cursor: pointer;
                font-family: var(--font-inter, "Inter", sans-serif);
                font-size: 14px;
                font-weight: 400;
                line-height: 20px;
                text-align: left;
                outline: none;
                box-sizing: border-box;
                user-select: none;
            }
            #hf-model-explorer-dialog .hf-me-filter-trigger:hover {
                background: var(--accent, #313235);
            }
            #hf-model-explorer-dialog .hf-me-filter-trigger:focus-visible,
            #hf-model-explorer-dialog .hf-me-filter.is-open .hf-me-filter-trigger,
            #hf-model-explorer-dialog .hf-me-filter.has-selection .hf-me-filter-trigger {
                border-color: var(--border, #494a50);
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
                background: var(--primary, #0b8ce9);
                color: #ffffff;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 11px;
                font-weight: 700;
                line-height: 1;
            }
            #hf-model-explorer-dialog .hf-me-filter-caret {
                margin-left: auto;
                color: var(--muted-foreground, #8a8a8a);
                pointer-events: none;
                flex-shrink: 0;
            }
            #hf-model-explorer-dialog .hf-me-filter-popover {
                position: absolute;
                top: calc(100% + 8px);
                left: 0;
                min-width: 20rem;
                max-width: 24rem;
                z-index: 1700;
                border-radius: 8px;
                border: 1px solid var(--border, #494a50);
                background: var(--background, #171718);
                color: var(--foreground, #ffffff);
                padding: 8px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
                box-sizing: border-box;
            }
            #hf-model-explorer-dialog .hf-me-filter-search {
                position: relative;
                width: 100%;
                height: 36px;
                border-radius: 8px;
                border: none;
                background: var(--secondary, #262729);
                margin-bottom: 8px;
            }
            #hf-model-explorer-dialog .hf-me-filter-search:focus-within {
                box-shadow: 0 0 0 1px var(--ring, #8a8a8a);
            }
            #hf-model-explorer-dialog .hf-me-filter-search-icon {
                position: absolute;
                left: 10px;
                top: 50%;
                transform: translateY(-50%);
                color: var(--muted-foreground, #8a8a8a);
                font-size: 14px;
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
                color: var(--foreground, #ffffff);
                font-size: 13px;
                border-radius: 8px;
                padding: 0 10px 0 32px;
                box-sizing: border-box;
            }
            #hf-model-explorer-dialog .hf-me-filter-search-input::placeholder {
                color: var(--muted-foreground, #8a8a8a);
            }
            #hf-model-explorer-dialog .hf-me-filter-meta {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 0 4px 6px;
            }
            #hf-model-explorer-dialog .hf-me-filter-meta-text {
                font-size: 13px;
                color: var(--muted-foreground, #8a8a8a);
                font-weight: 500;
            }
            #hf-model-explorer-dialog .hf-me-filter-clear-btn {
                appearance: none;
                border: none;
                background: transparent;
                color: var(--muted-foreground, #8a8a8a);
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                padding: 2px 6px;
                border-radius: 6px;
            }
            #hf-model-explorer-dialog .hf-me-filter-clear-btn:hover {
                background: var(--accent, #313235);
                color: var(--foreground, #ffffff);
            }
            #hf-model-explorer-dialog .hf-me-filter-divider {
                height: 1px;
                background: var(--border, #494a50);
                margin: 4px 0 8px;
            }
            #hf-model-explorer-dialog .hf-me-filter-options {
                max-height: min(18rem, 45vh);
                overflow-y: auto;
                scrollbar-width: thin;
                scrollbar-color: var(--muted, #3c3d42) transparent;
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            #hf-model-explorer-dialog .hf-me-filter-option {
                appearance: none;
                border: none;
                width: 100%;
                min-height: 40px;
                height: 40px;
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 0 8px;
                border-radius: 8px;
                background: transparent;
                color: var(--foreground, #ffffff);
                text-align: left;
                font-family: var(--font-inter, "Inter", sans-serif);
                font-size: 14px;
                line-height: 20px;
                cursor: pointer;
                box-sizing: border-box;
                flex-shrink: 0;
            }
            #hf-model-explorer-dialog .hf-me-filter-option:hover {
                background: var(--accent, #313235);
            }
            #hf-model-explorer-dialog .hf-me-filter-option.is-selected {
                background: var(--muted, #3c3d42);
            }
            #hf-model-explorer-dialog .hf-me-filter-option-check {
                width: 16px;
                height: 16px;
                border-radius: 4px;
                background: var(--secondary, #262729);
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex: 0 0 auto;
                color: transparent;
                font-size: 11px;
                transition: all 150ms ease;
            }
            #hf-model-explorer-dialog .hf-me-filter-option.is-selected .hf-me-filter-option-check {
                background: var(--foreground, #ffffff);
                color: var(--background, #171718);
            }
            #hf-model-explorer-dialog .hf-me-filter-option-label {
                display: block;
                line-height: 20px;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            #hf-model-explorer-dialog .hf-me-filter-empty {
                padding: 6px 8px;
                color: var(--muted-foreground, #8a8a8a);
                font-size: 13px;
            }
            #hf-model-explorer-dialog .hf-me-toggle-row {
                display: flex;
                align-items: center;
                justify-content: flex-start;
                gap: 16px;
                padding: 8px 24px 24px;
                min-height: 72px;
                box-sizing: border-box;
                border-bottom: none;
                flex-shrink: 0;
            }
            #hf-model-explorer-dialog .hf-me-toggle-label {
                display: inline-flex;
                align-items: center;
                gap: 10px;
                cursor: pointer;
                user-select: none;
                color: var(--foreground, #ffffff);
                font-size: 14px;
                font-weight: 400;
                line-height: 20px;
            }
            #hf-model-explorer-dialog .hf-me-tumbler {
                position: relative;
                display: inline-flex;
                align-items: center;
                width: 36px;
                height: 20px;
                flex-shrink: 0;
                cursor: pointer;
                margin: 0;
            }
            #hf-model-explorer-dialog .hf-me-tumbler input {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                margin: 0;
                opacity: 0;
                cursor: pointer;
                z-index: 2;
            }
            #hf-model-explorer-dialog .hf-me-tumbler-track {
                position: relative;
                display: block;
                width: 36px;
                height: 20px;
                border-radius: 9999px;
                background: var(--secondary, #262729);
                border: 1px solid var(--border, #494a50);
                box-sizing: border-box;
                transition: background-color 140ms ease, border-color 140ms ease;
            }
            #hf-model-explorer-dialog .hf-me-tumbler-track::before {
                content: "";
                position: absolute;
                top: 50%;
                left: 2px;
                width: 14px;
                height: 14px;
                border-radius: 9999px;
                background: #ffffff;
                transform: translateY(-50%);
                transition: transform 140ms ease;
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
            }
            #hf-model-explorer-dialog .hf-me-tumbler input:checked + .hf-me-tumbler-track {
                background: var(--primary, #0b8ce9);
                border-color: var(--primary, #0b8ce9);
            }
            #hf-model-explorer-dialog .hf-me-tumbler input:checked + .hf-me-tumbler-track::before {
                transform: translate(16px, -50%);
            }
            #hf-model-explorer-dialog .hf-me-content-scroll {
                flex: 1 1 auto;
                overflow-y: auto;
                scrollbar-width: thin;
                scrollbar-color: var(--muted, #3c3d42) transparent;
                scrollbar-gutter: stable;
                padding: 0 24px 24px;
            }
            #hf-model-explorer-dialog .hf-me-body {
                min-height: 0;
                width: 100%;
                box-sizing: border-box;
                padding: 0;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            #hf-model-explorer-dialog .hf-me-row {
                display: flex;
                align-items: center;
                gap: 12px;
                min-height: 48px;
                height: 48px;
                border-radius: 12px;
                background: transparent;
                padding: 0 8px 0 16px;
                transition: background-color 150ms ease;
                box-sizing: border-box;
                overflow: hidden;
            }
            #hf-model-explorer-dialog .hf-me-row:hover {
                background: var(--secondary, #262729);
            }
            #hf-model-explorer-dialog .hf-me-row.hf-me-row--grouped {
                border-radius: 0;
                background: transparent;
            }
            #hf-model-explorer-dialog .hf-me-row.hf-me-row--grouped:hover {
                background: var(--secondary, #262729);
            }
            #hf-model-explorer-dialog .hf-me-main {
                min-width: 0;
                display: flex;
                flex: 1 1 auto;
            }
            #hf-model-explorer-dialog .hf-me-file {
                font-family: var(--font-inter, "Inter", sans-serif);
                font-size: 14px;
                font-weight: 600;
                line-height: 20px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                color: var(--foreground, #ffffff);
            }
            #hf-model-explorer-dialog .hf-me-meta {
                margin-left: auto;
                display: grid;
                grid-template-columns: minmax(0, 1fr) calc(36px + 36px + 6.5rem + 12px);
                align-items: center;
                gap: 10px;
                min-width: 0;
                flex: 0 1 60%;
            }
            #hf-model-explorer-dialog .hf-me-tags {
                display: flex;
                align-items: center;
                justify-content: flex-end;
                flex-wrap: nowrap;
                gap: 6px;
                min-width: 0;
                overflow: hidden;
            }
            #hf-model-explorer-dialog .hf-me-tag {
                display: inline-flex;
                align-items: center;
                border-radius: 4px;
                background: var(--muted, #3c3d42);
                color: var(--foreground, #ffffff);
                font-size: 12px;
                line-height: 16px;
                letter-spacing: 0.05em;
                text-transform: uppercase;
                font-weight: 700;
                padding: 4px 8px;
                white-space: nowrap;
                flex: 0 0 auto;
            }
            #hf-model-explorer-dialog .hf-me-tag--size {
                background: transparent;
                text-transform: none;
                letter-spacing: normal;
                color: var(--muted-foreground, #8a8a8a);
                font-size: 12px;
                font-weight: 400;
                font-variant-numeric: tabular-nums;
                padding: 0 4px;
            }
            #hf-model-explorer-dialog .hf-me-actions {
                display: flex;
                align-items: center;
                justify-content: flex-end;
                gap: 6px;
                align-self: center;
                width: calc(36px + 36px + 6.5rem + 12px);
                min-width: calc(36px + 36px + 6.5rem + 12px);
                max-width: calc(36px + 36px + 6.5rem + 12px);
            }
            #hf-model-explorer-dialog .hf-me-action-btn {
                position: relative;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                cursor: pointer;
                white-space: nowrap;
                appearance: none;
                border: none;
                border-radius: 8px;
                text-align: center;
                height: 36px;
                min-height: 36px;
                min-width: 5.5rem;
                padding: 0 16px;
                font-size: 14px;
                font-weight: 500;
                line-height: 20px;
                font-family: var(--font-inter, "Inter", sans-serif);
                transition: background-color 150ms ease, opacity 150ms ease;
            }
            #hf-model-explorer-dialog .hf-me-action-btn i {
                line-height: 1;
            }
            #hf-model-explorer-dialog .hf-me-action-btn:disabled {
                opacity: 0.5;
                cursor: default;
            }
            #hf-model-explorer-dialog .hf-me-action-btn--secondary,
            #hf-model-explorer-dialog .hf-me-action-btn--primary {
                background: var(--muted, #3c3d42);
                color: var(--foreground, #ffffff);
            }
            #hf-model-explorer-dialog .hf-me-action-btn--secondary:hover:not(:disabled),
            #hf-model-explorer-dialog .hf-me-action-btn--primary:hover:not(:disabled) {
                background: var(--border, #494a50);
            }
            #hf-model-explorer-dialog .hf-me-action-btn--move {
                background: var(--muted, #3c3d42);
                color: var(--foreground, #ffffff);
                min-width: 36px;
                width: 36px;
                padding: 0;
                opacity: 0;
                pointer-events: none;
                transform: scale(0.95);
                transition: opacity 150ms ease, transform 150ms ease, background-color 150ms ease;
            }
            #hf-model-explorer-dialog .hf-me-row:hover .hf-me-action-btn--move,
            #hf-model-explorer-dialog .hf-me-row:focus-within .hf-me-action-btn--move {
                opacity: 1;
                pointer-events: auto;
                transform: none;
            }
            #hf-model-explorer-dialog .hf-me-action-btn--move:disabled {
                opacity: 1;
            }
            #hf-model-explorer-dialog .hf-me-action-btn--move:hover:not(:disabled) {
                background: var(--border, #494a50);
            }
            #hf-model-explorer-dialog .hf-me-action-btn--destructive {
                background: var(--destructive, #b33a3a);
                color: #ffffff;
                min-width: 36px;
                width: 36px;
                padding: 0;
                opacity: 0;
                pointer-events: none;
                transform: scale(0.95);
                transition: opacity 150ms ease, transform 150ms ease, background-color 150ms ease;
            }
            #hf-model-explorer-dialog .hf-me-row:hover .hf-me-action-btn--destructive,
            #hf-model-explorer-dialog .hf-me-row:focus-within .hf-me-action-btn--destructive {
                opacity: 1;
                pointer-events: auto;
                transform: none;
            }
            #hf-model-explorer-dialog .hf-me-action-btn--destructive:disabled {
                opacity: 1;
            }
            #hf-model-explorer-dialog .hf-me-action-btn--destructive:hover:not(:disabled) {
                background: #c84646;
            }
            #hf-model-explorer-dialog .hf-me-group-blob {
                border-radius: 12px;
                border: 1px solid var(--border, #494a50);
                background: transparent;
                overflow: hidden;
            }
            #hf-model-explorer-dialog .hf-me-group-blob .hf-me-row {
                border-radius: 0;
            }
            #hf-model-explorer-dialog .hf-me-group-blob .hf-me-row + .hf-me-row {
                border-top: 1px solid color-mix(in srgb, var(--border, #494a50) 55%, transparent);
            }
            .hf-me-confirm-btn.p-button {
                min-height: 40px;
                padding: 8px 16px;
                font-size: 14px;
                font-weight: 500;
                font-family: var(--font-inter, "Inter", sans-serif);
                border-radius: 8px;
                border: none !important;
                box-shadow: none !important;
                background: var(--secondary, #262729) !important;
                color: var(--foreground, #ffffff) !important;
                transition: background-color 150ms ease, opacity 150ms ease;
                display: inline-flex !important;
                align-items: center;
                justify-content: center;
                gap: 6px;
                line-height: 20px;
            }
            .hf-me-confirm-btn.p-button:hover {
                background: var(--accent, #313235) !important;
            }
            .hf-me-confirm-btn.p-button.p-button-success {
                background: #2f9e5b !important;
            }
            .hf-me-confirm-btn.p-button.p-button-success:hover {
                background: #37b368 !important;
            }
            .hf-me-confirm-btn.p-button.hf-btn-primary {
                background: var(--primary, #0b8ce9) !important;
            }
            .hf-me-confirm-btn.p-button.hf-btn-primary:hover {
                background: color-mix(in srgb, var(--primary, #0b8ce9) 90%, black) !important;
            }
            .hf-me-confirm-btn.p-button.p-button-danger {
                background: var(--destructive, #b33a3a) !important;
            }
            .hf-me-confirm-btn.p-button.p-button-danger:hover {
                background: #c84646 !important;
            }
            #hf-model-explorer-dialog .hf-me-empty {
                padding: 22px 10px;
                color: var(--muted-foreground, #8a8a8a);
                font-size: 14px;
            }
            @media (max-width: 720px) {
                #hf-model-explorer-dialog .hf-me-shell {
                    grid-template-columns: minmax(0, 1fr);
                }
                #hf-model-explorer-dialog .hf-me-left-panel {
                    border-right: none;
                    border-bottom: 1px solid var(--border, #494a50);
                    max-height: 230px;
                }
                #hf-model-explorer-dialog .hf-me-toggle-row {
                    flex-wrap: wrap;
                    align-items: flex-start;
                }
                #hf-model-explorer-dialog .hf-me-filter-row {
                    margin-left: 0;
                    justify-content: flex-start;
                    width: 100%;
                    flex-wrap: nowrap;
                }
                #hf-model-explorer-dialog .hf-me-main {
                    flex: 1 1 auto;
                }
                #hf-model-explorer-dialog .hf-me-meta {
                    width: auto;
                    justify-content: initial;
                }
            }
        `;
        document.head.appendChild(style);
    }

    async show() {
        if (!this.element) {
            this.createUi();
        }
        if (this._onDocClick && !this._docClickAttached) {
            document.addEventListener("click", this._onDocClick);
            this._docClickAttached = true;
        }
        this.element.style.display = "flex";
        try {
            await this.refreshAll();
        } catch (error) {
            this.renderError(`Failed to open Model Explorer: ${error}`);
        }
    }

    close() {
        if (this._onDocClick && this._docClickAttached) {
            document.removeEventListener("click", this._onDocClick);
            this._docClickAttached = false;
        }
        if (this.element) {
            this.element.style.display = "none";
            this.closeFilterPopover(null, false);
        }
    }

    async showUploadDialog() {
        showUnifiedImportModelDialog({
            initialMode: "file",
            onSuccess: () => void this.refreshAll(),
        });
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
                <i class="icon-[comfy--ai-model] hf-me-left-title-icon" aria-hidden="true"></i>
                <h2 class="hf-me-left-title">Model Explorer</h2>
            </header>
            <div class="hf-me-left-scroll">
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
                    <i class="hf-me-search-icon icon-[lucide--search] size-4" aria-hidden="true"></i>
                    <input id="hf-me-search" class="hf-me-search-input" type="text" placeholder="Search ..." />
                    <button id="hf-me-search-clear" type="button" class="hf-me-search-clear" aria-label="Clear search" style="display:none;">
                        <i class="icon-[lucide--x] size-3.5" aria-hidden="true"></i>
                    </button>
                </div>
                <button id="hf-me-hfsearch-btn" type="button" class="hf-me-hfsearch-btn" hidden>
                    <i class="icon-[lucide--globe] size-4" aria-hidden="true"></i>
                    <span>Search on Hugging Face</span>
                </button>
            </div>
        `;

        const headerActions = document.createElement("div");
        headerActions.className = "hf-me-header-actions";

        const importBtn = document.createElement("button");
        importBtn.id = "hf-me-import-btn";
        importBtn.type = "button";
        importBtn.className = "hf-me-import-btn";
        importBtn.setAttribute("data-testid", "hf-me-import-btn");
        importBtn.innerHTML = `<i class="icon-[lucide--folder-input] size-4" aria-hidden="true"></i><span>Import</span>`;
        importBtn.onclick = (e) => {
            e.stopPropagation();
            showUnifiedImportModelDialog({
                initialFolder: this.filters.category && this.filters.category !== MODEL_EXPLORER_OTHER_CATEGORY_KEY
                    ? this.filters.category
                    : "",
                onSuccess: () => void this.refreshAll(),
            });
        };

        const closeIconButton = document.createElement("button");
        closeIconButton.type = "button";
        closeIconButton.className = "hf-me-native-close-btn hf-me-close-btn";
        closeIconButton.setAttribute("data-testid", "hf-me-close-btn");
        closeIconButton.setAttribute("aria-label", "Close dialog");
        closeIconButton.innerHTML = `<i class="icon-[lucide--x] size-4" aria-hidden="true"></i>`;
        closeIconButton.onclick = () => this.close();

        headerActions.appendChild(importBtn);
        headerActions.appendChild(closeIconButton);
        mainHeader.appendChild(headerActions);
        mainPanel.appendChild(mainHeader);

        const filterWrap = document.createElement("div");
        filterWrap.className = "hf-me-filter-row";
        filterWrap.style.display = "none";
        filterWrap.innerHTML = `
            <div id="hf-me-base-wrap" class="hf-me-filter" data-filter-key="base">
                <button type="button" class="hf-me-filter-trigger" aria-label="Base model filter">
                    <span class="hf-me-filter-label">Base model</span>
                    <span class="hf-me-filter-badge" style="display:none;">0</span>
                    <i class="icon-[lucide--chevron-down] size-5 hf-me-filter-caret" aria-hidden="true"></i>
                </button>
                <div class="hf-me-filter-popover" style="display:none;">
                    <div class="hf-me-filter-search">
                        <i class="hf-me-filter-search-icon icon-[lucide--search] size-4" aria-hidden="true"></i>
                        <input type="text" class="hf-me-filter-search-input" placeholder="Search ..." />
                    </div>
                    <div class="hf-me-filter-meta">
                        <span class="hf-me-filter-meta-text">0 item selected</span>
                        <button type="button" class="hf-me-filter-clear-btn">Clear all</button>
                    </div>
                    <div class="hf-me-filter-divider"></div>
                    <div class="hf-me-filter-options"></div>
                </div>
            </div>
            <div id="hf-me-precision-wrap" class="hf-me-filter" data-filter-key="precision">
                <button type="button" class="hf-me-filter-trigger" aria-label="Precision filter">
                    <span class="hf-me-filter-label">Precision</span>
                    <span class="hf-me-filter-badge" style="display:none;">0</span>
                    <i class="icon-[lucide--chevron-down] size-5 hf-me-filter-caret" aria-hidden="true"></i>
                </button>
                <div class="hf-me-filter-popover" style="display:none;">
                    <div class="hf-me-filter-search">
                        <i class="hf-me-filter-search-icon icon-[lucide--search] size-4" aria-hidden="true"></i>
                        <input type="text" class="hf-me-filter-search-input" placeholder="Search ..." />
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
        const installedOnlyRow = document.createElement("div");
        installedOnlyRow.id = "hf-me-installed-only-row";
        installedOnlyRow.className = "hf-me-toggle-row";
        installedOnlyRow.innerHTML = `
            <div class="hf-me-toggle-label">
                <label class="hf-me-tumbler hf-me-installed-toggle-wrap">
                    <input id="hf-me-installed-only" type="checkbox" role="switch" aria-label="Show downloaded only" />
                    <span class="hf-me-tumbler-track" aria-hidden="true"></span>
                </label>
                <label for="hf-me-installed-only">Show downloaded only</label>
            </div>
        `;
        installedOnlyRow.appendChild(filterWrap);
        mainPanel.appendChild(installedOnlyRow);

        const bodyScroll = document.createElement("div");
        bodyScroll.className = "hf-me-content-scroll";
        applyNativeScrollbarClasses(bodyScroll);
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
        this.baseControl = this.createFilterControl(panel.querySelector("#hf-me-base-wrap"), "base", "Base model");
        this.precisionControl = this.createFilterControl(panel.querySelector("#hf-me-precision-wrap"), "precision", "Precision");
        this.searchInput = panel.querySelector("#hf-me-search");
        this.searchClearBtn = panel.querySelector("#hf-me-search-clear");
        this.installedOnlyToggle = panel.querySelector("#hf-me-installed-only");
        this.baseWrap = panel.querySelector("#hf-me-base-wrap");
        this.precisionWrap = panel.querySelector("#hf-me-precision-wrap");
        this.filterWrap = filterWrap;
        const leftScroll = leftPanel.querySelector(".hf-me-left-scroll");
        applyNativeScrollbarClasses(leftScroll);
        const toggleInput = this.installedOnlyToggle;

        const updateSliderState = () => {
            if (!toggleInput) return;
            toggleInput.setAttribute("aria-checked", toggleInput.checked ? "true" : "false");
        };
        if (toggleInput) {
            toggleInput.addEventListener("change", () => updateSliderState());
            updateSliderState();
        }
        this.hfSearchBtn = panel.querySelector("#hf-me-hfsearch-btn");
        if (this.hfSearchBtn) {
            this.hfSearchBtn.onclick = () => {
                const q = (this.searchInput?.value || this.filters.search || "").trim();
                if (q.length >= 2) {
                    void this.searchOnHuggingFace(q);
                }
            };
        }
        if (this.searchClearBtn) {
            this.searchClearBtn.onclick = () => {
                this.searchInput.value = "";
                this.searchClearBtn.style.display = "none";
                if (this.hfSearchBtn) this.hfSearchBtn.hidden = true;
                this.filters.search = "";
                void this.refreshGroups();
                this.searchInput.focus();
            };
        }
        this.searchInput.oninput = () => {
            const rawVal = this.searchInput.value.trim();
            if (this.searchClearBtn) {
                this.searchClearBtn.style.display = rawVal.length > 0 ? "inline-flex" : "none";
            }
            if (this.hfSearchBtn) {
                this.hfSearchBtn.hidden = rawVal.length < 2;
            }
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

        this._onDocClick = (event) => {
            if (!this.element || this.element.style.display === "none") return;
            const target = event?.target;
            if (!(target instanceof Element)) return;
            if (target.closest(".hf-me-filter")) return;
            this.closeFilterPopover();
        };
        this._docClickAttached = false;
    }

    async refreshAll() {
        await this.fetchCategories();
        await this.refreshFiltersAndGroups();
    }

    async refreshFiltersAndGroups() {
        this.pendingFilterSelectionRefresh = false;
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
        applyNativeScrollbarClasses(optionsEl);

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
            this.pendingFilterSelectionRefresh = true;
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
            this.pendingFilterSelectionRefresh = true;
        });

        return control;
    }

    closeFilterPopover(keepOpenKey = null, refreshOnClose = true) {
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
            if (refreshOnClose && this.pendingFilterSelectionRefresh) {
                this.pendingFilterSelectionRefresh = false;
                void this.refreshGroups();
            }
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
                : this.normalizeBase(rawValue);
            const dedupeKey = key === "precision" ? value : value.toLowerCase();
            if (
                !value ||
                (key === "precision" && value === "unknown") ||
                (key === "base" && value.toLowerCase() === "unknown")
            ) {
                continue;
            }
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            normalized.push(value);
        }
        normalized.sort((a, b) =>
            this.formatFilterValueLabel(key, a).localeCompare(this.formatFilterValueLabel(key, b), undefined, {
                sensitivity: "base",
            })
        );

        control.options = normalized;
        const selected = Array.isArray(this.filters[key]) ? this.filters[key] : [];
        if (key === "base") {
            const canonicalByLower = new Map(normalized.map((value) => [value.toLowerCase(), value]));
            this.filters[key] = selected
                .map((value) => canonicalByLower.get(String(value || "").toLowerCase()) || "")
                .filter(Boolean);
        } else {
            this.filters[key] = selected.filter((value) => normalized.includes(value));
        }
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
            control.labelEl.textContent = this.formatFilterValueLabel(control.key, value);
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
            const label = this.formatFilterValueLabel(control.key, value);
            return label.toLowerCase().includes(query);
        });
        if (!visibleOptions.length) {
            control.optionsEl.innerHTML = `<div class="hf-me-filter-empty">No items found</div>`;
            return;
        }
        control.optionsEl.innerHTML = visibleOptions
            .map((value) => {
                const isSelected = selected.has(value);
                const label = this.formatFilterValueLabel(control.key, value);
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
            this.filterWrap.style.display = "flex";
            this.filterWrap.style.visibility = "visible";
        }
        if (this.baseWrap) {
            this.baseWrap.style.visibility = filterAllowed ? "visible" : "hidden";
            this.baseWrap.style.pointerEvents = filterAllowed ? "auto" : "none";
        }
        if (this.precisionWrap) {
            this.precisionWrap.style.visibility = precisionAllowed ? "visible" : "hidden";
            this.precisionWrap.style.pointerEvents = precisionAllowed ? "auto" : "none";
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
        this.hfSearchSeq = (this.hfSearchSeq || 0) + 1;
        this.setLoading(true);
        try {
            const params = new URLSearchParams();
            const selectedBase = Array.isArray(this.filters.base) ? this.filters.base : [];
            const selectedPrecision = Array.isArray(this.filters.precision) ? this.filters.precision : [];
            if (this.filters.category) {
                params.set("category", this.filters.category);
            }
            if (selectedBase.length === 1) params.set("base", selectedBase[0]);
            if (selectedPrecision.length === 1) params.set("precision", selectedPrecision[0]);
            if (this.filters.search) params.set("search", this.filters.search);
            if (this.filters.installedOnly) params.set("installed_only", "true");
            params.set("installed_first", "true");
            params.set("offset", "0");
            params.set("limit", "1500");
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

        const createCategoryButton = (value, label, iconClass = "icon-[lucide--folder]") => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "hf-me-nav-item";
            if (value === this.filters.category) {
                button.classList.add("is-active");
            }
            button.innerHTML = `
                <i class="${iconClass} size-4 hf-me-nav-icon" aria-hidden="true"></i>
                <span class="hf-me-nav-label">${escapeHtml(label)}</span>
            `;
            button.onclick = () => {
                if (this.filters.category === value) return;
                this.filters.category = value;
                this.filters.base = [];
                this.filters.precision = [];
                this.closeFilterPopover(null, false);
                this.renderCategorySelect();
                void this.refreshFiltersAndGroups();
            };
            this.categoryList.appendChild(button);
        };

        createCategoryButton("", "All Categories", "icon-[lucide--list]");

        const sectionHeader = document.createElement("div");
        sectionHeader.className = "hf-me-nav-title";
        sectionHeader.innerHTML = `<h3 class="hf-me-nav-title-text">By type</h3>`;
        this.categoryList.appendChild(sectionHeader);

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
        if (normalized === "gguf") return "gguf";
        if (normalized.endsWith(".gguf")) return "gguf";
        if (normalized.startsWith("q") && !normalized.includes("qwen")) return "gguf";
        if (normalized.includes("convrot")) {
            if (normalized.includes("int4") || normalized.includes("int_4") || normalized.includes("fp4")) {
                return "int4 convrot";
            }
            return "int8 convrot";
        }
        return normalized;
    }

    normalizeBase(value) {
        return String(value || "").trim();
    }

    formatBase(value) {
        const base = this.normalizeBase(value);
        if (!base) return "";
        if (base.toLowerCase() === "unknown") return "";
        return base.replaceAll("_", " ");
    }

    formatFilterValueLabel(key, value) {
        if (key === "precision") {
            return this.formatPrecision(value);
        }
        if (key === "base") {
            return this.formatBase(value);
        }
        return String(value || "");
    }

    formatPrecision(value) {
        const precision = this.normalizePrecision(value);
        if (!precision || precision === "unknown") return "";
        if (precision === "gguf") return "GGUF";
        if (precision === "int8 convrot") return "INT8 ConvRot";
        if (precision === "int4 convrot") return "INT4 ConvRot";
        if (precision === "fp8 mixed") return "FP8 Mixed";
        if (precision === "fp8 scaled") return "FP8 Scaled";
        if (precision === "mxfp8") return "MXFP8";
        if (precision === "nvfp4") return "NVFP4";
        return precision.toUpperCase();
    }

    parseSizeBytes(variant) {
        if (!variant || typeof variant !== "object") return null;
        const candidates = [variant.size_bytes, variant.content_length];
        for (const candidate of candidates) {
            if (Number.isFinite(candidate) && candidate > 0) return Number(candidate);
            if (typeof candidate === "string") {
                const parsed = Number.parseInt(candidate, 10);
                if (Number.isFinite(parsed) && parsed > 0) return parsed;
            }
        }
        return null;
    }

    formatSizeGb(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return "";
        const gb = bytes / (1024 * 1024 * 1024);
        if (gb >= 1) {
            return `${gb.toFixed(1).replace(".", ",")}Gb`;
        }
        const mb = bytes / (1024 * 1024);
        return `${mb.toFixed(mb >= 100 ? 0 : 1).replace(".", ",")}Mb`;
    }

    renderVariantRow(group, variant, index, { grouped = false, showCategoryTag = false } = {}) {
        const filename = escapeHtml(variant.filename || "");
        const normalizedPrecision = this.normalizePrecision(variant.precision);
        const precision = this.formatPrecision(normalizedPrecision);
        const baseLabel = this.formatBase(group.base || "");
        const categoryLabel = showCategoryTag ? this.formatCategoryLabel(group.category || "") : "";
        const sizeLabel = this.formatSizeGb(this.parseSizeBytes(variant));
        const variantKey = `${group.group_id}:${index}`;
        const installed = Boolean(variant.installed);

        const tags = [];
        if (categoryLabel) {
            tags.push(`<span class="hf-me-tag">${escapeHtml(categoryLabel)}</span>`);
        }
        if (baseLabel) {
            tags.push(`<span class="hf-me-tag">${escapeHtml(baseLabel)}</span>`);
        }
        if (precision) {
            tags.push(`<span class="hf-me-tag">${escapeHtml(precision)}</span>`);
        }
        if (sizeLabel) {
            tags.push(`<span class="hf-me-tag hf-me-tag--size">${escapeHtml(sizeLabel)}</span>`);
        }

        const actions = installed
            ? `
                <button class="hf-me-action-btn p-button p-component hf-me-action-btn--move" data-action="move" data-key="${variantKey}" aria-label="Move model to another folder" title="Move to another folder">
                    <i class="icon-[lucide--arrow-right] size-3.5" aria-hidden="true"></i>
                </button>
                <button class="hf-me-action-btn p-button p-component hf-me-action-btn--destructive" data-action="delete" data-key="${variantKey}" aria-label="Delete model">
                    <i class="icon-[lucide--trash-2] size-3.5" aria-hidden="true"></i>
                </button>
                <button class="hf-me-action-btn p-button p-component hf-me-action-btn--primary" data-action="use" data-key="${variantKey}">Use</button>
              `
            : `
                <button class="hf-me-action-btn p-button p-component hf-me-action-btn--secondary" data-action="download" data-key="${variantKey}">
                    <i class="icon-[lucide--download] size-3.5" aria-hidden="true"></i>
                    <span>Download</span>
                </button>
              `;

        return `
            <div class="hf-me-row${grouped ? " hf-me-row--grouped" : ""}">
                <div class="hf-me-main">
                    <div class="hf-me-file">${filename}</div>
                </div>
                <div class="hf-me-meta">
                    <div class="hf-me-tags">${tags.join("")}</div>
                    <div class="hf-me-actions">${actions}</div>
                </div>
            </div>
        `;
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

    renderEmptyState() {
        const q = (this.filters.search || "").trim();
        if (q.length >= 2) {
            this.body.innerHTML = `
                <div class="hf-me-empty" style="display:flex;flex-direction:column;align-items:center;gap:0.75rem;">
                    <div>No models found for "${escapeHtml(q)}" in local database.</div>
                    <button type="button" class="hf-me-hfsearch-btn" data-hf-empty-search="1">
                        <i class="icon-[lucide--globe] size-4" aria-hidden="true"></i>
                        <span>Search "${escapeHtml(q)}" on Hugging Face</span>
                    </button>
                </div>
            `;
            const btn = this.body.querySelector("[data-hf-empty-search]");
            if (btn) {
                btn.onclick = () => void this.searchOnHuggingFace(q);
            }
            return;
        }
        this.body.innerHTML = `<div class="hf-me-empty">No models found for current filters.</div>`;
    }

    renderGroups() {
        if (!this.groups.length) {
            this.renderEmptyState();
            return;
        }

        const installedRows = [];
        const groupedRows = [];
        const showCategoryTag = !this.filters.category || this.filters.category === MODEL_EXPLORER_OTHER_CATEGORY_KEY;
        for (const group of this.groups) {
            const variants = Array.isArray(group.variants) ? group.variants : [];
            if (!variants.length) continue;
            const nonInstalledRows = [];
            for (let index = 0; index < variants.length; index += 1) {
                const variant = variants[index];
                if (!variant) continue;
                if (variant.installed) {
                    installedRows.push(
                        this.renderVariantRow(group, variant, index, {
                            grouped: false,
                            showCategoryTag,
                        })
                    );
                    continue;
                }
                nonInstalledRows.push(
                    this.renderVariantRow(group, variant, index, {
                        grouped: true,
                        showCategoryTag,
                    })
                );
            }
            if (nonInstalledRows.length) {
                groupedRows.push(`<div class="hf-me-group-blob">${nonInstalledRows.join("")}</div>`);
            }
        }
        const htmlRows = [...installedRows, ...groupedRows];
        if (!htmlRows.length) {
            this.renderEmptyState();
        } else {
            this.body.innerHTML = htmlRows.join("");
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
                } else if (action === "move") {
                    await this.moveVariant(pair.group, pair.variant, button);
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

    async searchOnHuggingFace(query) {
        const cleanQuery = String(query || "").trim();
        if (cleanQuery.length < 2 || !this.body) return;

        const seq = (this.hfSearchSeq = (this.hfSearchSeq || 0) + 1);
        const renderBanner = (subtitleHtml) => `
            <div class="hf-me-hfsearch-banner">
                <div class="hf-me-hfsearch-banner-title">
                    <i class="icon-[lucide--globe] size-4" aria-hidden="true"></i>
                    <span>${subtitleHtml}</span>
                </div>
                <button type="button" class="hf-me-action-btn p-button p-component hf-me-action-btn--secondary" data-hf-back="1">
                    <i class="icon-[lucide--arrow-left] size-3.5" aria-hidden="true"></i>
                    <span>Back to catalog</span>
                </button>
            </div>
        `;
        const bindBackButton = () => {
            const backBtn = this.body.querySelector("[data-hf-back]");
            if (backBtn) {
                backBtn.onclick = () => {
                    this.hfSearchSeq += 1;
                    this.renderGroups();
                };
            }
        };

        this.body.innerHTML = `
            ${renderBanner(`Searching Hugging Face for "${escapeHtml(cleanQuery)}"...`)}
            <div class="hf-me-empty">Searching Hugging Face for "${escapeHtml(cleanQuery)}"...</div>
        `;
        bindBackButton();

        try {
            const params = new URLSearchParams({ q: cleanQuery, limit: "15" });
            if (this.filters.category && this.filters.category !== MODEL_EXPLORER_OTHER_CATEGORY_KEY) {
                params.set("category", this.filters.category);
            }
            const resp = await this.fetchExplorer(`/hf_search?${params.toString()}`, {}, 45000);
            const data = await resp.json().catch(() => ({}));
            if (seq !== this.hfSearchSeq || !this.body.isConnected) return;
            if (!resp.ok || data.ok === false) {
                this.body.innerHTML = `
                    ${renderBanner(`Hugging Face search failed for "${escapeHtml(cleanQuery)}"`)}
                    <div class="hf-me-empty">Search failed: ${escapeHtml(data.error || `HTTP ${resp.status}`)}</div>
                `;
                bindBackButton();
                return;
            }
            const results = Array.isArray(data.results) ? data.results : [];
            if (!results.length) {
                this.body.innerHTML = `
                    ${renderBanner(`Hugging Face results for "${escapeHtml(cleanQuery)}" (0)`)}
                    <div class="hf-me-empty">No matching model files found on Hugging Face for "${escapeHtml(cleanQuery)}".</div>
                `;
                bindBackButton();
                return;
            }

            const defaultFolder =
                this.filters.category && this.filters.category !== MODEL_EXPLORER_OTHER_CATEGORY_KEY
                    ? this.filters.category
                    : "checkpoints";

            const rowsHtml = results
                .map((item, idx) => {
                    const repoUrl = `https://huggingface.co/${escapeHtml(item.repo_id)}`;
                    const folder = escapeHtml(item.directory || defaultFolder);
                    const tags = [
                        `<a class="hf-me-tag hf-me-tag--link" href="${repoUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.repo_id)}</a>`,
                    ];
                    if (item.is_priority_author) {
                        tags.push(`<span class="hf-me-tag hf-me-tag--priority">priority</span>`);
                    }
                    tags.push(`<span class="hf-me-tag">${folder}/</span>`);
                    tags.push(`<span class="hf-me-tag hf-me-tag--size">♥ ${Number(item.likes || 0)}</span>`);

                    return `
                        <div class="hf-me-row">
                            <div class="hf-me-main">
                                <div class="hf-me-file">${escapeHtml(item.filename)}</div>
                            </div>
                            <div class="hf-me-meta">
                                <div class="hf-me-tags">${tags.join("")}</div>
                                <div class="hf-me-actions">
                                    <button type="button" class="hf-me-action-btn p-button p-component hf-me-action-btn--secondary" data-hf-dl-idx="${idx}">
                                        <i class="icon-[lucide--download] size-3.5" aria-hidden="true"></i>
                                        <span>Download</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                    `;
                })
                .join("");

            this.body.innerHTML = `
                ${renderBanner(`Hugging Face results for "${escapeHtml(cleanQuery)}" (${results.length})`)}
                ${rowsHtml}
            `;
            bindBackButton();

            this.body.querySelectorAll("button[data-hf-dl-idx]").forEach((btn) => {
                btn.onclick = async () => {
                    const item = results[Number(btn.getAttribute("data-hf-dl-idx"))];
                    if (!item?.url) return;
                    btn.disabled = true;
                    btn.textContent = "Queued";
                    try {
                        const dlResp = await this.fetchExplorer("/download", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                models: [
                                    {
                                        filename: item.filename,
                                        url: item.url,
                                        folder: item.directory || defaultFolder,
                                    },
                                ],
                            }),
                        });
                        if (!dlResp.ok) {
                            throw new Error(`HTTP ${dlResp.status}`);
                        }
                        showToast({
                            severity: "info",
                            summary: "Queued",
                            detail: `${item.filename} queued for download.`,
                        });
                    } catch (dlErr) {
                        btn.disabled = false;
                        btn.innerHTML = `<i class="icon-[lucide--download] size-3.5" aria-hidden="true"></i><span>Download</span>`;
                        showToast({
                            severity: "error",
                            summary: "Queue failed",
                            detail: String(dlErr?.message || dlErr),
                        });
                    }
                };
            });
        } catch (err) {
            if (seq !== this.hfSearchSeq || !this.body.isConnected) return;
            this.body.innerHTML = `
                ${renderBanner(`Hugging Face search failed for "${escapeHtml(cleanQuery)}"`)}
                <div class="hf-me-empty">Search error: ${escapeHtml(err?.message || String(err))}</div>
            `;
            bindBackButton();
        }
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
            await addModelNodeFromSelection(category, modelPath, data?.node_hint || null);
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
        const ok = await showConfirmDialog({
            title: "Delete model",
            message: `Delete local file for "${variant.filename}"?`,
            confirmLabel: "Delete",
            confirmTone: "danger",
            cancelLabel: "Cancel",
        });
        if (!ok) return;
        button.disabled = true;
        button.innerHTML = `<i class="pi pi-spin pi-spinner-dotted" aria-hidden="true"></i>`;
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
            await this.refreshGroups();
        } catch (error) {
            showToast({
                severity: "error",
                summary: "Delete failed",
                detail: String(error),
            });
            button.disabled = false;
            button.innerHTML = `<i class="icon-[lucide--trash-2] size-3.5" aria-hidden="true"></i>`;
        }
    }

    async moveVariant(group, variant, button) {
        let folders = [];
        try {
            const resp = await fetchWithTimeout("/folder_structure", {}, 10000);
            if (resp.ok) {
                const data = await resp.json();
                if (Array.isArray(data)) folders = data;
            }
        } catch (_err) {
            // Fall back to known explorer categories if /folder_structure fails
        }
        if (!folders.length && Array.isArray(this.categories)) {
            folders = this.categories.map((c) => c?.id).filter(Boolean);
        }

        const currentFolder = String(variant.directory || group.category || "").trim();
        const targetFolder = await showMoveFolderDialog({
            filename: variant.filename,
            currentFolder,
            folders,
        });
        if (!targetFolder) return;

        button.disabled = true;
        button.innerHTML = `<i class="pi pi-spin pi-spinner-dotted" aria-hidden="true"></i>`;
        try {
            const resp = await this.fetchExplorer("/move", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filename: variant.filename,
                    category: group.category,
                    model_path: variant.model_path,
                    target_folder: targetFolder,
                }),
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                throw new Error(data?.error || `HTTP ${resp.status}`);
            }
            const status = String(data?.status || "");
            if (status === "already_in_place") {
                showToast({
                    severity: "info",
                    summary: "Already in folder",
                    detail: `${variant.filename} is already in ${data?.target_folder || targetFolder}.`,
                });
                button.disabled = false;
                button.innerHTML = `<i class="icon-[lucide--arrow-right] size-3.5" aria-hidden="true"></i>`;
                return;
            }
            showToast({
                severity: "success",
                summary: "Model moved",
                detail: `Moved ${variant.filename} to ${data?.target_folder || targetFolder}.`,
            });
            await this.refreshAll();
        } catch (error) {
            showToast({
                severity: "error",
                summary: "Move failed",
                detail: String(error?.message || error),
            });
            button.disabled = false;
            button.innerHTML = `<i class="icon-[lucide--arrow-right] size-3.5" aria-hidden="true"></i>`;
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
        registerGlobalAction("refreshModelExplorer", () => {
            if (modelExplorerDialog.element && modelExplorerDialog.element.style.display !== "none") {
                void modelExplorerDialog.refreshAll();
            }
        });
    },
});
