import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { showUnifiedImportModelDialog } from "./import_model_dialog.js";
import {
    unwrapStoreValue,
    getActiveWorkflow,
    findPiniaStore,
    resolveMissingModelStore,
    resolveExecutionErrorStore,
    resolveModelStore,
    getMissingModelCandidates,
    subscribeMissingModels,
    subscribeExecutionErrors,
    subscribeRightSidePanel,
    dismissNativeErrorDialog,
} from "./comfy_stores.js";
import { mountInNativeStack, unmountFromNativeStack } from "./native_stack.js";

const extensionLifecycleHandlers = {
    beforeLoadGraph: null,
    loadedGraphNode: null,
    afterLoadGraph: null,
};

app.registerExtension({
    name: "autoDownloadModels",
    beforeLoadGraph() {
        return extensionLifecycleHandlers.beforeLoadGraph?.();
    },
    loadedGraphNode(node) {
        return extensionLifecycleHandlers.loadedGraphNode?.(node);
    },
    afterLoadGraph() {
        return extensionLifecycleHandlers.afterLoadGraph?.();
    },
    setup() {
        const RUN_HOOK_SETTING_ID = "downloader.auto_open_missing_models_on_run";
        const RUN_HOOK_COOLDOWN_MS = 1800;

        /* ──────────────── Helper Functions ──────────────── */
        const createButton = (text, className, onClick) => {
            const btn = document.createElement("button");
            btn.textContent = text;
            btn.className = className; // e.g. "p-button p-component"
            if (onClick) btn.onclick = onClick;
            return btn;
        };

        const applyNativeButtonStyle = (btn, variant = "secondary") => {
            const palette = {
                primary: {
                    bg: "var(--primary-background)",
                    hover: "var(--primary-background-hover)",
                    fg: "var(--base-foreground)",
                },
                secondary: {
                    bg: "var(--secondary-background)",
                    hover: "var(--secondary-background-hover)",
                    fg: "var(--base-foreground)",
                },
                destructive: {
                    bg: "var(--destructive-background)",
                    hover: "var(--destructive-background-hover)",
                    fg: "var(--base-foreground)",
                },
            };
            const selected = palette[variant] || palette.secondary;

            Object.assign(btn.style, {
                minHeight: "40px",
                padding: "0.45rem 1rem",
                borderRadius: "10px",
                border: "none",
                background: selected.bg,
                color: selected.fg,
                fontSize: "14px",
                fontWeight: "600",
                fontFamily: "var(--font-inter, Inter, sans-serif)",
                lineHeight: "1",
                cursor: "pointer",
                boxShadow: "none",
                transition: "background-color 120ms ease, opacity 120ms ease",
            });

            btn.addEventListener("mouseenter", () => {
                if (!btn.disabled) {
                    btn.style.background = selected.hover;
                }
            });
            btn.addEventListener("mouseleave", () => {
                btn.style.background = selected.bg;
            });
        };

        const TEMPLATE_DIALOG_TOKENS = Object.freeze({
            surface: "var(--base-background, var(--interface-panel-surface, var(--comfy-menu-bg, #1f2128)))",
            panel: "var(--modal-panel-background, var(--base-background, var(--comfy-menu-bg, #1f2128)))",
            border: "var(--interface-stroke, var(--border-color, var(--border-default, #3c4452)))",
            text: "var(--input-text, var(--text-color, var(--p-text-color, #e5e7eb)))",
            shadow: "var(--shadow-interface, 0 12px 28px rgba(0, 0, 0, 0.45))",
        });

        const applyTemplateDialogOverlayStyle = (overlay, zIndex = 9000) => {
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

        const bindBackdropClose = (overlay, onClose) => {
            let pointerDownOnBackdrop = false;

            overlay.addEventListener("pointerdown", (event) => {
                pointerDownOnBackdrop = event.target === overlay;
            });

            overlay.addEventListener("pointercancel", () => {
                pointerDownOnBackdrop = false;
            });

            overlay.addEventListener("click", (event) => {
                const shouldClose = event.target === overlay && pointerDownOnBackdrop;
                pointerDownOnBackdrop = false;
                if (shouldClose && typeof onClose === "function") {
                    onClose();
                }
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
                    border: 1px solid var(--border-default, #4b5563);
                    background: var(--comfy-input-bg, #2b3242);
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
                    background: var(--secondary-background, #3a4458);
                    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
                    transition: transform 140ms ease, background-color 140ms ease;
                }
                .hf-manual-toggle.p-toggleswitch-checked .p-toggleswitch-slider {
                    background: var(--primary-background, #2786e5);
                    border-color: var(--primary-background, #2786e5);
                }
                .hf-manual-toggle.p-toggleswitch-checked .p-toggleswitch-slider::before {
                    transform: translate(20px, -50%);
                    background: var(--base-foreground, #e5e7eb);
                }
                .hf-manual-toggle.p-focus .p-toggleswitch-slider {
                    box-shadow: 0 0 0 2px rgba(39, 134, 229, 0.3);
                }
            `;
            document.head.appendChild(style);
        };

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

        const createInput = (value, placeholder, options = {}) => {
            const { highlightMissingUrl = true } = options;
            const inp = document.createElement("input");
            inp.type = "text";
            inp.value = value || "";
            inp.placeholder = placeholder || "";
            Object.assign(inp.style, {
                background: "var(--comfy-input-bg)",
                border: "1px solid var(--border-default)",
                color: "var(--input-text)",
                padding: "8px 12px",
                borderRadius: "8px",
                width: "100%",
                boxSizing: "border-box",
                minHeight: "40px",
                fontSize: "14px",
                lineHeight: "1.3",
                fontFamily: "var(--font-inter, Inter, sans-serif)",
            });

            if (highlightMissingUrl && !value && placeholder && placeholder.includes("URL")) {
                inp.style.borderColor = "color-mix(in srgb, var(--destructive-background) 50%, var(--border-default) 50%)";
                inp.style.background = "color-mix(in srgb, var(--comfy-input-bg) 88%, var(--destructive-background) 12%)";

                inp.addEventListener("input", () => {
                    if (inp.value.trim()) {
                        inp.style.borderColor = "var(--border-default)";
                        inp.style.background = "var(--comfy-input-bg)";
                    } else {
                        inp.style.borderColor = "color-mix(in srgb, var(--destructive-background) 50%, var(--border-default) 50%)";
                        inp.style.background = "color-mix(in srgb, var(--comfy-input-bg) 88%, var(--destructive-background) 12%)";
                    }
                });
            }

            return inp;
        };

        const showToast = (options, type = "info") => {
            let toastOptions = options;
            if (typeof options === "string") {
                toastOptions = { detail: options, severity: type };
            }

            const sticky = Boolean(toastOptions.sticky);
            const life = toastOptions.life ?? (sticky ? undefined : 5000);
            const closable = toastOptions.closable ?? !sticky;

            const payload = {
                severity: toastOptions.severity || type,
                summary: toastOptions.summary,
                detail: toastOptions.detail,
                closable,
                life,
                sticky: toastOptions.sticky,
                group: toastOptions.group,
                styleClass: toastOptions.styleClass,
                contentStyleClass: toastOptions.contentStyleClass
            };

            Object.keys(payload).forEach((key) => {
                if (payload[key] === undefined) {
                    delete payload[key];
                }
            });

            if (app && app.extensionManager && app.extensionManager.toast && app.extensionManager.toast.add) {
                app.extensionManager.toast.add(payload);
            } else {
                const summary = payload.summary ? `${payload.summary}: ` : "";
                console.log(`[AutoDownload] ${summary}${payload.detail || "Notification"}`);
            }
        };

        const PROGRESS_TOAST_GROUP = "hf-download-progress";
        const PROGRESS_TOAST_LIFE_MS = 60000;

        const getToastGroupClear = () => {
            const toast = app?.extensionManager?.toast;
            if (!toast) {
                return null;
            }
            if (typeof toast.clearGroup === "function") {
                return (group) => toast.clearGroup(group);
            }
            if (typeof toast.removeGroup === "function") {
                return (group) => toast.removeGroup(group);
            }
            if (typeof toast.clear === "function" && toast.clear.length >= 1) {
                return (group) => toast.clear(group);
            }
            return null;
        };

        const clearProgressToast = () => {
            const clearGroup = getToastGroupClear();
            if (clearGroup) {
                clearGroup(PROGRESS_TOAST_GROUP);
            }
            const stale = document.querySelectorAll(".hf-downloader-progress-toast");
            stale.forEach((node) => {
                const toast = node.closest(".p-toast-message") || node;
                toast.remove();
            });
        };

        const showProgressToast = (name) => {
            const clearGroup = getToastGroupClear();
            if (clearGroup) {
                clearGroup(PROGRESS_TOAST_GROUP);
                showToast({
                    severity: "info",
                    summary: "Download in progress",
                    detail: name,
                    group: PROGRESS_TOAST_GROUP,
                    sticky: true,
                    closable: false,
                    styleClass: "hf-downloader-progress-toast"
                });
                return;
            }
            showToast({
                severity: "info",
                summary: "Download in progress",
                detail: name,
                life: PROGRESS_TOAST_LIFE_MS,
                styleClass: "hf-downloader-progress-toast"
            });
        };

        const showFinalToast = (failures, total) => {
            clearProgressToast();
            const finishedDetail = failures
                ? `${total - failures} succeeded, ${failures} failed.`
                : `${total} model(s) downloaded.`;
            const finishedSeverity = failures
                ? (failures === total ? "error" : "warn")
                : "success";
            const finishedSummary = failures
                ? (failures === total ? "Downloads failed" : "Downloads finished with errors")
                : "Downloads finished";
            showToast({
                severity: finishedSeverity,
                summary: finishedSummary,
                detail: finishedDetail,
                life: 8000
            });
        };

        const registerGlobalAction = (name, action) => {
            if (typeof window === "undefined") return;
            if (!window.hfDownloader) {
                window.hfDownloader = {};
            }
            window.hfDownloader[name] = action;
        };

        const getRunHookEnabled = () => {
            const settingsUi = app?.ui?.settings;
            if (!settingsUi?.getSettingValue) {
                return true;
            }
            return settingsUi.getSettingValue(RUN_HOOK_SETTING_ID) !== false;
        };

        const getWorkflowOpenAutoEnabled = () => {
            const settingsUi = app?.ui?.settings;
            if (!settingsUi?.getSettingValue) {
                return true;
            }
            return settingsUi.getSettingValue(RUN_HOOK_SETTING_ID) !== false;
        };

        const getActiveWorkflowEntry = () => getActiveWorkflow();

        const getActiveWorkflowPathKey = () => {
            const activeWorkflow = getActiveWorkflowEntry();
            return String(activeWorkflow?.path || activeWorkflow?.key || "").trim();
        };

        const getActiveWorkflowStableKey = () => {
            const activeWorkflow = getActiveWorkflowEntry();
            if (!activeWorkflow) return "";
            return String(
                activeWorkflow?.key ||
                activeWorkflow?.path ||
                activeWorkflow?.fullFilename ||
                activeWorkflow?.filename ||
                ""
            ).trim();
        };

        const isMissingModelCandidate = (candidate) => {
            if (!candidate || typeof candidate !== "object") {
                return false;
            }
            if (candidate.isMissing === false) {
                return false;
            }
            const name = String(candidate?.name || candidate?.filename || "").trim();
            if (!name) {
                return false;
            }
            const directory = String(candidate?.directory || candidate?.folder || "").trim();
            const inputName = String(candidate?.widgetName || candidate?.input_name || "").trim();
            const nodeId = candidate?.nodeId ?? candidate?.node_id;
            return Boolean(directory || inputName || nodeId !== undefined || candidate?.url || candidate?.isMissing === true);
        };

        let availableFolders = [
            "checkpoints",
            "loras",
            "vae",
            "controlnet",
            "upscale_models",
            "text_encoders",
            "clip_vision"
        ];
        const folderPickers = new Set();

        const loadFolderList = () => {
            fetch("/folder_structure")
                .then(r => r.json())
                .then(folders => {
                    if (Array.isArray(folders) && folders.length > 0) {
                        availableFolders = folders;
                        Array.from(folderPickers).forEach(picker => picker.refresh());
                        console.log("[AutoDownload] Loaded folder list:", folders);
                    } else {
                        console.warn("[AutoDownload] No folders returned from /folder_structure");
                    }
                })
                .catch(err => {
                    console.error("[AutoDownload] Failed to fetch folder structure:", err);
                });
        };

        const createFolderPicker = (value, placeholder) => {
            const wrapper = document.createElement("div");
            Object.assign(wrapper.style, {
                position: "relative",
                width: "100%"
            });

            const input = createInput(value, placeholder);
            input.autocomplete = "off";
            input.style.paddingRight = "26px";

            const toggleBtn = document.createElement("button");
            toggleBtn.type = "button";
            toggleBtn.tabIndex = -1;
            toggleBtn.setAttribute("aria-label", "Choose destination folder");
            Object.assign(toggleBtn.style, {
                position: "absolute",
                right: "2px",
                top: "50%",
                transform: "translateY(-50%)",
                width: "18px",
                height: "18px",
                padding: "0",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--descrip-text, var(--muted-foreground, #9aa4b6))",
                borderRadius: "4px",
            });
            toggleBtn.innerHTML = `<i class="icon-[lucide--chevron-down] size-3" aria-hidden="true"></i>`;

            const dropdown = document.createElement("div");
            dropdown.className = "hf-folder-picker-dropdown";
            dropdown.setAttribute("data-testid", "hf-folder-picker-dropdown");
            Object.assign(dropdown.style, {
                position: "fixed",
                top: "0px",
                left: "0px",
                width: "190px",
                background: "var(--comfy-menu-bg, var(--background, #1e1e1e))",
                border: "1px solid var(--border-default, rgba(255, 255, 255, 0.14))",
                borderRadius: "8px",
                boxShadow: "0 10px 28px rgba(0, 0, 0, 0.45)",
                maxHeight: "220px",
                overflowY: "auto",
                padding: "4px",
                zIndex: "10050",
                display: "none",
                boxSizing: "border-box",
                pointerEvents: "auto",
            });
            applyNativeScrollbarClasses(dropdown);

            let isOpen = false;
            let lastUseFilter = false;
            let listenersAttached = false;
            let suppressInputReopen = false;

            const selectFolder = (folder) => {
                input.value = folder;
                input.style.border = "";
                input.style.boxShadow = "";
                hideList();
                suppressInputReopen = true;
                try {
                    input.dispatchEvent(new Event("input", { bubbles: true }));
                } finally {
                    suppressInputReopen = false;
                }
                input.dispatchEvent(new Event("change", { bubbles: true }));
            };

            const positionDropdown = () => {
                if (!isOpen || !wrapper.isConnected) {
                    hideList();
                    return;
                }
                const rect = input.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) {
                    hideList();
                    return;
                }
                const desiredWidth = Math.min(Math.max(rect.width, 190), window.innerWidth - 16);
                let left = rect.left;
                if (left + desiredWidth > window.innerWidth - 8) {
                    left = Math.max(8, rect.right - desiredWidth);
                }
                dropdown.style.left = `${Math.round(left)}px`;
                dropdown.style.width = `${Math.round(desiredWidth)}px`;

                const spaceBelow = window.innerHeight - rect.bottom - 8;
                const spaceAbove = rect.top - 8;
                if (spaceBelow >= 140 || spaceBelow >= spaceAbove) {
                    dropdown.style.top = `${Math.round(rect.bottom + 4)}px`;
                    dropdown.style.bottom = "";
                    dropdown.style.maxHeight = `${Math.max(96, Math.min(220, Math.floor(spaceBelow - 4)))}px`;
                } else {
                    dropdown.style.top = "";
                    dropdown.style.bottom = `${Math.round(window.innerHeight - rect.top + 4)}px`;
                    dropdown.style.maxHeight = `${Math.max(96, Math.min(220, Math.floor(spaceAbove - 4)))}px`;
                }
            };

            const onDocMouseDown = (event) => {
                const target = event?.target;
                if (target instanceof Node && (wrapper.contains(target) || dropdown.contains(target))) {
                    return;
                }
                hideList();
            };

            const onWindowScroll = (event) => {
                const target = event?.target;
                if (target === dropdown || (target instanceof Node && dropdown.contains(target))) {
                    return;
                }
                positionDropdown();
            };

            const onWindowResize = () => {
                positionDropdown();
            };

            const attachListeners = () => {
                if (listenersAttached) return;
                listenersAttached = true;
                document.addEventListener("mousedown", onDocMouseDown, true);
                window.addEventListener("scroll", onWindowScroll, true);
                window.addEventListener("resize", onWindowResize);
            };

            const detachListeners = () => {
                if (!listenersAttached) return;
                listenersAttached = false;
                document.removeEventListener("mousedown", onDocMouseDown, true);
                window.removeEventListener("scroll", onWindowScroll, true);
                window.removeEventListener("resize", onWindowResize);
            };

            const buildList = (useFilter = false) => {
                lastUseFilter = Boolean(useFilter);
                dropdown.innerHTML = "";
                const rawQuery = input.value.trim();
                const queryLower = rawQuery.toLowerCase();
                const filtered = useFilter && queryLower
                    ? availableFolders.filter(folder => folder.toLowerCase().includes(queryLower))
                    : availableFolders;

                if (!filtered.length) {
                    if (rawQuery) {
                        const customItem = document.createElement("div");
                        customItem.setAttribute("data-folder-option", rawQuery);
                        customItem.textContent = `Use "${rawQuery}"`;
                        Object.assign(customItem.style, {
                            padding: "6px 10px",
                            borderRadius: "5px",
                            cursor: "pointer",
                            color: "var(--input-text, var(--foreground, #e5e7eb))",
                            fontSize: "12px",
                            fontFamily: "var(--font-inter, Inter, sans-serif)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                        });
                        customItem.addEventListener("mouseenter", () => {
                            customItem.style.background = "var(--secondary-background-hover, var(--accent, rgba(255, 255, 255, 0.08)))";
                        });
                        customItem.addEventListener("mouseleave", () => {
                            customItem.style.background = "transparent";
                        });
                        customItem.addEventListener("mousedown", (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            selectFolder(rawQuery);
                        });
                        dropdown.appendChild(customItem);
                        return;
                    }
                    const empty = document.createElement("div");
                    empty.textContent = "No folders available";
                    empty.style.padding = "6px 10px";
                    empty.style.fontSize = "12px";
                    empty.style.color = "#888";
                    dropdown.appendChild(empty);
                    return;
                }

                filtered.forEach(folder => {
                    const isCurrent = queryLower && folder.toLowerCase() === queryLower;
                    const item = document.createElement("div");
                    item.setAttribute("data-folder-option", folder);
                    item.textContent = folder;
                    Object.assign(item.style, {
                        padding: "6px 10px",
                        borderRadius: "5px",
                        cursor: "pointer",
                        color: "var(--input-text, var(--foreground, #e5e7eb))",
                        fontSize: "12px",
                        fontWeight: isCurrent ? "600" : "400",
                        background: isCurrent
                            ? "var(--secondary-background-hover, var(--accent, rgba(255, 255, 255, 0.08)))"
                            : "transparent",
                        fontFamily: "var(--font-inter, Inter, sans-serif)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                    });
                    item.addEventListener("mouseenter", () => {
                        item.style.background = "var(--secondary-background-hover, var(--accent, rgba(255, 255, 255, 0.1)))";
                    });
                    item.addEventListener("mouseleave", () => {
                        item.style.background = isCurrent
                            ? "var(--secondary-background-hover, var(--accent, rgba(255, 255, 255, 0.08)))"
                            : "transparent";
                    });
                    item.addEventListener("mousedown", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        selectFolder(folder);
                    });
                    dropdown.appendChild(item);
                });
            };

            function hideList() {
                if (!isOpen && !dropdown.isConnected && dropdown.style.display === "none") {
                    return;
                }
                isOpen = false;
                dropdown.style.display = "none";
                detachListeners();
                if (dropdown.isConnected) {
                    dropdown.remove();
                }
            }

            const showList = (useFilter = false) => {
                if (input.disabled) return;
                buildList(useFilter);
                if (!dropdown.isConnected) {
                    (document.body || document.documentElement).appendChild(dropdown);
                }
                isOpen = true;
                dropdown.style.display = "block";
                positionDropdown();
                attachListeners();
            };

            dropdown.addEventListener("mousedown", (e) => {
                e.preventDefault();
            });

            input.addEventListener("focus", () => showList(false));
            input.addEventListener("click", (e) => {
                e.stopPropagation();
                if (!isOpen) showList(false);
            });
            input.addEventListener("input", () => {
                input.style.border = "";
                input.style.boxShadow = "";
                if (suppressInputReopen) return;
                showList(true);
            });
            input.addEventListener("keydown", (e) => {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    hideList();
                } else if (e.key === "Enter" && isOpen) {
                    hideList();
                } else if (e.key === "ArrowDown" && !isOpen) {
                    e.preventDefault();
                    showList(false);
                }
            });
            input.addEventListener("blur", () => {
                hideList();
            });

            toggleBtn.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (input.disabled) return;
                if (isOpen) {
                    hideList();
                } else {
                    input.focus();
                    showList(false);
                }
            });

            wrapper.appendChild(input);
            wrapper.appendChild(toggleBtn);

            const destroy = () => {
                hideList();
                if (dropdown.isConnected) {
                    dropdown.remove();
                }
                folderPickers.delete(picker);
            };

            const picker = {
                refresh: () => {
                    if (!wrapper.isConnected) {
                        destroy();
                        return;
                    }
                    if (isOpen) {
                        buildList(lastUseFilter);
                        positionDropdown();
                    }
                },
                destroy,
            };
            folderPickers.add(picker);

            return { wrapper, input, dropdown, hide: hideList, destroy };
        };

        const parseFilenameFromUrl = (url) => {
            if (!url || typeof url !== "string") return null;
            const value = url.trim();
            if (!value) return null;

            const extract = (candidate) => {
                const clean = String(candidate || "").split("?")[0].split("#")[0];
                const parts = clean.split("/").filter(Boolean);
                if (!parts.length) return null;
                const tail = parts[parts.length - 1];
                if (!tail) return null;
                try {
                    return decodeURIComponent(tail);
                } catch {
                    return tail;
                }
            };

            try {
                if (value.includes("://")) {
                    const parsed = new URL(value);
                    const fromPath = extract(parsed.pathname);
                    if (fromPath) return fromPath;
                }
            } catch {
                // Fall through to raw parsing below.
            }

            return extract(value);
        };

        const parseHfFolderLinkInfo = (link) => {
            if (!link || typeof link !== "string") return null;
            const value = link.trim();
            if (!value) return null;

            let pathText = value;
            try {
                if (value.includes("://")) {
                    const parsed = new URL(value);
                    const host = String(parsed.hostname || "").toLowerCase();
                    if (host && host !== "huggingface.co") {
                        return null;
                    }
                    pathText = parsed.pathname || "";
                }
            } catch {
                return null;
            }

            const cleanPath = String(pathText).split("?")[0].split("#")[0];
            const pathParts = cleanPath.split("/").filter(Boolean);
            if (pathParts.length < 2) {
                return null;
            }

            const repoOwner = pathParts[0];
            const repoName = pathParts[1];
            if (!repoOwner || !repoName) {
                return null;
            }

            let subfolderParts = [];
            const treeIdx = pathParts.indexOf("tree");
            const resolveIdx = pathParts.indexOf("resolve");
            const blobIdx = pathParts.indexOf("blob");

            if (treeIdx >= 0) {
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
            } else if (pathParts.length > 2) {
                const remaining = pathParts.slice(2);
                const tail = remaining[remaining.length - 1] || "";
                if (tail.includes(".")) {
                    subfolderParts = remaining.slice(0, -1);
                } else {
                    subfolderParts = remaining;
                }
            }

            const subfolder = subfolderParts.join("/").replace(/^\/+|\/+$/g, "");
            const targetSegment = subfolder
                ? subfolder.split("/").filter(Boolean).slice(-1)[0]
                : repoName;

            if (!targetSegment) {
                return null;
            }

            return {
                repo: `${repoOwner}/${repoName}`,
                repoName,
                subfolder,
                targetSegment
            };
        };

        const FOLDER_REPO_SECTION_TITLE = "Folder/ Full Repo";
        const NODE_CURATED_SECTION_TITLE = "Node-Specific Downloads";
        const FLASHVSR_TEXT_MARKERS = ["flashvsr", "flash-vsr", "flash vsr"];
        const WAN_ANIMATE_TEXT_MARKERS = [
            "wananimatepreprocess",
            "wan animate preprocess",
            "onnxdetectionmodelloader",
            "poseandfacedetection",
        ];
        const WAN_ANIMATE_INPUT_NAMES = new Set(["vitpose_model", "yolo_model"]);
        const WAN_ANIMATE_CURATED_MODELS = {
            yolo: {
                filename: "yolov10m.onnx",
                url: "https://huggingface.co/Wan-AI/Wan2.2-Animate-14B/resolve/main/process_checkpoint/det/yolov10m.onnx?download=true",
                suggestedFolder: "detection",
                source: "wananimatepreprocess_docs",
            },
            vitposeLarge: {
                filename: "vitpose-l-wholebody.onnx",
                url: "https://huggingface.co/JunkyByte/easy_ViTPose/resolve/main/onnx/wholebody/vitpose-l-wholebody.onnx?download=true",
                suggestedFolder: "detection",
                source: "wananimatepreprocess_docs",
            },
            vitposeHugeModel: {
                filename: "vitpose_h_wholebody_model.onnx",
                url: "https://huggingface.co/Kijai/vitpose_comfy/resolve/main/onnx/vitpose_h_wholebody_model.onnx?download=true",
                suggestedFolder: "detection",
                source: "wananimatepreprocess_docs",
            },
            vitposeHugeData: {
                filename: "vitpose_h_wholebody_data.bin",
                url: "https://huggingface.co/Kijai/vitpose_comfy/resolve/main/onnx/vitpose_h_wholebody_data.bin?download=true",
                suggestedFolder: "detection",
                source: "wananimatepreprocess_docs",
            },
        };
        const REPO_FOLDER_DOWNLOAD_EXCEPTIONS = [
            {
                id: "flashvsr",
                label: "FlashVSR",
                sectionTitle: FOLDER_REPO_SECTION_TITLE,
                markers: FLASHVSR_TEXT_MARKERS,
                defaultVariant: "v1.1",
                variants: {
                    v1: {
                        displayName: "FlashVSR",
                        repoId: "JunhaoZhuang/FlashVSR",
                    },
                    "v1.1": {
                        displayName: "FlashVSR-v1.1",
                        repoId: "JunhaoZhuang/FlashVSR-v1.1",
                    },
                },
            },
        ];

        const textContainsAnyMarker = (value, markers) => {
            const haystack = String(value || "").toLowerCase();
            if (!haystack) return false;
            return markers.some((marker) => marker && haystack.includes(marker));
        };

        const isFlashVsrFamilyText = (value) =>
            textContainsAnyMarker(value, FLASHVSR_TEXT_MARKERS);

        const inferFlashVsrVariantId = (signals = {}) => {
            const missingValueLower = String(signals.missingValue || "").toLowerCase();
            if (missingValueLower) {
                if (missingValueLower.includes("1.1")) {
                    return "v1.1";
                }
                if (
                    isFlashVsrFamilyText(missingValueLower) ||
                    /\bv?1(?:\.0)?\b/.test(missingValueLower)
                ) {
                    return "v1";
                }
            }

            const explicitFields = [
                signals.repoId,
                signals.directory,
                signals.url,
                signals.filename,
            ]
                .map((value) => String(value || "").toLowerCase())
                .filter(Boolean)
                .join(" ");
            if (explicitFields.includes("flashvsr-v1.1")) {
                return "v1.1";
            }
            if (explicitFields.includes("flashvsr")) {
                return "v1";
            }

            const contextualFields = [
                signals.inputName,
                signals.details,
                signals.classType,
                signals.nodeTitle,
                signals.source,
                signals.type,
                signals.name,
            ]
                .map((value) => String(value || "").toLowerCase())
                .filter(Boolean)
                .join(" ");
            if (contextualFields.includes("flashvsr-v1.1")) {
                return "v1.1";
            }
            if (isFlashVsrFamilyText(contextualFields)) {
                return null;
            }

            return null;
        };

        const resolveRepoFolderDownloadException = (signals = {}) => {
            for (const exception of REPO_FOLDER_DOWNLOAD_EXCEPTIONS) {
                const markers = Array.isArray(exception.markers) ? exception.markers : [];
                if (!markers.length) continue;

                const hasMarker = [
                    signals.classType,
                    signals.inputName,
                    signals.details,
                    signals.missingValue,
                    signals.filename,
                    signals.directory,
                    signals.url,
                    signals.repoId,
                    signals.nodeTitle,
                    signals.source,
                    signals.type,
                    signals.name,
                ].some((value) => textContainsAnyMarker(value, markers));
                if (!hasMarker) continue;

                const variantId = exception.id === "flashvsr"
                    ? inferFlashVsrVariantId(signals)
                    : exception.defaultVariant;
                const variants = exception.variants || {};
                const selectedVariant = variants[variantId] || variants[exception.defaultVariant] || null;
                if (!selectedVariant || !selectedVariant.repoId) {
                    continue;
                }

                return {
                    exceptionId: exception.id,
                    exceptionLabel: exception.label,
                    sectionTitle: exception.sectionTitle || FOLDER_REPO_SECTION_TITLE,
                    variantId,
                    variantLabel: selectedVariant.displayName || variantId,
                    repoId: selectedVariant.repoId,
                    url: `https://huggingface.co/${selectedVariant.repoId}`,
                    suggestedFolder: String(selectedVariant.suggestedFolder || ""),
                };
            }
            return null;
        };

        const createRepoFolderMissingModelEntry = (signals = {}) => {
            const resolved = resolveRepoFolderDownloadException(signals);
            if (!resolved) {
                return null;
            }

            const nodeTitle =
                String(signals.nodeTitle || "").trim() ||
                String(signals.classType || "").trim() ||
                "Unknown Node";
            const nodeId = Number(signals.nodeId);

            const requestedPathRaw = String(
                signals.requestedPath || signals.missingValue || resolved.variantLabel || ""
            ).trim();

            return {
                filename: resolved.variantLabel,
                requested_path: requestedPathRaw || resolved.variantLabel,
                url: resolved.url,
                suggested_folder: resolved.suggestedFolder,
                source: "folder_repo_exception",
                node_title: nodeTitle,
                node_id: Number.isFinite(nodeId) ? nodeId : undefined,
                download_mode: "folder",
                repo_id: resolved.repoId,
                exception_id: resolved.exceptionId,
                exception_label: resolved.exceptionLabel,
                section: resolved.sectionTitle,
            };
        };

        const isFolderRepoDownloadModel = (model) =>
            String(model?.download_mode || "").toLowerCase() === "folder";

        const createWanAnimateCuratedModelEntry = (modelKey, signals = {}) => {
            const config = WAN_ANIMATE_CURATED_MODELS[modelKey];
            if (!config || !config.filename || !config.url) {
                return null;
            }
            const nodeTitle =
                String(signals.nodeTitle || "").trim() ||
                String(signals.classType || "").trim() ||
                "Unknown Node";
            const nodeId = Number(signals.nodeId);
            return {
                filename: config.filename,
                requested_path: config.filename,
                url: config.url,
                suggested_folder: config.suggestedFolder || "detection",
                source: config.source || "wananimatepreprocess_docs",
                node_title: nodeTitle,
                node_id: Number.isFinite(nodeId) ? nodeId : undefined,
                section: NODE_CURATED_SECTION_TITLE,
                exception_id: "wananimatepreprocess",
                exception_label: "WanAnimatePreprocess",
            };
        };

        const createWanAnimatePreprocessCuratedEntries = (signals = {}) => {
            const inputNameLower = String(signals.inputName || "").toLowerCase().trim();
            const missingValueLower = String(signals.missingValue || "").toLowerCase().trim();
            const classTypeLower = String(signals.classType || "").toLowerCase();
            const nodeTitleLower = String(signals.nodeTitle || "").toLowerCase();
            const detailsLower = String(signals.details || "").toLowerCase();
            const sourceLower = String(signals.source || "").toLowerCase();
            const nameLower = String(signals.name || "").toLowerCase();
            const filenameLower = String(signals.filename || "").toLowerCase();

            const contextualText = [
                classTypeLower,
                nodeTitleLower,
                detailsLower,
                sourceLower,
                nameLower,
                filenameLower,
                missingValueLower,
            ].join(" ");

            const hasFamilyMarker = textContainsAnyMarker(contextualText, WAN_ANIMATE_TEXT_MARKERS);
            const hasInputMarker = WAN_ANIMATE_INPUT_NAMES.has(inputNameLower);
            const hasKnownFilenameMarker =
                missingValueLower.includes("yolov10m.onnx") ||
                missingValueLower.includes("vitpose-l-wholebody.onnx") ||
                missingValueLower.includes("vitpose-h-wholebody.onnx") ||
                missingValueLower.includes("vitpose_h_wholebody_model.onnx") ||
                missingValueLower.includes("vitpose_h_wholebody_data.bin");
            const hasOnnxLoaderHint =
                classTypeLower.includes("onnx") ||
                nodeTitleLower.includes("onnx");

            const isWanAnimateContext =
                hasFamilyMarker ||
                (hasInputMarker && hasOnnxLoaderHint) ||
                hasKnownFilenameMarker;
            if (!isWanAnimateContext) {
                return [];
            }

            const selectedKeys = [];
            const pushKey = (key) => {
                if (!key || selectedKeys.includes(key)) return;
                selectedKeys.push(key);
            };

            const wantsYolo =
                inputNameLower === "yolo_model" ||
                missingValueLower.includes("yolo") ||
                missingValueLower.includes("yolov10m.onnx");
            if (wantsYolo) {
                pushKey("yolo");
            }

            const wantsVitpose =
                inputNameLower === "vitpose_model" ||
                missingValueLower.includes("vitpose");
            if (wantsVitpose) {
                const wantsHuge =
                    missingValueLower.includes("vitpose_h_wholebody_model.onnx") ||
                    missingValueLower.includes("vitpose_h_wholebody_data.bin") ||
                    missingValueLower.includes("vitpose-h-wholebody.onnx") ||
                    missingValueLower.includes("vitpose_h_");
                const wantsLarge =
                    missingValueLower.includes("vitpose-l-wholebody.onnx") ||
                    missingValueLower.includes("vitpose_l_wholebody.onnx");

                if (wantsHuge) {
                    pushKey("vitposeHugeModel");
                    pushKey("vitposeHugeData");
                } else if (wantsLarge) {
                    pushKey("vitposeLarge");
                } else {
                    // Fallback to the README-recommended large checkpoint when the selected name is unknown.
                    pushKey("vitposeLarge");
                }
            }

            if (!selectedKeys.length && isWanAnimateContext) {
                pushKey("yolo");
                pushKey("vitposeLarge");
            }

            return selectedKeys
                .map((modelKey) => createWanAnimateCuratedModelEntry(modelKey, signals))
                .filter(Boolean);
        };

        const RUN_HOOK_INPUT_FOLDER_HINTS = Object.freeze({
            ckpt_name: "checkpoints",
            unet_name: "diffusion_models",
            vae_name: "vae",
            clip_name: "text_encoders",
            clip_name1: "text_encoders",
            clip_name2: "text_encoders",
            clip_name3: "text_encoders",
            clip_name4: "text_encoders",
            text_encoder: "text_encoders",
            text_encoder_name: "text_encoders",
            lora_name: "loras",
            control_net_name: "controlnet",
            controlnet_name: "controlnet",
            clip_vision: "clip_vision",
            clip_vision_name: "clip_vision",
            style_model_name: "style_models",
            gligen_name: "gligen",
            audio_encoder_name: "audio_encoders",
            conditioning_name: "embeddings",
            hypernetwork_name: "hypernetworks",
            photomaker_model_name: "photomaker",
            bg_removal_name: "background_removal",
            tiny_vae: "vae_approx",
            tiny_vae_name: "vae_approx",
            vae_approx_name: "vae_approx",
        });

        const guessSuggestedFolderFromRunHookFilename = (value) => {
            const lower = String(value || "").trim().toLowerCase();
            if (!lower) return "";
            const compact = lower.replace(/[^a-z0-9]+/g, "");

            if (lower.includes("controlnet")) return "controlnet";
            if (lower.includes("lora")) return "loras";
            if (
                lower.includes("clip_vision") ||
                lower.includes("clip vision") ||
                lower.includes("clip-vit-") ||
                compact.includes("clipvisionh") ||
                compact.includes("clipvisiong") ||
                compact.includes("clipvith") ||
                compact.includes("clipvitg")
            ) {
                return "clip_vision";
            }
            if (
                lower.includes("text_encoder") ||
                lower.includes("text-encoder") ||
                lower.includes("umt5") ||
                lower.startsWith("t5_") ||
                lower.startsWith("t5-") ||
                lower.includes("qwen")
            ) {
                return "text_encoders";
            }
            if (
                lower.includes("vae_approx") ||
                lower.includes("tinyvae") ||
                lower.includes("tiny_vae") ||
                lower.startsWith("tae") ||
                lower.includes("taesd")
            ) {
                return "vae_approx";
            }
            if (lower.includes("vae")) return "vae";
            return "";
        };

        const inferSuggestedFolderFromRunHookSignals = (signals = {}) => {
            const inputNameLower = String(signals?.inputName || "").trim().toLowerCase();
            if (inputNameLower && RUN_HOOK_INPUT_FOLDER_HINTS[inputNameLower]) {
                return RUN_HOOK_INPUT_FOLDER_HINTS[inputNameLower];
            }
            if (inputNameLower.endsWith(".lora_name") || inputNameLower.includes("lora")) {
                return "loras";
            }

            const classTypeLower = String(signals?.classType || "").trim().toLowerCase();
            if (classTypeLower) {
                if (classTypeLower === "ltxvaudiovaeloader") return "checkpoints";
                if (classTypeLower.includes("modelpreviewoverride") || classTypeLower.includes("previewoverride")) return "vae_approx";
                if (classTypeLower.includes("clipvision")) return "clip_vision";
                if (classTypeLower.includes("style")) return "style_models";
                if (classTypeLower.includes("controlnet")) return "controlnet";
                if (classTypeLower.includes("lora")) return "loras";
                if (classTypeLower.includes("vae")) return "vae";
                if (classTypeLower.includes("clip")) return "text_encoders";
                if (classTypeLower.includes("unet")) return "diffusion_models";
                if (classTypeLower.includes("checkpoint") || classTypeLower.includes("ckpt")) return "checkpoints";
                if (classTypeLower.includes("latent") && classTypeLower.includes("upscale")) return "latent_upscale_models";
                if (classTypeLower.includes("upscale")) return "upscale_models";
                if (classTypeLower.includes("audioencoder") || classTypeLower.includes("audio_encoder")) return "audio_encoders";
                if (classTypeLower.includes("opticalflow") || classTypeLower.includes("optical_flow")) return "optical_flow";
                if (classTypeLower.includes("moge") || classTypeLower.includes("da3") || classTypeLower.includes("geometry")) return "geometry_estimation";
                if (classTypeLower.includes("mediapipe") || classTypeLower.includes("sam3d") || classTypeLower.includes("detection")) return "detection";
                if (classTypeLower.includes("hypernetwork")) return "hypernetworks";
                if (classTypeLower.includes("photomaker")) return "photomaker";
                if (classTypeLower.includes("conditioning")) return "embeddings";
                if (classTypeLower.includes("bgremoval") || classTypeLower.includes("backgroundremoval") || classTypeLower.includes("background_removal")) return "background_removal";
                if (classTypeLower.includes("frameinterpolation") || classTypeLower.includes("frame_interpolation")) return "frame_interpolation";
                if (classTypeLower.includes("modelpatch") || classTypeLower.includes("model_patch")) return "model_patches";
            }

            return guessSuggestedFolderFromRunHookFilename(
                signals?.filename || signals?.missingValue || ""
            );
        };

        const findEmbeddedModelMetadataForRunHookFailure = (graphData, filename, preferredDirectory = "") => {
            if (!graphData || typeof graphData !== "object" || !filename) {
                return null;
            }
            const targetFilename = String(filename || "").trim().toLowerCase();
            const targetDirectory = String(preferredDirectory || "").trim().toLowerCase();
            if (!targetFilename) {
                return null;
            }

            const embeddedModels = collectEmbeddedModelsNativeLike(graphData);
            if (!embeddedModels.length) {
                return null;
            }

            const matches = embeddedModels.filter((model) => {
                const modelName = getPathBasename(model?.name || "").toLowerCase();
                return modelName === targetFilename;
            });
            if (!matches.length) {
                return null;
            }

            const exactDirectoryMatch = matches.find((model) =>
                String(model?.directory || "").trim().toLowerCase() === targetDirectory
            );
            return exactDirectoryMatch || matches[0] || null;
        };

        const createGenericValidationFailureMissingModelEntry = (signals = {}, graphData = null) => {
            const filename = getPathBasename(
                signals?.filename || signals?.missingValue || parseMissingValueFromDetails(signals?.details || "")
            );
            if (!filename || !MODELISH_FILENAME_PATTERN.test(filename)) {
                return null;
            }

            const inferredFolder = inferSuggestedFolderFromRunHookSignals({
                ...signals,
                filename,
            });
            if (!inferredFolder) {
                return null;
            }

            const embedded = findEmbeddedModelMetadataForRunHookFailure(
                graphData,
                filename,
                inferredFolder
            );
            const suggestedFolder =
                String(embedded?.directory || "").trim() ||
                inferredFolder;
            const nodeTitle =
                String(signals.nodeTitle || "").trim() ||
                String(signals.classType || "").trim() ||
                "Unknown Node";
            const nodeId = Number(signals.nodeId);

            return {
                filename,
                name: filename,
                requested_path: filename,
                directory: suggestedFolder,
                suggested_folder: suggestedFolder,
                url: String(embedded?.url || "").trim(),
                hash: String(embedded?.hash || "").trim(),
                hash_type: String(embedded?.hash_type || "").trim(),
                node_title: nodeTitle,
                node_id: Number.isFinite(nodeId) ? nodeId : undefined,
                input_name: String(signals?.inputName || "").trim(),
                details: String(signals?.details || "").trim(),
                source: "run_hook_validation_inferred",
                type: "",
            };
        };

        const createRunHookFallbackMissingModels = (failures = [], graphData = null) => {
            if (!Array.isArray(failures) || !failures.length) {
                return [];
            }

            const collected = [];
            const seen = new Set();
            const pushEntry = (entry) => {
                if (!entry || typeof entry !== "object") {
                    return;
                }
                const mode = String(entry.download_mode || "file").toLowerCase();
                const key = mode === "folder"
                    ? `folder|${String(entry.exception_id || "").toLowerCase()}|${String(entry.repo_id || "").toLowerCase()}|${String(entry.url || "").toLowerCase()}`
                    : [
                        "file",
                        String(entry.filename || "").toLowerCase(),
                        String(entry.requested_path || "").toLowerCase(),
                        String(entry.url || "").toLowerCase(),
                        String(entry.suggested_folder || entry.folder || "").toLowerCase(),
                        String(entry.node_id || "").toLowerCase(),
                    ].join("|");
                if (!key || seen.has(key)) {
                    return;
                }
                seen.add(key);
                collected.push(entry);
            };

            for (const failure of failures) {
                const signals = {
                    classType: failure?.classType,
                    inputName: failure?.inputName,
                    details: failure?.details,
                    missingValue: failure?.missingValue,
                    nodeId: failure?.nodeId,
                    nodeTitle: failure?.nodeTitle || failure?.classType,
                };

                const repoEntry = createRepoFolderMissingModelEntry(signals);
                if (repoEntry) {
                    pushEntry({
                        ...repoEntry,
                        source: "run_hook_fallback",
                    });
                }

                const curatedEntries = createWanAnimatePreprocessCuratedEntries(signals);
                curatedEntries.forEach((entry) => {
                    pushEntry({
                        ...entry,
                        source: "run_hook_fallback",
                    });
                });

                const genericEntry = createGenericValidationFailureMissingModelEntry(
                    signals,
                    graphData
                );
                if (genericEntry) {
                    pushEntry(genericEntry);
                }
            }

            return collected;
        };

        const createLastChanceRunHookMissingModels = (failures = [], graphData = null) => {
            if (!Array.isArray(failures) || !failures.length) {
                return [];
            }

            const collected = [];
            const seen = new Set();
            for (const failure of failures) {
                const filename = getPathBasename(
                    failure?.missingValue || parseMissingValueFromDetails(failure?.details || "")
                );
                if (!filename || !MODELISH_FILENAME_PATTERN.test(filename)) {
                    continue;
                }

                const inferredFolder = inferSuggestedFolderFromRunHookSignals({
                    classType: failure?.classType,
                    inputName: failure?.inputName,
                    filename,
                    missingValue: filename,
                }) || "checkpoints";
                const embedded = findEmbeddedModelMetadataForRunHookFailure(
                    graphData,
                    filename,
                    inferredFolder
                );
                const suggestedFolder =
                    String(embedded?.directory || "").trim() ||
                    inferredFolder;
                const nodeTitle =
                    String(failure?.nodeTitle || failure?.classType || "").trim() ||
                    "Unknown Node";
                const nodeId = Number(failure?.nodeId);
                const entry = {
                    filename,
                    name: filename,
                    requested_path: filename,
                    directory: suggestedFolder,
                    suggested_folder: suggestedFolder,
                    url: String(embedded?.url || "").trim(),
                    hash: String(embedded?.hash || "").trim(),
                    hash_type: String(embedded?.hash_type || "").trim(),
                    node_title: nodeTitle,
                    node_id: Number.isFinite(nodeId) ? nodeId : undefined,
                    input_name: String(failure?.inputName || "").trim(),
                    details: String(failure?.details || "").trim(),
                    source: "run_hook_last_chance",
                    type: "",
                };
                const key = [
                    entry.filename.toLowerCase(),
                    String(entry.requested_path || "").toLowerCase(),
                    entry.suggested_folder.toLowerCase(),
                    entry.url.toLowerCase(),
                    String(entry.node_id || "").toLowerCase(),
                    entry.input_name.toLowerCase(),
                ].join("|");
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                collected.push(entry);
            }

            return filterRunHookEligibleMissingModels(collected);
        };

        const resolveComboWidgetOptionsNativeLike = (widget) => {
            try {
                const values = widget?.options?.values;
                if (!values) return [];
                if (typeof values === "function") {
                    const result = values(widget);
                    return Array.isArray(result) ? result : [];
                }
                if (Array.isArray(values)) {
                    return values;
                }
                if (typeof values === "object") {
                    return Object.keys(values);
                }
            } catch (_) {
                // Ignore malformed widget option providers.
            }
            return [];
        };

        /**
         * Collects all string values currently present in live graph node widgets.
         * Used to cross-reference against stale model metadata entries.
         * Returns a Set of string values.
         */
        const collectAllLiveWidgetValues = (graph = null) => {
            const rootGraph = graph || app?.rootGraph;
            if (!rootGraph || typeof rootGraph !== "object") {
                return new Set();
            }
            const values = new Set();
            const visitGraph = (currentGraph) => {
                const nodes = Array.isArray(currentGraph?.nodes) ? currentGraph.nodes : [];
                for (const node of nodes) {
                    if (!node || typeof node !== "object") continue;
                    if (isGraphNodeBypassed(node)) continue;

                    const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
                    for (const widget of widgets) {
                        if (isDynamicGroupWidgetDisabledInNode(node, widget?.name)) continue;
                        const val = typeof widget?.value === "string" ? widget.value.trim() : "";
                        if (val) {
                            values.add(val);
                        }
                    }

                    if (typeof node?.isSubgraphNode === "function" && node.isSubgraphNode() && node?.subgraph) {
                        visitGraph(node.subgraph);
                    }
                }
            };
            visitGraph(rootGraph);
            return values;
        };

        /**
         * Given a pending-warning candidate object, checks whether it is still
         * referenced by an active missing live graph node widget. Returns true if stale
         * or already resolved in the live widget's combo options.
         */
        const isPendingCandidateStaleInLiveGraph = (candidate, liveWidgetValues, graph = null) => {
            if (!candidate || typeof candidate !== "object") return false;
            const name = String(candidate?.name || candidate?.filename || "").trim();
            if (!name) return false;
            const baseName = name.split(/[/\\]/).pop().trim();

            const rootGraph = graph || app?.rootGraph;
            if (rootGraph && typeof rootGraph === "object") {
                const candNodeId = String(candidate?.nodeId ?? candidate?.node_id ?? "").trim();
                const candWidgetName = String(candidate?.widgetName || candidate?.input_name || "").trim();
                if (candNodeId) {
                    const localNodeId = candNodeId.includes(":") ? candNodeId.split(":").pop() : candNodeId;
                    const targetNode = findNodeByIdRecursive(rootGraph, localNodeId);
                    if (targetNode) {
                        if (isGraphNodeBypassed(targetNode)) return true;
                        const widgets = Array.isArray(targetNode?.widgets) ? targetNode.widgets : [];
                        const targetWidget = candWidgetName
                            ? widgets.find(w => String(w?.name || "").trim() === candWidgetName)
                            : widgets.find(w => {
                                const v = typeof w?.value === "string" ? w.value.trim() : "";
                                return v === name || (baseName && v.split(/[/\\]/).pop().trim() === baseName);
                            });
                        if (targetWidget) {
                            if (isDynamicGroupWidgetDisabledInNode(targetNode, targetWidget?.name)) {
                                return true;
                            }
                            const options = resolveComboWidgetOptionsNativeLike(targetWidget);
                            const currentVal = typeof targetWidget?.value === "string" ? targetWidget.value.trim() : "";
                            if (
                                options.length > 0 &&
                                (isValuePresentInComboOptions(options, currentVal) ||
                                 isValuePresentInComboOptions(options, name))
                            ) {
                                return true;
                            }
                        }
                    }
                }
            }

            // If the model name is still present in any active widget value, it's not stale
            if (liveWidgetValues.has(name)) return false;
            // Also check base name (without path prefix)
            if (baseName && liveWidgetValues.has(baseName)) return false;
            return true;
        };

        const alignNodeWidgetSlashes = (node, currentGraph = null) => {
            if (!node || typeof node !== "object") return false;
            const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
            let nodeUpdated = false;
            for (const widget of widgets) {
                const val = typeof widget?.value === "string" ? widget.value.trim() : "";
                if (!val) {
                    continue;
                }

                const options = resolveComboWidgetOptionsNativeLike(widget);
                if (!Array.isArray(options) || !options.length) {
                    continue;
                }
                if (options.includes(val)) {
                    continue;
                }

                const normalizedVal = val.replace(/\\/g, "/");
                const normalizedValLower = normalizedVal.toLowerCase();
                let matchedOption = options.find(
                    opt => typeof opt === "string" && opt.replace(/\\/g, "/") === normalizedVal
                );
                if (!matchedOption) {
                    matchedOption = options.find(
                        opt => typeof opt === "string" && opt.replace(/\\/g, "/").toLowerCase() === normalizedValLower
                    );
                }
                if (
                    !matchedOption &&
                    MODELISH_FILENAME_PATTERN.test(val) &&
                    isLocalModelLoaderNode(node)
                ) {
                    const widgetName = String(widget?.name || "").trim();
                    const upstreamInfo = getUpstreamDownloaderNodeUrlAndFolder(node, widgetName, currentGraph || node?.graph || app?.rootGraph);
                    if (!upstreamInfo) {
                        const valBaseLower = getPathBasename(normalizedVal).toLowerCase();
                        if (valBaseLower) {
                            const baseMatches = options.filter(
                                opt => typeof opt === "string" && getPathBasename(opt).toLowerCase() === valBaseLower
                            );
                            if (baseMatches.length) {
                                matchedOption =
                                    baseMatches.find(opt => opt.replace(/\\/g, "/").toLowerCase() === valBaseLower) ||
                                    baseMatches[0];
                            }
                        }
                    }
                }
                if (matchedOption && widget.value !== matchedOption) {
                    widget.value = matchedOption;
                    nodeUpdated = true;
                }
            }
            if (nodeUpdated) {
                node?.setDirtyCanvas?.(true);
            }
            return nodeUpdated;
        };

        const alignGraphWidgetSlashes = (graph = null) => {
            const rootGraph = graph || app?.rootGraph;
            if (!rootGraph || typeof rootGraph !== "object") {
                return;
            }
            const visitGraph = (currentGraph, visited = new Set()) => {
                if (!currentGraph || visited.has(currentGraph)) return;
                visited.add(currentGraph);
                const nodes = Array.isArray(currentGraph?.nodes) ? currentGraph.nodes : [];
                for (const node of nodes) {
                    if (!node || typeof node !== "object") continue;
                    alignNodeWidgetSlashes(node, currentGraph);
                    const sub = (typeof node?.getInnerGraph === "function" ? node.getInnerGraph() : null) || node?.subgraph;
                    if (sub && typeof sub === "object") {
                        visitGraph(sub, visited);
                    }
                }
            };
            visitGraph(rootGraph);
        };

        const parseDownloaderLinkFilename = (url) => {
            try {
                const cleaned = String(url || "").split("?")[0].split("#")[0];
                const parts = cleaned.split("/").filter(Boolean);
                const last = parts[parts.length - 1];
                return last ? decodeURIComponent(last) : "";
            } catch (_) {
                return "";
            }
        };

        const syncNodeDownloaderLinkedWidgets = (node, currentGraph = null) => {
            if (!node || typeof node !== "object") return false;
            const resolvedGraph = currentGraph || node?.graph || app?.rootGraph;
            if (!resolvedGraph || typeof resolvedGraph !== "object") return false;
            const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
            const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
            if (!widgets.length || !inputs.length) return false;

            let updated = false;
            for (const widget of widgets) {
                const widgetName = String(widget?.name || "").trim();
                if (!widgetName || !isModelValidationInputName(widgetName)) continue;

                const inp = inputs.find(entry =>
                    String(entry?.name || "").trim() === widgetName ||
                    String(entry?.widget?.name || "").trim() === widgetName
                );
                if (!inp || inp.link == null) continue;

                const link = resolvedGraph.links ? resolvedGraph.links[inp.link] : null;
                if (!link) continue;

                const upstreamId = link.origin_id;
                if (upstreamId == null) continue;

                const upstreamNode = typeof resolvedGraph.getNodeById === "function"
                    ? resolvedGraph.getNodeById(upstreamId)
                    : (resolvedGraph._nodes_by_id ? resolvedGraph._nodes_by_id[upstreamId] : null);
                if (!upstreamNode || String(upstreamNode.type) !== "Hugging Face Download Model") {
                    continue;
                }

                const upWidgets = Array.isArray(upstreamNode.widgets) ? upstreamNode.widgets : [];
                const linkWidget = upWidgets.find(w => w?.name === "link");
                const hfUrl = String(linkWidget ? linkWidget.value : "").trim();
                if (!hfUrl) continue;

                const parsedFilename = parseDownloaderLinkFilename(hfUrl);
                if (!parsedFilename) continue;

                if (widget.value !== parsedFilename) {
                    widget.value = parsedFilename;
                    updated = true;
                }
            }
            return updated;
        };

        const syncDownloaderLinkedWidgetNames = (graph = null) => {
            const rootGraph = graph || app?.rootGraph;
            if (!rootGraph || typeof rootGraph !== "object") {
                return;
            }
            const visitGraph = (currentGraph, visited = new Set()) => {
                if (!currentGraph || visited.has(currentGraph)) return;
                visited.add(currentGraph);
                const nodes = Array.isArray(currentGraph?.nodes) ? currentGraph.nodes : [];
                for (const node of nodes) {
                    if (!node || typeof node !== "object") continue;
                    syncNodeDownloaderLinkedWidgets(node, currentGraph);
                    const sub = (typeof node?.getInnerGraph === "function" ? node.getInnerGraph() : null) || node?.subgraph;
                    if (sub && typeof sub === "object") {
                        visitGraph(sub, visited);
                    }
                }
            };
            visitGraph(rootGraph);
        };

        const getUpstreamDownloaderNodeUrlAndFolder = (node, widgetName, graph) => {
            const rootGraph = graph || app?.rootGraph;
            if (!rootGraph || typeof rootGraph !== "object" || !Array.isArray(node?.inputs)) {
                return null;
            }
            const inp = node.inputs.find(entry => 
                String(entry?.name || "").trim() === widgetName || 
                String(entry?.widget?.name || "").trim() === widgetName
            );
            const linkId = inp?.link;
            if (linkId == null) return null;

            const link = rootGraph.links ? rootGraph.links[linkId] : null;
            if (!link) return null;

            const upstreamId = link.origin_id;
            if (upstreamId == null) return null;

            const upstreamNode = typeof rootGraph.getNodeById === "function" 
                ? rootGraph.getNodeById(upstreamId) 
                : (rootGraph._nodes_by_id ? rootGraph._nodes_by_id[upstreamId] : null);

            if (upstreamNode && String(upstreamNode.type) === "Hugging Face Download Model") {
                const widgets = Array.isArray(upstreamNode.widgets) ? upstreamNode.widgets : [];
                // Retrieve by widget name if available (highly robust), otherwise use index check
                const targetFolderWidget = widgets.find(w => w?.name === "target_folder");
                const customPathWidget = widgets.find(w => w?.name === "custom_path");
                const linkWidget = widgets.find(w => w?.name === "link");

                const folder = String(targetFolderWidget ? targetFolderWidget.value : (widgets[0]?.value || "")).trim();
                const customPath = String(customPathWidget ? customPathWidget.value : (folder === "custom" ? widgets[1]?.value : "")).trim();
                const url = String(linkWidget ? linkWidget.value : (folder === "custom" ? widgets[2]?.value : widgets[1]?.value || "")).trim();
                
                if (url && url.startsWith("http")) {
                    let directory = folder;
                    let lockedFolder = null;
                    let requestedPath = null;
                    if (customPath) {
                        const normalizedCustom = customPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
                        if (normalizedCustom) {
                            const segments = normalizedCustom.split("/");
                            if (segments.length) {
                                directory = segments[0];
                                lockedFolder = normalizedCustom;
                                if (segments.length > 1) {
                                    const filename = url.split("?")[0].split("/").pop();
                                    requestedPath = segments.slice(1).concat(filename).join("/");
                                }
                            }
                        }
                    } else if (folder && folder !== "custom") {
                        directory = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
                        lockedFolder = directory;
                    }
                    return { url, directory, lockedFolder, requestedPath };
                }
            }
            return null;
        };

        const isDynamicGroupWidgetDisabledInNode = (node, widgetName) => {
            if (!node || typeof node !== "object") return false;
            const wName = String(widgetName || "").trim();
            if (!wName.endsWith(".lora_name")) {
                return false;
            }
            const prefix = wName.slice(0, -".lora_name".length);

            const isFlagDisabled = (val) => {
                if (val === false || val === 0 || val === "false" || val === "0") return true;
                return false;
            };
            const isZeroStrength = (val) => {
                if (val === undefined || val === null) return false;
                const num = Number(val);
                return !Number.isNaN(num) && num === 0;
            };

            // 1. Live node widgets array
            const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
            if (widgets.length) {
                const enabledWidget = widgets.find(w => String(w?.name || "").trim() === `${prefix}.enabled`);
                if (enabledWidget && isFlagDisabled(enabledWidget.value)) {
                    return true;
                }
                const strengthWidget = widgets.find(w => {
                    const n = String(w?.name || "").trim();
                    return n === `${prefix}.strength` || n === `${prefix}.strength_model` || n === `${prefix}.strength_clip`;
                });
                if (strengthWidget && isZeroStrength(strengthWidget.value)) {
                    return true;
                }
            }

            // 2. Named widgets dictionary
            const named = node?.widgets_values_named || (typeof node?.widgets_values === "object" && !Array.isArray(node?.widgets_values) ? node.widgets_values : null);
            if (named && typeof named === "object") {
                const en = named[`${prefix}.enabled`];
                if (isFlagDisabled(en)) return true;
                const st = named[`${prefix}.strength`] ?? named[`${prefix}.strength_model`] ?? named[`${prefix}.strength_clip`];
                if (isZeroStrength(st)) return true;
            }

            // 3. Array widgets_values for dynamic LoRA stack
            if (Array.isArray(node?.widgets_values)) {
                const match = prefix.match(/^loras\.(\d+)$/);
                if (match) {
                    const idx = parseInt(match[1], 10);
                    const wv = node.widgets_values;
                    const offset = (wv.length > 0 && typeof wv[0] === "number" && !Number.isNaN(wv[0])) ? 1 : 0;
                    const rowStart = offset + idx * 3;
                    if (rowStart + 2 < wv.length) {
                        const st = wv[rowStart + 1];
                        const en = wv[rowStart + 2];
                        if (isFlagDisabled(en) || isZeroStrength(st)) return true;
                    }
                }
            }

            // 4. Check counterpart live node if available
            if (node.id != null) {
                const liveNode = (app?.rootGraph?._nodes_by_id?.[node.id]) || findNodeByIdRecursive(app?.rootGraph, node.id);
                if (liveNode && liveNode !== node) {
                    return isDynamicGroupWidgetDisabledInNode(liveNode, widgetName);
                }
            }

            return false;
        };

        const getDisabledWidgetValuesForNode = (node) => {
            const disabledValues = new Set();
            if (!node || typeof node !== "object") return disabledValues;

            const checkAndAdd = (val) => {
                if (typeof val === "string") {
                    const s = val.trim();
                    if (s) {
                        disabledValues.add(s);
                        const base = s.split(/[/\\]/).pop().trim();
                        if (base) disabledValues.add(base);
                    }
                }
            };

            const widgets = Array.isArray(node.widgets) ? node.widgets : [];
            for (const w of widgets) {
                const wName = String(w?.name || "").trim();
                if (isDynamicGroupWidgetDisabledInNode(node, wName)) {
                    checkAndAdd(w?.value);
                }
            }

            const named = node.widgets_values_named || (typeof node.widgets_values === "object" && !Array.isArray(node.widgets_values) ? node.widgets_values : null);
            if (named && typeof named === "object") {
                for (const [k, v] of Object.entries(named)) {
                    if (isDynamicGroupWidgetDisabledInNode(node, k)) {
                        checkAndAdd(v);
                    }
                }
            }

            const nodeType = String(node.type || "");
            if ((nodeType === "LoadLoraModel" || nodeType === "LoadLoraTextEncoder" || nodeType === "Load LoRA (Model)" || nodeType === "Load LoRA (Text Encoder)") && Array.isArray(node.widgets_values)) {
                const wv = node.widgets_values;
                const offset = (wv.length > 0 && typeof wv[0] === "number") ? 1 : 0;
                let rIdx = offset;
                while (rIdx + 2 < wv.length) {
                    const loraVal = wv[rIdx];
                    const st = wv[rIdx + 1];
                    const en = wv[rIdx + 2];
                    const isFlagDisabled = en === false || en === 0 || en === "false" || en === "0";
                    const isZeroStrength = st !== undefined && st !== null && !Number.isNaN(Number(st)) && Number(st) === 0;
                    if (isFlagDisabled || isZeroStrength) {
                        checkAndAdd(loraVal);
                    }
                    rIdx += 3;
                }
            }

            if (node.id != null) {
                const liveNode = (app?.rootGraph?._nodes_by_id?.[node.id]) || findNodeByIdRecursive(app?.rootGraph, node.id);
                if (liveNode && liveNode !== node) {
                    const liveDisabled = getDisabledWidgetValuesForNode(liveNode);
                    for (const v of liveDisabled) {
                        disabledValues.add(v);
                    }
                }
            }

            return disabledValues;
        };

        const isValuePresentInComboOptions = (options, value) => {
            if (!Array.isArray(options) || !options.length || !value) {
                return false;
            }
            if (options.includes(value)) {
                return true;
            }
            const normVal = String(value).replace(/\\/g, "/").trim().toLowerCase();
            const baseLower = getPathBasename(normVal).toLowerCase();
            return options.some(opt => {
                if (typeof opt !== "string") return false;
                const normOpt = opt.replace(/\\/g, "/").trim().toLowerCase();
                if (normOpt === normVal) return true;
                return Boolean(baseLower && getPathBasename(normOpt).toLowerCase() === baseLower);
            });
        };

        const collectLiveGraphMissingModelCandidatesNativeLike = (graph = null, graphData = null) => {
            const rootGraph = graph || app?.rootGraph;
            if (!rootGraph || typeof rootGraph !== "object") {
                return [];
            }

            // Align paths to match the server's loaded format before checking if they're missing
            alignGraphWidgetSlashes(rootGraph);

            const collected = [];
            const seen = new Set();
            const visitedGraphs = new Set();
            const visitGraph = (currentGraph, prefix = "") => {
                if (!currentGraph || typeof currentGraph !== "object" || visitedGraphs.has(currentGraph)) {
                    return;
                }
                visitedGraphs.add(currentGraph);

                const nodes = Array.isArray(currentGraph?.nodes)
                    ? currentGraph.nodes
                    : (Array.isArray(currentGraph?._nodes) ? currentGraph._nodes : []);
                for (const node of nodes) {
                    if (!node || typeof node !== "object") {
                        continue;
                    }
                    if (isGraphNodeBypassed(node) || isExcludedDiscoveryNode(node)) {
                        continue;
                    }

                    const nodeId = String(node?.id ?? "").trim();
                    const executionId = prefix
                        ? `${prefix}:${nodeId}`
                        : nodeId;

                    const sub = (typeof node?.getInnerGraph === "function" ? node.getInnerGraph() : null) || node?.subgraph;
                    if (sub && typeof sub === "object") {
                        visitGraph(sub, executionId);
                        continue;
                    }

                    const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
                    for (const widget of widgets) {
                        const value = typeof widget?.value === "string"
                            ? widget.value.trim()
                            : "";
                        if (!value || !MODELISH_FILENAME_PATTERN.test(value)) {
                            continue;
                        }

                        const widgetType = String(widget?.type || "").trim().toLowerCase();
                        const options = resolveComboWidgetOptionsNativeLike(widget);
                        const hasOptions = Array.isArray(options) && options.length > 0;
                        const isComboLike =
                            widgetType === "combo" || hasOptions;
                        if (!isComboLike) {
                            continue;
                        }

                        const widgetName = String(widget?.name || "").trim();
                        if (isDynamicGroupWidgetDisabledInNode(node, widgetName)) {
                            continue;
                        }
                        const hasLinkedInput = Array.isArray(node?.inputs) && node.inputs.some(inp => 
                            (String(inp?.name || "").trim() === widgetName || String(inp?.widget?.name || "").trim() === widgetName) && inp.link != null
                        );
                        let upstreamUrlInfo = null;
                        if (hasLinkedInput) {
                            upstreamUrlInfo = getUpstreamDownloaderNodeUrlAndFolder(node, widgetName, currentGraph);
                            if (!upstreamUrlInfo) {
                                continue;
                            }
                        }

                        // If options list is empty/unpopulated and there is no linked HF downloader,
                        // do not falsely treat every valid model name as missing on startup.
                        if (!hasOptions && !upstreamUrlInfo) {
                            continue;
                        }

                        const inOptions = hasOptions && isValuePresentInComboOptions(options, value);
                        if (inOptions) {
                            continue;
                        }

                        const directory = upstreamUrlInfo
                            ? upstreamUrlInfo.directory
                            : (
                                String(widget?.options?.model_folder || widget?.options?.folder || "").trim() ||
                                inferSuggestedFolderFromRunHookSignals({
                                    classType: node?.type,
                                    inputName: widgetName,
                                    filename: value,
                                    missingValue: value,
                                }) ||
                                ""
                            );
                        const embedded = upstreamUrlInfo
                            ? { url: upstreamUrlInfo.url }
                            : findEmbeddedModelMetadataForRunHookFailure(
                                graphData,
                                value,
                                directory
                            );
                        const candidate = {
                            nodeId: executionId,
                            nodeType: String(node?.type || "").trim(),
                            widgetName,
                            isAssetSupported: false,
                            name: value,
                            directory,
                            url: String(embedded?.url || "").trim(),
                            hash: String(embedded?.hash || "").trim(),
                            hashType: String(embedded?.hash_type || "").trim(),
                            isMissing: true,
                        };
                        const key = [
                            String(candidate?.nodeId || "").trim().toLowerCase(),
                            String(candidate?.widgetName || "").trim().toLowerCase(),
                            String(candidate?.name || "").trim().toLowerCase(),
                            String(candidate?.directory || "").trim().toLowerCase(),
                        ].join("|");
                        if (seen.has(key)) {
                            continue;
                        }
                        seen.add(key);
                        collected.push(candidate);
                    }
                }

                try {
                    const subgraphs = currentGraph.subgraphs;
                    if (subgraphs) {
                        if (typeof subgraphs.values === "function") {
                            for (const sub of subgraphs.values()) {
                                if (sub && typeof sub === "object") {
                                    visitGraph(sub, prefix);
                                }
                            }
                        } else if (Array.isArray(subgraphs)) {
                            for (const sub of subgraphs) {
                                if (sub && typeof sub === "object") {
                                    visitGraph(sub, prefix);
                                }
                            }
                        } else if (typeof subgraphs === "object") {
                            for (const sub of Object.values(subgraphs)) {
                                if (sub && typeof sub === "object") {
                                    visitGraph(sub, prefix);
                                }
                            }
                        }
                    }
                } catch (_) {}
            };

            visitGraph(rootGraph, "");
            return collected;
        };

        const collectEmbeddedMissingModelCandidatesNativeLike = async (graphData = null) => {
            if (!graphData || typeof graphData !== "object") {
                return [];
            }

            const uniqueModels = collectEmbeddedModelsNativeLike(graphData);
            if (!uniqueModels.length) {
                return [];
            }

            const modelStore = await resolveModelStore();
            if (!modelStore) {
                return [];
            }

            try {
                await modelStore.loadModelFolders();
            } catch (_) {
                return [];
            }

            const folderNamesCache = new Map();
            const collected = [];
            const seen = new Set();

            for (const model of uniqueModels) {
                const directory = String(model?.directory || "").trim();
                const modelName = String(model?.name || "").trim();
                if (!directory || !modelName) {
                    continue;
                }

                if (!folderNamesCache.has(directory)) {
                    let nameSet = null;
                    try {
                        const folder = await modelStore.getLoadedModelFolder(directory);
                        const values = folder?.models ? Object.values(folder.models) : [];
                        nameSet = new Set(
                            values
                                .map((entry) => String(entry?.file_name || "").trim())
                                .filter(Boolean)
                        );
                    } catch (_) {
                        nameSet = null;
                    }
                    folderNamesCache.set(directory, nameSet);
                }

                const namesInFolder = folderNamesCache.get(directory);
                if (namesInFolder && namesInFolder.has(modelName)) {
                    continue;
                }

                const candidate = {
                    nodeId: model?.sourceNodeId,
                    nodeType: String(model?.sourceNodeType || "").trim(),
                    widgetName: String(model?.sourceWidgetName || "").trim(),
                    isAssetSupported: false,
                    name: modelName,
                    directory,
                    url: String(model?.url || "").trim(),
                    hash: String(model?.hash || "").trim(),
                    hashType: String(model?.hash_type || "").trim(),
                    isMissing: true,
                };
                const key = [
                    String(candidate?.name || "").trim().toLowerCase(),
                    String(candidate?.directory || "").trim().toLowerCase(),
                    String(candidate?.url || "").trim().toLowerCase(),
                    String(candidate?.widgetName || "").trim().toLowerCase(),
                    String(candidate?.nodeId ?? "").trim().toLowerCase(),
                ].join("|");
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                collected.push(candidate);
            }

            return collected;
        };

        const getFrontendPendingWarningCandidates = () => {
            const activeWorkflow = getActiveWorkflowEntry();
            const pendingWarnings = unwrapStoreValue(activeWorkflow?.pendingWarnings);
            const pendingCandidates = unwrapStoreValue(pendingWarnings?.missingModelCandidates);
            return Array.isArray(pendingCandidates) ? pendingCandidates : [];
        };

        const getFrontendMissingModelCandidates = async (graphDataOverride = null) => {
            try {
                alignGraphWidgetSlashes(app?.rootGraph);
            } catch (_) {}
            let candidates = getFrontendPendingWarningCandidates();
            if (candidates.length) {
                // Filter out stale or resolved candidates whose model name no longer matches
                // any active missing live widget value.
                const hasLiveNodes = Array.isArray(app?.rootGraph?.nodes) && app.rootGraph.nodes.length > 0;
                if (hasLiveNodes) {
                    const liveValues = collectAllLiveWidgetValues();
                    candidates = candidates.filter(c => !isPendingCandidateStaleInLiveGraph(c, liveValues));
                }
                if (candidates.length) {
                    return candidates;
                }
            }

            const hasExplicitWorkflowGraph = graphDataOverride && typeof graphDataOverride === "object";
            const graphData = hasExplicitWorkflowGraph
                ? graphDataOverride
                : serializeWorkflowForModelScan();
            candidates = collectLiveGraphMissingModelCandidatesNativeLike(app?.rootGraph, graphData);
            if (candidates.length) {
                return candidates;
            }

            if (hasExplicitWorkflowGraph) {
                return [];
            }

            candidates = await collectEmbeddedMissingModelCandidatesNativeLike(graphData);
            if (candidates.length) {
                return candidates;
            }

            return [];
        };

        const countActionableScanResults = (data) => {
            const missing = Array.isArray(data?.missing) ? data.missing.length : 0;
            const found = Array.isArray(data?.found) ? data.found.length : 0;
            const mismatches = Array.isArray(data?.mismatches)
                ? data.mismatches.length
                : (Array.isArray(data?.path_mismatches) ? data.path_mismatches.length : 0);
            return missing + found + mismatches;
        };

        const countDownloadRequiredScanResults = (data) => {
            const missing = Array.isArray(data?.missing) ? data.missing.length : 0;
            const mismatches = Array.isArray(data?.mismatches)
                ? data.mismatches.length
                : (Array.isArray(data?.path_mismatches) ? data.path_mismatches.length : 0);
            return missing + mismatches;
        };

        const buildScanResultsSignature = (data = null) => {
            if (!data || typeof data !== "object") {
                return "";
            }
            const parts = [];
            const pushParts = (items, kind, projector) => {
                if (!Array.isArray(items)) return;
                for (const item of items) {
                    const value = projector(item);
                    if (!value) continue;
                    parts.push(`${kind}|${value}`);
                }
            };
            pushParts(data?.missing, "missing", (item) => [
                String(item?.filename || item?.name || "").trim().toLowerCase(),
                String(item?.suggested_folder || item?.directory || "").trim().toLowerCase(),
                String(item?.url || "").trim().toLowerCase(),
            ].join("|"));
            pushParts(data?.found, "found", (item) => [
                String(item?.filename || item?.name || "").trim().toLowerCase(),
                String(item?.path || item?.actual_path || "").trim().toLowerCase(),
            ].join("|"));
            pushParts(
                Array.isArray(data?.mismatches) ? data.mismatches : data?.path_mismatches,
                "mismatch",
                (item) => [
                    String(item?.filename || item?.requested_path || "").trim().toLowerCase(),
                    String(item?.expected_path || "").trim().toLowerCase(),
                    String(item?.actual_path || "").trim().toLowerCase(),
                ].join("|")
            );
            parts.sort();
            return parts.join("||");
        };

        const getMissingEntryDestinationFolder = (entry) => {
            const downloadMode = String(entry?.download_mode || "file").trim().toLowerCase();
            if (downloadMode === "folder") {
                return normalizeWorkflowPath(
                    entry?.locked_folder ||
                    entry?.suggested_folder ||
                    entry?.directory ||
                    entry?.folder ||
                    ""
                );
            }

            const lockedFolder = normalizeWorkflowPath(entry?.locked_folder || "");
            let folder = normalizeWorkflowPath(
                lockedFolder ||
                entry?.suggested_folder ||
                entry?.directory ||
                entry?.folder ||
                ""
            );
            const requestedPath = normalizeWorkflowPath(
                entry?.requested_path ||
                entry?.requestedPath ||
                entry?.display_name ||
                entry?.name ||
                entry?.filename ||
                ""
            );
            const requestedDir = getPathDirname(requestedPath);
            if (requestedDir) {
                const folderLower = folder.toLowerCase();
                const requestedLower = requestedDir.toLowerCase();
                if (!folder) {
                    folder = requestedDir;
                } else if (folderLower !== requestedLower && !folderLower.endsWith(`/${requestedLower}`)) {
                    folder = normalizeWorkflowPath(`${folder}/${requestedDir}`);
                }
            }
            return folder;
        };

        const getMissingEntryDestinationKey = (entry) => {
            if (!entry || typeof entry !== "object") {
                return "";
            }
            const downloadMode = String(entry?.download_mode || "file").trim().toLowerCase();
            if (downloadMode === "folder") {
                const repoId = String(entry?.repo_id || "").trim().toLowerCase();
                const url = String(entry?.url || "").trim().toLowerCase();
                const folder = getMissingEntryDestinationFolder(entry).toLowerCase();
                return `folder|${repoId}|${url}|${folder}`;
            }

            const filename = getPathBasename(
                entry?.filename ||
                entry?.requested_path ||
                entry?.requestedPath ||
                entry?.name ||
                entry?.display_name ||
                ""
            ).toLowerCase();
            if (!filename) {
                return "";
            }
            const folder = getMissingEntryDestinationFolder(entry).toLowerCase();
            return `file|${folder}|${filename}`;
        };

        const getMissingEntryMergeScore = (entry) => {
            const nodeLabel = [
                String(entry?.node_title || ""),
                String(entry?.node_type || ""),
            ].join(" ").toLowerCase();
            const source = String(entry?.source || "").trim().toLowerCase();
            const requestedPath = normalizeWorkflowPath(
                entry?.requested_path ||
                entry?.requestedPath ||
                entry?.display_name ||
                entry?.name ||
                entry?.filename ||
                ""
            );

            let score = 0;
            if (entry?.url) score += 40;
            if (entry?.hf_repo || entry?.repo_id) score += 10;
            if (nodeLabel.includes("hugging face download model")) score += 20;
            if (source === "workflow_metadata") score += 16;
            if (source === "frontend_missing_model_store") score += 10;
            if (source === "run_hook_validation_inferred" || source === "run_hook_fallback") score += 6;
            if (entry?.folder_locked || entry?.locked_folder) score += 6;
            if (requestedPath.includes("/")) score += 4;

            return [score, requestedPath.length];
        };

        const coalesceMissingEntriesByDestination = (entries = []) => {
            if (!Array.isArray(entries) || !entries.length) {
                return [];
            }

            const groups = new Map();
            const passthrough = [];
            for (const entry of entries) {
                if (!entry || typeof entry !== "object") {
                    continue;
                }
                const key = getMissingEntryDestinationKey(entry);
                if (!key) {
                    passthrough.push(entry);
                    continue;
                }
                if (!groups.has(key)) {
                    groups.set(key, []);
                }
                groups.get(key).push(entry);
            }

            const merged = [...passthrough];
            for (const group of groups.values()) {
                if (group.length === 1) {
                    merged.push(group[0]);
                    continue;
                }

                const best = [...group].sort((a, b) => {
                    const aScore = getMissingEntryMergeScore(a);
                    const bScore = getMissingEntryMergeScore(b);
                    if (bScore[0] !== aScore[0]) return bScore[0] - aScore[0];
                    return bScore[1] - aScore[1];
                })[0];
                const next = { ...best };

                if (!next.url) {
                    const firstWithUrl = group.find((entry) => entry?.url);
                    if (firstWithUrl?.url) {
                        next.url = firstWithUrl.url;
                    }
                }
                if (!next.hf_repo) {
                    const firstWithRepo = group.find((entry) => entry?.hf_repo);
                    if (firstWithRepo?.hf_repo) {
                        next.hf_repo = firstWithRepo.hf_repo;
                    }
                }
                if (!next.hf_path) {
                    const firstWithPath = group.find((entry) => entry?.hf_path);
                    if (firstWithPath?.hf_path) {
                        next.hf_path = firstWithPath.hf_path;
                    }
                }
                if (!next.locked_folder) {
                    const firstLocked = group.find((entry) => entry?.locked_folder);
                    if (firstLocked?.locked_folder) {
                        next.locked_folder = firstLocked.locked_folder;
                        next.folder_locked = true;
                    }
                }
                if (!next.suggested_folder) {
                    const firstFolder = group.find((entry) => entry?.suggested_folder || entry?.directory || entry?.folder);
                    if (firstFolder) {
                        next.suggested_folder =
                            firstFolder.suggested_folder ||
                            firstFolder.directory ||
                            firstFolder.folder;
                    }
                }
                if (!next.directory && next.suggested_folder) {
                    next.directory = next.suggested_folder;
                }

                const longestRequested = [...group].sort((a, b) => {
                    const aPath = normalizeWorkflowPath(
                        a?.requested_path || a?.requestedPath || a?.display_name || a?.name || a?.filename || ""
                    );
                    const bPath = normalizeWorkflowPath(
                        b?.requested_path || b?.requestedPath || b?.display_name || b?.name || b?.filename || ""
                    );
                    return bPath.length - aPath.length;
                })[0];
                const longestRequestedPath = normalizeWorkflowPath(
                    longestRequested?.requested_path ||
                    longestRequested?.requestedPath ||
                    longestRequested?.display_name ||
                    longestRequested?.name ||
                    longestRequested?.filename ||
                    ""
                );
                if (longestRequestedPath) {
                    next.requested_path = longestRequestedPath;
                    if (!next.display_name || String(next.display_name).trim().length < longestRequestedPath.length) {
                        next.display_name = longestRequestedPath;
                    }
                }

                const normalizedFilename = getPathBasename(
                    next?.filename || next?.requested_path || next?.display_name || next?.name || ""
                );
                if (normalizedFilename) {
                    next.filename = normalizedFilename;
                }

                const alternatives = [];
                const seenAlternatives = new Set();
                for (const entry of group) {
                    const altList = Array.isArray(entry?.alternatives) ? entry.alternatives : [];
                    for (const alt of altList) {
                        if (!alt || typeof alt !== "object") {
                            continue;
                        }
                        const altKey = [
                            String(alt?.filename || "").trim().toLowerCase(),
                            String(alt?.url || "").trim().toLowerCase(),
                            String(alt?.suggested_folder || alt?.directory || "").trim().toLowerCase(),
                        ].join("|");
                        if (seenAlternatives.has(altKey)) {
                            continue;
                        }
                        seenAlternatives.add(altKey);
                        alternatives.push(alt);
                    }
                }
                if (alternatives.length) {
                    next.alternatives = alternatives;
                }

                merged.push(next);
            }

            return merged;
        };

        const mergeMissingEntries = (existingEntries, newEntries) => {
            return coalesceMissingEntriesByDestination([
                ...(Array.isArray(existingEntries) ? existingEntries : []),
                ...(Array.isArray(newEntries) ? newEntries : []),
            ]);
        };

        const createFrontendMissingModelEntryFromCandidate = (candidate) => {
            if (!isMissingModelCandidate(candidate)) {
                return null;
            }
            if (isFrontendMissingModelCandidateBypassed(candidate)) {
                return null;
            }

            const requestedPath = normalizeWorkflowPath(
                candidate?.requested_path ||
                candidate?.requestedPath ||
                candidate?.name ||
                candidate?.filename ||
                ""
            );
            const filename = getPathBasename(requestedPath);
            if (!filename) {
                return null;
            }

            const inferredDirectory = inferSuggestedFolderFromRunHookSignals({
                classType: candidate?.nodeType || candidate?.node_type || candidate?.node_title,
                inputName: candidate?.widgetName || candidate?.input_name,
                filename,
                missingValue: requestedPath || filename,
            });
            const rawDirectory = String(candidate?.directory || candidate?.folder || "").trim();
            const directory =
                (inferredDirectory && (!rawDirectory || rawDirectory === "checkpoints")
                    ? inferredDirectory
                    : rawDirectory) ||
                inferredDirectory ||
                "checkpoints";
            return {
                filename,
                name: filename,
                requested_path: requestedPath || filename,
                suggested_folder: directory,
                directory,
                url: String(candidate?.url || "").trim(),
                hash: String(candidate?.hash || "").trim(),
                hash_type: String(candidate?.hashType || candidate?.hash_type || "").trim(),
                node_id: candidate?.nodeId ?? candidate?.node_id,
                node_title: String(candidate?.nodeType || candidate?.node_title || "").trim(),
                node_type: String(candidate?.nodeType || candidate?.node_type || "").trim(),
                input_name: String(candidate?.widgetName || candidate?.input_name || "").trim(),
                source: "frontend_missing_model_store",
                type: "",
            };
        };

        const isWorkflowManagedMissingEntry = (entry) => {
            if (!entry || typeof entry !== "object") {
                return false;
            }
            const source = String(entry?.source || "").trim().toLowerCase();
            const nodeLabel = [
                String(entry?.node_title || ""),
                String(entry?.node_type || ""),
            ].join(" ").toLowerCase();
            return Boolean(entry?.url) && (
                source === "workflow_metadata" ||
                nodeLabel.includes("hugging face download model") ||
                nodeLabel.includes("huggingface download model")
            );
        };

        const collectResolvedFrontendMissingModelCandidates = (
            candidates = [],
            unresolvedMissingModels = [],
            unresolvedMismatchModels = []
        ) => {
            const normalizedCandidates = Array.isArray(candidates)
                ? candidates.filter((candidate) => isMissingModelCandidate(candidate))
                : [];
            if (!normalizedCandidates.length) {
                return [];
            }

            const unresolvedKeys = new Set();
            for (const entry of Array.isArray(unresolvedMissingModels) ? unresolvedMissingModels : []) {
                if (!entry || typeof entry !== "object") {
                    continue;
                }
                if (isWorkflowManagedMissingEntry(entry)) {
                    continue;
                }
                const key = getMissingEntryDestinationKey(entry);
                if (key) {
                    unresolvedKeys.add(key);
                }
            }
            for (const entry of Array.isArray(unresolvedMismatchModels) ? unresolvedMismatchModels : []) {
                if (!entry || typeof entry !== "object") {
                    continue;
                }
                const key = getMissingEntryDestinationKey(entry);
                if (key) {
                    unresolvedKeys.add(key);
                }
            }

            if (!unresolvedKeys.size) {
                return normalizedCandidates;
            }

            const resolved = [];
            for (const candidate of normalizedCandidates) {
                if (isFrontendMissingModelCandidateBypassed(candidate)) {
                    resolved.push(candidate);
                    continue;
                }
                const entry = createFrontendMissingModelEntryFromCandidate(candidate);
                if (!entry) {
                    continue;
                }
                const key = getMissingEntryDestinationKey(entry);
                if (!key || unresolvedKeys.has(key)) {
                    continue;
                }
                resolved.push(candidate);
            }
            return resolved;
        };

        const applyResolvedFrontendMissingModelState = async (
            candidates = [],
            unresolvedMissingModels = [],
            unresolvedMismatchModels = []
        ) => {
            const normalizedCandidates = Array.isArray(candidates)
                ? candidates.filter((candidate) => isMissingModelCandidate(candidate))
                : [];
            if (!normalizedCandidates.length) {
                return { resolvedCount: 0, allResolved: false };
            }

            const resolvedCandidates = collectResolvedFrontendMissingModelCandidates(
                normalizedCandidates,
                unresolvedMissingModels,
                unresolvedMismatchModels
            );
            if (!resolvedCandidates.length) {
                return { resolvedCount: 0, allResolved: false };
            }

            clearMissingModelNodeHighlights(resolvedCandidates);
            await clearMissingModelStoreState(resolvedCandidates);

            const allResolved = resolvedCandidates.length >= normalizedCandidates.length;
            if (allResolved) {
                await clearModelValidationErrorsFromFrontendState();
            }

            return {
                resolvedCount: resolvedCandidates.length,
                allResolved,
            };
        };

        const createRunHookFallbackMissingModelsFromFrontendStore = async (providedCandidates = null) => {
            const candidates = Array.isArray(providedCandidates)
                ? providedCandidates
                : await getFrontendMissingModelCandidates();
            if (!candidates.length) {
                return [];
            }

            const modelStore = await resolveModelStore();
            const folderNamesCache = new Map();
            if (modelStore && typeof modelStore.loadModelFolders === "function") {
                try {
                    await modelStore.loadModelFolders();
                } catch (_) {
                    // Keep going; stale frontend candidates are still better than nothing.
                }
            }

            const collected = [];
            const seen = new Set();
            for (const candidate of candidates) {
                const entry = createFrontendMissingModelEntryFromCandidate(candidate);
                if (!entry) {
                    continue;
                }
                const filename = entry.filename;
                const directory = entry.directory;

                if (modelStore && directory) {
                    if (!folderNamesCache.has(directory)) {
                        let nameSet = null;
                        try {
                            const folder = await modelStore.getLoadedModelFolder(directory);
                            const values = folder?.models ? Object.values(folder.models) : [];
                            nameSet = new Set();
                            for (const item of values) {
                                const rawFileName = String(item?.file_name || item?.name || "").trim();
                                if (!rawFileName) continue;
                                nameSet.add(rawFileName.toLowerCase());
                                const baseName = getPathBasename(rawFileName).toLowerCase();
                                if (baseName) {
                                    nameSet.add(baseName);
                                }
                            }
                        } catch (_) {
                            nameSet = null;
                        }
                        folderNamesCache.set(directory, nameSet);
                    }
                    const namesInFolder = folderNamesCache.get(directory);
                    if (namesInFolder && namesInFolder.has(filename.toLowerCase())) {
                        continue;
                    }
                }

                const key = [
                    entry.filename.toLowerCase(),
                    String(entry.requested_path || "").toLowerCase(),
                    entry.suggested_folder.toLowerCase(),
                    entry.url.toLowerCase(),
                    String(entry.node_id || "").toLowerCase(),
                    entry.input_name.toLowerCase(),
                ].join("|");
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                collected.push(entry);
            }

            return filterRunHookEligibleMissingModels(collected);
        };

        const resolvedCatalogModelsByName = new Map();
        const catalogEnrichedWorkflowSignatures = new Set();
        let catalogEnrichInFlight = false;

        const recordCatalogResolvedEntries = (entries = []) => {
            if (!Array.isArray(entries)) return;
            for (const entry of entries) {
                if (!entry || typeof entry !== "object") continue;
                const url = String(entry.url || "").trim();
                if (!url) continue;
                const folder = String(
                    entry.locked_folder || entry.suggested_folder || entry.directory || ""
                ).trim();
                const filename = String(entry.filename || entry.name || "").trim();
                const requestedPath = String(entry.requested_path || filename).trim();
                const sizeBytes = Number(entry.size_bytes ?? entry.size ?? 0) || 0;
                const payload = {
                    url,
                    folder,
                    filename: filename || requestedPath,
                    requestedPath,
                    sizeBytes,
                };
                for (const rawKey of [
                    filename,
                    requestedPath,
                    getPathBasename(filename),
                    getPathBasename(requestedPath),
                ]) {
                    const key = String(rawKey || "").trim().toLowerCase();
                    if (key) {
                        resolvedCatalogModelsByName.set(key, payload);
                    }
                }
            }
        };

        const lookupResolvedCatalogModel = (nameOrPath) => {
            const raw = String(nameOrPath || "").trim().toLowerCase();
            if (!raw) return null;
            return (
                resolvedCatalogModelsByName.get(raw) ||
                resolvedCatalogModelsByName.get(getPathBasename(raw).toLowerCase()) ||
                null
            );
        };

        const syncResolvedUrlsIntoNativeMissingModelStore = async (entries = []) => {
            recordCatalogResolvedEntries(entries);
            try {
                const missingModelStore = await resolveMissingModelStore();
                if (!missingModelStore) return false;
                const current = unwrapStoreValue(missingModelStore.missingModelCandidates);
                if (!Array.isArray(current) || !current.length) return false;

                let changed = false;
                const newlyLinkedUrls = [];
                const nextCandidates = current.map((candidate) => {
                    if (!candidate || typeof candidate !== "object") return candidate;
                    const match = lookupResolvedCatalogModel(candidate.name || candidate.filename);
                    if (!match) return candidate;
                    const curUrl = String(candidate.url || "").trim();
                    const curDir = String(candidate.directory || "").trim();
                    const nextUrl = curUrl || match.url;
                    const nextDir = curDir || match.folder;
                    if (nextUrl === curUrl && nextDir === curDir) {
                        return candidate;
                    }
                    changed = true;
                    if (!curUrl && nextUrl) {
                        newlyLinkedUrls.push({ url: nextUrl, sizeBytes: match.sizeBytes });
                    }
                    return {
                        ...candidate,
                        url: nextUrl,
                        directory: nextDir,
                    };
                });

                if (changed) {
                    if (typeof missingModelStore.setMissingModels === "function") {
                        missingModelStore.setMissingModels(nextCandidates);
                    } else if ("value" in missingModelStore.missingModelCandidates) {
                        missingModelStore.missingModelCandidates.value = nextCandidates;
                    } else {
                        missingModelStore.missingModelCandidates = nextCandidates;
                    }
                    try {
                        const activeWf = getActiveWorkflowEntry();
                        const pw = unwrapStoreValue(activeWf?.pendingWarnings);
                        if (pw && "missingModelCandidates" in pw) {
                            if (
                                pw.missingModelCandidates &&
                                typeof pw.missingModelCandidates === "object" &&
                                "value" in pw.missingModelCandidates
                            ) {
                                pw.missingModelCandidates.value = nextCandidates;
                            } else {
                                pw.missingModelCandidates = nextCandidates;
                            }
                        }
                    } catch (_) {}
                    for (const item of newlyLinkedUrls) {
                        if (item.sizeBytes > 0 && typeof missingModelStore.setFileSize === "function") {
                            try {
                                missingModelStore.setFileSize(item.url, item.sizeBytes);
                            } catch (_) {}
                        }
                    }
                }
                return changed;
            } catch (err) {
                console.warn("[AutoDownload] Failed syncing catalog URLs into missingModelStore:", err);
                return false;
            }
        };

        const enrichNativeMissingModelStoreFromCatalog = async () => {
            if (catalogEnrichInFlight) return;
            try {
                const missingModelStore = await resolveMissingModelStore();
                if (!missingModelStore) return;
                const candidates = unwrapStoreValue(missingModelStore.missingModelCandidates);
                if (!Array.isArray(candidates) || !candidates.length) return;

                const unlinked = candidates.filter((c) => c && !String(c.url || "").trim());
                if (!unlinked.length) return;

                const appliedFromCache = await syncResolvedUrlsIntoNativeMissingModelStore([]);
                const stillUnlinked = (
                    unwrapStoreValue(missingModelStore.missingModelCandidates) || []
                ).filter((c) => c && !String(c.url || "").trim());
                if (!stillUnlinked.length) {
                    if (appliedFromCache) {
                        setTimeout(() => injectButtonsIntoMissingModelsDialogs(document), 60);
                    }
                    return;
                }

                const sig = buildMissingModelCandidatesSignature(stillUnlinked);
                if (!sig || catalogEnrichedWorkflowSignatures.has(sig)) return;
                catalogEnrichedWorkflowSignatures.add(sig);

                const workflow = serializeWorkflowForModelScan();
                if (!workflow || typeof workflow !== "object") return;

                const prefill = stillUnlinked
                    .map((c) => createFrontendMissingModelEntryFromCandidate(c))
                    .filter(Boolean);
                if (!prefill.length) return;

                catalogEnrichInFlight = true;
                const res = await enrichMissingEntriesViaBackend(prefill, {
                    workflow,
                    requestId: `native_sidebar_catalog_${Date.now()}`,
                    skipHfSearch: true,
                    skipStoreSync: true,
                });
                if (res && Array.isArray(res.missing) && res.missing.length) {
                    await syncResolvedUrlsIntoNativeMissingModelStore(res.missing);
                }
            } catch (_) {
            } finally {
                catalogEnrichInFlight = false;
            }
        };

        const enrichMissingEntriesViaBackend = async (entries = [], options = {}) => {
            const missingEntries = Array.isArray(entries) ? entries.filter(Boolean) : [];
            if (!missingEntries.length) {
                return null;
            }

            const workflow =
                options?.workflow && typeof options.workflow === "object"
                    ? options.workflow
                    : serializeWorkflowForModelScan();
            if (!workflow || typeof workflow !== "object") {
                return null;
            }

            try {
                const payload = {
                    ...workflow,
                    request_id: options?.requestId || `frontend-enrich-${Date.now()}`,
                    skip_hf_search: options?.skipHfSearch !== false,
                    prefilled_missing_models: missingEntries,
                };
                const resp = api && typeof api.fetchApi === "function"
                    ? await api.fetchApi("/check_missing_models", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                        signal: options?.signal
                    })
                    : await fetch("/check_missing_models", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                        signal: options?.signal
                    });
                if (resp.status !== 200) {
                    return null;
                }
                const data = await resp.json();
                const enrichedMissing = filterRunHookEligibleMissingModels(
                    Array.isArray(data?.missing) ? data.missing : []
                );
                if (!options?.skipStoreSync && enrichedMissing.length) {
                    void syncResolvedUrlsIntoNativeMissingModelStore(enrichedMissing);
                }
                return {
                    request_id: data?.request_id || payload.request_id,
                    missing: enrichedMissing,
                    found: Array.isArray(data?.found) ? data.found : [],
                    mismatches: Array.isArray(data?.mismatches)
                        ? data.mismatches
                        : (Array.isArray(data?.path_mismatches) ? data.path_mismatches : []),
                };
            } catch (err) {
                console.warn("[AutoDownload] Backend enrichment failed:", err);
                return null;
            }
        };

        const normalizeFolderPathInput = (value) =>
            String(value || "")
                .replace(/\\/g, "/")
                .trim()
                .replace(/^\/+/, "")
                .replace(/\/+$/, "");

        const buildFolderDownloadDestinationPreview = (folder, targetSegment) => {
            const parts = ["models"];
            const normalizedFolder = normalizeFolderPathInput(folder);
            if (normalizedFolder) {
                parts.push(normalizedFolder);
            }
            if (targetSegment) {
                parts.push(targetSegment);
            }
            return `${parts.join("/")}/`;
        };

        const normalizeWorkflowPath = (value) => {
            let normalized = String(value || "").replace(/\\/g, "/").trim();
            if (!normalized) return "";
            normalized = normalized.replace(/\/+/g, "/");
            normalized = normalized.replace(/^(?:\.\/)+/, "");
            if (normalized === ".") return "";
            return normalized;
        };

        const getPathBasename = (value) => {
            const normalized = normalizeWorkflowPath(value).replace(/\/+$/, "");
            if (!normalized) return "";
            const idx = normalized.lastIndexOf("/");
            return idx === -1 ? normalized : normalized.slice(idx + 1);
        };

        const getPathDirname = (value) => {
            const normalized = normalizeWorkflowPath(value).replace(/\/+$/, "");
            if (!normalized) return "";
            const idx = normalized.lastIndexOf("/");
            return idx === -1 ? "" : normalized.slice(0, idx);
        };

        const getSafeSubgraphList = (graphData) => {
            const defs = graphData?.definitions?.subgraphs;
            if (!defs || typeof defs !== "object") {
                return [];
            }
            if (Array.isArray(defs)) {
                return defs.filter(Boolean);
            }
            return Object.values(defs).filter(Boolean);
        };

        const hasSerializableSubgraphDefinitions = (graphData) => {
            return getSafeSubgraphList(graphData).length > 0;
        };

        const isLiveGraphDefaultWorkflow = (rootGraph = app?.rootGraph) => {
            if (!rootGraph || typeof rootGraph !== "object") return false;
            const nodes = Array.isArray(rootGraph.nodes)
                ? rootGraph.nodes
                : (Array.isArray(rootGraph._nodes) ? rootGraph._nodes : []);
            if (nodes.length !== 7) return false;
            const types = nodes.map((n) => String(n?.type || "").trim()).sort();
            const expectedTypes = [
                "CLIPTextEncode",
                "CLIPTextEncode",
                "CheckpointLoaderSimple",
                "EmptyLatentImage",
                "KSampler",
                "SaveImage",
                "VAEDecode",
            ];
            if (!types.every((t, idx) => t === expectedTypes[idx])) return false;
            const ckptNode = nodes.find((n) => n?.type === "CheckpointLoaderSimple");
            const ckptWidget = Array.isArray(ckptNode?.widgets) ? ckptNode.widgets[0] : null;
            const ckptVal = String(ckptWidget?.value || "").trim().toLowerCase();
            return (
                ckptVal === "v1-5-pruned-emaonly-fp16.safetensors" ||
                ckptVal === "v1-5-pruned-emaonly.safetensors" ||
                ckptVal === "v1-5-pruned-emaonly.ckpt"
            );
        };

        const computeLiveGraphRevisionKey = (graph = null) => {
            const rootGraph = graph || app?.rootGraph;
            if (!rootGraph || typeof rootGraph !== "object") return "";
            const parts = [];
            forEachGraphNodeRecursive(rootGraph, (node) => {
                if (!node || typeof node !== "object") return;
                const mode = Number(node.mode ?? 0);
                const wv = Array.isArray(node.widgets)
                    ? node.widgets.map((w) => (typeof w?.value === "string" ? w.value : "")).join(",")
                    : "";
                parts.push(`${node.id ?? ""}:${node.type || ""}:${mode}:${wv}`);
            });
            return `${parts.length}#${parts.join("|")}`;
        };

        const serializeWorkflowForModelScan = () => {
            const sanitizeData = (data, cloneFirst = false) => {
                if (!data || typeof data !== "object") return data;
                
                try {
                    const parsedData = cloneFirst ? JSON.parse(JSON.stringify(data)) : data;
                    const liveNodes = app?.rootGraph?._nodes_by_id || app?.graph?._nodes_by_id || {};
                    
                    const processNodeList = (nodes) => {
                        if (!Array.isArray(nodes)) return;
                        for (const node of nodes) {
                            const liveNode = liveNodes[node.id] || findNodeByIdRecursive(app?.rootGraph || app?.graph, node.id);
                            if (!liveNode || !Array.isArray(liveNode.widgets)) continue;

                            const serializableWidgets = liveNode.widgets.filter(
                                w => w?.serialize !== false && w?.options?.serialize !== false
                            );
                            if (Array.isArray(node.widgets_values)) {
                                const widgetMap =
                                    node.widgets_values.length === serializableWidgets.length
                                        ? serializableWidgets
                                        : (node.widgets_values.length === liveNode.widgets.length ? liveNode.widgets : null);
                                if (widgetMap) {
                                    for (let i = 0; i < widgetMap.length; i += 1) {
                                        const lw = widgetMap[i];
                                        if (typeof lw?.value === "string" && typeof node.widgets_values[i] === "string") {
                                            node.widgets_values[i] = lw.value;
                                        }
                                    }
                                }
                            }
                            if (node.widgets_values_named && typeof node.widgets_values_named === "object") {
                                for (const lw of liveNode.widgets) {
                                    const wName = String(lw?.name || "").trim();
                                    if (wName && wName in node.widgets_values_named && typeof lw?.value === "string") {
                                        node.widgets_values_named[wName] = lw.value;
                                    }
                                }
                            }

                            if (!Array.isArray(liveNode.inputs)) continue;
                            
                            const indicesToNull = new Set();
                            const namesToNull = new Set();
                            for (const inp of liveNode.inputs) {
                                if (inp.link != null) {
                                    if (inp.widget && typeof inp.widget === 'object') {
                                        const wName = String(inp.widget.name || "");
                                        if (wName) {
                                            namesToNull.add(wName);
                                            const wIdx = liveNode.widgets.findIndex(w => String(w?.name || "") === wName);
                                            if (wIdx >= 0) indicesToNull.add(wIdx);
                                        }
                                    }
                                    const matchedName = String(inp.name || "");
                                    if (matchedName) {
                                        namesToNull.add(matchedName);
                                        const wIdx = liveNode.widgets.findIndex(w => String(w?.name || "") === matchedName);
                                        if (wIdx >= 0) indicesToNull.add(wIdx);
                                    }
                                }
                            }
                            
                            if (Array.isArray(node.widgets_values)) {
                                for (const idx of indicesToNull) {
                                    if (idx < node.widgets_values.length) {
                                        node.widgets_values[idx] = null;
                                    }
                                }
                            }
                            if (node.widgets_values_named && typeof node.widgets_values_named === "object") {
                                for (const wName of namesToNull) {
                                    if (wName in node.widgets_values_named) {
                                        node.widgets_values_named[wName] = null;
                                    }
                                }
                            }

                            const disabledValues = getDisabledWidgetValuesForNode(liveNode || node);
                            if (disabledValues.size > 0) {
                                if (Array.isArray(node.properties?.models)) {
                                    node.properties.models = node.properties.models.filter(m => {
                                        const mName = String(m?.name || "").trim();
                                        if (!mName) return false;
                                        const base = mName.split(/[/\\]/).pop().trim();
                                        return !disabledValues.has(mName) && !disabledValues.has(base);
                                    });
                                }
                                if (node.widgets_values_named && typeof node.widgets_values_named === "object") {
                                    for (const [k, v] of Object.entries(node.widgets_values_named)) {
                                        if (isDynamicGroupWidgetDisabledInNode(liveNode || node, k)) {
                                            node.widgets_values_named[k] = null;
                                        }
                                    }
                                }
                                const nodeType = String(node.type || liveNode?.type || "");
                                if ((nodeType === "LoadLoraModel" || nodeType === "LoadLoraTextEncoder" || nodeType === "Load LoRA (Model)" || nodeType === "Load LoRA (Text Encoder)") && Array.isArray(node.widgets_values)) {
                                    const wv = node.widgets_values;
                                    const offset = (wv.length > 0 && typeof wv[0] === "number") ? 1 : 0;
                                    let rIdx = offset;
                                    while (rIdx + 2 < wv.length) {
                                        const st = wv[rIdx + 1];
                                        const en = wv[rIdx + 2];
                                        const isFlagDisabled = en === false || en === 0 || en === "false" || en === "0";
                                        const isZeroStrength = st !== undefined && st !== null && !Number.isNaN(Number(st)) && Number(st) === 0;
                                        if (isFlagDisabled || isZeroStrength) {
                                            node.widgets_values[rIdx] = null;
                                        }
                                        rIdx += 3;
                                    }
                                }
                            }
                        }
                    };

                    // Process root nodes
                    processNodeList(parsedData.nodes);

                    // Process subgraphs in definitions (recursive support)
                    if (parsedData.definitions && parsedData.definitions.subgraphs) {
                        for (const subgraphId in parsedData.definitions.subgraphs) {
                            const subgraph = parsedData.definitions.subgraphs[subgraphId];
                            if (subgraph && subgraph.nodes) {
                                processNodeList(subgraph.nodes);
                            }
                        }
                    }

                    // Strip stale model metadata entries that no longer match
                    // any widget value. This prevents the backend from seeing
                    // models the user has already swapped out in the UI.
                    const allWidgetVals = new Set();
                    const gatherAllWidgetVals = (nodes) => {
                        if (!Array.isArray(nodes)) return;
                        for (const node of nodes) {
                            const wvRaw = node?.widgets_values;
                            const wv = Array.isArray(wvRaw) ? wvRaw : Object.values(wvRaw || {});
                            for (const v of wv) {
                                if (typeof v === "string" && v.trim()) {
                                    allWidgetVals.add(v.trim());
                                }
                            }
                            if (node?.widgets_values_named && typeof node.widgets_values_named === "object") {
                                for (const v of Object.values(node.widgets_values_named)) {
                                    if (typeof v === "string" && v.trim()) {
                                        allWidgetVals.add(v.trim());
                                    }
                                }
                            }
                        }
                    };
                    gatherAllWidgetVals(parsedData.nodes);
                    if (parsedData.definitions && parsedData.definitions.subgraphs) {
                        for (const subgraphId in parsedData.definitions.subgraphs) {
                            const sg = parsedData.definitions.subgraphs[subgraphId];
                            gatherAllWidgetVals(sg?.nodes);
                        }
                    }

                    // Filter per-node properties.models
                    const filterNodeModels = (nodes) => {
                        if (!Array.isArray(nodes)) return;
                        for (const node of nodes) {
                            if (!node?.properties?.models || !Array.isArray(node.properties.models)) continue;
                            node.properties.models = node.properties.models.filter(m => {
                                const name = String(m?.name || "").trim();
                                return !name || allWidgetVals.has(name) || allWidgetVals.has(name.split(/[/\\]/).pop().trim());
                            });
                        }
                    };
                    filterNodeModels(parsedData.nodes);
                    if (parsedData.definitions && parsedData.definitions.subgraphs) {
                        for (const subgraphId in parsedData.definitions.subgraphs) {
                            const sg = parsedData.definitions.subgraphs[subgraphId];
                            filterNodeModels(sg?.nodes);
                        }
                    }

                    // Filter top-level models array
                    if (Array.isArray(parsedData.models)) {
                        parsedData.models = parsedData.models.filter(m => {
                            const name = String(m?.name || "").trim();
                            return !name || allWidgetVals.has(name) || allWidgetVals.has(name.split(/[/\\]/).pop().trim());
                        });
                    }

                    return parsedData;
                } catch(e) {
                    console.error("[AutoDownload] Recursive sanitize failed:", e);
                    return data;
                }
            };

            let rootGraphData = null;
            try {
                if (typeof app?.rootGraph?.serialize === "function") {
                    rootGraphData = app.rootGraph.serialize();
                    if (rootGraphData && typeof rootGraphData === "object") {
                        return sanitizeData(rootGraphData);
                    }
                }
            } catch (_) {
                // Fall through to workflow store state.
            }

            try {
                const activeWorkflow = getActiveWorkflowEntry();
                const activeState = activeWorkflow?.activeState;
                if (activeState && typeof activeState === "object") {
                    return sanitizeData(activeState, true);
                }
            } catch (_) {
                // Fall through to deprecated graph alias.
            }

            try {
                if (typeof app?.graph?.serialize === "function") {
                    const legacyGraphData = app.graph.serialize();
                    if (
                        legacyGraphData &&
                        typeof legacyGraphData === "object" &&
                        (!rootGraphData || hasSerializableSubgraphDefinitions(legacyGraphData))
                    ) {
                        return sanitizeData(legacyGraphData);
                    }
                }
            } catch (_) {
                // No serialized workflow available.
            }

            return sanitizeData(rootGraphData);
        };

        const isWorkflowReadyForModelScan = () => {
            if (app?.isGraphReady === false) {
                return false;
            }
            const rootGraph = app?.rootGraph || app?.graph;
            return Boolean(rootGraph && (Array.isArray(rootGraph.nodes) || Array.isArray(rootGraph._nodes)));
        };

        const formatFoundModelPath = (value) => {
            const normalized = normalizeWorkflowPath(value).replace(/^\/+/, "");
            if (!normalized) return "";
            const parts = normalized.split("/").filter(Boolean);
            if (!parts.length) return normalized;
            for (let i = parts.length - 1; i >= 0; i -= 1) {
                if (parts[i].toLowerCase() === "models" && i < parts.length - 1) {
                    return parts.slice(i + 1).join("/");
                }
            }
            return normalized;
        };

        const canonicalizeModelBasename = (value) => {
            const base = getPathBasename(value).toLowerCase();
            if (!base) return "";
            const dotIdx = base.lastIndexOf(".");
            const ext = dotIdx >= 0 ? base.slice(dotIdx) : "";
            let stem = dotIdx >= 0 ? base.slice(0, dotIdx) : base;
            stem = stem
                .replace(/[-_]?fp8[-_]?e4m3fn$/i, "")
                .replace(/[-_]?fp(16|32|8|4)$/i, "")
                .replace(/[-_]?bf16$/i, "")
                .replace(/[-_]?nf4$/i, "")
                .replace(/[-_]?int(8|4)$/i, "");
            return `${stem}${ext}`;
        };

        const resolveDownloadedFilename = (rowData, statusInfo = null) => {
            const fromStatusPath = getPathBasename(statusInfo?.path || "");
            if (fromStatusPath) return fromStatusPath;

            const fromRowFilename = getPathBasename(rowData?.filename || rowData?.originalFilename || "");
            if (fromRowFilename) return fromRowFilename;

            const fromRequestedPath = getPathBasename(
                rowData?.requestedPath || rowData?.initialWidgetValue || ""
            );
            if (fromRequestedPath) return fromRequestedPath;

            const fromInputUrl = parseFilenameFromUrl(rowData?.urlInput?.value || "");
            if (fromInputUrl) return fromInputUrl;

            const fromResolvedUrl = parseFilenameFromUrl(rowData?.resolvedUrl || "");
            if (fromResolvedUrl) return fromResolvedUrl;

            const fallback = String(rowData?.filename || rowData?.originalFilename || "").trim();
            return fallback || null;
        };

        const syncRowFilename = (rowData, filename) => {
            const next = String(filename || "").trim();
            if (!next) return;
            if (rowData.filename !== next) {
                rowData.filename = next;
                if (rowData.nameEl) {
                    rowData.nameEl.textContent = rowData.displayName || next;
                }
            }
        };

        ensureManualToggleStyles();

        const collectModelWidgetsInNode = (node, rowData) => {
            if (!node || !Array.isArray(node.widgets)) return [];
            const candidates = [
                rowData.requestedPath,
                rowData.originalFilename,
                rowData.initialWidgetValue
            ].filter(Boolean);
            if (!candidates.length) return [];

            const matches = [];
            const seenWidgets = new Set();
            const addMatches = (predicate) => {
                for (const widget of node.widgets) {
                    if (typeof widget?.value !== "string") continue;
                    if (!predicate(widget.value)) continue;
                    if (seenWidgets.has(widget)) continue;
                    seenWidgets.add(widget);
                    matches.push(widget);
                }
            };

            const exactCandidates = new Set(candidates.map(normalizeWorkflowPath).filter(Boolean));
            addMatches((value) => exactCandidates.has(normalizeWorkflowPath(value)));

            const candidateBasenames = new Set(
                candidates
                    .map(getPathBasename)
                    .filter(Boolean)
                    .map((x) => x.toLowerCase())
            );
            if (candidateBasenames.size) {
                addMatches((value) => candidateBasenames.has(getPathBasename(value).toLowerCase()));
            }

            const candidateCanonical = new Set(
                candidates
                    .map(canonicalizeModelBasename)
                    .filter(Boolean)
            );
            if (candidateCanonical.size) {
                addMatches((value) => candidateCanonical.has(canonicalizeModelBasename(value)));
            }

            return matches;
        };

        const buildRowDataFromModelEntry = (entry) => ({
            requestedPath: entry?.requested_path || entry?.requestedPath || entry?.filename || "",
            originalFilename: entry?.filename || "",
            initialWidgetValue: entry?.requested_path || entry?.requestedPath || entry?.filename || "",
        });

        const forEachGraphNodeRecursive = (graph, callback, visited = new Set()) => {
            if (!graph || typeof callback !== "function") return;
            if (visited.has(graph)) {
                return;
            }
            visited.add(graph);

            const nodes = Array.isArray(graph.nodes)
                ? graph.nodes
                : (Array.isArray(graph._nodes) ? graph._nodes : []);
            
            for (const node of nodes) {
                if (!node) continue;
                callback(node);
                try {
                    const sub = (typeof node.getInnerGraph === "function" ? node.getInnerGraph() : null) || node.subgraph;
                    if (sub && typeof sub === "object") {
                        forEachGraphNodeRecursive(sub, callback, visited);
                    }
                } catch (_) {}
            }

            try {
                const subgraphs = graph.subgraphs;
                if (subgraphs) {
                    if (typeof subgraphs.values === "function") {
                        for (const sub of subgraphs.values()) {
                            if (sub && typeof sub === "object") {
                                forEachGraphNodeRecursive(sub, callback, visited);
                            }
                        }
                    } else if (Array.isArray(subgraphs)) {
                        for (const sub of subgraphs) {
                            if (sub && typeof sub === "object") {
                                forEachGraphNodeRecursive(sub, callback, visited);
                            }
                        }
                    } else if (typeof subgraphs === "object") {
                        for (const sub of Object.values(subgraphs)) {
                            if (sub && typeof sub === "object") {
                                forEachGraphNodeRecursive(sub, callback, visited);
                            }
                        }
                    }
                }
            } catch (_) {}
        };

        const findNodeByIdRecursive = (graph, id) => {
            let foundNode = null;
            forEachGraphNodeRecursive(graph, (node) => {
                if (node && String(node.id) === String(id)) {
                    foundNode = node;
                }
            });
            return foundNode;
        };

        const collectModelWidgetTargets = (entry) => {
            const graphNodes = [];
            forEachGraphNodeRecursive(app?.rootGraph || app?.graph, (node) => {
                graphNodes.push(node);
            });
            if (!graphNodes.length) return [];

            const rowData = buildRowDataFromModelEntry(entry);
            const targets = [];
            const seenWidgets = new Set();
            const pushNodeMatches = (node) => {
                if (!node) return;
                const widgets = collectModelWidgetsInNode(node, rowData);
                if (!widgets.length) return;
                for (const widget of widgets) {
                    if (seenWidgets.has(widget)) continue;
                    seenWidgets.add(widget);
                    targets.push({ node, widget });
                }
            };

            const nodeId = Number(entry?.node_id);
            let hadPreferredMatches = false;
            if (Number.isFinite(nodeId)) {
                const preferredNode = findNodeByIdRecursive(app?.rootGraph || app?.graph, nodeId);
                if (isLocalModelLoaderNode(preferredNode)) {
                    const beforeCount = targets.length;
                    pushNodeMatches(preferredNode);
                    hadPreferredMatches = targets.length > beforeCount;
                }
            }

            if (hadPreferredMatches) {
                return targets;
            }

            for (const node of graphNodes) {
                if (!isLocalModelLoaderNode(node)) continue;
                pushNodeMatches(node);
            }
            return targets;
        };

        const resolveNodeByExecutionOrGraphId = (rootGraph, rawId) => {
            const idStr = String(rawId ?? "").trim();
            if (!rootGraph || !idStr) return null;
            if (idStr.includes(":")) {
                const parts = idStr.split(":").filter(Boolean);
                let currentGraph = rootGraph;
                let currentNode = null;
                for (let i = 0; i < parts.length; i += 1) {
                    const part = parts[i];
                    const numeric = Number(part);
                    currentNode =
                        currentGraph?.getNodeById?.(part) ||
                        (Number.isFinite(numeric) ? currentGraph?.getNodeById?.(numeric) : null) ||
                        null;
                    if (!currentNode) break;
                    if (i < parts.length - 1) {
                        currentGraph = currentNode.subgraph || currentNode.getInnerGraph?.() || null;
                        if (!currentGraph) {
                            currentNode = null;
                            break;
                        }
                    }
                }
                if (currentNode) return currentNode;
                const leafId = parts[parts.length - 1];
                if (leafId) {
                    const leafMatch = findNodeByIdRecursive(rootGraph, leafId);
                    if (leafMatch) return leafMatch;
                }
            }
            return findNodeByIdRecursive(rootGraph, idStr);
        };

        const locateModelNodeOnCanvas = (entry) => {
            if (!entry || typeof entry !== "object") {
                return false;
            }
            const rootGraph = app?.rootGraph || app?.graph;
            const rawNodeId = String(entry?.node_id ?? entry?.nodeId ?? "").trim();
            let targetNode = rawNodeId ? resolveNodeByExecutionOrGraphId(rootGraph, rawNodeId) : null;
            if (!targetNode) {
                const targets = collectModelWidgetTargets(entry);
                if (targets.length && targets[0]?.node) {
                    targetNode = targets[0].node;
                }
            }
            if (!targetNode) {
                showToast({
                    severity: "warn",
                    summary: "Node not found",
                    detail: `Could not locate node for "${entry.filename || entry.display_name || "model"}".`,
                    life: 2400,
                });
                return false;
            }

            const canvas = app?.canvas;
            if (!canvas) {
                return false;
            }
            try {
                if (targetNode.graph && canvas.graph !== targetNode.graph) {
                    if (typeof canvas.openSubgraph === "function") {
                        canvas.openSubgraph(targetNode.graph);
                    } else if (typeof canvas.setGraph === "function") {
                        canvas.setGraph(targetNode.graph);
                    }
                }
            } catch (_) {}

            try {
                if (typeof canvas.deselectAll === "function") {
                    canvas.deselectAll();
                }
                if (typeof canvas.selectNode === "function") {
                    canvas.selectNode(targetNode);
                } else if (typeof canvas.selectNodes === "function") {
                    canvas.selectNodes([targetNode]);
                }
            } catch (_) {}

            try {
                if (typeof canvas.animateToBounds === "function" && targetNode.boundingRect) {
                    canvas.animateToBounds(targetNode.boundingRect);
                } else if (typeof canvas.centerOnNode === "function") {
                    canvas.centerOnNode(targetNode);
                }
            } catch (_) {
                try {
                    if (typeof canvas.centerOnNode === "function") {
                        canvas.centerOnNode(targetNode);
                    }
                } catch (_) {}
            }

            try {
                canvas.setDirty?.(true, true);
            } catch (_) {}
            return true;
        };

        const applyWorkflowPathForModelEntry = (entry, nextValue) => {
            const targetValue = normalizeWorkflowPath(nextValue);
            if (!targetValue) return 0;

            const targets = collectModelWidgetTargets(entry);
            if (!targets.length) return 0;

            let updatedRefs = 0;
            const dirtyNodes = new Set();
            for (const { node, widget } of targets) {
                if (!widget || typeof widget.value !== "string") continue;
                if (normalizeWorkflowPath(widget.value) === targetValue) continue;
                widget.value = targetValue;
                updatedRefs += 1;
                dirtyNodes.add(node);
            }

            for (const node of dirtyNodes) {
                node?.setDirtyCanvas?.(true);
            }
            return updatedRefs;
        };

        const shouldAutoFixPathMismatch = (entry) => {
            const requestedPath = normalizeWorkflowPath(entry?.requested_path || entry?.filename || "");
            const foundPath = normalizeWorkflowPath(entry?.clean_path || "");
            if (!requestedPath || !foundPath || requestedPath === foundPath) {
                return false;
            }

            const requestedBase = getPathBasename(requestedPath).toLowerCase();
            const foundBase = getPathBasename(foundPath).toLowerCase();
            if (requestedBase && foundBase && requestedBase !== foundBase) {
                return false;
            }
            return true;
        };

        const autoApplyPathMismatches = (mismatches) => {
            let fixedRefs = 0;
            let fixedRows = 0;
            const remaining = [];

            for (const entry of mismatches || []) {
                if (!shouldAutoFixPathMismatch(entry)) {
                    remaining.push(entry);
                    continue;
                }
                const updated = applyWorkflowPathForModelEntry(entry, entry?.clean_path || "");
                if (updated > 0) {
                    fixedRows += 1;
                    fixedRefs += updated;
                    continue;
                }
                remaining.push(entry);
            }

            return { remaining, fixedRows, fixedRefs };
        };

        const isLocalModelLoaderNode = (node) => {
            if (!node) return false;
            const typeLower = String(node.type || "").toLowerCase();
            if (!typeLower) return false;

            // Never rewrite link/download nodes or note/primitive nodes.
            if (
                typeLower.includes("hugging face download model") ||
                typeLower.includes("huggingface download model") ||
                typeLower.includes("hugging face download folder") ||
                typeLower.includes("huggingface download folder") ||
                typeLower === "note" ||
                typeLower === "markdownnote" ||
                typeLower === "primitivestring" ||
                typeLower === "primitivestringmultiline"
            ) {
                return false;
            }

            const props = node.properties || {};
            const hasModelMetadata = Array.isArray(props.models) && props.models.length > 0;
            const looksLikeLoader =
                typeLower.includes("loader") ||
                typeLower.startsWith("load") ||
                typeLower.includes("lora") ||
                typeLower.includes("upscale") ||
                isLikelyModelLoaderClass(node.type);

            if (hasModelMetadata || looksLikeLoader) {
                return true;
            }

            const widgets = Array.isArray(node.widgets) ? node.widgets : [];
            return widgets.some(w => isModelValidationInputName(w?.name));
        };

        const buildUpdatedWidgetValue = (rowData, statusInfo = null) => {
            const downloadedFilename = (resolveDownloadedFilename(rowData, statusInfo) || rowData.filename || "").trim();
            if (!downloadedFilename) return "";
            const requestedPath = normalizeWorkflowPath(rowData.requestedPath || rowData.originalFilename || "");
            if (!requestedPath) {
                const selectedFolder = normalizeWorkflowPath(rowData.folderInput?.value || "");
                const folderParts = selectedFolder.split("/").filter(Boolean);
                if (folderParts.length > 1) {
                    const subfolder = folderParts.slice(1).join("/");
                    return `${subfolder}/${downloadedFilename}`;
                }
                return downloadedFilename;
            }
            const dir = getPathDirname(requestedPath);
            return dir ? `${dir}/${downloadedFilename}` : downloadedFilename;
        };

        const applyDownloadedReferenceToWorkflow = (rowData, statusInfo = null) => {
            if (!rowData) return 0;
            const nextValue = buildUpdatedWidgetValue(rowData, statusInfo);
            if (!nextValue) return 0;

            const graphNodes = [];
            forEachGraphNodeRecursive(app?.rootGraph || app?.graph, (node) => {
                graphNodes.push(node);
            });
            let updatedRefs = 0;

            for (const node of graphNodes) {
                if (!isLocalModelLoaderNode(node)) continue;
                const widgets = collectModelWidgetsInNode(node, rowData);
                if (!widgets.length) continue;

                let nodeChanged = false;
                for (const widget of widgets) {
                    if (normalizeWorkflowPath(widget.value) === normalizeWorkflowPath(nextValue)) {
                        continue;
                    }
                    widget.value = nextValue;
                    updatedRefs += 1;
                    nodeChanged = true;
                }

                if (nodeChanged) {
                    node.setDirtyCanvas(true);
                }
            }

            if (updatedRefs > 0) {
                rowData.initialWidgetValue = nextValue;
                rowData.requestedPath = nextValue;
            }
            return updatedRefs;
        };

        const NATIVE_OVERLAY_WRAPPER_CLASS =
            "pointer-events-none flex w-full justify-end transition-all duration-300 ease-out";
        const NATIVE_OVERLAY_PANEL_CLASS =
            "pointer-events-auto relative flex w-fit max-w-120 min-w-80 flex-col gap-2 overflow-hidden rounded-lg border border-l-4 bg-background p-3 shadow-md transition-colors duration-200 ease-in-out border-l-warning";
        const applyNativeToasterPanelStyle = (panel) => {
            if (!panel) return;
            panel.className =
                "pointer-events-auto relative flex flex-col overflow-hidden rounded-lg border border-l-4 bg-background text-foreground p-3 shadow-md transition-colors duration-200 ease-in-out border-l-warning";
            const nativeErrorOverlay = typeof document !== "undefined"
                ? document.querySelector('[data-testid="error-overlay"]')
                : null;
            const measuredWidth = nativeErrorOverlay
                ? Math.round(nativeErrorOverlay.getBoundingClientRect().width)
                : 0;
            const targetWidth = measuredWidth >= 320 && measuredWidth <= 480
                ? `min(${measuredWidth}px, calc(100vw - 32px))`
                : "min(416px, calc(100vw - 32px))";
            Object.assign(panel.style, {
                width: targetWidth,
                minWidth: "min(320px, calc(100vw - 32px))",
                maxWidth: "min(480px, calc(100vw - 32px))",
                padding: "12px",
                gap: "10px",
            });
        };
        const NATIVE_OVERLAY_CLOSE_BTN_CLASS =
            "inline-flex cursor-pointer touch-manipulation appearance-none items-center justify-center gap-2 border-none font-inter text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 bg-transparent text-muted-foreground hover:bg-accent p-0 absolute top-2 right-2 size-6 rounded-sm";
        const NATIVE_SECONDARY_BTN_CLASS =
            "relative inline-flex cursor-pointer touch-manipulation appearance-none items-center justify-center gap-2 border-none font-inter whitespace-nowrap transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 bg-secondary text-foreground hover:bg-accent min-h-8 rounded-lg px-3 py-2 text-xs font-normal";
        const NATIVE_PRIMARY_BTN_CLASS =
            "relative inline-flex cursor-pointer touch-manipulation appearance-none items-center justify-center gap-2 border-none font-inter whitespace-nowrap transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 bg-primary text-foreground hover:bg-primary/90 min-h-8 rounded-lg px-3 py-2 text-xs font-medium";

        const ensureAutoDownloadOverlayControlStyles = () => {
            if (typeof document === "undefined" || document.getElementById("hf-auto-download-control-styles")) {
                return;
            }
            const style = document.createElement("style");
            style.id = "hf-auto-download-control-styles";
            style.textContent = `
                .hf-row-skip-btn {
                    position: relative;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: 20px;
                    height: 20px;
                    padding: 0;
                    border: none;
                    border-radius: 4px;
                    background: transparent;
                    cursor: pointer;
                    flex-shrink: 0;
                    transition: background-color 120ms ease;
                }
                .hf-row-skip-btn .hf-skip-x {
                    display: none;
                }
                .hf-row-skip-btn:not(:disabled):hover,
                .hf-row-skip-btn:not(:disabled):focus-visible {
                    background: var(--accent, rgba(255, 255, 255, 0.08));
                    outline: none;
                }
                .hf-row-skip-btn:not(:disabled):hover .hf-skip-spinner,
                .hf-row-skip-btn:not(:disabled):focus-visible .hf-skip-spinner {
                    display: none !important;
                }
                .hf-row-skip-btn:not(:disabled):hover .hf-skip-x,
                .hf-row-skip-btn:not(:disabled):focus-visible .hf-skip-x {
                    display: inline-flex;
                }
                .hf-node-tumbler {
                    position: relative;
                    display: inline-flex;
                    align-items: center;
                    width: 26px;
                    height: 14px;
                    flex-shrink: 0;
                    cursor: pointer;
                    vertical-align: middle;
                    margin: 0;
                }
                .hf-node-tumbler input {
                    position: absolute;
                    inset: 0;
                    width: 100%;
                    height: 100%;
                    margin: 0;
                    opacity: 0;
                    cursor: pointer;
                    z-index: 2;
                }
                .hf-node-tumbler-track {
                    position: relative;
                    display: block;
                    width: 26px;
                    height: 14px;
                    border-radius: 9999px;
                    background: var(--comfy-input-bg, #3a3a42);
                    border: 1px solid var(--border-default, rgba(255, 255, 255, 0.18));
                    box-sizing: border-box;
                    transition: background-color 140ms ease, border-color 140ms ease;
                }
                .hf-node-tumbler-track::before {
                    content: "";
                    position: absolute;
                    top: 50%;
                    left: 1px;
                    width: 10px;
                    height: 10px;
                    border-radius: 9999px;
                    background: #ffffff;
                    transform: translateY(-50%);
                    transition: transform 140ms ease;
                    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
                }
                .hf-node-tumbler input:checked + .hf-node-tumbler-track {
                    background: var(--primary-background, #2786e5);
                    border-color: var(--primary-background, #2786e5);
                }
                .hf-node-tumbler input:checked + .hf-node-tumbler-track::before {
                    transform: translate(12px, -50%);
                }
                .hf-node-tumbler input:focus-visible + .hf-node-tumbler-track {
                    outline: 1px solid var(--ring, #3b82f6);
                    outline-offset: 1px;
                }
            `;
            (document.head || document.documentElement).appendChild(style);
        };

        const createMissingCountBadge = (count = 0) => {
            const badge = document.createElement("span");
            badge.setAttribute("data-testid", "hf-model-count-badge");
            badge.className = "inline-flex shrink-0 items-center justify-center rounded-full font-semibold tabular-nums";
            Object.assign(badge.style, {
                minWidth: "18px",
                height: "18px",
                padding: "0 4px",
                background: "var(--warning, #f59e0b)",
                color: "#111111",
                fontSize: "11px",
                fontWeight: "600",
                lineHeight: "1",
                boxSizing: "border-box",
            });
            badge.textContent = String(Math.max(0, Number(count) || 0));
            return badge;
        };

        const createNativeOverlayCloseButton = (testId, onClose) => {
            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.setAttribute("aria-label", "Close");
            if (testId) {
                closeBtn.setAttribute("data-testid", testId);
            }
            closeBtn.className = NATIVE_OVERLAY_CLOSE_BTN_CLASS;
            const closeIcon = document.createElement("i");
            closeIcon.className = "icon-[lucide--x] block size-4 leading-none";
            closeIcon.setAttribute("aria-hidden", "true");
            closeBtn.appendChild(closeIcon);
            closeBtn.onclick = () => {
                if (typeof onClose === "function") {
                    onClose();
                }
            };
            return closeBtn;
        };

        const removeExistingAutoDownloadDialog = () => {
            const existing = document.getElementById("auto-download-dialog");
            if (!existing) return;
            try {
                if (typeof existing.__hfOverlayCleanup === "function") {
                    existing.__hfOverlayCleanup();
                }
            } catch (_) {}
            unmountFromNativeStack(existing, "auto-download-dialog");
            existing.remove();
        };

        const mountOverlayInNativeStack = (dlg) => {
            const unmount = mountInNativeStack(dlg, {
                id: "auto-download-dialog",
                priority: 30,
                visible: true,
            });
            dlg.__hfOverlayCleanup = unmount;
            return unmount;
        };

        /* Show loading dialog immediately */
        const showLoadingDialog = (onSkipModel, options = {}) => {
            const skipModeActive = Boolean(options.skipModeActive);
            const initialModels = Array.isArray(options.initialModels) ? options.initialModels.filter(Boolean) : [];
            removeExistingAutoDownloadDialog();
            ensureAutoDownloadOverlayControlStyles();

            const dlg = document.createElement("div");
            dlg.id = "auto-download-dialog";
            dlg.setAttribute("data-testid", "hf-model-search-overlay");
            dlg.className = NATIVE_OVERLAY_WRAPPER_CLASS;

            const panel = document.createElement("div");
            panel.setAttribute("role", "status");
            applyNativeToasterPanelStyle(panel);

            let cleanupOverlay = () => {};
            const closeBtn = createNativeOverlayCloseButton("hf-model-search-dismiss", () => {
                if (typeof options.onClose === "function") {
                    options.onClose();
                } else {
                    cleanupOverlay();
                    if (dlg.parentElement) dlg.remove();
                }
            });

            const headerRow = document.createElement("div");
            headerRow.className = "flex w-full items-center gap-2 pr-7";
            headerRow.style.marginBottom = "2px";

            const countBadge = createMissingCountBadge(initialModels.length);
            if (initialModels.length === 0) {
                countBadge.style.display = "none";
            }
            const titleEl = document.createElement("span");
            titleEl.className = "shrink-0 text-foreground";
            Object.assign(titleEl.style, {
                fontSize: "13px",
                fontWeight: "600",
                lineHeight: "1.2",
            });
            titleEl.textContent = "Auto-Download Models";

            const statusEl = document.createElement("span");
            statusEl.className = "min-w-0 flex-1 truncate text-muted-foreground";
            statusEl.style.fontSize = "11px";
            statusEl.textContent = skipModeActive ? "Skipping unresolved..." : "Searching...";

            headerRow.appendChild(countBadge);
            headerRow.appendChild(titleEl);
            headerRow.appendChild(statusEl);

            const detailEl = document.createElement("div");
            detailEl.className = "m-0 min-w-0 text-muted-foreground truncate";
            Object.assign(detailEl.style, {
                fontSize: "12px",
                lineHeight: "1.35",
                display: initialModels.length > 0 ? "none" : "block",
            });
            detailEl.textContent = "Scanning workflow for missing models...";

            const searchRows = [];
            let listEl = null;
            if (initialModels.length > 0) {
                listEl = document.createElement("div");
                listEl.className = "flex flex-col overflow-y-auto pr-0.5";
                Object.assign(listEl.style, {
                    maxHeight: "min(65vh, 500px)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                });
                applyNativeScrollbarClasses(listEl);

                initialModels.forEach((m) => {
                    const displayName = String(
                        m.display_name || m.requested_path || m.filename || m.name || ""
                    ).trim() || "Unknown model";
                    const rawFilename = String(m.filename || m.name || displayName).trim();
                    const folderLabel = String(
                        m.locked_folder || m.suggested_folder || m.directory || m.folder || ""
                    ).trim();
                    const nodeTitle = String(m.node_title || m.nodeType || "").trim();

                    const row = document.createElement("div");
                    row.setAttribute("data-testid", "hf-model-search-row");
                    Object.assign(row.style, {
                        display: "flex",
                        flexDirection: "column",
                        gap: "5px",
                        padding: "0",
                        borderTop: "none",
                    });

                    const topLine = document.createElement("div");
                    Object.assign(topLine.style, {
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                    });

                    const nameEl = document.createElement("div");
                    nameEl.className = "min-w-0 flex-1 truncate text-foreground";
                    Object.assign(nameEl.style, {
                        fontSize: "12px",
                        fontWeight: "500",
                        lineHeight: "1.3",
                    });
                    nameEl.textContent = displayName;
                    nameEl.title = nodeTitle ? `${displayName} (${nodeTitle})` : displayName;

                    const skipBtn = document.createElement("button");
                    skipBtn.type = "button";
                    skipBtn.className = "hf-row-skip-btn";
                    skipBtn.setAttribute("data-testid", "hf-model-row-skip-search");
                    skipBtn.setAttribute("aria-label", `Skip searching for ${displayName}`);
                    skipBtn.title = "Skip searching for this model";
                    skipBtn.disabled = skipModeActive;

                    const rowSpinner = document.createElement("i");
                    rowSpinner.setAttribute("data-testid", "hf-model-row-spinner");
                    rowSpinner.setAttribute("aria-hidden", "true");
                    rowSpinner.className = "hf-skip-spinner pi pi-spinner-dotted pi-spin inline-flex size-3.5 items-center justify-center text-xs leading-none text-muted-foreground";

                    const skipXIcon = document.createElement("i");
                    skipXIcon.setAttribute("aria-hidden", "true");
                    skipXIcon.className = "hf-skip-x icon-[lucide--x] size-3.5 text-foreground";

                    skipBtn.appendChild(rowSpinner);
                    skipBtn.appendChild(skipXIcon);

                    const locateBtn = document.createElement("button");
                    locateBtn.type = "button";
                    locateBtn.setAttribute("data-testid", "hf-model-locate-node");
                    locateBtn.setAttribute("aria-label", `Locate node${nodeTitle ? `: ${nodeTitle}` : ""}`);
                    locateBtn.title = nodeTitle ? `Locate node: ${nodeTitle}` : "Locate node on canvas";
                    locateBtn.className =
                        "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent p-0 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
                    const locateIcon = document.createElement("i");
                    locateIcon.className = "icon-[lucide--locate] size-3.5";
                    locateIcon.setAttribute("aria-hidden", "true");
                    locateBtn.appendChild(locateIcon);
                    locateBtn.onclick = (event) => {
                        event.stopPropagation();
                        locateModelNodeOnCanvas({
                            ...m,
                            filename: rawFilename,
                            display_name: displayName,
                        });
                    };

                    topLine.appendChild(nameEl);
                    topLine.appendChild(skipBtn);
                    topLine.appendChild(locateBtn);

                    const controlsLine = document.createElement("div");
                    Object.assign(controlsLine.style, {
                        paddingLeft: "0",
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                    });

                    const folderField = document.createElement("input");
                    folderField.type = "text";
                    folderField.readOnly = true;
                    folderField.tabIndex = -1;
                    folderField.value = folderLabel;
                    folderField.placeholder = "Folder";
                    Object.assign(folderField.style, {
                        width: "120px",
                        minWidth: "0",
                        flexShrink: "0",
                        height: "24px",
                        minHeight: "24px",
                        fontSize: "11px",
                        lineHeight: "1.2",
                        padding: "2px 7px",
                        borderRadius: "5px",
                        background: "var(--comfy-input-bg)",
                        border: "1px solid var(--border-default)",
                        color: "var(--muted-foreground, var(--input-text))",
                        boxSizing: "border-box",
                        opacity: "0.85",
                    });

                    const urlField = document.createElement("input");
                    urlField.type = "text";
                    urlField.readOnly = true;
                    urlField.tabIndex = -1;
                    urlField.value = m.url || "";
                    urlField.placeholder = skipModeActive ? "Search skipped" : "Searching...";
                    Object.assign(urlField.style, {
                        flex: "1",
                        minWidth: "0",
                        width: "100%",
                        height: "24px",
                        minHeight: "24px",
                        fontSize: "11px",
                        lineHeight: "1.2",
                        padding: "2px 7px",
                        borderRadius: "5px",
                        background: "var(--comfy-input-bg)",
                        border: "1px solid var(--border-default)",
                        color: "var(--muted-foreground, var(--input-text))",
                        boxSizing: "border-box",
                        opacity: "0.85",
                    });

                    controlsLine.appendChild(folderField);
                    controlsLine.appendChild(urlField);

                    row.appendChild(topLine);
                    row.appendChild(controlsLine);
                    listEl.appendChild(row);

                    const searchRowEntry = {
                        filename: rawFilename.toLowerCase(),
                        baseFilename: (rawFilename.split("/").pop() || rawFilename).toLowerCase(),
                        displayName: displayName.toLowerCase(),
                        rowSpinner,
                        skipBtn,
                        urlField,
                        row,
                        skipped: skipModeActive,
                    };
                    skipBtn.onclick = (event) => {
                        event.stopPropagation();
                        if (skipBtn.disabled || searchRowEntry.skipped) return;
                        searchRowEntry.skipped = true;
                        skipBtn.disabled = true;
                        skipBtn.title = "Search skipped";
                        rowSpinner.className = "icon-[lucide--x] size-3.5 text-muted-foreground opacity-50";
                        skipXIcon.style.display = "none";
                        if (!urlField.value) {
                            urlField.placeholder = "Search skipped";
                        }
                        row.style.opacity = "0.6";
                        if (typeof onSkipModel === "function") {
                            onSkipModel(rawFilename);
                        }
                    };
                    searchRows.push(searchRowEntry);
                });
            }

            panel.appendChild(headerRow);
            if (!listEl) {
                panel.appendChild(detailEl);
            } else {
                panel.appendChild(listEl);
            }
            panel.appendChild(closeBtn);
            dlg.appendChild(panel);

            cleanupOverlay = mountOverlayInNativeStack(dlg);

            return {
                dlg,
                setStatus: (text) => { statusEl.textContent = text; },
                setDetail: (text) => {
                    if (!listEl && text) {
                        detailEl.textContent = text;
                    }
                },
                setTotalCount: (n) => {
                    const count = Math.max(0, Number(n) || 0);
                    if (count > 0) {
                        countBadge.textContent = String(count);
                        countBadge.style.display = "inline-flex";
                    }
                },
                setActiveModel: (filename, statusText = "") => {
                    const target = String(filename || "").trim().toLowerCase();
                    const targetBase = target ? (target.split("/").pop() || target) : "";
                    for (const sr of searchRows) {
                        if (sr.skipped) continue;
                        const matched = Boolean(
                            target && (
                                sr.filename === target ||
                                sr.baseFilename === targetBase ||
                                sr.displayName === target
                            )
                        );
                        sr.rowSpinner.className = matched
                            ? "hf-skip-spinner pi pi-spinner-dotted pi-spin inline-flex size-3.5 items-center justify-center text-xs leading-none text-warning"
                            : "hf-skip-spinner pi pi-spinner-dotted pi-spin inline-flex size-3.5 items-center justify-center text-xs leading-none text-muted-foreground";
                        if (matched && statusText && !sr.urlField.value) {
                            sr.urlField.placeholder = statusText;
                        }
                    }
                },
                setSkipMode: (active) => {
                    for (const sr of searchRows) {
                        if (!sr.skipped) {
                            sr.skipBtn.disabled = Boolean(active);
                        }
                    }
                },
                cleanup: cleanupOverlay,
                remove: () => {
                    cleanupOverlay();
                    if (dlg.parentElement) dlg.remove();
                }
            };
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
                fontFamily: "var(--font-inter, Inter, sans-serif)",
                transition: "background-color 120ms ease, color 120ms ease",
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

        /* ──────────────── UI Components ──────────────── */
        const getLiveLoaderModelState = (graph = null) => {
            const rootGraph = graph || app?.rootGraph || app?.graph;
            const parts = [];
            let allCombosPopulated = true;
            forEachGraphNodeRecursive(rootGraph, (node) => {
                if (!node || typeof node !== "object") return;
                if (isGraphNodeBypassed(node)) return;
                if (!isLocalModelLoaderNode(node)) return;
                const widgets = Array.isArray(node.widgets) ? node.widgets : [];
                for (const w of widgets) {
                    if (!w || typeof w.value !== "string") continue;
                    if (isDynamicGroupWidgetDisabledInNode(node, w.name)) continue;
                    const opts = resolveComboWidgetOptionsNativeLike(w);
                    const isModelWidget = isModelValidationInputName(w.name) || opts.length > 0;
                    if (!isModelWidget) continue;
                    if (isModelValidationInputName(w.name) && opts.length === 0) {
                        allCombosPopulated = false;
                    }
                    parts.push(`${node.id ?? ""}:${w.name || ""}=${normalizeWorkflowPath(w.value)}`);
                }
            });
            parts.sort();
            return {
                signature: parts.join("|"),
                allCombosPopulated,
            };
        };

        const showResultsDialog = (data, options = {}) => {
            let statusUnsub = null;
            let graphChangeHandler = null;
            let adaptDebounceTimer = null;
            let adaptAbortController = null;
            const stopPolling = () => {
                if (typeof statusUnsub === "function") {
                    try {
                        statusUnsub();
                    } catch (_) {}
                    statusUnsub = null;
                }
            };
            const stopLoaderWatcher = () => {
                if (graphChangeHandler && api && typeof api.removeEventListener === "function") {
                    try {
                        api.removeEventListener("graphChanged", graphChangeHandler);
                    } catch (_) {}
                }
                graphChangeHandler = null;
                if (adaptDebounceTimer) {
                    clearTimeout(adaptDebounceTimer);
                    adaptDebounceTimer = null;
                }
                if (adaptAbortController) {
                    try {
                        adaptAbortController.abort();
                    } catch (_) {}
                    adaptAbortController = null;
                }
            };

            removeExistingAutoDownloadDialog();
            ensureAutoDownloadOverlayControlStyles();

            const dlg = document.createElement("div");
            dlg.id = "auto-download-dialog";
            dlg.setAttribute("data-testid", "hf-model-results-overlay");
            dlg.className = NATIVE_OVERLAY_WRAPPER_CLASS;

            let content = null;
            const rowFolderPickers = [];
            let cleanupOverlayMount = () => {};
            const cleanupUi = () => {
                stopLoaderWatcher();
                while (rowFolderPickers.length) {
                    const picker = rowFolderPickers.pop();
                    try {
                        picker?.destroy?.();
                    } catch (_) {}
                }
                cleanupOverlayMount();
            };

            const closeDialog = (userDismissed = false) => {
                stopPolling();
                cleanupUi();
                if (userDismissed && typeof options?.onUserDismiss === "function") {
                    try {
                        options.onUserDismiss();
                    } catch (_) {}
                }
                if (dlg.parentElement) {
                    dlg.remove();
                }
            };

            const panel = document.createElement("div");
            panel.setAttribute("role", "status");
            applyNativeToasterPanelStyle(panel);

            const headerWrap = document.createElement("div");
            headerWrap.className = "flex w-full items-center gap-2 pr-7";
            headerWrap.style.marginBottom = "2px";

            const countBadge = createMissingCountBadge(0);

            const titleEl = document.createElement("span");
            titleEl.className = "shrink-0 text-foreground";
            Object.assign(titleEl.style, {
                fontSize: "13px",
                fontWeight: "600",
                lineHeight: "1.2",
            });
            titleEl.textContent = "Auto-Download Models";

            const summaryInline = document.createElement("span");
            summaryInline.className = "min-w-0 flex-1 truncate text-muted-foreground";
            summaryInline.style.fontSize = "11px";

            headerWrap.appendChild(countBadge);
            headerWrap.appendChild(titleEl);
            headerWrap.appendChild(summaryInline);
            panel.appendChild(headerWrap);
            panel.appendChild(createNativeOverlayCloseButton("hf-model-results-dismiss", () => closeDialog(true)));

            const rawMissingModels = coalesceMissingEntriesByDestination(
                Array.isArray(data.missing) ? [...data.missing] : []
            );
            const {
                repoFolderMissing: repoFolderMissingModelsRaw,
                curatedMissing: curatedMissingModelsRaw,
                regularMissing: regularMissingModelsRaw
            } = splitMissingModelsForRepoFolderSection(rawMissingModels);

            const repoFolderMissingModels = [...repoFolderMissingModelsRaw];
            repoFolderMissingModels.sort((a, b) => (a.filename || "").localeCompare(b.filename || ""));

            const curatedMissingModels = [...curatedMissingModelsRaw];
            curatedMissingModels.sort((a, b) => (a.filename || "").localeCompare(b.filename || ""));

            const missingModels = [...regularMissingModelsRaw];
            missingModels.sort((a, b) => {
                const aMissing = a.url ? 0 : 1;
                const bMissing = b.url ? 0 : 1;
                if (aMissing !== bMissing) return bMissing - aMissing;
                return (a.filename || "").localeCompare(b.filename || "");
            });

            let mismatchModels = Array.isArray(data.mismatches)
                ? [...data.mismatches]
                : (Array.isArray(data.path_mismatches) ? [...data.path_mismatches] : []);
            const autoMismatchFix = autoApplyPathMismatches(mismatchModels);
            mismatchModels = autoMismatchFix.remaining;
            const frontendMissingCandidates = Array.isArray(options?.frontendMissingModelCandidates)
                ? options.frontendMissingModelCandidates
                : [];

            if (frontendMissingCandidates.length) {
                void applyResolvedFrontendMissingModelState(
                    frontendMissingCandidates,
                    rawMissingModels,
                    mismatchModels
                );
            }

            if (autoMismatchFix.fixedRows > 0) {
                showToast({
                    severity: "info",
                    summary: "Model paths auto-fixed",
                    detail: `Updated ${autoMismatchFix.fixedRefs} loader reference${autoMismatchFix.fixedRefs === 1 ? "" : "s"} to installed model paths.`,
                    life: 3200,
                });
            }

            const totalMissingCount =
                repoFolderMissingModels.length +
                curatedMissingModels.length +
                missingModels.length;

            if (
                options?.triggeredByWorkflowOpen &&
                totalMissingCount === 0 &&
                mismatchModels.length === 0
            ) {
                return;
            }

            if (
                options?.triggeredByRunHook &&
                totalMissingCount === 0 &&
                mismatchModels.length === 0
            ) {
                void clearModelValidationErrorsFromFrontendState();
                showToast({
                    severity: "success",
                    summary: "No downloads needed",
                    detail: autoMismatchFix.fixedRows > 0
                        ? (typeof options?.resumeRun === "function"
                            ? "Resolved path mismatches and resumed the workflow run."
                            : "Resolved path mismatches. Press Run again.")
                        : "All required model files are already available.",
                    life: 3200,
                });
                const resume = options?.resumeRun;
                if (typeof resume === "function") {
                    setTimeout(() => {
                        try {
                            resume();
                        } catch (resumeErr) {
                            console.error("[AutoDownload] Failed to resume run after no-download result:", resumeErr);
                        }
                    }, 0);
                }
                return;
            }

            countBadge.textContent = String(totalMissingCount);
            countBadge.style.display = totalMissingCount > 0 ? "inline-flex" : "none";

            const summaryParts = [];
            if (mismatchModels.length > 0) {
                summaryParts.push(`Mismatches: ${mismatchModels.length}`);
            }
            summaryInline.textContent = summaryParts.join(" • ");

            const listFrame = document.createElement("div");
            listFrame.className = "flex flex-col overflow-hidden";

            content = document.createElement("div");
            content.className = "flex flex-col overflow-y-auto pr-0.5";
            Object.assign(content.style, {
                maxHeight: "min(65vh, 500px)",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
            });
            applyNativeScrollbarClasses(content);
            loadFolderList();

            const makeSectionTitle = (text, color = "") => {
                const sectionTitle = document.createElement("div");
                sectionTitle.textContent = text;
                sectionTitle.className = "font-medium uppercase tracking-wider text-muted-foreground";
                Object.assign(sectionTitle.style, {
                    fontSize: "10px",
                    paddingTop: "4px",
                });
                if (color) {
                    sectionTitle.style.color = color;
                }
                return sectionTitle;
            };

            const makeBaseCard = () => {
                const row = document.createElement("div");
                row.className = "rounded-md border border-solid border-border/60 bg-secondary/40 px-2.5 py-2 flex flex-col gap-1.5";
                return row;
            };

            const applyCompactInputStyle = (inp, horizontalPadding = 7) => {
                Object.assign(inp.style, {
                    width: "100%",
                    minWidth: "0",
                    minHeight: "24px",
                    height: "24px",
                    fontSize: "11px",
                    lineHeight: "1.2",
                    padding: `2px ${horizontalPadding}px`,
                    borderRadius: "5px",
                });
            };

            const rowInputs = [];
            let downloadBtn = null;
            let downloadBtnLabel = null;
            const updateDownloadButtonState = () => {
                if (!downloadBtn || !downloadBtnLabel) return;
                const total = rowInputs.length;
                const checked = rowInputs.filter((r) => r.checkbox.checked).length;
                if (total === 0 || checked === 0) {
                    downloadBtn.disabled = true;
                    downloadBtnLabel.textContent = "Select models to download";
                } else if (checked === total) {
                    downloadBtn.disabled = false;
                    downloadBtnLabel.textContent = total === 1
                        ? "Download model"
                        : `Download all (${total})`;
                } else {
                    downloadBtn.disabled = false;
                    downloadBtnLabel.textContent = checked === 1
                        ? "Download 1 model"
                        : `Download ${checked} of ${total} models`;
                }
            };

            const renderMissingRows = (models, renderOptions = {}) => {
                const isFolderRepoSection = Boolean(renderOptions.isFolderRepoSection);
                models.forEach((m) => {
                    const downloadMode = isFolderRepoSection || isFolderRepoDownloadModel(m) ? "folder" : "file";
                    const displayName = String(m.display_name || m.requested_path || m.filename || "").trim() || "Unknown model";
                    const rowWrapper = document.createElement("div");
                    rowWrapper.setAttribute("data-testid", "hf-model-result-row");
                    Object.assign(rowWrapper.style, {
                        display: "flex",
                        flexDirection: "column",
                        gap: "5px",
                        padding: "0",
                        borderTop: "none",
                    });

                    const topLine = document.createElement("div");
                    Object.assign(topLine.style, {
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                    });

                    const toggleLabel = document.createElement("label");
                    toggleLabel.className = "hf-node-tumbler";
                    toggleLabel.setAttribute("data-testid", "hf-model-toggle");
                    toggleLabel.title = "Include in download";

                    const cb = document.createElement("input");
                    cb.type = "checkbox";
                    cb.checked = Boolean(m.url);
                    cb.setAttribute("aria-label", `Include ${displayName} in download`);
                    cb.addEventListener("change", updateDownloadButtonState);

                    const toggleTrack = document.createElement("span");
                    toggleTrack.className = "hf-node-tumbler-track";
                    toggleTrack.setAttribute("aria-hidden", "true");

                    toggleLabel.appendChild(cb);
                    toggleLabel.appendChild(toggleTrack);

                    const nameEl = document.createElement("div");
                    nameEl.className = "min-w-0 flex-1 truncate text-foreground";
                    Object.assign(nameEl.style, {
                        fontSize: "12px",
                        fontWeight: "500",
                        lineHeight: "1.3",
                    });
                    nameEl.textContent = displayName;
                    nameEl.title = m.node_title ? `${displayName} (${m.node_title})` : displayName;

                    const defaultFolder = String(m.locked_folder || m.suggested_folder || "").trim();
                    const folderPicker = createFolderPicker(defaultFolder, "Folder");
                    rowFolderPickers.push(folderPicker);
                    Object.assign(folderPicker.wrapper.style, {
                        width: "120px",
                        minWidth: "0",
                        flexShrink: "0",
                    });
                    applyCompactInputStyle(folderPicker.input, 7);
                    folderPicker.input.style.paddingRight = "18px";
                    folderPicker.input.setAttribute("data-testid", "hf-model-folder-input");
                    if (downloadMode === "folder") {
                        folderPicker.input.placeholder = "Root";
                    }
                    const preferAuthoritativeFolder = Boolean(m.folder_locked) && downloadMode !== "folder";
                    const updateFolderTooltip = () => {
                        const val = folderPicker.input.value.trim();
                        folderPicker.input.title = val
                            ? `Download folder: ${val} (click to change)`
                            : "Click to choose download folder";
                    };
                    updateFolderTooltip();

                    const locateBtn = document.createElement("button");
                    locateBtn.type = "button";
                    locateBtn.setAttribute("data-testid", "hf-model-locate-node");
                    locateBtn.setAttribute("aria-label", `Locate node${m.node_title ? `: ${m.node_title}` : ""}`);
                    locateBtn.title = m.node_title ? `Locate node: ${m.node_title}` : "Locate node on canvas";
                    locateBtn.className =
                        "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent p-0 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
                    const locateIcon = document.createElement("i");
                    locateIcon.className = "icon-[lucide--locate] size-3.5";
                    locateIcon.setAttribute("aria-hidden", "true");
                    locateBtn.appendChild(locateIcon);
                    locateBtn.onclick = (event) => {
                        event.stopPropagation();
                        locateModelNodeOnCanvas(m);
                    };

                    topLine.appendChild(nameEl);
                    topLine.appendChild(toggleLabel);
                    topLine.appendChild(locateBtn);

                    const controlsLine = document.createElement("div");
                    Object.assign(controlsLine.style, {
                        paddingLeft: "0",
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                    });

                    const urlPlaceholder = downloadMode === "folder"
                        ? "HuggingFace repo/folder URL..."
                        : "HuggingFace URL...";
                    const urlInput = createInput(m.url, urlPlaceholder);
                    applyCompactInputStyle(urlInput, 7);
                    Object.assign(urlInput.style, {
                        flex: "1",
                        minWidth: "0",
                    });

                    controlsLine.appendChild(folderPicker.wrapper);
                    controlsLine.appendChild(urlInput);

                    rowWrapper.appendChild(topLine);
                    rowWrapper.appendChild(controlsLine);

                    const rowData = {
                        rowWrapper,
                        folderPicker,
                        checkbox: cb,
                        displayName,
                        filename: m.filename,
                        originalFilename: m.filename,
                        requestedPath: m.requested_path || m.filename,
                        initialWidgetValue: m.requested_path || m.filename,
                        resolvedUrl: m.url || "",
                        urlInput: urlInput,
                        folderInput: folderPicker.input,
                        nameEl: nameEl,
                        nodeTitle: m.node_title || "Unknown Node",
                        nodeId: m.node_id,
                        downloadMode,
                        skipWorkflowUpdate: downloadMode === "folder",
                        preferAuthoritativeFolder,
                        userEditedFolder: false,
                        folderLocked: false,
                        lockedFolder: "",
                    };
                    const onFolderEdited = () => {
                        rowData.userEditedFolder = true;
                        updateFolderTooltip();
                    };
                    folderPicker.input.addEventListener("input", onFolderEdited);
                    folderPicker.input.addEventListener("change", onFolderEdited);
                    rowInputs.push(rowData);

                    if (downloadMode !== "folder" && Array.isArray(m.alternatives) && m.alternatives.length > 0) {
                        const altToggle = document.createElement("button");
                        altToggle.type = "button";
                        altToggle.textContent = `Alternatives (${m.alternatives.length})`;
                        Object.assign(altToggle.style, {
                            alignSelf: "flex-start",
                            marginLeft: "0",
                            fontSize: "11px",
                            padding: "2px 8px",
                            background: "var(--comfy-input-bg)",
                            color: "var(--input-text)",
                            border: "1px solid var(--border-default)",
                            borderRadius: "5px",
                            cursor: "pointer",
                            fontWeight: "600",
                        });

                        const altList = document.createElement("div");
                        Object.assign(altList.style, {
                            display: "none",
                            marginLeft: "0",
                            background: "var(--comfy-input-bg)",
                            border: "1px solid var(--border-default)",
                            padding: "6px",
                            borderRadius: "6px",
                        });

                        m.alternatives.forEach((alt) => {
                            const altRow = document.createElement("div");
                            Object.assign(altRow.style, {
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: "8px",
                                padding: "4px 0",
                                borderBottom: "1px solid var(--border-default)",
                            });

                            const altLabel = document.createElement("div");
                            altLabel.className = "min-w-0 flex-1 text-2xs text-muted-foreground break-all";
                            altLabel.textContent = `${alt.filename}${alt.source ? " • " + alt.source : ""}`;

                            const useBtn = document.createElement("button");
                            useBtn.type = "button";
                            useBtn.textContent = "Use";
                            Object.assign(useBtn.style, {
                                padding: "2px 8px",
                                background: "var(--comfy-input-bg)",
                                color: "var(--input-text)",
                                border: "1px solid var(--border-default)",
                                borderRadius: "5px",
                                cursor: "pointer",
                                fontSize: "11px",
                                fontWeight: "600",
                                flexShrink: "0",
                            });

                            useBtn.onclick = () => {
                                rowData.filename = alt.filename || rowData.filename;
                                if (alt.url) {
                                    rowData.urlInput.value = alt.url;
                                    rowData.resolvedUrl = alt.url;
                                    cb.checked = true;
                                    updateDownloadButtonState();
                                }
                                if (alt.suggested_folder && !rowData.userEditedFolder && !rowData.preferAuthoritativeFolder) {
                                    rowData.folderInput.value = alt.suggested_folder;
                                    updateFolderTooltip();
                                }
                                rowData.nameEl.textContent = rowData.filename;
                                rowData.nameEl.title = rowData.nodeTitle
                                    ? `${rowData.filename} (${rowData.nodeTitle})`
                                    : rowData.filename;
                            };

                            altRow.appendChild(altLabel);
                            altRow.appendChild(useBtn);
                            altList.appendChild(altRow);
                        });

                        altToggle.onclick = () => {
                            altList.style.display = altList.style.display === "none" ? "block" : "none";
                        };

                        rowWrapper.appendChild(altToggle);
                        rowWrapper.appendChild(altList);
                    }

                    content.appendChild(rowWrapper);
                });
            };

            if (repoFolderMissingModels.length) {
                content.appendChild(makeSectionTitle(FOLDER_REPO_SECTION_TITLE, "#9ec4ff"));
                renderMissingRows(repoFolderMissingModels, { isFolderRepoSection: true });
            }

            if (curatedMissingModels.length) {
                content.appendChild(makeSectionTitle(NODE_CURATED_SECTION_TITLE, "#9ec4ff"));
                renderMissingRows(curatedMissingModels);
            }

            if (!missingModels.length) {
                if (totalMissingCount === 0) {
                    const noMissing = document.createElement("div");
                    noMissing.textContent = "No missing model file links detected.";
                    Object.assign(noMissing.style, {
                        padding: "4px 2px",
                        color: "#58d58c",
                        fontSize: "12px",
                        lineHeight: "1.3",
                    });
                    content.appendChild(noMissing);
                }
            } else {
                renderMissingRows(missingModels);
            }

            if (mismatchModels.length > 0) {
                content.appendChild(makeSectionTitle("Path Mismatches", "#f7b96a"));
                mismatchModels.forEach((m) => {
                    const row = makeBaseCard();

                    const left = document.createElement("div");
                    left.className = "min-w-0 flex flex-col gap-0.5";
                    const currentLabel = m.requested_path || m.filename || "";
                    const foundLabel = m.clean_path || "";
                    const currEl = document.createElement("div");
                    currEl.className = "text-2xs text-muted-foreground break-all";
                    currEl.textContent = `Current: ${currentLabel}`;
                    const foundEl = document.createElement("div");
                    foundEl.className = "text-xs font-medium break-all";
                    foundEl.style.color = "#4caf50";
                    foundEl.textContent = `Found: ${foundLabel}`;
                    left.appendChild(currEl);
                    left.appendChild(foundEl);

                    const btnRow = document.createElement("div");
                    btnRow.className = "flex items-center justify-end gap-1.5";

                    const fixBtn = document.createElement("button");
                    fixBtn.type = "button";
                    fixBtn.textContent = "Use Found Path";
                    Object.assign(fixBtn.style, {
                        padding: "4px 8px",
                        background: "#2f84da",
                        color: "white",
                        border: "none",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontWeight: "600",
                        fontSize: "11px",
                    });

                    fixBtn.onclick = () => {
                        const updated = applyWorkflowPathForModelEntry(m, m.clean_path || "");
                        if (updated <= 0) {
                            alert("Could not find matching model widget to update.");
                            return;
                        }
                        fixBtn.textContent = "Fixed";
                        fixBtn.style.background = "#4caf50";
                        fixBtn.disabled = true;
                        moveBtn.disabled = true;
                        moveBtn.style.opacity = "0.7";
                    };

                    const moveBtn = document.createElement("button");
                    moveBtn.type = "button";
                    moveBtn.textContent = "Move File";
                    Object.assign(moveBtn.style, {
                        padding: "4px 8px",
                        background: "#f2ae42",
                        color: "#111",
                        border: "none",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontWeight: "700",
                        fontSize: "11px",
                    });

                    moveBtn.onclick = async () => {
                        moveBtn.disabled = true;
                        moveBtn.style.opacity = "0.7";
                        moveBtn.textContent = "Moving...";
                        try {
                            const resp = await fetch("/relocate_model_file", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    found_path: m.found_path,
                                    requested_path: m.requested_path || m.filename,
                                    filename: m.filename,
                                    suggested_folder: m.suggested_folder || "checkpoints",
                                }),
                            });
                            const payload = await resp.json().catch(() => ({}));
                            if (resp.status !== 200) {
                                const detail = payload?.error || `Server returned ${resp.status}`;
                                throw new Error(detail);
                            }

                            const nextPath = payload?.clean_path || (m.requested_path || m.filename || "");
                            if (nextPath) {
                                applyWorkflowPathForModelEntry(m, nextPath);
                            }

                            moveBtn.textContent = payload?.status === "already_in_place" ? "Already in place" : "Moved";
                            moveBtn.style.background = "#4caf50";
                            moveBtn.style.color = "#fff";
                            fixBtn.disabled = true;
                            fixBtn.style.opacity = "0.7";

                            if (payload?.to) {
                                currEl.textContent = `Current: ${m.requested_path || m.filename || ""}`;
                                foundEl.textContent = `Found: ${nextPath}`;
                            }
                        } catch (err) {
                            moveBtn.disabled = false;
                            moveBtn.style.opacity = "1";
                            moveBtn.textContent = "Move File";
                            alert(`Move failed: ${err}`);
                        }
                    };

                    btnRow.appendChild(fixBtn);
                    btnRow.appendChild(moveBtn);
                    row.appendChild(left);
                    row.appendChild(btnRow);
                    content.appendChild(row);
                });
            }

            listFrame.appendChild(content);
            panel.appendChild(listFrame);

            const statusLine = document.createElement("div");
            statusLine.className = "text-xs text-muted-foreground pt-0.5";
            statusLine.style.display = "none";
            panel.appendChild(statusLine);

            const setStatus = (msg, color = "") => {
                const text = String(msg || "").trim();
                statusLine.textContent = text;
                statusLine.style.display = text ? "block" : "none";
                statusLine.style.color = color || "";
            };

            const footer = document.createElement("div");
            footer.className = "flex w-full items-center pt-0.5";

            downloadBtn = document.createElement("button");
            downloadBtn.type = "button";
            downloadBtn.setAttribute("data-testid", "hf-download-all-btn");
            downloadBtn.className = `${NATIVE_SECONDARY_BTN_CLASS} w-full justify-center font-medium`;
            Object.assign(downloadBtn.style, {
                width: "100%",
                height: "32px",
                minHeight: "32px",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: "500",
            });
            const downloadBtnIcon = document.createElement("i");
            downloadBtnIcon.className = "icon-[lucide--download] size-4 shrink-0";
            downloadBtnIcon.setAttribute("aria-hidden", "true");
            downloadBtnLabel = document.createElement("span");
            downloadBtnLabel.setAttribute("data-testid", "hf-download-btn-label");
            downloadBtnLabel.className = "truncate";
            downloadBtn.appendChild(downloadBtnIcon);
            downloadBtn.appendChild(downloadBtnLabel);
            updateDownloadButtonState();

            downloadBtn.onclick = async () => {
                const selectedRows = rowInputs.filter((r) => r.checkbox.checked);
                let missingFolderCount = 0;
                for (const r of selectedRows) {
                    const folderVal = r.folderInput.value.trim();
                    if (!folderVal) {
                        r.folderInput.style.border = "1.5px solid #f44336";
                        r.folderInput.style.boxShadow = "0 0 4px #f44336";
                        missingFolderCount += 1;
                    } else {
                        r.folderInput.style.border = "";
                        r.folderInput.style.boxShadow = "";
                    }
                }
                if (missingFolderCount > 0) {
                    setStatus("Please select a target folder for all checked models.", "#f44336");
                    return;
                }
                const toDownload = selectedRows.map((r) => {
                    const effectiveFolder = r.folderInput.value.trim();
                    const item = {
                        filename: r.filename,
                        target_filename: r.filename,
                        display_name: r.displayName || r.requestedPath || r.filename,
                        requested_path: r.requestedPath || r.filename,
                        url: r.urlInput.value.trim(),
                        folder: effectiveFolder,
                        folder_locked: false,
                        locked_folder: "",
                    };
                    if (String(r.downloadMode || "").toLowerCase() === "folder") {
                        item.download_mode = "folder";
                    }
                    return item;
                });

                if (toDownload.length === 0) {
                    alert("No models selected.");
                    return;
                }

                setStatus("Queuing downloads...", "#9ad6ff");
                downloadBtn.disabled = true;
                downloadBtnLabel.textContent = "Queued";

                const queueable = [];
                const queueRows = [];
                for (let i = 0; i < toDownload.length; i += 1) {
                    const item = toDownload[i];
                    const row = selectedRows[i];
                    if (!item.url) {
                        setStatus(`Skipped ${item.filename} (missing URL).`, "#f5b14c");
                        continue;
                    }
                    if (row.downloadMode !== "folder") {
                        const effectiveFilename = resolveDownloadedFilename(row);
                        if (effectiveFilename) {
                            item.filename = effectiveFilename;
                            item.target_filename = effectiveFilename;
                            syncRowFilename(row, effectiveFilename);
                        }
                    }
                    row.resolvedUrl = item.url;
                    queueable.push(item);
                    queueRows.push(row);
                }

                if (!queueable.length) {
                    setStatus("No valid URLs to queue.", "#f5b14c");
                    updateDownloadButtonState();
                    return;
                }

                try {
                    const resp = await fetch("/queue_download", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ models: queueable }),
                    });
                    if (resp.status !== 200) {
                        throw new Error("Server returned " + resp.status + " " + resp.statusText);
                    }
                    const res = await resp.json();
                    const queued = res.queued || [];
                    const downloadIds = queued.map((q) => q.download_id).filter(Boolean);
                    const queueRowsById = new Map();
                    for (let i = 0; i < queued.length; i += 1) {
                        const q = queued[i];
                        const row = queueRows[i];
                        if (q?.download_id && row) {
                            queueRowsById.set(q.download_id, row);
                        }
                    }

                    setStatus(`Queued ${queued.length} download(s). Track progress in the Downloads panel.`, "#9ad6ff");
                    try {
                        window?.hfDownloader?.restoreDownloadPanel?.();
                        window?.hfDownloader?.pollDownloadStatusNow?.();
                    } catch (_) {}
                    cleanupUi();
                    if (dlg.parentElement) {
                        dlg.remove();
                    }

                    const statusMap = {};
                    const pending = new Set(downloadIds);

                    const applyDownloadUpdate = (downloads) => {
                        if (!downloads || typeof downloads !== "object") return;
                        for (const id of downloadIds) {
                            const info = downloads[id];
                            if (!info) continue;
                            const last = statusMap[id];
                            if (last !== info.status) {
                                statusMap[id] = info.status;
                            }
                            if (info.status === "downloaded" || info.status === "completed" || info.status === "failed" || info.status === "cancelled") {
                                pending.delete(id);
                            }
                        }

                        if (pending.size === 0) {
                            stopPolling();
                            let updatedRefs = 0;
                            for (const id of downloadIds) {
                                const info = downloads[id];
                                if (!info || (info.status !== "downloaded" && info.status !== "completed")) continue;
                                const row = queueRowsById.get(id);
                                if (!row) continue;
                                if (row.downloadMode !== "folder") {
                                    const effectiveFilename = resolveDownloadedFilename(row, info);
                                    if (effectiveFilename) {
                                        syncRowFilename(row, effectiveFilename);
                                    }
                                }
                                if (row.skipWorkflowUpdate) {
                                    continue;
                                }
                                updatedRefs += applyDownloadedReferenceToWorkflow(row, info);
                            }

                            if (updatedRefs > 0) {
                                showToast({
                                    severity: "success",
                                    summary: "Workflow updated",
                                    detail: `Updated ${updatedRefs} model reference${updatedRefs === 1 ? "" : "s"} automatically.`,
                                });
                            }
                        }
                    };

                    if (downloadIds.length && api && typeof api.addEventListener === "function") {
                        const onWsStatus = (event) => {
                            applyDownloadUpdate(event?.detail?.downloads);
                        };
                        api.addEventListener("hf_download_status", onWsStatus);
                        statusUnsub = () => {
                            try {
                                api.removeEventListener("hf_download_status", onWsStatus);
                            } catch (_) {}
                        };
                    }
                } catch (e) {
                    setStatus(`Queue error: ${e}`, "#ff6b6b");
                    updateDownloadButtonState();
                }
            };

            footer.appendChild(downloadBtn);
            panel.appendChild(footer);

            dlg.appendChild(panel);
            cleanupOverlayMount = mountOverlayInNativeStack(dlg);
            dlg.__hfOverlayCleanup = cleanupUi;

            let currentBaseSummaryText = summaryInline.textContent;
            const updateSummaryLine = () => {
                countBadge.textContent = String(rowInputs.length);
                countBadge.style.display = rowInputs.length > 0 ? "inline-flex" : "none";
                const parts = [];
                if (mismatchModels.length > 0) {
                    parts.push(`Mismatches: ${mismatchModels.length}`);
                }
                currentBaseSummaryText = parts.join(" • ");
                summaryInline.textContent = currentBaseSummaryText;
            };

            dlg.__hfPruneCompletedModels = (completedPaths = []) => {
                if (!dlg.isConnected) return;
                const list = Array.isArray(completedPaths) ? completedPaths : [completedPaths];
                const completedNames = new Set();
                for (const raw of list) {
                    const normalized = String(raw || "").trim().replace(/\\/g, "/");
                    if (!normalized) continue;
                    completedNames.add(normalized.toLowerCase());
                    const base = normalized.split("/").pop();
                    if (base) completedNames.add(base.toLowerCase());
                }
                if (completedNames.size === 0) return;

                let removed = 0;
                for (let i = rowInputs.length - 1; i >= 0; i -= 1) {
                    const row = rowInputs[i];
                    const candidates = [
                        row.filename,
                        row.requestedPath,
                        row.originalFilename,
                        row.displayName,
                    ]
                        .map((v) => String(v || "").trim().replace(/\\/g, "/"))
                        .filter(Boolean);
                    const matched = candidates.some((c) => {
                        const lower = c.toLowerCase();
                        const base = lower.split("/").pop();
                        return completedNames.has(lower) || (base && completedNames.has(base));
                    });
                    if (!matched) continue;
                    try {
                        row.folderPicker?.destroy?.();
                    } catch (_) {}
                    row.rowWrapper?.remove?.();
                    rowInputs.splice(i, 1);
                    removed += 1;
                }
                if (removed === 0) return;

                if (rowInputs.length === 0 && mismatchModels.length === 0) {
                    closeDialog();
                    return;
                }
                updateSummaryLine();
                updateDownloadButtonState();
            };

            const collectLiveGraphLoaderModelValues = (graph = null) => {
                const rootGraph = graph || app?.rootGraph || app?.graph;
                const referencedNames = new Set();
                const existingSelectedNames = new Set();
                const addNameForms = (targetSet, val) => {
                    const norm = normalizeWorkflowPath(val).toLowerCase();
                    if (!norm) return;
                    targetSet.add(norm);
                    const base = getPathBasename(norm).toLowerCase();
                    if (base) targetSet.add(base);
                };
                forEachGraphNodeRecursive(rootGraph, (node) => {
                    if (!node || typeof node !== "object") return;
                    if (isGraphNodeBypassed(node) || isExcludedDiscoveryNode(node)) return;
                    if (!isLocalModelLoaderNode(node)) return;
                    const widgets = Array.isArray(node.widgets) ? node.widgets : [];
                    for (const w of widgets) {
                        if (!w || typeof w.value !== "string") continue;
                        if (isDynamicGroupWidgetDisabledInNode(node, w.name)) continue;
                        const opts = resolveComboWidgetOptionsNativeLike(w);
                        const isModelWidget = isModelValidationInputName(w.name) || opts.length > 0;
                        if (!isModelWidget) continue;
                        const trimmed = w.value.trim();
                        if (!trimmed) continue;
                        addNameForms(referencedNames, trimmed);
                        if (opts.length > 0 && isValuePresentInComboOptions(opts, trimmed)) {
                            addNameForms(existingSelectedNames, trimmed);
                        }
                    }
                });
                return { referencedNames, existingSelectedNames };
            };

            const collectRowNameForms = (vals = []) => {
                const forms = [];
                for (const raw of vals) {
                    const norm = normalizeWorkflowPath(raw).toLowerCase();
                    if (!norm) continue;
                    forms.push(norm);
                    const base = getPathBasename(norm).toLowerCase();
                    if (base && base !== norm) forms.push(base);
                }
                return forms;
            };

            const dialogLoadGeneration = currentWorkflowLoadGeneration;
            let lastLoaderSignature = getLiveLoaderModelState().signature;
            let adaptInFlight = false;

            const adaptToLoaderModelChange = async (expectedSignature) => {
                if (!dlg.isConnected || dialogLoadGeneration !== currentWorkflowLoadGeneration) {
                    return;
                }
                const workflow = serializeWorkflowForModelScan();
                const liveStateNow = getLiveLoaderModelState();
                if (liveStateNow.signature !== expectedSignature) {
                    return;
                }

                const liveValues = collectLiveGraphLoaderModelValues(app?.rootGraph);
                const localMissing = collectLiveGraphMissingModelCandidatesNativeLike(app?.rootGraph, workflow);
                const localMissingNameSet = new Set();
                for (const c of localMissing) {
                    for (const form of collectRowNameForms([c?.name])) {
                        localMissingNameSet.add(form);
                    }
                }

                let prunedAny = false;
                for (let i = rowInputs.length - 1; i >= 0; i -= 1) {
                    const row = rowInputs[i];
                    const rowForms = collectRowNameForms([
                        row.filename,
                        row.requestedPath,
                        row.originalFilename,
                        row.displayName,
                    ]);
                    if (rowForms.length === 0) continue;
                    const stillInLocalMissing = rowForms.some((f) => localMissingNameSet.has(f));
                    if (stillInLocalMissing) continue;
                    const stillReferenced = rowForms.some((f) => liveValues.referencedNames.has(f));
                    const selectedAsExisting = rowForms.some((f) => liveValues.existingSelectedNames.has(f));
                    if (!stillReferenced || selectedAsExisting) {
                        try {
                            row.folderPicker?.destroy?.();
                        } catch (_) {}
                        row.rowWrapper?.remove?.();
                        rowInputs.splice(i, 1);
                        prunedAny = true;
                    }
                }

                if (prunedAny) {
                    if (rowInputs.length === 0 && mismatchModels.length === 0 && localMissing.length === 0) {
                        void clearMissingModelStoreState([]);
                        void clearModelValidationErrorsFromFrontendState();
                        closeDialog();
                        return;
                    }
                    updateSummaryLine();
                    updateDownloadButtonState();
                }

                const existingRowNameSet = new Set();
                for (const row of rowInputs) {
                    for (const form of collectRowNameForms([
                        row.filename,
                        row.requestedPath,
                        row.originalFilename,
                        row.displayName,
                    ])) {
                        existingRowNameSet.add(form);
                    }
                }
                const hasNewMissing = localMissing.some((c) => {
                    const forms = collectRowNameForms([c?.name]);
                    if (forms.length === 0) return false;
                    return !forms.some((f) => existingRowNameSet.has(f));
                });

                if (!hasNewMissing) {
                    if (rowInputs.length === 0 && mismatchModels.length === 0) {
                        void clearMissingModelStoreState([]);
                        void clearModelValidationErrorsFromFrontendState();
                        closeDialog();
                    }
                    return;
                }

                if (!workflow || typeof workflow !== "object") {
                    return;
                }

                if (adaptAbortController) {
                    try {
                        adaptAbortController.abort();
                    } catch (_) {}
                }
                adaptAbortController = typeof AbortController !== "undefined" ? new AbortController() : null;
                adaptInFlight = true;
                summaryInline.textContent = currentBaseSummaryText
                    ? `${currentBaseSummaryText} • Updating...`
                    : "Updating...";

                try {
                    const reqPayload = {
                        ...workflow,
                        request_id: `adapt_${Date.now()}`,
                        skip_hf_search: false,
                    };
                    const resp = api && typeof api.fetchApi === "function"
                        ? await api.fetchApi("/check_missing_models", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(reqPayload),
                            signal: adaptAbortController?.signal,
                        })
                        : await fetch("/check_missing_models", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(reqPayload),
                            signal: adaptAbortController?.signal,
                        });
                    if (!dlg.isConnected || dialogLoadGeneration !== currentWorkflowLoadGeneration) {
                        return;
                    }
                    if (resp.status !== 200) {
                        summaryInline.textContent = currentBaseSummaryText;
                        return;
                    }
                    const nextData = await resp.json();
                    if (!dlg.isConnected || dialogLoadGeneration !== currentWorkflowLoadGeneration) {
                        return;
                    }
                    if (getLiveLoaderModelState().signature !== expectedSignature) {
                        return;
                    }
                    nextData.missing = coalesceMissingEntriesByDestination(
                        Array.isArray(nextData?.missing) ? nextData.missing : []
                    );
                    const nextRawMismatches = Array.isArray(nextData?.mismatches)
                        ? [...nextData.mismatches]
                        : (Array.isArray(nextData?.path_mismatches) ? [...nextData.path_mismatches] : []);
                    const nextAutoFix = autoApplyPathMismatches(nextRawMismatches);
                    nextData.mismatches = nextAutoFix.remaining;
                    const nextMissingCount = nextData.missing.length;
                    const nextMismatchCount = nextData.mismatches.length;
                    if (nextMissingCount === 0 && nextMismatchCount === 0) {
                        void clearMissingModelStoreState([]);
                        void clearModelValidationErrorsFromFrontendState();
                        closeDialog();
                        return;
                    }
                    void syncResolvedUrlsIntoNativeMissingModelStore(nextData.missing);
                    showResultsDialog(nextData, {
                        ...options,
                        triggeredByLoaderChange: true,
                    });
                } catch (err) {
                    if (err?.name !== "AbortError" && dlg.isConnected) {
                        summaryInline.textContent = currentBaseSummaryText;
                    }
                } finally {
                    adaptInFlight = false;
                }
            };

            graphChangeHandler = () => {
                if (!dlg.isConnected || dialogLoadGeneration !== currentWorkflowLoadGeneration) {
                    stopLoaderWatcher();
                    return;
                }
                if (adaptInFlight) return;
                const currentSig = getLiveLoaderModelState().signature;
                if (currentSig === lastLoaderSignature) return;
                lastLoaderSignature = currentSig;
                if (adaptDebounceTimer) {
                    clearTimeout(adaptDebounceTimer);
                }
                adaptDebounceTimer = setTimeout(() => {
                    adaptDebounceTimer = null;
                    void adaptToLoaderModelChange(currentSig);
                }, 250);
            };
            if (api && typeof api.addEventListener === "function") {
                api.addEventListener("graphChanged", graphChangeHandler);
            }

            if (!options?.triggeredByWorkflowOpen && !options?.triggeredByLoaderChange) {
                setTimeout(() => {
                    const firstUrlInput = dlg.querySelector(
                        "input[placeholder='HuggingFace URL...'], input[placeholder='HuggingFace repo/folder URL...']"
                    );
                    if (firstUrlInput) {
                        firstUrlInput.focus();
                        firstUrlInput.select();
                    }
                }, 0);
            }
        };

        const showManualDownloadDialog = () => {
            showUnifiedImportModelDialog({
                initialMode: "url",
                onSuccess: () => {
                    try {
                        window?.hfDownloader?.refreshModelExplorer?.();
                    } catch (_) {}
                },
            });
        };

        let currentWorkflowLoadGeneration = 0;
        let activeAutoDownloadCancel = null;
        let lastObservedActiveWorkflowKey = "";

        const abortActiveAutoDownloadForTabSwitch = () => {
            if (typeof activeAutoDownloadCancel === "function") {
                try {
                    activeAutoDownloadCancel();
                } catch (_) {}
                activeAutoDownloadCancel = null;
            }
            removeExistingAutoDownloadDialog();
        };

        const runAutoDownload = async (skippedFilenames = new Set(), skipAllUnresolved = false, options = {}) => {
            if (typeof activeAutoDownloadCancel === "function") {
                try {
                    activeAutoDownloadCancel();
                } catch (_) {}
                activeAutoDownloadCancel = null;
            }
            const myLoadGeneration = currentWorkflowLoadGeneration;
            let loadingDlg = null;
            let aborted = false;
            let skipRequested = false;
            let searchStatusUnsub = null;
            let currentSearchingFilename = "";
            const requestId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;

            const resolveBaseUrl = () => {
                const path = window.location.pathname || "/";
                const basePath = path.endsWith("/") ? path : path.replace(/\/[^/]*$/, "/");
                return window.location.origin + basePath;
            };

            const doFetch = async (path, fetchOptions = {}) => {
                const method = String(fetchOptions.method || "GET").toUpperCase();
                if (method === "GET" && api && typeof api.fetchApi === "function") {
                    let apiPath = String(path || "");
                    if (!apiPath.startsWith("/")) apiPath = "/" + apiPath;
                    return api.fetchApi(apiPath, fetchOptions);
                }
                const baseUrl = resolveBaseUrl();
                const relPath = String(path || "").replace(/^\/+/, "");
                const url = new URL(relPath, baseUrl).toString();
                return fetch(url, {
                    ...fetchOptions,
                    headers: {
                        "Content-Type": "application/json",
                        ...(fetchOptions.headers || {})
                    }
                });
            };

            const resumeRunIfPossible = async () => {
                const resume = options?.resumeRun;
                if (typeof resume !== "function") {
                    return;
                }
                if (app && typeof app.refreshComboInNodes === "function") {
                    try {
                        await app.refreshComboInNodes();
                    } catch (e) {}
                }
                try {
                    resume();
                } catch (resumeErr) {
                    console.error("[AutoDownload] Failed to resume run after scan:", resumeErr);
                }
            };

            const controller = new AbortController();
            const cleanupSearchListener = () => {
                if (typeof searchStatusUnsub === "function") {
                    try {
                        searchStatusUnsub();
                    } catch (_) {}
                    searchStatusUnsub = null;
                }
            };
            const cancelCurrentScan = () => {
                if (aborted) return;
                aborted = true;
                skipRequested = false;
                cleanupSearchListener();
                try {
                    controller.abort();
                } catch (_) {}
                doFetch(`/cancel_search`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ request_id: requestId })
                }).catch(err => console.error("[AutoDownload] Cancel search request failed:", err));
                if (loadingDlg) {
                    try {
                        loadingDlg.cleanup();
                        loadingDlg.remove();
                    } catch (_) {}
                }
            };
            activeAutoDownloadCancel = cancelCurrentScan;

            try {
                let initialWorkflow = null;
                let initialModels = [];
                try {
                    initialWorkflow = serializeWorkflowForModelScan();
                    const rawInitialCandidates = (
                        Array.isArray(options?.frontendMissingModelCandidates) &&
                        options.frontendMissingModelCandidates.length
                    )
                        ? options.frontendMissingModelCandidates
                        : (() => {
                            const liveCandidates = initialWorkflow && typeof initialWorkflow === "object"
                                ? collectLiveGraphMissingModelCandidatesNativeLike(app?.rootGraph, initialWorkflow)
                                : [];
                            if (liveCandidates.length) return liveCandidates;
                            return Array.isArray(cachedNativeMissingCandidates) && cachedNativeMissingCandidates.length
                                ? cachedNativeMissingCandidates
                                : [];
                        })();
                    if (Array.isArray(rawInitialCandidates) && rawInitialCandidates.length) {
                        initialModels = coalesceMissingEntriesByDestination(
                            rawInitialCandidates
                                .filter((entry) => Boolean(entry && (entry.filename || entry.name)))
                                .map((entry) => ({
                                    ...entry,
                                    filename: entry?.filename || entry?.name || "",
                                    suggested_folder: entry?.suggested_folder || entry?.directory || entry?.folder || "",
                                }))
                        );
                    }
                } catch (_) {
                    initialModels = [];
                }

                // Show loading dialog immediately
                loadingDlg = showLoadingDialog((targetFilename) => {
                    const skipName = String(targetFilename || currentSearchingFilename || "").trim();
                    if (!skipName) return;
                    skippedFilenames.add(skipName.toLowerCase());
                    const baseSkip = skipName.split("/").pop();
                    if (baseSkip) {
                        skippedFilenames.add(baseSkip.toLowerCase());
                    }
                    doFetch(`/skip_search_model`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ request_id: requestId, filename: skipName })
                    }).catch(err => console.error("[AutoDownload] Skip model request failed:", err));
                }, {
                    skipModeActive: skipAllUnresolved,
                    initialModels,
                    onClose: cancelCurrentScan
                });

                loadingDlg.setStatus(skipAllUnresolved ? "Skipping unresolved..." : "Searching...");

                const applySearchStatusPayload = (statusData) => {
                    if (aborted || myLoadGeneration !== currentWorkflowLoadGeneration || !loadingDlg) return;
                    if (!statusData || typeof statusData !== "object") return;
                    if (statusData.request_id && statusData.request_id !== requestId) return;
                    const status = statusData.status || statusData;
                    if (!status || typeof status !== "object") return;
                    const source = String(status.source || "").trim();
                    const filename = String(status.filename || "").trim();
                    const detailRaw = String(status.detail || "").trim();
                    let message = String(status.message || "").trim();

                    if (filename) {
                        currentSearchingFilename = filename;
                    }

                    let displayMessage = message;
                    let displayDetail = "";

                    if (status.current_index && status.total_files) {
                        const idx = status.current_index;
                        const total = status.total_files;
                        const fn = filename || "model";
                        const node = status.node_label || "";
                        displayMessage = `Searching model ${idx} of ${total}`;
                        displayDetail = node ? `"${fn}" in ${node}` : `"${fn}"`;
                    } else {
                        const sourceLabelMap = {
                            workflow: "Scanning workflow",
                            popular_models: "Checking curated model list",
                            manager_cache: "Checking manager cache",
                            huggingface_search: "Searching Hugging Face",
                            huggingface_fulltext: "Searching by file name",
                            huggingface_priority_authors: "Searching priority authors",
                            huggingface_priority_repos: "Searching priority repos",
                            huggingface_skip: "Skipping unresolved Hugging Face lookups",
                            complete: "Scan complete"
                        };

                        const sourceLabel = sourceLabelMap[source] || (
                            source
                                ? source.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
                                : ""
                        );

                        if (!displayMessage) {
                            displayMessage = sourceLabel || "Looking for links...";
                        }

                        const detailParts = [];
                        if (filename) {
                            detailParts.push(filename);
                        }
                        if (detailRaw) {
                            detailParts.push(detailRaw);
                        }
                        if (sourceLabel && !displayMessage.toLowerCase().includes(sourceLabel.toLowerCase())) {
                            detailParts.push(sourceLabel);
                        }
                        displayDetail = detailParts.length ? detailParts.join(" • ") : "Working...";
                    }

                    loadingDlg.setStatus(displayMessage);
                    loadingDlg.setDetail(displayDetail);
                    if (status.total_files) {
                        loadingDlg.setTotalCount(status.total_files);
                    }
                    if (filename) {
                        loadingDlg.setActiveModel(filename, displayDetail || displayMessage);
                    }
                };
                if (api && typeof api.addEventListener === "function") {
                    const onWsSearchStatus = (event) => {
                        applySearchStatusPayload(event?.detail);
                    };
                    api.addEventListener("hf_search_status", onWsSearchStatus);
                    searchStatusUnsub = () => {
                        try {
                            api.removeEventListener("hf_search_status", onWsSearchStatus);
                        } catch (_) {}
                    };
                }

                const workflow = initialWorkflow || serializeWorkflowForModelScan();
                if (!workflow || typeof workflow !== "object") {
                    throw new Error("Workflow is not ready for missing-model scan.");
                }
                console.log("[AutoDownload] Scanning workflow:", workflow);

                const frontendStoreFallbackMissing =
                    await createRunHookFallbackMissingModelsFromFrontendStore(
                        Array.isArray(options?.frontendMissingModelCandidates)
                            ? options.frontendMissingModelCandidates
                            : null
                    );
                if (aborted || myLoadGeneration !== currentWorkflowLoadGeneration) {
                    cancelCurrentScan();
                    return;
                }
                if (frontendStoreFallbackMissing.length) {
                    loadingDlg.setStatus("Resolving links...");
                    loadingDlg.setDetail("Checking curated model registry for native missing-model candidates.");
                    const enrichedFastPathResults = await enrichMissingEntriesViaBackend(
                        frontendStoreFallbackMissing,
                        {
                            workflow,
                            requestId,
                            skipHfSearch: skipAllUnresolved,
                            signal: controller.signal
                        }
                    );
                    if (loadingDlg) {
                        cleanupSearchListener();
                        loadingDlg.cleanup();
                        loadingDlg.remove();
                    }
                    if (
                        aborted ||
                        myLoadGeneration !== currentWorkflowLoadGeneration ||
                        enrichedFastPathResults?.cancelled ||
                        enrichedFastPathResults?.status === "cancelled"
                    ) {
                        return;
                    }
                    console.info(
                        "[AutoDownload] Using frontend missing-model store fast path:",
                        frontendStoreFallbackMissing
                    );
                    const fastPathPayload = enrichedFastPathResults && typeof enrichedFastPathResults === "object"
                        ? enrichedFastPathResults
                        : {
                            request_id: requestId,
                            missing: frontendStoreFallbackMissing,
                            found: [],
                            mismatches: []
                        };
                    void syncResolvedUrlsIntoNativeMissingModelStore(fastPathPayload.missing || []);
                    showResultsDialog(fastPathPayload, options || {});
                    return;
                }

                // Call backend
                const resp = await doFetch("/check_missing_models", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        ...workflow,
                        request_id: requestId,
                        skip_filenames: Array.from(skippedFilenames),
                        skip_hf_search: skipAllUnresolved
                    }),
                    signal: controller.signal
                });

                if (aborted || myLoadGeneration !== currentWorkflowLoadGeneration) {
                    cancelCurrentScan();
                    return;
                }

                // Remove loading dialog
                if (loadingDlg) {
                    cleanupSearchListener();
                    loadingDlg.cleanup();
                    loadingDlg.remove();
                }

                if (resp.status !== 200) {
                    let detail = resp.statusText;
                    try {
                        const bodyText = await resp.text();
                        if (bodyText) detail = bodyText;
                    } catch (e) {
                        // ignore
                    }
                    throw new Error("Failed to scan models: " + detail + " (" + resp.status + ")");
                }
                const data = await resp.json();
                if (
                    aborted ||
                    myLoadGeneration !== currentWorkflowLoadGeneration ||
                    data?.cancelled ||
                    data?.status === "cancelled"
                ) {
                    return;
                }
                data.missing = coalesceMissingEntriesByDestination(
                    Array.isArray(data?.missing) ? data.missing : []
                );
                console.log("[AutoDownload] Scan results:", data);

                const filterOutBackendFoundAndMismatchedModels = (entries, scanData) => {
                    if (!Array.isArray(entries) || !entries.length) return [];
                    const resolvedNames = new Set();
                    const addResolved = (val) => {
                        const norm = normalizeWorkflowPath(val).toLowerCase();
                        if (!norm) return;
                        resolvedNames.add(norm);
                        const base = getPathBasename(norm).toLowerCase();
                        if (base) resolvedNames.add(base);
                    };
                    const foundItems = Array.isArray(scanData?.found) ? scanData.found : [];
                    for (const item of foundItems) {
                        addResolved(item?.filename);
                        addResolved(item?.name);
                        addResolved(item?.requested_path);
                        addResolved(item?.clean_path);
                    }
                    const mismatchItems = Array.isArray(scanData?.mismatches)
                        ? scanData.mismatches
                        : (Array.isArray(scanData?.path_mismatches) ? scanData.path_mismatches : []);
                    for (const item of mismatchItems) {
                        addResolved(item?.filename);
                        addResolved(item?.name);
                        addResolved(item?.requested_path);
                        addResolved(item?.clean_path);
                    }
                    if (!resolvedNames.size) return entries;
                    return entries.filter((entry) => {
                        const fn = normalizeWorkflowPath(entry?.filename || entry?.name || "").toLowerCase();
                        const req = normalizeWorkflowPath(entry?.requested_path || "").toLowerCase();
                        const base = getPathBasename(fn || req).toLowerCase();
                        if (fn && resolvedNames.has(fn)) return false;
                        if (req && resolvedNames.has(req)) return false;
                        if (base && resolvedNames.has(base)) return false;
                        return true;
                    });
                };

                if (!countActionableScanResults(data)) {
                    const fallbackFromStoreRaw = await createRunHookFallbackMissingModelsFromFrontendStore(
                        Array.isArray(options?.frontendMissingModelCandidates)
                            ? options.frontendMissingModelCandidates
                            : null
                    );
                    if (aborted || myLoadGeneration !== currentWorkflowLoadGeneration) {
                        return;
                    }
                    const fallbackMissingFromFrontendStore = filterOutBackendFoundAndMismatchedModels(
                        fallbackFromStoreRaw,
                        data
                    );
                    if (fallbackMissingFromFrontendStore.length) {
                        data.missing = mergeMissingEntries(data?.missing, fallbackMissingFromFrontendStore);
                        console.info(
                            "[AutoDownload] Recovered actionable models from frontend missing-model store:",
                            fallbackMissingFromFrontendStore
                        );
                    }
                }

                const suppressEmptyResults = Boolean(options?.suppressEmptyResults);
                if (suppressEmptyResults) {
                    const fallbackMissingFromFailures = filterOutBackendFoundAndMismatchedModels(
                        createRunHookFallbackMissingModels(options?.runHookFailures || [], workflow),
                        data
                    );
                    const fallbackStoreRaw2 = await createRunHookFallbackMissingModelsFromFrontendStore(
                        Array.isArray(options?.frontendMissingModelCandidates)
                            ? options.frontendMissingModelCandidates
                            : null
                    );
                    if (aborted || myLoadGeneration !== currentWorkflowLoadGeneration) {
                        return;
                    }
                    const fallbackMissingFromFrontendStore = filterOutBackendFoundAndMismatchedModels(
                        fallbackStoreRaw2,
                        data
                    );
                    if (fallbackMissingFromFailures.length) {
                        const existingMissing = Array.isArray(data?.missing) ? data.missing : [];
                        data.missing = mergeMissingEntries(existingMissing, fallbackMissingFromFailures);
                    }
                    if (fallbackMissingFromFrontendStore.length) {
                        const existingMissing = Array.isArray(data?.missing) ? data.missing : [];
                        data.missing = mergeMissingEntries(existingMissing, fallbackMissingFromFrontendStore);
                    }

                    const split = splitMissingModelsForRepoFolderSection(
                        Array.isArray(data?.missing) ? data.missing : [],
                        getNodeErrorsSnapshot()
                    );
                    let totalMissing =
                        (Array.isArray(split?.repoFolderMissing) ? split.repoFolderMissing.length : 0) +
                        (Array.isArray(split?.curatedMissing) ? split.curatedMissing.length : 0) +
                        (Array.isArray(split?.regularMissing) ? split.regularMissing.length : 0);
                    const foundCount = Array.isArray(data?.found) ? data.found.length : 0;
                    let mismatchCount = Array.isArray(data?.mismatches)
                        ? data.mismatches.length
                        : (Array.isArray(data?.path_mismatches) ? data.path_mismatches.length : 0);
                    let hasAnyResults = totalMissing > 0 || foundCount > 0 || mismatchCount > 0;

                    if (!hasAnyResults) {
                        const lastChanceMissing = filterOutBackendFoundAndMismatchedModels(
                            createLastChanceRunHookMissingModels(
                                options?.runHookFailures || [],
                                workflow
                            ),
                            data
                        );
                        if (lastChanceMissing.length) {
                            const existingMissing = Array.isArray(data?.missing) ? data.missing : [];
                            data.missing = mergeMissingEntries(existingMissing, lastChanceMissing);
                            const recoveredSplit = splitMissingModelsForRepoFolderSection(
                                data.missing,
                                getNodeErrorsSnapshot()
                            );
                            totalMissing =
                                (Array.isArray(recoveredSplit?.repoFolderMissing) ? recoveredSplit.repoFolderMissing.length : 0) +
                                (Array.isArray(recoveredSplit?.curatedMissing) ? recoveredSplit.curatedMissing.length : 0) +
                                (Array.isArray(recoveredSplit?.regularMissing) ? recoveredSplit.regularMissing.length : 0);
                            mismatchCount = Array.isArray(data?.mismatches)
                                ? data.mismatches.length
                                : (Array.isArray(data?.path_mismatches) ? data.path_mismatches.length : 0);
                            hasAnyResults = totalMissing > 0 || foundCount > 0 || mismatchCount > 0;
                            console.info(
                                "[AutoDownload] Recovered actionable models from last-chance run-hook fallback:",
                                lastChanceMissing
                            );
                        }
                    }

                    if (!hasAnyResults) {
                        const emptyDetail = options?.triggeredByWorkflowOpen
                            ? "Workflow-open missing-model scan reported candidates, but the scan returned no actionable models."
                            : "Run hook detected missing-model signals, but scan returned no actionable models.";
                        showToast({
                            severity: "warn",
                            summary: "Auto-download skipped",
                            detail: emptyDetail,
                            life: 4200
                        });
                        resumeRunIfPossible();
                        return;
                    }
                }

                // Show results
                data.missing = coalesceMissingEntriesByDestination(
                    Array.isArray(data?.missing) ? data.missing : []
                );
                if (
                    aborted ||
                    myLoadGeneration !== currentWorkflowLoadGeneration ||
                    data?.cancelled ||
                    data?.status === "cancelled"
                ) {
                    return;
                }
                void syncResolvedUrlsIntoNativeMissingModelStore(
                    Array.isArray(data?.missing) ? data.missing : []
                );
                if (Boolean(options?.suppressEmptyResults) && countDownloadRequiredScanResults(data) <= 0) {
                    if (Array.isArray(options?.frontendMissingModelCandidates) && options.frontendMissingModelCandidates.length) {
                        void applyResolvedFrontendMissingModelState(
                            options.frontendMissingModelCandidates,
                            Array.isArray(data?.missing) ? data.missing : [],
                            Array.isArray(data?.mismatches)
                                ? data.mismatches
                                : (Array.isArray(data?.path_mismatches) ? data.path_mismatches : [])
                        );
                    }
                    resumeRunIfPossible();
                    return;
                }
                showResultsDialog(data, options || {});

            } catch (e) {
                // Remove loading dialog on error
                cleanupSearchListener();
                if (loadingDlg) {
                    loadingDlg.cleanup();
                    if (aborted || (e && e.name === "AbortError")) {
                        if (skipRequested && !skipAllUnresolved) {
                            skipRequested = false;
                            aborted = false;
                            loadingDlg.remove();
                            // Restart scan and skip unresolved Hugging Face lookups.
                            setTimeout(() => {
                                runAutoDownload(skippedFilenames, true, options);
                            }, 0);
                            return;
                        }
                        loadingDlg.remove();
                        return;
                    }
                    loadingDlg.remove();
                }
                if (
                    aborted ||
                    myLoadGeneration !== currentWorkflowLoadGeneration ||
                    (e && e.name === "AbortError")
                ) {
                    return;
                }
                console.error("[AutoDownload] Error:", e);
                alert("Error: " + e);
            } finally {
                if (activeAutoDownloadCancel === cancelCurrentScan) {
                    activeAutoDownloadCancel = null;
                }
            }
        };

        const MISSING_MODELS_LIST_SELECTOR = ".comfy-missing-models";
        const MISSING_MODELS_BUTTON_CLASS = "hf-auto-search-download-missing-btn";
        let missingModelsObserver = null;

        const injectMissingModelsActionButton = (listbox) => {
            if (!listbox || !(listbox instanceof Element) || !listbox.parentElement) return;

            const parent = listbox.parentElement;
            if (parent.querySelector(`.${MISSING_MODELS_BUTTON_CLASS}`)) return;

            const buttonWrap = document.createElement("div");
            buttonWrap.className = MISSING_MODELS_BUTTON_CLASS;
            Object.assign(buttonWrap.style, {
                marginBottom: "12px",
                display: "flex",
                justifyContent: "center"
            });

            const actionBtn = document.createElement("button");
            actionBtn.type = "button";
            actionBtn.className = NATIVE_SECONDARY_BTN_CLASS;
            actionBtn.textContent = "Auto-search and download missing models";

            actionBtn.onclick = (event) => {
                event.preventDefault();
                event.stopPropagation();

                const runAction = window?.hfDownloader?.runAutoDownload;
                if (typeof runAction !== "function") {
                    showToast({
                        severity: "warn",
                        summary: "Action unavailable",
                        detail: "Auto-download tool is not ready yet."
                    });
                    return;
                }

                actionBtn.disabled = true;
                actionBtn.textContent = "Starting...";
                try {
                    runAction();
                } catch (err) {
                    console.error("[AutoDownload] Failed to start auto-download from missing models dialog:", err);
                    showToast({
                        severity: "error",
                        summary: "Failed to start",
                        detail: String(err)
                    });
                } finally {
                    setTimeout(() => {
                        if (!actionBtn.isConnected) return;
                        actionBtn.disabled = false;
                        actionBtn.textContent = "Auto-search and download missing models";
                    }, 1000);
                }
            };

            buttonWrap.appendChild(actionBtn);
            parent.insertBefore(buttonWrap, listbox);
        };

        const NATIVE_DOWNLOAD_TO_COMFY_ATTR = "data-hf-download-to-comfy";
        const NATIVE_SPLIT_BTN_PART_CLASS =
            "bg-secondary text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50";
        const NATIVE_SPLIT_MENU_CONTAINER_CLASS =
            "z-3000 min-w-44 overflow-y-auto rounded-lg border border-solid border-border bg-background p-1 text-foreground shadow-lg outline-none";
        const NATIVE_SPLIT_MENU_ITEM_CLASS =
            "group flex min-h-8 w-full cursor-pointer appearance-none items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1 text-left font-inter text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";
        let cachedNativeMissingCandidates = [];
        let activeNativeSplitDropdown = null;

        const closeNativeSplitDropdown = () => {
            if (!activeNativeSplitDropdown) return;
            const current = activeNativeSplitDropdown;
            activeNativeSplitDropdown = null;
            try {
                current.cleanup?.();
            } catch (_) {}
            try {
                if (current.triggerBtn) {
                    current.triggerBtn.removeAttribute("data-state");
                    current.triggerBtn.setAttribute("aria-expanded", "false");
                }
            } catch (_) {}
            try {
                current.menu?.remove?.();
            } catch (_) {}
        };

        const openNativeSplitDropdown = (anchorEl, triggerBtn, options = {}) => {
            if (!anchorEl || !triggerBtn) return;
            if (activeNativeSplitDropdown?.triggerBtn === triggerBtn) {
                closeNativeSplitDropdown();
                return;
            }
            closeNativeSplitDropdown();

            const menu = document.createElement("div");
            menu.setAttribute("role", "menu");
            menu.setAttribute("data-testid", "hf-native-split-menu");
            menu.className = NATIVE_SPLIT_MENU_CONTAINER_CLASS;
            Object.assign(menu.style, {
                position: "fixed",
                top: "0px",
                left: "0px",
                zIndex: "10050",
            });

            const addMenuItem = (label, iconClass, disabled, onSelect) => {
                const item = document.createElement("button");
                item.type = "button";
                item.setAttribute("role", "menuitem");
                item.className = NATIVE_SPLIT_MENU_ITEM_CLASS;
                item.disabled = Boolean(disabled);
                const icon = document.createElement("i");
                icon.className = `${iconClass} size-3.5 shrink-0 text-muted-foreground`;
                icon.setAttribute("aria-hidden", "true");
                const text = document.createElement("span");
                text.className = "truncate";
                text.textContent = label;
                item.appendChild(icon);
                item.appendChild(text);
                item.addEventListener("click", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    closeNativeSplitDropdown();
                    if (typeof onSelect === "function") {
                        onSelect();
                    }
                });
                menu.appendChild(item);
            };

            addMenuItem(
                "Download to Comfy",
                "icon-[lucide--hard-drive-download]",
                Boolean(options.comfyDisabled),
                options.onComfyDownload
            );
            addMenuItem(
                "Download to browser",
                "icon-[lucide--globe]",
                Boolean(options.browserDisabled),
                options.onBrowserDownload
            );

            (document.body || document.documentElement).appendChild(menu);

            const positionMenu = () => {
                if (!anchorEl.isConnected || !triggerBtn.isConnected || !menu.isConnected) {
                    closeNativeSplitDropdown();
                    return;
                }
                const rect = anchorEl.getBoundingClientRect();
                const menuRect = menu.getBoundingClientRect();
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const left = Math.max(8, Math.min(rect.right - menuRect.width, vw - menuRect.width - 8));
                const spaceBelow = vh - rect.bottom - 8;
                const spaceAbove = rect.top - 8;
                const top =
                    spaceBelow >= menuRect.height || spaceBelow >= spaceAbove
                        ? Math.min(rect.bottom + 4, vh - menuRect.height - 8)
                        : Math.max(8, rect.top - menuRect.height - 4);
                menu.style.left = `${Math.round(left)}px`;
                menu.style.top = `${Math.round(top)}px`;
            };

            positionMenu();
            triggerBtn.setAttribute("data-state", "open");
            triggerBtn.setAttribute("aria-expanded", "true");

            const onDocPointerDown = (event) => {
                const target = event?.target;
                if (target instanceof Node && (menu.contains(target) || triggerBtn.contains(target))) {
                    return;
                }
                closeNativeSplitDropdown();
            };
            const onDocKeyDown = (event) => {
                if (event.key === "Escape") {
                    event.stopPropagation();
                    closeNativeSplitDropdown();
                }
            };
            const onWindowReposition = () => {
                positionMenu();
            };

            document.addEventListener("pointerdown", onDocPointerDown, true);
            document.addEventListener("keydown", onDocKeyDown, true);
            window.addEventListener("scroll", onWindowReposition, true);
            window.addEventListener("resize", onWindowReposition);

            activeNativeSplitDropdown = {
                menu,
                triggerBtn,
                cleanup: () => {
                    document.removeEventListener("pointerdown", onDocPointerDown, true);
                    document.removeEventListener("keydown", onDocKeyDown, true);
                    window.removeEventListener("scroll", onWindowReposition, true);
                    window.removeEventListener("resize", onWindowReposition);
                },
            };
        };

        const ensureNativeSidebarStyles = () => {
            if (document.getElementById("hf-native-sidebar-styles")) return;
            const style = document.createElement("style");
            style.id = "hf-native-sidebar-styles";
            style.textContent = `
                .hf-native-hidden-download {
                    display: none !important;
                }
                .hf-native-split-group {
                    display: inline-flex;
                    align-items: stretch;
                    height: 32px;
                    border-radius: 8px;
                    overflow: hidden;
                    flex-shrink: 0;
                }
                .hf-native-split-group-all {
                    width: 100%;
                    flex: 1 1 0%;
                    min-width: 0;
                    border-radius: 6px;
                }
                .hf-native-split-main,
                .hf-native-split-chevron {
                    appearance: none;
                    border: none;
                    margin: 0;
                    cursor: pointer;
                    font-family: var(--font-inter, Inter, sans-serif);
                    font-size: 12px;
                    font-weight: 400;
                    line-height: 1;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                    transition: background-color 150ms ease, color 150ms ease, opacity 150ms ease;
                }
                .hf-native-split-main {
                    padding: 0 10px;
                    white-space: nowrap;
                    min-width: 0;
                }
                .hf-native-split-group-all .hf-native-split-main {
                    flex: 1 1 0%;
                    padding: 0 12px;
                }
                .hf-native-split-chevron {
                    width: 22px;
                    padding: 0;
                    flex-shrink: 0;
                    border-left: 1px solid color-mix(in srgb, var(--border-default, rgba(255, 255, 255, 0.14)) 70%, transparent);
                }
                .hf-native-split-chevron[data-state="open"] i {
                    rotate: 180deg;
                }
            `;
            (document.head || document.documentElement).appendChild(style);
        };

        const formatNativeByteSize = (bytes) => {
            const val = Number(bytes);
            if (!Number.isFinite(val) || val <= 0) return "";
            const units = ["B", "KB", "MB", "GB", "TB"];
            let idx = 0;
            let scaled = val;
            while (scaled >= 1024 && idx < units.length - 1) {
                scaled /= 1024;
                idx += 1;
            }
            return `${scaled.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
        };

        const setNativeMainButtonLabel = (btnEl, text) => {
            if (!btnEl) return;
            const span = btnEl.querySelector("[data-hf-label]");
            if (span) {
                span.textContent = text;
            } else {
                btnEl.textContent = text;
            }
        };

        const triggerBrowserDownloadForItems = (items = [], nativeBtn = null) => {
            if (nativeBtn && typeof nativeBtn.click === "function") {
                nativeBtn.click();
                return;
            }
            const valid = (Array.isArray(items) ? items : []).filter((item) => item && String(item.url || "").trim());
            if (!valid.length) {
                showToast({
                    severity: "warn",
                    summary: "No download URL",
                    detail: "No resolved link found in catalog for this model yet.",
                    life: 3500
                });
                return;
            }
            for (const item of valid) {
                const a = document.createElement("a");
                a.href = item.url;
                a.download = item.filename || "";
                a.target = "_blank";
                a.rel = "noopener noreferrer";
                a.style.display = "none";
                document.body.appendChild(a);
                a.click();
                a.remove();
            }
        };

        const queueModelsToComfyBackend = async (modelsToQueue, btnEl, defaultLabel) => {
            const validItems = (Array.isArray(modelsToQueue) ? modelsToQueue : []).filter(
                (item) => item && String(item.url || "").trim()
            );
            if (!validItems.length) {
                showToast({
                    severity: "warn",
                    summary: "No download URL",
                    detail: "No resolved link found in catalog for this model yet.",
                    life: 3500
                });
                return;
            }
            if (btnEl) {
                btnEl.disabled = true;
                setNativeMainButtonLabel(btnEl, "Queuing...");
            }
            try {
                const resp = await fetch("/queue_download", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ models: validItems }),
                });
                if (resp.status !== 200) {
                    let detail = resp.statusText;
                    try {
                        const errText = await resp.text();
                        if (errText) detail = errText;
                    } catch (_) {}
                    throw new Error(`Server returned ${resp.status}: ${detail}`);
                }
                const res = await resp.json();
                const queuedCount = Array.isArray(res?.queued) ? res.queued.length : validItems.length;
                try {
                    window?.hfDownloader?.restoreDownloadPanel?.();
                    window?.hfDownloader?.pollDownloadStatusNow?.();
                } catch (_) {}
                if (btnEl) {
                    setNativeMainButtonLabel(btnEl, validItems.length > 1 ? `Queued (${queuedCount})` : "Queued");
                    setTimeout(() => {
                        if (!btnEl.isConnected) return;
                        btnEl.disabled = false;
                        setNativeMainButtonLabel(
                            btnEl,
                            btnEl.dataset.hfDefaultLabel || defaultLabel
                        );
                    }, 1800);
                }
            } catch (err) {
                console.error("[AutoDownload] Queue to Comfy failed:", err);
                showToast({
                    severity: "error",
                    summary: "Queue failed",
                    detail: String(err?.message || err),
                    life: 4500
                });
                if (btnEl) {
                    btnEl.disabled = false;
                    setNativeMainButtonLabel(
                        btnEl,
                        btnEl.dataset.hfDefaultLabel || defaultLabel
                    );
                }
            }
        };

        const buildQueueItemForNativeRow = (candidate, rowNameHint = "", rowFolderHint = "") => {
            const entry = candidate ? createFrontendMissingModelEntryFromCandidate(candidate) : null;
            const rawName = String(
                entry?.requested_path || entry?.filename || candidate?.name || rowNameHint || ""
            ).trim();
            if (!rawName) return null;
            const catalogMatch = lookupResolvedCatalogModel(rawName) || lookupResolvedCatalogModel(rowNameHint);
            const url = String(candidate?.url || entry?.url || catalogMatch?.url || "").trim();
            if (!url) return null;
            const filename = getPathBasename(entry?.filename || catalogMatch?.filename || rawName) || rawName;
            const folder = String(
                candidate?.directory ||
                catalogMatch?.folder ||
                entry?.directory ||
                rowFolderHint ||
                inferSuggestedFolderFromRunHookSignals({
                    filename: rawName,
                    requested_path: rawName,
                    requestedPath: rawName,
                }) ||
                "checkpoints"
            ).trim();
            const sizeBytes = Number(catalogMatch?.sizeBytes || candidate?.sizeBytes || 0) || 0;
            return {
                filename,
                target_filename: filename,
                display_name: rawName,
                requested_path: rawName,
                url,
                folder,
                sizeBytes,
                folder_locked: Boolean(catalogMatch?.folder && candidate?.directory),
                locked_folder: String(candidate?.directory || catalogMatch?.folder || "").trim(),
            };
        };

        const getDirectNativeMissingModelRows = (rowsContainer) => {
            if (!rowsContainer || !(rowsContainer instanceof Element)) return [];
            const anchors = Array.from(
                rowsContainer.querySelectorAll('[data-testid="missing-model-download"], [data-testid="missing-model-locate"]')
            );
            const seen = new Set();
            const rows = [];
            for (const anchor of anchors) {
                let cur = anchor.parentElement;
                while (cur && cur.parentElement && cur.parentElement !== rowsContainer) {
                    const locateCount = cur.parentElement.querySelectorAll('[data-testid="missing-model-locate"]').length;
                    const dlCount = cur.parentElement.querySelectorAll('[data-testid="missing-model-download"]').length;
                    if (locateCount > 1 || dlCount > 1) {
                        break;
                    }
                    cur = cur.parentElement;
                }
                if (cur && cur !== rowsContainer && !seen.has(cur)) {
                    seen.add(cur);
                    rows.push(cur);
                }
            }
            return rows;
        };

        const collectNonButtonTextLines = (rowEl) => {
            if (!rowEl || !(rowEl instanceof Element)) return [];
            const ignoredSelector =
                '[data-testid="missing-model-download"], [data-testid="missing-model-locate"], [data-testid="hf-download-split"], [data-testid="hf-download-to-comfy"], button';
            const lines = [];
            let current = "";
            const walk = (node) => {
                if (!node) return;
                if (node.nodeType === Node.TEXT_NODE) {
                    current += node.textContent || "";
                    return;
                }
                if (node.nodeType !== Node.ELEMENT_NODE) return;
                if (node.matches?.(ignoredSelector)) return;
                const tag = node.tagName;
                const isBreak = tag === "DIV" || tag === "P" || tag === "LI" || tag === "BR" || tag === "TR";
                if (isBreak && current.trim()) {
                    lines.push(current.trim());
                    current = "";
                }
                for (let child = node.firstChild; child; child = child.nextSibling) {
                    walk(child);
                }
                if (isBreak && current.trim()) {
                    lines.push(current.trim());
                    current = "";
                }
            };
            walk(rowEl);
            if (current.trim()) lines.push(current.trim());
            return lines.flatMap((chunk) =>
                chunk.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
            );
        };

        const extractNativeRowModelLabel = (rowEl) => {
            if (!rowEl || !(rowEl instanceof Element)) return "";
            const titled = rowEl.querySelectorAll("[title]");
            for (const el of titled) {
                const t = String(el.getAttribute("title") || "").trim();
                if (!t) continue;
                const lower = t.toLowerCase();
                if (
                    lower === "download" ||
                    lower === "locate" ||
                    lower === "copy url" ||
                    lower === "copy link" ||
                    lower === "download to comfy" ||
                    lower.startsWith("http://") ||
                    lower.startsWith("https://")
                ) {
                    continue;
                }
                if (t.includes(".") || t.includes("/")) {
                    return t;
                }
            }
            const lines = collectNonButtonTextLines(rowEl);
            for (const line of lines) {
                if (line.includes(".") && !/\b(?:KB|MB|GB|TB|bytes)\b/i.test(line)) {
                    return line;
                }
            }
            return lines[0] || "";
        };

        const extractNativeRowFolderHint = (rowEl) => {
            const lines = collectNonButtonTextLines(rowEl);
            for (const line of lines) {
                const head = line.split("·")[0].trim();
                if (
                    head &&
                    !/\s/.test(head) &&
                    !head.includes(".") &&
                    /^[a-zA-Z0-9_/-]+$/.test(head)
                ) {
                    return head;
                }
            }
            return "";
        };

        const matchCandidateForNativeRow = (rowEl, rowIndex, totalRows, candidates = []) => {
            const list = Array.isArray(candidates) ? candidates : [];
            const rowLabel = extractNativeRowModelLabel(rowEl);
            const rowFolderHint = extractNativeRowFolderHint(rowEl);
            const rowBase = getPathBasename(rowLabel).toLowerCase();
            const rowLabelLower = rowLabel.toLowerCase();
            if (rowLabelLower) {
                for (const c of list) {
                    const cName = String(c?.name || "").trim();
                    const cBase = getPathBasename(cName).toLowerCase();
                    if (
                        cName.toLowerCase() === rowLabelLower ||
                        (cBase && (cBase === rowLabelLower || cBase === rowBase))
                    ) {
                        return { candidate: c, rowLabel, rowFolderHint };
                    }
                }
                const rowTextLower = String(rowEl.textContent || "").toLowerCase();
                const sorted = [...list].sort(
                    (a, b) => getPathBasename(b?.name || "").length - getPathBasename(a?.name || "").length
                );
                for (const c of sorted) {
                    const cBase = getPathBasename(c?.name || "").toLowerCase();
                    if (cBase && rowTextLower.includes(cBase)) {
                        return { candidate: c, rowLabel, rowFolderHint };
                    }
                }
            }
            if (list.length === totalRows && list[rowIndex]) {
                return { candidate: list[rowIndex], rowLabel, rowFolderHint };
            }
            return { candidate: null, rowLabel, rowFolderHint };
        };

        const createNativeSplitButtonGroup = ({
            groupTestId,
            mainTestId,
            chevronTestId,
            label,
            title,
            isFooterAll = false,
            onMainClick,
            onDropdownRequest,
        }) => {
            const group = document.createElement("div");
            group.setAttribute("data-testid", groupTestId);
            group.setAttribute(NATIVE_DOWNLOAD_TO_COMFY_ATTR, "true");
            group.className = isFooterAll
                ? "hf-native-split-group hf-native-split-group-all"
                : "hf-native-split-group";

            const mainBtn = document.createElement("button");
            mainBtn.type = "button";
            mainBtn.setAttribute("data-testid", mainTestId);
            mainBtn.setAttribute(NATIVE_DOWNLOAD_TO_COMFY_ATTR, "true");
            mainBtn.className = `hf-native-split-main ${NATIVE_SPLIT_BTN_PART_CLASS}`;
            mainBtn.dataset.hfDefaultLabel = label;
            if (title) mainBtn.title = title;

            if (isFooterAll) {
                const dlIcon = document.createElement("i");
                dlIcon.className = "icon-[lucide--download] size-4 shrink-0";
                dlIcon.setAttribute("aria-hidden", "true");
                const textSpan = document.createElement("span");
                textSpan.setAttribute("data-hf-label", "true");
                textSpan.className = "truncate";
                textSpan.textContent = label;
                mainBtn.appendChild(dlIcon);
                mainBtn.appendChild(textSpan);
            } else {
                mainBtn.textContent = label;
            }

            const chevronBtn = document.createElement("button");
            chevronBtn.type = "button";
            chevronBtn.setAttribute("data-testid", chevronTestId);
            chevronBtn.setAttribute("aria-label", "Download options");
            chevronBtn.setAttribute("aria-haspopup", "menu");
            chevronBtn.setAttribute("aria-expanded", "false");
            chevronBtn.className = `hf-native-split-chevron ${NATIVE_SPLIT_BTN_PART_CLASS}`;
            chevronBtn.innerHTML =
                `<i class="icon-[lucide--chevron-down] size-3 text-muted-foreground transition-transform duration-150" aria-hidden="true"></i>`;

            mainBtn.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                closeNativeSplitDropdown();
                onMainClick?.(mainBtn);
            });
            chevronBtn.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                onDropdownRequest?.(group, chevronBtn, mainBtn);
            });

            group.appendChild(mainBtn);
            group.appendChild(chevronBtn);
            return { group, mainBtn, chevronBtn };
        };

        const injectNativeSidebarMissingModelButtonsSync = (candidates = []) => {
            const rowsContainers = Array.from(
                document.querySelectorAll('[data-testid="missing-model-importable-rows"]')
            );
            const actionsContainers = Array.from(
                document.querySelectorAll('[data-testid="missing-model-actions"]')
            );
            if (!rowsContainers.length && !actionsContainers.length) return;

            ensureNativeSidebarStyles();
            const activeCandidates = Array.isArray(candidates) && candidates.length
                ? candidates
                : cachedNativeMissingCandidates;

            for (const rowsContainer of rowsContainers) {
                const containerQueueItems = [];
                const seenQueueKeys = new Set();
                const rows = getDirectNativeMissingModelRows(rowsContainer);
                rows.forEach((rowEl, idx) => {
                    const { candidate, rowLabel, rowFolderHint } = matchCandidateForNativeRow(
                        rowEl,
                        idx,
                        rows.length,
                        activeCandidates
                    );
                    const queueItem = buildQueueItemForNativeRow(candidate, rowLabel, rowFolderHint);
                    if (queueItem) {
                        const dedupeKey = `${queueItem.folder}::${queueItem.filename}`.toLowerCase();
                        if (!seenQueueKeys.has(dedupeKey)) {
                            seenQueueKeys.add(dedupeKey);
                            containerQueueItems.push(queueItem);
                        }
                    }

                    const nativeDownloadBtn = rowEl.querySelector('[data-testid="missing-model-download"]');
                    const nativeLocateBtn = rowEl.querySelector('[data-testid="missing-model-locate"]');
                    const anchorBtn = nativeDownloadBtn || (queueItem ? nativeLocateBtn : null);
                    let splitGroup = rowEl.querySelector('[data-testid="hf-download-split"]');

                    if (!anchorBtn || !queueItem) {
                        if (splitGroup) {
                            splitGroup.remove();
                        }
                        if (nativeDownloadBtn) {
                            nativeDownloadBtn.classList.remove("hf-native-hidden-download");
                        }
                        return;
                    }

                    if (nativeDownloadBtn) {
                        nativeDownloadBtn.classList.add("hf-native-hidden-download");
                    }

                    if (!splitGroup) {
                        const created = createNativeSplitButtonGroup({
                            groupTestId: "hf-download-split",
                            mainTestId: "hf-download-to-comfy",
                            chevronTestId: "hf-download-split-trigger",
                            label: "Download",
                            title: `Download ${queueItem.filename} to ComfyUI (models/${queueItem.folder})`,
                            isFooterAll: false,
                            onMainClick: (btn) => {
                                const itemToQueue = splitGroup?._hfQueueItem;
                                if (!itemToQueue) return;
                                void queueModelsToComfyBackend([itemToQueue], btn, "Download");
                            },
                            onDropdownRequest: (groupEl, chevronEl, mainEl) => {
                                const itemToQueue = groupEl?._hfQueueItem;
                                const nativeBtn = groupEl?._hfNativeDownloadBtn || null;
                                openNativeSplitDropdown(groupEl, chevronEl, {
                                    comfyDisabled: !itemToQueue || mainEl.disabled,
                                    browserDisabled: !nativeBtn && !itemToQueue?.url,
                                    onComfyDownload: () => {
                                        if (!itemToQueue) return;
                                        void queueModelsToComfyBackend([itemToQueue], mainEl, "Download");
                                    },
                                    onBrowserDownload: () => {
                                        triggerBrowserDownloadForItems(
                                            itemToQueue ? [itemToQueue] : [],
                                            nativeBtn
                                        );
                                    },
                                });
                            },
                        });
                        splitGroup = created.group;
                        anchorBtn.insertAdjacentElement("beforebegin", splitGroup);
                    } else {
                        if (splitGroup.nextElementSibling !== anchorBtn) {
                            anchorBtn.insertAdjacentElement("beforebegin", splitGroup);
                        }
                        const mainEl = splitGroup.querySelector('[data-testid="hf-download-to-comfy"]');
                        if (mainEl) {
                            mainEl.title = `Download ${queueItem.filename} to ComfyUI (models/${queueItem.folder})`;
                        }
                    }

                    splitGroup._hfQueueItem = queueItem;
                    splitGroup._hfNativeDownloadBtn = nativeDownloadBtn || null;
                });

                const cardScope = rowsContainer.parentElement || document;
                const actionsEl =
                    cardScope.querySelector('[data-testid="missing-model-actions"]') ||
                    document.querySelector('[data-testid="missing-model-actions"]');
                const nativeDownloadAllBtn = actionsEl
                    ? actionsEl.querySelector('[data-testid="missing-model-download-all"]')
                    : null;
                let allWrap = cardScope.querySelector('[data-testid="hf-native-download-all-wrap"]');
                let allSplit = cardScope.querySelector('[data-testid="hf-download-all-split"]');

                const shouldShowDownloadAll =
                    containerQueueItems.length > 0 &&
                    (Boolean(nativeDownloadAllBtn) || containerQueueItems.length > 1);

                if (!shouldShowDownloadAll) {
                    if (allSplit) allSplit.remove();
                    if (allWrap) allWrap.remove();
                    if (nativeDownloadAllBtn) {
                        nativeDownloadAllBtn.classList.remove("hf-native-hidden-download");
                    }
                    continue;
                }

                let downloadAllLabel = "";
                if (nativeDownloadAllBtn) {
                    const nativeText = String(nativeDownloadAllBtn.textContent || "").trim();
                    if (nativeText) {
                        downloadAllLabel = nativeText;
                    }
                }
                if (!downloadAllLabel) {
                    const totalBytes = containerQueueItems.reduce(
                        (acc, item) => acc + (Number(item?.sizeBytes || 0) || 0),
                        0
                    );
                    const formattedSize = formatNativeByteSize(totalBytes);
                    downloadAllLabel = formattedSize ? `Download all (${formattedSize})` : "Download all";
                }

                if (nativeDownloadAllBtn) {
                    nativeDownloadAllBtn.classList.add("hf-native-hidden-download");
                }

                if (!allSplit) {
                    const createdAll = createNativeSplitButtonGroup({
                        groupTestId: "hf-download-all-split",
                        mainTestId: "hf-download-all-to-comfy",
                        chevronTestId: "hf-download-all-split-trigger",
                        label: downloadAllLabel,
                        title: "Download all missing models to ComfyUI",
                        isFooterAll: true,
                        onMainClick: (btn) => {
                            const items = Array.isArray(allSplit?._hfQueueItems) ? allSplit._hfQueueItems : [];
                            void queueModelsToComfyBackend(
                                items,
                                btn,
                                btn.dataset.hfDefaultLabel || downloadAllLabel
                            );
                        },
                        onDropdownRequest: (groupEl, chevronEl, mainEl) => {
                            const items = Array.isArray(groupEl?._hfQueueItems) ? groupEl._hfQueueItems : [];
                            const nativeBtn = groupEl?._hfNativeDownloadAllBtn || null;
                            openNativeSplitDropdown(groupEl, chevronEl, {
                                comfyDisabled: !items.length || mainEl.disabled,
                                browserDisabled: !nativeBtn && !items.some((item) => item?.url),
                                onComfyDownload: () => {
                                    void queueModelsToComfyBackend(
                                        items,
                                        mainEl,
                                        mainEl.dataset.hfDefaultLabel || downloadAllLabel
                                    );
                                },
                                onBrowserDownload: () => {
                                    triggerBrowserDownloadForItems(items, nativeBtn);
                                },
                            });
                        },
                    });
                    allSplit = createdAll.group;
                } else {
                    const mainEl = allSplit.querySelector('[data-testid="hf-download-all-to-comfy"]');
                    if (mainEl && !mainEl.disabled) {
                        mainEl.dataset.hfDefaultLabel = downloadAllLabel;
                        setNativeMainButtonLabel(mainEl, downloadAllLabel);
                    }
                }

                allSplit._hfQueueItems = containerQueueItems;
                allSplit._hfNativeDownloadAllBtn = nativeDownloadAllBtn || null;

                if (actionsEl) {
                    if (allWrap) {
                        allWrap.remove();
                        allWrap = null;
                    }
                    if (allSplit.parentElement !== actionsEl) {
                        actionsEl.appendChild(allSplit);
                    }
                } else {
                    if (!allWrap) {
                        allWrap = document.createElement("div");
                        allWrap.setAttribute("data-testid", "hf-native-download-all-wrap");
                        allWrap.className = "flex items-center pt-2";
                    }
                    if (allSplit.parentElement !== allWrap) {
                        allWrap.appendChild(allSplit);
                    }
                    if (rowsContainer.nextElementSibling !== allWrap) {
                        rowsContainer.insertAdjacentElement("afterend", allWrap);
                    }
                }
            }
        };

        const injectNativeSidebarMissingModelButtons = () => {
            const hasSidebar = Boolean(
                document.querySelector(
                    '[data-testid="missing-model-importable-rows"], [data-testid="missing-model-actions"]'
                )
            );
            const hasErrorOverlay = Boolean(document.querySelector('[data-testid="error-overlay"]'));
            if (hasSidebar || hasErrorOverlay) {
                void enrichNativeMissingModelStoreFromCatalog();
            }
            if (!hasSidebar) return;

            injectNativeSidebarMissingModelButtonsSync(cachedNativeMissingCandidates);
            void resolveMissingModelStore()
                .then((store) => {
                    const candidates = unwrapStoreValue(store?.missingModelCandidates);
                    if (Array.isArray(candidates)) {
                        cachedNativeMissingCandidates = candidates;
                        injectNativeSidebarMissingModelButtonsSync(candidates);
                    }
                })
                .catch(() => {});
        };

        const injectButtonsIntoMissingModelsDialogs = (root = document) => {
            if (!root) return;

            const listboxes = [];
            if (root instanceof Element && root.matches(MISSING_MODELS_LIST_SELECTOR)) {
                listboxes.push(root);
            }
            if (typeof root.querySelectorAll === "function") {
                root.querySelectorAll(MISSING_MODELS_LIST_SELECTOR).forEach((el) => {
                    listboxes.push(el);
                });
            }

            for (const listbox of listboxes) {
                injectMissingModelsActionButton(listbox);
            }

            injectNativeSidebarMissingModelButtons();
        };

        let missingModelsObserverTarget = null;
        let nativeSidebarInjectRaf = 0;

        const scheduleNativeMissingModelsInjection = () => {
            if (nativeSidebarInjectRaf || typeof requestAnimationFrame !== "function") {
                if (typeof requestAnimationFrame !== "function") {
                    injectButtonsIntoMissingModelsDialogs(document);
                }
                return;
            }
            nativeSidebarInjectRaf = requestAnimationFrame(() => {
                nativeSidebarInjectRaf = 0;
                injectButtonsIntoMissingModelsDialogs(document);
            });
        };

        const disconnectMissingModelsObserver = () => {
            if (missingModelsObserver) {
                try {
                    missingModelsObserver.disconnect();
                } catch (_) {}
            }
            missingModelsObserverTarget = null;
        };

        const findScopedMissingModelsContainer = () => {
            const importableRows = document.querySelector('[data-testid="missing-model-importable-rows"]');
            if (importableRows) {
                return (
                    importableRows.closest(
                        'aside, [data-testid="right-side-panel"], .right-side-panel, [class*="right-side-panel"], [class*="side-bar"], [class*="sidebar"], .p-splitterpanel'
                    ) ||
                    importableRows.parentElement ||
                    importableRows
                );
            }
            const knownSidePanel = document.querySelector(
                '[data-testid="right-side-panel"], .right-side-panel, [class*="right-side-panel"], [data-testid="sidebar-right"], .comfyui-body-right'
            );
            if (knownSidePanel) {
                return knownSidePanel;
            }
            const panels = document.querySelectorAll('.p-splitterpanel, aside, [class*="sidebar"], [class*="side-bar"]');
            for (const panel of panels) {
                const text = String(panel?.textContent || "");
                if (
                    text.includes("Workflow Overview") ||
                    text.includes("Missing Models") ||
                    panel.querySelector('[data-testid="missing-model-actions"]')
                ) {
                    return panel;
                }
            }
            return document.querySelector(MISSING_MODELS_LIST_SELECTOR)?.closest(".p-dialog") || null;
        };

        // Option 1A: Lazy container-scoped observer active ONLY when missingModelStore has candidates.
        const syncMissingModelsObserverWithStore = (hasMissing) => {
            if (!hasMissing) {
                disconnectMissingModelsObserver();
                return;
            }
            injectButtonsIntoMissingModelsDialogs(document);
            if (typeof MutationObserver === "undefined") return;
            const target = findScopedMissingModelsContainer();
            if (!target || target === document.body || target === document.documentElement) {
                return;
            }
            if (missingModelsObserverTarget === target && missingModelsObserver) {
                return;
            }
            disconnectMissingModelsObserver();
            if (!missingModelsObserver) {
                missingModelsObserver = new MutationObserver(() => {
                    scheduleNativeMissingModelsInjection();
                });
            }
            missingModelsObserver.observe(target, {
                childList: true,
                subtree: true,
            });
            missingModelsObserverTarget = target;
        };

        let runHookLastTriggeredAt = 0;
        let workflowOpenLastTriggeredAt = 0;
        let workflowOpenMissingModelsTimer = null;
        let workflowOpenLastHandledSignature = "";
        let workflowOpenLastHandledPath = "";
        let workflowOpenTriggeredForCurrentLoad = false;

        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        const hasNativeMissingModelsDialog = () =>
            Boolean(document.querySelector(MISSING_MODELS_LIST_SELECTOR));

        const RUN_ERROR_DIALOG_SELECTOR = ".comfy-error-report";
        const MODEL_VALIDATION_INPUT_NAMES = new Set([
            "ckpt_name",
            "unet_name",
            "vae_name",
            "lora_name",
            "control_net_name",
            "clip_name",
            "model_name",
            "style_model_name",
            "gligen_name",
            "audio_encoder_name",
            "name",
            "unet",
            "model",
            "vae",
            "clip",
            "lora",
            "checkpoint",
            "diffusion_model",
            "vitpose_model",
            "yolo_model",
            "tiny_vae",
            "vae_approx"
        ]);
        const isModelValidationInputName = (name) => {
            const lower = String(name || "").trim().toLowerCase();
            if (!lower) return false;
            return (
                MODEL_VALIDATION_INPUT_NAMES.has(lower) ||
                lower.endsWith(".lora_name") ||
                lower.endsWith(".model_name") ||
                lower.endsWith(".ckpt_name")
            );
        };
        const RUN_HOOK_CLASS_INCLUDE_MARKERS = [
            "loader",
            "checkpoint",
            "controlnet",
            "lora",
            "vae",
            "unet",
            "clip",
            "gguf",
            "nunchaku",
            "kjnodes",
            "wanvideowrapper",
            "wanvideo_wrapper",
            "wan video wrapper",
            "wanvideo",
            "removal",
            "model",
        ];

        const getNodeErrorsSnapshot = () => {
            try {
                const store = findPiniaStore("executionError");
                if (store && typeof store === "object" && store.lastNodeErrors) {
                    return store.lastNodeErrors;
                }
            } catch (_) {}

            try {
                if (app?.extensionStore && typeof app.extensionStore === "object" && app.extensionStore.lastNodeErrors) {
                    return app.extensionStore.lastNodeErrors;
                }
            } catch (_) {}

            try {
                if (app?.extensionManager && typeof app.extensionManager === "object" && app.extensionManager.lastNodeErrors) {
                    return app.extensionManager.lastNodeErrors;
                }
            } catch (_) {}

            const value = app?.lastNodeErrors;
            if (!value || typeof value !== "object") {
                return null;
            }
            return value;
        };

        const getNodeErrorsSignature = (nodeErrors) => {
            if (!nodeErrors || typeof nodeErrors !== "object") {
                return "";
            }
            try {
                const parts = [];
                for (const nodeError of Object.values(nodeErrors)) {
                    const classType = String(nodeError?.class_type || "");
                    const reasons = Array.isArray(nodeError?.errors) ? nodeError.errors : [];
                    for (const reason of reasons) {
                        parts.push(
                            [
                                classType,
                                String(reason?.type || ""),
                                String(reason?.message || ""),
                                String(reason?.details || "")
                            ].join("|")
                        );
                    }
                }
                parts.sort();
                return parts.join("||");
            } catch (_) {
                return "";
            }
        };

        const parseInputNameFromDetails = (details) => {
            const text = String(details || "").trim();
            const match = text.match(/^([a-zA-Z0-9_.]+)\s*:/);
            return match ? match[1] : "";
        };

        const parseMissingValueFromDetails = (details) => {
            const text = String(details || "");
            const match =
                text.match(/:\s*'([^']+)'\s*not\s+in\s+\[/i) ||
                text.match(/'([^']+)'\s*not\s+in\s+\[/i);
            return match ? String(match[1] || "").trim() : "";
        };

        const isValueNotInListValidation = (reason) => {
            const type = String(reason?.type || "").toLowerCase();
            const message = String(reason?.message || "").toLowerCase();
            const details = String(reason?.details || "").toLowerCase();
            return (
                message.includes("value not in list") ||
                type.includes("value_not_in_list") ||
                details.includes("not in [")
            );
        };

        const parseNodeIdFromExecutionId = (executionId) => {
            const idToken = String(executionId || "").split(":").pop();
            const numericId = Number(idToken);
            return Number.isFinite(numericId) ? numericId : null;
        };

        const isNodeBypassedMode = (mode) => {
            const numericMode = Number(mode);
            return numericMode === 2 || numericMode === 4;
        };

        const isGraphNodeBypassed = (node) =>
            Boolean(node && typeof node === "object" && isNodeBypassedMode(node?.mode));

        const getGraphNodeByExecutionId = (executionId, graph = app?.rootGraph || app?.graph) => {
            const targetId = String(executionId || "").trim();
            if (!targetId || !graph) {
                return null;
            }

            let found = null;
            const visited = new Set();
            const visit = (currentGraph, prefix = "") => {
                if (!currentGraph || visited.has(currentGraph) || found) {
                    return;
                }
                visited.add(currentGraph);

                const nodes = Array.isArray(currentGraph?.nodes)
                    ? currentGraph.nodes
                    : (Array.isArray(currentGraph?._nodes) ? currentGraph._nodes : []);
                for (const node of nodes) {
                    if (!node || typeof node !== "object") {
                        continue;
                    }
                    const rawNodeId = String(node?.id ?? "").trim();
                    const executionNodeId = prefix && rawNodeId ? `${prefix}:${rawNodeId}` : rawNodeId;
                    if (executionNodeId === targetId || rawNodeId === targetId) {
                        found = node;
                        return;
                    }
                    try {
                        const sub = (typeof node.getInnerGraph === "function" ? node.getInnerGraph() : null) || node.subgraph;
                        if (sub && typeof sub === "object") {
                            visit(sub, executionNodeId);
                        }
                    } catch (_) {
                        // Ignore malformed subgraph nodes.
                    }
                    if (found) {
                        return;
                    }
                }
            };

            visit(graph, "");
            if (found) {
                return found;
            }

            const numericNodeId = parseNodeIdFromExecutionId(targetId);
            if (Number.isFinite(numericNodeId)) {
                return app?.graph?.getNodeById?.(numericNodeId) || null;
            }
            return null;
        };

        const isExecutionNodeBypassed = (executionId) =>
            isGraphNodeBypassed(getGraphNodeByExecutionId(executionId));

        const isFrontendMissingModelCandidateBypassed = (candidate) => {
            if (!candidate || typeof candidate !== "object") {
                return false;
            }
            const executionId = candidate?.nodeId ?? candidate?.node_id;
            if (executionId === undefined || executionId === null || executionId === "") {
                return false;
            }
            return isExecutionNodeBypassed(executionId);
        };

        const getGraphNodeTitleById = (nodeId, fallback = "") => {
            if (!Number.isFinite(nodeId)) {
                return fallback;
            }
            const node = app?.graph?.getNodeById?.(nodeId);
            const title = String(node?.title || node?.type || "").trim();
            return title || fallback;
        };

        const getRepoFolderModelKey = (model) => {
            const exceptionId = String(model?.exception_id || "").toLowerCase();
            const repoId = String(model?.repo_id || "").toLowerCase();
            const url = String(model?.url || "").toLowerCase();
            return `${exceptionId}|${repoId}|${url}`;
        };

        const getFileModelKey = (model) => {
            const mode = String(model?.download_mode || "file").toLowerCase();
            if (mode === "folder") {
                return "";
            }
            const filename = String(model?.filename || "").toLowerCase();
            const url = String(model?.url || "").toLowerCase();
            const folder = String(model?.suggested_folder || model?.folder || "").toLowerCase();
            return `${filename}|${url}|${folder}`;
        };

        const collectRepoFolderMissingModelsFromNodeErrors = (nodeErrors = getNodeErrorsSnapshot()) => {
            if (!nodeErrors || typeof nodeErrors !== "object") {
                return [];
            }

            const collected = [];
            const seen = new Set();
            for (const [executionId, nodeError] of Object.entries(nodeErrors)) {
                if (isExecutionNodeBypassed(executionId)) {
                    continue;
                }
                const classType = String(nodeError?.class_type || "").trim();
                const reasons = Array.isArray(nodeError?.errors) ? nodeError.errors : [];
                if (!reasons.length) continue;

                const nodeId = parseNodeIdFromExecutionId(executionId);
                const nodeTitle = getGraphNodeTitleById(nodeId, classType || "Unknown Node");
                for (const reason of reasons) {
                    if (!isValueNotInListValidation(reason)) {
                        continue;
                    }
                    const details = String(reason?.details || "");
                    const inputName =
                        String(reason?.extra_info?.input_name || "").trim() ||
                        parseInputNameFromDetails(details);
                    const missingValue = parseMissingValueFromDetails(details);

                    const repoEntry = createRepoFolderMissingModelEntry({
                        classType,
                        inputName,
                        details,
                        missingValue,
                        nodeId,
                        nodeTitle,
                    });
                    if (!repoEntry) {
                        continue;
                    }
                    const key = getRepoFolderModelKey(repoEntry);
                    if (seen.has(key)) {
                        continue;
                    }
                    seen.add(key);
                    collected.push(repoEntry);
                }
            }

            return collected;
        };

        const collectNodeSpecificCuratedMissingModelsFromNodeErrors = (nodeErrors = getNodeErrorsSnapshot()) => {
            if (!nodeErrors || typeof nodeErrors !== "object") {
                return [];
            }

            const collected = [];
            const seen = new Set();
            for (const [executionId, nodeError] of Object.entries(nodeErrors)) {
                if (isExecutionNodeBypassed(executionId)) {
                    continue;
                }
                const classType = String(nodeError?.class_type || "").trim();
                const reasons = Array.isArray(nodeError?.errors) ? nodeError.errors : [];
                if (!reasons.length) continue;

                const nodeId = parseNodeIdFromExecutionId(executionId);
                const nodeTitle = getGraphNodeTitleById(nodeId, classType || "Unknown Node");
                for (const reason of reasons) {
                    if (!isValueNotInListValidation(reason)) {
                        continue;
                    }
                    const details = String(reason?.details || "");
                    const inputName =
                        String(reason?.extra_info?.input_name || "").trim() ||
                        parseInputNameFromDetails(details);
                    const missingValue = parseMissingValueFromDetails(details);

                    const curatedEntries = createWanAnimatePreprocessCuratedEntries({
                        classType,
                        inputName,
                        details,
                        missingValue,
                        nodeId,
                        nodeTitle,
                    });
                    for (const entry of curatedEntries) {
                        const key = getFileModelKey(entry);
                        if (!key || seen.has(key)) {
                            continue;
                        }
                        seen.add(key);
                        collected.push(entry);
                    }
                }
            }

            return collected;
        };

        const splitMissingModelsForRepoFolderSection = (missingModels, nodeErrors = getNodeErrorsSnapshot()) => {
            const regularMissing = [];
            const curatedMissing = [];
            const repoFolderMissing = [];
            const seenRepoEntries = new Set();
            const seenFileEntries = new Set();

            const pushRepoEntry = (entry) => {
                if (!entry) return;
                const key = getRepoFolderModelKey(entry);
                if (!key || seenRepoEntries.has(key)) {
                    return;
                }
                seenRepoEntries.add(key);
                repoFolderMissing.push(entry);
            };

            const pushFileEntry = (entry, target = "regular") => {
                if (!entry || isFolderRepoDownloadModel(entry)) return;
                const key = getFileModelKey(entry);
                if (key && seenFileEntries.has(key)) {
                    return;
                }
                if (key) {
                    seenFileEntries.add(key);
                }
                if (target === "curated") {
                    curatedMissing.push(entry);
                } else {
                    regularMissing.push(entry);
                }
            };

            const missingList = Array.isArray(missingModels) ? missingModels : [];
            for (const model of missingList) {
                const repoEntry = createRepoFolderMissingModelEntry({
                    classType: model?.node_title,
                    missingValue: model?.requested_path || model?.filename,
                    filename: model?.filename,
                    directory: model?.directory,
                    url: model?.url,
                    repoId: model?.repo_id,
                    nodeId: model?.node_id,
                    nodeTitle: model?.node_title,
                    source: model?.source,
                    type: model?.type,
                    name: model?.name,
                    requestedPath: model?.requested_path,
                });
                if (repoEntry) {
                    pushRepoEntry({
                        ...repoEntry,
                        node_title: String(model?.node_title || repoEntry.node_title || "").trim() || "Unknown Node",
                        node_id: model?.node_id ?? repoEntry.node_id,
                        source: String(model?.source || repoEntry.source || "").trim() || "folder_repo_exception",
                    });
                    continue;
                }

                if (isFolderRepoDownloadModel(model)) {
                    pushRepoEntry(model);
                    continue;
                }

                const curatedEntries = createWanAnimatePreprocessCuratedEntries({
                    classType: model?.node_title,
                    inputName: model?.input_name,
                    missingValue: model?.requested_path || model?.filename,
                    filename: model?.filename,
                    details: model?.details,
                    directory: model?.directory,
                    url: model?.url,
                    repoId: model?.repo_id,
                    nodeId: model?.node_id,
                    nodeTitle: model?.node_title,
                    source: model?.source,
                    type: model?.type,
                    name: model?.name,
                });
                if (curatedEntries.length) {
                    curatedEntries.forEach((entry) => {
                        pushFileEntry({
                            ...entry,
                            node_title: String(model?.node_title || entry.node_title || "").trim() || "Unknown Node",
                            node_id: model?.node_id ?? entry.node_id,
                        }, "curated");
                    });
                    continue;
                }

                pushFileEntry(model, "regular");
            }

            const fromNodeErrors = collectRepoFolderMissingModelsFromNodeErrors(nodeErrors);
            fromNodeErrors.forEach(pushRepoEntry);

            const fromNodeErrorsCurated = collectNodeSpecificCuratedMissingModelsFromNodeErrors(nodeErrors);
            fromNodeErrorsCurated.forEach((entry) => pushFileEntry(entry, "curated"));

            return { repoFolderMissing, curatedMissing, regularMissing };
        };

        // Pinia store lookups (resolveModelStore, resolveExecutionErrorStore, resolveMissingModelStore, findPiniaStore)
        // are imported from ./comfy_stores.js.

        const getSelectedModelsMetadataNativeLike = (node) => {
            try {
                if (isGraphNodeBypassed(node)) {
                    return [];
                }
                const models = Array.isArray(node?.properties?.models) ? node.properties.models : [];
                if (!models.length) return [];
                const widgetsValuesRaw = node?.widgets_values;
                const widgetsValuesNamed = node?.widgets_values_named;
                if (!widgetsValuesRaw && !widgetsValuesNamed) return [];

                const widgetValues = [
                    ...(Array.isArray(widgetsValuesRaw)
                        ? widgetsValuesRaw
                        : Object.values(widgetsValuesRaw || {})),
                    ...(widgetsValuesNamed && typeof widgetsValuesNamed === "object"
                        ? Object.values(widgetsValuesNamed)
                        : []),
                ];
                if (!widgetValues.length) return [];

                const disabledModelValues = getDisabledWidgetValuesForNode(node);
                const stringWidgetValues = new Set();
                for (const value of widgetValues) {
                    if (typeof value === "string" && value.trim()) {
                        const trimmed = value.trim();
                        const base = trimmed.split(/[/\\]/).pop().trim();
                        if (disabledModelValues.has(trimmed) || disabledModelValues.has(base)) {
                            continue;
                        }
                        stringWidgetValues.add(trimmed);
                    }
                }
                if (!stringWidgetValues.size) return [];

                return models.filter((model) => {
                    const modelName = String(model?.name || "").trim();
                    if (!modelName) return false;
                    const base = modelName.split(/[/\\]/).pop().trim();
                    if (disabledModelValues.has(modelName) || disabledModelValues.has(base)) {
                        return false;
                    }
                    return stringWidgetValues.has(modelName) || stringWidgetValues.has(base);
                });
            } catch (_) {
                return [];
            }
        };

        const isExcludedDiscoveryNode = (node) => {
            if (!node || typeof node !== "object") return false;
            const nodeType = String(node.type || "");
            const cnrId = String(node.properties?.cnr_id || "");
            
            if (cnrId === "comfyui_controlnet_aux" ||
                cnrId === "frame-interpolation" ||
                cnrId === "ComfyUI-Frame-Interpolation" ||
                cnrId === "video-depth-anything" ||
                cnrId === "ComfyUI-Video-Depth-Anything") {
                return true;
            }
            
            if (nodeType.endsWith(" VFI") ||
                nodeType === "KSampler Gradually Adding More Denoise (efficient)" ||
                nodeType === "Make Interpolation State List" ||
                nodeType === "VFI FloatToInt" ||
                nodeType.includes("VideoDepthAnything")) {
                return true;
            }
            
            return false;
        };

        const collectEmbeddedModelsNativeLike = (graphData) => {
            const embeddedModels = [];

            const collectFromNodes = (nodes) => {
                if (!Array.isArray(nodes)) return;
                for (const node of nodes) {
                    if (isNodeBypassedMode(node?.mode) || isExcludedDiscoveryNode(node)) {
                        continue;
                    }
                    const selected = getSelectedModelsMetadataNativeLike(node);
                    if (selected.length) {
                        embeddedModels.push(...selected);
                    }
                }
            };

            collectFromNodes(graphData?.nodes);

            const subgraphs = getSafeSubgraphList(graphData);
            for (const subgraph of subgraphs) {
                collectFromNodes(subgraph?.nodes);
            }

            if (Array.isArray(graphData?.models)) {
                // Top-level graphData.models can contain stale entries from a
                // previous save. Cross-reference each entry against the current
                // widget values in the serialized nodes to exclude models that
                // are no longer referenced by any node.
                const allSerializedWidgetValues = new Set();
                const gatherWidgetValues = (nodes) => {
                    if (!Array.isArray(nodes)) return;
                    for (const node of nodes) {
                        const disabledValues = getDisabledWidgetValuesForNode(node);
                        const wvRaw = node?.widgets_values;
                        const wv = Array.isArray(wvRaw) ? wvRaw : Object.values(wvRaw || {});
                        for (const v of wv) {
                            if (typeof v === "string" && v.trim()) {
                                const trimmed = v.trim();
                                const base = trimmed.split(/[/\\]/).pop().trim();
                                if (!disabledValues.has(trimmed) && !disabledValues.has(base)) {
                                    allSerializedWidgetValues.add(trimmed);
                                }
                            }
                        }
                        if (node?.widgets_values_named && typeof node.widgets_values_named === "object") {
                            for (const v of Object.values(node.widgets_values_named)) {
                                if (typeof v === "string" && v.trim()) {
                                    const trimmed = v.trim();
                                    const base = trimmed.split(/[/\\]/).pop().trim();
                                    if (!disabledValues.has(trimmed) && !disabledValues.has(base)) {
                                        allSerializedWidgetValues.add(trimmed);
                                    }
                                }
                            }
                        }
                    }
                };
                gatherWidgetValues(graphData?.nodes);
                for (const subgraph of subgraphs) {
                    gatherWidgetValues(subgraph?.nodes);
                }

                for (const model of graphData.models) {
                    const modelName = String(model?.name || "").trim();
                    if (!modelName) continue;
                    // Only include if the model name is still referenced by a widget
                    if (allSerializedWidgetValues.has(modelName) ||
                        allSerializedWidgetValues.has(modelName.split(/[/\\]/).pop().trim())) {
                        embeddedModels.push(model);
                    }
                }
            }

            const uniqueByKey = new Map();
            for (const model of embeddedModels) {
                const key = String(model?.url || model?.hash || "").trim();
                if (!key) continue; // Native loadGraphData ignores models with no url/hash key.
                if (!uniqueByKey.has(key)) {
                    uniqueByKey.set(key, model);
                }
            }
            return Array.from(uniqueByKey.values());
        };

        const MODELISH_FILENAME_PATTERN =
            /\.(safetensors|gguf|ckpt|pt|pth|bin|onnx|engine|tflite|pb)(?:$|\?)/i;

        const workflowLikelyContainsModelReferences = (graphData) => {
            if (!graphData || typeof graphData !== "object") {
                return false;
            }

            const nodesToScan = [];
            const pushNodes = (nodes) => {
                if (!Array.isArray(nodes)) return;
                nodesToScan.push(...nodes);
            };

            pushNodes(graphData?.nodes);
            const subgraphs = getSafeSubgraphList(graphData);
            for (const subgraph of subgraphs) {
                pushNodes(subgraph?.nodes);
            }

            for (const node of nodesToScan) {
                if (!node || typeof node !== "object") continue;
                if (isNodeBypassedMode(node?.mode)) continue;

                const nodeModels = Array.isArray(node?.properties?.models) ? node.properties.models : [];
                if (nodeModels.length) {
                    return true;
                }

                const proxyWidgets = Array.isArray(node?.properties?.proxyWidgets)
                    ? node.properties.proxyWidgets
                    : [];
                for (const proxy of proxyWidgets) {
                    const widgetName = String(
                        Array.isArray(proxy) && proxy.length >= 2 ? proxy[1] : ""
                    )
                        .trim()
                        .toLowerCase();
                    if (widgetName && isModelValidationInputName(widgetName)) {
                        return true;
                    }
                }

                const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
                for (const input of inputs) {
                    const widgetName = String(input?.widget?.name || input?.name || "")
                        .trim()
                        .toLowerCase();
                    if (widgetName && isModelValidationInputName(widgetName)) {
                        return true;
                    }
                }

                const widgetValuesRaw = node?.widgets_values;
                const widgetValuesNamed = node?.widgets_values_named;
                const widgetValues = [
                    ...(Array.isArray(widgetValuesRaw)
                        ? widgetValuesRaw
                        : Object.values(widgetValuesRaw || {})),
                    ...(widgetValuesNamed && typeof widgetValuesNamed === "object"
                        ? Object.values(widgetValuesNamed)
                        : []),
                ];
                for (const value of widgetValues) {
                    if (typeof value !== "string") continue;
                    const text = value.trim();
                    if (!text) continue;
                    if (MODELISH_FILENAME_PATTERN.test(text)) {
                        return true;
                    }
                }
            }

            return false;
        };

        const getRegisteredNodeTypesMap = () => {
            const candidates = [
                globalThis?.LiteGraph?.registered_node_types,
                window?.LiteGraph?.registered_node_types,
            ];
            for (const candidate of candidates) {
                if (candidate && typeof candidate === "object") {
                    return candidate;
                }
            }
            return null;
        };

        const getMissingNodeTypesNativeLike = (graphData) => {
            if (!graphData || typeof graphData !== "object") {
                return [];
            }
            const registeredNodeTypes = getRegisteredNodeTypesMap();
            if (!registeredNodeTypes) {
                return [];
            }

            const missing = new Set();
            const collectFromNodes = (nodes) => {
                if (!Array.isArray(nodes)) return;
                for (const node of nodes) {
                    if (isNodeBypassedMode(node?.mode)) continue;
                    const nodeType = String(node?.type || "").trim();
                    if (!nodeType) continue;
                    if (!(nodeType in registeredNodeTypes)) {
                        missing.add(nodeType);
                    }
                }
            };

            collectFromNodes(graphData?.nodes);
            const subgraphs = getSafeSubgraphList(graphData);
            for (const subgraph of subgraphs) {
                collectFromNodes(subgraph?.nodes);
            }
            return Array.from(missing);
        };

        const getPreRunMissingModelsNativeLike = async (graphData = null) => {
            if (!graphData || typeof graphData !== "object") {
                graphData = serializeWorkflowForModelScan();
            }
            if (!graphData || typeof graphData !== "object") {
                return [];
            }

            const uniqueModels = collectEmbeddedModelsNativeLike(graphData);
            if (!uniqueModels.length) {
                return [];
            }

            const modelStore = await resolveModelStore();
            if (!modelStore) {
                return [];
            }

            try {
                await modelStore.loadModelFolders();
            } catch (_) {
                return [];
            }

            const folderNamesCache = new Map();
            const missing = [];

            for (const model of uniqueModels) {
                const directory = String(model?.directory || "").trim();
                const modelName = String(model?.name || "").trim();
                if (!directory || !modelName) {
                    continue;
                }

                if (!folderNamesCache.has(directory)) {
                    let nameSet = null;
                    try {
                        const folder = await modelStore.getLoadedModelFolder(directory);
                        const values = folder?.models ? Object.values(folder.models) : [];
                        if (Array.isArray(values) && values.length) {
                            nameSet = new Set(
                                values
                                    .map((entry) => String(entry?.file_name || "").trim())
                                    .filter(Boolean)
                            );
                        } else {
                            nameSet = new Set();
                        }
                    } catch (_) {
                        nameSet = null;
                    }
                    folderNamesCache.set(directory, nameSet);
                }

                const namesInFolder = folderNamesCache.get(directory);
                if (!namesInFolder || !namesInFolder.has(modelName)) {
                    missing.push(model);
                }
            }

            return missing;
        };

        const getPreRunMissingModelsBackendFallback = async (graphData = null) => {
            if (!graphData || typeof graphData !== "object") {
                graphData = serializeWorkflowForModelScan();
            }
            if (!graphData || typeof graphData !== "object") {
                return { missing: [], pathMismatches: [] };
            }
            if (!workflowLikelyContainsModelReferences(graphData)) {
                return { missing: [], pathMismatches: [] };
            }

            try {
                const resp = await doFetch("/check_missing_models", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        ...graphData,
                        request_id: `run-hook-preflight-${Date.now()}`,
                        skip_hf_search: true,
                    }),
                });
                if (resp.status !== 200) {
                    return { missing: [], pathMismatches: [] };
                }
                const data = await resp.json();
                return {
                    missing: filterRunHookEligibleMissingModels(
                        Array.isArray(data?.missing) ? data.missing : []
                    ),
                    pathMismatches: Array.isArray(data?.mismatches)
                        ? data.mismatches
                        : (Array.isArray(data?.path_mismatches) ? data.path_mismatches : []),
                };
            } catch (_) {
                return { missing: [], pathMismatches: [] };
            }
        };

        const isLikelyModelLoaderClass = (classType) => {
            const value = String(classType || "").toLowerCase();
            if (!value) return false;
            if (isFlashVsrFamilyText(value)) {
                return false;
            }
            return textContainsAnyMarker(value, RUN_HOOK_CLASS_INCLUDE_MARKERS);
        };

        const isModelValidationReason = (reason, classType = "") => {
            const type = String(reason?.type || "").toLowerCase();
            const message = String(reason?.message || "").toLowerCase();
            const details = String(reason?.details || "");
            const detailsLower = details.toLowerCase();
            const missingValue = parseMissingValueFromDetails(details);

            // Never treat unregistered node classes or missing custom nodes as model validation reasons.
            // This ensures they keep their native red borders and error states on the canvas.
            if (message.includes("unregistered") || 
                message.includes("not registered") || 
                type.includes("unregistered") ||
                (message.includes("class") && message.includes("not found")) ||
                (message.includes("class") && message.includes("does not exist")) ||
                (message.includes("node type") && message.includes("not found"))) {
                return false;
            }

            const isValueNotInList =
                message.includes("value not in list") ||
                type.includes("value_not_in_list") ||
                detailsLower.includes("not in [");
            
            const isMissingModelException = 
                message.includes("missing model") ||
                detailsLower.includes("missing model") ||
                type === "model_missing" ||
                ((message.includes("not found") || detailsLower.includes("not found") ||
                  message.includes("does not exist") || detailsLower.includes("does not exist")) &&
                 (isLikelyModelLoaderClass(classType) ||
                  /\b(checkpoint|model|lora|vae|unet|clip|embedding|controlnet|safetensors|ckpt|diffusion_model)\b/i.test(message + " " + details)));

            if (!isValueNotInList && !isMissingModelException) {
                return false;
            }

            if (isLikelyModelLoaderClass(classType)) {
                return true;
            }

            const inputName =
                String(reason?.extra_info?.input_name || "").trim() ||
                parseInputNameFromDetails(details);
            const inputNameLower = inputName.toLowerCase();

            const repoFolderException = resolveRepoFolderDownloadException({
                classType,
                inputName,
                details,
                missingValue,
            });
            if (repoFolderException) {
                return true;
            }

            const flashVsrRelated =
                isFlashVsrFamilyText(classType) ||
                isFlashVsrFamilyText(inputNameLower) ||
                isFlashVsrFamilyText(detailsLower) ||
                isFlashVsrFamilyText(missingValue);
            if (flashVsrRelated) {
                return false;
            }

            const looksModelInput = isModelValidationInputName(inputNameLower);
            const looksModelByClassAndInput =
                isLikelyModelLoaderClass(classType) && inputNameLower.endsWith("_name");
            const looksModelByClassAndValue =
                isLikelyModelLoaderClass(classType) && detailsLower.includes("not in [");

            return looksModelInput || looksModelByClassAndInput || looksModelByClassAndValue;
        };

        const isFlashVsrModelReference = (model) => {
            if (!model || typeof model !== "object") return false;
            const fields = [
                model?.directory,
                model?.name,
                model?.url,
                model?.type,
                model?.repo_id,
                model?.source,
            ];
            return fields.some((value) => isFlashVsrFamilyText(value));
        };

        const filterRunHookEligibleMissingModels = (models) => {
            if (!Array.isArray(models) || !models.length) {
                return [];
            }
            return models.filter((model) => {
                const repoFolderException = resolveRepoFolderDownloadException({
                    filename: model?.name,
                    name: model?.name,
                    directory: model?.directory,
                    url: model?.url,
                    repoId: model?.repo_id,
                    source: model?.source,
                    type: model?.type,
                });
                if (repoFolderException) {
                    return true;
                }
                return !isFlashVsrModelReference(model);
            });
        };

        const getMissingModelsDialogEntries = () => {
            const entries = [];
            const addEntry = (value) => {
                const text = String(value || "").replace(/\s+/g, " ").trim();
                if (!text) return;
                entries.push(text);
            };

            const listboxes = Array.from(
                document.querySelectorAll(MISSING_MODELS_LIST_SELECTOR)
            );
            for (const listbox of listboxes) {
                const optionNodes = listbox.querySelectorAll(
                    "[role='option'], .p-listbox-item, li"
                );
                if (optionNodes.length) {
                    optionNodes.forEach((node) => addEntry(node?.textContent));
                    continue;
                }
                const fallbackLines = String(listbox.textContent || "")
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean);
                fallbackLines.forEach(addEntry);
            }

            return Array.from(new Set(entries));
        };

        const shouldSuppressMissingDialogTriggerForFlashVsr = () => {
            const entries = getMissingModelsDialogEntries();
            if (!entries.length) {
                // If we cannot determine entries, avoid suppressing.
                return false;
            }
            const hasKnownRepoFolderException = entries.some((entry) =>
                Boolean(
                    resolveRepoFolderDownloadException({
                        classType: entry,
                        inputName: entry,
                        details: entry,
                        missingValue: entry,
                    })
                )
            );
            if (hasKnownRepoFolderException) {
                return false;
            }
            const hasFlash = entries.some((entry) => isFlashVsrFamilyText(entry));
            if (!hasFlash) {
                return false;
            }
            const hasNonFlash = entries.some((entry) => !isFlashVsrFamilyText(entry));
            return !hasNonFlash;
        };

        const shouldSuppressPromptValidationTriggerForFlashVsr = () => {
            const dialogs = Array.from(document.querySelectorAll(RUN_ERROR_DIALOG_SELECTOR));
            if (!dialogs.length) {
                return false;
            }

            let hasRelevantDialog = false;
            let hasNonFlashSignal = false;
            for (const dialog of dialogs) {
                const text = String(dialog?.textContent || "").toLowerCase();
                if (!text.includes("prompt execution failed")) continue;
                if (!text.includes("value not in list")) continue;
                hasRelevantDialog = true;
                const hasKnownRepoFolderException = Boolean(
                    resolveRepoFolderDownloadException({
                        classType: text,
                        inputName: text,
                        details: text,
                        missingValue: text,
                    })
                );
                if (hasKnownRepoFolderException) {
                    return false;
                }
                if (!isFlashVsrFamilyText(text)) {
                    hasNonFlashSignal = true;
                    break;
                }
            }

            return hasRelevantDialog && !hasNonFlashSignal;
        };

        const getNativeModelValidationFailures = (nodeErrors = getNodeErrorsSnapshot()) => {
            if (!nodeErrors || typeof nodeErrors !== "object") {
                return [];
            }

            const failures = [];
            for (const [executionId, nodeError] of Object.entries(nodeErrors)) {
                if (isExecutionNodeBypassed(executionId)) {
                    continue;
                }
                const nodeId = parseNodeIdFromExecutionId(executionId);
                const node = getGraphNodeByExecutionId(nodeId);
                if (node && isExcludedDiscoveryNode(node)) {
                    continue;
                }
                const classType = String(nodeError?.class_type || "");
                const reasons = Array.isArray(nodeError?.errors) ? nodeError.errors : [];
                const nodeTitle = getGraphNodeTitleById(nodeId, classType || "Unknown Node");
                for (const reason of reasons) {
                    if (!isModelValidationReason(reason, classType)) {
                        continue;
                    }

                    const details = String(reason?.details || "");
                    const inputName =
                        String(reason?.extra_info?.input_name || "").trim() ||
                        parseInputNameFromDetails(details);

                    if (node && isDynamicGroupWidgetDisabledInNode(node, inputName)) {
                        continue;
                    }

                    failures.push({
                        classType,
                        inputName,
                        missingValue: parseMissingValueFromDetails(details),
                        details,
                        nodeId,
                        nodeTitle,
                    });
                }
            }
            return failures;
        };

        const hasNativePromptValidationDialog = () => {
            const nodes = document.querySelectorAll(RUN_ERROR_DIALOG_SELECTOR);
            for (const node of nodes) {
                const text = String(node?.textContent || "").toLowerCase();
                if (!text) continue;
                if (text.includes("prompt execution failed") && text.includes("value not in list")) {
                    return true;
                }
            }
            return false;
        };

        const suppressNativeErrorOverlay = () => {
            void dismissNativeErrorDialog();
        };

        const stripModelValidationErrorsFromNodeErrors = (nodeErrors) => {
            if (!nodeErrors || typeof nodeErrors !== "object") {
                return { changed: false, removedCount: 0, nextNodeErrors: nodeErrors };
            }

            const nextNodeErrors = {};
            let changed = false;
            let removedCount = 0;

            for (const [executionId, nodeError] of Object.entries(nodeErrors)) {
                if (!nodeError || typeof nodeError !== "object") {
                    nextNodeErrors[executionId] = nodeError;
                    continue;
                }

                const classType = String(nodeError?.class_type || "");
                const reasons = Array.isArray(nodeError?.errors) ? nodeError.errors : [];
                if (!reasons.length) {
                    nextNodeErrors[executionId] = nodeError;
                    continue;
                }

                const kept = [];
                for (const reason of reasons) {
                    if (isModelValidationReason(reason, classType)) {
                        removedCount += 1;
                        changed = true;
                        continue;
                    }
                    kept.push(reason);
                }

                if (kept.length) {
                    nextNodeErrors[executionId] =
                        kept.length === reasons.length
                            ? nodeError
                            : { ...nodeError, errors: kept };
                } else {
                    changed = true;
                }
            }

            return {
                changed,
                removedCount,
                nextNodeErrors: Object.keys(nextNodeErrors).length ? nextNodeErrors : null,
            };
        };

        const replaceNodeErrorsInPlace = (target, nextNodeErrors) => {
            if (!target || typeof target !== "object") {
                return false;
            }
            try {
                const next = nextNodeErrors && typeof nextNodeErrors === "object" ? nextNodeErrors : null;
                for (const key of Object.keys(target)) {
                    if (!next || !(key in next)) {
                        delete target[key];
                    }
                }
                if (next) {
                    for (const [key, value] of Object.entries(next)) {
                        target[key] = value;
                    }
                }
                return true;
            } catch (_) {
                return false;
            }
        };

        const applyNodeErrorsFallback = (nodeErrors) => {
            try {
                const registeredNodeTypes = getRegisteredNodeTypesMap();
                forEachGraphNodeRecursive(app?.rootGraph || app?.graph, (node) => {
                    if (!node || typeof node !== "object") return;
                    if (registeredNodeTypes && node.type && !(node.type in registeredNodeTypes)) {
                        return;
                    }
                    node.has_errors = false;
                    
                    if (node.old_color !== undefined) {
                        node.color = node.old_color;
                        delete node.old_color;
                    } else if (typeof node.color === "string" && (node.color.toLowerCase() === "#ff0000" || node.color.toLowerCase() === "red")) {
                        delete node.color;
                    }

                    if (node.old_bgcolor !== undefined) {
                        node.bgcolor = node.old_bgcolor;
                        delete node.old_bgcolor;
                    } else if (typeof node.bgcolor === "string" && (node.bgcolor.toLowerCase() === "#ff0000" || node.bgcolor.toLowerCase() === "red")) {
                        delete node.bgcolor;
                    }

                    const inputs = Array.isArray(node.inputs) ? node.inputs : [];
                    for (const slot of inputs) {
                        if (slot && typeof slot === "object") {
                            delete slot.hasErrors;
                        }
                    }
                });

                if (nodeErrors && typeof nodeErrors === "object") {
                    for (const [executionId, nodeError] of Object.entries(nodeErrors)) {
                        const node = getGraphNodeByExecutionId(executionId);
                        if (!node) {
                            continue;
                        }
                        node.has_errors = true;
                        const reasons = Array.isArray(nodeError?.errors) ? nodeError.errors : [];
                        const inputs = Array.isArray(node.inputs) ? node.inputs : [];
                        for (const reason of reasons) {
                            const inputName = String(reason?.extra_info?.input_name || "").trim();
                            if (!inputName || !inputs.length) continue;
                            const slot = inputs.find((entry) => String(entry?.name || "") === inputName);
                            if (slot) {
                                slot.hasErrors = true;
                            }
                        }
                    }
                }

                if (app?.canvas?.setDirty) {
                    app.canvas.setDirty(true, true);
                } else if (app?.canvas?.draw) {
                    app.canvas.draw(true, true);
                }
            } catch (err) {
                console.warn("[AutoDownload] Error in applyNodeErrorsFallback:", err);
            }
        };

        const clearModelValidationErrorsFromFrontendState = async () => {
            const snapshot = getNodeErrorsSnapshot();
            if (!snapshot) {
                return false;
            }

            const stripped = stripModelValidationErrorsFromNodeErrors(snapshot);
            if (!stripped.changed || stripped.removedCount <= 0) {
                return false;
            }

            // Apply in-place immediately to reduce visible red-frame delay.
            const updatedInPlace = replaceNodeErrorsInPlace(snapshot, stripped.nextNodeErrors);
            if (updatedInPlace) {
                applyNodeErrorsFallback(stripped.nextNodeErrors);
            }

            const executionErrorStore = await resolveExecutionErrorStore();
            if (executionErrorStore) {
                try {
                    executionErrorStore.lastNodeErrors = stripped.nextNodeErrors;
                    if (!stripped.nextNodeErrors) {
                        if (typeof executionErrorStore.dismissErrorOverlay === "function") {
                            executionErrorStore.dismissErrorOverlay();
                        } else if ("isErrorOverlayOpen" in executionErrorStore) {
                            executionErrorStore.isErrorOverlayOpen = false;
                        }
                    }
                } catch (_) {}
            }

            try {
                if (app?.extensionStore && typeof app.extensionStore === "object") {
                    app.extensionStore.lastNodeErrors = stripped.nextNodeErrors;
                }
            } catch (_) {}

            try {
                if (app?.extensionManager && typeof app.extensionManager === "object") {
                    app.extensionManager.lastNodeErrors = stripped.nextNodeErrors;
                }
            } catch (_) {}

            try {
                if (app && typeof app === "object") {
                    app.lastNodeErrors = stripped.nextNodeErrors;
                }
            } catch (_) {}

            return updatedInPlace;
        };



        const clearMissingModelStoreState = async (candidates = []) => {
            if (!Array.isArray(candidates) || !candidates.length) {
                return false;
            }

            const missingModelStore = await resolveMissingModelStore();
            if (!missingModelStore || typeof missingModelStore !== "object") {
                return false;
            }

            let changed = false;
            const widgetCandidates = [];
            const nameCandidates = new Map();

            for (const candidate of candidates) {
                if (!isMissingModelCandidate(candidate)) {
                    continue;
                }
                const nodeId = String(candidate?.nodeId ?? candidate?.node_id ?? "").trim();
                const widgetName = String(candidate?.widgetName || candidate?.input_name || "").trim();
                const modelName = String(candidate?.name || candidate?.filename || "").trim();

                if (nodeId && widgetName) {
                    widgetCandidates.push({ nodeId, widgetName });
                    continue;
                }

                if (nodeId && modelName) {
                    if (!nameCandidates.has(modelName)) {
                        nameCandidates.set(modelName, new Set());
                    }
                    nameCandidates.get(modelName).add(nodeId);
                }
            }

            try {
                for (const entry of widgetCandidates) {
                    if (typeof missingModelStore.removeMissingModelByWidget === "function") {
                        missingModelStore.removeMissingModelByWidget(entry.nodeId, entry.widgetName);
                        changed = true;
                    }
                }

                for (const [modelName, nodeIds] of nameCandidates.entries()) {
                    if (
                        typeof missingModelStore.removeMissingModelByNameOnNodes === "function" &&
                        nodeIds.size
                    ) {
                        missingModelStore.removeMissingModelByNameOnNodes(modelName, nodeIds);
                        changed = true;
                    }
                }
            } catch (_) {
                // Fall back to a full clear below.
            }

            const remainingSignature = buildMissingModelCandidatesSignature(
                unwrapStoreValue(missingModelStore?.missingModelCandidates) || []
            );
            if (
                remainingSignature &&
                remainingSignature === buildMissingModelCandidatesSignature(candidates) &&
                typeof missingModelStore.clearMissingModels === "function"
            ) {
                try {
                    missingModelStore.clearMissingModels();
                    changed = true;
                } catch (_) {
                    // Ignore store clear failures.
                }
            }

            const executionErrorStore = await resolveExecutionErrorStore();
            if (executionErrorStore) {
                try {
                    const hasErrors = unwrapStoreValue(executionErrorStore.hasAnyError);
                    if (!hasErrors) {
                        if (typeof executionErrorStore.dismissErrorOverlay === "function") {
                            executionErrorStore.dismissErrorOverlay();
                        } else if ("isErrorOverlayOpen" in executionErrorStore) {
                            executionErrorStore.isErrorOverlayOpen = false;
                        }
                    }
                } catch (_) {
                    // Ignore overlay clear failures.
                }
            }

            return changed;
        };

        const clearCompletedModelsFromStore = async (filenamesOrPaths) => {
            const list = Array.isArray(filenamesOrPaths) ? filenamesOrPaths : [filenamesOrPaths];
            const validList = list.filter(Boolean);
            if (!validList.length) return false;

            const normalizedBases = validList.map(f => String(f).split(/[/\\]/).pop().trim().toLowerCase());

            const filterCandidates = (candidates) => {
                if (!Array.isArray(candidates)) return [];
                return candidates.filter((c) => {
                    const candidateName = String(c?.name || "").trim().toLowerCase();
                    const candidateFile = String(c?.filename || "").trim().toLowerCase();
                    const candBaseName = candidateName.split(/[/\\]/).pop().trim();
                    const candBaseFile = candidateFile.split(/[/\\]/).pop().trim();
                    if (normalizedBases.includes(candidateName) || normalizedBases.includes(candidateFile) ||
                        normalizedBases.includes(candBaseName) || normalizedBases.includes(candBaseFile)) {
                        return false;
                    }
                    const fullNormalizedList = validList.map(f => String(f).trim().toLowerCase().replace(/\\/g, "/"));
                    const candDir = String(c?.directory || c?.folder || "").trim().toLowerCase().replace(/\\/g, "/");
                    if (candDir) {
                        for (const fullNormalized of fullNormalizedList) {
                            if (fullNormalized.endsWith(candDir + "/" + candidateName)) {
                                return false;
                            }
                        }
                    }
                    return true;
                });
            };

            let changed = false;

            // 1. Clear from missingModelStore
            try {
                const missingModelStore = await resolveMissingModelStore();
                if (missingModelStore) {
                    const candidates = unwrapStoreValue(missingModelStore.missingModelCandidates);
                    if (Array.isArray(candidates) && candidates.length) {
                        const nextCandidates = filterCandidates(candidates);
                        if (nextCandidates.length !== candidates.length) {
                            changed = true;
                            if (nextCandidates.length === 0) {
                                if (typeof missingModelStore.clearMissingModels === "function") {
                                    try { missingModelStore.clearMissingModels(); } catch (e) {}
                                } else if ("value" in missingModelStore.missingModelCandidates) {
                                    missingModelStore.missingModelCandidates.value = null;
                                } else {
                                    missingModelStore.missingModelCandidates = null;
                                }
                            } else {
                                if (typeof missingModelStore.setMissingModels === "function") {
                                    try { missingModelStore.setMissingModels(nextCandidates); } catch (e) {}
                                } else if ("value" in missingModelStore.missingModelCandidates) {
                                    missingModelStore.missingModelCandidates.value = nextCandidates;
                                } else {
                                    missingModelStore.missingModelCandidates = nextCandidates;
                                }
                            }
                        }
                    }
                    
                    const missingNodeModelsObj = unwrapStoreValue(missingModelStore.missingNodeModels);
                    if (missingNodeModelsObj && typeof missingNodeModelsObj === "object") {
                        for (const [nodeId, models] of Object.entries(missingNodeModelsObj)) {
                            if (Array.isArray(models)) {
                                const originalLength = models.length;
                                const filtered = models.filter((m) => {
                                    const base = String(m).split(/[/\\]/).pop().trim().toLowerCase();
                                    return !normalizedBases.includes(base);
                                });
                                if (filtered.length !== originalLength) {
                                    changed = true;
                                    missingNodeModelsObj[nodeId] = filtered;
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn("[AutoDownload] Error clearing missingModelStore candidates:", e);
            }

            // 2. Clear from activeWorkflow and all open workflows in workflowStore
            try {
                const workflowStore = unwrapStoreValue(app?.extensionManager?.workflow);
                const workflows = [];
                if (workflowStore) {
                    if (workflowStore.activeWorkflow) {
                        workflows.push(workflowStore.activeWorkflow);
                    }
                    const storeWorkflows = unwrapStoreValue(workflowStore.workflows);
                    if (Array.isArray(storeWorkflows)) {
                        for (const wf of storeWorkflows) {
                            if (wf && !workflows.includes(wf)) {
                                workflows.push(wf);
                            }
                        }
                    } else if (storeWorkflows && typeof storeWorkflows === "object") {
                        for (const wf of Object.values(storeWorkflows)) {
                            if (wf && !workflows.includes(wf)) {
                                workflows.push(wf);
                            }
                        }
                    }
                }

                for (const wf of workflows) {
                    try {
                        const pendingWarnings = unwrapStoreValue(wf?.pendingWarnings);
                        if (pendingWarnings) {
                            const candidates = unwrapStoreValue(pendingWarnings.missingModelCandidates);
                            if (Array.isArray(candidates) && candidates.length) {
                                const nextCandidates = filterCandidates(candidates);
                                if (nextCandidates.length !== candidates.length) {
                                    changed = true;
                                    if (nextCandidates.length === 0) {
                                        if ("value" in pendingWarnings.missingModelCandidates) {
                                            pendingWarnings.missingModelCandidates.value = null;
                                        } else {
                                            pendingWarnings.missingModelCandidates = null;
                                        }
                                    } else {
                                        if ("value" in pendingWarnings.missingModelCandidates) {
                                            pendingWarnings.missingModelCandidates.value = nextCandidates;
                                        } else {
                                            pendingWarnings.missingModelCandidates = nextCandidates;
                                        }
                                    }
                                }
                            }
                        }
                    } catch (_) {}
                }
            } catch (e) {
                console.warn("[AutoDownload] Error clearing workflow pending warnings:", e);
            }

            if (changed) {
                // Dismiss error overlay if no more missing models or execution/node errors
                try {
                    const executionErrorStore = await resolveExecutionErrorStore();
                    if (executionErrorStore) {
                        const hasErrors = unwrapStoreValue(executionErrorStore.hasAnyError);
                        if (!hasErrors) {
                            if (typeof executionErrorStore.dismissErrorOverlay === "function") {
                                executionErrorStore.dismissErrorOverlay();
                            } else if ("isErrorOverlayOpen" in executionErrorStore) {
                                executionErrorStore.isErrorOverlayOpen = false;
                            }
                        }
                    }
                } catch (_) {}
            }

            return changed;
        };

        const buildMissingModelCandidatesSignature = (candidates = []) => {
            if (!Array.isArray(candidates) || !candidates.length) {
                return "";
            }
            const parts = [];
            for (const candidate of candidates) {
                if (!isMissingModelCandidate(candidate)) {
                    continue;
                }
                if (isFrontendMissingModelCandidateBypassed(candidate)) {
                    continue;
                }
                parts.push([
                    String(candidate?.directory || candidate?.folder || "").trim().toLowerCase(),
                    String(candidate?.name || candidate?.filename || "").trim().toLowerCase(),
                    String(candidate?.url || "").trim().toLowerCase(),
                    String(candidate?.widgetName || candidate?.input_name || "").trim().toLowerCase(),
                    String(candidate?.nodeId ?? candidate?.node_id ?? "").trim().toLowerCase(),
                ].join("|"));
            }
            parts.sort();
            return parts.join("||");
        };

        const clearMissingModelNodeHighlights = (candidates = []) => {
            if (!Array.isArray(candidates) || !candidates.length) {
                return 0;
            }

            const nodeInputNames = new Map();
            for (const candidate of candidates) {
                if (!isMissingModelCandidate(candidate)) {
                    continue;
                }
                const executionId = String(candidate?.nodeId ?? candidate?.node_id ?? "").trim();
                if (!executionId) {
                    continue;
                }
                if (!nodeInputNames.has(executionId)) {
                    nodeInputNames.set(executionId, new Set());
                }
                const inputName = String(candidate?.widgetName || candidate?.input_name || "").trim();
                if (inputName) {
                    nodeInputNames.get(executionId).add(inputName);
                }
            }

            if (!nodeInputNames.size) {
                return 0;
            }

            let clearedCount = 0;
            forEachGraphNodeRecursive(app?.rootGraph || app?.graph, (node) => {
                const rawNodeId = String(node?.id ?? "").trim();
                if (!rawNodeId) {
                    return;
                }
                const matchedExecutionIds = [];
                for (const executionId of nodeInputNames.keys()) {
                    if (executionId === rawNodeId || executionId.endsWith(`:${rawNodeId}`)) {
                        matchedExecutionIds.push(executionId);
                    }
                }
                if (!matchedExecutionIds.length) {
                    return;
                }

                clearedCount += 1;
                node.has_errors = false;

                const targetInputNames = new Set();
                for (const executionId of matchedExecutionIds) {
                    const names = nodeInputNames.get(executionId);
                    if (!names) {
                        continue;
                    }
                    for (const name of names) {
                        targetInputNames.add(name);
                    }
                }
                const inputs = Array.isArray(node.inputs) ? node.inputs : [];
                for (const slot of inputs) {
                    if (!slot || typeof slot !== "object") {
                        continue;
                    }
                    if (!targetInputNames.size) {
                        delete slot.hasErrors;
                        continue;
                    }
                    const slotName = String(slot?.name || "").trim();
                    if (!slotName || targetInputNames.has(slotName)) {
                        delete slot.hasErrors;
                    }
                }
            });

            if (clearedCount > 0) {
                if (app?.canvas?.setDirty) {
                    app.canvas.setDirty(true, true);
                } else if (app?.canvas?.draw) {
                    app.canvas.draw(true, true);
                }
            }
            return clearedCount;
        };

        const getDefaultGraphReference = () => {
            try {
                const dgNamespace = window?.comfyAPI?.defaultGraph;
                if (dgNamespace?.defaultGraph && typeof dgNamespace.defaultGraph === "object") {
                    return dgNamespace.defaultGraph;
                }
                if (typeof dgNamespace?.defaultGraphJSON === "string" && dgNamespace.defaultGraphJSON.trim()) {
                    const parsed = JSON.parse(dgNamespace.defaultGraphJSON);
                    if (parsed && typeof parsed === "object") {
                        return parsed;
                    }
                }
            } catch (_) {}
            return null;
        };

        const normalizeDefaultWorkflowNodeSignature = (node) => {
            if (!node || typeof node !== "object") {
                return "";
            }
            const type = String(node.type || "").trim();
            const widgets = node.widgets_values !== undefined ? node.widgets_values : null;
            let widgetsJson = "null";
            try {
                widgetsJson = JSON.stringify(widgets);
            } catch (_) {}
            return `${type}::${widgetsJson}`;
        };

        const isComfyDefaultWorkflow = (graphData) => {
            if (!graphData || typeof graphData !== "object" || !Array.isArray(graphData.nodes) || graphData.nodes.length === 0) {
                return false;
            }

            const defaultRef = getDefaultGraphReference();
            if (defaultRef && Array.isArray(defaultRef.nodes) && defaultRef.nodes.length === graphData.nodes.length) {
                const refById = new Map();
                for (const refNode of defaultRef.nodes) {
                    if (refNode && refNode.id !== undefined && refNode.id !== null) {
                        refById.set(String(refNode.id), normalizeDefaultWorkflowNodeSignature(refNode));
                    }
                }
                if (refById.size === defaultRef.nodes.length) {
                    let allMatchById = true;
                    for (const node of graphData.nodes) {
                        const key = node?.id !== undefined && node?.id !== null ? String(node.id) : "";
                        if (!key || refById.get(key) !== normalizeDefaultWorkflowNodeSignature(node)) {
                            allMatchById = false;
                            break;
                        }
                    }
                    if (allMatchById) {
                        return true;
                    }
                }

                const refSorted = defaultRef.nodes.map(normalizeDefaultWorkflowNodeSignature).sort();
                const graphSorted = graphData.nodes.map(normalizeDefaultWorkflowNodeSignature).sort();
                if (refSorted.every((sig, idx) => sig === graphSorted[idx])) {
                    return true;
                }
            }

            if (graphData.nodes.length === 7) {
                const types = graphData.nodes.map((n) => String(n?.type || "").trim()).sort();
                const expectedTypes = [
                    "CLIPTextEncode",
                    "CLIPTextEncode",
                    "CheckpointLoaderSimple",
                    "EmptyLatentImage",
                    "KSampler",
                    "SaveImage",
                    "VAEDecode",
                ];
                if (types.every((t, idx) => t === expectedTypes[idx])) {
                    const ckptNode = graphData.nodes.find((n) => n?.type === "CheckpointLoaderSimple");
                    const ckptVal = Array.isArray(ckptNode?.widgets_values)
                        ? String(ckptNode.widgets_values[0] || "").trim().toLowerCase()
                        : "";
                    if (
                        ckptVal === "v1-5-pruned-emaonly-fp16.safetensors" ||
                        ckptVal === "v1-5-pruned-emaonly.safetensors" ||
                        ckptVal === "v1-5-pruned-emaonly.ckpt"
                    ) {
                        return true;
                    }
                }
            }

            return false;
        };

        const triggerAutoDownloadFromWorkflowOpen = async (candidates = [], workflowGraphData = null, extraOpts = {}) => {
            const myGen = currentWorkflowLoadGeneration;
            if (workflowOpenTriggeredForCurrentLoad) {
                return false;
            }
            if (workflowGraphData ? isComfyDefaultWorkflow(workflowGraphData) : isLiveGraphDefaultWorkflow(app?.rootGraph)) {
                return false;
            }
            const workflowOpenCandidates = Array.isArray(candidates)
                ? candidates
                    .filter((candidate) => isMissingModelCandidate(candidate))
                    .map((candidate) => ({ ...candidate }))
                : [];
            const hasLiveNodes = Array.isArray(app?.rootGraph?.nodes) && app.rootGraph.nodes.length > 0;
            const liveValues = hasLiveNodes ? collectAllLiveWidgetValues() : new Set();
            const bypassedWorkflowOpenCandidates = workflowOpenCandidates.filter((candidate) =>
                isFrontendMissingModelCandidateBypassed(candidate) ||
                (hasLiveNodes && isPendingCandidateStaleInLiveGraph(candidate, liveValues))
            );
            const activeWorkflowOpenCandidates = workflowOpenCandidates.filter((candidate) =>
                !isFrontendMissingModelCandidateBypassed(candidate) &&
                !(hasLiveNodes && isPendingCandidateStaleInLiveGraph(candidate, liveValues))
            );
            if (bypassedWorkflowOpenCandidates.length) {
                clearMissingModelNodeHighlights(bypassedWorkflowOpenCandidates);
                void clearMissingModelStoreState(bypassedWorkflowOpenCandidates);
            }
            if (!activeWorkflowOpenCandidates.length) {
                void clearModelValidationErrorsFromFrontendState();
                return false;
            }

            clearMissingModelNodeHighlights(activeWorkflowOpenCandidates);
            void clearModelValidationErrorsFromFrontendState();

            const frontendMissingEntries =
                await createRunHookFallbackMissingModelsFromFrontendStore(activeWorkflowOpenCandidates);
            if (myGen !== currentWorkflowLoadGeneration) {
                return false;
            }
            if (!frontendMissingEntries.length) {
                void applyResolvedFrontendMissingModelState(workflowOpenCandidates, [], []);
                return false;
            }

            if (myGen !== currentWorkflowLoadGeneration) {
                return false;
            }
            removeExistingAutoDownloadDialog();
            workflowOpenLastTriggeredAt = Date.now();
            workflowOpenTriggeredForCurrentLoad = true;
            const runAction = window?.hfDownloader?.runAutoDownload;
            if (typeof runAction === "function") {
                runAction(new Set(), false, {
                    suppressEmptyResults: true,
                    triggeredByWorkflowOpen: true,
                    frontendMissingModelCandidates: activeWorkflowOpenCandidates,
                    reason: "workflow-open-missing-models",
                    ...extraOpts,
                });
                return true;
            }

            const resultsToShow = {
                request_id: `workflow_open_${Date.now()}`,
                missing: frontendMissingEntries,
                found: [],
                mismatches: [],
            };
            showResultsDialog(
                resultsToShow,
                {
                    suppressEmptyResults: true,
                    triggeredByWorkflowOpen: true,
                    frontendMissingModelCandidates: activeWorkflowOpenCandidates,
                    reason: "workflow-open-missing-models",
                    ...extraOpts,
                }
            );
            return true;
        };

        const getWorkflowOpenBackendResults = async (graphData = null, expectedGeneration = currentWorkflowLoadGeneration) => {
            if (expectedGeneration !== currentWorkflowLoadGeneration) {
                return null;
            }
            if (!graphData || typeof graphData !== "object") {
                return null;
            }
            if (!workflowLikelyContainsModelReferences(graphData)) {
                return null;
            }

            const controller =
                typeof AbortController !== "undefined" ? new AbortController() : null;
            const timeoutId = controller
                ? setTimeout(() => controller.abort(), 4000)
                : null;

            try {
                const requestPayload = {
                    ...graphData,
                    request_id: `workflow-open-preflight-${Date.now()}`,
                    skip_hf_search: true,
                };
                const resp = api && typeof api.fetchApi === "function"
                    ? await api.fetchApi("/check_missing_models", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(requestPayload),
                        signal: controller?.signal,
                    })
                    : await fetch("/check_missing_models", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(requestPayload),
                        signal: controller?.signal,
                    });
                if (expectedGeneration !== currentWorkflowLoadGeneration) {
                    return null;
                }
                if (resp.status !== 200) {
                    return null;
                }
                const data = await resp.json();
                if (expectedGeneration !== currentWorkflowLoadGeneration) {
                    return null;
                }
                const rawMismatches = Array.isArray(data?.mismatches)
                    ? data.mismatches
                    : (Array.isArray(data?.path_mismatches) ? data.path_mismatches : []);
                const autoFix = autoApplyPathMismatches(rawMismatches);
                if (autoFix.fixedRows > 0) {
                    showToast({
                        severity: "info",
                        summary: "Model paths auto-fixed",
                        detail: `Updated ${autoFix.fixedRefs} loader reference${autoFix.fixedRefs === 1 ? "" : "s"} to installed model paths.`,
                        life: 3200,
                    });
                }
                const filteredMissing = filterRunHookEligibleMissingModels(
                    Array.isArray(data?.missing) ? data.missing : []
                );
                void syncResolvedUrlsIntoNativeMissingModelStore(filteredMissing);
                return {
                    request_id: data?.request_id || `workflow_open_backend_${Date.now()}`,
                    missing: filteredMissing,
                    found: Array.isArray(data?.found) ? data.found : [],
                    mismatches: autoFix.remaining,
                };
            } catch (_) {
                return null;
            } finally {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            }
        };

        // Per-tab memoization cache keyed by workflow path -> { revKey, dismissed, candidatesSig }
        const workflowScanCache = new Map();
        let isLoadingWorkflow = false;
        let postSettleScanTimer = null;

        const getTabCacheKey = () =>
            String(getActiveWorkflowStableKey() || getActiveWorkflowPathKey() || "__default__").trim();

        const markCurrentTabDismissed = (tabKey, revKey) => {
            if (!tabKey) return;
            const existing = workflowScanCache.get(tabKey) || {};
            workflowScanCache.set(tabKey, {
                ...existing,
                revKey: revKey || existing.revKey || "",
                dismissed: true,
            });
        };

        const runUncachedFallbackBackendScan = async (expectedGeneration, tabKey, revKey) => {
            if (expectedGeneration !== currentWorkflowLoadGeneration) return;
            if (!getWorkflowOpenAutoEnabled() || !isWorkflowReadyForModelScan()) return;
            if (isLiveGraphDefaultWorkflow(app?.rootGraph)) return;
            if (document.getElementById("auto-download-dialog") || typeof activeAutoDownloadCancel === "function") return;

            const cachedEntry = workflowScanCache.get(tabKey);
            if (cachedEntry && cachedEntry.revKey === revKey) {
                return;
            }

            // Fast zero-clone check of live graph widgets first (catches un-embedded custom loaders / HF download nodes)
            const liveCandidates = collectLiveGraphMissingModelCandidatesNativeLike(app?.rootGraph, null);
            if (expectedGeneration !== currentWorkflowLoadGeneration) return;

            if (liveCandidates.length > 0) {
                workflowScanCache.set(tabKey, { revKey, dismissed: false, handled: true });
                await triggerAutoDownloadFromWorkflowOpen(liveCandidates, null, {
                    onUserDismiss: () => markCurrentTabDismissed(tabKey, revKey),
                });
                return;
            }

            // Quick local heuristic check before incurring graph serialize + /check_missing_models
            const workflow = serializeWorkflowForModelScan();
            if (!workflow || isComfyDefaultWorkflow(workflow)) {
                workflowScanCache.set(tabKey, { revKey, dismissed: false, handled: true });
                return;
            }
            if (!workflowLikelyContainsModelReferences(workflow)) {
                workflowScanCache.set(tabKey, { revKey, dismissed: false, handled: true });
                return;
            }

            const backendResults = await getWorkflowOpenBackendResults(workflow, expectedGeneration);
            if (expectedGeneration !== currentWorkflowLoadGeneration) return;

            workflowScanCache.set(tabKey, { revKey, dismissed: false, handled: true });
            const backendTargetCount = countDownloadRequiredScanResults(backendResults || {});
            const backendSignature = backendTargetCount > 0 ? buildScanResultsSignature(backendResults) : "";
            if (!backendSignature || workflowOpenTriggeredForCurrentLoad) return;

            workflowOpenLastHandledSignature = backendSignature;
            workflowOpenLastHandledPath = tabKey;
            workflowOpenTriggeredForCurrentLoad = true;
            removeExistingAutoDownloadDialog();
            showResultsDialog(backendResults, {
                suppressEmptyResults: true,
                triggeredByWorkflowOpen: true,
                reason: "workflow-open-missing-models",
                onUserDismiss: () => markCurrentTabDismissed(tabKey, revKey),
            });
        };

        const handleNativeMissingCandidates = (candidates = []) => {
            const list = Array.isArray(candidates) ? candidates : [];
            if (!list.length) return false;
            if (!getWorkflowOpenAutoEnabled()) return false;

            const tabKey = getTabCacheKey();
            const revKey = computeLiveGraphRevisionKey(app?.rootGraph);
            const cached = workflowScanCache.get(tabKey);
            const sig = buildMissingModelCandidatesSignature(list);

            if (
                cached &&
                cached.revKey === revKey &&
                (cached.dismissed || (sig && sig === cached.candidatesSig))
            ) {
                return false;
            }
            if (
                sig &&
                sig === workflowOpenLastHandledSignature &&
                (!tabKey || tabKey === workflowOpenLastHandledPath)
            ) {
                return false;
            }

            workflowOpenLastHandledSignature = sig;
            workflowOpenLastHandledPath = tabKey;
            workflowScanCache.set(tabKey, {
                revKey,
                dismissed: false,
                handled: true,
                candidatesSig: sig,
            });
            void triggerAutoDownloadFromWorkflowOpen(list, null, {
                onUserDismiss: () => markCurrentTabDismissed(tabKey, revKey),
            });
            return true;
        };

        // Native ComfyUI lifecycle hooks (zero setInterval, zero loadGraphData monkey-patching)
        extensionLifecycleHandlers.beforeLoadGraph = () => {
            isLoadingWorkflow = true;
            currentWorkflowLoadGeneration += 1;
            if (postSettleScanTimer) {
                clearTimeout(postSettleScanTimer);
                postSettleScanTimer = null;
            }
            abortActiveAutoDownloadForTabSwitch();
            workflowOpenLastTriggeredAt = 0;
            workflowOpenLastHandledSignature = "";
            workflowOpenLastHandledPath = "";
            workflowOpenTriggeredForCurrentLoad = false;
        };

        extensionLifecycleHandlers.loadedGraphNode = (node) => {
            try {
                const graph = node?.graph || app?.rootGraph;
                alignNodeWidgetSlashes(node, graph);
                syncNodeDownloaderLinkedWidgets(node, graph);
            } catch (_) {}
        };

        extensionLifecycleHandlers.afterLoadGraph = () => {
            isLoadingWorkflow = false;
            const loadGen = currentWorkflowLoadGeneration;
            const tabKey = getTabCacheKey();
            lastObservedActiveWorkflowKey = tabKey;
            const revKey = computeLiveGraphRevisionKey(app?.rootGraph);
            const cachedEntry = workflowScanCache.get(tabKey);

            // Fast exit on already-scanned tabs (e.g. switching tabs with skipAssetScans: true)
            if (cachedEntry && cachedEntry.revKey === revKey) {
                return;
            }

            if (postSettleScanTimer) {
                clearTimeout(postSettleScanTimer);
            }
            postSettleScanTimer = setTimeout(() => {
                postSettleScanTimer = null;
                if (loadGen !== currentWorkflowLoadGeneration) return;
                if (workflowOpenTriggeredForCurrentLoad) {
                    return;
                }
                const nativeCandidates = cachedNativeMissingCandidates.length
                    ? cachedNativeMissingCandidates
                    : getMissingModelCandidates();
                if (nativeCandidates.length > 0) {
                    cachedNativeMissingCandidates = nativeCandidates;
                    syncMissingModelsObserverWithStore(true);
                    void enrichNativeMissingModelStoreFromCatalog();
                    if (handleNativeMissingCandidates(nativeCandidates)) {
                        return;
                    }
                }
                void runUncachedFallbackBackendScan(loadGen, tabKey, revKey);
            }, 140);
        };

        let inFlightModelRefreshPromise = null;
        const recentlyRefreshedModelKeys = new Map();
        const MODEL_REFRESH_DEDUPE_TTL_MS = 4000;

        const normalizeRefreshModelKey = (value) => {
            const norm = normalizeWorkflowPath(value || "").toLowerCase();
            if (!norm) return "";
            return getPathBasename(norm).toLowerCase() || norm;
        };

        const runSingleModelRefresh = async (paths = []) => {
            const pathList = (Array.isArray(paths) ? paths : [paths])
                .map((p) => String(p || "").trim())
                .filter(Boolean);

            if (pathList.length > 0) {
                try {
                    const cleared = await clearCompletedModelsFromStore(pathList);
                    if (cleared) {
                        await clearModelValidationErrorsFromFrontendState();
                    }
                } catch (e) {
                    console.warn("[AutoDownload] Error clearing completed model from store:", e);
                }
            } else {
                try {
                    await clearModelValidationErrorsFromFrontendState();
                } catch (_) {}
            }

            if (app && typeof app.refreshComboInNodes === "function") {
                try {
                    await app.refreshComboInNodes();
                } catch (e) {}
            }

            // Let ComfyUI discover the downloaded file natively
            const missingModelStore = await resolveMissingModelStore();
            if (missingModelStore && typeof missingModelStore.refreshMissingModels === "function") {
                try {
                    await missingModelStore.refreshMissingModels({ silent: true });
                } catch (e) {
                    console.warn("[AutoDownload] Failed to run store.refreshMissingModels:", e);
                }
            } else if (app && typeof app.refreshMissingModels === "function") {
                try {
                    await app.refreshMissingModels({ silent: true });
                } catch (e) {
                    console.warn("[AutoDownload] Failed to run native refreshMissingModels:", e);
                }
            }

            // Clean up any remaining stale visual red frames
            const currentErrors = (typeof getNodeErrorsSnapshot === "function") ? getNodeErrorsSnapshot() : {};
            const registeredNodeTypes = (typeof getRegisteredNodeTypesMap === "function") ? getRegisteredNodeTypesMap() : null;
            if (typeof forEachGraphNodeRecursive === "function") {
                forEachGraphNodeRecursive(app?.rootGraph || app?.graph, (node) => {
                    if (!node || typeof node !== "object") return;
                    if (registeredNodeTypes && node.type && !(node.type in registeredNodeTypes)) {
                        return;
                    }
                    const execId = String(node.id || "");
                    if (currentErrors && currentErrors[execId]) {
                        return;
                    }
                    if (node.has_errors) {
                        node.has_errors = false;
                    }
                    if (node.old_color !== undefined) {
                        node.color = node.old_color;
                        delete node.old_color;
                    } else if (typeof node.color === "string" && (node.color.toLowerCase() === "#ff0000" || node.color.toLowerCase() === "red")) {
                        delete node.color;
                    }

                    if (node.old_bgcolor !== undefined) {
                        node.bgcolor = node.old_bgcolor;
                        delete node.old_bgcolor;
                    } else if (typeof node.bgcolor === "string" && (node.bgcolor.toLowerCase() === "#ff0000" || node.bgcolor.toLowerCase() === "red")) {
                        delete node.bgcolor;
                    }
                });
            }
            if (app?.graph && typeof app.graph.setDirtyCanvas === "function") {
                app.graph.setDirtyCanvas(true, true);
            }
            if (app?.canvas?.setDirty) {
                app.canvas.setDirty(true, true);
            }
        };

        const refreshAfterModelDownload = async (paths = []) => {
            const rawList = (Array.isArray(paths) ? paths : [paths])
                .map((p) => String(p || "").trim())
                .filter(Boolean);
            const openAutoDownloadDlg = document.getElementById("auto-download-dialog");
            if (openAutoDownloadDlg && typeof openAutoDownloadDlg.__hfPruneCompletedModels === "function") {
                openAutoDownloadDlg.__hfPruneCompletedModels(rawList);
            }

            const now = Date.now();
            for (const [k, ts] of recentlyRefreshedModelKeys.entries()) {
                if (now - ts > MODEL_REFRESH_DEDUPE_TTL_MS) {
                    recentlyRefreshedModelKeys.delete(k);
                }
            }

            const keys = rawList.map(normalizeRefreshModelKey).filter(Boolean);
            if (keys.length > 0 && keys.every((k) => recentlyRefreshedModelKeys.has(k))) {
                if (inFlightModelRefreshPromise) {
                    await inFlightModelRefreshPromise;
                }
                return false;
            }
            for (const k of keys) {
                recentlyRefreshedModelKeys.set(k, now);
            }
            if (keys.length === 0) {
                if (recentlyRefreshedModelKeys.has("__generic__")) {
                    if (inFlightModelRefreshPromise) {
                        await inFlightModelRefreshPromise;
                    }
                    return false;
                }
                recentlyRefreshedModelKeys.set("__generic__", now);
            }

            const prevPromise = inFlightModelRefreshPromise;
            const currentPromise = (async () => {
                if (prevPromise) {
                    try {
                        await prevPromise;
                    } catch (_) {}
                }
                await runSingleModelRefresh(rawList);
            })();
            inFlightModelRefreshPromise = currentPromise;
            try {
                await currentPromise;
                return true;
            } finally {
                if (inFlightModelRefreshPromise === currentPromise) {
                    inFlightModelRefreshPromise = null;
                }
            }
        };

        const installReactiveMissingModelSubscription = () => {
            subscribeMissingModels((candidates) => {
                const list = Array.isArray(candidates) ? candidates : [];
                cachedNativeMissingCandidates = list;
                syncMissingModelsObserverWithStore(list.length > 0);
                if (list.length > 0) {
                    void enrichNativeMissingModelStoreFromCatalog();
                }

                if (isLoadingWorkflow || !list.length) {
                    return;
                }

                handleNativeMissingCandidates(list);
            }, { immediate: true });

            subscribeRightSidePanel(() => {
                const hasCandidates =
                    cachedNativeMissingCandidates.length > 0 ||
                    getMissingModelCandidates().length > 0 ||
                    Boolean(document.querySelector(MISSING_MODELS_LIST_SELECTOR));
                if (!hasCandidates) return;

                void enrichNativeMissingModelStoreFromCatalog();
                if (typeof requestAnimationFrame === "function") {
                    requestAnimationFrame(() => syncMissingModelsObserverWithStore(true));
                } else {
                    syncMissingModelsObserverWithStore(true);
                }
                setTimeout(() => {
                    syncMissingModelsObserverWithStore(true);
                }, 120);
            }, { immediate: true });
        };

        const installApiValidationAndDownloadListeners = () => {
            const triggerRunHookFromErrorState = (nodeErrorsSnapshot = null, forceFromMissingStore = false) => {
                const settingsUi = app?.ui?.settings;
                const disableRedFrames = settingsUi?.getSettingValue("downloader.disable_missing_model_red_frames") === true;
                if (disableRedFrames) {
                    setTimeout(() => {
                        void clearModelValidationErrorsFromFrontendState();
                    }, 80);
                }

                // Option 2B: Do not intercept queuePrompt; react to native validation/execution error events & store state.
                if (!getRunHookEnabled()) return;
                if (document.getElementById("auto-download-dialog") || typeof activeAutoDownloadCancel === "function") {
                    return;
                }
                const now = Date.now();
                if (now - runHookLastTriggeredAt < RUN_HOOK_COOLDOWN_MS) {
                    return;
                }

                const nodeErrors = nodeErrorsSnapshot || getNodeErrorsSnapshot();
                const failures = getNativeModelValidationFailures(nodeErrors);
                const hasMissingStoreCandidates = Boolean(
                    forceFromMissingStore ||
                    cachedNativeMissingCandidates.length > 0 ||
                    getMissingModelCandidates().length > 0
                );
                if (!failures.length && !hasMissingStoreCandidates) {
                    return;
                }

                runHookLastTriggeredAt = now;
                suppressNativeErrorOverlay();
                void clearModelValidationErrorsFromFrontendState();
                void runAutoDownload(new Set(), false, {
                    suppressEmptyResults: true,
                    triggeredByRunHook: true,
                    reason: "model-validation",
                    runHookFailures: failures,
                });
            };

            const handleValidationEvent = (event) => {
                const detail = event?.detail;
                triggerRunHookFromErrorState(detail?.node_errors || getNodeErrorsSnapshot(), false);
            };

            let prevOverlayOpen = false;
            subscribeExecutionErrors((snapshot) => {
                const isOpen = Boolean(snapshot?.isErrorOverlayOpen);
                const openedNow = isOpen && !prevOverlayOpen;
                prevOverlayOpen = isOpen;
                if (isLoadingWorkflow) return;

                if (openedNow || snapshot?.fromAction) {
                    const hasMissing = Boolean(
                        snapshot?.hasMissingError ||
                        cachedNativeMissingCandidates.length > 0 ||
                        getMissingModelCandidates().length > 0
                    );
                    triggerRunHookFromErrorState(
                        snapshot?.lastNodeErrors || snapshot?.surfacedNodeErrors || null,
                        hasMissing
                    );
                }
            }, { immediate: false });

            if (api && typeof api.addEventListener === "function") {
                api.addEventListener("validation_error", handleValidationEvent);
                api.addEventListener("execution_error", handleValidationEvent);

                api.addEventListener("hf_download_finished", (event) => {
                    workflowScanCache.clear();
                    const path = event.detail?.path;
                    void refreshAfterModelDownload(path ? [path] : []);
                });
            }
        };

        const installEventDrivenUnbypassHook = () => {
            const nodeCtor = globalThis?.LiteGraph?.LGraphNode || window?.LiteGraph?.LGraphNode;
            if (!nodeCtor || !nodeCtor.prototype || typeof nodeCtor.prototype.changeMode !== "function") {
                return false;
            }
            const HOOK_SYM = Symbol.for("hfAutoDownloadChangeModeHook");
            if (nodeCtor.prototype[HOOK_SYM]) {
                return true;
            }

            const pendingNodes = new Set();
            let unbypassTimer = null;
            let unbypassBusy = false;

            const flushUnbypassedNodes = async () => {
                unbypassTimer = null;
                const unbypassedNodes = Array.from(pendingNodes).filter(
                    (n) => n && typeof n === "object" && !isGraphNodeBypassed(n)
                );
                pendingNodes.clear();

                if (!unbypassedNodes.length || isLoadingWorkflow) return;
                if (!getWorkflowOpenAutoEnabled()) return;
                if (unbypassBusy) return;
                if (document.getElementById("auto-download-dialog") || typeof activeAutoDownloadCancel === "function") {
                    return;
                }

                const rootGraph = app?.rootGraph || app?.graph;
                if (!rootGraph || typeof rootGraph !== "object") return;

                unbypassBusy = true;
                try {
                    const genAtTrigger = currentWorkflowLoadGeneration;
                    const tabKey = getTabCacheKey();
                    workflowScanCache.delete(tabKey);

                    const allLiveMissing = collectLiveGraphMissingModelCandidatesNativeLike(rootGraph, null);
                    const unbypassedIds = new Set(
                        unbypassedNodes.map((n) => String(n?.id ?? "").trim()).filter(Boolean)
                    );
                    const unbypassedMissing = allLiveMissing.filter((c) => {
                        const cid = String(c?.nodeId ?? c?.node_id ?? "").trim();
                        const localCid = cid.includes(":") ? cid.split(":").pop() : cid;
                        return (cid && unbypassedIds.has(cid)) || (localCid && unbypassedIds.has(localCid));
                    });

                    const candidatesToCheck = unbypassedMissing.length > 0 ? unbypassedMissing : allLiveMissing;
                    if (candidatesToCheck.length > 0) {
                        await runAutoDownload(new Set(), false, {
                            suppressEmptyResults: true,
                            triggeredByWorkflowOpen: true,
                            frontendMissingModelCandidates: candidatesToCheck,
                            reason: "node-unbypassed-missing-models",
                        });
                        return;
                    }

                    const hasUnpopulatedLoader = unbypassedNodes.some((node) => {
                        if (!isLocalModelLoaderNode(node)) return false;
                        const widgets = Array.isArray(node.widgets) ? node.widgets : [];
                        return widgets.some((w) => {
                            if (!w || typeof w.value !== "string" || !w.value.trim()) return false;
                            if (isDynamicGroupWidgetDisabledInNode(node, w.name)) return false;
                            if (!isModelValidationInputName(w.name)) return false;
                            return resolveComboWidgetOptionsNativeLike(w).length === 0;
                        });
                    });

                    if (hasUnpopulatedLoader) {
                        const workflow = serializeWorkflowForModelScan();
                        const backendResults = workflow ? await getWorkflowOpenBackendResults(workflow, genAtTrigger) : null;
                        if (genAtTrigger !== currentWorkflowLoadGeneration) return;
                        if (document.getElementById("auto-download-dialog")) return;
                        if (countDownloadRequiredScanResults(backendResults || {}) > 0) {
                            showResultsDialog(backendResults, {
                                suppressEmptyResults: true,
                                triggeredByWorkflowOpen: true,
                                reason: "node-unbypassed-missing-models",
                            });
                        }
                    }
                } catch (err) {
                    console.warn("[AutoDownload] Unbypass missing-model check failed:", err);
                } finally {
                    unbypassBusy = false;
                }
            };

            const origChangeMode = nodeCtor.prototype.changeMode;
            nodeCtor.prototype.changeMode = function(mode) {
                const prevMode = this?.mode;
                const result = origChangeMode.apply(this, arguments);
                const nextMode = this?.mode;
                if (
                    !isLoadingWorkflow &&
                    isNodeBypassedMode(prevMode) &&
                    !isNodeBypassedMode(nextMode)
                ) {
                    pendingNodes.add(this);
                    if (unbypassTimer) clearTimeout(unbypassTimer);
                    unbypassTimer = setTimeout(() => {
                        void flushUnbypassedNodes();
                    }, 80);
                }
                return result;
            };
            nodeCtor.prototype[HOOK_SYM] = true;
            return true;
        };

        registerGlobalAction("runAutoDownload", runAutoDownload);
        registerGlobalAction("showManualDownloadDialog", showManualDownloadDialog);
        registerGlobalAction("clearCompletedModelsFromStore", clearCompletedModelsFromStore);
        registerGlobalAction("clearModelValidationErrorsFromFrontendState", clearModelValidationErrorsFromFrontendState);
        registerGlobalAction("refreshAfterModelDownload", refreshAfterModelDownload);
        installReactiveMissingModelSubscription();
        installApiValidationAndDownloadListeners();
        installEventDrivenUnbypassHook();
    }
});
