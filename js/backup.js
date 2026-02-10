import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "backupToHuggingFace",
    setup() {
        const registerGlobalAction = (name, action) => {
            if (typeof window === "undefined") return;
            if (!window.hfDownloader) {
                window.hfDownloader = {};
            }
            window.hfDownloader[name] = action;
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
                console.log(`[HF Backup] ${summary}${payload.detail || "Notification"}`);
            }
        };

        const requestJson = async (url, init = {}) => {
            const options = { ...init };
            if (options.body && !options.headers) {
                options.headers = { "Content-Type": "application/json" };
            }

            const resp = await fetch(url, options);
            let data = {};
            try {
                data = await resp.json();
            } catch (e) {
                data = {};
            }

            if (!resp.ok || data.status === "error") {
                const msg = data.message || data.error || `Request failed (${resp.status})`;
                throw new Error(msg);
            }

            return data;
        };

        const createButton = (label, tone = "default") => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.className = "p-button p-component";
            if (tone === "success") {
                button.classList.add("p-button-success");
            } else if (tone === "danger") {
                button.classList.add("p-button-danger");
            } else if (tone === "secondary") {
                button.classList.add("p-button-secondary");
            }
            return button;
        };

        const showRestartDialog = () => {
            const existing = document.getElementById("hf-restart-required-dialog");
            if (existing) existing.remove();

            const overlay = document.createElement("div");
            overlay.id = "hf-restart-required-dialog";
            Object.assign(overlay.style, {
                position: "fixed",
                inset: "0",
                background: "rgba(0,0,0,0.55)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: "10001",
            });

            const panel = document.createElement("div");
            Object.assign(panel.style, {
                background: "#17191f",
                border: "1px solid #3c3c3c",
                borderRadius: "10px",
                padding: "24px",
                minWidth: "360px",
                maxWidth: "520px",
                color: "#fff",
                display: "flex",
                flexDirection: "column",
                gap: "14px",
                boxShadow: "0 12px 28px rgba(0,0,0,0.6)",
            });

            const text = document.createElement("div");
            text.textContent = "Custom nodes were changed. Restart ComfyUI to apply custom node updates.";
            panel.appendChild(text);

            const row = document.createElement("div");
            Object.assign(row.style, {
                display: "flex",
                justifyContent: "flex-end",
                gap: "8px",
            });

            const restartNow = createButton("Restart Now", "success");
            restartNow.onclick = async () => {
                try {
                    await fetch("/restart", { method: "POST" });
                } catch (e) {
                    console.error("Restart request failed:", e);
                }
                setTimeout(() => window.location.reload(), 1000);
            };

            const restartLater = createButton("Restart Later", "secondary");
            restartLater.onclick = () => overlay.remove();

            row.appendChild(restartLater);
            row.appendChild(restartNow);
            panel.appendChild(row);
            overlay.appendChild(panel);
            document.body.appendChild(overlay);
        };

        const createSelectionState = () => ({
            selected: new Map(),
            checkboxes: new Map(),
        });

        const getSelectedItems = (state) => {
            const dedup = new Map();
            for (const action of state.selected.values()) {
                if (!action) continue;
                const key = JSON.stringify(action);
                dedup.set(key, action);
            }
            return Array.from(dedup.values());
        };

        const makeNodeRow = (node, state, onSelectionChange) => {
            const row = document.createElement("div");
            Object.assign(row.style, {
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "4px 6px",
                color: node.selectable ? "#ececec" : "#9aa0a6",
                minHeight: "24px",
            });

            if (node.selectable && node.action) {
                const cb = document.createElement("input");
                cb.type = "checkbox";
                cb.checked = Boolean(node.default_checked);
                cb.addEventListener("mousedown", (e) => e.stopPropagation());
                cb.addEventListener("click", (e) => e.stopPropagation());
                cb.addEventListener("change", () => {
                    if (cb.checked) {
                        state.selected.set(node.id, node.action);
                    } else {
                        state.selected.delete(node.id);
                    }
                    onSelectionChange();
                });
                state.checkboxes.set(node.id, cb);
                if (cb.checked) {
                    state.selected.set(node.id, node.action);
                }
                row.appendChild(cb);
            } else {
                const spacer = document.createElement("span");
                spacer.style.display = "inline-block";
                spacer.style.width = "16px";
                row.appendChild(spacer);
            }

            const label = document.createElement("span");
            label.textContent = node.label;
            label.style.fontSize = "13px";
            row.appendChild(label);

            return row;
        };

        const renderNodes = (nodes, mount, state, onSelectionChange, depth = 0) => {
            const list = document.createElement("div");
            Object.assign(list.style, {
                display: "flex",
                flexDirection: "column",
                gap: "2px",
                marginLeft: depth === 0 ? "0" : "14px",
            });

            (nodes || []).forEach((node) => {
                const hasChildren = Array.isArray(node.children) && node.children.length > 0;

                if (hasChildren) {
                    const details = document.createElement("details");
                    details.open = depth === 0;
                    details.style.borderRadius = "6px";

                    const summary = document.createElement("summary");
                    summary.style.cursor = "pointer";
                    summary.style.listStyle = "none";
                    summary.style.outline = "none";
                    summary.appendChild(makeNodeRow(node, state, onSelectionChange));

                    const childWrap = document.createElement("div");
                    renderNodes(node.children, childWrap, state, onSelectionChange, depth + 1);

                    details.appendChild(summary);
                    details.appendChild(childWrap);
                    list.appendChild(details);
                } else {
                    list.appendChild(makeNodeRow(node, state, onSelectionChange));
                }
            });

            mount.appendChild(list);
        };

        let currentDialog = null;

        const showBackupDialog = async () => {
            if (currentDialog) {
                currentDialog.remove();
                currentDialog = null;
            }

            const backupState = createSelectionState();
            const localState = createSelectionState();
            let busy = false;

            const overlay = document.createElement("div");
            currentDialog = overlay;
            overlay.id = "backup-hf-dialog";
            Object.assign(overlay.style, {
                position: "fixed",
                inset: "0",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(0,0,0,0.5)",
                zIndex: "9999",
                padding: "16px",
                boxSizing: "border-box",
            });
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) {
                    overlay.remove();
                    currentDialog = null;
                }
            });

            const panel = document.createElement("div");
            Object.assign(panel.style, {
                background: "#17191f",
                color: "#fff",
                border: "1px solid #3c3c3c",
                borderRadius: "12px",
                width: "min(1220px, 100%)",
                maxHeight: "92vh",
                padding: "20px",
                boxShadow: "0 0 24px rgba(0,0,0,0.7)",
                display: "flex",
                flexDirection: "column",
                gap: "14px",
                overflow: "hidden",
            });

            const header = document.createElement("div");
            header.textContent = "Backup Manager: compare Hugging Face backup (left) with local ComfyUI install (right).";
            header.style.fontSize = "14px";
            header.style.color = "#d5d5d5";
            panel.appendChild(header);

            const body = document.createElement("div");
            Object.assign(body.style, {
                display: "flex",
                gap: "14px",
                minHeight: "420px",
                flexWrap: "wrap",
                overflow: "auto",
            });

            const makePanel = (title, subtitle) => {
                const root = document.createElement("div");
                Object.assign(root.style, {
                    background: "#1f2128",
                    border: "1px solid #3c3c3c",
                    borderRadius: "8px",
                    padding: "10px",
                    flex: "1 1 520px",
                    minHeight: "420px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                });

                const titleEl = document.createElement("div");
                titleEl.textContent = title;
                titleEl.style.fontSize = "13px";
                titleEl.style.fontWeight = "600";
                root.appendChild(titleEl);

                const subEl = document.createElement("div");
                subEl.textContent = subtitle;
                subEl.style.fontSize = "11px";
                subEl.style.color = "#9aa0a6";
                root.appendChild(subEl);

                const errorEl = document.createElement("div");
                Object.assign(errorEl.style, {
                    color: "#ff8f8f",
                    fontSize: "11px",
                    display: "none",
                    whiteSpace: "pre-wrap",
                });
                root.appendChild(errorEl);

                const tree = document.createElement("div");
                Object.assign(tree.style, {
                    flex: "1",
                    minHeight: "260px",
                    overflowY: "auto",
                    border: "1px solid #2d3039",
                    borderRadius: "6px",
                    padding: "6px",
                    background: "#181b22",
                });
                tree.textContent = "Loading...";
                root.appendChild(tree);

                const actions = document.createElement("div");
                Object.assign(actions.style, {
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "8px",
                });
                root.appendChild(actions);

                return { root, tree, actions, errorEl };
            };

            const backupPanel = makePanel("Backup (Hugging Face)", "Download all is always available. Selection enables extra actions.");
            const localPanel = makePanel("Local Install (ComfyUI)", "Default selected: Settings, Custom Nodes, Workflows, Subgraphs, loras.");

            body.appendChild(backupPanel.root);
            body.appendChild(localPanel.root);
            panel.appendChild(body);

            const footer = document.createElement("div");
            Object.assign(footer.style, {
                display: "flex",
                justifyContent: "space-between",
                gap: "8px",
            });

            const closeButton = createButton("Close", "secondary");
            closeButton.onclick = () => {
                overlay.remove();
                currentDialog = null;
            };
            footer.appendChild(closeButton);

            const status = document.createElement("div");
            status.style.fontSize = "12px";
            status.style.color = "#9aa0a6";
            status.textContent = "";
            footer.appendChild(status);

            panel.appendChild(footer);
            overlay.appendChild(panel);
            document.body.appendChild(overlay);

            const backupDownloadAllBtn = createButton("Download all");
            const backupSelectedRow = document.createElement("div");
            Object.assign(backupSelectedRow.style, {
                display: "none",
                gap: "8px",
                flexWrap: "wrap",
            });
            const backupDownloadSelectedBtn = createButton("Download selected only", "success");
            const backupDeleteSelectedBtn = createButton("Delete selected from backup", "danger");
            const backupClearSelectionBtn = createButton("Clear selection", "secondary");
            backupSelectedRow.appendChild(backupDownloadSelectedBtn);
            backupSelectedRow.appendChild(backupDeleteSelectedBtn);
            backupSelectedRow.appendChild(backupClearSelectionBtn);

            backupPanel.actions.appendChild(backupDownloadAllBtn);
            backupPanel.actions.appendChild(backupSelectedRow);

            const localAddSelectedBtn = createButton("Add selected to backup");
            localPanel.actions.appendChild(localAddSelectedBtn);

            const setStatus = (text) => {
                status.textContent = text || "";
            };

            const updateActions = () => {
                const backupItems = getSelectedItems(backupState);
                const localItems = getSelectedItems(localState);

                backupSelectedRow.style.display = backupItems.length > 0 ? "flex" : "none";
                backupDownloadAllBtn.disabled = busy;
                backupDownloadSelectedBtn.disabled = busy || backupItems.length === 0;
                backupDeleteSelectedBtn.disabled = busy || backupItems.length === 0;
                backupClearSelectionBtn.disabled = busy || backupItems.length === 0;
                localAddSelectedBtn.disabled = busy || localItems.length === 0;
                closeButton.disabled = busy;
            };

            const clearBackupSelection = () => {
                for (const cb of backupState.checkboxes.values()) {
                    cb.checked = false;
                }
                backupState.selected.clear();
                updateActions();
            };

            const setBusy = (value, msg = "") => {
                busy = value;
                panel.style.opacity = busy ? "0.78" : "1";
                setStatus(msg);
                updateActions();
            };

            const loadTree = async () => {
                backupState.selected.clear();
                backupState.checkboxes.clear();
                localState.selected.clear();
                localState.checkboxes.clear();

                backupPanel.tree.innerHTML = "Loading...";
                localPanel.tree.innerHTML = "Loading...";
                backupPanel.errorEl.style.display = "none";
                localPanel.errorEl.style.display = "none";

                const payload = await requestJson("/backup_browser_tree");

                backupPanel.tree.innerHTML = "";
                localPanel.tree.innerHTML = "";

                renderNodes(payload.backup || [], backupPanel.tree, backupState, updateActions, 0);
                renderNodes(payload.local || [], localPanel.tree, localState, updateActions, 0);

                if (payload.backup_error) {
                    backupPanel.errorEl.style.display = "block";
                    backupPanel.errorEl.textContent = payload.backup_error;
                }

                updateActions();
            };

            backupDownloadAllBtn.onclick = async () => {
                try {
                    setBusy(true, "Restoring full backup...");
                    const result = await requestJson("/restore_from_hf", { method: "POST", body: JSON.stringify({}) });
                    showToast({
                        severity: "success",
                        summary: "Restore complete",
                        detail: "Downloaded all items from backup.",
                        life: 4500,
                    });
                    await loadTree();
                    if (result.restart_required) {
                        showRestartDialog();
                    }
                } catch (e) {
                    showToast({
                        severity: "error",
                        summary: "Download failed",
                        detail: String(e.message || e),
                        life: 7000,
                    });
                } finally {
                    setBusy(false, "");
                }
            };

            backupDownloadSelectedBtn.onclick = async () => {
                const items = getSelectedItems(backupState);
                if (!items.length) return;

                try {
                    setBusy(true, "Restoring selected items...");
                    const result = await requestJson("/restore_selected_from_hf", {
                        method: "POST",
                        body: JSON.stringify({ items }),
                    });
                    const restoredFiles = result.restored_files || 0;
                    const restoredNodes = result.restored_custom_nodes || 0;
                    showToast({
                        severity: "success",
                        summary: "Selected restore complete",
                        detail: `Restored ${restoredFiles} file(s), ${restoredNodes} custom node entry(ies).`,
                        life: 5000,
                    });
                    await loadTree();
                    if (result.restart_required) {
                        showRestartDialog();
                    }
                } catch (e) {
                    showToast({
                        severity: "error",
                        summary: "Selected restore failed",
                        detail: String(e.message || e),
                        life: 7000,
                    });
                } finally {
                    setBusy(false, "");
                }
            };

            backupDeleteSelectedBtn.onclick = async () => {
                const items = getSelectedItems(backupState);
                if (!items.length) return;

                const confirmed = window.confirm("Delete selected items from the Hugging Face backup repository?");
                if (!confirmed) return;

                try {
                    setBusy(true, "Deleting selected backup items...");
                    const result = await requestJson("/delete_from_hf_backup", {
                        method: "POST",
                        body: JSON.stringify({ items }),
                    });
                    const deletedFiles = result.deleted_files || 0;
                    const removedNodes = result.removed_snapshot_nodes || 0;
                    showToast({
                        severity: "success",
                        summary: "Delete complete",
                        detail: `Deleted ${deletedFiles} file(s), removed ${removedNodes} custom node snapshot entry(ies).`,
                        life: 5000,
                    });
                    await loadTree();
                } catch (e) {
                    showToast({
                        severity: "error",
                        summary: "Delete failed",
                        detail: String(e.message || e),
                        life: 7000,
                    });
                } finally {
                    setBusy(false, "");
                }
            };

            backupClearSelectionBtn.onclick = () => {
                clearBackupSelection();
            };

            localAddSelectedBtn.onclick = async () => {
                const items = getSelectedItems(localState);
                if (!items.length) return;

                try {
                    setBusy(true, "Uploading selected local items...");
                    const result = await requestJson("/backup_selected_to_hf", {
                        method: "POST",
                        body: JSON.stringify({ items }),
                    });
                    const uploaded = result.uploaded_count || 0;
                    showToast({
                        severity: "success",
                        summary: "Upload complete",
                        detail: `Uploaded ${uploaded} selected item(s) to backup.`,
                        life: 5000,
                    });
                    await loadTree();
                } catch (e) {
                    showToast({
                        severity: "error",
                        summary: "Upload failed",
                        detail: String(e.message || e),
                        life: 7000,
                    });
                } finally {
                    setBusy(false, "");
                }
            };

            try {
                await loadTree();
            } catch (e) {
                backupPanel.tree.textContent = "Failed to load backup tree.";
                localPanel.tree.textContent = "Failed to load local tree.";
                backupPanel.errorEl.style.display = "block";
                backupPanel.errorEl.textContent = String(e.message || e);
                showToast({
                    severity: "error",
                    summary: "Backup manager",
                    detail: String(e.message || e),
                    life: 7000,
                });
            }
        };

        registerGlobalAction("showBackupDialog", showBackupDialog);
    },
});
