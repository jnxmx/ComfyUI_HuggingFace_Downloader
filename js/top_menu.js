import { app } from "../../../scripts/app.js";

const MENU_ID = "hf-downloader-top-menu";
const BUTTON_TOOLTIP = "Hugging Face Downloader";
const BUTTON_STYLE_ID = "hf-downloader-top-menu-button-style";
const BUTTON_SELECTOR = `button[aria-label="${BUTTON_TOOLTIP}"]`;
const TOP_MENU_STYLE_SETTING_ID = "downloader.top_menu_button_style";
const TOP_MENU_STYLE_DEFAULT = "default";
const TOP_MENU_STYLE_CHANGE_EVENT = `${TOP_MENU_STYLE_SETTING_ID}.change`;
const ACTIONBAR_STRIP_CLASSES = [
    "bg-transparent",
    "text-muted-foreground",
    "h-6",
    "h-7",
    "rounded-sm",
    "rounded-full",
    "px-2",
    "py-1"
];
const NATIVE_TRIGGER_CLASSES = [
    "hf-downloader-button",
    "relative",
    "inline-flex",
    "cursor-pointer",
    "touch-manipulation",
    "appearance-none",
    "items-center",
    "justify-center",
    "border-none",
    "font-inter",
    "text-xs",
    "font-medium",
    "whitespace-nowrap",
    "transition-colors",
    "focus-visible:ring-1",
    "focus-visible:ring-ring",
    "focus-visible:outline-none",
    "disabled:pointer-events-none",
    "disabled:opacity-50",
    "bg-secondary",
    "text-foreground",
    "hover:bg-accent",
    "group",
    "h-8",
    "gap-1",
    "rounded-lg",
    "pr-1.5",
    "pl-2",
    "data-[state=open]:bg-accent"
];
const NATIVE_MENU_CONTAINER_CLASS =
    "z-3000 min-w-52 overflow-y-auto rounded-lg border border-solid border-border bg-background p-1 text-foreground shadow-lg outline-none";
const NATIVE_MENU_ITEM_CLASS =
    "group flex min-h-8 w-full cursor-pointer appearance-none items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1 text-left font-inter text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";
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
    // Native icon-[lucide--loader-circle] animate-spin is provided by ComfyUI's built-in styles.
};

const ensureButtonStyles = () => {
    if (document.getElementById(BUTTON_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = BUTTON_STYLE_ID;
    style.textContent = `
        .hf-downloader-top-icon-wrap {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 16px;
            height: 16px;
            line-height: 1;
        }
        .hf-downloader-top-icon-wrap img {
            display: block;
            width: 16px;
            height: 16px;
            object-fit: contain;
        }
        button[aria-label="${BUTTON_TOOLTIP}"][data-state="open"] .hf-downloader-chevron {
            transform: none;
            rotate: 180deg;
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

const getBackupPanelState = () => {
    if (typeof window === "undefined") return null;
    return window?.hfDownloader?.backupPanelState || null;
};

const applyTopButtonState = () => {
    const dlState = getPanelState() || {};
    const bkState = getBackupPanelState() || {};
    const showSpinner = Boolean(
        (dlState.minimized && dlState.hasRunning) ||
        (bkState.minimized && bkState.hasRunning)
    );

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

const syncButtonOpenState = () => {
    const stateVal = menuVisible ? "open" : "closed";
    const expandedVal = String(Boolean(menuVisible));
    document.querySelectorAll(BUTTON_SELECTOR).forEach((button) => {
        if (button.getAttribute("data-state") !== stateVal) {
            button.setAttribute("data-state", stateVal);
        }
        if (button.getAttribute("aria-expanded") !== expandedVal) {
            button.setAttribute("aria-expanded", expandedVal);
        }
    });
};

const hideMenu = () => {
    if (menuElement) {
        menuElement.style.display = "none";
        menuElement.setAttribute("data-state", "closed");
    }
    menuVisible = false;
    syncButtonOpenState();
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

const createMenuItem = (label, actionName, iconClass = "") => {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.className = NATIVE_MENU_ITEM_CLASS;

    if (iconClass) {
        const icon = document.createElement("i");
        icon.className = `${iconClass} size-3.5 shrink-0 text-muted-foreground`;
        icon.setAttribute("aria-hidden", "true");
        item.appendChild(icon);
    }

    const labelSpan = document.createElement("span");
    labelSpan.className = "min-w-0 flex-1 truncate";
    labelSpan.textContent = label;
    item.appendChild(labelSpan);

    if (actionName) {
        item.addEventListener("click", (event) => {
            event.stopPropagation();
            hideMenu();
            runAction(actionName);
        });
    }

    return item;
};

const createMenuSeparator = () => {
    const sep = document.createElement("div");
    sep.setAttribute("role", "separator");
    sep.className = "my-1 h-px bg-border/50";
    return sep;
};

const ensureMenu = () => {
    if (menuElement) {
        return menuElement;
    }

    const menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-state", "closed");
    menu.className = NATIVE_MENU_CONTAINER_CLASS;
    Object.assign(menu.style, {
        position: "fixed",
        display: "none",
        flexDirection: "column",
        zIndex: "3000",
        maxHeight: "calc(100vh - 16px)",
        maxWidth: "calc(100vw - 16px)"
    });

    menu.appendChild(createMenuItem("Backup Manager", "showBackupDialog", "icon-[lucide--cloud]"));
    menu.appendChild(createMenuItem("Auto-download models", "runAutoDownload", "icon-[lucide--sparkles]"));
    menu.appendChild(createMenuItem("Model Explorer", "showModelExplorer", "icon-[lucide--compass]"));
    menu.appendChild(createMenuSeparator());
    menu.appendChild(createMenuItem("Download new model", "showManualDownloadDialog", "icon-[lucide--plus]"));

    document.body.appendChild(menu);
    menuElement = menu;

    if (!closeHandlersAttached) {
        document.addEventListener("click", (event) => {
            if (!menuVisible) return;
            const target = event?.target;
            if (target instanceof Element && (menuElement?.contains(target) || target.closest(BUTTON_SELECTOR))) {
                return;
            }
            hideMenu();
        }, true);
        document.addEventListener("keydown", (event) => {
            if (menuVisible && event.key === "Escape") {
                hideMenu();
            }
        });
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
    menu.style.display = "flex";
    const menuWidth = menu.offsetWidth || 208;
    const clampedLeft = Math.max(
        8,
        Math.min(Math.round(rect.left), window.innerWidth - menuWidth - 8)
    );
    menu.style.left = `${clampedLeft}px`;
    menu.style.top = `${Math.round(rect.bottom + 8)}px`;
    menu.setAttribute("data-state", "open");
    menuVisible = true;
    syncButtonOpenState();
};

const createButtonVisuals = (style) => {
    const iconUrls =
        style === "yellow"
            ? [HUGGINGFACE_YELLOW_ICON]
            : [...DEFAULT_ICON_URLS];
    let iconUrlIndex = 0;
    const iconImg = document.createElement("img");
    iconImg.className = "block size-4 object-contain";
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

    const iconSpinner = document.createElement("i");
    iconSpinner.className = "icon-[lucide--loader-circle] size-4 shrink-0 animate-spin text-foreground";
    iconSpinner.style.display = "none";
    iconSpinner.setAttribute("aria-hidden", "true");

    const iconWrap = document.createElement("span");
    iconWrap.className = "hf-downloader-top-icon-wrap relative flex size-4 shrink-0 items-center justify-center";
    iconWrap.setAttribute("aria-hidden", "true");
    iconWrap.appendChild(iconImg);
    iconWrap.appendChild(iconSpinner);

    const chevronIcon = document.createElement("i");
    chevronIcon.className =
        "hf-downloader-chevron icon-[lucide--chevron-down] size-3 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180";
    chevronIcon.setAttribute("aria-hidden", "true");

    return { iconWrap, iconImg, iconSpinner, chevronIcon, style };
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

const applyNativeTriggerButtonStyling = (button) => {
    for (const cls of ACTIONBAR_STRIP_CLASSES) {
        if (button.classList.contains(cls)) {
            button.classList.remove(cls);
        }
    }
    for (const cls of NATIVE_TRIGGER_CLASSES) {
        if (!button.classList.contains(cls)) {
            button.classList.add(cls);
        }
    }
    if (button.getAttribute("data-variant") !== "secondary") {
        button.setAttribute("data-variant", "secondary");
    }
    if (button.getAttribute("aria-haspopup") !== "menu") {
        button.setAttribute("aria-haspopup", "menu");
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
        applyNativeTriggerButtonStyling(button);

        const existing = buttonVisuals.get(button);
        const needsRebuild =
            !existing ||
            existing.style !== style ||
            !button.contains(existing.iconWrap) ||
            !button.contains(existing.chevronIcon);

        if (needsRebuild) {
            const visuals = createButtonVisuals(style);
            button.title = BUTTON_TOOLTIP;
            button.setAttribute("aria-label", BUTTON_TOOLTIP);
            button.replaceChildren(visuals.iconWrap, visuals.chevronIcon);
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

    syncButtonOpenState();
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
    const backupState = getBackupPanelState();
    let restoredAny = false;
    if (panelState?.minimized && panelState?.hasEntries) {
        const restore = window?.hfDownloader?.restoreDownloadPanel;
        if (typeof restore === "function") {
            restore();
            restoredAny = true;
        }
    }
    if (backupState?.minimized && backupState?.hasEntries) {
        const restoreBackup = window?.hfDownloader?.restoreBackupOperationPanel;
        if (typeof restoreBackup === "function") {
            restoreBackup();
            restoredAny = true;
        }
    }
    if (restoredAny) {
        hideMenu();
        applyTopButtonState();
        return;
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
