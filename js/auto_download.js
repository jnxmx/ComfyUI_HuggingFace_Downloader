import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

app.registerExtension({
    name: "autoDownloadModels",
    setup() {
        const RUN_HOOK_SETTING_ID = "downloader.auto_open_missing_models_on_run";
        const RUN_HOOK_TEMP_DISABLED = false;
        const RUN_QUEUE_COMMAND_IDS = ["Comfy.QueuePrompt", "Comfy.QueuePromptFront"];
        const RUN_COMMAND_OVERRIDE_MARKER = "__hfAutoDownloadRunHookNativeAwareOverride";
        const RUN_COMMAND_ORIGINAL_FN = "__hfAutoDownloadRunHookNativeAwareOriginalFn";
        const RUN_COMMAND_OVERRIDE_RETRY_MS = 500;
        const RUN_COMMAND_OVERRIDE_MAX_ATTEMPTS = 40;
        const RUN_NATIVE_DIALOG_WAIT_MS = 1200;
        const RUN_NATIVE_VALIDATION_WAIT_MS = 1200;
        const RUN_NATIVE_DIALOG_POLL_MS = 60;
        const RUN_NATIVE_VALIDATION_POLL_MS = 60;
        const RUN_HOOK_COOLDOWN_MS = 1800;
        const WORKFLOW_OPEN_TRIGGER_COOLDOWN_MS = 1800;
        const WORKFLOW_OPEN_CANDIDATE_POLL_MS = 500;
        const MODEL_STORE_IMPORT_CANDIDATES = [
            "../../../stores/modelStore.js",
            "/stores/modelStore.js",
            "../../../scripts/stores/modelStore.js",
            "/scripts/stores/modelStore.js"
        ];
        const EXECUTION_ERROR_STORE_IMPORT_CANDIDATES = [
            "../../../stores/executionErrorStore.js",
            "/stores/executionErrorStore.js",
            "../../../scripts/stores/executionErrorStore.js",
            "/scripts/stores/executionErrorStore.js"
        ];
        const MISSING_MODEL_STORE_IMPORT_CANDIDATES = [
            "../../../platform/missingModel/missingModelStore.js",
            "/platform/missingModel/missingModelStore.js",
            "../../../scripts/platform/missingModel/missingModelStore.js",
            "/scripts/platform/missingModel/missingModelStore.js"
        ];
        let runHookBypassRemaining = 0;

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
            if (RUN_HOOK_TEMP_DISABLED) {
                return false;
            }
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

        const unwrapStoreValue = (value) =>
            value && typeof value === "object" && "value" in value
                ? value.value
                : value;

        const getActiveWorkflowEntry = () => {
            try {
                const workflowStore = unwrapStoreValue(app?.extensionManager?.workflow);
                return unwrapStoreValue(workflowStore?.activeWorkflow) || null;
            } catch (_) {
                return null;
            }
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
                        folderPickers.forEach(picker => picker.refresh());
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

            const dropdown = document.createElement("div");
            Object.assign(dropdown.style, {
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                background: "var(--comfy-menu-bg)",
                border: "1px solid var(--border-default)",
                borderTop: "none",
                maxHeight: "180px",
                overflowY: "auto",
                zIndex: 10,
                display: "none",
                borderRadius: "0 0 8px 8px"
            });
            applyNativeScrollbarClasses(dropdown);

            const buildList = () => {
                dropdown.innerHTML = "";
                if (!availableFolders.length) {
                    const empty = document.createElement("div");
                    empty.textContent = "No folders available";
                    empty.style.padding = "6px 8px";
                    empty.style.color = "#888";
                    dropdown.appendChild(empty);
                    return;
                }
                availableFolders.forEach(folder => {
                    const item = document.createElement("div");
                    item.textContent = folder;
                    Object.assign(item.style, {
                        padding: "7px 10px",
                        cursor: "pointer",
                        color: "var(--input-text)",
                        fontSize: "13px",
                        fontFamily: "var(--font-inter, Inter, sans-serif)",
                    });
                    item.addEventListener("mouseenter", () => {
                        item.style.background = "var(--secondary-background-hover)";
                    });
                    item.addEventListener("mouseleave", () => {
                        item.style.background = "transparent";
                    });
                    item.addEventListener("mousedown", (e) => {
                        e.preventDefault();
                        input.value = folder;
                        dropdown.style.display = "none";
                    });
                    dropdown.appendChild(item);
                });
            };

            const showList = () => {
                buildList();
                dropdown.style.display = "block";
            };

            input.addEventListener("focus", showList);
            input.addEventListener("input", showList);
            input.addEventListener("blur", () => {
                setTimeout(() => {
                    dropdown.style.display = "none";
                }, 150);
            });

            wrapper.appendChild(input);
            wrapper.appendChild(dropdown);

            const picker = {
                refresh: () => {
                    if (dropdown.style.display === "block") {
                        buildList();
                    }
                }
            };
            folderPickers.add(picker);

            return { wrapper, input };
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
            if (lower.includes("vae_approx") || lower.includes("tinyvae") || lower.includes("taesd")) {
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

            const classTypeLower = String(signals?.classType || "").trim().toLowerCase();
            if (classTypeLower) {
                if (classTypeLower.includes("clipvision")) return "clip_vision";
                if (classTypeLower.includes("style")) return "style_models";
                if (classTypeLower.includes("controlnet")) return "controlnet";
                if (classTypeLower.includes("lora")) return "loras";
                if (classTypeLower.includes("vae")) return "vae";
                if (classTypeLower.includes("clip")) return "text_encoders";
                if (classTypeLower.includes("unet")) return "diffusion_models";
                if (classTypeLower.includes("checkpoint") || classTypeLower.includes("ckpt")) return "checkpoints";
                if (classTypeLower.includes("upscale")) return "upscale_models";
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
                    : `file|${String(entry.filename || "").toLowerCase()}|${String(entry.url || "").toLowerCase()}|${String(entry.suggested_folder || entry.folder || "").toLowerCase()}`;
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

        const getFrontendMissingModelCandidates = async () => {
            const store = await resolveMissingModelStore();
            const storeCandidates = unwrapStoreValue(store?.missingModelCandidates);
            let candidates = Array.isArray(storeCandidates)
                ? storeCandidates
                : [];
            if (!candidates.length) {
                const activeWorkflow = getActiveWorkflowEntry();
                const pendingWarnings = unwrapStoreValue(activeWorkflow?.pendingWarnings);
                const pendingCandidates = unwrapStoreValue(pendingWarnings?.missingModelCandidates);
                if (Array.isArray(pendingCandidates)) {
                    candidates = pendingCandidates;
                }
            }
            return Array.isArray(candidates) ? candidates : [];
        };

        const countActionableScanResults = (data) => {
            const missing = Array.isArray(data?.missing) ? data.missing.length : 0;
            const found = Array.isArray(data?.found) ? data.found.length : 0;
            const mismatches = Array.isArray(data?.mismatches)
                ? data.mismatches.length
                : (Array.isArray(data?.path_mismatches) ? data.path_mismatches.length : 0);
            return missing + found + mismatches;
        };

        const mergeMissingEntries = (existingEntries, newEntries) => {
            const merged = [];
            const seen = new Set();
            const append = (entry) => {
                if (!entry || typeof entry !== "object") {
                    return;
                }
                const key = [
                    String(entry?.filename || entry?.name || "").trim().toLowerCase(),
                    String(entry?.suggested_folder || entry?.directory || "").trim().toLowerCase(),
                    String(entry?.requested_path || "").trim().toLowerCase(),
                    String(entry?.url || "").trim().toLowerCase(),
                    String(entry?.node_id || "").trim().toLowerCase()
                ].join("|");
                if (seen.has(key)) {
                    return;
                }
                seen.add(key);
                merged.push(entry);
            };
            for (const entry of Array.isArray(existingEntries) ? existingEntries : []) {
                append(entry);
            }
            for (const entry of Array.isArray(newEntries) ? newEntries : []) {
                append(entry);
            }
            return merged;
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
                if (!isMissingModelCandidate(candidate)) {
                    continue;
                }
                const filename = String(candidate?.name || candidate?.filename || "").trim();
                if (!filename) {
                    continue;
                }
                const directory = String(candidate?.directory || candidate?.folder || "").trim() || "checkpoints";

                if (modelStore && directory) {
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
                    if (namesInFolder && namesInFolder.has(filename)) {
                        continue;
                    }
                }

                const entry = {
                    filename,
                    name: filename,
                    requested_path: filename,
                    suggested_folder: directory,
                    directory,
                    url: String(candidate?.url || "").trim(),
                    hash: String(candidate?.hash || "").trim(),
                    hash_type: String(candidate?.hashType || "").trim(),
                    node_id: candidate?.nodeId,
                    node_title: String(candidate?.nodeType || "").trim(),
                    input_name: String(candidate?.widgetName || "").trim(),
                    source: "frontend_missing_model_store",
                    type: "",
                };
                const key = [
                    entry.filename.toLowerCase(),
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

        const hasSerializableSubgraphDefinitions = (graphData) => {
            const defs = graphData?.definitions?.subgraphs;
            return Array.isArray(defs) && defs.length > 0;
        };

        const serializeWorkflowForModelScan = () => {
            let rootGraphData = null;
            try {
                if (typeof app?.rootGraph?.serialize === "function") {
                    rootGraphData = app.rootGraph.serialize();
                    if (rootGraphData && typeof rootGraphData === "object") {
                        return rootGraphData;
                    }
                }
            } catch (_) {
                // Fall through to workflow store state.
            }

            try {
                const activeWorkflow = getActiveWorkflowEntry();
                const activeState = activeWorkflow?.activeState;
                if (activeState && typeof activeState === "object") {
                    return activeState;
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
                        return legacyGraphData;
                    }
                }
            } catch (_) {
                // No serialized workflow available.
            }

            return rootGraphData;
        };

        const isWorkflowReadyForModelScan = () => {
            if (app?.isGraphReady === false) {
                return false;
            }
            const workflow = serializeWorkflowForModelScan();
            return Boolean(workflow && typeof workflow === "object");
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

        const collectModelWidgetTargets = (entry) => {
            const graphNodes = Array.isArray(app?.graph?._nodes) ? app.graph._nodes : [];
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
            if (Number.isFinite(nodeId) && app?.graph?.getNodeById) {
                const beforeCount = targets.length;
                pushNodeMatches(app.graph.getNodeById(nodeId));
                hadPreferredMatches = targets.length > beforeCount;
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

            // Never rewrite link/download nodes (they are metadata sources, not local model loaders).
            if (
                typeLower.includes("hugging face download model") ||
                typeLower.includes("huggingface download model") ||
                typeLower.includes("hugging face download folder") ||
                typeLower.includes("huggingface download folder")
            ) {
                return false;
            }

            const props = node.properties || {};
            const hasModelMetadata = Array.isArray(props.models) && props.models.length > 0;
            const looksLikeLoader = typeLower.includes("loader");

            return hasModelMetadata || looksLikeLoader;
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

            const graphNodes = Array.isArray(app?.graph?._nodes) ? app.graph._nodes : [];
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

        /* Show loading dialog immediately */
        const showLoadingDialog = (onSkip, options = {}) => {
            const skipModeActive = Boolean(options.skipModeActive);
            const existing = document.getElementById("auto-download-dialog");
            if (existing) existing.remove();

            const dlg = document.createElement("div");
            dlg.id = "auto-download-dialog";
            applyTemplateDialogOverlayStyle(dlg, 9000);

            const panel = document.createElement("div");
            applyTemplateDialogPanelStyle(panel, {
                padding: "20px 22px",
                textAlign: "left",
                width: "480px",
                maxWidth: "92vw",
            });

            const statusEl = document.createElement("div");
            statusEl.textContent = "Preparing scan...";
            Object.assign(statusEl.style, {
                fontSize: "16px",
                lineHeight: "1.25",
                fontWeight: "600",
                letterSpacing: "-0.005em"
            });

            const detailEl = document.createElement("div");
            detailEl.textContent = "Preparing workflow scan...";
            Object.assign(detailEl.style, {
                fontSize: "13px",
                color: "var(--descrip-text, #999)",
                marginTop: "8px",
                minHeight: "18px"
            });

            const actionsEl = document.createElement("div");
            Object.assign(actionsEl.style, {
                display: "flex",
                gap: "8px",
                marginTop: "14px",
                justifyContent: "flex-end"
            });

            const buttonBaseStyle = {
                padding: "8px 16px",
                borderRadius: "8px",
                cursor: "pointer",
                fontSize: "14px",
                fontWeight: "600",
                fontFamily: "var(--font-inter, Inter, sans-serif)",
            };

            const skipBtn = document.createElement("button");
            skipBtn.textContent = "Skip";
            applyNativeButtonStyle(skipBtn, "secondary");
            Object.assign(skipBtn.style, {
                ...buttonBaseStyle,
                opacity: skipModeActive ? "0.65" : "1",
            });
            skipBtn.disabled = skipModeActive;

            skipBtn.onclick = () => {
                if (skipBtn.disabled) return;
                if (onSkip) onSkip();
            };

            panel.appendChild(statusEl);
            panel.appendChild(detailEl);
            actionsEl.appendChild(skipBtn);
            panel.appendChild(actionsEl);

            dlg.appendChild(panel);
            document.body.appendChild(dlg);
            return {
                dlg,
                setStatus: (text) => { statusEl.textContent = text; },
                setDetail: (text) => { detailEl.textContent = text; },
                setSkipMode: (active) => {
                    skipBtn.disabled = Boolean(active);
                    skipBtn.style.opacity = active ? "0.65" : "1";
                },
                cleanup: () => {},
                remove: () => { if (dlg.parentElement) dlg.remove(); }
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
        const showResultsDialog = (data, options = {}) => {
            let pollTimer = null;
            const stopPolling = () => {
                if (pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                }
            };

            const existing = document.getElementById("auto-download-dialog");
            if (existing) existing.remove();

            const dlg = document.createElement("div");
            dlg.id = "auto-download-dialog";
            applyTemplateDialogOverlayStyle(dlg, 9000);

            let content = null;
            const cleanupUi = () => {};

            const closeDialog = () => {
                stopPolling();
                cleanupUi();
                if (dlg.parentElement) {
                    dlg.remove();
                }
            };

            bindBackdropClose(dlg, closeDialog);

            const panel = document.createElement("div");
            applyTemplateDialogPanelStyle(panel, {
                width: "min(1220px, 100%)",
                maxHeight: "92vh",
                padding: "0",
            });

            const headerWrap = document.createElement("div");
            Object.assign(headerWrap.style, {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                height: "88px",
                padding: "0 24px",
                flexShrink: "0",
            });

            const titleWrap = document.createElement("div");
            Object.assign(titleWrap.style, {
                display: "flex",
                flexDirection: "column",
                gap: "0",
            });

            const titleEl = document.createElement("div");
            titleEl.textContent = "Auto-Download Models";
            Object.assign(titleEl.style, {
                letterSpacing: "0",
                color: "var(--input-text)",
            });
            titleEl.style.setProperty("font-family", "Inter, Arial, sans-serif", "important");
            titleEl.style.setProperty("font-size", "24px", "important");
            titleEl.style.setProperty("font-weight", "600", "important");
            titleEl.style.setProperty("line-height", "32px", "important");

            titleWrap.appendChild(titleEl);
            headerWrap.appendChild(titleWrap);
            headerWrap.appendChild(createDialogCloseIconButton(closeDialog));
            panel.appendChild(headerWrap);

            const rawMissingModels = Array.isArray(data.missing) ? [...data.missing] : [];
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

            const foundModels = Array.isArray(data.found) ? data.found : [];
            let mismatchModels = Array.isArray(data.mismatches)
                ? [...data.mismatches]
                : (Array.isArray(data.path_mismatches) ? [...data.path_mismatches] : []);
            const autoMismatchFix = autoApplyPathMismatches(mismatchModels);
            mismatchModels = autoMismatchFix.remaining;

            if (autoMismatchFix.fixedRows > 0) {
                showToast({
                    severity: "info",
                    summary: "Model paths auto-fixed",
                    detail: `Updated ${autoMismatchFix.fixedRefs} loader reference${autoMismatchFix.fixedRefs === 1 ? "" : "s"} to installed model paths.`,
                    life: 3200,
                });
            }

            const summaryRow = document.createElement("div");
            Object.assign(summaryRow.style, {
                display: "flex",
                flexWrap: "wrap",
                gap: "8px",
                fontSize: "13px",
                color: "var(--descrip-text, #999)",
                padding: "10px 24px 0",
            });
            const totalMissingCount =
                repoFolderMissingModels.length +
                curatedMissingModels.length +
                missingModels.length;

            if (
                options?.triggeredByRunHook &&
                totalMissingCount === 0 &&
                mismatchModels.length === 0
            ) {
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

            summaryRow.textContent = `Missing: ${totalMissingCount} • Found: ${foundModels.length} • Mismatches: ${mismatchModels.length}`;
            panel.appendChild(summaryRow);

            const listFrame = document.createElement("div");
            Object.assign(listFrame.style, {
                border: "none",
                borderRadius: "0",
                background: TEMPLATE_DIALOG_TOKENS.surface,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                minHeight: "280px",
                maxHeight: "56vh",
            });

            content = document.createElement("div");
            Object.assign(content.style, {
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                padding: "8px 24px 12px",
            });
            applyNativeScrollbarClasses(content);
            loadFolderList();

            const makeSectionTitle = (text, color = "#9aa4b6") => {
                const sectionTitle = document.createElement("div");
                sectionTitle.textContent = text;
                Object.assign(sectionTitle.style, {
                    color,
                    fontSize: "11px",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    padding: "4px 0 0",
                    fontWeight: "600",
                });
                return sectionTitle;
            };

            const makeBaseRow = () => {
                const row = document.createElement("div");
                Object.assign(row.style, {
                    display: "grid",
                    gridTemplateColumns: "24px minmax(190px, 1.1fr) minmax(260px, 1.2fr) minmax(160px, 0.8fr)",
                    alignItems: "center",
                    gap: "12px",
                    background: "color-mix(in srgb, var(--comfy-menu-bg) 82%, var(--base-foreground) 18%)",
                    borderRadius: "10px",
                    padding: "10px 12px",
                });
                return row;
            };

            const rowInputs = [];

            const renderMissingRows = (models, options = {}) => {
                const isFolderRepoSection = Boolean(options.isFolderRepoSection);
                models.forEach((m) => {
                    const downloadMode = isFolderRepoSection || isFolderRepoDownloadModel(m) ? "folder" : "file";
                    const displayName = String(m.display_name || m.requested_path || m.filename || "").trim() || "Unknown model";
                    const rowWrapper = document.createElement("div");
                    Object.assign(rowWrapper.style, {
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                    });

                    const row = makeBaseRow();

                    const cb = document.createElement("input");
                    cb.type = "checkbox";
                    cb.checked = Boolean(m.url);
                    cb.style.margin = "0";

                    const infoDiv = document.createElement("div");
                    Object.assign(infoDiv.style, {
                        minWidth: "0",
                    });
                    const nameEl = document.createElement("div");
                    Object.assign(nameEl.style, {
                        fontWeight: "600",
                        fontSize: "13px",
                        lineHeight: "1.2",
                        wordBreak: "break-word",
                        color: "var(--input-text)",
                    });
                    nameEl.textContent = displayName;

                    const metaEl = document.createElement("div");
                    Object.assign(metaEl.style, {
                        fontSize: "11px",
                        color: "var(--descrip-text, #999)",
                        marginTop: "3px",
                    });
                    const modeMeta = downloadMode === "folder" ? " • full repo/folder" : "";
                    metaEl.textContent = `${m.node_title || "Unknown Node"}${m.source ? " • " + m.source : ""}${modeMeta}`;
                    infoDiv.appendChild(nameEl);
                    infoDiv.appendChild(metaEl);

                    const urlPlaceholder = downloadMode === "folder"
                        ? "HuggingFace repo/folder URL..."
                        : "HuggingFace URL...";
                    const urlInput = createInput(m.url, urlPlaceholder);
                    Object.assign(urlInput.style, {
                        width: "100%",
                        minWidth: "0",
                        fontSize: "14px",
                        minHeight: "40px",
                    });

                    const defaultFolder = downloadMode === "folder"
                        ? (m.locked_folder || m.suggested_folder || "")
                        : (m.locked_folder || m.suggested_folder || "checkpoints");
                    const folderPicker = createFolderPicker(defaultFolder, "Folder");
                    Object.assign(folderPicker.wrapper.style, {
                        width: "100%",
                        minWidth: "0",
                    });
                    Object.assign(folderPicker.input.style, {
                        fontSize: "14px",
                        minHeight: "40px",
                    });
                    if (downloadMode === "folder") {
                        folderPicker.input.placeholder = "Root";
                    }
                    const folderLocked = Boolean(m.folder_locked) && downloadMode !== "folder";
                    if (folderLocked) {
                        folderPicker.input.value = String(m.locked_folder || m.suggested_folder || defaultFolder || "").trim();
                        folderPicker.input.readOnly = true;
                        folderPicker.input.disabled = true;
                        folderPicker.input.title = "Locked to the requesting node's model folder";
                        folderPicker.wrapper.style.opacity = "0.9";
                    }

                    row.appendChild(cb);
                    row.appendChild(infoDiv);
                    row.appendChild(urlInput);
                    row.appendChild(folderPicker.wrapper);
                    rowWrapper.appendChild(row);

                    const rowData = {
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
                        metaEl: metaEl,
                        nodeTitle: m.node_title || "Unknown Node",
                        nodeId: m.node_id,
                        downloadMode,
                        skipWorkflowUpdate: downloadMode === "folder",
                        folderLocked,
                        lockedFolder: folderLocked
                            ? String(m.locked_folder || m.suggested_folder || defaultFolder || "").trim()
                            : "",
                    };
                    rowInputs.push(rowData);

                    if (downloadMode !== "folder" && Array.isArray(m.alternatives) && m.alternatives.length > 0) {
                        const altToggle = document.createElement("button");
                        altToggle.textContent = `Alternatives (${m.alternatives.length})`;
                        Object.assign(altToggle.style, {
                            alignSelf: "flex-start",
                            fontSize: "12px",
                            padding: "6px 9px",
                            background: "var(--comfy-input-bg)",
                            color: "var(--input-text)",
                            border: "1px solid var(--border-default)",
                            borderRadius: "7px",
                            cursor: "pointer",
                            fontWeight: "600",
                        });

                        const altList = document.createElement("div");
                        Object.assign(altList.style, {
                            display: "none",
                            background: "var(--comfy-input-bg)",
                            border: "1px solid var(--border-default)",
                            padding: "8px",
                            borderRadius: "8px",
                        });

                        m.alternatives.forEach((alt) => {
                            const altRow = document.createElement("div");
                            Object.assign(altRow.style, {
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: "10px",
                                padding: "7px 0",
                                borderBottom: "1px solid var(--border-default)",
                            });

                            const altLabel = document.createElement("div");
                            altLabel.style.fontSize = "12px";
                            altLabel.style.color = "var(--descrip-text, #999)";
                            altLabel.textContent = `${alt.filename}${alt.source ? " • " + alt.source : ""}`;

                            const useBtn = document.createElement("button");
                            useBtn.textContent = "Use";
                            Object.assign(useBtn.style, {
                                padding: "5px 10px",
                                background: "var(--comfy-input-bg)",
                                color: "var(--input-text)",
                                border: "1px solid var(--border-default)",
                                borderRadius: "6px",
                                cursor: "pointer",
                                fontSize: "12px",
                                fontWeight: "600",
                            });

                            useBtn.onclick = () => {
                                rowData.filename = alt.filename || rowData.filename;
                                if (alt.url) {
                                    rowData.urlInput.value = alt.url;
                                    rowData.resolvedUrl = alt.url;
                                    cb.checked = true;
                                }
                                if (alt.suggested_folder && !rowData.folderLocked) {
                                    rowData.folderInput.value = alt.suggested_folder;
                                }
                                rowData.nameEl.textContent = rowData.filename;
                                rowData.metaEl.textContent = `${rowData.nodeTitle}${alt.source ? " • alt:" + alt.source : ""}`;
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

            content.appendChild(makeSectionTitle("Missing Models"));
            if (!missingModels.length) {
                const noMissing = document.createElement("div");
                noMissing.textContent = curatedMissingModels.length
                    ? "No additional missing model file links detected."
                    : "No missing model file links detected.";
                Object.assign(noMissing.style, {
                    padding: "12px 10px 16px",
                    color: "#58d58c",
                    fontSize: "14px",
                    lineHeight: "1.15",
                });
                content.appendChild(noMissing);
            } else {
                renderMissingRows(missingModels);
            }

            content.appendChild(makeSectionTitle("Found Local Models"));
            if (!foundModels.length) {
                const noneFound = document.createElement("div");
                noneFound.textContent = "No already-installed models matched this workflow.";
                Object.assign(noneFound.style, {
                    padding: "10px 8px 14px",
                    color: "#99a3b8",
                    fontSize: "14px",
                });
                content.appendChild(noneFound);
            } else {
                foundModels.forEach((m) => {
                    const row = makeBaseRow();

                    const marker = document.createElement("div");
                    marker.textContent = "●";
                    Object.assign(marker.style, {
                        color: "#56d78f",
                        fontSize: "10px",
                        fontWeight: "700",
                        width: "24px",
                        textAlign: "center",
                    });

                    const infoDiv = document.createElement("div");
                    Object.assign(infoDiv.style, {
                        minWidth: "0",
                    });

                    const nameEl = document.createElement("div");
                    nameEl.textContent = m.filename || "Unknown model";
                    Object.assign(nameEl.style, {
                        fontWeight: "600",
                        fontSize: "13px",
                        lineHeight: "1.2",
                        wordBreak: "break-word",
                        color: "var(--input-text)",
                    });

                    const metaEl = document.createElement("div");
                    metaEl.textContent = `${m.source || "exact_match"} • already installed`;
                    Object.assign(metaEl.style, {
                        fontSize: "11px",
                        color: "var(--descrip-text, #999)",
                        marginTop: "3px",
                    });

                    infoDiv.appendChild(nameEl);
                    infoDiv.appendChild(metaEl);

                    const pathEl = document.createElement("div");
                    pathEl.textContent = formatFoundModelPath(m.found_path || m.clean_path || "");
                    Object.assign(pathEl.style, {
                        minWidth: "0",
                        fontSize: "13px",
                        color: "var(--input-text)",
                        wordBreak: "break-word",
                    });

                    const installedEl = document.createElement("div");
                    installedEl.textContent = "Installed";
                    Object.assign(installedEl.style, {
                        justifySelf: "end",
                        fontSize: "12px",
                        fontWeight: "600",
                        color: "#56d78f",
                    });

                    row.appendChild(marker);
                    row.appendChild(infoDiv);
                    row.appendChild(pathEl);
                    row.appendChild(installedEl);
                    content.appendChild(row);
                });
            }

            if (mismatchModels.length > 0) {
                content.appendChild(makeSectionTitle("Path Mismatches", "#f7b96a"));
                mismatchModels.forEach((m) => {
                    const row = makeBaseRow();
                    Object.assign(row.style, {
                        gridTemplateColumns: "1fr auto auto",
                    });
                    const left = document.createElement("div");
                    Object.assign(left.style, {
                        minWidth: "220px",
                    });
                    const currentLabel = m.requested_path || m.filename || "";
                    const foundLabel = m.clean_path || "";
                    left.innerHTML = `<div style="color:#aaa; font-size:11px">Current: ${currentLabel}</div><div style="color:#4caf50; font-weight:600; font-size:12px; margin-top:2px;">Found: ${foundLabel}</div>`;

                    const fixBtn = document.createElement("button");
                    fixBtn.textContent = "Use Found Path";
                    Object.assign(fixBtn.style, {
                        padding: "7px 10px",
                        background: "#2f84da",
                        color: "white",
                        border: "none",
                        borderRadius: "8px",
                        cursor: "pointer",
                        fontWeight: "600",
                        fontSize: "13px",
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
                    moveBtn.textContent = "Move File";
                    Object.assign(moveBtn.style, {
                        padding: "7px 10px",
                        background: "#f2ae42",
                        color: "#111",
                        border: "none",
                        borderRadius: "8px",
                        cursor: "pointer",
                        fontWeight: "700",
                        fontSize: "13px",
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
                                left.innerHTML = `<div style="color:#aaa; font-size:11px">Current: ${m.requested_path || m.filename || ""}</div><div style="color:#4caf50; font-weight:600; font-size:12px; margin-top:2px;">Found: ${nextPath}</div>`;
                            }
                        } catch (err) {
                            moveBtn.disabled = false;
                            moveBtn.style.opacity = "1";
                            moveBtn.textContent = "Move File";
                            alert(`Move failed: ${err}`);
                        }
                    };

                    row.appendChild(left);
                    row.appendChild(fixBtn);
                    row.appendChild(moveBtn);
                    content.appendChild(row);
                });
            }

            listFrame.appendChild(content);
            panel.appendChild(listFrame);

            const statusLine = document.createElement("div");
            Object.assign(statusLine.style, {
                fontSize: "13px",
                color: "var(--descrip-text, #999)",
                minHeight: "20px",
                padding: "0 24px",
            });
            panel.appendChild(statusLine);

            const setStatus = (msg, color = "#9aa4b6") => {
                statusLine.textContent = msg || "";
                statusLine.style.color = color;
            };

            const footer = document.createElement("div");
            Object.assign(footer.style, {
                display: "flex",
                justifyContent: "flex-end",
                gap: "12px",
                marginTop: "2px",
                padding: "0 24px 16px",
            });

            const downloadBtn = createButton("Download Selected", "p-button p-component p-button-success", async () => {
                const selectedRows = rowInputs.filter((r) => r.checkbox.checked);
                const toDownload = selectedRows.map((r) => {
                    const effectiveFolder = r.folderLocked
                        ? (r.lockedFolder || r.folderInput.value.trim())
                        : r.folderInput.value.trim();
                    const item = {
                        filename: r.filename,
                        target_filename: r.filename,
                        display_name: r.displayName || r.requestedPath || r.filename,
                        requested_path: r.requestedPath || r.filename,
                        url: r.urlInput.value.trim(),
                        folder: effectiveFolder,
                        folder_locked: Boolean(r.folderLocked),
                        locked_folder: r.lockedFolder || "",
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
                downloadBtn.textContent = "Queued";

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
                    downloadBtn.disabled = false;
                    downloadBtn.textContent = "Download Selected";
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
                    cleanupUi();
                    if (dlg.parentElement) {
                        dlg.remove();
                    }

                    const statusMap = {};
                    const pending = new Set(downloadIds);

                    const poll = async () => {
                        if (!downloadIds.length) return;
                        try {
                            const statusResp = await fetch(`/download_status?ids=${encodeURIComponent(downloadIds.join(","))}`);
                            if (statusResp.status !== 200) return;
                            const statusData = await statusResp.json();
                            const downloads = statusData.downloads || {};

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
                        } catch (e) {
                            // Status panel already tracks final errors; avoid noisy alerts here.
                        }
                    };

                    pollTimer = setInterval(poll, 1000);
                    poll();
                } catch (e) {
                    setStatus(`Queue error: ${e}`, "#ff6b6b");
                    downloadBtn.disabled = false;
                    downloadBtn.textContent = "Download Selected";
                }
            });

            if (rowInputs.length === 0) {
                downloadBtn.disabled = true;
            }
            applyNativeButtonStyle(downloadBtn, "primary");

            footer.appendChild(downloadBtn);
            panel.appendChild(footer);

            dlg.appendChild(panel);
            document.body.appendChild(dlg);
            setTimeout(() => {
                const firstUrlInput = dlg.querySelector(
                    "input[placeholder='HuggingFace URL...'], input[placeholder='HuggingFace repo/folder URL...']"
                );
                if (firstUrlInput) {
                    firstUrlInput.focus();
                    firstUrlInput.select();
                }
            }, 0);
        };

        const showManualDownloadDialog = () => {

            let pollTimer = null;
            const stopPolling = () => {
                if (pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                }
            };

            const existing = document.getElementById("manual-download-dialog");
            if (existing) existing.remove();

            const dlg = document.createElement("div");
            dlg.id = "manual-download-dialog";
            applyTemplateDialogOverlayStyle(dlg, 9000);

            const closeDialog = () => {
                stopPolling();
                if (dlg.parentElement) {
                    dlg.remove();
                }
            };

            bindBackdropClose(dlg, closeDialog);

            const panel = document.createElement("div");
            applyTemplateDialogPanelStyle(panel, {
                padding: "0",
                width: "min(820px, 100%)",
                maxWidth: "92vw",
                maxHeight: "92vh",
            });
            // Allow folder picker popup to extend beyond the panel body.
            panel.style.overflow = "visible";

            const headerWrap = document.createElement("div");
            Object.assign(headerWrap.style, {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                height: "88px",
                padding: "0 24px",
                flexShrink: "0",
            });

            const titleWrap = document.createElement("div");
            Object.assign(titleWrap.style, {
                display: "flex",
                flexDirection: "column",
                gap: "0",
            });

            const titleEl = document.createElement("div");
            titleEl.textContent = "Download New Model";
            Object.assign(titleEl.style, {
                letterSpacing: "0",
                color: "var(--input-text)",
            });
            titleEl.style.setProperty("font-family", "Inter, Arial, sans-serif", "important");
            titleEl.style.setProperty("font-size", "24px", "important");
            titleEl.style.setProperty("font-weight", "600", "important");
            titleEl.style.setProperty("line-height", "32px", "important");

            titleWrap.appendChild(titleEl);
            headerWrap.appendChild(titleWrap);
            headerWrap.appendChild(createDialogCloseIconButton(closeDialog));
            panel.appendChild(headerWrap);

            const content = document.createElement("div");
            Object.assign(content.style, {
                display: "flex",
                flexDirection: "column",
                gap: "10px",
                background: "transparent",
                border: "none",
                borderRadius: "0",
                padding: "12px 24px",
                overflow: "visible",
            });

            const urlLabel = document.createElement("div");
            urlLabel.textContent = "Model URL";
            Object.assign(urlLabel.style, {
                fontSize: "11px",
                color: "var(--descrip-text, #999)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: "600",
            });
            const urlInput = createInput("", "Model URL...", { highlightMissingUrl: false });
            Object.assign(urlInput.style, {
                fontSize: "14px",
                minHeight: "40px",
            });

            const fullRepoSwitchRow = document.createElement("div");
            Object.assign(fullRepoSwitchRow.style, {
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
                gap: "10px",
                marginTop: "2px",
            });

            const fullRepoSwitchText = document.createElement("span");
            fullRepoSwitchText.textContent = "Download full repo/folder";
            Object.assign(fullRepoSwitchText.style, {
                fontSize: "13px",
                color: "var(--input-text)",
                fontWeight: "500",
                userSelect: "none",
            });

            const fullRepoSwitchWrap = document.createElement("label");
            fullRepoSwitchWrap.className = "hf-manual-toggle p-toggleswitch p-component transition-transform active:scale-90";
            Object.assign(fullRepoSwitchWrap.style, {
                margin: "0",
                cursor: "pointer",
                flexShrink: "0",
            });

            const fullRepoSwitch = document.createElement("input");
            fullRepoSwitch.type = "checkbox";
            fullRepoSwitch.className = "p-toggleswitch-input";
            fullRepoSwitch.checked = false;
            fullRepoSwitch.setAttribute("role", "switch");
            fullRepoSwitch.setAttribute("aria-label", "Download full repo/folder");

            const fullRepoSwitchSlider = document.createElement("span");
            fullRepoSwitchSlider.className = "p-toggleswitch-slider";

            const setFullRepoSwitchVisualState = () => {
                const on = Boolean(fullRepoSwitch.checked);
                fullRepoSwitchWrap.classList.toggle("p-toggleswitch-checked", on);
                fullRepoSwitch.setAttribute("aria-checked", on ? "true" : "false");
            };

            fullRepoSwitch.addEventListener("focus", () => {
                fullRepoSwitchWrap.classList.add("p-focus");
            });
            fullRepoSwitch.addEventListener("blur", () => {
                fullRepoSwitchWrap.classList.remove("p-focus");
            });

            fullRepoSwitchWrap.appendChild(fullRepoSwitch);
            fullRepoSwitchWrap.appendChild(fullRepoSwitchSlider);
            fullRepoSwitchRow.appendChild(fullRepoSwitchWrap);
            fullRepoSwitchRow.appendChild(fullRepoSwitchText);

            fullRepoSwitchRow.addEventListener("click", (event) => {
                const target = event?.target;
                if (target === fullRepoSwitch || fullRepoSwitchWrap.contains(target)) {
                    return;
                }
                fullRepoSwitch.checked = !fullRepoSwitch.checked;
                fullRepoSwitch.dispatchEvent(new Event("change", { bubbles: true }));
            });

            const destinationPreviewLine = document.createElement("div");
            Object.assign(destinationPreviewLine.style, {
                display: "none",
                fontSize: "13px",
                color: "var(--descrip-text, #9aa1ad)",
                fontWeight: "500",
                lineHeight: "1.4",
                marginTop: "-2px",
                marginBottom: "2px",
            });

            const folderLabel = document.createElement("div");
            folderLabel.textContent = "Folder";
            Object.assign(folderLabel.style, {
                fontSize: "11px",
                color: "var(--descrip-text, #999)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: "600",
            });
            const folderPicker = createFolderPicker("loras", "Folder");
            Object.assign(folderPicker.input.style, {
                fontSize: "14px",
                minHeight: "40px",
            });

            content.appendChild(urlLabel);
            content.appendChild(urlInput);
            content.appendChild(fullRepoSwitchRow);
            content.appendChild(destinationPreviewLine);
            content.appendChild(folderLabel);
            content.appendChild(folderPicker.wrapper);
            panel.appendChild(content);

            const footer = document.createElement("div");
            Object.assign(footer.style, {
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px",
                padding: "0 24px 16px",
            });

            const statusLine = document.createElement("div");
            Object.assign(statusLine.style, {
                fontSize: "13px",
                color: "var(--descrip-text, #999)",
                minHeight: "20px",
                padding: "0 24px",
            });
            panel.appendChild(statusLine);

            const setStatus = (msg, color = "#9aa4b6") => {
                statusLine.textContent = msg || "";
                statusLine.style.color = color;
            };

            let folderValueForNormalMode = "loras";
            let folderValueForRepoMode = "";

            const setFolderInputValue = (value) => {
                folderPicker.input.value = String(value || "");
            };

            const updateManualDownloadModeUi = (reason = "refresh") => {
                const fullRepoMode = Boolean(fullRepoSwitch.checked);
                const currentFolderValue = normalizeFolderPathInput(folderPicker.input.value);

                if (reason === "toggle") {
                    if (fullRepoMode) {
                        folderValueForNormalMode = currentFolderValue || "loras";
                        setFolderInputValue(folderValueForRepoMode);
                    } else {
                        folderValueForRepoMode = currentFolderValue;
                        setFolderInputValue(folderValueForNormalMode || "loras");
                    }
                } else if (fullRepoMode) {
                    folderValueForRepoMode = currentFolderValue;
                } else {
                    folderValueForNormalMode = currentFolderValue || "loras";
                }

                if (fullRepoMode) {
                    urlLabel.textContent = "Hugging Face URL / Repo / Folder";
                    urlInput.placeholder = "https://huggingface.co/owner/repo[/tree/main/subfolder]";
                    folderLabel.textContent = "Folder";
                    folderPicker.input.placeholder = "Root";
                    destinationPreviewLine.style.display = "block";
                    const parsed = parseHfFolderLinkInfo(urlInput.value);
                    if (parsed?.targetSegment) {
                        destinationPreviewLine.textContent = buildFolderDownloadDestinationPreview(
                            folderPicker.input.value,
                            parsed.targetSegment
                        );
                    } else {
                        destinationPreviewLine.textContent = "models/<repo-or-subfolder>/";
                    }
                    return;
                }

                urlLabel.textContent = "Model URL";
                urlInput.placeholder = "https://example.com/path/model.safetensors";
                folderLabel.textContent = "Folder";
                folderPicker.input.placeholder = "Folder";
                destinationPreviewLine.style.display = "none";
            };

            fullRepoSwitch.addEventListener("change", () => {
                setFullRepoSwitchVisualState();
                updateManualDownloadModeUi("toggle");
            });
            urlInput.addEventListener("input", () => updateManualDownloadModeUi("input"));
            folderPicker.input.addEventListener("input", () => updateManualDownloadModeUi("input"));
            setFullRepoSwitchVisualState();
            updateManualDownloadModeUi();

            const downloadBtn = createButton("Download", "p-button p-component p-button-success", async () => {
                const url = urlInput.value.trim();
                const fullRepoMode = Boolean(fullRepoSwitch.checked);
                const normalizedFolder = normalizeFolderPathInput(folderPicker.input.value);
                let filename = "";
                let queueModel = null;

                if (!url) {
                    showToast({
                        severity: "warn",
                        summary: "Missing URL",
                        detail: fullRepoMode
                            ? "Enter a Hugging Face repo or folder link."
                            : "Enter a direct model file URL."
                    });
                    return;
                }

                if (fullRepoMode) {
                    const parsedFolder = parseHfFolderLinkInfo(url);
                    if (!parsedFolder?.targetSegment) {
                        showToast({
                            severity: "error",
                            summary: "Invalid link",
                            detail: "Could not parse repository/folder from Hugging Face link."
                        });
                        return;
                    }
                    filename = `${parsedFolder.targetSegment}`;
                    queueModel = {
                        filename,
                        url,
                        folder: normalizedFolder,
                        download_mode: "folder"
                    };
                } else {
                    filename = parseFilenameFromUrl(url) || "";
                    queueModel = {
                        filename,
                        url,
                        folder: normalizedFolder || "loras"
                    };
                }

                downloadBtn.disabled = true;
                downloadBtn.textContent = "Queued";
                setStatus(
                    fullRepoMode ? "Queuing folder download..." : "Queuing download...",
                    "#9ad6ff"
                );

                try {
                    const resp = await fetch("/queue_download", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            models: [queueModel]
                        })
                    });
                    if (resp.status !== 200) {
                        throw new Error("Server returned " + resp.status + " " + resp.statusText);
                    }
                    const res = await resp.json();
                    const queued = res.queued || [];
                    const rejected = Array.isArray(res.rejected) ? res.rejected : [];
                    const downloadIds = queued.map(q => q.download_id);
                    if (!downloadIds.length) {
                        const rejection = rejected.length ? String(rejected[0]?.error || "").trim() : "";
                        const detail = rejection || "No download was queued.";
                        showToast({ severity: "warn", summary: "Queue rejected", detail });
                        downloadBtn.disabled = false;
                        downloadBtn.textContent = "Download";
                        setStatus(detail, "#f5b14c");
                        return;
                    }

                    setStatus(`Queued ${downloadIds.length} download(s). Track progress in the Downloads panel.`, "#9ad6ff");
                    const statusMap = {};
                    const pending = new Set(downloadIds);
                    let statusErrorToastShown = false;

                    const poll = async () => {
                        try {
                            const statusResp = await fetch(`/download_status?ids=${encodeURIComponent(downloadIds.join(","))}`);
                            if (statusResp.status !== 200) return;
                            const statusData = await statusResp.json();
                            const downloads = statusData.downloads || {};
                            statusErrorToastShown = false;

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
                                const failures = downloadIds.filter((id) => downloads[id]?.status === "failed" || downloads[id]?.status === "cancelled").length;
                                downloadBtn.disabled = false;
                                downloadBtn.textContent = "Download";
                                if (failures) {
                                    setStatus(`Finished with ${failures} error(s).`, "#ff6b6b");
                                } else {
                                    setStatus("Download completed.", "#5bd98c");
                                }
                            }
                        } catch (e) {
                            if (!statusErrorToastShown) {
                                showToast({
                                    severity: "error",
                                    summary: "Status error",
                                    detail: "Status polling failed. Retrying in background."
                                });
                                statusErrorToastShown = true;
                            }
                            setStatus("Status polling error.", "#ff6b6b");
                        }
                    };

                    pollTimer = setInterval(poll, 1000);
                    poll();
                } catch (e) {
                    showToast({ severity: "error", summary: "Queue error", detail: String(e) });
                    downloadBtn.disabled = false;
                    downloadBtn.textContent = "Download";
                    setStatus(`Queue error: ${String(e)}`, "#ff6b6b");
                }
            });
            applyNativeButtonStyle(downloadBtn, "primary");

            footer.appendChild(downloadBtn);
            panel.appendChild(footer);

            dlg.appendChild(panel);
            document.body.appendChild(dlg);
            loadFolderList();
            setTimeout(() => {
                if (urlInput) {
                    urlInput.focus();
                    urlInput.select();
                }
            }, 0);
        };

        const runAutoDownload = async (skippedFilenames = new Set(), skipAllUnresolved = false, options = {}) => {
            let loadingDlg = null;
            let aborted = false;
            let skipRequested = false;
            let statusTimer = null;
            const resumeRunIfPossible = () => {
                const resume = options?.resumeRun;
                if (typeof resume !== "function") {
                    return;
                }
                try {
                    resume();
                } catch (resumeErr) {
                    console.error("[AutoDownload] Failed to resume run after scan:", resumeErr);
                }
            };
            try {
                // Show loading dialog immediately
                const controller = new AbortController();
                loadingDlg = showLoadingDialog(() => {
                    skipRequested = true;
                    aborted = true;
                    loadingDlg.setSkipMode(true);
                    loadingDlg.setStatus("Skipping unresolved models...");
                    loadingDlg.setDetail("Restarting scan without Hugging Face lookups.");
                    if (statusTimer) {
                        clearInterval(statusTimer);
                        statusTimer = null;
                    }
                    controller.abort();
                }, { skipModeActive: skipAllUnresolved });

                if (skipAllUnresolved) {
                    loadingDlg.setStatus("Skipping unresolved models...");
                    loadingDlg.setDetail("Running fast scan with available links.");
                } else {
                    loadingDlg.setStatus("Looking for links...");
                    loadingDlg.setDetail("Preparing workflow scan...");
                }

                const requestId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;

                const resolveBaseUrl = () => {
                    const path = window.location.pathname || "/";
                    const basePath = path.endsWith("/") ? path : path.replace(/\/[^/]*$/, "/");
                    return window.location.origin + basePath;
                };

                const doFetch = async (path, options = {}) => {
                    const method = String(options.method || "GET").toUpperCase();
                    if (method === "GET" && api && typeof api.fetchApi === "function") {
                        let apiPath = String(path || "");
                        if (!apiPath.startsWith("/")) apiPath = "/" + apiPath;
                        return api.fetchApi(apiPath, options);
                    }
                    const baseUrl = resolveBaseUrl();
                    const relPath = String(path || "").replace(/^\/+/, "");
                    const url = new URL(relPath, baseUrl).toString();
                    return fetch(url, options);
                };

                const pollStatus = async () => {
                    try {
                        const statusResp = await doFetch(`/search_status?request_id=${encodeURIComponent(requestId)}&_t=${Date.now()}`, {
                            cache: "no-store"
                        });
                        if (statusResp.status !== 200) return;
                        const statusData = await statusResp.json();
                        const status = statusData.status || {};
                        const source = String(status.source || "").trim();
                        const filename = String(status.filename || "").trim();
                        const detailRaw = String(status.detail || "").trim();
                        let message = String(status.message || "").trim();

                        const sourceLabelMap = {
                            workflow: "Scanning workflow",
                            popular_models: "Checking curated model list",
                            manager_cache: "Checking manager cache",
                            huggingface_search: "Searching Hugging Face",
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

                        if (!message) {
                            message = sourceLabel || "Looking for links...";
                        }

                        const detailParts = [];
                        if (filename) {
                            detailParts.push(filename);
                        }
                        if (detailRaw) {
                            detailParts.push(detailRaw);
                        }
                        if (sourceLabel && !message.toLowerCase().includes(sourceLabel.toLowerCase())) {
                            detailParts.push(sourceLabel);
                        }

                        const detail = detailParts.length ? detailParts.join(" • ") : "Working...";
                        loadingDlg.setStatus(message);
                        loadingDlg.setDetail(detail);
                    } catch (e) {
                        // Ignore polling errors during search
                    }
                };
                statusTimer = setInterval(pollStatus, 600);
                pollStatus();

                const workflow = serializeWorkflowForModelScan();
                if (!workflow || typeof workflow !== "object") {
                    throw new Error("Workflow is not ready for missing-model scan.");
                }
                console.log("[AutoDownload] Scanning workflow:", workflow);

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

                // Remove loading dialog
                if (loadingDlg) {
                    if (statusTimer) {
                        clearInterval(statusTimer);
                        statusTimer = null;
                    }
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
                console.log("[AutoDownload] Scan results:", data);

                if (!countActionableScanResults(data)) {
                    const fallbackMissingFromFrontendStore =
                        await createRunHookFallbackMissingModelsFromFrontendStore(
                            Array.isArray(options?.frontendMissingModelCandidates)
                                ? options.frontendMissingModelCandidates
                                : null
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
                    const fallbackMissingFromFailures =
                        createRunHookFallbackMissingModels(options?.runHookFailures || [], workflow);
                    const fallbackMissingFromFrontendStore =
                        await createRunHookFallbackMissingModelsFromFrontendStore(
                            Array.isArray(options?.frontendMissingModelCandidates)
                                ? options.frontendMissingModelCandidates
                                : null
                        );
                    if (fallbackMissingFromFailures.length) {
                        const existingMissing = Array.isArray(data?.missing) ? data.missing : [];
                        data.missing = [...existingMissing, ...fallbackMissingFromFailures];
                    }
                    if (fallbackMissingFromFrontendStore.length) {
                        const existingMissing = Array.isArray(data?.missing) ? data.missing : [];
                        data.missing = [...existingMissing, ...fallbackMissingFromFrontendStore];
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
                        const lastChanceMissing = createLastChanceRunHookMissingModels(
                            options?.runHookFailures || [],
                            workflow
                        );
                        if (lastChanceMissing.length) {
                            const existingMissing = Array.isArray(data?.missing) ? data.missing : [];
                            data.missing = [...existingMissing, ...lastChanceMissing];
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
                showResultsDialog(data, options || {});

            } catch (e) {
                // Remove loading dialog on error
                if (loadingDlg) {
                    if (statusTimer) {
                        clearInterval(statusTimer);
                        statusTimer = null;
                    }
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
                console.error("[AutoDownload] Error:", e);
                alert("Error: " + e);
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
            actionBtn.className = "p-button p-component p-button-sm";
            actionBtn.textContent = "Auto-search and download missing models";
            Object.assign(actionBtn.style, {
                background: "#2196f3",
                color: "#fff",
                border: "none",
                padding: "9px 16px",
                fontWeight: "600"
            });

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
        };

        const setupMissingModelsDialogObserver = () => {
            if (missingModelsObserver || typeof MutationObserver === "undefined") return;
            missingModelsObserver = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (!mutation.addedNodes?.length) continue;
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType !== Node.ELEMENT_NODE) continue;
                        injectButtonsIntoMissingModelsDialogs(node);
                    }
                }
            });

            missingModelsObserver.observe(document.body, {
                childList: true,
                subtree: true
            });

            injectButtonsIntoMissingModelsDialogs(document);
            setTimeout(() => injectButtonsIntoMissingModelsDialogs(document), 300);
            setTimeout(() => injectButtonsIntoMissingModelsDialogs(document), 1000);
        };

        let runHookLastTriggeredAt = 0;
        let workflowOpenLastTriggeredAt = 0;
        let workflowOpenMissingModelsTimer = null;
        let workflowOpenLastHandledSignature = "";

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
            "name"
        ]);
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
        ];

        const getNodeErrorsSnapshot = () => {
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
            const match = text.match(/^([a-zA-Z0-9_]+)\s*:/);
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

        let resolvedModelStorePromise = null;
        let resolvedExecutionErrorStorePromise = null;
        let resolvedMissingModelStorePromise = null;

        const resolveModelStore = async () => {
            if (resolvedModelStorePromise) {
                return resolvedModelStorePromise;
            }

            resolvedModelStorePromise = (async () => {
                for (const candidate of MODEL_STORE_IMPORT_CANDIDATES) {
                    try {
                        const module = await import(candidate);
                        const useModelStore = module?.useModelStore;
                        if (typeof useModelStore === "function") {
                            const store = useModelStore();
                            if (
                                store &&
                                typeof store.loadModelFolders === "function" &&
                                typeof store.getLoadedModelFolder === "function"
                            ) {
                                return store;
                            }
                        }
                    } catch (_) {
                        // Try next import candidate.
                    }
                }
                return null;
            })();

            return resolvedModelStorePromise;
        };

        const resolveExecutionErrorStore = async () => {
            if (resolvedExecutionErrorStorePromise) {
                return resolvedExecutionErrorStorePromise;
            }

            resolvedExecutionErrorStorePromise = (async () => {
                for (const candidate of EXECUTION_ERROR_STORE_IMPORT_CANDIDATES) {
                    try {
                        const module = await import(candidate);
                        const useExecutionErrorStore = module?.useExecutionErrorStore;
                        if (typeof useExecutionErrorStore === "function") {
                            const store = useExecutionErrorStore();
                            if (store && typeof store === "object" && ("lastNodeErrors" in store)) {
                                return store;
                            }
                        }
                    } catch (_) {
                        // Try next import candidate.
                    }
                }
                return null;
            })();

            return resolvedExecutionErrorStorePromise;
        };

        const resolveMissingModelStore = async () => {
            if (resolvedMissingModelStorePromise) {
                return resolvedMissingModelStorePromise;
            }

            resolvedMissingModelStorePromise = (async () => {
                for (const candidate of MISSING_MODEL_STORE_IMPORT_CANDIDATES) {
                    try {
                        const module = await import(candidate);
                        const useMissingModelStore = module?.useMissingModelStore;
                        if (typeof useMissingModelStore === "function") {
                            const store = useMissingModelStore();
                            if (store && typeof store === "object" && ("missingModelCandidates" in store)) {
                                return store;
                            }
                        }
                    } catch (_) {
                        // Try next import candidate.
                    }
                }
                return null;
            })();

            return resolvedMissingModelStorePromise;
        };

        const getSelectedModelsMetadataNativeLike = (node) => {
            try {
                const models = Array.isArray(node?.properties?.models) ? node.properties.models : [];
                if (!models.length) return [];
                const widgetsValuesRaw = node?.widgets_values;
                if (!widgetsValuesRaw) return [];

                const widgetValues = Array.isArray(widgetsValuesRaw)
                    ? widgetsValuesRaw
                    : Object.values(widgetsValuesRaw || {});
                if (!widgetValues.length) return [];

                const stringWidgetValues = new Set();
                for (const value of widgetValues) {
                    if (typeof value === "string" && value.trim()) {
                        stringWidgetValues.add(value);
                    }
                }
                if (!stringWidgetValues.size) return [];

                return models.filter((model) => {
                    const modelName = String(model?.name || "").trim();
                    if (!modelName) return false;
                    return stringWidgetValues.has(modelName);
                });
            } catch (_) {
                return [];
            }
        };

        const collectEmbeddedModelsNativeLike = (graphData) => {
            const embeddedModels = [];

            const collectFromNodes = (nodes) => {
                if (!Array.isArray(nodes)) return;
                for (const node of nodes) {
                    const selected = getSelectedModelsMetadataNativeLike(node);
                    if (selected.length) {
                        embeddedModels.push(...selected);
                    }
                }
            };

            collectFromNodes(graphData?.nodes);

            const subgraphs = graphData?.definitions?.subgraphs;
            if (Array.isArray(subgraphs)) {
                for (const subgraph of subgraphs) {
                    collectFromNodes(subgraph?.nodes);
                }
            }

            if (Array.isArray(graphData?.models)) {
                embeddedModels.push(...graphData.models);
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
            const subgraphs = graphData?.definitions?.subgraphs;
            if (Array.isArray(subgraphs)) {
                for (const subgraph of subgraphs) {
                    pushNodes(subgraph?.nodes);
                }
            }

            for (const node of nodesToScan) {
                if (!node || typeof node !== "object") continue;

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
                    if (widgetName && MODEL_VALIDATION_INPUT_NAMES.has(widgetName)) {
                        return true;
                    }
                }

                const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
                for (const input of inputs) {
                    const widgetName = String(input?.widget?.name || input?.name || "")
                        .trim()
                        .toLowerCase();
                    if (widgetName && MODEL_VALIDATION_INPUT_NAMES.has(widgetName)) {
                        return true;
                    }
                }

                const widgetValuesRaw = node?.widgets_values;
                const widgetValues = Array.isArray(widgetValuesRaw)
                    ? widgetValuesRaw
                    : Object.values(widgetValuesRaw || {});
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
                    const nodeType = String(node?.type || "").trim();
                    if (!nodeType) continue;
                    if (!(nodeType in registeredNodeTypes)) {
                        missing.add(nodeType);
                    }
                }
            };

            collectFromNodes(graphData?.nodes);
            const subgraphs = graphData?.definitions?.subgraphs;
            if (Array.isArray(subgraphs)) {
                for (const subgraph of subgraphs) {
                    collectFromNodes(subgraph?.nodes);
                }
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

            const isValueNotInList =
                message.includes("value not in list") ||
                type.includes("value_not_in_list") ||
                detailsLower.includes("not in [");
            if (!isValueNotInList) {
                return false;
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

            const looksModelInput = MODEL_VALIDATION_INPUT_NAMES.has(inputNameLower);
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
                const classType = String(nodeError?.class_type || "");
                const reasons = Array.isArray(nodeError?.errors) ? nodeError.errors : [];
                const nodeId = parseNodeIdFromExecutionId(executionId);
                const nodeTitle = getGraphNodeTitleById(nodeId, classType || "Unknown Node");
                for (const reason of reasons) {
                    if (!isModelValidationReason(reason, classType)) {
                        continue;
                    }

                    const details = String(reason?.details || "");
                    const inputName =
                        String(reason?.extra_info?.input_name || "").trim() ||
                        parseInputNameFromDetails(details);

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

        const waitForNativeMissingModelsDialog = async (timeoutMs) => {
            const start = Date.now();
            while (Date.now() - start <= timeoutMs) {
                if (hasNativeMissingModelsDialog()) {
                    return true;
                }
                await wait(RUN_NATIVE_DIALOG_POLL_MS);
            }
            return false;
        };

        const closeNativePromptValidationDialogs = () => {
            let removed = 0;
            const nodes = document.querySelectorAll(RUN_ERROR_DIALOG_SELECTOR);
            for (const node of nodes) {
                const text = String(node?.textContent || "").toLowerCase();
                if (!text.includes("prompt execution failed")) continue;
                if (!text.includes("value not in list")) continue;

                const container =
                    node.closest(".p-dialog-mask") ||
                    node.closest(".p-dialog") ||
                    node;
                if (container && container.parentElement) {
                    container.remove();
                    removed += 1;
                }
            }
            return removed;
        };

        const suppressNativePromptValidationDialogsSoon = () => {
            closeNativePromptValidationDialogs();
            [70, 160, 320, 620].forEach((delay) => {
                setTimeout(() => {
                    closeNativePromptValidationDialogs();
                }, delay);
            });
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

        const forEachGraphNodeRecursive = (graph, callback) => {
            if (!graph || typeof callback !== "function") return;
            const nodes = Array.isArray(graph?._nodes) ? graph._nodes : [];
            for (const node of nodes) {
                callback(node);
            }
            const subgraphs = graph?.subgraphs;
            if (subgraphs && typeof subgraphs.values === "function") {
                for (const subgraph of subgraphs.values()) {
                    forEachGraphNodeRecursive(subgraph, callback);
                }
            }
        };

        const applyNodeErrorsFallback = (nodeErrors) => {
            forEachGraphNodeRecursive(app?.graph, (node) => {
                if (!node || typeof node !== "object") return;
                node.has_errors = false;
                const inputs = Array.isArray(node.inputs) ? node.inputs : [];
                for (const slot of inputs) {
                    if (slot && typeof slot === "object") {
                        delete slot.hasErrors;
                    }
                }
            });

            if (nodeErrors && typeof nodeErrors === "object") {
                for (const [executionId, nodeError] of Object.entries(nodeErrors)) {
                    const idToken = String(executionId || "").split(":").pop();
                    const numericId = Number(idToken);
                    if (!Number.isFinite(numericId)) {
                        continue;
                    }
                    const node = app?.graph?.getNodeById?.(numericId);
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
                    return true;
                } catch (_) {
                    // Fall through to in-place update result.
                }
            }

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
                    if (typeof executionErrorStore.dismissErrorOverlay === "function") {
                        executionErrorStore.dismissErrorOverlay();
                    } else if ("isErrorOverlayOpen" in executionErrorStore) {
                        executionErrorStore.isErrorOverlayOpen = false;
                    }
                } catch (_) {
                    // Ignore overlay clear failures.
                }
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
                const numericNodeId = Number(candidate?.nodeId ?? candidate?.node_id);
                if (!Number.isFinite(numericNodeId)) {
                    continue;
                }
                if (!nodeInputNames.has(numericNodeId)) {
                    nodeInputNames.set(numericNodeId, new Set());
                }
                const inputName = String(candidate?.widgetName || candidate?.input_name || "").trim();
                if (inputName) {
                    nodeInputNames.get(numericNodeId).add(inputName);
                }
            }

            if (!nodeInputNames.size) {
                return 0;
            }

            let clearedCount = 0;
            forEachGraphNodeRecursive(app?.graph, (node) => {
                const numericNodeId = Number(node?.id);
                if (!Number.isFinite(numericNodeId) || !nodeInputNames.has(numericNodeId)) {
                    return;
                }

                clearedCount += 1;
                node.has_errors = false;

                const targetInputNames = nodeInputNames.get(numericNodeId) || new Set();
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

        const triggerAutoDownloadFromWorkflowOpen = (candidates = []) => {
            const workflowOpenCandidates = Array.isArray(candidates)
                ? candidates
                    .filter((candidate) => isMissingModelCandidate(candidate))
                    .map((candidate) => ({ ...candidate }))
                : [];
            const now = Date.now();
            if (now - workflowOpenLastTriggeredAt < WORKFLOW_OPEN_TRIGGER_COOLDOWN_MS) {
                clearMissingModelNodeHighlights(workflowOpenCandidates);
                void clearMissingModelStoreState(workflowOpenCandidates);
                void clearModelValidationErrorsFromFrontendState();
                return false;
            }
            if (document.getElementById("auto-download-dialog")) {
                clearMissingModelNodeHighlights(workflowOpenCandidates);
                void clearMissingModelStoreState(workflowOpenCandidates);
                void clearModelValidationErrorsFromFrontendState();
                return false;
            }

            const runAction = window?.hfDownloader?.runAutoDownload;
            if (typeof runAction !== "function") {
                return false;
            }

            workflowOpenLastTriggeredAt = now;
            clearMissingModelNodeHighlights(workflowOpenCandidates);
            void clearModelValidationErrorsFromFrontendState();
            runAction(new Set(), false, {
                suppressEmptyResults: true,
                triggeredByWorkflowOpen: true,
                frontendMissingModelCandidates: workflowOpenCandidates,
                reason: "workflow-open-missing-models",
            });
            void clearMissingModelStoreState(workflowOpenCandidates);
            showToast({
                severity: "info",
                summary: "Missing models detected",
                detail: "Opened Auto-download from ComfyUI's workflow-open missing-model scan.",
                life: 3200,
            });
            return true;
        };

        const installWorkflowOpenMissingModelsWatcher = () => {
            if (workflowOpenMissingModelsTimer) {
                return;
            }

            let pollBusy = false;
            const poll = async () => {
                if (pollBusy) {
                    return;
                }
                pollBusy = true;
                try {
                    if (!getWorkflowOpenAutoEnabled()) {
                        return;
                    }
                    const candidates = await getFrontendMissingModelCandidates();
                    const signature = buildMissingModelCandidatesSignature(candidates);
                    if (!signature) {
                        workflowOpenLastHandledSignature = "";
                        return;
                    }
                    if (signature === workflowOpenLastHandledSignature) {
                        return;
                    }
                    if (!isWorkflowReadyForModelScan()) {
                        return;
                    }

                    workflowOpenLastHandledSignature = signature;
                    triggerAutoDownloadFromWorkflowOpen(candidates);
                } finally {
                    pollBusy = false;
                }
            };

            workflowOpenMissingModelsTimer = setInterval(() => {
                void poll();
            }, WORKFLOW_OPEN_CANDIDATE_POLL_MS);
            void poll();
        };

        const waitForNativeModelValidationFailure = async ({
            timeoutMs,
            beforeSignature,
            hadValidationDialogBeforeRun
        }) => {
            const start = Date.now();
            while (Date.now() - start <= timeoutMs) {
                const nodeErrors = getNodeErrorsSnapshot();
                const signature = getNodeErrorsSignature(nodeErrors);
                if (signature && signature !== beforeSignature) {
                    const failures = getNativeModelValidationFailures(nodeErrors);
                    if (failures.length) {
                        return failures;
                    }
                }

                if (!hadValidationDialogBeforeRun && hasNativePromptValidationDialog()) {
                    const failures = getNativeModelValidationFailures(nodeErrors);
                    if (failures.length) {
                        return failures;
                    }
                    if (shouldSuppressPromptValidationTriggerForFlashVsr()) {
                        return [];
                    }
                    return [
                        {
                            classType: "",
                            inputName: "",
                            missingValue: "",
                            details: "Prompt execution failed"
                        }
                    ];
                }

                await wait(RUN_NATIVE_VALIDATION_POLL_MS);
            }
            return [];
        };

        const getImmediateValidationFailures = ({
            beforeSignature,
            hadValidationDialogBeforeRun
        }) => {
            const nodeErrors = getNodeErrorsSnapshot();
            const signature = getNodeErrorsSignature(nodeErrors);
            if (signature && signature !== beforeSignature) {
                const failures = getNativeModelValidationFailures(nodeErrors);
                if (failures.length) {
                    return failures;
                }
            }

            if (!hadValidationDialogBeforeRun && hasNativePromptValidationDialog()) {
                const failures = getNativeModelValidationFailures(nodeErrors);
                if (failures.length) {
                    return failures;
                }
                if (shouldSuppressPromptValidationTriggerForFlashVsr()) {
                    return [];
                }
                return [
                    {
                        classType: "",
                        inputName: "",
                        missingValue: "",
                        details: "Prompt execution failed"
                    }
                ];
            }

            return [];
        };

        const triggerAutoDownloadFromRunHook = (reason = "missing-dialog", failures = [], extraOptions = {}) => {
            const isValidationReason = reason === "model-validation";
            const now = Date.now();
            if (now - runHookLastTriggeredAt < RUN_HOOK_COOLDOWN_MS) {
                if (isValidationReason) {
                    void clearModelValidationErrorsFromFrontendState();
                }
                if (document.getElementById("auto-download-dialog")) {
                    suppressNativePromptValidationDialogsSoon();
                }
                return false;
            }
            if (document.getElementById("auto-download-dialog")) {
                if (isValidationReason) {
                    void clearModelValidationErrorsFromFrontendState();
                }
                suppressNativePromptValidationDialogsSoon();
                return false;
            }
            const runAction = window?.hfDownloader?.runAutoDownload;
            if (typeof runAction !== "function") {
                return false;
            }

            runHookLastTriggeredAt = now;
            suppressNativePromptValidationDialogsSoon();
            runAction(new Set(), false, {
                suppressEmptyResults: true,
                triggeredByRunHook: true,
                reason,
                runHookFailures: Array.isArray(failures) ? failures : [],
                ...extraOptions,
            });
            if (isValidationReason) {
                void clearModelValidationErrorsFromFrontendState();
            }

            const firstMissing = failures.find((item) => item?.missingValue)?.missingValue || "";
            const detail = isValidationReason
                ? (
                    firstMissing
                        ? `Detected run validation mismatch for "${firstMissing}". Started auto-download scan.`
                        : "Detected run validation mismatch for model loaders. Started auto-download scan."
                )
                : (reason === "native-missing-models"
                    ? (
                        firstMissing
                            ? `Native missing-model check found "${firstMissing}". Started auto-download scan.`
                            : "Native missing-model check failed. Started auto-download scan."
                    )
                    : "Started auto-download scan from native missing-model check.");

            showToast({
                severity: "info",
                summary: "Missing models detected",
                detail,
                life: 3200
            });
            return true;
        };

        const installRunQueueCommandHooksNativeAware = () => {
            let attempts = 0;
            let timer = null;

            const applyOverride = (commandId) => {
                const commands = app?.extensionManager?.command?.commands;
                if (!Array.isArray(commands)) {
                    return false;
                }
                const command = commands.find((entry) => entry?.id === commandId);
                if (!command || typeof command.function !== "function") {
                    return false;
                }
                if (command[RUN_COMMAND_OVERRIDE_MARKER]) {
                    return true;
                }

                const originalFn = command.function;
                command[RUN_COMMAND_ORIGINAL_FN] = originalFn;

                command.function = async (metadata) => {
                    const fallback = command[RUN_COMMAND_ORIGINAL_FN];
                    if (typeof fallback !== "function") {
                        return undefined;
                    }
                    if (runHookBypassRemaining > 0) {
                        runHookBypassRemaining = Math.max(0, runHookBypassRemaining - 1);
                        return fallback(metadata);
                    }

                    let resumeQueued = false;
                    const resumeRun = () => {
                        if (resumeQueued) {
                            return;
                        }
                        resumeQueued = true;
                        runHookBypassRemaining += 1;
                        setTimeout(async () => {
                            try {
                                await fallback(metadata);
                            } catch (resumeErr) {
                                console.error("[AutoDownload] Failed to resume original run:", resumeErr);
                            }
                        }, 0);
                    };

                    const hookEnabled = getRunHookEnabled();
                    const graphData = serializeWorkflowForModelScan();
                    const missingNodeTypes = getMissingNodeTypesNativeLike(graphData);
                    const hasMissingNodes = missingNodeTypes.length > 0;
                    const hadDialogBeforeRun = hasNativeMissingModelsDialog();
                    const hadValidationDialogBeforeRun = hasNativePromptValidationDialog();
                    const beforeNodeErrorSignature = getNodeErrorsSignature(getNodeErrorsSnapshot());
                    let preRunEligibleMissingModels = [];
                    let preRunPathMismatches = [];

                    if (hookEnabled && !hasMissingNodes) {
                        const preRunMissingModels = await getPreRunMissingModelsNativeLike(graphData);
                        preRunEligibleMissingModels =
                            filterRunHookEligibleMissingModels(preRunMissingModels);
                        if (!preRunEligibleMissingModels.length) {
                            const backendPreflight =
                                await getPreRunMissingModelsBackendFallback(graphData);
                            preRunEligibleMissingModels = backendPreflight.missing;
                            preRunPathMismatches = backendPreflight.pathMismatches;
                        }
                        if (preRunEligibleMissingModels.length || preRunPathMismatches.length) {
                            const preRunFailures = preRunEligibleMissingModels.map((model) => ({
                                classType: "",
                                inputName: "",
                                missingValue: String(model?.name || "").trim(),
                                details: `${String(model?.directory || "").trim()}/${String(model?.name || "").trim()}`
                            })).concat(
                                preRunPathMismatches.map((item) => ({
                                    classType: "",
                                    inputName: "",
                                    missingValue:
                                        String(item?.filename || item?.requested_path || "").trim(),
                                    details:
                                        String(item?.expected_path || item?.requested_path || "").trim() ||
                                        String(item?.actual_path || "").trim()
                                }))
                            );
                            const preRunReason = preRunEligibleMissingModels.length
                                ? "native-missing-models"
                                : "missing-dialog";
                            if (triggerAutoDownloadFromRunHook(preRunReason, preRunFailures, { resumeRun })) {
                                return false;
                            }
                        }
                    }

                    let result;
                    let error;
                    try {
                        result = await fallback(metadata);
                    } catch (err) {
                        error = err;
                    }

                    if (hookEnabled && !hasMissingNodes) {
                        const immediateHasDialog = !hadDialogBeforeRun && hasNativeMissingModelsDialog();
                        const immediateValidationFailures = getImmediateValidationFailures({
                            beforeSignature: beforeNodeErrorSignature,
                            hadValidationDialogBeforeRun
                        });

                        let triggeredImmediately = false;
                        if (immediateHasDialog) {
                            const shouldSuppressFlashVsrDialogTrigger =
                                shouldSuppressMissingDialogTriggerForFlashVsr();
                            const shouldTriggerMissingDialog =
                                !shouldSuppressFlashVsrDialogTrigger ||
                                preRunEligibleMissingModels.length > 0;
                            if (shouldTriggerMissingDialog) {
                                triggeredImmediately =
                                    triggerAutoDownloadFromRunHook("missing-dialog", [], { resumeRun }) || triggeredImmediately;
                            }
                        }
                        if (immediateValidationFailures.length) {
                            triggeredImmediately =
                                triggerAutoDownloadFromRunHook("model-validation", immediateValidationFailures, { resumeRun }) ||
                                triggeredImmediately;
                        }

                        if (!triggeredImmediately) {
                            void (async () => {
                                try {
                                    const [hasDialogNow, validationFailures] = await Promise.all([
                                        hadDialogBeforeRun
                                            ? Promise.resolve(false)
                                            : waitForNativeMissingModelsDialog(RUN_NATIVE_DIALOG_WAIT_MS),
                                        waitForNativeModelValidationFailure({
                                            timeoutMs: RUN_NATIVE_VALIDATION_WAIT_MS,
                                            beforeSignature: beforeNodeErrorSignature,
                                            hadValidationDialogBeforeRun
                                        })
                                    ]);

                                    if (hasDialogNow) {
                                        const shouldSuppressFlashVsrDialogTrigger =
                                            shouldSuppressMissingDialogTriggerForFlashVsr();
                                        const shouldTriggerMissingDialog =
                                            !shouldSuppressFlashVsrDialogTrigger ||
                                            preRunEligibleMissingModels.length > 0;
                                        if (shouldTriggerMissingDialog) {
                                            triggerAutoDownloadFromRunHook("missing-dialog", [], { resumeRun });
                                        }
                                    }
                                    if (validationFailures.length) {
                                        triggerAutoDownloadFromRunHook("model-validation", validationFailures, { resumeRun });
                                    }
                                } catch (_) {
                                    // No-op: run behavior must remain native even if hook observation fails.
                                }
                            })();
                        }
                    }

                    if (error) {
                        throw error;
                    }
                    return result;
                };

                command[RUN_COMMAND_OVERRIDE_MARKER] = true;
                return true;
            };

            const runAttempt = () => {
                attempts += 1;
                let allApplied = true;
                for (const commandId of RUN_QUEUE_COMMAND_IDS) {
                    if (!applyOverride(commandId)) {
                        allApplied = false;
                    }
                }

                if (allApplied || attempts >= RUN_COMMAND_OVERRIDE_MAX_ATTEMPTS) {
                    if (timer) {
                        clearInterval(timer);
                        timer = null;
                    }
                    if (!allApplied) {
                        console.warn("[AutoDownload] Could not hook all Run commands.");
                    }
                }
                return allApplied;
            };

            const firstApplied = runAttempt();
            if (!firstApplied && attempts < RUN_COMMAND_OVERRIDE_MAX_ATTEMPTS) {
                timer = setInterval(runAttempt, RUN_COMMAND_OVERRIDE_RETRY_MS);
            }
        };

        registerGlobalAction("runAutoDownload", runAutoDownload);
        registerGlobalAction("showManualDownloadDialog", showManualDownloadDialog);
        setupMissingModelsDialogObserver();
        installWorkflowOpenMissingModelsWatcher();
        installRunQueueCommandHooksNativeAware();
    }
});
