import { app } from "../../../scripts/app.js";
import { ComfyButtonGroup } from "../../../scripts/ui/components/buttonGroup.js";
import { ComfyButton } from "../../../scripts/ui/components/button.js";

const BUTTON_GROUP_CLASS = "hf-downloader-top-menu-group";
const MENU_ID = "hf-downloader-top-menu";
const BUTTON_TOOLTIP = "Hugging Face Downloader";
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
        minWidth: "220px",
        zIndex: 10000,
        display: "none"
    });

    menu.appendChild(createMenuItem("Backup ComfyUI to Hugging Face", "showBackupDialog"));
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
    menu.style.display = "block";
    menuVisible = true;
};

const createTopMenuButton = () => {
    const button = new ComfyButton({
        icon: "huggingface",
        tooltip: BUTTON_TOOLTIP,
        app,
        enabled: true,
        classList: "comfyui-button comfyui-menu-mobile-collapse"
    });

    button.element.classList.add("hf-downloader-button");
    button.element.setAttribute("aria-label", BUTTON_TOOLTIP);
    button.element.title = BUTTON_TOOLTIP;

    const iconUrl = new URL("./assets/hf-logo-pirate.svg", import.meta.url).toString();
    const iconImg = document.createElement("img");
    iconImg.src = iconUrl;
    iconImg.alt = "Hugging Face";
    iconImg.width = 20;
    iconImg.height = 20;
    iconImg.style.display = "block";

    if (button.iconElement) {
        button.iconElement.className = "hf-downloader-icon";
        Object.assign(button.iconElement.style, {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: "1"
        });
        button.iconElement.appendChild(iconImg);
    } else {
        button.element.appendChild(iconImg);
    }

    button.element.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleMenu(button.element);
    });

    return button;
};

const attachTopMenuButton = (attempt = 0) => {
    if (document.querySelector(`.${BUTTON_GROUP_CLASS}`)) {
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
