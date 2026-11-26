import { app } from "../../../scripts/app.js";

const STYLE_ID = "hf-unified-import-styles";
const DIALOG_OVERLAY_ID = "hf-import-model-overlay";

const DEFAULT_FOLDERS = [
    "checkpoints",
    "loras",
    "diffusion_models",
    "vae",
    "text_encoders",
    "controlnet",
    "clip_vision",
    "upscale_models",
    "latent_upscale_models",
    "embeddings",
    "ipadapter",
    "style_models",
    "model_patches",
    "animatediff_models",
    "vae_approx",
];

const FOLDER_CLEAN_LABELS = {
    checkpoints: "Checkpoints",
    loras: "LoRA",
    diffusion_models: "Diffusion Models",
    vae: "VAE",
    vae_approx: "VAE Approx",
    text_encoders: "Text Encoders",
    clip: "CLIP",
    clip_vision: "CLIP Vision",
    controlnet: "ControlNet",
    upscale_models: "Upscale Models",
    latent_upscale_models: "Latent Upscale Models",
    embeddings: "Embeddings",
    ipadapter: "IP-Adapter",
    style_models: "Style Models",
    model_patches: "Model Patches",
    animatediff_models: "AnimateDiff Models",
    animatediff_motion_lora: "AnimateDiff Motion LoRA",
    frame_interpolation: "Frame Interpolation",
    background_removal: "Background Removal",
};

const showToast = (options, severityFallback = "info") => {
    const payload = typeof options === "string"
        ? { detail: options, severity: severityFallback }
        : { ...(options || {}) };
    app?.extensionManager?.toast?.add?.({
        severity: payload.severity || severityFallback,
        summary: payload.summary,
        detail: payload.detail,
        life: payload.life ?? 4500,
        closable: payload.closable ?? true,
    });
};

const escapeHtml = (value) =>
    String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");

const formatSizeHuman = (bytes) => {
    const num = Number(bytes);
    if (!Number.isFinite(num) || num <= 0) return "";
    const gb = num / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = num / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(2)} MB`;
    return `${Math.max(1, Math.round(num / 1024))} KB`;
};

const normalizeFolderPathInput = (value) =>
    String(value || "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");

const parseFilenameFromUrl = (url) => {
    if (!url || typeof url !== "string") return "";
    const value = url.trim();
    if (!value) return "";
    const extract = (candidate) => {
        const clean = String(candidate || "").split("?")[0].split("#")[0];
        const parts = clean.split("/").filter(Boolean);
        if (!parts.length) return "";
        const tail = parts[parts.length - 1];
        if (!tail) return "";
        try {
            return decodeURIComponent(tail);
        } catch {
            return tail;
        }
    };
    try {
        if (value.includes("://")) {
            const parsed = new URL(value);
            return extract(parsed.pathname);
        }
    } catch {
        // Fallback below
    }
    return extract(value);
};

const normalizeHfDownloadUrl = (url) => {
    const raw = String(url || "").trim();
    if (!raw) return "";
    try {
        const parsed = new URL(raw);
        if (parsed.hostname.toLowerCase() === "huggingface.co") {
            parsed.pathname = parsed.pathname.replace(/\/blob\//, "/resolve/");
            return parsed.toString();
        }
    } catch {
        // keep original
    }
    return raw;
};

const parseHfFolderLinkInfo = (link) => {
    if (!link || typeof link !== "string") return null;
    const value = link.trim();
    if (!value) return null;

    let pathText = value;
    let isHfHost = false;
    try {
        if (value.includes("://")) {
            const parsed = new URL(value);
            const host = String(parsed.hostname || "").toLowerCase();
            if (host && host !== "huggingface.co") {
                return null;
            }
            isHfHost = host === "huggingface.co";
            pathText = parsed.pathname || "";
        }
    } catch {
        return null;
    }

    const cleanPath = String(pathText).split("?")[0].split("#")[0];
    const pathParts = cleanPath.split("/").filter(Boolean);
    if (pathParts.length < 2) return null;

    const repoOwner = pathParts[0];
    const repoName = pathParts[1];
    if (!repoOwner || !repoName) return null;

    let subfolderParts = [];
    let isExplicitRepoOrTree = false;
    const treeIdx = pathParts.indexOf("tree");
    const resolveIdx = pathParts.indexOf("resolve");
    const blobIdx = pathParts.indexOf("blob");

    if (treeIdx >= 0) {
        isExplicitRepoOrTree = true;
        if (pathParts.length > treeIdx + 2) {
            subfolderParts = pathParts.slice(treeIdx + 2);
        }
    } else if (resolveIdx >= 0 || blobIdx >= 0) {
        const idx = resolveIdx >= 0 ? resolveIdx : blobIdx;
        if (pathParts.length > idx + 2) {
            const remaining = pathParts.slice(idx + 2);
            if (remaining.length > 1) {
                subfolderParts = remaining.slice(0, -1);
            }
        }
    } else if (pathParts.length === 2) {
        isExplicitRepoOrTree = isHfHost;
    } else if (pathParts.length > 2) {
        const remaining = pathParts.slice(2);
        const tail = remaining[remaining.length - 1] || "";
        if (tail.includes(".")) {
            subfolderParts = remaining.slice(0, -1);
        } else {
            subfolderParts = remaining;
            isExplicitRepoOrTree = isHfHost;
        }
    }

    const subfolder = subfolderParts.join("/").replace(/^\/+|\/+$/g, "");
    const targetSegment = subfolder
        ? subfolder.split("/").filter(Boolean).slice(-1)[0]
        : repoName;
    if (!targetSegment) return null;

    return {
        repo: `${repoOwner}/${repoName}`,
        repoName,
        subfolder,
        targetSegment,
        isExplicitRepoOrTree,
    };
};

const buildFolderDownloadDestinationPreview = (folder, targetSegment) => {
    const parts = ["models"];
    const normalizedFolder = normalizeFolderPathInput(folder);
    if (normalizedFolder) parts.push(normalizedFolder);
    if (targetSegment) parts.push(targetSegment);
    return `${parts.join("/")}/`;
};

const formatFolderCleanLabel = (folderId) => {
    const clean = normalizeFolderPathInput(folderId);
    if (!clean) return "Root (models/)";
    if (FOLDER_CLEAN_LABELS[clean]) return FOLDER_CLEAN_LABELS[clean];
    return clean
        .split(/[/_-]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
};

const inferModelFolderFromLinkOrName = (url, filename, fullRepoMode = false, preferredFolder = "") => {
    if (fullRepoMode) return normalizeFolderPathInput(preferredFolder);
    const combined = `${String(url || "")} ${String(filename || "")}`.toLowerCase();

    const urlSegments = (() => {
        try {
            if (url && String(url).includes("://")) {
                return new URL(String(url)).pathname.toLowerCase().split("/").filter(Boolean);
            }
        } catch {
            // ignore
        }
        return String(url || "").toLowerCase().split(/[/?#]+/).filter(Boolean);
    })();

    const directFolderMatches = [
        ["loras", ["loras", "lora"]],
        ["vae_approx", ["vae_approx", "taesd", "taef"]],
        ["vae", ["vae"]],
        ["diffusion_models", ["diffusion_models", "unet"]],
        ["text_encoders", ["text_encoders", "clip"]],
        ["clip_vision", ["clip_vision"]],
        ["controlnet", ["controlnet"]],
        ["checkpoints", ["checkpoints"]],
        ["upscale_models", ["upscale_models"]],
        ["latent_upscale_models", ["latent_upscale_models"]],
        ["embeddings", ["embeddings"]],
        ["ipadapter", ["ipadapter", "ip-adapter", "ip_adapter"]],
        ["style_models", ["style_models"]],
        ["model_patches", ["model_patches"]],
        ["animatediff_models", ["animatediff_models", "animatediff"]],
    ];

    for (const [folder, markers] of directFolderMatches) {
        if (urlSegments.some((seg) => markers.includes(seg))) {
            return folder;
        }
    }

    if (/(?:^|[^a-z])lora(?:[^a-z]|$)/i.test(combined)) return "loras";
    if (/vae_approx|taesd|taeh/i.test(combined)) return "vae_approx";
    if (/(?:^|[^a-z])vae(?:[^a-z]|$)/i.test(combined)) return "vae";
    if (/controlnet/i.test(combined)) return "controlnet";
    if (/clip_vision|siglip/i.test(combined)) return "clip_vision";
    if (/t5xxl|umt5|qwen.*clip|text_encoder/i.test(combined)) return "text_encoders";
    if (/upscale|esrgan|4x[-_]/i.test(combined)) return "upscale_models";
    if (/ipadapter|ip-adapter/i.test(combined)) return "ipadapter";
    if (/embedding/i.test(combined)) return "embeddings";
    if (/diffusion|unet|flux|wan2|qwen_image|minimax/i.test(combined)) return "diffusion_models";
    if (/checkpoint|sdxl|ckpt/i.test(combined)) return "checkpoints";
    const normalizedPreferred = normalizeFolderPathInput(preferredFolder);
    if (normalizedPreferred && normalizedPreferred !== "all") return normalizedPreferred;
    return "loras";
};

const ensureUnifiedImportStyles = () => {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        #${DIALOG_OVERLAY_ID} {
            position: fixed;
            inset: 0;
            width: 100vw;
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.45);
            z-index: 10002;
            padding: 16px;
            box-sizing: border-box;
        }
        .hf-import-dialog {
            width: 602px;
            max-width: calc(100vw - 1rem);
            min-height: 458px;
            max-height: 85vh;
            border-radius: 16px;
            border: 1px solid var(--border, #494a50);
            background: var(--background, #171718);
            color: var(--foreground, #ffffff);
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -4px rgba(0, 0, 0, 0.5);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            outline: none;
            font-family: var(--font-inter, "Inter", sans-serif);
            box-sizing: border-box;
        }
        .hf-import-header {
            display: flex;
            flex-shrink: 0;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 0 12px 0 0;
            height: 56px;
            box-sizing: border-box;
        }
        .hf-import-title-wrap {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 16px;
            font-size: 16px;
            font-weight: 700;
            line-height: 24px;
            color: var(--foreground, #ffffff);
        }
        .hf-import-close-btn {
            appearance: none;
            border: none;
            width: 32px;
            height: 32px;
            border-radius: 8px;
            background: transparent;
            color: var(--muted-foreground, #8a8a8a);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: background-color 150ms ease, color 150ms ease;
            flex-shrink: 0;
            outline: none;
        }
        .hf-import-close-btn:hover {
            background: var(--accent, #313235);
            color: var(--foreground, #ffffff);
        }
        .hf-import-close-btn:focus-visible {
            box-shadow: 0 0 0 1px var(--ring, #8a8a8a);
        }
        .hf-import-body-wrap {
            flex: 1 1 auto;
            min-height: 0;
            display: flex;
            flex-direction: column;
            overflow: auto;
        }
        .hf-cloud-upload-body {
            flex: 1 1 auto;
            min-height: 400px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            gap: 24px;
            border-top: 1px solid var(--border, #494a50);
            padding: 24px 16px 16px;
            box-sizing: border-box;
            overflow-y: auto;
        }
        .hf-import-step-scroll {
            min-height: 0;
            flex: 1 1 auto;
            overflow-y: auto;
        }
        .hf-import-step1-layout {
            display: flex;
            height: 100%;
            flex-direction: column;
            justify-content: space-between;
            gap: 24px;
            font-size: 14px;
            line-height: 20px;
        }
        .hf-import-step1-top {
            display: flex;
            flex-direction: column;
            gap: 24px;
        }
        .hf-import-intro {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .hf-import-intro-main {
            margin: 0;
            color: var(--foreground, #ffffff);
        }
        .hf-import-intro-sub {
            margin: 0;
            color: var(--muted-foreground, #8a8a8a);
        }
        .hf-import-provider-row {
            margin-top: 8px;
            display: inline-flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 4px;
        }
        .hf-import-hf-chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }
        .hf-import-hf-link {
            color: var(--muted-foreground, #8a8a8a);
            text-decoration: underline;
        }
        .hf-import-hf-link:hover {
            color: var(--foreground, #ffffff);
        }
        .hf-import-input-group {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .hf-cloud-url-input {
            height: 40px;
            width: 100%;
            min-width: 0;
            appearance: none;
            border-radius: 8px;
            border: 1px solid transparent;
            background: var(--secondary, #262729);
            padding: 8px 15px;
            font-family: inherit;
            font-size: 14px;
            line-height: 20px;
            color: var(--foreground, #ffffff);
            outline: none;
            box-shadow: none;
            box-sizing: border-box;
            transition: border-color 150ms ease, opacity 150ms ease;
        }
        .hf-cloud-url-input::placeholder {
            color: var(--muted-foreground, #8a8a8a);
        }
        .hf-cloud-url-input:focus,
        .hf-cloud-url-input:focus-visible {
            border-color: var(--ring, #8a8a8a);
            box-shadow: none;
            outline: none;
        }
        .hf-cloud-url-input[aria-invalid="true"] {
            border-color: #f75951;
            box-shadow: none;
        }
        .hf-cloud-url-input:disabled {
            pointer-events: none;
            opacity: 0.5;
        }
        .hf-sr-only {
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border: 0;
        }
        .hf-cloud-dropzone {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 8px;
            border-radius: 8px;
            border: 1px dashed var(--border, #494a50);
            padding: 16px;
            text-align: center;
            cursor: pointer;
            background: transparent;
            transition: border-color 150ms ease, background-color 150ms ease;
            box-sizing: border-box;
            min-height: 94px;
        }
        .hf-cloud-dropzone:hover,
        .hf-cloud-dropzone:focus-within,
        .hf-cloud-dropzone.is-dragover {
            border-color: var(--muted-foreground, #8a8a8a);
        }
        .hf-cloud-dropzone.is-dragover {
            background: rgba(255, 255, 255, 0.03);
        }
        .hf-cloud-dropzone-text {
            color: var(--muted-foreground, #8a8a8a);
            font-size: 14px;
            line-height: 20px;
        }
        .hf-cloud-choose-pill {
            border-radius: 6px;
            background: var(--secondary, #262729);
            padding: 6px 12px;
            font-size: 14px;
            font-weight: 500;
            line-height: 20px;
            color: var(--foreground, #ffffff);
            transition: background-color 150ms ease;
        }
        .hf-cloud-dropzone:hover .hf-cloud-choose-pill {
            background: var(--accent, #313235);
        }
        .hf-import-step1-bottom {
            display: flex;
            flex-direction: column;
            gap: 12px;
            color: var(--muted-foreground, #8a8a8a);
            font-size: 13px;
            line-height: 18px;
        }
        .hf-import-step2-layout {
            display: flex;
            flex-direction: column;
            gap: 16px;
            font-size: 14px;
            line-height: 20px;
            color: var(--muted-foreground, #8a8a8a);
        }
        .hf-import-readout-block {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .hf-import-field-label {
            font-size: 14px;
            line-height: 20px;
            color: var(--muted-foreground, #8a8a8a);
            margin: 0;
        }
        .hf-import-detected-card {
            display: flex;
            align-items: center;
            gap: 12px;
            border-radius: 8px;
            background: var(--secondary, #262729);
            padding: 8px 16px;
            min-height: 36px;
            box-sizing: border-box;
        }
        .hf-import-detected-name {
            margin: 0;
            min-width: 0;
            flex: 1 1 auto;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 14px;
            line-height: 20px;
            font-weight: 400;
            color: var(--foreground, #ffffff);
        }
        .hf-import-detected-meta {
            font-size: 12px;
            color: var(--muted-foreground, #8a8a8a);
            flex-shrink: 0;
        }
        .hf-import-type-label-row {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
            font-size: 14px;
            line-height: 20px;
            color: var(--muted-foreground, #8a8a8a);
        }
        .hf-import-type-label-row label {
            color: var(--muted-foreground, #8a8a8a);
            font-weight: 400;
        }
        .hf-import-select-wrap {
            position: relative;
            width: 100%;
        }
        .hf-import-select-btn {
            width: 100%;
            height: 40px;
            display: inline-flex;
            align-items: center;
            justify-content: space-between;
            border-radius: 8px;
            border: 2.5px solid transparent;
            background: var(--secondary, #262729);
            color: var(--foreground, #ffffff);
            padding: 0 12px 0 8px;
            font-family: inherit;
            font-size: 14px;
            font-weight: 400;
            line-height: 20px;
            cursor: pointer;
            box-sizing: border-box;
            text-align: left;
            outline: none;
            transition: all 200ms ease-in-out;
        }
        .hf-import-select-btn:hover:not(:disabled) {
            background: var(--accent, #313235);
        }
        .hf-import-select-btn:focus-visible,
        .hf-import-select-btn.is-open {
            border-color: var(--border, #494a50);
        }
        .hf-import-select-btn:disabled {
            opacity: 0.3;
            cursor: default;
        }
        .hf-import-select-label {
            flex: 1 1 auto;
            min-width: 0;
            padding: 8px 0 8px 8px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .hf-import-select-chevron-wrap {
            display: flex;
            flex-shrink: 0;
            align-items: center;
            justify-content: center;
            padding-left: 12px;
        }
        .hf-import-select-chevron {
            color: var(--muted-foreground, #8a8a8a);
            transition: transform 150ms ease;
        }
        .hf-import-select-btn.is-open .hf-import-select-chevron {
            transform: rotate(180deg);
        }
        .hf-import-select-menu {
            position: fixed;
            z-index: 10010;
            background: var(--background, #171718);
            color: var(--foreground, #ffffff);
            border: 1px solid var(--border, #494a50);
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            padding: 8px;
            max-height: min(28rem, 45vh);
            overflow-y: auto;
            box-sizing: border-box;
            font-family: var(--font-inter, "Inter", sans-serif);
        }
        .hf-import-select-option {
            width: 100%;
            min-height: 44px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 12px 8px;
            border: none;
            border-radius: 4px;
            background: transparent;
            color: var(--foreground, #ffffff);
            font-family: inherit;
            font-size: 14px;
            font-weight: 400;
            line-height: 20px;
            text-align: left;
            cursor: pointer;
            outline: none;
            box-sizing: border-box;
        }
        .hf-import-select-option:hover {
            background: var(--accent, #313235);
        }
        .hf-import-select-option.is-selected {
            background: var(--muted, #3c3d42);
        }
        .hf-import-dest-preview {
            margin: 0;
            font-size: 12px;
            color: var(--muted-foreground, #8a8a8a);
        }
        .hf-import-upload-layout,
        .hf-import-complete-layout {
            display: flex;
            flex-direction: column;
            gap: 16px;
            font-size: 14px;
            line-height: 20px;
        }
        .hf-import-upload-card {
            position: relative;
            overflow: hidden;
            display: flex;
            align-items: center;
            border-radius: 8px;
            background: var(--secondary, #262729);
            min-height: 76px;
            padding: 16px 20px;
            box-sizing: border-box;
        }
        .hf-import-upload-card-fill {
            position: absolute;
            top: 0;
            bottom: 0;
            left: 0;
            width: 0%;
            background: color-mix(in srgb, var(--primary, #0b8ce9) 34%, var(--secondary, #262729));
            transition: width 150ms linear;
            pointer-events: none;
        }
        .hf-import-upload-card-inner {
            position: relative;
            z-index: 1;
            display: flex;
            align-items: center;
            gap: 16px;
            width: 100%;
            min-width: 0;
        }
        .hf-import-cube-icon {
            color: var(--muted-foreground, #8a8a8a);
            flex-shrink: 0;
        }
        .hf-import-upload-text {
            display: flex;
            flex-direction: column;
            gap: 4px;
            min-width: 0;
            flex: 1 1 auto;
        }
        .hf-import-upload-title {
            margin: 0;
            font-size: 14px;
            font-weight: 500;
            line-height: 20px;
            color: var(--foreground, #ffffff);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .hf-import-upload-sub {
            margin: 0;
            font-size: 13px;
            font-weight: 400;
            line-height: 18px;
            color: var(--muted-foreground, #8a8a8a);
        }
        .hf-import-upload-meta {
            margin: 0;
            font-size: 14px;
            line-height: 20px;
            color: var(--muted-foreground, #8a8a8a);
        }
        .hf-import-complete-text {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-top: 4px;
        }
        .hf-import-complete-heading {
            margin: 0;
            font-size: 15px;
            font-weight: 700;
            line-height: 22px;
            color: var(--foreground, #ffffff);
        }
        .hf-import-complete-sub {
            margin: 0;
            font-size: 14px;
            font-weight: 400;
            line-height: 20px;
            color: var(--muted-foreground, #8a8a8a);
        }
        .hf-import-error {
            font-size: 14px;
            line-height: 20px;
            color: #f75951;
            margin: 0;
        }
        .hf-import-footer {
            display: flex;
            width: 100%;
            justify-content: flex-end;
            gap: 8px;
            flex-shrink: 0;
        }
        .hf-import-btn-ghost {
            appearance: none;
            border: none;
            height: 40px;
            padding: 8px 16px;
            border-radius: 8px;
            background: transparent;
            color: var(--muted-foreground, #8a8a8a);
            font-family: inherit;
            font-size: 14px;
            font-weight: 500;
            line-height: 20px;
            cursor: pointer;
            transition: background-color 150ms ease, color 150ms ease;
        }
        .hf-import-btn-ghost:hover:not(:disabled) {
            background: var(--accent, #313235);
            color: var(--foreground, #ffffff);
        }
        .hf-import-btn-ghost:disabled {
            pointer-events: none;
            opacity: 0.5;
        }
        .hf-import-btn-secondary {
            appearance: none;
            border: none;
            height: 40px;
            padding: 8px 16px;
            border-radius: 8px;
            background: var(--secondary, #262729);
            color: var(--foreground, #ffffff);
            font-family: inherit;
            font-size: 14px;
            font-weight: 500;
            line-height: 20px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            cursor: pointer;
            transition: background-color 150ms ease, opacity 150ms ease;
        }
        .hf-import-btn-secondary:hover:not(:disabled) {
            background: var(--accent, #313235);
        }
        .hf-import-btn-secondary:disabled {
            pointer-events: none;
            opacity: 0.5;
        }
    `;
    (document.head || document.documentElement).appendChild(style);
};

export function showUnifiedImportModelDialog(options = {}) {
    ensureUnifiedImportStyles();

    const existing = document.getElementById(DIALOG_OVERLAY_ID);
    if (existing) {
        existing.__hfCleanup?.();
        existing.remove();
    }

    let step = 1; // 1 = source, 2 = type, 3 = uploading (file), 4 = complete/background
    let activeSource = "url"; // "url" | "repo" | "file"
    let urlValue = String(options.initialUrl || "").trim();
    let fullRepoMode = Boolean(options.fullRepoMode);
    let selectedFile = null;
    let folderOptions = [...DEFAULT_FOLDERS];
    const normalizedInitialFolder = normalizeFolderPathInput(options.initialFolder);
    let selectedFolder = (normalizedInitialFolder && normalizedInitialFolder !== "all") ? normalizedInitialFolder : "loras";
    let freeSpaceBytes = null;
    let freeSpaceText = "Checking...";
    let isSubmitting = false;
    let uploadAbortController = null;
    let activeUploadXhr = null;
    let stepErrorText = "";
    let activeDropdownMenu = null;
    let activeDropdownCleanup = null;
    let uploadUiState = {
        filename: "",
        totalBytes: 0,
        uploadedBytes: 0,
        percent: 0,
        speedMbps: 0,
        etaText: "",
    };
    let completeUiState = {
        mode: "file", // "file" | "download"
        name: "",
        subline: "",
        folderLabel: "LoRA",
    };

    const closeFolderDropdown = () => {
        if (activeDropdownCleanup) {
            try {
                activeDropdownCleanup();
            } catch (_) {}
            activeDropdownCleanup = null;
        }
        if (activeDropdownMenu) {
            try {
                activeDropdownMenu.remove();
            } catch (_) {}
            activeDropdownMenu = null;
        }
    };

    const overlay = document.createElement("div");
    overlay.id = DIALOG_OVERLAY_ID;

    const dialog = document.createElement("div");
    dialog.className = "hf-import-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("data-testid", "hf-import-model-dialog");

    const abortActiveUpload = () => {
        if (uploadAbortController) {
            try {
                uploadAbortController.abort();
            } catch (_) {}
            uploadAbortController = null;
        }
        if (activeUploadXhr) {
            try {
                activeUploadXhr.abort();
            } catch (_) {}
            activeUploadXhr = null;
        }
    };

    const cleanupDialog = () => {
        closeFolderDropdown();
        document.removeEventListener("keydown", onKeyDown);
        abortActiveUpload();
        if (overlay.parentElement) {
            overlay.remove();
        }
    };
    overlay.__hfCleanup = cleanupDialog;

    const onKeyDown = (event) => {
        if (event.key === "Escape") {
            if (activeDropdownMenu) {
                event.preventDefault();
                event.stopPropagation();
                closeFolderDropdown();
                return;
            }
            if (!isSubmitting) {
                event.preventDefault();
                cleanupDialog();
            }
        }
    };
    document.addEventListener("keydown", onKeyDown);

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay && !isSubmitting) {
            cleanupDialog();
        }
    });

    const header = document.createElement("div");
    header.className = "hf-import-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "hf-import-title-wrap";
    titleWrap.id = "hf-import-model-title";
    titleWrap.innerHTML = `<span>Import a model</span>`;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "hf-import-close-btn";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = `<i class="icon-[lucide--x] size-4" aria-hidden="true"></i>`;
    closeBtn.onclick = () => {
        if (isSubmitting) {
            abortActiveUpload();
        }
        cleanupDialog();
    };

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    const bodyWrap = document.createElement("div");
    bodyWrap.className = "hf-import-body-wrap";

    const cloudBody = document.createElement("div");
    cloudBody.className = "hf-cloud-upload-body";

    const stepScroll = document.createElement("div");
    stepScroll.className = "hf-import-step-scroll";

    const stepContainer = document.createElement("div");
    stepScroll.appendChild(stepContainer);

    const footer = document.createElement("div");
    footer.className = "hf-import-footer";

    cloudBody.appendChild(stepScroll);
    cloudBody.appendChild(footer);
    bodyWrap.appendChild(cloudBody);
    dialog.appendChild(header);
    dialog.appendChild(bodyWrap);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const resolveDetectedTarget = () => {
        if (activeSource === "file" && selectedFile) {
            return {
                displayName: selectedFile.name,
                filename: selectedFile.name,
                repoInfo: null,
            };
        }
        const trimmed = urlValue.trim();
        const hfInfo = parseHfFolderLinkInfo(trimmed);
        if (fullRepoMode && hfInfo) {
            return {
                displayName: hfInfo.subfolder ? `${hfInfo.repo} (${hfInfo.subfolder})` : hfInfo.repo,
                filename: hfInfo.targetSegment,
                repoInfo: hfInfo,
            };
        }
        const filename = parseFilenameFromUrl(trimmed);
        if (hfInfo && filename) {
            return {
                displayName: `${hfInfo.repo.replace("/", "__")}__${filename}`,
                filename,
                repoInfo: hfInfo,
            };
        }
        return {
            displayName: filename || trimmed,
            filename: filename || "",
            repoInfo: hfInfo,
        };
    };

    const advanceFromUrlStep = () => {
        const trimmed = urlValue.trim();
        if (!trimmed) {
            stepErrorText = "Please enter a model URL or Hugging Face link.";
            render();
            return;
        }
        let parsedUrl = null;
        try {
            parsedUrl = new URL(trimmed);
            if (!["http:", "https:"].includes(parsedUrl.protocol)) {
                throw new Error("invalid protocol");
            }
        } catch {
            stepErrorText = "Please enter a valid http(s) URL.";
            render();
            return;
        }

        const hfInfo = parseHfFolderLinkInfo(trimmed);
        fullRepoMode = Boolean(hfInfo?.isExplicitRepoOrTree);
        activeSource = fullRepoMode ? "repo" : "url";
        selectedFile = null;

        const detected = resolveDetectedTarget();
        if (!detected.filename) {
            stepErrorText = fullRepoMode
                ? "Could not parse repository or folder name from Hugging Face link."
                : "Could not detect a model filename from this URL.";
            render();
            return;
        }

        stepErrorText = "";
        selectedFolder = inferModelFolderFromLinkOrName(
            trimmed,
            detected.filename,
            fullRepoMode,
            options.initialFolder || ""
        );
        step = 2;
        render();
    };

    const advanceFromFileStep = (file) => {
        if (!file) return;
        selectedFile = file;
        activeSource = "file";
        fullRepoMode = false;
        stepErrorText = "";
        selectedFolder = inferModelFolderFromLinkOrName(
            "",
            file.name,
            false,
            options.initialFolder || ""
        );
        step = 2;
        render();
    };

    // Modal-level drag & drop convenience on Step 1
    let dialogDragDepth = 0;
    dialog.addEventListener("dragenter", (e) => {
        if (step !== 1 || isSubmitting) return;
        if (!e.dataTransfer?.types?.includes?.("Files")) return;
        e.preventDefault();
        dialogDragDepth += 1;
        stepContainer.querySelector('[data-testid="hf-import-dropzone"]')?.classList.add("is-dragover");
    });
    dialog.addEventListener("dragover", (e) => {
        if (step !== 1 || isSubmitting) return;
        if (!e.dataTransfer?.types?.includes?.("Files")) return;
        e.preventDefault();
        stepContainer.querySelector('[data-testid="hf-import-dropzone"]')?.classList.add("is-dragover");
    });
    dialog.addEventListener("dragleave", (e) => {
        if (step !== 1 || isSubmitting) return;
        dialogDragDepth = Math.max(0, dialogDragDepth - 1);
        if (dialogDragDepth === 0) {
            stepContainer.querySelector('[data-testid="hf-import-dropzone"]')?.classList.remove("is-dragover");
        }
    });
    dialog.addEventListener("drop", (e) => {
        if (step !== 1 || isSubmitting) return;
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        e.preventDefault();
        e.stopPropagation();
        dialogDragDepth = 0;
        stepContainer.querySelector('[data-testid="hf-import-dropzone"]')?.classList.remove("is-dragover");
        advanceFromFileStep(file);
    });

    const handleUrlSubmit = async (submitBtn, errorEl) => {
        const trimmed = normalizeHfDownloadUrl(urlValue);
        const detected = resolveDetectedTarget();
        const normalizedFolder = normalizeFolderPathInput(selectedFolder);
        const targetFolder = fullRepoMode ? normalizedFolder : (normalizedFolder || "loras");
        const queueModel = fullRepoMode
            ? {
                filename: detected.filename,
                url: urlValue.trim(),
                folder: targetFolder,
                download_mode: "folder",
            }
            : {
                filename: detected.filename,
                url: trimmed,
                folder: targetFolder,
            };

        isSubmitting = true;
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="pi pi-spin pi-spinner-dotted" aria-hidden="true"></i><span>Importing...</span>`;
        errorEl.style.display = "none";

        try {
            const resp = await fetch("/queue_download", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ models: [queueModel] }),
            });
            if (resp.status !== 200) {
                throw new Error(`Server returned ${resp.status} ${resp.statusText}`);
            }
            const res = await resp.json();
            const queued = Array.isArray(res?.queued) ? res.queued : [];
            const rejected = Array.isArray(res?.rejected) ? res.rejected : [];
            if (!queued.length) {
                const detail = String(rejected[0]?.error || "Download request was rejected.").trim();
                errorEl.textContent = detail;
                errorEl.style.display = "block";
                isSubmitting = false;
                submitBtn.disabled = false;
                submitBtn.textContent = "Import";
                return;
            }
            try {
                window?.hfDownloader?.restoreDownloadPanel?.();
                window?.hfDownloader?.pollDownloadStatusNow?.();
            } catch (_) {}
            isSubmitting = false;
            const folderLabel = formatFolderCleanLabel(targetFolder);
            completeUiState = {
                mode: "download",
                name: detected.displayName || detected.filename,
                subline: fullRepoMode
                    ? buildFolderDownloadDestinationPreview(targetFolder, detected.filename)
                    : folderLabel,
                folderLabel,
            };
            step = 4;
            render();
            options.onSuccess?.({ mode: activeSource, queueModel });
        } catch (err) {
            errorEl.textContent = `Queue error: ${String(err?.message || err)}`;
            errorEl.style.display = "block";
            isSubmitting = false;
            submitBtn.disabled = false;
            submitBtn.textContent = "Import";
        }
    };

    const sendChunkXhr = (formData, onChunkProgress) =>
        new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            activeUploadXhr = xhr;
            xhr.open("POST", "/hf_downloader_model_explorer_v2/upload_chunk", true);
            xhr.upload.onprogress = (evt) => {
                if (evt.lengthComputable) {
                    onChunkProgress(evt.loaded);
                }
            };
            xhr.onload = () => {
                if (activeUploadXhr === xhr) activeUploadXhr = null;
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve();
                } else {
                    reject(new Error(`HTTP ${xhr.status}`));
                }
            };
            xhr.onerror = () => {
                if (activeUploadXhr === xhr) activeUploadXhr = null;
                reject(new Error("Network error"));
            };
            xhr.onabort = () => {
                if (activeUploadXhr === xhr) activeUploadXhr = null;
                const abortErr = new Error("Aborted");
                abortErr.name = "AbortError";
                reject(abortErr);
            };
            xhr.send(formData);
        });

    const updateUploadingDom = () => {
        if (step !== 3) return;
        const fillEl = stepContainer.querySelector(".hf-import-upload-card-fill");
        const bytesEl = stepContainer.querySelector('[data-upload="bytes"]');
        const metaEl = stepContainer.querySelector('[data-upload="speed-eta"]');
        if (fillEl) {
            fillEl.style.width = `${uploadUiState.percent}%`;
        }
        if (bytesEl) {
            const uploadedText = uploadUiState.uploadedBytes > 0
                ? formatSizeHuman(uploadUiState.uploadedBytes)
                : "0.00 MB";
            const totalText = formatSizeHuman(uploadUiState.totalBytes) || "0 KB";
            bytesEl.textContent = `${uploadedText} of ${totalText}`;
        }
        if (metaEl) {
            if (uploadUiState.speedMbps > 0 && uploadUiState.etaText) {
                metaEl.textContent = `${uploadUiState.speedMbps.toFixed(2)} MB/s · ${uploadUiState.etaText} left`;
            } else if (uploadUiState.speedMbps > 0) {
                metaEl.textContent = `${uploadUiState.speedMbps.toFixed(2)} MB/s`;
            } else {
                metaEl.textContent = "Starting upload...";
            }
        }
    };

    const handleFileUploadSubmit = async () => {
        if (!selectedFile || isSubmitting) return;
        closeFolderDropdown();
        isSubmitting = true;
        stepErrorText = "";

        const uploadId = Math.random().toString(36).slice(2) + Date.now().toString(36);
        const targetFolder = normalizeFolderPathInput(selectedFolder) || "loras";
        const filename = selectedFile.name;
        const fileSize = selectedFile.size;
        const chunkSize = 8 * 1024 * 1024;
        const totalChunks = Math.max(1, Math.ceil(fileSize / chunkSize));

        uploadUiState = {
            filename,
            totalBytes: fileSize,
            uploadedBytes: 0,
            percent: 0,
            speedMbps: 0,
            etaText: "",
        };
        step = 3;
        render();

        uploadAbortController = new AbortController();
        const startTime = Date.now();
        let bytesUploaded = 0;

        const reportProgress = (currentTotalBytes) => {
            const clampedBytes = Math.min(fileSize, Math.max(0, currentTotalBytes));
            const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
            const percent = fileSize > 0 ? Math.min(100, (clampedBytes / fileSize) * 100) : 100;
            const speedBps = clampedBytes / elapsedSec;
            const speedMb = speedBps / (1024 * 1024);
            const remainingSec = speedBps > 0 ? Math.max(0, Math.round((fileSize - clampedBytes) / speedBps)) : 0;
            let etaStr = "";
            if (remainingSec > 0) {
                const m = Math.floor(remainingSec / 60);
                const s = remainingSec % 60;
                etaStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
            } else if (clampedBytes < fileSize) {
                etaStr = "<1s";
            }
            uploadUiState = {
                filename,
                totalBytes: fileSize,
                uploadedBytes: clampedBytes,
                percent,
                speedMbps: speedMb,
                etaText: etaStr,
            };
            updateUploadingDom();
        };

        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            if (!uploadAbortController || uploadAbortController.signal.aborted) break;
            const start = chunkIndex * chunkSize;
            const end = Math.min(start + chunkSize, fileSize);
            const chunk = selectedFile.slice(start, end);
            const chunkBytes = end - start;

            const formData = new FormData();
            formData.append("upload_id", uploadId);
            formData.append("filename", filename);
            formData.append("folder", targetFolder);
            formData.append("chunk_index", String(chunkIndex));
            formData.append("total_chunks", String(totalChunks));
            formData.append("chunk", chunk, filename);

            let ok = false;
            let retries = 3;
            while (retries > 0 && !ok) {
                try {
                    await sendChunkXhr(formData, (loadedInChunk) => {
                        if (!uploadAbortController || uploadAbortController.signal.aborted) return;
                        reportProgress(bytesUploaded + Math.min(chunkBytes, loadedInChunk));
                    });
                    ok = true;
                } catch (err) {
                    if (err?.name === "AbortError" || !uploadAbortController || uploadAbortController.signal.aborted) {
                        break;
                    }
                    retries -= 1;
                    if (retries === 0) {
                        isSubmitting = false;
                        uploadAbortController = null;
                        stepErrorText = `Upload failed: ${err?.message || err}`;
                        step = 2;
                        render();
                        return;
                    }
                    await new Promise((r) => setTimeout(r, 1000));
                }
            }

            if (!uploadAbortController || uploadAbortController.signal.aborted) break;

            bytesUploaded += chunkBytes;
            reportProgress(bytesUploaded);
        }

        if (!uploadAbortController || uploadAbortController.signal.aborted) {
            isSubmitting = false;
            uploadAbortController = null;
            step = 2;
            render();
            return;
        }

        isSubmitting = false;
        uploadAbortController = null;
        completeUiState = {
            mode: "file",
            name: filename,
            subline: formatSizeHuman(fileSize) || "0 KB",
            folderLabel: formatFolderCleanLabel(targetFolder),
        };
        step = 4;
        render();
        options.onSuccess?.({ mode: "file", filename, folder: targetFolder });
    };

    const renderStep1 = () => {
        closeFolderDropdown();
        stepContainer.innerHTML = "";
        stepContainer.className = "hf-import-step1-layout";
        stepContainer.setAttribute("data-testid", "hf-import-step-1");

        const topStack = document.createElement("div");
        topStack.className = "hf-import-step1-top";

        const intro = document.createElement("div");
        intro.className = "hf-import-intro";
        intro.innerHTML = `
            <p class="hf-import-intro-main">Paste a model download link to add it to your library.</p>
        `;
        topStack.appendChild(intro);

        const inputGroup = document.createElement("div");
        inputGroup.className = "hf-import-input-group";

        const urlInput = document.createElement("input");
        urlInput.type = "text";
        urlInput.className = "hf-cloud-url-input";
        urlInput.setAttribute("data-testid", "hf-import-url-input");
        urlInput.placeholder = "Paste link here";
        urlInput.autocomplete = "off";
        urlInput.value = urlValue;
        if (stepErrorText) {
            urlInput.setAttribute("aria-invalid", "true");
        }

        const errorEl = document.createElement("p");
        errorEl.className = "hf-import-error";
        errorEl.setAttribute("data-testid", "hf-import-error");
        errorEl.style.display = stepErrorText ? "block" : "none";
        errorEl.textContent = stepErrorText;

        const continueBtn = document.createElement("button");
        continueBtn.type = "button";
        continueBtn.className = "hf-import-btn-secondary";
        continueBtn.setAttribute("data-testid", "hf-import-continue-btn");
        continueBtn.innerHTML = `<span>Continue</span>`;

        const syncContinueDisabled = () => {
            continueBtn.disabled = !urlInput.value.trim();
        };

        urlInput.addEventListener("input", () => {
            urlValue = urlInput.value;
            if (stepErrorText) {
                stepErrorText = "";
                errorEl.style.display = "none";
                urlInput.removeAttribute("aria-invalid");
            }
            syncContinueDisabled();
        });
        urlInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !continueBtn.disabled) {
                event.preventDefault();
                advanceFromUrlStep();
            }
        });

        inputGroup.appendChild(urlInput);
        if (stepErrorText) {
            inputGroup.appendChild(errorEl);
        }
        topStack.appendChild(inputGroup);

        const dropGroup = document.createElement("div");
        dropGroup.className = "hf-import-input-group";

        const dropzone = document.createElement("label");
        dropzone.className = "hf-cloud-dropzone";
        dropzone.setAttribute("data-testid", "hf-import-dropzone");

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.className = "hf-sr-only";
        fileInput.accept = ".safetensors,.ckpt,.pt,.pth,.bin,.gguf,.onnx,.sft";
        fileInput.onchange = (e) => {
            const file = e.target?.files?.[0];
            if (file) advanceFromFileStep(file);
        };

        const dropText = document.createElement("span");
        dropText.className = "hf-cloud-dropzone-text";
        dropText.textContent = "Or drop a model file here";

        const choosePill = document.createElement("span");
        choosePill.className = "hf-cloud-choose-pill";
        choosePill.textContent = "Choose a file";

        dropzone.appendChild(fileInput);
        dropzone.appendChild(dropText);
        dropzone.appendChild(choosePill);

        dropzone.ondragover = (e) => {
            e.preventDefault();
            dropzone.classList.add("is-dragover");
        };
        dropzone.ondragleave = () => {
            dropzone.classList.remove("is-dragover");
        };
        dropzone.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove("is-dragover");
            const file = e.dataTransfer?.files?.[0];
            if (file) advanceFromFileStep(file);
        };

        dropGroup.appendChild(dropzone);
        topStack.appendChild(dropGroup);

        stepContainer.appendChild(topStack);

        syncContinueDisabled();
        continueBtn.onclick = () => advanceFromUrlStep();

        footer.innerHTML = "";
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "hf-import-btn-ghost";
        cancelBtn.setAttribute("data-testid", "hf-import-cancel-btn");
        cancelBtn.textContent = "Cancel";
        cancelBtn.onclick = cleanupDialog;

        footer.appendChild(cancelBtn);
        footer.appendChild(continueBtn);

        setTimeout(() => {
            if (urlInput.isConnected) {
                urlInput.focus();
            }
        }, 0);
    };

    const renderStep2 = () => {
        closeFolderDropdown();
        stepContainer.innerHTML = "";
        stepContainer.className = "hf-import-step2-layout";
        stepContainer.setAttribute("data-testid", "hf-import-step-2");

        const detected = resolveDetectedTarget();

        const readoutBlock = document.createElement("div");
        readoutBlock.className = "hf-import-readout-block";

        const fieldLabel = document.createElement("p");
        fieldLabel.className = "hf-import-field-label";
        if (activeSource === "file") {
            fieldLabel.textContent = "The model file you selected:";
        } else if (fullRepoMode) {
            fieldLabel.textContent = "The repository associated with the link you provided:";
        } else {
            fieldLabel.textContent = "The model associated with the link you provided:";
        }

        const detectedCard = document.createElement("div");
        detectedCard.className = "hf-import-detected-card";

        const detectedName = document.createElement("p");
        detectedName.className = "hf-import-detected-name";
        detectedName.setAttribute("data-testid", "hf-import-detected-name");
        detectedName.textContent = detected.displayName || "Unknown model";
        detectedName.title = detected.displayName || "";
        detectedCard.appendChild(detectedName);

        if (activeSource === "file" && selectedFile) {
            const sizeMeta = document.createElement("span");
            sizeMeta.className = "hf-import-detected-meta";
            sizeMeta.textContent = formatSizeHuman(selectedFile.size);
            detectedCard.appendChild(sizeMeta);
        }

        readoutBlock.appendChild(fieldLabel);
        readoutBlock.appendChild(detectedCard);
        stepContainer.appendChild(readoutBlock);

        const typeBlock = document.createElement("div");
        typeBlock.className = "hf-import-readout-block";

        const typeLabelRow = document.createElement("div");
        typeLabelRow.className = "hf-import-type-label-row";
        typeLabelRow.innerHTML = `
            <label for="hf-import-folder-select-el">What type of model is this?</label>
        `;

        const selectWrap = document.createElement("div");
        selectWrap.className = "hf-import-select-wrap";

        const folderSelect = document.createElement("button");
        folderSelect.type = "button";
        folderSelect.id = "hf-import-folder-select-el";
        folderSelect.className = "hf-import-select-btn";
        folderSelect.setAttribute("data-testid", "hf-import-folder-select");
        folderSelect.setAttribute("role", "combobox");
        folderSelect.setAttribute("aria-haspopup", "listbox");
        folderSelect.setAttribute("aria-expanded", "false");

        const selectLabelEl = document.createElement("span");
        selectLabelEl.className = "hf-import-select-label";

        const chevronWrap = document.createElement("span");
        chevronWrap.className = "hf-import-select-chevron-wrap";
        chevronWrap.innerHTML = `<i class="icon-[lucide--chevron-down] size-5 hf-import-select-chevron" aria-hidden="true"></i>`;

        folderSelect.appendChild(selectLabelEl);
        folderSelect.appendChild(chevronWrap);

        const folderItems = [];
        if (fullRepoMode) {
            folderItems.push({ value: "", label: "Root (models/)" });
        }
        const uniqueFolders = Array.from(new Set(folderOptions.map(normalizeFolderPathInput).filter(Boolean)));
        if (selectedFolder && !uniqueFolders.includes(selectedFolder)) {
            uniqueFolders.unshift(selectedFolder);
        }
        for (const f of uniqueFolders) {
            folderItems.push({ value: f, label: formatFolderCleanLabel(f) });
        }

        selectedFolder = (fullRepoMode && !selectedFolder)
            ? ""
            : (selectedFolder || "loras");

        const updateSelectedDisplay = () => {
            const matched = folderItems.find((item) => item.value === selectedFolder) || folderItems[0];
            if (matched) {
                selectedFolder = matched.value;
                selectLabelEl.textContent = matched.label;
                folderSelect.dataset.value = matched.value;
            }
        };
        updateSelectedDisplay();

        let destPreview = null;
        if (fullRepoMode) {
            destPreview = document.createElement("p");
            destPreview.className = "hf-import-dest-preview";
            destPreview.textContent = `Destination: ${buildFolderDownloadDestinationPreview(
                selectedFolder,
                detected.filename
            )}`;
        }

        const openFolderDropdown = () => {
            if (folderSelect.disabled || isSubmitting) return;
            if (activeDropdownMenu) {
                closeFolderDropdown();
                return;
            }

            const rect = folderSelect.getBoundingClientRect();
            const menu = document.createElement("div");
            menu.className = "hf-import-select-menu scrollbar-custom";
            menu.setAttribute("role", "listbox");
            menu.setAttribute("data-testid", "hf-import-folder-menu");
            menu.style.left = `${rect.left}px`;
            menu.style.width = `${rect.width}px`;

            const spaceBelow = window.innerHeight - rect.bottom - 8;
            if (spaceBelow < 180 && rect.top > 200) {
                menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
            } else {
                menu.style.top = `${rect.bottom + 6}px`;
            }

            for (const item of folderItems) {
                const isSelected = item.value === selectedFolder;
                const optBtn = document.createElement("button");
                optBtn.type = "button";
                optBtn.className = `hf-import-select-option${isSelected ? " is-selected" : ""}`;
                optBtn.setAttribute("role", "option");
                optBtn.setAttribute("aria-selected", isSelected ? "true" : "false");
                optBtn.dataset.value = item.value;

                const optText = document.createElement("span");
                optText.textContent = item.label;
                optBtn.appendChild(optText);

                if (isSelected) {
                    const checkIcon = document.createElement("i");
                    checkIcon.className = "icon-[lucide--check] size-4";
                    checkIcon.setAttribute("aria-hidden", "true");
                    optBtn.appendChild(checkIcon);
                }

                optBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    selectedFolder = item.value;
                    updateSelectedDisplay();
                    if (destPreview) {
                        destPreview.textContent = `Destination: ${buildFolderDownloadDestinationPreview(
                            selectedFolder,
                            detected.filename
                        )}`;
                    }
                    closeFolderDropdown();
                });

                menu.appendChild(optBtn);
            }

            document.body.appendChild(menu);
            folderSelect.classList.add("is-open");
            folderSelect.setAttribute("aria-expanded", "true");
            activeDropdownMenu = menu;

            const selectedEl = menu.querySelector(".hf-import-select-option.is-selected");
            if (selectedEl) {
                selectedEl.scrollIntoView({ block: "nearest" });
            }

            const handleOutsidePointerDown = (e) => {
                if (!menu.contains(e.target) && !folderSelect.contains(e.target)) {
                    closeFolderDropdown();
                }
            };
            const handleWindowResize = () => closeFolderDropdown();

            document.addEventListener("pointerdown", handleOutsidePointerDown, true);
            window.addEventListener("resize", handleWindowResize);

            activeDropdownCleanup = () => {
                document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
                window.removeEventListener("resize", handleWindowResize);
                folderSelect.classList.remove("is-open");
                folderSelect.setAttribute("aria-expanded", "false");
            };
        };

        folderSelect.addEventListener("click", (e) => {
            e.stopPropagation();
            openFolderDropdown();
        });

        selectWrap.appendChild(folderSelect);
        typeBlock.appendChild(typeLabelRow);
        typeBlock.appendChild(selectWrap);
        if (destPreview) {
            typeBlock.appendChild(destPreview);
        }

        stepContainer.appendChild(typeBlock);

        const errorEl = document.createElement("p");
        errorEl.className = "hf-import-error";
        errorEl.setAttribute("data-testid", "hf-import-error");
        errorEl.style.display = stepErrorText ? "block" : "none";
        errorEl.textContent = stepErrorText;
        stepContainer.appendChild(errorEl);

        const exceedsDiskSpace =
            activeSource === "file" &&
            selectedFile &&
            freeSpaceBytes !== null &&
            selectedFile.size > freeSpaceBytes;
        if (exceedsDiskSpace) {
            errorEl.textContent = `Insufficient disk space: file is ${formatSizeHuman(selectedFile.size)}, available ${freeSpaceText}.`;
            errorEl.style.display = "block";
        }

        footer.innerHTML = "";
        const backBtn = document.createElement("button");
        backBtn.type = "button";
        backBtn.className = "hf-import-btn-ghost";
        backBtn.setAttribute("data-testid", "hf-import-back-btn");
        backBtn.textContent = "Back";
        backBtn.onclick = () => {
            if (isSubmitting) {
                abortActiveUpload();
                return;
            }
            if (activeSource === "file") {
                selectedFile = null;
                activeSource = "url";
            }
            stepErrorText = "";
            step = 1;
            render();
        };

        const submitBtn = document.createElement("button");
        submitBtn.type = "button";
        submitBtn.className = "hf-import-btn-secondary";
        submitBtn.setAttribute("data-testid", "hf-import-submit-btn");
        submitBtn.innerHTML = `<span>Import</span>`;
        submitBtn.disabled = Boolean(exceedsDiskSpace);

        submitBtn.onclick = () => {
            if (activeSource === "file") {
                void handleFileUploadSubmit();
            } else {
                void handleUrlSubmit(submitBtn, errorEl);
            }
        };

        footer.appendChild(backBtn);
        footer.appendChild(submitBtn);
    };

    const renderStep3Uploading = () => {
        closeFolderDropdown();
        stepContainer.innerHTML = "";
        stepContainer.className = "hf-import-upload-layout";
        stepContainer.setAttribute("data-testid", "hf-import-step-uploading");

        const card = document.createElement("div");
        card.className = "hf-import-upload-card";

        const fill = document.createElement("div");
        fill.className = "hf-import-upload-card-fill";
        fill.style.width = `${uploadUiState.percent}%`;

        const inner = document.createElement("div");
        inner.className = "hf-import-upload-card-inner";
        inner.innerHTML = `
            <i class="icon-[lucide--box] size-5 hf-import-cube-icon" aria-hidden="true"></i>
            <div class="hf-import-upload-text">
                <p class="hf-import-upload-title" data-upload="title">Uploading ${escapeHtml(uploadUiState.filename)}</p>
                <p class="hf-import-upload-sub" data-upload="bytes"></p>
            </div>
        `;

        card.appendChild(fill);
        card.appendChild(inner);

        const metaEl = document.createElement("p");
        metaEl.className = "hf-import-upload-meta";
        metaEl.setAttribute("data-upload", "speed-eta");

        stepContainer.appendChild(card);
        stepContainer.appendChild(metaEl);

        updateUploadingDom();

        footer.innerHTML = "";
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "hf-import-btn-secondary";
        cancelBtn.setAttribute("data-testid", "hf-import-cancel-upload-btn");
        cancelBtn.textContent = "Cancel";
        cancelBtn.onclick = () => {
            abortActiveUpload();
        };
        footer.appendChild(cancelBtn);
    };

    const renderStep4Complete = () => {
        closeFolderDropdown();
        stepContainer.innerHTML = "";
        stepContainer.className = "hf-import-complete-layout";
        stepContainer.setAttribute("data-testid", "hf-import-step-complete");

        const card = document.createElement("div");
        card.className = "hf-import-upload-card";

        const inner = document.createElement("div");
        inner.className = "hf-import-upload-card-inner";
        inner.innerHTML = `
            <i class="icon-[lucide--box] size-5 hf-import-cube-icon" aria-hidden="true"></i>
            <div class="hf-import-upload-text">
                <p class="hf-import-upload-title" data-testid="hf-import-complete-name">${escapeHtml(completeUiState.name)}</p>
                <p class="hf-import-upload-sub" data-testid="hf-import-complete-sub">${escapeHtml(completeUiState.subline)}</p>
            </div>
        `;
        card.appendChild(inner);

        const textBlock = document.createElement("div");
        textBlock.className = "hf-import-complete-text";

        const heading = document.createElement("p");
        heading.className = "hf-import-complete-heading";
        const sub = document.createElement("p");
        sub.className = "hf-import-complete-sub";

        if (completeUiState.mode === "download") {
            heading.textContent = "Model is downloading in the background.";
            sub.textContent = `You can monitor progress in the downloader window. Once finished, find it in the ${completeUiState.folderLabel} section of the models library.`;
        } else {
            heading.textContent = "Model successfully imported.";
            sub.textContent = `Find it in the ${completeUiState.folderLabel} section of the models library.`;
        }

        textBlock.appendChild(heading);
        textBlock.appendChild(sub);

        stepContainer.appendChild(card);
        stepContainer.appendChild(textBlock);

        footer.innerHTML = "";
        const anotherBtn = document.createElement("button");
        anotherBtn.type = "button";
        anotherBtn.className = "hf-import-btn-ghost";
        anotherBtn.setAttribute("data-testid", "hf-import-another-btn");
        anotherBtn.textContent = "Import Another";
        anotherBtn.onclick = () => {
            urlValue = "";
            selectedFile = null;
            activeSource = "url";
            fullRepoMode = false;
            stepErrorText = "";
            selectedFolder = (normalizedInitialFolder && normalizedInitialFolder !== "all")
                ? normalizedInitialFolder
                : "loras";
            step = 1;
            render();
        };

        const doneBtn = document.createElement("button");
        doneBtn.type = "button";
        doneBtn.className = "hf-import-btn-secondary";
        doneBtn.setAttribute(
            "data-testid",
            completeUiState.mode === "download" ? "hf-import-ok-btn" : "hf-import-finish-btn"
        );
        doneBtn.textContent = completeUiState.mode === "download" ? "OK" : "Finish";
        doneBtn.onclick = cleanupDialog;

        footer.appendChild(anotherBtn);
        footer.appendChild(doneBtn);
    };

    const render = () => {
        if (step === 1) {
            renderStep1();
        } else if (step === 2) {
            renderStep2();
        } else if (step === 3) {
            renderStep3Uploading();
        } else {
            renderStep4Complete();
        }
    };

    render();

    void fetch("/folder_structure")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
            if (!Array.isArray(data) || !data.length || !overlay.isConnected) return;
            folderOptions = data.map(normalizeFolderPathInput).filter(Boolean);
            if (step === 2) render();
        })
        .catch(() => {});

    void fetch("/hf_downloader_model_explorer_v2/disk_space")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
            if (!overlay.isConnected) return;
            if (data && Number.isFinite(data.free)) {
                freeSpaceBytes = data.free;
                freeSpaceText = formatSizeHuman(data.free) || "Unknown";
            } else {
                freeSpaceText = "Unavailable";
            }
            const diskVal = document.getElementById("hf-import-disk-val");
            if (diskVal) diskVal.textContent = freeSpaceText;
            if (step === 2 && activeSource === "file" && !isSubmitting) render();
        })
        .catch(() => {
            freeSpaceText = "Unavailable";
            const diskVal = document.getElementById("hf-import-disk-val");
            if (diskVal) diskVal.textContent = freeSpaceText;
        });
}

if (typeof window !== "undefined") {
    window.hfDownloader = window.hfDownloader || {};
    window.hfDownloader.showUnifiedImportModelDialog = showUnifiedImportModelDialog;
}
