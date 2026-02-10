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
                background: "#333",
                border: "1px solid #555",
                color: "#fff",
                padding: "4px",
                borderRadius: "4px",
                width: "100%",
                boxSizing: "border-box"
            });

            if (!value && placeholder && placeholder.includes("URL")) {
                inp.style.borderColor = "#ff4444";
                inp.style.background = "#3a2a2a";

                inp.addEventListener("input", () => {
                    if (inp.value.trim()) {
                        inp.style.borderColor = "#555";
                        inp.style.background = "#333";
                    } else {
                        inp.style.borderColor = "#ff4444";
                        inp.style.background = "#3a2a2a";
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
                background: "#1f2128",
                border: "1px solid #444",
                borderTop: "none",
                maxHeight: "180px",
                overflowY: "auto",
                zIndex: 10,
                display: "none"
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
                        padding: "6px 8px",
                        cursor: "pointer",
                        color: "#ddd"
                    });
                    item.addEventListener("mouseenter", () => {
                        item.style.background = "#2b2f3a";
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
        const showLoadingDialog = (onCancel, onSkip) => {
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
                background: "rgba(0,0,0,0.6)",
                zIndex: 9000
            });

            const panel = document.createElement("div");
            Object.assign(panel.style, {
                background: "#17191f",
                color: "#fff",
                padding: "40px",
                borderRadius: "12px",
                textAlign: "center",
                fontSize: "18px",
                border: "1px solid #3c3c3c"
            });

            const statusEl = document.createElement("div");
            statusEl.textContent = "🔍 Looking for links...";

            const detailEl = document.createElement("div");
            detailEl.style.fontSize = "12px";
            detailEl.style.color = "#aaa";
            detailEl.style.marginTop = "8px";
            detailEl.textContent = "Waiting for status...";

            const cancelBtn = document.createElement("button");
            cancelBtn.textContent = "Cancel";
            Object.assign(cancelBtn.style, {
                marginTop: "16px",
                padding: "6px 14px",
                background: "#2b2f3a",
                color: "#ddd",
                border: "1px solid #444",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "12px"
            });

            const skipBtn = document.createElement("button");
            skipBtn.textContent = "Skip Current";
            Object.assign(skipBtn.style, {
                marginTop: "16px",
                marginLeft: "10px",
                padding: "6px 14px",
                background: "#2b2f3a",
                color: "#ddd",
                border: "1px solid #444",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "12px",
                opacity: "0.6"
            });
            skipBtn.disabled = true;

            let cancelled = false;
            cancelBtn.onclick = () => {
                if (!cancelled) {
                    cancelled = true;
                    statusEl.textContent = "Cancelled.";
                    cancelBtn.textContent = "Close";
                    clearInterval(timer);
                    if (onCancel) onCancel();
                } else {
                    if (dlg.parentElement) dlg.remove();
                }
            };

            skipBtn.onclick = () => {
                if (skipBtn.disabled) return;
                if (onSkip) onSkip();
            };

            panel.appendChild(statusEl);
            panel.appendChild(detailEl);
            panel.appendChild(cancelBtn);
            panel.appendChild(skipBtn);

            dlg.appendChild(panel);
            document.body.appendChild(dlg);
            return {
                dlg,
                setStatus: (text) => { statusEl.textContent = text; },
                setDetail: (text) => { detailEl.textContent = text; },
                setSkippable: (canSkip) => {
                    skipBtn.disabled = !canSkip;
                    skipBtn.style.opacity = canSkip ? "1" : "0.6";
                },
                cleanup: () => {},
                remove: () => { if (dlg.parentElement) dlg.remove(); }
            };
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

            // Remove existing dialog if any
            const existing = document.getElementById("auto-download-dialog");
            if (existing) existing.remove();

            // Overlay
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
                background: "rgba(0,0,0,0.6)",
                zIndex: 9000
            });

            // Panel
            const panel = document.createElement("div");
            Object.assign(panel.style, {
                background: "#17191f",
                color: "#fff",
                padding: "20px",
                borderRadius: "12px",
                width: "800px",
                maxWidth: "90vw",
                maxHeight: "85vh",
                display: "flex",
                flexDirection: "column",
                gap: "16px",
                boxShadow: "0 0 20px rgba(0,0,0,0.8)",
                border: "1px solid #3c3c3c"
            });

            /* Header */
            const header = document.createElement("div");
            header.innerHTML = `<h3>Auto-Download Models</h3><p style="font-size:12px;color:#aaa">Detected missing models and valid URLs.</p>`;
            panel.appendChild(header);

            /* Content Area (Scrollable) */
            const content = document.createElement("div");
            Object.assign(content.style, {
                flex: "1",
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
                paddingRight: "5px"
            });
            loadFolderList();

            /* Content Area */
            Object.assign(content.style, {
                marginTop: "15px",
                maxHeight: "400px",
                overflowY: "auto"
            });

            // 2. Found Models sections
            // A. Exact Matches (Information Only)
            if (data.found && data.found.length > 0) {
                const foundSection = document.createElement("div");
                foundSection.innerHTML = "<h4 style='margin:10px 0 5px'>Found Local Models</h4>";
                const ul = document.createElement("ul");
                ul.style.fontSize = "12px";
                ul.style.color = "#ccc";
                data.found.forEach(m => {
                    const li = document.createElement("li");
                    li.textContent = `${m.filename} -> ${m.found_path} (Exact Match)`;
                    ul.appendChild(li);
                });
                foundSection.appendChild(ul);
                content.appendChild(foundSection);
            }

            // B. Mismatches (Actionable)
            if (data.mismatches && data.mismatches.length > 0) {
                const mismatchSection = document.createElement("div");
                mismatchSection.innerHTML = "<h4 style='margin:10px 0 5px; color: #ff9800'>Path Mismatches (Action Required)</h4>";

                const ul = document.createElement("ul");
                ul.style.listStyle = "none";
                ul.style.padding = "0";

                data.mismatches.forEach(m => {
                    const li = document.createElement("li");
                    li.style.background = "#2a2d35";
                    li.style.marginBottom = "5px";
                    li.style.padding = "8px";
                    li.style.borderRadius = "4px";
                    li.style.display = "flex";
                    li.style.justifyContent = "space-between";
                    li.style.alignItems = "center";

                    const left = document.createElement("div");
                    const currentLabel = m.requested_path || m.filename;
                    left.innerHTML = `<div style="color:#aaa; font-size:11px">Current: ${currentLabel}</div><div style="color:#4caf50; font-weight:bold; font-size:12px">Found: ${m.clean_path}</div>`;

                    const fixBtn = document.createElement("button");
                    fixBtn.textContent = "Fix Path";
                    fixBtn.style.padding = "4px 8px";
                    fixBtn.style.background = "#2196F3";
                    fixBtn.style.color = "white";
                    fixBtn.style.border = "none";
                    fixBtn.style.borderRadius = "4px";
                    fixBtn.style.cursor = "pointer";

                    fixBtn.onclick = () => {
                        const node = app.graph.getNodeById(m.node_id);
                        if (node) {
                            // Find widget with the old value
                            const targetValue = m.requested_path || m.filename;
                            const widget = node.widgets.find(w => w.value === targetValue || w.value === m.filename);
                            if (widget) {
                                widget.value = m.clean_path;
                                node.setDirtyCanvas(true);
                                fixBtn.textContent = "Fixed!";
                                fixBtn.style.background = "#4caf50";
                                fixBtn.disabled = true;
                            } else {
                                alert("Could not find matching widget value on node.");
                            }
                        } else {
                            alert("Node not found.");
                        }
                    };

                    li.appendChild(left);
                    li.appendChild(fixBtn);
                    ul.appendChild(li);
                });

                mismatchSection.appendChild(ul);
                content.appendChild(mismatchSection);
            }

            // 3. Missing Models Table
            const missingModels = data.missing || [];
            missingModels.sort((a, b) => {
                const aMissing = a.url ? 0 : 1;
                const bMissing = b.url ? 0 : 1;
                if (aMissing !== bMissing) return bMissing - aMissing;
                return (a.filename || "").localeCompare(b.filename || "");
            });
            // Container for rows
            const rowsContainer = document.createElement("div");
            Object.assign(rowsContainer.style, {
                display: "flex",
                flexDirection: "column",
                gap: "8px"
            });

            const rowInputs = []; // To store references to data for downloading

            if (missingModels.length === 0) {
                const noMissing = document.createElement("div");
                noMissing.textContent = "No missing models detected!";
                noMissing.style.padding = "20px";
                noMissing.style.textAlign = "center";
                noMissing.style.color = "#4caf50";
                content.appendChild(noMissing);
            } else {
                missingModels.forEach((m, idx) => {
                    const rowWrapper = document.createElement("div");
                    Object.assign(rowWrapper.style, {
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px"
                    });

                    const row = document.createElement("div");
                    Object.assign(row.style, {
                        display: "grid",
                        gridTemplateColumns: "30px 1fr 2fr 1fr",
                        gap: "10px",
                        alignItems: "center",
                        background: "#1f2128",
                        padding: "10px",
                        borderRadius: "6px"
                    });

                    // Checkbox
                    const cb = document.createElement("input");
                    cb.type = "checkbox";
                    cb.checked = true; // Default selected

                    // Should be unchecked if no URL?
                    if (!m.url) cb.checked = false;

                    // Info
                    const infoDiv = document.createElement("div");
                    const nameEl = document.createElement("div");
                    nameEl.style.fontWeight = "bold";
                    nameEl.style.fontSize = "12px";
                    nameEl.style.wordBreak = "break-all";
                    nameEl.textContent = m.filename;

                    const metaEl = document.createElement("div");
                    metaEl.style.fontSize = "10px";
                    metaEl.style.color = "#888";
                    metaEl.textContent = `${m.node_title || "Unknown Node"}${m.source ? " • " + m.source : ""}`;

                    infoDiv.appendChild(nameEl);
                    infoDiv.appendChild(metaEl);

                    // URL Input
                    const urlInput = createInput(m.url, "HuggingFace URL...");

                    // Folder (can be editable)
                    const folderPicker = createFolderPicker(m.suggested_folder || "checkpoints", "Folder");

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
                        nodeId: m.node_id
                    };
                    rowInputs.push(rowData);

                    if (Array.isArray(m.alternatives) && m.alternatives.length > 0) {
                        const altToggle = document.createElement("button");
                        altToggle.textContent = `Alternatives (${m.alternatives.length})`;
                        Object.assign(altToggle.style, {
                            marginTop: "6px",
                            fontSize: "11px",
                            padding: "4px 6px",
                            background: "#2b2f3a",
                            color: "#ddd",
                            border: "1px solid #444",
                            borderRadius: "4px",
                            cursor: "pointer"
                        });
                        infoDiv.appendChild(altToggle);

                        const altList = document.createElement("div");
                        Object.assign(altList.style, {
                            display: "none",
                            background: "#17191f",
                            border: "1px solid #333",
                            padding: "8px",
                            borderRadius: "6px"
                        });

                        m.alternatives.forEach((alt) => {
                            const altRow = document.createElement("div");
                            Object.assign(altRow.style, {
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: "10px",
                                padding: "4px 0",
                                borderBottom: "1px solid #222"
                            });

                            const altLabel = document.createElement("div");
                            altLabel.style.fontSize = "11px";
                            altLabel.style.color = "#bbb";
                            altLabel.textContent = `${alt.filename}${alt.source ? " • " + alt.source : ""}`;

                            const useBtn = document.createElement("button");
                            useBtn.textContent = "Use";
                            Object.assign(useBtn.style, {
                                padding: "4px 8px",
                                background: "#3a3f4b",
                                color: "#fff",
                                border: "none",
                                borderRadius: "4px",
                                cursor: "pointer",
                                fontSize: "11px"
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

                        rowWrapper.appendChild(altList);
                    }

                    rowsContainer.appendChild(rowWrapper);
                });
                content.appendChild(rowsContainer);
            }

            panel.appendChild(content);

            const statusLine = document.createElement("div");
            Object.assign(statusLine.style, {
                fontSize: "12px",
                color: "#aaa",
                minHeight: "16px"
            });
            panel.appendChild(statusLine);

            const refreshHint = document.createElement("div");
            Object.assign(refreshHint.style, {
                color: "yellow",
                marginTop: "6px",
                display: "none"
            });
            panel.appendChild(refreshHint);

            /* Buttons */
            const footer = document.createElement("div");
            Object.assign(footer.style, {
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px",
                marginTop: "10px"
            });

            const closeBtn = createButton("Close", "p-button p-component p-button-secondary", () => {
                stopPolling();
                dlg.remove();
            });

            const downloadBtn = createButton("Download Selected", "p-button p-component p-button-success", async () => {
                const selectedRows = rowInputs.filter((r) => r.checkbox.checked);
                const toDownload = selectedRows.map((r) => ({
                    filename: r.filename,
                    url: r.urlInput.value.trim(),
                    folder: r.folderInput.value.trim()
                }));

                if (toDownload.length === 0) {
                    alert("No models selected.");
                    return;
                }

                const setStatus = (msg, color = "#aaa") => {
                    statusLine.textContent = msg || "";
                    statusLine.style.color = color;
                };

                refreshHint.style.display = "none";
                setStatus("Queuing downloads...");

                // Switch UI to downloading state
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
                if (queueable.length === 0) {
                    setStatus("No valid URLs to queue.", "#f5b14c");
                    downloadBtn.disabled = false;
                    downloadBtn.textContent = "Download Selected";
                    return;
                }
                setStatus(`Queued ${queueable.length} model(s). Track progress in the Downloads panel.`, "#9ad6ff");

                try {
                    const resp = await fetch("/queue_download", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ models: queueable })
                    });
                    if (resp.status !== 200) {
                        throw new Error("Server returned " + resp.status + " " + resp.statusText);
                    }
                    const res = await resp.json();
                    const queued = res.queued || [];
                    const downloadIds = queued.map(q => q.download_id);
                    const queueRowsById = new Map();
                    for (let i = 0; i < queued.length; i += 1) {
                        const q = queued[i];
                        const row = queueRows[i];
                        if (q?.download_id && row) {
                            queueRowsById.set(q.download_id, row);
                        }
                    }

                    setStatus(`Queued ${queued.length} download(s). Track progress in the Downloads panel.`, "#9ad6ff");
                    if (dlg.parentElement) {
                        dlg.remove();
                    }

                    const statusMap = {};
                    const pending = new Set(downloadIds);

                    const poll = async () => {
                        if (downloadIds.length === 0) return;
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
                                    const name = info.filename || id;
                                    if (info.status === "failed") {
                                        setStatus(`Failed: ${name}`, "#ff6b6b");
                                    }
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

                                let statusMessage;
                                let statusColor;
                                if (failures) {
                                    statusMessage = `Finished with ${failures} error(s). See Downloads panel for details.`;
                                    statusColor = "#ff6b6b";
                                } else {
                                    statusMessage = "All downloads finished.";
                                    statusColor = "#5bd98c";
                                }
                                if (updatedRefs > 0) {
                                    statusMessage += ` Updated ${updatedRefs} workflow reference${updatedRefs === 1 ? "" : "s"} to downloaded filename${updatedRefs === 1 ? "" : "s"}.`;
                                    showToast({
                                        severity: "success",
                                        summary: "Workflow updated",
                                        detail: `Updated ${updatedRefs} model reference${updatedRefs === 1 ? "" : "s"} automatically.`
                                    });
                                }
                                setStatus(statusMessage, statusColor);
                                downloadBtn.style.display = "none";
                                closeBtn.textContent = "Finish";
                                closeBtn.className = "p-button p-component p-button-success";
                                closeBtn.style.display = "inline-block";

                                refreshHint.textContent = "Please refresh ComfyUI (Press 'R' or F5) to load new models.";
                                refreshHint.style.display = "block";
                            }
                        } catch (e) {
                            setStatus(`Status polling error: ${e}`, "#ff6b6b");
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

            // If no models to download, disable download button
            if (missingModels.length === 0) downloadBtn.disabled = true;

            footer.appendChild(closeBtn);
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
                background: "rgba(0,0,0,0.6)",
                zIndex: 9000
            });

            const panel = document.createElement("div");
            Object.assign(panel.style, {
                background: "#17191f",
                color: "#fff",
                padding: "20px",
                borderRadius: "12px",
                width: "520px",
                maxWidth: "90vw",
                display: "flex",
                flexDirection: "column",
                gap: "16px",
                boxShadow: "0 0 20px rgba(0,0,0,0.8)",
                border: "1px solid #3c3c3c"
            });

            const header = document.createElement("div");
            header.innerHTML = `<h3>Download New Model</h3><p style="font-size:12px;color:#aaa">Paste a direct Hugging Face file URL and choose a folder.</p>`;
            panel.appendChild(header);

            const content = document.createElement("div");
            Object.assign(content.style, {
                display: "flex",
                flexDirection: "column",
                gap: "10px"
            });

            const urlLabel = document.createElement("div");
            urlLabel.textContent = "HuggingFace URL";
            urlLabel.style.fontSize = "12px";
            urlLabel.style.color = "#aaa";
            const urlInput = createInput("", "HuggingFace URL...");

            const folderLabel = document.createElement("div");
            folderLabel.textContent = "Folder";
            folderLabel.style.fontSize = "12px";
            folderLabel.style.color = "#aaa";
            const folderPicker = createFolderPicker("loras", "Folder");

            content.appendChild(urlLabel);
            content.appendChild(urlInput);
            content.appendChild(folderLabel);
            content.appendChild(folderPicker.wrapper);
            panel.appendChild(content);

            const footer = document.createElement("div");
            Object.assign(footer.style, {
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px"
            });

            const closeBtn = createButton("Close", "p-button p-component p-button-secondary", () => {
                stopPolling();
                dlg.remove();
            });

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
                        return;
                    }

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
                                    const name = info.filename || id;
                                }
                                if (info.status === "downloaded" || info.status === "completed" || info.status === "failed" || info.status === "cancelled") {
                                    pending.delete(id);
                                }
                            }

                            if (pending.size === 0) {
                                stopPolling();
                                downloadBtn.disabled = false;
                                downloadBtn.textContent = "Download";
                            }
                        } catch (e) {
                            showToast({ severity: "error", summary: "Status error", detail: String(e) });
                        }
                    };

                    pollTimer = setInterval(poll, 1000);
                    poll();
                } catch (e) {
                    showToast({ severity: "error", summary: "Queue error", detail: String(e) });
                    downloadBtn.disabled = false;
                    downloadBtn.textContent = "Download";
                }
            });

            footer.appendChild(closeBtn);
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

        const runAutoDownload = async (skippedFilenames = new Set()) => {
            let loadingDlg = null;
            let aborted = false;
            let skipRequested = false;
            let currentFilename = "";
            let statusTimer = null;
            try {
                // Show loading dialog immediately
                const controller = new AbortController();
                loadingDlg = showLoadingDialog(() => {
                    aborted = true;
                    if (statusTimer) {
                        clearInterval(statusTimer);
                        statusTimer = null;
                    }
                    controller.abort();
                }, () => {
                    if (!currentFilename) return;
                    skippedFilenames.add(currentFilename.toLowerCase());
                    skipRequested = true;
                    aborted = true;
                    if (statusTimer) {
                        clearInterval(statusTimer);
                        statusTimer = null;
                    }
                    controller.abort();
                });

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
                        const statusResp = await doFetch(`/search_status?request_id=${encodeURIComponent(requestId)}`);
                        if (statusResp.status !== 200) return;
                        const statusData = await statusResp.json();
                        const status = statusData.status || {};
                        const detailRaw = status.detail || "";
                        let message = status.message || "🔍 Looking for links...";
                        const type = status.source || "search";
                        const filename = status.filename || "";
                        currentFilename = filename || "";
                        if (detailRaw && type.startsWith("huggingface_") && !/searching/i.test(message)) {
                            message = `Searching ${detailRaw}`;
                        }
                        const detail = filename ? `${type}:${filename}` : type;
                        loadingDlg.setStatus(message);
                        loadingDlg.setDetail(detail);
                        loadingDlg.setSkippable(Boolean(currentFilename));
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
                    body: JSON.stringify({ ...workflow, request_id: requestId, skip_filenames: Array.from(skippedFilenames) }),
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
                        if (skipRequested) {
                            skipRequested = false;
                            aborted = false;
                            currentFilename = "";
                            // Restart scan with updated skip list
                            setTimeout(() => {
                                runAutoDownload(skippedFilenames);
                            }, 0);
                            return;
                        }
                        loadingDlg.setStatus("Cancelled.");
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
