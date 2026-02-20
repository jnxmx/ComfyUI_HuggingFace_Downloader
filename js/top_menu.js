import { app } from "../../../scripts/app.js";

const MENU_ID = "hf-downloader-top-menu";
const BUTTON_TOOLTIP = "Hugging Face Downloader";
const BUTTON_SPINNER_STYLE_ID = "hf-downloader-top-menu-spinner-style";
const BUTTON_STYLE_ID = "hf-downloader-top-menu-button-style";
const BUTTON_SELECTOR = `button[aria-label="${BUTTON_TOOLTIP}"]`;
const TOP_MENU_STYLE_SETTING_ID = "downloader.top_menu_button_style";
const TOP_MENU_STYLE_DEFAULT = "default";
const TOP_MENU_STYLE_CHANGE_EVENT = `${TOP_MENU_STYLE_SETTING_ID}.change`;
const HUGGINGFACE_YELLOW_ICON =
    new URL("./assets/hf-logo.png", import.meta.url).toString();
const DEFAULT_ICON_URLS = [
    new URL("./assets/hf-logo-pirate-white.png", import.meta.url).toString(),
    new URL("./assets/hf-logo-pirate.png", import.meta.url).toString(),
    new URL("./assets/hf-favicon.ico", import.meta.url).toString()
];
const LORA_BUTTON_TOOLTIP = "Launch LoRA Manager (Shift+Click opens in new window)";
const LORA_BUTTON_SELECTOR = `button[aria-label="${LORA_BUTTON_TOOLTIP}"]`;
const LORA_STYLE_ID = "hf-downloader-lora-button-style";
const LORA_FALLBACK_ICON_HTML = `<span class="lm-top-menu-l-icon">L</span>`;

const getActions = () => {
    if (typeof window === "undefined") return {};
    return window.hfDownloader || {};
};

const showToast = (options, type = "info") => {
    let toastOptions = options;
    if (typeof options === "string") {
        toastOptions = { detail: options, severity: type };
    }

    const life = toastOptions.life ?? 5000;
    const closable = toastOptions.closable ?? true;

    const payload = {
        severity: toastOptions.severity || type,
        summary: toastOptions.summary,
        detail: toastOptions.detail,
        life,
        closable,
    };

    Object.keys(payload).forEach((key) => {
        if (payload[key] === undefined) {
            delete payload[key];
        }
    });

    if (app?.extensionManager?.toast?.add) {
        app.extensionManager.toast.add(payload);
    } else {
        const summary = payload.summary ? `${payload.summary}: ` : "";
        console.log(`[HF Downloader] ${summary}${payload.detail || "Notification"}`);
    }
};

let menuVisible = false;
let menuElement = null;
let closeHandlersAttached = false;
let panelStateListenerAttached = false;
let buttonObserverAttached = false;
let buttonObserver = null;
let decorateQueued = false;
const buttonVisuals = new Map();

const ensureSpinnerStyles = () => {
    if (document.getElementById(BUTTON_SPINNER_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = BUTTON_SPINNER_STYLE_ID;
    style.textContent = `
        .hf-downloader-top-spinner {
            width: 16px;
            height: 16px;
            border-radius: 999px;
            border: 2px solid rgba(255, 255, 255, 0.25);
            border-top-color: #fff;
            animation: hf-downloader-top-spin 0.9s linear infinite;
            display: none;
        }
        @keyframes hf-downloader-top-spin {
            to { transform: rotate(360deg); }
        }
    `;
    document.head.appendChild(style);
};

const ensureButtonStyles = () => {
    if (document.getElementById(BUTTON_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = BUTTON_STYLE_ID;
    style.textContent = `
        button[aria-label="${BUTTON_TOOLTIP}"].hf-downloader-button {
            border-radius: 4px;
            padding: 6px;
            border: 1px solid transparent;
            background-color: var(--primary-bg);
            transition: all 0.2s ease;
            margin-left: 10px;
            margin-right: 6px;
        }
        button[aria-label="${BUTTON_TOOLTIP}"].hf-downloader-button:hover {
            background-color: var(--primary-hover-bg) !important;
        }
        .hf-downloader-top-icon-wrap {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 20px;
            height: 20px;
            line-height: 1;
        }
        .hf-downloader-top-icon-wrap img {
            display: block;
            width: 20px;
            height: 20px;
        }
    `;
    document.head.appendChild(style);
};

const ensureLoraButtonStyles = () => {
    if (document.getElementById(LORA_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = LORA_STYLE_ID;
    style.textContent = `
        button[aria-label="${LORA_BUTTON_TOOLTIP}"].lm-top-menu-button {
            transition: all 0.2s ease;
            border: 1px solid transparent;
            border-radius: 4px;
            padding: 6px;
            background-color: var(--primary-bg);
        }
        button[aria-label="${LORA_BUTTON_TOOLTIP}"].lm-top-menu-button:hover {
            background-color: var(--primary-hover-bg) !important;
        }
        button[aria-label="${LORA_BUTTON_TOOLTIP}"].lm-top-menu-button .lm-top-menu-l-icon {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 20px;
            height: 20px;
            line-height: 1;
            font-size: 18px;
            font-weight: 600;
            color: #fff;
        }
    `;
    document.head.appendChild(style);
};

const getPanelState = () => {
    if (typeof window === "undefined") return null;
    return window?.hfDownloader?.downloadPanelState || null;
};

const applyTopButtonState = (state = null) => {
    const current = state || getPanelState() || {};
    const showSpinner = Boolean(current.minimized && current.hasRunning);

    for (const [button, visuals] of buttonVisuals.entries()) {
        if (!button?.isConnected || !visuals?.iconImg?.isConnected || !visuals?.iconSpinner?.isConnected) {
            buttonVisuals.delete(button);
            continue;
        }

        visuals.iconImg.style.display = showSpinner ? "none" : "block";
        visuals.iconSpinner.style.display = showSpinner ? "block" : "none";
    }
};

const getTopMenuButtonStyle = () => {
    const settingsUi = app?.ui?.settings;
    if (!settingsUi?.getSettingValue) return TOP_MENU_STYLE_DEFAULT;
    const value = settingsUi.getSettingValue(TOP_MENU_STYLE_SETTING_ID);
    if (typeof value === "string" && value) {
        return value;
    }
    return TOP_MENU_STYLE_DEFAULT;
};

const hideMenu = () => {
    if (menuElement) {
        menuElement.style.display = "none";
    }
    menuVisible = false;
};

const runAction = (name) => {
    const actions = getActions();
    const action = actions?.[name];
    if (typeof action === "function") {
        action();
        return;
    }
    showToast({
        severity: "warn",
        summary: "Action unavailable",
        detail: "The requested tool is not ready yet."
    });
};

const createMenuItem = (label, actionName) => {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    Object.assign(item.style, {
        appearance: "none",
        border: "none",
        background: "transparent",
        color: "#ddd",
        padding: "8px 12px",
        textAlign: "left",
        cursor: "pointer",
        width: "100%",
        minWidth: "0",
        boxSizing: "border-box",
        whiteSpace: "nowrap",
        fontSize: "12px"
    });

    item.addEventListener("mouseenter", () => {
        item.style.background = "#2b2f3a";
    });
    item.addEventListener("mouseleave", () => {
        item.style.background = "transparent";
    });

    if (actionName) {
        item.addEventListener("click", (event) => {
            event.stopPropagation();
            hideMenu();
            runAction(actionName);
        });
    }

    return item;
};

const ensureMenu = () => {
    if (menuElement) {
        return menuElement;
    }

    const menu = document.createElement("div");
    menu.id = MENU_ID;
    Object.assign(menu.style, {
        position: "absolute",
        background: "#1f2128",
        border: "1px solid #3c3c3c",
        borderRadius: "8px",
        boxShadow: "0 8px 20px rgba(0,0,0,0.5)",
        padding: "6px 0",
        display: "inline-flex",
        flexDirection: "column",
        width: "max-content",
        minWidth: "0",
        maxWidth: "calc(100vw - 16px)",
        zIndex: 10000,
        overflowX: "auto",
        overflowY: "hidden"
    });
    menu.style.display = "none";

    menu.appendChild(createMenuItem("Backup Manager", "showBackupDialog"));
    menu.appendChild(createMenuItem("Auto-download models", "runAutoDownload"));
    menu.appendChild(createMenuItem("Model Explorer", "showModelExplorer"));

    menu.appendChild(createMenuItem("Download new model", "showManualDownloadDialog"));

    document.body.appendChild(menu);
    menuElement = menu;

    if (!closeHandlersAttached) {
        document.addEventListener("click", hideMenu);
        window.addEventListener("resize", hideMenu);
        closeHandlersAttached = true;
    }

    return menu;
};

const toggleMenu = (buttonEl) => {
    if (menuVisible) {
        hideMenu();
        return;
    }

    const menu = ensureMenu();
    const rect = buttonEl.getBoundingClientRect();
    menu.style.left = `${Math.round(rect.left)}px`;
    menu.style.top = `${Math.round(rect.bottom + 6)}px`;
    menu.style.display = "inline-flex";
    menuVisible = true;
};

const createButtonVisuals = (style) => {
    const iconUrls =
        style === "yellow"
            ? [HUGGINGFACE_YELLOW_ICON]
            : [...DEFAULT_ICON_URLS];
    let iconUrlIndex = 0;
    const iconImg = document.createElement("img");
    iconImg.src = iconUrls[iconUrlIndex];
    iconImg.onerror = () => {
        iconUrlIndex += 1;
        if (iconUrlIndex >= iconUrls.length) {
            iconImg.onerror = null;
            return;
        }
        iconImg.src = iconUrls[iconUrlIndex];
    };
    iconImg.alt = "Hugging Face";

    const iconSpinner = document.createElement("div");
    iconSpinner.className = "hf-downloader-top-spinner";
    iconSpinner.setAttribute("aria-hidden", "true");

    const iconWrap = document.createElement("span");
    iconWrap.className = "hf-downloader-top-icon-wrap";
    iconWrap.setAttribute("aria-hidden", "true");
    iconWrap.appendChild(iconImg);
    iconWrap.appendChild(iconSpinner);

    return { iconWrap, iconImg, iconSpinner, style };
};

const decorateLoraButton = () => {
    ensureLoraButtonStyles();
    const button = document.querySelector(LORA_BUTTON_SELECTOR);
    if (!button) return;
    if (!button.classList.contains("lm-top-menu-button")) {
        button.classList.add("lm-top-menu-button");
    }
    const hasIcon = button.querySelector("svg, .lm-top-menu-l-icon");
    if (!hasIcon) {
        button.innerHTML = LORA_FALLBACK_ICON_HTML;
    }
};

const decorateTopButtons = () => {
    const style = getTopMenuButtonStyle();
    for (const [button] of buttonVisuals.entries()) {
        if (!button?.isConnected) {
            buttonVisuals.delete(button);
        }
    }

    const buttons = document.querySelectorAll(BUTTON_SELECTOR);
    buttons.forEach((button) => {
        button.style.display = style === "disabled" ? "none" : "";

        const existing = buttonVisuals.get(button);
        const needsRebuild =
            !existing ||
            existing.style !== style ||
            !button.contains(existing.iconWrap);

        if (needsRebuild) {
            const visuals = createButtonVisuals(style);
            button.classList.add("hf-downloader-button");
            button.title = BUTTON_TOOLTIP;
            button.setAttribute("aria-label", BUTTON_TOOLTIP);
            button.replaceChildren(visuals.iconWrap);
            buttonVisuals.set(button, visuals);
        } else {
            existing.style = style;
        }

        if (button.dataset.hfDownloaderClickGuard !== "1") {
            button.addEventListener("click", (event) => {
                event.stopPropagation();
            });
            button.dataset.hfDownloaderClickGuard = "1";
        }
    });

    applyTopButtonState();
    decorateLoraButton();
};

const queueDecorateTopButtons = () => {
    if (decorateQueued) return;
    decorateQueued = true;
    requestAnimationFrame(() => {
        decorateQueued = false;
        decorateTopButtons();
    });
};

const handleTopMenuStyleChange = () => {
    buttonVisuals.clear();
    queueDecorateTopButtons();
};

const watchTopButtonRenders = () => {
    if (buttonObserverAttached || typeof MutationObserver === "undefined") return;
    buttonObserver = new MutationObserver(() => {
        queueDecorateTopButtons();
    });
    buttonObserver.observe(document.body, {
        childList: true,
        subtree: true
    });
    buttonObserverAttached = true;
};

const resolveButtonElement = (event) => {
    if (event?.currentTarget instanceof HTMLElement) {
        return event.currentTarget;
    }
    if (event?.target instanceof HTMLElement) {
        const targetButton = event.target.closest(BUTTON_SELECTOR);
        if (targetButton) return targetButton;
    }
    return document.querySelector(BUTTON_SELECTOR);
};

const handleTopButtonClick = (event) => {
    event?.stopPropagation?.();
    const buttonEl = resolveButtonElement(event);
    if (!buttonEl) return;

    const panelState = getPanelState();
    if (panelState?.minimized && panelState?.hasEntries) {
        const restore = window?.hfDownloader?.restoreDownloadPanel;
        if (typeof restore === "function") {
            hideMenu();
            restore();
            applyTopButtonState();
            return;
        }
    }
    toggleMenu(buttonEl);
};

app.registerExtension({
    name: "HuggingFaceDownloader.TopMenu",
    actionBarButtons: [
        {
            icon: "pi pi-cloud-download",
            tooltip: BUTTON_TOOLTIP,
            onClick: handleTopButtonClick
        }
    ],
    setup() {
        ensureSpinnerStyles();
        ensureButtonStyles();
        const settingsUi = app?.ui?.settings;
        if (settingsUi?.addEventListener) {
            settingsUi.addEventListener(TOP_MENU_STYLE_CHANGE_EVENT, handleTopMenuStyleChange);
        }
        queueDecorateTopButtons();
        watchTopButtonRenders();

        if (!panelStateListenerAttached && typeof window !== "undefined") {
            window.addEventListener("hfDownloader:panelState", (event) => {
                applyTopButtonState(event?.detail);
            });
            panelStateListenerAttached = true;
        }
    }
});
