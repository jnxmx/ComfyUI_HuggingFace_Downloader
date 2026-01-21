


console.log("Mock register"); ({ setup: () => {} });({
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
                background: "#2a2d35",
                border: "1px solid #3c3c3c",
                color: "#fff",
                padding: "4px 8px",
                borderRadius: "4px",
                width: "100%",
                boxSizing: "border-box"
            });
            return inp;
        };

        /* ──────────────── UI Components ──────────────── */
        const showResultsDialog = (data) => {
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

            // 1. Found Models (Local)
            if (data.found && data.found.length > 0) {
                const foundSection = document.createElement("details");
                foundSection.style.marginBottom = "10px";

                const summary = document.createElement("summary");
                summary.style.cursor = "pointer";
                summary.style.color = "#4caf50";

                const summaryText = document.createElement("span");
                summaryText.textContent = `Found Local Models (${data.found.length})`;
                summary.appendChild(summaryText);

                const fixBtn = createButton("Fix Paths", "", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    let fixed = 0;
                    data.found.forEach(m => {
                        const node = app.graph.getNodeById(m.node_id);
                        if (node && node.widgets) {
                            node.widgets.forEach(w => {
                                if (w.value === m.filename) {
                                    w.value = m.path;
                                    fixed++;
                                }
                            });
                        }
                    });
                    alert(`Updated paths for ${fixed} widgets.`);
                });
                Object.assign(fixBtn.style, {
                    marginLeft: "10px",
                    padding: "2px 8px",
                    fontSize: "10px",
                    background: "#2a2d35",
                    border: "1px solid #444",
                    color: "#eee",
                    cursor: "pointer",
                    borderRadius: "4px"
                });
                /* Fetch folder structure for autocomplete */
                let availableFolders = ["checkpoints", "loras", "vae", "controlnet", "upscale_models", "text_encoders", "clip_vision"];

                // Use non-blocking fetch
                fetch("/folder_structure")
                    .then(r => r.json())
                    .then(fData => {
                        if (Array.isArray(fData)) {
                            // Update datalist if already created, or just update the variable if not
                            const dl = document.getElementById(datalistId);
                            if (dl) {
                                dl.innerHTML = "";
                                fData.forEach(f => {
                                    const opt = document.createElement("option");
                                    opt.value = f;
                                    dl.appendChild(opt);
                                });
                            }
                        }
                    })
                    .catch(e => console.warn("[AutoDownload] Failed to fetch folder structure:", e));

                /* Create Datalist for folders */
                const datalistId = "folder-options-" + Date.now();
                const datalist = document.createElement("datalist");
                datalist.id = datalistId;
                availableFolders.forEach(f => {
                    const opt = document.createElement("option");
                    opt.value = f;
                    datalist.appendChild(opt);
                });
                // Append datalist to content so it gets cleaned up with dialog? 
                // Datalist needs to be in document to work. Panel is in document.
                content.appendChild(datalist);

                /* Helper to create styled inputs */
                function createInput(value, placeholder, listId = null) {
                    const input = document.createElement("input");
                    input.type = "text";
                    input.value = value || "";
                    input.placeholder = placeholder || "";
                    if (listId) input.setAttribute("list", listId);

                    Object.assign(input.style, {
                        width: "100%",
                        background: "#333",
                        color: "#fff",
                        border: "1px solid #555",
                        padding: "4px",
                        borderRadius: "4px"
                    });


                    // Highlight if empty URL
                    if (!value && placeholder.includes("URL")) {
                        input.style.borderColor = "#ff4444";
                        input.style.background = "#3a2a2a";

                        input.addEventListener("input", () => {
                            if (input.value.trim()) {
                                input.style.borderColor = "#555";
                                input.style.background = "#333";
                            } else {
                                input.style.borderColor = "#ff4444";
                                input.style.background = "#3a2a2a";
                            }
                        });
                    }
                    return input;
                }

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
                        infoDiv.innerHTML = `<div style="font-weight:bold; word-break:break-all">${m.filename}</div><div style="font-size:10px;color:#888">${m.node_title || "Unknown Node"}</div>`;

                        // URL Input
                        const urlInput = createInput(m.url, "HuggingFace URL...");

                        // Folder (can be editable)
                        const folderInput = createInput(m.suggested_folder || "checkpoints", "Folder", datalistId);

                        row.appendChild(cb);
                        row.appendChild(infoDiv);
                        row.appendChild(urlInput);
                        row.appendChild(folderInput);

                        rowsContainer.appendChild(row);

                        rowInputs.push({
                            checkbox: cb,
                            filename: m.filename,
                            urlInput: urlInput,
                            folderInput: folderInput
                        });
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

                const closeBtn = createButton("Close", "p-button p-component p-button-secondary", () => dlg.remove());

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
                    downloadBtn.textContent = "Downloading...";
                    content.style.display = "none"; // Hide list to show logs better? Or just keep it.
                    logPanel.style.display = "block";

                    const addLog = (msg) => {
                        const line = document.createElement("div");
                        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
                        logPanel.appendChild(line);
                        logPanel.scrollTop = logPanel.scrollHeight;
                    };

                    addLog(`Starting download of ${toDownload.length} models...`);

                    // Process sequentially
                    for (const item of toDownload) {
                        if (!item.url) {
                            addLog(`[SKIP] No URL for ${item.filename}`);
                            continue;
                        }

                        addLog(`>> Downloading ${item.filename} from ${item.url}...`);

                        try {
                            const resp = await fetch("/install_models", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ models: [item] })
                            });
                            console.log("[AutoDownload] Install response status:", resp.status);

                            if (resp.status !== 200) {
                                throw new Error("Server returned " + resp.status + " " + resp.statusText);
                            }

                            const res = await resp.json();
                            console.log("[AutoDownload] Install result:", res);

                            if (res.results && res.results.length > 0) {
                                const r = res.results[0];
                                if (r.status === "success") {
                                    addLog(`[OK] ${r.message || "Downloaded successfully"}`);
                                } else {
                                    addLog(`[ERR] ${r.error}`);
                                }
                            } else {
                                addLog(`[ERR] Unknown response for ${item.filename}`);
                            }

                        } catch (e) {
                            addLog(`[ERR] Network/Server Error: ${e}`);
                        }
                    }

                    addLog("All tasks finished.");
                    downloadBtn.textContent = "Finished";

                    // Suggest refresh (Press R?)
                    const refreshHint = document.createElement("div");
                    refreshHint.style.color = "yellow";
                    refreshHint.style.marginTop = "10px";
                    refreshHint.textContent = "Please refresh ComfyUI (Press 'R' or F5) to load new models.";
                    logPanel.appendChild(refreshHint);
                });

                // If no models to download, disable download button
                if (missingModels.length === 0) downloadBtn.disabled = true;

                footer.appendChild(closeBtn);
                footer.appendChild(downloadBtn);
                panel.appendChild(footer);

                dlg.appendChild(panel);
                document.body.appendChild(dlg);
            };

            /* ──────────────── Menu Integration ──────────────── */
            const origMenu = LGraphCanvas.prototype.getCanvasMenuOptions;
            LGraphCanvas.prototype.getCanvasMenuOptions = function () {
                const menu = origMenu.apply(this, arguments);
                menu.push(null, {
                    content: "Auto-download models",
                    callback: async () => {
                        try {
                            const workflow = app.graph.serialize();
                            console.log("[AutoDownload] Scanning workflow:", workflow);

                            // Call backend
                            const resp = await fetch("/check_missing_models", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify(workflow)
                            });

                            if (resp.status !== 200) {
                                throw new Error("Failed to scan models: " + resp.statusText + " (" + resp.status + ")");
                            }
                            const data = await resp.json();
                            console.log("[AutoDownload] Scan results:", data);

                            showResultsDialog(data);

                        } catch (e) {
                            console.error("[AutoDownload] Error:", e);
                            alert("Error: " + e);
                        }
                    }
                });
                return menu;
            };
        }
    });
