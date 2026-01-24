import { app } from "../../../scripts/app.js";

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
            const clean = url.split("?")[0].split("#")[0];
            const parts = clean.split("/").filter(Boolean);
            return parts.length ? parts[parts.length - 1] : null;
        };

        /* Show loading dialog immediately */
        const showLoadingDialog = () => {
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
            panel.innerHTML = "<div>🔍 Looking for links...</div>";

            dlg.appendChild(panel);
            document.body.appendChild(dlg);
            return dlg;
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
                    left.innerHTML = `<div style="color:#aaa; font-size:11px">Current: ${m.filename}</div><div style="color:#4caf50; font-weight:bold; font-size:12px">Found: ${m.clean_path}</div>`;

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
                            const widget = node.widgets.find(w => w.value === m.filename);
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
                        urlInput: urlInput,
                        folderInput: folderPicker.input,
                        nameEl: nameEl,
                        metaEl: metaEl,
                        nodeTitle: m.node_title || "Unknown Node"
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

            /* Logs Panel (Initially Hidden) */
            const logPanel = document.createElement("div");
            Object.assign(logPanel.style, {
                height: "150px",
                background: "#000",
                borderRadius: "6px",
                padding: "10px",
                fontSize: "12px",
                fontFamily: "monospace",
                overflowY: "auto",
                display: "none",
                color: "#0f0"
            });
            panel.appendChild(logPanel);

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
                const toDownload = rowInputs.filter(r => r.checkbox.checked).map(r => ({
                    filename: r.filename,
                    url: r.urlInput.value.trim(),
                    folder: r.folderInput.value.trim()
                }));

                if (toDownload.length === 0) {
                    alert("No models selected.");
                    return;
                }

                // Switch UI to downloading state
                downloadBtn.disabled = true;
                downloadBtn.textContent = "Queued";
                content.style.display = "none";
                logPanel.style.display = "block";

                const addLog = (msg) => {
                    const line = document.createElement("div");
                    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
                    logPanel.appendChild(line);
                    logPanel.scrollTop = logPanel.scrollHeight;
                };

                const queueable = [];
                for (const item of toDownload) {
                    if (!item.url) {
                        addLog(`[SKIP] No URL for ${item.filename}`);
                        continue;
                    }
                    queueable.push(item);
                }
                if (queueable.length === 0) {
                    addLog("No valid URLs to queue.");
                    downloadBtn.disabled = false;
                    downloadBtn.textContent = "Download Selected";
                    return;
                }

                addLog(`Queuing ${queueable.length} models for background download...`);

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

                    addLog(`Queued ${queued.length} downloads. You can close this window while they run.`);

                    const statusMap = {};
                    const pending = new Set(downloadIds);
                    const failed = new Set();
                    let lastProgressId = null;

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
                                    if (info.status === "completed") {
                                        addLog(`[OK] ${name} completed`);
                                    } else if (info.status === "failed") {
                                        addLog(`[ERR] ${name} failed: ${info.error || "unknown error"}`);
                                    } else if (info.status === "downloading") {
                                        addLog(`>> Downloading ${name}...`);
                                    } else if (info.status === "queued") {
                                        addLog(`Queued ${name}`);
                                    }
                                }
                                if (info.status === "completed" || info.status === "failed") {
                                    pending.delete(id);
                                    if (info.status === "failed") {
                                        failed.add(id);
                                    }
                                }
                            }

                            let activeId = null;
                            for (const id of downloadIds) {
                                if (downloads[id]?.status === "downloading") {
                                    activeId = id;
                                    break;
                                }
                            }
                            if (activeId && activeId !== lastProgressId) {
                                const name = downloads[activeId]?.filename || activeId;
                                showProgressToast(name);
                                lastProgressId = activeId;
                            } else if (!activeId && lastProgressId) {
                                clearProgressToast();
                                lastProgressId = null;
                            }

                            if (pending.size === 0) {
                                stopPolling();
                                addLog("All tasks finished.");
                                showFinalToast(failed.size, downloadIds.length);

                                downloadBtn.style.display = "none";
                                closeBtn.textContent = "Finish";
                                closeBtn.className = "p-button p-component p-button-success";
                                closeBtn.style.display = "inline-block";

                                const refreshHint = document.createElement("div");
                                refreshHint.style.color = "yellow";
                                refreshHint.style.marginTop = "10px";
                                refreshHint.textContent = "Please refresh ComfyUI (Press 'R' or F5) to load new models.";
                                logPanel.appendChild(refreshHint);
                            }
                        } catch (e) {
                            addLog(`[ERR] Status polling error: ${e}`);
                        }
                    };

                    pollTimer = setInterval(poll, 1000);
                    poll();
                } catch (e) {
                    addLog(`[ERR] Queue error: ${e}`);
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
                    const failed = new Set();
                    let lastProgressId = null;

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
                                    if (info.status === "failed") {
                                        failed.add(id);
                                    }
                                }
                                if (info.status === "completed" || info.status === "failed") {
                                    pending.delete(id);
                                }
                            }

                            let activeId = null;
                            for (const id of downloadIds) {
                                if (downloads[id]?.status === "downloading") {
                                    activeId = id;
                                    break;
                                }
                            }
                            if (activeId && activeId !== lastProgressId) {
                                const name = downloads[activeId]?.filename || activeId;
                                showProgressToast(name);
                                lastProgressId = activeId;
                            } else if (!activeId && lastProgressId) {
                                clearProgressToast();
                                lastProgressId = null;
                            }

                            if (pending.size === 0) {
                                stopPolling();
                                showFinalToast(failed.size, downloadIds.length);
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
        };

        const runAutoDownload = async () => {
            let loadingDlg = null;
            try {
                // Show loading dialog immediately
                loadingDlg = showLoadingDialog();

                const workflow = app.graph.serialize();
                console.log("[AutoDownload] Scanning workflow:", workflow);

                // Call backend
                const resp = await fetch("/check_missing_models", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(workflow)
                });

                // Remove loading dialog
                if (loadingDlg) loadingDlg.remove();

                if (resp.status !== 200) {
                    throw new Error("Failed to scan models: " + resp.statusText + " (" + resp.status + ")");
                }
                const data = await resp.json();
                console.log("[AutoDownload] Scan results:", data);

                // Show results
                showResultsDialog(data);

            } catch (e) {
                // Remove loading dialog on error
                if (loadingDlg) loadingDlg.remove();
                console.error("[AutoDownload] Error:", e);
                alert("Error: " + e);
            }
        };

        registerGlobalAction("runAutoDownload", runAutoDownload);
        registerGlobalAction("showManualDownloadDialog", showManualDownloadDialog);
    }
});
