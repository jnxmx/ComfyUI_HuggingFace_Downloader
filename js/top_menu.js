import { app } from "../../../scripts/app.js";

const MENU_ID = "hf-downloader-top-menu";
const BUTTON_TOOLTIP = "Hugging Face Downloader";
const BUTTON_STYLE_ID = "hf-downloader-top-menu-button-style";
const TRIGGER_CLASS = "hf-downloader-ab-trigger";
const ICON_CLASS = "hf-downloader-ab-icon";
const BUTTON_SELECTOR = `button[aria-label="${BUTTON_TOOLTIP}"], button.${TRIGGER_CLASS}`;
const TOP_MENU_STYLE_SETTING_ID = "downloader.top_menu_button_style";
const TOP_MENU_STYLE_DEFAULT = "default";
const TOP_MENU_STYLE_CHANGE_EVENT = `${TOP_MENU_STYLE_SETTING_ID}.change`;

const NATIVE_MENU_CONTAINER_CLASS =
    "z-3000 min-w-52 overflow-y-auto rounded-lg border border-solid border-border bg-background p-1 text-foreground shadow-lg outline-none";
const NATIVE_MENU_ITEM_CLASS =
    "group flex min-h-8 w-full cursor-pointer appearance-none items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1 text-left font-inter text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

const HUGGINGFACE_YELLOW_ICON = new URL("./assets/hf-logo.png", import.meta.url).toString();
const DEFAULT_ICON_URL = new URL("./assets/hf-logo-pirate.png", import.meta.url).toString();
const CHEVRON_SVG_URL =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2.25' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E";
const SPINNER_SVG_URL =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='%23e5e7eb'%3E%3Ccircle cx='12' cy='3' r='2'/%3E%3Ccircle cx='18.36' cy='5.64' r='1.85' opacity='.88'/%3E%3Ccircle cx='21' cy='12' r='1.7' opacity='.76'/%3E%3Ccircle cx='18.36' cy='18.36' r='1.55' opacity='.64'/%3E%3Ccircle cx='12' cy='21' r='1.4' opacity='.52'/%3E%3Ccircle cx='5.64' cy='18.36' r='1.25' opacity='.4'/%3E%3Ccircle cx='3' cy='12' r='1.15' opacity='.28'/%3E%3Ccircle cx='5.64' cy='5.64' r='1.05' opacity='.18'/%3E%3C/svg%3E";

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

const ensureButtonStyles = () => {
    if (typeof document === "undefined" || document.getElementById(BUTTON_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = BUTTON_STYLE_ID;
    style.textContent = `
        @keyframes hf-dl-top-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        html[data-hf-dl-button-style="disabled"] button.${TRIGGER_CLASS}.${TRIGGER_CLASS} {
            display: none;
        }
        button[aria-label="${BUTTON_TOOLTIP}"].${TRIGGER_CLASS}.${TRIGGER_CLASS},
        button.${TRIGGER_CLASS}.${TRIGGER_CLASS}.${TRIGGER_CLASS} {
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            height: 32px;
            min-height: 32px;
            padding: 0 6px 0 8px;
            border: none;
            border-radius: 8px;
            background: var(--secondary-background, var(--secondary, #262729));
            color: var(--foreground, #ffffff);
            font-family: var(--font-inter, Inter, sans-serif);
            font-size: 12px;
            font-weight: 500;
            line-height: 1;
            white-space: nowrap;
            cursor: pointer;
            transition: background-color 150ms ease, opacity 150ms ease;
        }
        button[aria-label="${BUTTON_TOOLTIP}"].${TRIGGER_CLASS}.${TRIGGER_CLASS}:hover,
        button.${TRIGGER_CLASS}.${TRIGGER_CLASS}.${TRIGGER_CLASS}:hover {
            background: var(--accent, var(--secondary-background-hover, #313235));
            color: var(--foreground, #ffffff);
        }
        button.${TRIGGER_CLASS}.${TRIGGER_CLASS}[data-state="open"] {
            background: var(--accent, var(--secondary-background-hover, #313235));
        }
        button.${TRIGGER_CLASS}.${TRIGGER_CLASS} > i.${ICON_CLASS} {
            display: inline-block;
            width: 16px;
            height: 16px;
            flex-shrink: 0;
            background-color: transparent;
            background-image: url("${DEFAULT_ICON_URL}");
            background-repeat: no-repeat;
            background-position: center;
            background-size: contain;
        }
        html[data-hf-dl-button-style="yellow"] button.${TRIGGER_CLASS}.${TRIGGER_CLASS} > i.${ICON_CLASS} {
            background-image: url("${HUGGINGFACE_YELLOW_ICON}");
        }
        html[data-hf-dl-minimized-spinner="1"] button.${TRIGGER_CLASS}.${TRIGGER_CLASS} > i.${ICON_CLASS} {
            background-image: url("${SPINNER_SVG_URL}");
            animation: hf-dl-top-spin 1s linear infinite;
        }
        button.${TRIGGER_CLASS}.${TRIGGER_CLASS}::after {
            content: "";
            display: inline-block;
            width: 12px;
            height: 12px;
            flex-shrink: 0;
            background-image: url("${CHEVRON_SVG_URL}");
            background-repeat: no-repeat;
            background-position: center;
            background-size: 12px 12px;
            transition: transform 150ms ease;
        }
        button.${TRIGGER_CLASS}.${TRIGGER_CLASS}[data-state="open"]::after {
            transform: rotate(180deg);
        }
    `;
    (document.head || document.documentElement).appendChild(style);
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
    if (typeof document === "undefined") return;
    const dlState = getPanelState() || {};
    const bkState = getBackupPanelState() || {};
    const showSpinner = Boolean(
        (dlState.minimized && dlState.hasRunning) ||
        (bkState.minimized && bkState.hasRunning)
    );
    if (showSpinner) {
        document.documentElement.dataset.hfDlMinimizedSpinner = "1";
    } else {
        delete document.documentElement.dataset.hfDlMinimizedSpinner;
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

const applyTopMenuStyleAttr = () => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.hfDlButtonStyle = getTopMenuButtonStyle();
};

const syncButtonOpenState = () => {
    if (typeof document === "undefined") return;
    const stateVal = menuVisible ? "open" : "closed";
    const expandedVal = String(Boolean(menuVisible));
    document.querySelectorAll(BUTTON_SELECTOR).forEach((button) => {
        if (button.getAttribute("data-state") !== stateVal) {
            button.setAttribute("data-state", stateVal);
        }
        if (button.getAttribute("aria-expanded") !== expandedVal) {
            button.setAttribute("aria-expanded", expandedVal);
        }
        if (button.getAttribute("aria-haspopup") !== "menu") {
            button.setAttribute("aria-haspopup", "menu");
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
    menu.appendChild(createMenuItem("Import model", "showManualDownloadDialog", "icon-[lucide--plus]"));

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
            class: TRIGGER_CLASS,
            icon: ICON_CLASS,
            tooltip: BUTTON_TOOLTIP,
            onClick: handleTopButtonClick
        }
    ],
    setup() {
        ensureButtonStyles();
        applyTopMenuStyleAttr();
        applyTopButtonState();

        const settingsUi = app?.ui?.settings;
        if (settingsUi?.addEventListener) {
            settingsUi.addEventListener(TOP_MENU_STYLE_CHANGE_EVENT, applyTopMenuStyleAttr);
        }

        if (!panelStateListenerAttached && typeof window !== "undefined") {
            window.addEventListener("hfDownloader:panelState", () => {
                applyTopButtonState();
            });
            panelStateListenerAttached = true;
        }
    }
});
