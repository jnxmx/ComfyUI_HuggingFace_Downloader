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
                console.log(`[HF Backup] ${summary}${payload.detail || "Notification"}`);
            }
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

        const TEMPLATE_DIALOG_TOKENS = Object.freeze({
            surface: "var(--base-background, var(--interface-panel-surface, var(--comfy-menu-bg, #1f2128)))",
            panel: "var(--modal-panel-background, var(--base-background, var(--comfy-menu-bg, #1f2128)))",
            border: "var(--interface-stroke, var(--border-color, var(--border-default, #3c4452)))",
            text: "var(--input-text, var(--text-color, var(--p-text-color, #e5e7eb)))",
            shadow: "var(--shadow-interface, 0 12px 28px rgba(0, 0, 0, 0.45))",
        });

        const applyTemplateDialogOverlayStyle = (overlay, zIndex = 9999) => {
            Object.assign(overlay.style, {
                position: "fixed",
                inset: "0",
                width: "100vw",
                height: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(0,0,0,0.5)",
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
    border-top: 1px solid var(--interface-stroke, var(--border-color, var(--border-default)));
}
#backup-hf-dialog .hf-tree-block-title {
    color: var(--descrip-text, #999);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0 4px 2px;
}
#backup-hf-dialog .hf-tree-empty {
    color: var(--descrip-text, #999);
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
    background: var(--secondary-background-hover);
}
#backup-hf-dialog details[open] > summary.hf-tree-summary > .hf-tree-row {
    background: var(--secondary-background);
}
#backup-hf-dialog .hf-tree-expander {
    color: var(--input-text);
    opacity: 0.85;
}
.hf-backup-action-btn.p-button {
    min-height: 40px;
    padding: 0.5rem 0.8rem;
    font-size: 14px;
    font-weight: 600;
    font-family: var(--font-inter, Inter, sans-serif);
    border-radius: 10px;
    border: none !important;
    box-shadow: none !important;
    background: var(--secondary-background) !important;
    color: var(--base-foreground) !important;
    transition: background-color 120ms ease, opacity 120ms ease;
    display: inline-flex !important;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    line-height: 1.1;
}
.hf-backup-action-btn.p-button:hover {
    background: var(--secondary-background-hover) !important;
}
.hf-backup-action-btn.p-button.p-button-success {
    background: var(--success-background, #43c06b) !important;
}
.hf-backup-action-btn.p-button.p-button-success:hover {
    background: var(--success-background-hover, #55d17c) !important;
}
.hf-backup-action-btn.p-button.hf-btn-primary {
    background: var(--primary-background) !important;
}
.hf-backup-action-btn.p-button.hf-btn-primary:hover {
    background: var(--primary-background-hover) !important;
}
.hf-backup-action-btn.p-button.p-button-danger {
    background: var(--destructive-background) !important;
}
.hf-backup-action-btn.p-button.p-button-danger:hover {
    background: var(--destructive-background-hover) !important;
}
.hf-backup-action-btn.p-button:disabled {
    opacity: 0.6;
}
#backup-hf-dialog .hf-repo-link {
    color: var(--primary-color, var(--primary-background));
    text-decoration: none;
    font-size: inherit;
    font-weight: inherit;
}
#backup-hf-dialog .hf-repo-link:hover {
    text-decoration: underline;
}
#backup-hf-dialog .hf-header-meta {
    color: var(--descrip-text, #999);
    font-family: Inter, Arial, sans-serif;
    font-size: 16px;
    font-weight: 600;
    line-height: 24px;
}
#hf-backup-op-panel {
    position: fixed;
    right: 16px;
    top: 16px;
    width: 350px;
    min-width: 310px;
    max-width: calc(100vw - 32px);
    max-height: 60vh;
    background: var(--interface-panel-surface, var(--hf-queue-bg, var(--p-content-background, var(--comfy-menu-bg, #1f2128))));
    border: 1px solid var(--interface-stroke, var(--hf-queue-border, var(--border-color, var(--p-content-border-color, #3c4452))));
    border-radius: 8px;
    color: var(--fg-color, var(--p-text-color, #ddd));
    font-size: 12px;
    z-index: 10002;
    display: none;
    flex-direction: column;
    overflow: hidden;
}
#hf-backup-op-panel .hf-backup-op-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 48px;
    padding: 0 8px;
    border-bottom: 1px solid var(--interface-stroke, var(--border-color, var(--p-content-border-color, #333)));
    background: transparent;
}
#hf-backup-op-panel .hf-backup-op-header-title {
    padding: 0 8px;
    font-size: 14px;
    font-weight: 400;
    color: var(--text-color, var(--input-text, var(--p-text-color, #e5e7eb)));
}
#hf-backup-op-panel .hf-backup-op-header-controls {
    display: inline-flex;
    align-items: center;
    gap: 4px;
}
#hf-backup-op-panel .hf-backup-op-count {
    min-width: 24px;
    height: 24px;
    background: var(--secondary-background, var(--p-surface-800, #2f323a));
    color: var(--text-color, var(--input-text, var(--p-text-color, #e5e7eb)));
    padding: 0 8px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    line-height: 1;
    font-weight: 700;
    opacity: 0.9;
}
#hf-backup-op-panel .hf-backup-op-minimize {
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-color, var(--input-text, #e5e7eb));
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
}
#hf-backup-op-panel .hf-backup-op-minimize:hover {
    background: var(--secondary-background-hover, rgba(255, 255, 255, 0.08));
}
#hf-backup-op-panel .hf-backup-op-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 6px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
#hf-backup-op-panel .hf-backup-op-item {
    background: var(--secondary-background, var(--p-surface-800, #222));
    border: 1px solid var(--secondary-background, var(--border-color, var(--border-default, #3c4452)));
    border-radius: 8px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 48px;
    box-sizing: border-box;
}
#hf-backup-op-panel .hf-backup-op-main {
    display: flex;
    align-items: center;
    gap: 8px;
}
#hf-backup-op-panel .hf-backup-op-spinner {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.22);
    border-top-color: #4aa3ff;
    animation: hf-backup-op-spin 0.9s linear infinite;
    flex: 0 0 auto;
}
#hf-backup-op-panel .hf-backup-op-spinner.done {
    animation: none;
    border-color: #5bd98c;
}
#hf-backup-op-panel .hf-backup-op-spinner.error {
    animation: none;
    border-color: #ff6b6b;
}
@keyframes hf-backup-op-spin {
    to { transform: rotate(360deg); }
}
#hf-backup-op-panel .hf-backup-op-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-color, var(--input-text, #e3e5ea));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
#hf-backup-op-panel .hf-backup-op-detail {
    font-size: 11px;
    color: var(--descrip-text, var(--p-text-muted-color, #aab1bc));
    min-height: 15px;
    line-height: 1.25;
}
#hf-backup-op-panel .hf-backup-op-actions {
    display: none;
    justify-content: flex-end;
    padding: 8px 12px 10px;
    border-top: 1px solid var(--interface-stroke, var(--border-color, var(--p-content-border-color, #333)));
    background: transparent;
}
#hf-backup-op-panel .hf-backup-op-refresh {
    border-radius: 8px;
    padding: 0.55rem 1.15rem;
    font-size: 14px;
    cursor: pointer;
    font-weight: 600;
    min-height: 40px;
    font-family: var(--font-inter, Inter, sans-serif);
}
#hf-backup-op-panel .hf-backup-op-refresh:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}
#hf-backup-op-panel.hf-backup-op-minimized .hf-backup-op-body,
#hf-backup-op-panel.hf-backup-op-minimized .hf-backup-op-actions {
    display: none !important;
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
            } else if (tone === "primary") {
                button.classList.add("hf-btn-primary");
            } else if (tone === "danger") {
                button.classList.add("p-button-danger");
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
                background: TEMPLATE_DIALOG_TOKENS.surface,
                border: `1px solid ${TEMPLATE_DIALOG_TOKENS.border}`,
                borderRadius: "16px",
                padding: "24px",
                minWidth: "360px",
                maxWidth: "520px",
                color: TEMPLATE_DIALOG_TOKENS.text,
                display: "flex",
                flexDirection: "column",
                gap: "14px",
                boxShadow: TEMPLATE_DIALOG_TOKENS.shadow,
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

        const showConfirmDialog = ({
            title = "Please confirm",
            message = "",
            confirmLabel = "Confirm",
            confirmTone = "primary",
            cancelLabel = "Cancel",
        } = {}) => new Promise((resolve) => {
            const existing = document.getElementById("hf-confirm-dialog");
            if (existing) existing.remove();

            const overlay = document.createElement("div");
            overlay.id = "hf-confirm-dialog";
            applyTemplateDialogOverlayStyle(overlay, 10001);

            const panel = document.createElement("div");
            applyTemplateDialogPanelStyle(panel, {
                minWidth: "360px",
                maxWidth: "560px",
                width: "min(560px, 100%)",
                padding: "24px",
                gap: "14px",
            });

            const heading = document.createElement("div");
            heading.textContent = title;
            Object.assign(heading.style, {
                fontFamily: "Inter, Arial, sans-serif",
                fontSize: "20px",
                fontWeight: "600",
                lineHeight: "1.25",
                color: "var(--input-text)",
            });

            const detail = document.createElement("div");
            detail.textContent = message;
            Object.assign(detail.style, {
                fontSize: "14px",
                lineHeight: "1.4",
                color: "var(--descrip-text, #c4c9d4)",
            });

            const actions = document.createElement("div");
            Object.assign(actions.style, {
                display: "flex",
                justifyContent: "flex-end",
                gap: "8px",
                marginTop: "4px",
            });

            let settled = false;
            const onKeyDown = (event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    settle(false);
                }
            };
            const settle = (value) => {
                if (settled) return;
                settled = true;
                document.removeEventListener("keydown", onKeyDown);
                overlay.remove();
                resolve(Boolean(value));
            };

            const cancelBtn = createButton(cancelLabel, "default");
            cancelBtn.onclick = () => settle(false);

            const confirmBtn = createButton(confirmLabel, confirmTone);
            confirmBtn.onclick = () => settle(true);

            actions.appendChild(cancelBtn);
            actions.appendChild(confirmBtn);

            panel.appendChild(heading);
            panel.appendChild(detail);
            panel.appendChild(actions);
            overlay.appendChild(panel);

            overlay.addEventListener("click", (event) => {
                if (event.target === overlay) {
                    settle(false);
                }
            });

            document.addEventListener("keydown", onKeyDown);

            document.body.appendChild(overlay);
            confirmBtn.focus();
        });

        const refreshComfyUiState = async () => {
            try {
                if (typeof app?.refreshComboInNodes === "function") {
                    const maybePromise = app.refreshComboInNodes();
                    if (maybePromise && typeof maybePromise.then === "function") {
                        await maybePromise;
                    }
                }
                if (app?.graph && typeof app.graph.setDirtyCanvas === "function") {
                    app.graph.setDirtyCanvas(true, true);
                }
                if (app?.canvas && typeof app.canvas.setDirty === "function") {
                    app.canvas.setDirty(true, true);
                }
                return true;
            } catch (error) {
                console.warn("[HF Backup] Refresh hook failed:", error);
                return false;
            }
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
                { id: "io", title: "Input / Output", nodes: groups.io },
                { id: "models", title: "Models", nodes: groups.models },
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
                padding: "4px 6px",
                color: node.selectable ? "var(--input-text)" : "var(--descrip-text, #999)",
                minHeight: "24px",
                minWidth: "0",
            });

            const expander = document.createElement("span");
            expander.className = "hf-tree-expander";
            expander.textContent = hasChildren ? (isOpen ? "▾" : "▸") : "";
            Object.assign(expander.style, {
                width: "16px",
                textAlign: "center",
                color: "var(--input-text)",
                fontSize: "13px",
                userSelect: "none",
                opacity: "0.85",
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
            label.style.fontSize = "13px";
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
        let opStatusRotateTimer = null;
        let opStatusHideTimer = null;
        let opStatusPanelMinimized = false;
        let opStatusPositionHandlersAttached = false;

        const clearOpStatusTimers = () => {
            if (opStatusRotateTimer) {
                clearInterval(opStatusRotateTimer);
                opStatusRotateTimer = null;
            }
            if (opStatusHideTimer) {
                clearTimeout(opStatusHideTimer);
                opStatusHideTimer = null;
            }
        };

        const getOperationPanelTopAnchor = () => {
            const appAnchor = app?.menu?.settingsGroup?.element?.parentElement;
            if (appAnchor?.getBoundingClientRect) return appAnchor;

            const selectors = [
                ".comfyui-menu-bar",
                ".comfyui-menu",
                ".comfyui-header",
                ".p-menubar",
                "header",
            ];
            for (const selector of selectors) {
                const element = document.querySelector(selector);
                if (element?.getBoundingClientRect) return element;
            }
            return null;
        };

        const syncOperationPanelThemeFromJobQueue = (panel) => {
            if (!panel || typeof window === "undefined" || !window.getComputedStyle) return;
            const textNodes = document.querySelectorAll("h1, h2, h3, h4, span, div");
            let jobQueueTitle = null;
            for (const node of textNodes) {
                if ((node.textContent || "").trim() !== "Job Queue") continue;
                if (node.closest("#hf-backup-op-panel")) continue;
                jobQueueTitle = node;
                break;
            }

            if (!jobQueueTitle) {
                panel.style.removeProperty("--hf-queue-bg");
                panel.style.removeProperty("--hf-queue-border");
                return;
            }

            const candidates = [
                jobQueueTitle.closest("[class*='panel']"),
                jobQueueTitle.closest("[class*='queue']"),
                jobQueueTitle.closest("[role='dialog']"),
                jobQueueTitle.closest("section"),
                jobQueueTitle.parentElement,
            ];
            const nativePanel = candidates.find((el) => el && el !== panel);
            if (!nativePanel) return;

            const styles = window.getComputedStyle(nativePanel);
            const bg = styles.backgroundColor;
            const border = styles.borderColor;
            if (bg && bg !== "rgba(0, 0, 0, 0)") {
                panel.style.setProperty("--hf-queue-bg", bg);
            }
            if (border && border !== "rgba(0, 0, 0, 0)") {
                panel.style.setProperty("--hf-queue-border", border);
            }
        };

        const updateOperationPanelPosition = () => {
            const panel = document.getElementById("hf-backup-op-panel");
            if (!panel) return;
            const anchor = getOperationPanelTopAnchor();
            let top = 16;
            if (anchor) {
                const rect = anchor.getBoundingClientRect();
                if (Number.isFinite(rect.bottom)) {
                    top = Math.max(8, Math.round(rect.bottom + 10));
                }
            }
            panel.style.top = `${top}px`;
            panel.style.right = "16px";
            panel.style.bottom = "auto";
            panel.style.left = "auto";
            panel.style.maxHeight = `calc(100vh - ${top + 16}px)`;
            syncOperationPanelThemeFromJobQueue(panel);
        };

        const setOperationPanelMinimized = (value) => {
            opStatusPanelMinimized = Boolean(value);
            const panel = document.getElementById("hf-backup-op-panel");
            if (!panel) return;
            panel.classList.toggle("hf-backup-op-minimized", opStatusPanelMinimized);

            const minimizeBtn = panel.querySelector(".hf-backup-op-minimize");
            if (minimizeBtn) {
                minimizeBtn.innerHTML = opStatusPanelMinimized ? "<i class=\"pi pi-plus\"></i>" : "<i class=\"pi pi-minus\"></i>";
                minimizeBtn.title = opStatusPanelMinimized ? "Expand backup uploads" : "Minimize backup uploads";
            }
        };

        const hideOperationStatusPanel = () => {
            const panel = document.getElementById("hf-backup-op-panel");
            if (!panel) return;
            panel.style.display = "none";
            setOperationPanelMinimized(false);
        };

        const ensureOperationStatusPanel = () => {
            let panel = document.getElementById("hf-backup-op-panel");
            if (!panel) {
                panel = document.createElement("div");
                panel.id = "hf-backup-op-panel";

                const header = document.createElement("div");
                header.className = "hf-backup-op-header";

                const headerTitle = document.createElement("div");
                headerTitle.className = "hf-backup-op-header-title";
                headerTitle.textContent = "Backup Uploads";

                const controls = document.createElement("div");
                controls.className = "hf-backup-op-header-controls";

                const count = document.createElement("div");
                count.className = "hf-backup-op-count";
                count.textContent = "1";

                const minimizeBtn = document.createElement("button");
                minimizeBtn.type = "button";
                minimizeBtn.className = "hf-backup-op-minimize";
                minimizeBtn.innerHTML = "<i class=\"pi pi-minus\"></i>";
                minimizeBtn.title = "Minimize backup uploads";
                minimizeBtn.addEventListener("click", () => {
                    setOperationPanelMinimized(!opStatusPanelMinimized);
                });

                controls.appendChild(count);
                controls.appendChild(minimizeBtn);
                header.appendChild(headerTitle);
                header.appendChild(controls);

                const body = document.createElement("div");
                body.className = "hf-backup-op-body";
                applyNativeScrollbarClasses(body);

                const item = document.createElement("div");
                item.className = "hf-backup-op-item";

                const main = document.createElement("div");
                main.className = "hf-backup-op-main";

                const spinner = document.createElement("div");
                spinner.className = "hf-backup-op-spinner";

                const title = document.createElement("div");
                title.className = "hf-backup-op-title";

                main.appendChild(spinner);
                main.appendChild(title);

                const detail = document.createElement("div");
                detail.className = "hf-backup-op-detail";

                item.appendChild(main);
                item.appendChild(detail);
                body.appendChild(item);

                const actions = document.createElement("div");
                actions.className = "hf-backup-op-actions";
                const refreshButton = document.createElement("button");
                refreshButton.type = "button";
                refreshButton.className = "hf-backup-op-refresh p-button p-component p-button-success";
                refreshButton.textContent = "Refresh";
                refreshButton.onclick = async () => {
                    refreshButton.disabled = true;
                    const originalLabel = refreshButton.textContent;
                    refreshButton.textContent = "Refreshing...";
                    const ok = await refreshComfyUiState();
                    refreshButton.textContent = ok ? "Refreshed" : "Refresh failed";
                    if (ok) {
                        showToast({
                            severity: "success",
                            summary: "Refreshed",
                            detail: "ComfyUI model widgets refreshed without page reload.",
                            life: 2500,
                        });
                        setTimeout(() => {
                            refreshButton.textContent = originalLabel;
                            refreshButton.disabled = false;
                            hideOperationStatusPanel();
                        }, 700);
                        return;
                    }
                    setTimeout(() => {
                        refreshButton.textContent = originalLabel;
                        refreshButton.disabled = false;
                    }, 900);
                };
                actions.appendChild(refreshButton);

                panel.appendChild(header);
                panel.appendChild(body);
                panel.appendChild(actions);
                document.body.appendChild(panel);

                if (!opStatusPositionHandlersAttached) {
                    window.addEventListener("resize", updateOperationPanelPosition, { passive: true });
                    window.addEventListener("scroll", updateOperationPanelPosition, { passive: true });
                    opStatusPositionHandlersAttached = true;
                }
            }

            updateOperationPanelPosition();
            setOperationPanelMinimized(opStatusPanelMinimized);

            return {
                panel,
                spinner: panel.querySelector(".hf-backup-op-spinner"),
                title: panel.querySelector(".hf-backup-op-title"),
                detail: panel.querySelector(".hf-backup-op-detail"),
                actions: panel.querySelector(".hf-backup-op-actions"),
            };
        };

        const normalizeActionPath = (value) => String(value || "")
            .replace(/\\/g, "/")
            .replace(/^\/+/, "")
            .replace(/^\.\/+/, "")
            .replace(/^ComfyUI\//i, "");

        const inferCategoryFromPath = (path) => {
            const normalized = normalizeActionPath(path).toLowerCase();
            if (!normalized) return null;
            if (normalized.endsWith("user/default/comfy.settings.json")) return "Settings";
            if (normalized.startsWith("user/default/workflows/.subgraphs") || normalized.includes("/.subgraphs/")) return "Subgraphs";
            if (normalized.startsWith("user/default/workflows")) return "Workflows";
            if (normalized.startsWith("custom_nodes")) return "Custom Nodes";
            if (normalized === "input" || normalized.startsWith("input/")) return "Input";
            if (normalized === "output" || normalized.startsWith("output/")) return "Output";
            if (normalized.startsWith("models/")) {
                const folder = normalized.split("/")[1];
                return folder ? `Models / ${folder}` : "Models";
            }
            return "Files";
        };

        const inferCategoriesFromItems = (items = [], fallback = []) => {
            const ordered = [];
            const seen = new Set();
            const add = (label) => {
                if (!label || seen.has(label)) return;
                seen.add(label);
                ordered.push(label);
            };

            for (const action of items || []) {
                if (!action || typeof action !== "object") continue;
                const kind = String(action.kind || "");
                if (kind === "local_custom_nodes_all" || kind === "custom_nodes_all" || kind === "snapshot_custom_node") {
                    add("Custom Nodes");
                    continue;
                }
                if (kind === "paths" && Array.isArray(action.paths)) {
                    action.paths.forEach((p) => add(inferCategoryFromPath(p)));
                    continue;
                }
                if (kind === "path") {
                    add(inferCategoryFromPath(action.path));
                }
            }

            if (!ordered.length) {
                fallback.forEach((item) => add(item));
            }
            return ordered;
        };

        const showOperationProgress = ({ title, categories = [] }) => {
            clearOpStatusTimers();
            const refs = ensureOperationStatusPanel();
            refs.panel.style.display = "flex";
            setOperationPanelMinimized(false);
            updateOperationPanelPosition();
            refs.title.textContent = title || "Backup in progress. Please wait.";
            refs.spinner.classList.remove("done", "error");
            refs.actions.style.display = "none";

            if (!categories.length) {
                refs.detail.textContent = "Working...";
                return;
            }

            let index = 0;
            refs.detail.textContent = `Processing: ${categories[0]}`;
            if (categories.length > 1) {
                opStatusRotateTimer = setInterval(() => {
                    index = (index + 1) % categories.length;
                    refs.detail.textContent = `Processing: ${categories[index]}`;
                }, 1400);
            }
        };

        const showOperationDone = ({ title, detail, showRefresh = false }) => {
            clearOpStatusTimers();
            const refs = ensureOperationStatusPanel();
            refs.panel.style.display = "flex";
            setOperationPanelMinimized(false);
            updateOperationPanelPosition();
            refs.title.textContent = title || "Operation complete.";
            refs.detail.textContent = detail || "";
            refs.spinner.classList.remove("error");
            refs.spinner.classList.add("done");
            refs.actions.style.display = showRefresh ? "flex" : "none";
        };

        const showOperationError = ({ title, detail }) => {
            clearOpStatusTimers();
            const refs = ensureOperationStatusPanel();
            refs.panel.style.display = "flex";
            setOperationPanelMinimized(false);
            updateOperationPanelPosition();
            refs.title.textContent = title || "Backup operation failed.";
            refs.detail.textContent = detail || "";
            refs.spinner.classList.remove("done");
            refs.spinner.classList.add("error");
            refs.actions.style.display = "none";
            opStatusHideTimer = setTimeout(() => {
                hideOperationStatusPanel();
            }, 7000);
        };

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
            let backupSelectionTouched = false;

            const overlay = document.createElement("div");
            currentDialog = overlay;
            overlay.id = "backup-hf-dialog";
            applyTemplateDialogOverlayStyle(overlay, 9999);
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
                    if (busy) return;
                    closeDialog();
                }
            });

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
                gap: "8px",
                height: "88px",
                padding: "0 24px",
                flexShrink: "0",
            });

            const header = document.createElement("div");
            header.textContent = "Backup Manager";
            header.style.letterSpacing = "0";
            header.style.color = "var(--input-text)";
            header.style.flex = "1";
            header.style.minWidth = "0";
            header.style.setProperty("font-family", "Inter, Arial, sans-serif", "important");
            header.style.setProperty("font-size", "24px", "important");
            header.style.setProperty("font-weight", "600", "important");
            header.style.setProperty("line-height", "32px", "important");
            headerWrap.appendChild(header);

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
                transition: "background-color 120ms ease, color 120ms ease",
                flexShrink: "0",
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
                if (busy) return;
                closeDialog();
            };
            headerWrap.appendChild(closeIconButton);
            panel.appendChild(headerWrap);

            const body = document.createElement("div");
            Object.assign(body.style, {
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "14px",
                minHeight: "420px",
                overflow: "auto",
                padding: "16px 24px 0",
            });
            applyNativeScrollbarClasses(body);

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
                    background: "transparent",
                    border: "none",
                    borderRadius: "0",
                    padding: "0",
                    minWidth: "0",
                    minHeight: "420px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                });

                const titleRow = document.createElement("div");
                Object.assign(titleRow.style, {
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    flexWrap: "wrap",
                });
                const titleEl = document.createElement("div");
                titleEl.textContent = title;
                titleEl.style.setProperty("font-family", "Inter, Arial, sans-serif", "important");
                titleEl.style.setProperty("font-size", "16px", "important");
                titleEl.style.setProperty("font-weight", "600", "important");
                titleEl.style.setProperty("line-height", "24px", "important");
                titleEl.style.color = "var(--input-text)";
                titleRow.appendChild(titleEl);

                const metaEl = document.createElement("div");
                metaEl.className = "hf-header-meta";
                metaEl.style.display = "none";
                metaEl.style.setProperty("font-family", "Inter, Arial, sans-serif", "important");
                metaEl.style.setProperty("font-size", "16px", "important");
                metaEl.style.setProperty("font-weight", "600", "important");
                metaEl.style.setProperty("line-height", "24px", "important");
                titleRow.appendChild(metaEl);
                root.appendChild(titleRow);

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
                    border: `1px solid ${TEMPLATE_DIALOG_TOKENS.border}`,
                    borderRadius: "10px",
                    padding: "6px",
                    background: TEMPLATE_DIALOG_TOKENS.panel,
                });
                applyNativeScrollbarClasses(tree);
                tree.textContent = "Loading...";
                root.appendChild(tree);

                const actions = document.createElement("div");
                Object.assign(actions.style, {
                    display: "flex",
                    flexWrap: "nowrap",
                    alignItems: "center",
                    justifyContent: "flex-start",
                    gap: "8px",
                    marginTop: "10px",
                    minHeight: "40px",
                });
                root.appendChild(actions);

                return { root, tree, actions, errorEl, metaEl };
            };

            const localPanel = makePanel("Local Install (ComfyUI)");
            const backupPanel = makePanel("Backup (Hugging Face)");
            localPanel.tree.style.background = "#000000";

            body.appendChild(localPanel.root);
            body.appendChild(backupPanel.root);
            panel.appendChild(body);

            const footer = document.createElement("div");
            Object.assign(footer.style, {
                display: "flex",
                justifyContent: "flex-start",
                gap: "8px",
                padding: "8px 24px 16px",
            });

            const status = document.createElement("div");
            status.style.fontSize = "12px";
            status.style.color = "var(--descrip-text, #999)";
            status.textContent = "";
            footer.appendChild(status);

            panel.appendChild(footer);
            overlay.appendChild(panel);
            document.body.appendChild(overlay);

            const backupDownloadAllBtn = createButton("↓ Download full backup", "success");
            const backupDeleteSelectedBtn = createButton("Delete selected from backup", "danger");
            const backupClearSelectionBtn = createButton("Clear selection", "secondary");
            const setBackupSelectionButtonsVisible = (visible) => {
                const displayValue = visible ? "inline-flex" : "none";
                backupDeleteSelectedBtn.style.setProperty("display", displayValue, "important");
                backupClearSelectionBtn.style.setProperty("display", displayValue, "important");
            };
            setBackupSelectionButtonsVisible(false);

            backupPanel.actions.appendChild(backupDownloadAllBtn);
            backupPanel.actions.appendChild(backupDeleteSelectedBtn);
            backupPanel.actions.appendChild(backupClearSelectionBtn);

            const localAddSelectedBtn = createButton("↑ Upload to backup", "primary");
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

                backupPanel.metaEl.innerHTML = "";

                if (!repoName) {
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

                const hasBackupSelection = backupSelectionTouched && backupItems.length > 0;
                backupDownloadAllBtn.textContent = hasBackupSelection
                    ? "↓ Download selected only"
                    : "↓ Download full backup";
                setBackupSelectionButtonsVisible(hasBackupSelection);
                backupDownloadAllBtn.disabled = busy;
                backupDeleteSelectedBtn.disabled = busy || backupItems.length === 0;
                backupClearSelectionBtn.disabled = busy || backupItems.length === 0;
                localAddSelectedBtn.disabled = busy || localItems.length === 0;
                closeIconButton.disabled = busy;
                closeIconButton.style.opacity = busy ? "0.5" : "1";
                closeIconButton.style.cursor = busy ? "default" : "pointer";
            };

            const clearBackupSelection = () => {
                clearSelectionState(backupState);
                updateActions();
            };

            const setBusy = (value, msg = "") => {
                busy = value;
                if (!overlay.isConnected) {
                    return;
                }
                panel.style.opacity = "1";
                setStatus(msg);
                updateActions();
            };

            const loadTree = async () => {
                resetSelectionStructure(backupState);
                resetSelectionStructure(localState);
                backupSelectionTouched = false;

                backupPanel.tree.innerHTML = "Loading...";
                localPanel.tree.innerHTML = "Loading...";
                backupPanel.errorEl.style.display = "none";
                localPanel.errorEl.style.display = "none";

                const payload = await requestJson("/backup_browser_tree");

                backupPanel.tree.innerHTML = "";
                localPanel.tree.innerHTML = "";

                renderGroupedTree(payload.backup || [], backupPanel.tree, backupState, () => {
                    backupSelectionTouched = true;
                    updateActions();
                });
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
                const items = getSelectedItems(backupState);
                if (backupSelectionTouched && items.length) {
                    try {
                        showOperationProgress({
                            title: "Backup restore in progress. Please wait.",
                            categories: inferCategoriesFromItems(items, ["Selected items"]),
                        });
                        setBusy(true, "Restoring selected items...");
                        closeDialog();
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
                        showOperationDone({
                            title: "Backup restore complete",
                            detail: `Restored ${restoredFiles} file(s).`,
                            showRefresh: false,
                        });
                        if (result.restart_required) {
                            showRestartDialog();
                        }
                    } catch (e) {
                        showOperationError({
                            title: "Selected restore failed",
                            detail: String(e.message || e),
                        });
                        showToast({
                            severity: "error",
                            summary: "Selected restore failed",
                            detail: String(e.message || e),
                            life: 7000,
                        });
                    } finally {
                        setBusy(false, "");
                    }
                    return;
                }

                try {
                    showOperationProgress({
                        title: "Backup restore in progress. Please wait.",
                        categories: ["Settings", "Workflows", "Subgraphs", "Custom Nodes", "Models", "Input", "Output"],
                    });
                    setBusy(true, "Restoring full backup...");
                    closeDialog();
                    const result = await requestJson("/restore_from_hf", { method: "POST", body: JSON.stringify({}) });
                    showToast({
                        severity: "success",
                        summary: "Restore complete",
                        detail: "Downloaded all items from backup.",
                        life: 4500,
                    });
                    await loadTree();
                    showOperationDone({
                        title: "Backup restore complete",
                        showRefresh: false,
                    });
                    if (result.restart_required) {
                        showRestartDialog();
                    }
                } catch (e) {
                    showOperationError({
                        title: "Backup restore failed",
                        detail: String(e.message || e),
                    });
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

            backupDeleteSelectedBtn.onclick = async () => {
                const items = getSelectedItems(backupState);
                if (!items.length) return;

                const confirmed = await showConfirmDialog({
                    title: "Delete selected backup items?",
                    message: "This will permanently remove selected files from your Hugging Face backup repository.",
                    confirmLabel: "Delete",
                    confirmTone: "danger",
                    cancelLabel: "Cancel",
                });
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
                    showOperationProgress({
                        title: "Backup in progress. Please wait.",
                        categories: inferCategoriesFromItems(items, ["Selected items"]),
                    });
                    setBusy(true, "Uploading selected local items...");
                    closeDialog();
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
                    showOperationDone({
                        title: "Backup upload complete",
                        detail: `Uploaded ${uploaded} item(s).`,
                        showRefresh: true,
                    });
                } catch (e) {
                    showOperationError({
                        title: "Backup upload failed",
                        detail: String(e.message || e),
                    });
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
