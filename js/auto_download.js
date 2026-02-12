import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

app.registerExtension({
    name: "autoDownloadModels",
    setup() {
        /* ──────────────── Helper Functions ──────────────── */
        const createButton = (text, className, onClick) => {
            const btn = document.createElement("button");
            btn.textContent = text;
            btn.className = className; // e.g. "p-button p-component"
            if (onClick) btn.onclick = onClick;
            return btn;
        };

        const createInput = (value, placeholder) => {
            const inp = document.createElement("input");
            inp.type = "text";
            inp.value = value || "";
            inp.placeholder = placeholder || "";
            Object.assign(inp.style, {
                background: "#0f131a",
                border: "1px solid #414857",
                color: "#e8edf8",
                padding: "7px 10px",
                borderRadius: "9px",
                width: "100%",
                boxSizing: "border-box",
                minHeight: "36px",
                fontSize: "14px",
                lineHeight: "1.3"
            });

            if (!value && placeholder && placeholder.includes("URL")) {
                inp.style.borderColor = "#7a4750";
                inp.style.background = "#221720";

                inp.addEventListener("input", () => {
                    if (inp.value.trim()) {
                        inp.style.borderColor = "#414857";
                        inp.style.background = "#0f131a";
                    } else {
                        inp.style.borderColor = "#7a4750";
                        inp.style.background = "#221720";
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

            const payload = {
                severity: toastOptions.severity || type,
                summary: toastOptions.summary,
                detail: toastOptions.detail,
                closable: toastOptions.closable,
                life: toastOptions.life,
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
                background: "#131923",
                border: "1px solid #3a4354",
                borderTop: "none",
                maxHeight: "180px",
                overflowY: "auto",
                zIndex: 10,
                display: "none",
                borderRadius: "0 0 8px 8px"
            });

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
                        color: "#d8dfec",
                        fontSize: "13px"
                    });
                    item.addEventListener("mouseenter", () => {
                        item.style.background = "#252d3c";
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

        const normalizeWorkflowPath = (value) => String(value || "").replace(/\\/g, "/").trim();

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

            const fromInputUrl = parseFilenameFromUrl(rowData?.urlInput?.value || "");
            if (fromInputUrl) return fromInputUrl;

            const fromResolvedUrl = parseFilenameFromUrl(rowData?.resolvedUrl || "");
            if (fromResolvedUrl) return fromResolvedUrl;

            const fallback = String(rowData?.filename || "").trim();
            return fallback || null;
        };

        const syncRowFilename = (rowData, filename) => {
            const next = String(filename || "").trim();
            if (!next) return;
            if (rowData.filename !== next) {
                rowData.filename = next;
                if (rowData.nameEl) {
                    rowData.nameEl.textContent = next;
                }
            }
        };

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
            Object.assign(dlg.style, {
                position: "fixed",
                top: 0,
                left: 0,
                width: "100vw",
                height: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(8,10,16,0.72)",
                zIndex: 9000
            });

            const panel = document.createElement("div");
            Object.assign(panel.style, {
                background: "#171b24",
                color: "#fff",
                padding: "22px 24px",
                borderRadius: "12px",
                textAlign: "left",
                width: "480px",
                maxWidth: "92vw",
                border: "1px solid #3a4560",
                boxShadow: "0 14px 34px rgba(0, 0, 0, 0.5)"
            });

            const statusEl = document.createElement("div");
            statusEl.textContent = "Preparing scan...";
            Object.assign(statusEl.style, {
                fontSize: "18px",
                lineHeight: "1.25",
                fontWeight: "600",
                letterSpacing: "-0.005em"
            });

            const detailEl = document.createElement("div");
            detailEl.textContent = "Preparing workflow scan...";
            Object.assign(detailEl.style, {
                fontSize: "12px",
                color: "#a2aec8",
                marginTop: "8px",
                minHeight: "18px"
            });

            const actionsEl = document.createElement("div");
            Object.assign(actionsEl.style, {
                display: "flex",
                gap: "8px",
                marginTop: "14px",
                justifyContent: "flex-start"
            });

            const buttonBaseStyle = {
                padding: "7px 16px",
                borderRadius: "7px",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: "600"
            };

            const skipBtn = document.createElement("button");
            skipBtn.textContent = "Skip";
            Object.assign(skipBtn.style, {
                ...buttonBaseStyle,
                background: "#2c3344",
                color: "#e2e9f8",
                border: "1px solid #465673",
                opacity: skipModeActive ? "0.65" : "1"
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
            closeIconButton.textContent = "×";
            Object.assign(closeIconButton.style, {
                width: "34px",
                height: "34px",
                borderRadius: "8px",
                border: "none",
                background: "transparent",
                color: "#a9b2c2",
                fontSize: "34px",
                lineHeight: "1",
                cursor: "pointer",
                padding: "0",
                display: "grid",
                placeItems: "center",
            });
            closeIconButton.onmouseenter = () => {
                closeIconButton.style.background = "rgba(113, 126, 150, 0.2)";
                closeIconButton.style.color = "#e7edf9";
            };
            closeIconButton.onmouseleave = () => {
                closeIconButton.style.background = "transparent";
                closeIconButton.style.color = "#a9b2c2";
            };
            closeIconButton.onclick = () => {
                if (typeof onClose === "function") {
                    onClose();
                }
            };
            return closeIconButton;
        };

        /* ──────────────── UI Components ──────────────── */
        const showResultsDialog = (data) => {
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
            Object.assign(dlg.style, {
                position: "fixed",
                top: 0,
                left: 0,
                width: "100vw",
                height: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(8, 11, 17, 0.72)",
                zIndex: 9000,
                padding: "16px",
                boxSizing: "border-box",
            });

            let content = null;
            const cleanupUi = () => {};

            const closeDialog = () => {
                stopPolling();
                cleanupUi();
                if (dlg.parentElement) {
                    dlg.remove();
                }
            };

            dlg.addEventListener("click", (e) => {
                if (e.target === dlg) {
                    closeDialog();
                }
            });

            const panel = document.createElement("div");
            Object.assign(panel.style, {
                background: "#141922",
                color: "#fff",
                border: "1px solid #303746",
                borderRadius: "14px",
                width: "min(1220px, 100%)",
                maxHeight: "92vh",
                padding: "18px",
                boxShadow: "0 16px 42px rgba(0,0,0,0.55)",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                overflow: "hidden",
            });

            const headerWrap = document.createElement("div");
            Object.assign(headerWrap.style, {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
            });

            const titleWrap = document.createElement("div");
            Object.assign(titleWrap.style, {
                display: "flex",
                flexDirection: "column",
                gap: "4px",
            });

            const titleEl = document.createElement("div");
            titleEl.textContent = "Auto-Download Models";
            Object.assign(titleEl.style, {
                fontSize: "24px",
                fontWeight: "700",
                letterSpacing: "-0.01em",
                color: "#f0f4fc",
            });

            const subtitleEl = document.createElement("div");
            subtitleEl.textContent = "Detected missing models and valid URLs.";
            Object.assign(subtitleEl.style, {
                fontSize: "14px",
                color: "#a4adbe",
            });

            titleWrap.appendChild(titleEl);
            titleWrap.appendChild(subtitleEl);
            headerWrap.appendChild(titleWrap);
            headerWrap.appendChild(createDialogCloseIconButton(closeDialog));
            panel.appendChild(headerWrap);

            const missingModels = Array.isArray(data.missing) ? [...data.missing] : [];
            missingModels.sort((a, b) => {
                const aMissing = a.url ? 0 : 1;
                const bMissing = b.url ? 0 : 1;
                if (aMissing !== bMissing) return bMissing - aMissing;
                return (a.filename || "").localeCompare(b.filename || "");
            });

            const foundModels = Array.isArray(data.found) ? data.found : [];
            const mismatchModels = Array.isArray(data.mismatches) ? data.mismatches : [];

            const summaryRow = document.createElement("div");
            Object.assign(summaryRow.style, {
                display: "flex",
                flexWrap: "wrap",
                gap: "10px",
                fontSize: "13px",
                color: "#93a0b8",
            });
            summaryRow.textContent = `Missing: ${missingModels.length} • Found: ${foundModels.length} • Mismatches: ${mismatchModels.length}`;
            panel.appendChild(summaryRow);

            const listFrame = document.createElement("div");
            Object.assign(listFrame.style, {
                border: "1px solid #313848",
                borderRadius: "10px",
                background: "#111720",
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
                gap: "10px",
                padding: "12px",
            });
            loadFolderList();

            const makeSectionTitle = (text, color = "#9aa4b6") => {
                const sectionTitle = document.createElement("div");
                sectionTitle.textContent = text;
                Object.assign(sectionTitle.style, {
                    color,
                    fontSize: "12px",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    padding: "2px 2px 2px",
                    fontWeight: "600",
                });
                return sectionTitle;
            };

            const makeBaseRow = () => {
                const row = document.createElement("div");
                Object.assign(row.style, {
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    flexWrap: "wrap",
                    background: "#1a202b",
                    border: "1px solid #2f3646",
                    padding: "11px",
                    borderRadius: "8px",
                });
                return row;
            };

            const rowInputs = [];

            content.appendChild(makeSectionTitle("Missing Models"));
            if (!missingModels.length) {
                const noMissing = document.createElement("div");
                noMissing.textContent = "No missing models detected.";
                Object.assign(noMissing.style, {
                    padding: "12px",
                    color: "#5bd98c",
                    fontSize: "14px",
                });
                content.appendChild(noMissing);
            } else {
                missingModels.forEach((m) => {
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
                    cb.style.marginTop = "2px";

                    const infoDiv = document.createElement("div");
                    Object.assign(infoDiv.style, {
                        flex: "1 1 220px",
                        minWidth: "180px",
                    });
                    const nameEl = document.createElement("div");
                    Object.assign(nameEl.style, {
                        fontWeight: "600",
                        fontSize: "16px",
                        lineHeight: "1.2",
                        wordBreak: "break-word",
                        color: "#edf2fb",
                    });
                    nameEl.textContent = m.filename || "Unknown model";

                    const metaEl = document.createElement("div");
                    Object.assign(metaEl.style, {
                        fontSize: "12px",
                        color: "#99a5bb",
                        marginTop: "3px",
                    });
                    metaEl.textContent = `${m.node_title || "Unknown Node"}${m.source ? " • " + m.source : ""}`;
                    infoDiv.appendChild(nameEl);
                    infoDiv.appendChild(metaEl);

                    const urlInput = createInput(m.url, "HuggingFace URL...");
                    Object.assign(urlInput.style, {
                        flex: "2 1 320px",
                        minWidth: "220px",
                        fontSize: "14px",
                        minHeight: "36px",
                    });

                    const folderPicker = createFolderPicker(m.suggested_folder || "checkpoints", "Folder");
                    Object.assign(folderPicker.wrapper.style, {
                        flex: "0 0 180px",
                        minWidth: "140px",
                    });
                    Object.assign(folderPicker.input.style, {
                        fontSize: "14px",
                        minHeight: "36px",
                    });

                    row.appendChild(cb);
                    row.appendChild(infoDiv);
                    row.appendChild(urlInput);
                    row.appendChild(folderPicker.wrapper);
                    rowWrapper.appendChild(row);

                    const rowData = {
                        checkbox: cb,
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
                    };
                    rowInputs.push(rowData);

                    if (Array.isArray(m.alternatives) && m.alternatives.length > 0) {
                        const altToggle = document.createElement("button");
                        altToggle.textContent = `Alternatives (${m.alternatives.length})`;
                        Object.assign(altToggle.style, {
                            alignSelf: "flex-start",
                            fontSize: "12px",
                            padding: "6px 9px",
                            background: "#2a3140",
                            color: "#d9e2f3",
                            border: "1px solid #3c4558",
                            borderRadius: "7px",
                            cursor: "pointer",
                            fontWeight: "600",
                        });

                        const altList = document.createElement("div");
                        Object.assign(altList.style, {
                            display: "none",
                            background: "#151b25",
                            border: "1px solid #2d3443",
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
                                padding: "5px 0",
                                borderBottom: "1px solid #242b38",
                            });

                            const altLabel = document.createElement("div");
                            altLabel.style.fontSize = "12px";
                            altLabel.style.color = "#b7c1d6";
                            altLabel.textContent = `${alt.filename}${alt.source ? " • " + alt.source : ""}`;

                            const useBtn = document.createElement("button");
                            useBtn.textContent = "Use";
                            Object.assign(useBtn.style, {
                                padding: "5px 10px",
                                background: "#304059",
                                color: "#e9f1ff",
                                border: "1px solid #3f5270",
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
                                if (alt.suggested_folder) {
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
            }

            content.appendChild(makeSectionTitle("Found Local Models"));
            if (!foundModels.length) {
                const noneFound = document.createElement("div");
                noneFound.textContent = "No already-installed models matched this workflow.";
                Object.assign(noneFound.style, {
                    padding: "10px 12px",
                    color: "#99a3b8",
                    fontSize: "13px",
                });
                content.appendChild(noneFound);
            } else {
                foundModels.forEach((m) => {
                    const row = makeBaseRow();

                    const marker = document.createElement("div");
                    marker.textContent = "✓";
                    Object.assign(marker.style, {
                        color: "#5bd98c",
                        fontSize: "16px",
                        fontWeight: "700",
                        width: "14px",
                        textAlign: "center",
                    });

                    const infoDiv = document.createElement("div");
                    Object.assign(infoDiv.style, {
                        flex: "1 1 240px",
                        minWidth: "200px",
                    });

                    const nameEl = document.createElement("div");
                    nameEl.textContent = m.filename || "Unknown model";
                    Object.assign(nameEl.style, {
                        fontWeight: "600",
                        fontSize: "15px",
                        lineHeight: "1.2",
                        wordBreak: "break-word",
                        color: "#edf2fb",
                    });

                    const metaEl = document.createElement("div");
                    metaEl.textContent = `${m.source || "exact_match"} • already installed`;
                    Object.assign(metaEl.style, {
                        fontSize: "12px",
                        color: "#99a5bb",
                        marginTop: "3px",
                    });

                    infoDiv.appendChild(nameEl);
                    infoDiv.appendChild(metaEl);

                    const pathEl = document.createElement("div");
                    pathEl.textContent = formatFoundModelPath(m.found_path || m.clean_path || "");
                    Object.assign(pathEl.style, {
                        flex: "2 1 360px",
                        minWidth: "220px",
                        fontSize: "13px",
                        color: "#cfd8ea",
                        wordBreak: "break-word",
                    });

                    row.appendChild(marker);
                    row.appendChild(infoDiv);
                    row.appendChild(pathEl);
                    content.appendChild(row);
                });
            }

            if (mismatchModels.length > 0) {
                content.appendChild(makeSectionTitle("Path Mismatches", "#f7b96a"));
                mismatchModels.forEach((m) => {
                    const row = makeBaseRow();
                    const left = document.createElement("div");
                    Object.assign(left.style, {
                        flex: "1 1 260px",
                        minWidth: "220px",
                    });
                    const currentLabel = m.requested_path || m.filename;
                    left.innerHTML = `<div style="color:#aaa; font-size:11px">Current: ${currentLabel}</div><div style="color:#4caf50; font-weight:600; font-size:12px; margin-top:2px;">Found: ${m.clean_path}</div>`;

                    const fixBtn = document.createElement("button");
                    fixBtn.textContent = "Fix Path";
                    Object.assign(fixBtn.style, {
                        padding: "6px 11px",
                        background: "#2f84da",
                        color: "white",
                        border: "1px solid #3f9af7",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontWeight: "600",
                        fontSize: "13px",
                    });

                    fixBtn.onclick = () => {
                        const node = app.graph.getNodeById(m.node_id);
                        if (!node) {
                            alert("Node not found.");
                            return;
                        }
                        const targetValue = m.requested_path || m.filename;
                        const widget = node.widgets.find((w) => w.value === targetValue || w.value === m.filename);
                        if (!widget) {
                            alert("Could not find matching widget value on node.");
                            return;
                        }
                        widget.value = m.clean_path;
                        node.setDirtyCanvas(true);
                        fixBtn.textContent = "Fixed";
                        fixBtn.style.background = "#4caf50";
                        fixBtn.disabled = true;
                    };

                    row.appendChild(left);
                    row.appendChild(fixBtn);
                    content.appendChild(row);
                });
            }

            listFrame.appendChild(content);
            panel.appendChild(listFrame);

            const statusLine = document.createElement("div");
            Object.assign(statusLine.style, {
                fontSize: "13px",
                color: "#9ba8be",
                minHeight: "17px",
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
                gap: "10px",
                marginTop: "4px",
            });

            const downloadBtn = createButton("Download Selected", "p-button p-component p-button-success", async () => {
                const selectedRows = rowInputs.filter((r) => r.checkbox.checked);
                const toDownload = selectedRows.map((r) => ({
                    filename: r.filename,
                    url: r.urlInput.value.trim(),
                    folder: r.folderInput.value.trim(),
                }));

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
                    const effectiveFilename = resolveDownloadedFilename(row);
                    if (effectiveFilename) {
                        item.filename = effectiveFilename;
                        syncRowFilename(row, effectiveFilename);
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
                                const failures = downloadIds.filter((id) => downloads[id]?.status === "failed" || downloads[id]?.status === "cancelled").length;
                                let updatedRefs = 0;
                                for (const id of downloadIds) {
                                    const info = downloads[id];
                                    if (!info || (info.status !== "downloaded" && info.status !== "completed")) continue;
                                    const row = queueRowsById.get(id);
                                    if (!row) continue;
                                    const effectiveFilename = resolveDownloadedFilename(row, info);
                                    if (effectiveFilename) {
                                        syncRowFilename(row, effectiveFilename);
                                    }
                                    updatedRefs += applyDownloadedReferenceToWorkflow(row, info);
                                }

                                if (failures) {
                                    showToast({
                                        severity: failures === downloadIds.length ? "error" : "warn",
                                        summary: "Downloads finished with errors",
                                        detail: `${downloadIds.length - failures} succeeded, ${failures} failed or cancelled.`,
                                    });
                                } else {
                                    showToast({
                                        severity: "success",
                                        summary: "Downloads queued",
                                        detail: `${downloadIds.length} model(s) completed.`,
                                    });
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

            if (!missingModels.length) {
                downloadBtn.disabled = true;
            }
            Object.assign(downloadBtn.style, {
                minHeight: "36px",
                padding: "0.42rem 0.95rem",
                fontSize: "14px",
                fontWeight: "600",
                borderRadius: "8px",
            });

            footer.appendChild(downloadBtn);
            panel.appendChild(footer);

            dlg.appendChild(panel);
            document.body.appendChild(dlg);
            setTimeout(() => {
                const firstUrlInput = dlg.querySelector("input[placeholder='HuggingFace URL...']");
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
            Object.assign(dlg.style, {
                position: "fixed",
                top: 0,
                left: 0,
                width: "100vw",
                height: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(8, 11, 17, 0.72)",
                zIndex: 9000
            });

            const closeDialog = () => {
                stopPolling();
                if (dlg.parentElement) {
                    dlg.remove();
                }
            };

            dlg.addEventListener("click", (e) => {
                if (e.target === dlg) {
                    closeDialog();
                }
            });

            const panel = document.createElement("div");
            Object.assign(panel.style, {
                background: "#141922",
                color: "#fff",
                padding: "18px",
                borderRadius: "14px",
                width: "min(820px, 100%)",
                maxWidth: "92vw",
                maxHeight: "92vh",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                boxShadow: "0 16px 42px rgba(0,0,0,0.55)",
                border: "1px solid #303746",
                overflow: "hidden",
            });

            const headerWrap = document.createElement("div");
            Object.assign(headerWrap.style, {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
            });

            const titleWrap = document.createElement("div");
            Object.assign(titleWrap.style, {
                display: "flex",
                flexDirection: "column",
                gap: "4px",
            });

            const titleEl = document.createElement("div");
            titleEl.textContent = "Download New Model";
            Object.assign(titleEl.style, {
                fontSize: "24px",
                fontWeight: "700",
                letterSpacing: "-0.01em",
                color: "#f0f4fc",
            });

            const subtitleEl = document.createElement("div");
            subtitleEl.textContent = "Paste a direct Hugging Face file URL and choose a folder.";
            Object.assign(subtitleEl.style, {
                fontSize: "14px",
                color: "#a4adbe",
            });

            titleWrap.appendChild(titleEl);
            titleWrap.appendChild(subtitleEl);
            headerWrap.appendChild(titleWrap);
            headerWrap.appendChild(createDialogCloseIconButton(closeDialog));
            panel.appendChild(headerWrap);

            const content = document.createElement("div");
            Object.assign(content.style, {
                display: "flex",
                flexDirection: "column",
                gap: "10px",
                background: "#111720",
                border: "1px solid #313848",
                borderRadius: "10px",
                padding: "12px",
            });

            const urlLabel = document.createElement("div");
            urlLabel.textContent = "Hugging Face URL";
            Object.assign(urlLabel.style, {
                fontSize: "12px",
                color: "#99a5ba",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: "600",
            });
            const urlInput = createInput("", "HuggingFace URL...");
            Object.assign(urlInput.style, {
                fontSize: "15px",
                minHeight: "38px",
            });

            const folderLabel = document.createElement("div");
            folderLabel.textContent = "Folder";
            Object.assign(folderLabel.style, {
                fontSize: "12px",
                color: "#99a5ba",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: "600",
            });
            const folderPicker = createFolderPicker("loras", "Folder");
            Object.assign(folderPicker.input.style, {
                fontSize: "15px",
                minHeight: "38px",
            });

            content.appendChild(urlLabel);
            content.appendChild(urlInput);
            content.appendChild(folderLabel);
            content.appendChild(folderPicker.wrapper);
            panel.appendChild(content);

            const footer = document.createElement("div");
            Object.assign(footer.style, {
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px",
            });

            const statusLine = document.createElement("div");
            Object.assign(statusLine.style, {
                fontSize: "13px",
                color: "#9ba8be",
                minHeight: "17px",
            });
            panel.appendChild(statusLine);

            const setStatus = (msg, color = "#9aa4b6") => {
                statusLine.textContent = msg || "";
                statusLine.style.color = color;
            };

            const downloadBtn = createButton("Download", "p-button p-component p-button-success", async () => {
                const url = urlInput.value.trim();
                const folder = folderPicker.input.value.trim() || "loras";
                const filename = parseFilenameFromUrl(url);

                if (!url) {
                    showToast({ severity: "warn", summary: "Missing URL", detail: "Enter a Hugging Face file URL." });
                    return;
                }
                if (!filename) {
                    showToast({ severity: "error", summary: "Invalid URL", detail: "Could not extract filename from URL." });
                    return;
                }

                downloadBtn.disabled = true;
                downloadBtn.textContent = "Queued";
                setStatus("Queuing download...", "#9ad6ff");

                try {
                    const resp = await fetch("/queue_download", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            models: [
                                {
                                    filename,
                                    url,
                                    folder
                                }
                            ]
                        })
                    });
                    if (resp.status !== 200) {
                        throw new Error("Server returned " + resp.status + " " + resp.statusText);
                    }
                    const res = await resp.json();
                    const queued = res.queued || [];
                    const downloadIds = queued.map(q => q.download_id);
                    if (!downloadIds.length) {
                        showToast({ severity: "warn", summary: "Queue empty", detail: "No download was queued." });
                        downloadBtn.disabled = false;
                        downloadBtn.textContent = "Download";
                        setStatus("No download queued.", "#f5b14c");
                        return;
                    }

                    setStatus(`Queued ${downloadIds.length} download(s). Track progress in the Downloads panel.`, "#9ad6ff");
                    const statusMap = {};
                    const pending = new Set(downloadIds);

                    const poll = async () => {
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
                            showToast({ severity: "error", summary: "Status error", detail: String(e) });
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
            Object.assign(downloadBtn.style, {
                minHeight: "36px",
                padding: "0.42rem 0.95rem",
                fontSize: "14px",
                fontWeight: "600",
                borderRadius: "8px",
            });

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

        const runAutoDownload = async (skippedFilenames = new Set(), skipAllUnresolved = false) => {
            let loadingDlg = null;
            let aborted = false;
            let skipRequested = false;
            let statusTimer = null;
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

                const workflow = app.graph.serialize();
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

                // Show results
                showResultsDialog(data);

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
                                runAutoDownload(skippedFilenames, true);
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

        registerGlobalAction("runAutoDownload", runAutoDownload);
        registerGlobalAction("showManualDownloadDialog", showManualDownloadDialog);
        setupMissingModelsDialogObserver();
    }
});
