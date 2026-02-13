import { app } from "../../../scripts/app.js";
import { ComfyButtonGroup } from "../../../scripts/ui/components/buttonGroup.js";
import { ComfyButton } from "../../../scripts/ui/components/button.js";

const BUTTON_GROUP_CLASS = "hf-downloader-top-menu-group";
const MENU_ID = "hf-downloader-top-menu";
const BUTTON_TOOLTIP = "Hugging Face Downloader";
const BUTTON_SPINNER_STYLE_ID = "hf-downloader-top-menu-spinner-style";
const MAX_ATTACH_ATTEMPTS = 120;

const getActions = () => {
    if (typeof window === "undefined") return {};
    return window.hfDownloader || {};
};

const showToast = (options, type = "info") => {
    let toastOptions = options;
    if (typeof options === "string") {
        toastOptions = { detail: options, severity: type };
    }

    const payload = {
        severity: toastOptions.severity || type,
        summary: toastOptions.summary,
        detail: toastOptions.detail,
        life: toastOptions.life,
        closable: toastOptions.closable,
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
let iconImageElement = null;
let iconSpinnerElement = null;

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

const getPanelState = () => {
    if (typeof window === "undefined") return null;
    return window?.hfDownloader?.downloadPanelState || null;
};

const applyTopButtonState = (state = null) => {
    if (!iconImageElement || !iconSpinnerElement) return;

    const current = state || getPanelState() || {};
    const showSpinner = Boolean(current.minimized && current.hasRunning);

    iconImageElement.style.display = showSpinner ? "none" : "block";
    iconSpinnerElement.style.display = showSpinner ? "block" : "none";
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
    item.addEventListener("click", (event) => {
        event.stopPropagation();
        hideMenu();
        runAction(actionName);
    });

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

const createTopMenuButton = () => {
    ensureSpinnerStyles();

    const button = new ComfyButton({
        icon: "huggingface",
        tooltip: BUTTON_TOOLTIP,
        app,
        enabled: true,
        classList: "comfyui-button comfyui-menu-mobile-collapse primary"
    });

    button.element.classList.add("hf-downloader-button");
    button.element.setAttribute("aria-label", BUTTON_TOOLTIP);
    button.element.title = BUTTON_TOOLTIP;

    const iconUrls = [
        "https://huggingface.co/datasets/huggingface/brand-assets/resolve/main/hf-logo-pirate-white.png?download=true",
        "https://huggingface.co/datasets/huggingface/brand-assets/resolve/main/hf-logo-pirate.png?download=true",
        new URL("./assets/hf-favicon.ico", import.meta.url).toString()
    ];
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
    iconImg.width = 20;
    iconImg.height = 20;
    iconImg.style.display = "block";

    const iconSpinner = document.createElement("div");
    iconSpinner.className = "hf-downloader-top-spinner";
    iconSpinner.setAttribute("aria-hidden", "true");

    if (button.iconElement) {
        button.iconElement.textContent = "";
        Object.assign(button.iconElement.style, {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: "1",
            transform: "none"
        });
        button.iconElement.appendChild(iconImg);
        button.iconElement.appendChild(iconSpinner);
    } else {
        button.element.appendChild(iconImg);
        button.element.appendChild(iconSpinner);
    }

    iconImageElement = iconImg;
    iconSpinnerElement = iconSpinner;
    applyTopButtonState();

    button.element.addEventListener("click", (event) => {
        event.stopPropagation();
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
        toggleMenu(button.element);
    });

    return button;
};

const attachTopMenuButton = (attempt = 0) => {
    if (!panelStateListenerAttached && typeof window !== "undefined") {
        window.addEventListener("hfDownloader:panelState", (event) => {
            applyTopButtonState(event?.detail);
        });
        panelStateListenerAttached = true;
    }

    if (document.querySelector(`.${BUTTON_GROUP_CLASS}`)) {
        applyTopButtonState();
        return;
    }

    const settingsGroup = app.menu?.settingsGroup;
    if (!settingsGroup?.element?.parentElement) {
        if (attempt >= MAX_ATTACH_ATTEMPTS) {
            console.warn("[HF Downloader] Unable to locate the ComfyUI menu bar.");
            return;
        }

        requestAnimationFrame(() => attachTopMenuButton(attempt + 1));
        return;
    }

    const hfButton = createTopMenuButton();
    const buttonGroup = new ComfyButtonGroup(hfButton);
    buttonGroup.element.classList.add(BUTTON_GROUP_CLASS);

    settingsGroup.element.before(buttonGroup.element);
};

app.registerExtension({
    name: "HuggingFaceDownloader.TopMenu",
    setup() {
        attachTopMenuButton();
    }
});
