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

        const ensureTreeStyles = () => {
            if (document.getElementById("hf-backup-tree-style")) return;
            const style = document.createElement("style");
            style.id = "hf-backup-tree-style";
            style.textContent = `
#backup-hf-dialog summary.hf-tree-summary {
    list-style: none;
}
#backup-hf-dialog summary.hf-tree-summary::-webkit-details-marker {
    display: none;
}
#backup-hf-dialog summary.hf-tree-summary::marker {
    display: none;
    content: "";
}
#backup-hf-dialog .hf-tree-root {
    display: flex;
    flex-direction: column;
    gap: 0;
}
#backup-hf-dialog .hf-tree-block {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
#backup-hf-dialog .hf-tree-block + .hf-tree-block {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #2a2f3a;
}
#backup-hf-dialog .hf-tree-block-title {
    color: #8f97a5;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0 4px 2px;
}
#backup-hf-dialog .hf-tree-empty {
    color: #727a88;
    font-size: 11px;
    padding: 4px 6px;
}
#backup-hf-dialog .hf-tree-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
}
#backup-hf-dialog .hf-tree-row {
    border-radius: 4px;
    transition: background-color 120ms ease;
}
#backup-hf-dialog .hf-tree-row:hover {
    background: rgba(115, 133, 165, 0.11);
}
#backup-hf-dialog details[open] > summary.hf-tree-summary > .hf-tree-row {
    background: rgba(96, 115, 148, 0.14);
}
#backup-hf-dialog .hf-tree-expander {
    color: #b8c0cf;
}
#backup-hf-dialog .hf-backup-action-btn.p-button {
    min-height: 28px;
    padding: 0.26rem 0.7rem;
    font-size: 12px;
    font-weight: 600;
    border-radius: 6px;
}
#backup-hf-dialog .hf-repo-link {
    color: #7cb3ff;
    text-decoration: none;
    font-size: 12px;
}
#backup-hf-dialog .hf-repo-link:hover {
    text-decoration: underline;
}
#backup-hf-dialog .hf-header-meta {
    color: #9aa4b6;
    font-size: 11px;
}
`;
            document.head.appendChild(style);
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
            button.className = "p-button p-component hf-backup-action-btn";
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
            nodes: new Map(),
            parentById: new Map(),
            childrenById: new Map(),
            depthById: new Map(),
            defaultCheckedIds: new Set(),
        });

        const linkParentChild = (state, parentId, childId) => {
            if (!parentId || !childId) return;
            state.parentById.set(childId, parentId);
            const children = state.childrenById.get(parentId) || [];
            children.push(childId);
            state.childrenById.set(parentId, children);
        };

        const getSelectableDescendantIds = (state, nodeId) => {
            const ids = [];
            const stack = [...(state.childrenById.get(nodeId) || [])];
            while (stack.length) {
                const current = stack.pop();
                if (state.checkboxes.has(current)) {
                    ids.push(current);
                }
                const children = state.childrenById.get(current);
                if (children?.length) {
                    stack.push(...children);
                }
            }
            return ids;
        };

        const updateSelectedMapForNode = (state, nodeId, checked, indeterminate = false) => {
            const node = state.nodes.get(nodeId);
            if (!node?.action) return;
            if (checked && !indeterminate) {
                state.selected.set(nodeId, node.action);
            } else {
                state.selected.delete(nodeId);
            }
        };

        const setCheckboxVisual = (state, nodeId, checked, indeterminate = false) => {
            const cb = state.checkboxes.get(nodeId);
            if (!cb) return;
            cb.checked = Boolean(checked);
            cb.indeterminate = Boolean(indeterminate);
        };

        const updateAncestorStates = (state, nodeId) => {
            let parentId = state.parentById.get(nodeId);
            while (parentId) {
                const parentCb = state.checkboxes.get(parentId);
                if (parentCb) {
                    const descendants = getSelectableDescendantIds(state, parentId);
                    if (descendants.length) {
                        let checkedCount = 0;
                        let hasIndeterminate = false;
                        for (const id of descendants) {
                            const cb = state.checkboxes.get(id);
                            if (!cb) continue;
                            if (cb.indeterminate) {
                                hasIndeterminate = true;
                            } else if (cb.checked) {
                                checkedCount += 1;
                            }
                        }

                        const allChecked = checkedCount === descendants.length && !hasIndeterminate;
                        const noneChecked = checkedCount === 0 && !hasIndeterminate;
                        if (allChecked) {
                            setCheckboxVisual(state, parentId, true, false);
                            updateSelectedMapForNode(state, parentId, true, false);
                        } else if (noneChecked) {
                            setCheckboxVisual(state, parentId, false, false);
                            updateSelectedMapForNode(state, parentId, false, false);
                        } else {
                            setCheckboxVisual(state, parentId, false, true);
                            updateSelectedMapForNode(state, parentId, false, true);
                        }
                    }
                }
                parentId = state.parentById.get(parentId);
            }
        };

        const setNodeSelectionCascade = (state, nodeId, checked) => {
            if (state.checkboxes.has(nodeId)) {
                setCheckboxVisual(state, nodeId, checked, false);
                updateSelectedMapForNode(state, nodeId, checked, false);
            }

            const descendants = getSelectableDescendantIds(state, nodeId);
            for (const id of descendants) {
                setCheckboxVisual(state, id, checked, false);
                updateSelectedMapForNode(state, id, checked, false);
            }

            updateAncestorStates(state, nodeId);
        };

        const clearSelectionState = (state) => {
            state.selected.clear();
            for (const cb of state.checkboxes.values()) {
                cb.checked = false;
                cb.indeterminate = false;
            }
        };

        const initializeDefaultSelections = (state) => {
            const defaultIds = Array.from(state.defaultCheckedIds).sort(
                (a, b) => (state.depthById.get(a) || 0) - (state.depthById.get(b) || 0)
            );
            clearSelectionState(state);
            for (const id of defaultIds) {
                setNodeSelectionCascade(state, id, true);
            }
        };

        const resetSelectionStructure = (state) => {
            state.selected.clear();
            state.checkboxes.clear();
            state.nodes.clear();
            state.parentById.clear();
            state.childrenById.clear();
            state.depthById.clear();
            state.defaultCheckedIds.clear();
        };

        const normalizeSectionKey = (label) => (label || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "");

        const groupTopLevelNodes = (nodes) => {
            const groups = {
                core: [],
                custom: [],
                models: [],
                io: [],
            };

            for (const node of nodes || []) {
                const key = normalizeSectionKey(node.label);
                if (["settings", "workflows", "subgraphs"].includes(key)) {
                    groups.core.push(node);
                } else if (key === "custom_nodes") {
                    groups.custom.push(node);
                } else if (["input", "output"].includes(key)) {
                    groups.io.push(node);
                } else {
                    groups.models.push(node);
                }
            }

            return [
                { id: "core", title: "Settings / Workflows", nodes: groups.core },
                { id: "custom", title: "Custom Nodes", nodes: groups.custom },
                { id: "models", title: "Models", nodes: groups.models },
                { id: "io", title: "Input / Output", nodes: groups.io },
            ];
        };

        const getSelectedItems = (state) => {
            const dedup = new Map();
            for (const action of state.selected.values()) {
                if (!action) continue;
                const key = JSON.stringify(action);
                dedup.set(key, action);
            }
            return Array.from(dedup.values());
        };

        const makeNodeRow = (node, state, onSelectionChange, opts = {}) => {
            const { hasChildren = false, isOpen = false } = opts;
            const row = document.createElement("div");
            row.className = "hf-tree-row";
            Object.assign(row.style, {
                display: "grid",
                gridTemplateColumns: "16px 22px minmax(0,1fr)",
                alignItems: "center",
                gap: "8px",
                padding: "3px 6px",
                color: node.selectable ? "#ececec" : "#9aa0a6",
                minHeight: "22px",
                minWidth: "0",
            });

            const expander = document.createElement("span");
            expander.className = "hf-tree-expander";
            expander.textContent = hasChildren ? (isOpen ? "▾" : "▸") : "";
            Object.assign(expander.style, {
                width: "16px",
                textAlign: "center",
                color: "#cfd6df",
                fontSize: "12px",
                userSelect: "none",
            });
            row.appendChild(expander);

            if (node.selectable && node.action) {
                const cb = document.createElement("input");
                cb.type = "checkbox";
                cb.checked = Boolean(node.default_checked);
                cb.addEventListener("mousedown", (e) => e.stopPropagation());
                cb.addEventListener("click", (e) => e.stopPropagation());
                cb.addEventListener("change", () => {
                    setNodeSelectionCascade(state, node.id, cb.checked);
                    onSelectionChange();
                });
                state.checkboxes.set(node.id, cb);
                if (cb.checked) {
                    state.defaultCheckedIds.add(node.id);
                }
                const cbWrap = document.createElement("span");
                cbWrap.style.display = "flex";
                cbWrap.style.alignItems = "center";
                cbWrap.style.justifyContent = "center";
                cbWrap.appendChild(cb);
                row.appendChild(cbWrap);
            } else {
                const spacer = document.createElement("span");
                spacer.style.display = "block";
                spacer.style.width = "22px";
                row.appendChild(spacer);
            }

            const label = document.createElement("span");
            label.textContent = node.label;
            label.style.fontSize = "12px";
            label.style.flex = "1";
            label.style.minWidth = "0";
            label.style.overflowWrap = "anywhere";
            row.appendChild(label);

            return row;
        };

        const renderNodes = (nodes, mount, state, onSelectionChange, depth = 0, parentId = null) => {
            const list = document.createElement("div");
            list.className = "hf-tree-list";
            Object.assign(list.style, {
                display: "flex",
                flexDirection: "column",
                gap: "1px",
                marginLeft: depth === 0 ? "0" : "14px",
            });

            (nodes || []).forEach((node) => {
                state.nodes.set(node.id, node);
                state.depthById.set(node.id, depth);
                linkParentChild(state, parentId, node.id);

                const hasChildren = Array.isArray(node.children) && node.children.length > 0;

                if (hasChildren) {
                    const details = document.createElement("details");
                    details.open = false;
                    details.style.borderRadius = "6px";

                    const summary = document.createElement("summary");
                    summary.className = "hf-tree-summary";
                    summary.style.cursor = "pointer";
                    summary.style.listStyle = "none";
                    summary.style.display = "block";
                    summary.style.padding = "0";
                    summary.style.margin = "0";
                    summary.style.outline = "none";
                    const row = makeNodeRow(node, state, onSelectionChange, {
                        hasChildren: true,
                        isOpen: details.open,
                    });
                    summary.appendChild(row);

                    details.addEventListener("toggle", () => {
                        const expander = row.querySelector(".hf-tree-expander");
                        if (expander) {
                            expander.textContent = details.open ? "▾" : "▸";
                        }
                    });

                    const childWrap = document.createElement("div");
                    renderNodes(node.children, childWrap, state, onSelectionChange, depth + 1, node.id);

                    details.appendChild(summary);
                    details.appendChild(childWrap);
                    list.appendChild(details);
                } else {
                    list.appendChild(makeNodeRow(node, state, onSelectionChange, { hasChildren: false }));
                }
            });

            mount.appendChild(list);
        };

        const renderGroupedTree = (nodes, mount, state, onSelectionChange) => {
            const root = document.createElement("div");
            root.className = "hf-tree-root";

            const groups = groupTopLevelNodes(nodes || []);
            for (const group of groups) {
                const block = document.createElement("section");
                block.className = "hf-tree-block";
                block.dataset.group = group.id;

                const blockTitle = document.createElement("div");
                blockTitle.className = "hf-tree-block-title";
                blockTitle.textContent = group.title;
                block.appendChild(blockTitle);

                if (group.nodes.length) {
                    renderNodes(group.nodes, block, state, onSelectionChange, 0, null);
                } else {
                    const empty = document.createElement("div");
                    empty.className = "hf-tree-empty";
                    empty.textContent = "No entries";
                    block.appendChild(empty);
                }

                root.appendChild(block);
            }

            mount.appendChild(root);
        };

        let currentDialog = null;
        let currentDialogCleanup = null;

        const showBackupDialog = async () => {
            ensureTreeStyles();
            if (currentDialog) {
                if (typeof currentDialogCleanup === "function") {
                    currentDialogCleanup();
                }
                currentDialog.remove();
                currentDialog = null;
                currentDialogCleanup = null;
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
            const closeDialog = () => {
                if (typeof currentDialogCleanup === "function") {
                    currentDialogCleanup();
                }
                overlay.remove();
                currentDialog = null;
                currentDialogCleanup = null;
            };

            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) {
                    closeDialog();
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
                padding: "16px",
                boxShadow: "0 0 24px rgba(0,0,0,0.7)",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
                overflow: "hidden",
            });

            const headerWrap = document.createElement("div");
            Object.assign(headerWrap.style, {
                display: "flex",
                flexDirection: "column",
                gap: "2px",
            });

            const header = document.createElement("div");
            header.textContent = "Backup Manager";
            header.style.fontSize = "15px";
            header.style.fontWeight = "600";
            header.style.color = "#e5ebf7";
            headerWrap.appendChild(header);

            const headerMeta = document.createElement("div");
            headerMeta.className = "hf-header-meta";
            headerMeta.textContent = "";
            headerWrap.appendChild(headerMeta);
            panel.appendChild(headerWrap);

            const body = document.createElement("div");
            Object.assign(body.style, {
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "14px",
                minHeight: "420px",
                overflow: "auto",
            });

            const updatePanelColumns = () => {
                body.style.gridTemplateColumns = window.innerWidth < 980 ? "1fr" : "1fr 1fr";
            };
            updatePanelColumns();
            window.addEventListener("resize", updatePanelColumns);
            currentDialogCleanup = () => {
                window.removeEventListener("resize", updatePanelColumns);
            };

            const makePanel = (title) => {
                const root = document.createElement("div");
                Object.assign(root.style, {
                    background: "#1b1f28",
                    border: "1px solid #323845",
                    borderRadius: "8px",
                    padding: "8px",
                    minWidth: "0",
                    minHeight: "420px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                });

                const titleEl = document.createElement("div");
                titleEl.textContent = title;
                titleEl.style.fontSize = "12px";
                titleEl.style.fontWeight = "600";
                titleEl.style.color = "#e1e6ef";
                root.appendChild(titleEl);

                const metaEl = document.createElement("div");
                metaEl.className = "hf-header-meta";
                metaEl.style.display = "none";
                root.appendChild(metaEl);

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
                    border: "1px solid #2f3440",
                    borderRadius: "6px",
                    padding: "6px",
                    background: "#171b24",
                });
                tree.textContent = "Loading...";
                root.appendChild(tree);

                const actions = document.createElement("div");
                Object.assign(actions.style, {
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "6px",
                });
                root.appendChild(actions);

                return { root, tree, actions, errorEl, metaEl };
            };

            const localPanel = makePanel("Local Install (ComfyUI)");
            const backupPanel = makePanel("Backup (Hugging Face)");

            body.appendChild(localPanel.root);
            body.appendChild(backupPanel.root);
            panel.appendChild(body);

            const footer = document.createElement("div");
            Object.assign(footer.style, {
                display: "flex",
                justifyContent: "space-between",
                gap: "8px",
            });

            const closeButton = createButton("Close", "secondary");
            closeButton.onclick = () => {
                closeDialog();
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

            const backupDownloadAllBtn = createButton("↑ Download all");
            const backupSelectedRow = document.createElement("div");
            Object.assign(backupSelectedRow.style, {
                display: "none",
                gap: "8px",
                flexWrap: "wrap",
            });
            const backupDownloadSelectedBtn = createButton("↑ Download selected only", "success");
            const backupDeleteSelectedBtn = createButton("Delete selected from backup", "danger");
            const backupClearSelectionBtn = createButton("Clear selection", "secondary");
            backupSelectedRow.appendChild(backupDownloadSelectedBtn);
            backupSelectedRow.appendChild(backupDeleteSelectedBtn);
            backupSelectedRow.appendChild(backupClearSelectionBtn);

            backupPanel.actions.appendChild(backupDownloadAllBtn);
            backupPanel.actions.appendChild(backupSelectedRow);

            const localAddSelectedBtn = createButton("↓ Upload to backup");
            localPanel.actions.appendChild(localAddSelectedBtn);

            const setStatus = (text) => {
                status.textContent = text || "";
            };

            const formatSizeGb = (sizeBytes) => {
                if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
                    return null;
                }
                return `${(sizeBytes / (1024 ** 3)).toFixed(2)} GB`;
            };

            const updateRepoMeta = (repoName, sizeBytes) => {
                const backupUrl = repoName ? `https://huggingface.co/${repoName}` : "";
                const sizeLabel = formatSizeGb(sizeBytes);

                headerMeta.innerHTML = "";
                backupPanel.metaEl.innerHTML = "";

                if (!repoName) {
                    headerMeta.textContent = "No backup repository configured.";
                    backupPanel.metaEl.style.display = "none";
                    return;
                }

                const makeLink = () => {
                    const link = document.createElement("a");
                    link.className = "hf-repo-link";
                    link.href = backupUrl;
                    link.target = "_blank";
                    link.rel = "noopener noreferrer";
                    link.textContent = repoName;
                    return link;
                };

                const headerLink = makeLink();
                headerMeta.appendChild(headerLink);
                if (sizeLabel) {
                    const size = document.createElement("span");
                    size.textContent = ` \u00b7 ${sizeLabel}`;
                    headerMeta.appendChild(size);
                }

                const panelLink = makeLink();
                backupPanel.metaEl.appendChild(panelLink);
                if (sizeLabel) {
                    const size = document.createElement("span");
                    size.textContent = ` \u00b7 ${sizeLabel}`;
                    backupPanel.metaEl.appendChild(size);
                }
                backupPanel.metaEl.style.display = "block";
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
                clearSelectionState(backupState);
                updateActions();
            };

            const setBusy = (value, msg = "") => {
                busy = value;
                panel.style.opacity = busy ? "0.78" : "1";
                setStatus(msg);
                updateActions();
            };

            const loadTree = async () => {
                resetSelectionStructure(backupState);
                resetSelectionStructure(localState);

                backupPanel.tree.innerHTML = "Loading...";
                localPanel.tree.innerHTML = "Loading...";
                backupPanel.errorEl.style.display = "none";
                localPanel.errorEl.style.display = "none";

                const payload = await requestJson("/backup_browser_tree");

                backupPanel.tree.innerHTML = "";
                localPanel.tree.innerHTML = "";

                renderGroupedTree(payload.backup || [], backupPanel.tree, backupState, updateActions);
                renderGroupedTree(payload.local || [], localPanel.tree, localState, updateActions);
                initializeDefaultSelections(backupState);
                initializeDefaultSelections(localState);
                updateRepoMeta(payload.repo_name || "", payload.backup_total_size_bytes);

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
