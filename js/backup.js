import { app } from "../../../scripts/app.js";
import { setNativeStackPanelVisible, unmountFromNativeStack } from "./native_stack.js";

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
    opacity: 0.4 !important;
    background: var(--secondary-background, #333) !important;
    color: var(--descrip-text, #999) !important;
    cursor: not-allowed !important;
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
    position: relative;
    width: min(480px, calc(100vw - 32px));
    max-width: min(480px, calc(100vw - 32px));
    max-height: min(42vh, 360px);
    box-sizing: border-box;
    border-left-width: 4px;
    border-left-color: #3b82f6;
    overflow: hidden;
    pointer-events: auto;
}
#hf-backup-op-panel .hf-backup-op-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 24px;
    padding: 0;
    background: transparent;
}
#hf-backup-op-panel .hf-backup-op-header-title {
    padding: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1 1 auto;
}
#hf-backup-op-panel .hf-backup-op-header-controls {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}
#hf-backup-op-panel .hf-backup-op-count {
    font-size: 11px;
    line-height: 1;
    font-weight: 500;
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(59, 130, 246, 0.16);
    color: #93c5fd;
    white-space: nowrap;
}
#hf-backup-op-panel .hf-backup-op-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
#hf-backup-op-panel .hf-backup-op-item {
    min-height: 44px;
    box-sizing: border-box;
}
#hf-backup-op-panel .hf-backup-op-item.has-detail {
    height: auto;
    min-height: 60px;
    max-height: none;
    align-items: flex-start;
}
#hf-backup-op-panel .hf-backup-op-content {
    min-width: 0;
    flex: 1 1 auto;
    padding-right: 76px;
}
#hf-backup-op-panel .hf-backup-op-title {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--input-text, #e3e5ea);
}
#hf-backup-op-panel .hf-backup-op-meta {
    margin-top: 2px;
    color: var(--muted-foreground, var(--descrip-text, #9ca3af));
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
    font-size: 11px;
    line-height: 1.2;
}
#hf-backup-op-panel .hf-backup-op-detail {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
#hf-backup-op-panel .hf-backup-op-error {
    margin-top: 4px;
    font-size: 11px;
    line-height: 1.25;
    color: #ffb4b4;
    white-space: normal;
    word-break: break-word;
    display: none;
}
#hf-backup-op-panel .hf-backup-op-state-icon {
    width: 16px;
    height: 16px;
    display: inline-block;
}
#hf-backup-op-panel .hf-backup-op-status-lower {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
    position: absolute;
    right: 8px;
    bottom: 7px;
    line-height: 1;
    pointer-events: none;
    z-index: 2;
    text-transform: uppercase;
}
#hf-backup-op-panel .hf-backup-op-progress-container {
    position: absolute;
    left: 0;
    bottom: 0;
    right: 0;
    height: 2px;
    background: rgba(255, 255, 255, 0.08);
    pointer-events: none;
    overflow: hidden;
}
#hf-backup-op-panel .hf-backup-op-progress-bar {
    height: 100%;
    width: 0%;
    background: #3b82f6;
    transition: width 200ms ease-out, background-color 200ms ease-in-out;
}
#hf-backup-op-panel .hf-backup-op-progress-bar.indeterminate {
    width: 42%;
    animation: hf-backup-op-progress-slide 1.25s ease-in-out infinite;
}
@keyframes hf-backup-op-progress-slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(260%); }
}
#hf-backup-op-panel .hf-backup-op-actions {
    display: none;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    padding-top: 4px;
    background: transparent;
}
#hf-backup-op-panel .hf-backup-op-actions.visible {
    display: flex;
}
#hf-backup-op-panel .hf-backup-op-footer-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px;
    font-size: 12px;
    line-height: 1;
    font-weight: 500;
    border-radius: 6px;
    cursor: pointer;
}
#hf-backup-op-panel .hf-backup-op-refresh:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}
#hf-backup-op-panel.hf-backup-op-collapsed .hf-backup-op-body,
#hf-backup-op-panel.hf-backup-op-collapsed .hf-backup-op-actions {
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

        const OP_WRAPPER_ID = "hf-backup-op-panel-wrapper";
        const OP_PANEL_ID = "hf-backup-op-panel";
        const OP_WRAPPER_CLASS = "pointer-events-none flex w-full justify-end transition-all duration-300 ease-out";
        const OP_PANEL_CLASS = "pointer-events-auto flex flex-col gap-1.5 rounded-lg border border-solid border-border border-l-4 bg-background p-2.5 text-foreground shadow-md";
        const OP_ITEM_CLASS = "hf-backup-op-item relative flex items-center justify-between gap-2 overflow-hidden rounded-md border border-solid border-border/60 bg-secondary/40 px-2 py-1.5 text-xs text-foreground transition-colors duration-150 ease-in-out";
        const OP_BUTTON_BASE_CLASS = "relative inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap appearance-none border border-solid border-border/60 rounded-md text-xs font-medium font-inter transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
        const OP_BUTTON_ICON_CLASS = "flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
        const OP_FAILED_TTL_MS = 120000;

        let currentDialog = null;
        let currentDialogCleanup = null;
        let opStatusRotateTimer = null;
        let opStatusHideTimer = null;
        let opStatusPanelMinimized = false;
        let opStatusPanelCollapsed = false;
        let opStatusHasEntries = false;
        let opStatusHasRunning = false;
        let opStatusMode = "upload";
        let opPanelWrapper = null;
        let opPanel = null;
        let opCollapseBtn = null;

        const getBackupPanelState = () => ({
            minimized: opStatusPanelMinimized,
            collapsed: opStatusPanelCollapsed,
            hasRunning: opStatusHasRunning,
            hasEntries: opStatusHasEntries,
        });

        const publishBackupPanelState = () => {
            if (typeof window === "undefined") return;
            if (!window.hfDownloader) {
                window.hfDownloader = {};
            }
            const state = getBackupPanelState();
            window.hfDownloader.backupPanelState = state;
            window.dispatchEvent(new CustomEvent("hfDownloader:panelState", { detail: state }));
        };

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

        const updateOperationPanelPosition = () => {
            if (!opPanel || !opPanelWrapper) return;
            const visible = Boolean(opStatusHasEntries && !opStatusPanelMinimized);
            if (visible) {
                setNativeStackPanelVisible(opPanelWrapper, true, { id: OP_WRAPPER_ID, priority: 15 });
            } else {
                setNativeStackPanelVisible(OP_WRAPPER_ID, false);
            }
        };

        const applyOperationPanelVisibility = () => {
            if (!opPanel || !opPanelWrapper) return;
            if (!opStatusHasEntries || opStatusPanelMinimized) {
                opPanel.style.display = "none";
                opPanelWrapper.style.display = "none";
                setNativeStackPanelVisible(OP_WRAPPER_ID, false);
            } else {
                opPanelWrapper.style.display = "flex";
                opPanel.style.display = "flex";
                opPanel.classList.toggle("hf-backup-op-collapsed", opStatusPanelCollapsed);
                if (opCollapseBtn) {
                    opCollapseBtn.innerHTML = opStatusPanelCollapsed
                        ? `<i class="icon-[lucide--chevron-down] size-4"></i>`
                        : `<i class="icon-[lucide--chevron-up] size-4"></i>`;
                    opCollapseBtn.title = opStatusPanelCollapsed ? "Expand backup status" : "Collapse backup status";
                    opCollapseBtn.setAttribute("aria-label", opStatusPanelCollapsed ? "Expand backup status" : "Collapse backup status");
                    opCollapseBtn.setAttribute("aria-expanded", String(!opStatusPanelCollapsed));
                }
                updateOperationPanelPosition();
            }
        };

        const setOperationPanelCollapsed = (value) => {
            opStatusPanelCollapsed = Boolean(value);
            applyOperationPanelVisibility();
            publishBackupPanelState();
        };

        const setOperationPanelMinimized = (value) => {
            opStatusPanelMinimized = Boolean(value);
            if (!opStatusPanelMinimized) {
                opStatusPanelCollapsed = false;
            }
            applyOperationPanelVisibility();
            publishBackupPanelState();
        };

        const hideOperationStatusPanel = () => {
            clearOpStatusTimers();
            opStatusHasEntries = false;
            opStatusHasRunning = false;
            opStatusPanelMinimized = false;
            opStatusPanelCollapsed = false;
            applyOperationPanelVisibility();
            publishBackupPanelState();
        };

        registerGlobalAction("restoreBackupOperationPanel", () => {
            if (!opStatusHasEntries) return;
            setOperationPanelMinimized(false);
            updateOperationPanelPosition();
        });
        registerGlobalAction("minimizeBackupOperationPanel", () => {
            setOperationPanelMinimized(true);
        });
        registerGlobalAction("toggleBackupOperationPanel", () => {
            setOperationPanelMinimized(!opStatusPanelMinimized);
        });
        registerGlobalAction("getBackupOperationPanelState", () => getBackupPanelState());

        const applyOperationModeHeader = (refs, mode = "upload") => {
            opStatusMode = mode === "restore" ? "restore" : "upload";
            if (!refs) return;
            const isRestore = opStatusMode === "restore";
            if (refs.headerIcon) {
                refs.headerIcon.className = `${isRestore ? "icon-[lucide--download]" : "icon-[lucide--upload]"} size-4 shrink-0`;
                refs.headerIcon.style.color = "#3b82f6";
            }
            if (refs.headerLabel) {
                refs.headerLabel.textContent = isRestore ? "Backup Restore" : "Backup Uploads";
            }
        };

        const ensureOperationStatusPanel = () => {
            ensureTreeStyles();
            if (!opPanel || !opPanelWrapper || !opPanelWrapper.isConnected) {
                if (opPanelWrapper) {
                    unmountFromNativeStack(opPanelWrapper, OP_WRAPPER_ID);
                }
                const existingWrapper = document.getElementById(OP_WRAPPER_ID);
                if (existingWrapper) existingWrapper.remove();
                const existingPanel = document.getElementById(OP_PANEL_ID);
                if (existingPanel) existingPanel.remove();

                opPanelWrapper = document.createElement("div");
                opPanelWrapper.id = OP_WRAPPER_ID;
                opPanelWrapper.setAttribute("data-testid", "hf-backup-op-overlay");
                opPanelWrapper.className = OP_WRAPPER_CLASS;
                opPanelWrapper.style.display = "none";

                opPanel = document.createElement("div");
                opPanel.id = OP_PANEL_ID;
                opPanel.className = OP_PANEL_CLASS;
                opPanel.style.display = "none";

                const header = document.createElement("div");
                header.className = "hf-backup-op-header";

                const headerTitle = document.createElement("div");
                headerTitle.className = "hf-backup-op-header-title";

                const headerIcon = document.createElement("i");
                headerIcon.className = "hf-backup-op-header-icon icon-[lucide--upload] size-4 shrink-0";
                headerIcon.style.color = "#3b82f6";

                const headerLabel = document.createElement("span");
                headerLabel.className = "hf-backup-op-header-label text-sm font-medium text-foreground truncate";
                headerLabel.textContent = "Backup Uploads";

                headerTitle.appendChild(headerIcon);
                headerTitle.appendChild(headerLabel);

                const controls = document.createElement("div");
                controls.className = "hf-backup-op-header-controls";

                const count = document.createElement("div");
                count.className = "hf-backup-op-count";
                count.textContent = "Active: 1";

                opCollapseBtn = document.createElement("button");
                opCollapseBtn.type = "button";
                opCollapseBtn.className = `${OP_BUTTON_ICON_CLASS} hf-backup-op-collapse`;
                opCollapseBtn.innerHTML = `<i class="icon-[lucide--chevron-up] size-4"></i>`;
                opCollapseBtn.title = "Collapse backup status";
                opCollapseBtn.setAttribute("aria-label", "Collapse backup status");
                opCollapseBtn.setAttribute("aria-expanded", "true");
                opCollapseBtn.addEventListener("click", (event) => {
                    event.stopPropagation();
                    setOperationPanelCollapsed(!opStatusPanelCollapsed);
                });

                const minimizeBtn = document.createElement("button");
                minimizeBtn.type = "button";
                minimizeBtn.className = `${OP_BUTTON_ICON_CLASS} hf-backup-op-minimize`;
                minimizeBtn.innerHTML = `<i class="icon-[lucide--x] size-4"></i>`;
                minimizeBtn.title = "Minimize backup status";
                minimizeBtn.setAttribute("aria-label", "Minimize backup status");
                minimizeBtn.addEventListener("click", () => {
                    if (opStatusHasRunning) {
                        setOperationPanelMinimized(true);
                    } else {
                        hideOperationStatusPanel();
                    }
                });

                controls.appendChild(count);
                controls.appendChild(opCollapseBtn);
                controls.appendChild(minimizeBtn);
                header.appendChild(headerTitle);
                header.appendChild(controls);

                const body = document.createElement("div");
                body.className = "hf-backup-op-body";
                applyNativeScrollbarClasses(body);

                const item = document.createElement("div");
                item.className = OP_ITEM_CLASS;

                const progressContainer = document.createElement("div");
                progressContainer.className = "hf-backup-op-progress-container";
                const progressBar = document.createElement("div");
                progressBar.className = "hf-backup-op-progress-bar indeterminate";
                progressContainer.appendChild(progressBar);
                item.appendChild(progressContainer);

                const leading = document.createElement("div");
                leading.className = "relative flex items-center gap-1";

                const iconWrap = document.createElement("div");
                iconWrap.className = "inline-flex h-6 w-6 items-center justify-center overflow-hidden rounded-[6px]";

                const stateIcon = document.createElement("i");
                stateIcon.className = "hf-backup-op-state-icon pi pi-spinner-dotted pi-spin inline-flex size-4 items-center justify-center text-sm leading-none text-primary-background";
                iconWrap.appendChild(stateIcon);
                leading.appendChild(iconWrap);

                const content = document.createElement("div");
                content.className = "hf-backup-op-content relative min-w-0 flex-1";

                const title = document.createElement("div");
                title.className = "hf-backup-op-title truncate opacity-90";

                const meta = document.createElement("div");
                meta.className = "hf-backup-op-meta";

                const detail = document.createElement("div");
                detail.className = "hf-backup-op-detail";
                meta.appendChild(detail);

                const error = document.createElement("div");
                error.className = "hf-backup-op-error";
                error.style.display = "none";

                content.appendChild(title);
                content.appendChild(meta);
                content.appendChild(error);

                const statusLower = document.createElement("div");
                statusLower.className = "hf-backup-op-status-lower";
                statusLower.textContent = "UPLOADING";
                statusLower.style.color = "#4aa3ff";

                item.appendChild(leading);
                item.appendChild(content);
                item.appendChild(statusLower);
                body.appendChild(item);

                const actions = document.createElement("div");
                actions.className = "hf-backup-op-actions";

                const dismissButton = document.createElement("button");
                dismissButton.type = "button";
                dismissButton.className = `${OP_BUTTON_BASE_CLASS} hf-backup-op-dismiss hf-backup-op-footer-btn bg-secondary text-foreground hover:bg-accent`;
                dismissButton.textContent = "Dismiss";
                dismissButton.onclick = () => {
                    hideOperationStatusPanel();
                };

                const refreshButton = document.createElement("button");
                refreshButton.type = "button";
                refreshButton.className = "hf-backup-op-refresh hf-backup-op-footer-btn bg-primary text-primary-foreground border-0 hover:bg-primary/90";
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
                        }, 500);
                        return;
                    }
                    setTimeout(() => {
                        refreshButton.textContent = originalLabel;
                        refreshButton.disabled = false;
                    }, 900);
                };

                actions.appendChild(dismissButton);
                actions.appendChild(refreshButton);

                opPanel.appendChild(header);
                opPanel.appendChild(body);
                opPanel.appendChild(actions);
                opPanelWrapper.appendChild(opPanel);

                updateOperationPanelPosition();
            }

            updateOperationPanelPosition();

            return {
                wrapper: opPanelWrapper,
                panel: opPanel,
                headerIcon: opPanel.querySelector(".hf-backup-op-header-icon"),
                headerLabel: opPanel.querySelector(".hf-backup-op-header-label"),
                countBadge: opPanel.querySelector(".hf-backup-op-count"),
                item: opPanel.querySelector(".hf-backup-op-item"),
                stateIcon: opPanel.querySelector(".hf-backup-op-state-icon"),
                title: opPanel.querySelector(".hf-backup-op-title"),
                detail: opPanel.querySelector(".hf-backup-op-detail"),
                error: opPanel.querySelector(".hf-backup-op-error"),
                statusLower: opPanel.querySelector(".hf-backup-op-status-lower"),
                progressBar: opPanel.querySelector(".hf-backup-op-progress-bar"),
                actions: opPanel.querySelector(".hf-backup-op-actions"),
                dismissBtn: opPanel.querySelector(".hf-backup-op-dismiss"),
                refreshBtn: opPanel.querySelector(".hf-backup-op-refresh"),
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

        const inferOperationMode = (mode, title = "") => {
            if (mode === "restore" || mode === "upload") return mode;
            return /restore|download/i.test(String(title || "")) ? "restore" : "upload";
        };

        const showOperationProgress = ({ mode, title, categories = [] }) => {
            clearOpStatusTimers();
            const refs = ensureOperationStatusPanel();
            const resolvedMode = inferOperationMode(mode, title);
            applyOperationModeHeader(refs, resolvedMode);

            opStatusHasEntries = true;
            opStatusHasRunning = true;
            opStatusPanelMinimized = false;

            if (refs.countBadge) {
                refs.countBadge.textContent = "Active: 1";
            }
            if (refs.title) {
                refs.title.textContent = title || (resolvedMode === "restore" ? "Backup restore in progress" : "Backup upload in progress");
                refs.title.title = refs.title.textContent;
            }
            if (refs.stateIcon) {
                refs.stateIcon.className = "hf-backup-op-state-icon pi pi-spinner-dotted pi-spin inline-flex size-4 items-center justify-center text-sm leading-none text-primary-background";
            }
            if (refs.statusLower) {
                refs.statusLower.textContent = resolvedMode === "restore" ? "DOWNLOADING" : "UPLOADING";
                refs.statusLower.style.color = "#4aa3ff";
            }
            if (refs.progressBar) {
                refs.progressBar.classList.add("indeterminate");
                refs.progressBar.style.width = "";
                refs.progressBar.style.backgroundColor = "#4aa3ff";
            }
            if (refs.error) {
                refs.error.textContent = "";
                refs.error.style.display = "none";
            }
            refs.item?.classList.remove("has-detail");
            refs.actions?.classList.remove("visible");

            if (!categories.length) {
                if (refs.detail) refs.detail.textContent = "Working...";
            } else {
                let index = 0;
                if (refs.detail) refs.detail.textContent = `Processing: ${categories[0]}`;
                if (categories.length > 1) {
                    opStatusRotateTimer = setInterval(() => {
                        index = (index + 1) % categories.length;
                        if (refs.detail) refs.detail.textContent = `Processing: ${categories[index]}`;
                    }, 1400);
                }
            }

            applyOperationPanelVisibility();
            publishBackupPanelState();
        };

        const showOperationDone = ({ mode, title, detail, showRefresh = true }) => {
            clearOpStatusTimers();
            const refs = ensureOperationStatusPanel();
            const resolvedMode = inferOperationMode(mode || opStatusMode, title);
            applyOperationModeHeader(refs, resolvedMode);

            opStatusHasEntries = true;
            opStatusHasRunning = false;
            opStatusPanelMinimized = false;

            if (refs.countBadge) {
                refs.countBadge.textContent = "Active: 0";
            }
            if (refs.title) {
                refs.title.textContent = title || "Operation complete.";
                refs.title.title = refs.title.textContent;
            }
            if (refs.detail) {
                refs.detail.textContent = detail || "";
            }
            if (refs.error) {
                refs.error.textContent = "";
                refs.error.style.display = "none";
            }
            refs.item?.classList.remove("has-detail");
            if (refs.stateIcon) {
                refs.stateIcon.className = "hf-backup-op-state-icon icon-[lucide--check-check] size-4 text-green-400";
            }
            if (refs.statusLower) {
                refs.statusLower.textContent = resolvedMode === "restore" ? "DOWNLOADED" : "UPLOADED";
                refs.statusLower.style.color = "#5bd98c";
            }
            if (refs.progressBar) {
                refs.progressBar.classList.remove("indeterminate");
                refs.progressBar.style.width = "100%";
                refs.progressBar.style.backgroundColor = "#5bd98c";
            }
            if (refs.dismissBtn) {
                refs.dismissBtn.style.display = "inline-flex";
            }
            if (refs.refreshBtn) {
                refs.refreshBtn.style.display = showRefresh ? "inline-flex" : "none";
                refs.refreshBtn.disabled = false;
                refs.refreshBtn.textContent = "Refresh";
            }
            refs.actions?.classList.add("visible");

            applyOperationPanelVisibility();
            publishBackupPanelState();
        };

        const showOperationError = ({ mode, title, detail }) => {
            clearOpStatusTimers();
            const refs = ensureOperationStatusPanel();
            const resolvedMode = inferOperationMode(mode || opStatusMode, title);
            applyOperationModeHeader(refs, resolvedMode);

            opStatusHasEntries = true;
            opStatusHasRunning = false;
            opStatusPanelMinimized = false;

            if (refs.countBadge) {
                refs.countBadge.textContent = "Active: 0";
            }
            if (refs.title) {
                refs.title.textContent = title || "Backup operation failed.";
                refs.title.title = refs.title.textContent;
            }
            if (refs.detail) {
                refs.detail.textContent = resolvedMode === "restore" ? "Restore failed" : "Upload failed";
            }
            if (refs.error) {
                refs.error.textContent = detail || "";
                refs.error.title = detail || "";
                refs.error.style.display = detail ? "block" : "none";
            }
            refs.item?.classList.toggle("has-detail", Boolean(detail));
            if (refs.stateIcon) {
                refs.stateIcon.className = "hf-backup-op-state-icon icon-[lucide--alert-circle] size-4 text-red-400";
            }
            if (refs.statusLower) {
                refs.statusLower.textContent = "FAILED";
                refs.statusLower.style.color = "#ff6b6b";
            }
            if (refs.progressBar) {
                refs.progressBar.classList.remove("indeterminate");
                refs.progressBar.style.width = "100%";
                refs.progressBar.style.backgroundColor = "#ff6b6b";
            }
            if (refs.dismissBtn) {
                refs.dismissBtn.style.display = "inline-flex";
            }
            if (refs.refreshBtn) {
                refs.refreshBtn.style.display = "none";
            }
            refs.actions?.classList.add("visible");

            applyOperationPanelVisibility();
            publishBackupPanelState();

            opStatusHideTimer = setTimeout(() => {
                hideOperationStatusPanel();
            }, OP_FAILED_TTL_MS);
        };

        registerGlobalAction("showBackupOperationProgress", (opts = {}) => showOperationProgress(opts));
        registerGlobalAction("showBackupOperationDone", (opts = {}) => showOperationDone(opts));
        registerGlobalAction("showBackupOperationError", (opts = {}) => showOperationError(opts));
        registerGlobalAction("hideBackupOperationPanel", () => hideOperationStatusPanel());
        publishBackupPanelState();

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

            // Repository configuration row (below header, above the panels)
            const repoConfigRow = document.createElement("div");
            Object.assign(repoConfigRow.style, {
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "0 24px 12px",
                flexWrap: "wrap",
            });

            const repoInputLabel = document.createElement("span");
            repoInputLabel.textContent = "Backup Repo:";
            repoInputLabel.style.fontSize = "14px";
            repoInputLabel.style.fontWeight = "600";
            repoInputLabel.style.color = "var(--input-text)";

            const repoInput = document.createElement("input");
            repoInput.type = "text";
            repoInput.placeholder = "username/repository-name or full Hugging Face URL";
            Object.assign(repoInput.style, {
                flex: "1",
                minWidth: "200px",
                height: "36px",
                background: "var(--comfy-input-bg, #222)",
                color: "var(--input-text, #fff)",
                border: `1px solid ${TEMPLATE_DIALOG_TOKENS.border}`,
                borderRadius: "8px",
                padding: "0 10px",
                fontSize: "13px",
            });

            // Initialize value from ComfyUI settings
            const currentRepoVal = app.ui.settings.getSettingValue("downloaderbackup.repo_name") || "";
            repoInput.value = currentRepoVal;

            const parseRepoName = (val) => {
                let clean = val.trim();
                if (!clean) return "";
                const match = clean.match(/(?:https?:\/\/)?(?:www\.)?huggingface\.co\/([^\/]+)\/([^\/\?\#]+)/);
                if (match && match[1] && match[2]) {
                    return `${match[1]}/${match[2]}`;
                }
                return clean;
            };

            const refreshRepoBtn = document.createElement("button");
            refreshRepoBtn.type = "button";
            refreshRepoBtn.title = "Save and refresh repository";
            refreshRepoBtn.innerHTML = "<i class=\"pi pi-refresh\"></i>";
            Object.assign(refreshRepoBtn.style, {
                width: "36px",
                height: "36px",
                borderRadius: "8px",
                border: "none",
                background: "var(--secondary-background, #333)",
                color: "var(--input-text)",
                cursor: "pointer",
                display: "grid",
                placeItems: "center",
                transition: "background-color 120ms ease",
            });
            refreshRepoBtn.onmouseenter = () => {
                refreshRepoBtn.style.background = "var(--secondary-background-hover)";
            };
            refreshRepoBtn.onmouseleave = () => {
                refreshRepoBtn.style.background = "var(--secondary-background)";
            };

            const createRepoBtn = createButton("Create new backup repo", "primary");
            createRepoBtn.style.height = "36px";
            createRepoBtn.style.fontSize = "13px";
            createRepoBtn.style.borderRadius = "8px";

            repoConfigRow.appendChild(repoInputLabel);
            repoConfigRow.appendChild(repoInput);
            repoConfigRow.appendChild(refreshRepoBtn);
            repoConfigRow.appendChild(createRepoBtn);
            panel.appendChild(repoConfigRow);

            // Runpod Warning Message container
            const runpodWarningRow = document.createElement("div");
            Object.assign(runpodWarningRow.style, {
                display: "none",
                fontSize: "12px",
                padding: "4px 24px 12px",
                lineHeight: "1.4",
            });
            panel.appendChild(runpodWarningRow);

            const updateRunpodWarning = (isRunpod, comfyuiBackupEnv, currentRepo) => {
                if (!isRunpod) {
                    runpodWarningRow.style.display = "none";
                    return;
                }

                const cleanedRepo = (currentRepo || "").trim();
                const cleanedEnv = (comfyuiBackupEnv || "").trim();

                runpodWarningRow.style.display = "block";
                runpodWarningRow.innerHTML = "";

                const warningContainer = document.createElement("div");
                Object.assign(warningContainer.style, {
                    background: "rgba(255, 165, 0, 0.15)",
                    border: "1px solid rgba(255, 165, 0, 0.3)",
                    borderRadius: "8px",
                    padding: "10px 14px",
                    color: "#ffd075",
                });

                const link = document.createElement("a");
                link.href = "https://console.runpod.io/user/secrets";
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                link.textContent = "RunPod User Secrets";
                Object.assign(link.style, {
                    color: "#4aa3ff",
                    textDecoration: "underline",
                    fontWeight: "bold",
                });

                if (!cleanedEnv) {
                    warningContainer.appendChild(document.createTextNode("RunPod environment detected: "));
                    warningContainer.appendChild(link);
                    warningContainer.appendChild(document.createTextNode(` is missing the 'COMFYUI_BACKUP' variable. Please create a new secret 'COMFYUI_BACKUP' with value '${cleanedRepo}' to ensure settings persist across pod restarts.`));
                } else if (cleanedEnv !== cleanedRepo) {
                    warningContainer.appendChild(document.createTextNode("RunPod environment detected: "));
                    warningContainer.appendChild(link);
                    warningContainer.appendChild(document.createTextNode(` 'COMFYUI_BACKUP' secret is currently set to '${cleanedEnv}', which differs from '${cleanedRepo}'. Please update the RunPod secret 'COMFYUI_BACKUP' to '${cleanedRepo}' to keep them in sync.`));
                } else {
                    // Correctly configured
                    Object.assign(warningContainer.style, {
                        background: "rgba(67, 192, 107, 0.12)",
                        border: "1px solid rgba(67, 192, 107, 0.25)",
                        color: "#a3ecc1",
                    });
                    warningContainer.textContent = `RunPod environment: 'COMFYUI_BACKUP' is correctly set to '${cleanedRepo}'.`;
                }

                runpodWarningRow.appendChild(warningContainer);
            };

            const body = document.createElement("div");
            Object.assign(body.style, {
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "14px",
                minHeight: "420px",
                overflow: "auto",
                padding: "8px 24px 0",
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
                const sizeLabel = formatSizeGb(sizeBytes);

                backupPanel.metaEl.innerHTML = "";

                if (!repoName) {
                    backupPanel.metaEl.style.display = "none";
                    return;
                }

                if (sizeLabel) {
                    const size = document.createElement("span");
                    size.textContent = `Size: ${sizeLabel}`;
                    backupPanel.metaEl.appendChild(size);
                    backupPanel.metaEl.style.display = "block";
                } else {
                    backupPanel.metaEl.style.display = "none";
                }
            };

            const updateActions = () => {
                const backupItems = getSelectedItems(backupState);
                const localItems = getSelectedItems(localState);
                const hasRepo = Boolean((repoInput.value || "").trim());

                const hasBackupSelection = backupSelectionTouched && backupItems.length > 0;
                backupDownloadAllBtn.textContent = hasBackupSelection
                    ? "↓ Download selected only"
                    : "↓ Download full backup";
                setBackupSelectionButtonsVisible(hasBackupSelection);
                backupDownloadAllBtn.disabled = busy || !hasRepo;
                backupDeleteSelectedBtn.disabled = busy || !hasRepo || backupItems.length === 0;
                backupClearSelectionBtn.disabled = busy || backupItems.length === 0;
                localAddSelectedBtn.disabled = busy || !hasRepo || localItems.length === 0;
                closeIconButton.disabled = busy;
                closeIconButton.style.opacity = busy ? "0.5" : "1";
                closeIconButton.style.cursor = busy ? "default" : "pointer";
                refreshRepoBtn.disabled = busy;
                createRepoBtn.disabled = busy;
                repoInput.disabled = busy;

                // Disable or enable all checkboxes in both trees depending on repo config status
                for (const cb of backupState.checkboxes.values()) {
                    cb.disabled = !hasRepo;
                }
                for (const cb of localState.checkboxes.values()) {
                    cb.disabled = !hasRepo;
                }
            };

            refreshRepoBtn.onclick = async () => {
                const rawVal = repoInput.value;
                const parsed = parseRepoName(rawVal);
                repoInput.value = parsed;
                if (!parsed) {
                    showToast("Repository name/path cannot be empty.", "error");
                    return;
                }
                setBusy(true, "Updating and verifying backup repository...");
                try {
                    app.ui.settings.setSettingValue("downloaderbackup.repo_name", parsed);
                    await loadTree();
                    showToast("Repository name updated and reloaded.", "success");
                } catch (e) {
                    showToast(`Failed to load repository: ${e.message || e}`, "error");
                } finally {
                    setBusy(false);
                }
            };

            createRepoBtn.onclick = () => {
                const modalOverlay = document.createElement("div");
                applyTemplateDialogOverlayStyle(modalOverlay, 10005);

                const modalPanel = document.createElement("div");
                applyTemplateDialogPanelStyle(modalPanel, {
                    minWidth: "360px",
                    maxWidth: "500px",
                    padding: "24px",
                    gap: "16px",
                });

                const modalTitle = document.createElement("div");
                modalTitle.textContent = "Create New Backup Repository";
                Object.assign(modalTitle.style, {
                    fontSize: "18px",
                    fontWeight: "600",
                    color: "var(--input-text)",
                });

                const modalDesc = document.createElement("div");
                modalDesc.textContent = "Enter a name for the new Hugging Face repository. A private repository will be created under your account.";
                Object.assign(modalDesc.style, {
                    fontSize: "13px",
                    color: "var(--descrip-text, #999)",
                    lineHeight: "1.4",
                });

                const modalInput = document.createElement("input");
                modalInput.type = "text";
                modalInput.placeholder = "e.g., my-backup or username/my-backup";
                Object.assign(modalInput.style, {
                    width: "100%",
                    height: "36px",
                    background: "var(--comfy-input-bg, #222)",
                    color: "var(--input-text, #fff)",
                    border: `1px solid ${TEMPLATE_DIALOG_TOKENS.border}`,
                    borderRadius: "8px",
                    padding: "0 10px",
                    fontSize: "13px",
                    boxSizing: "border-box",
                });

                const modalActions = document.createElement("div");
                Object.assign(modalActions.style, {
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "8px",
                    marginTop: "8px",
                });

                const cancelBtn = createButton("Cancel", "default");
                cancelBtn.onclick = () => modalOverlay.remove();

                const confirmBtn = createButton("Create", "primary");
                confirmBtn.onclick = async () => {
                    const name = modalInput.value;
                    const parsedName = parseRepoName(name);
                    if (!parsedName) {
                        showToast("Repository name cannot be empty.", "error");
                        return;
                    }
                    modalOverlay.remove();
                    setBusy(true, "Creating Hugging Face repository...");
                    try {
                        const res = await requestJson("/create_hf_backup_repo", {
                            method: "POST",
                            body: JSON.stringify({ repo_name: parsedName }),
                        });
                        
                        if (res.status === "ok" && res.repo_name) {
                            repoInput.value = res.repo_name;
                            app.ui.settings.setSettingValue("downloaderbackup.repo_name", res.repo_name);
                            showToast(`Repository created successfully: ${res.repo_name}`, "success");
                            await loadTree();
                        } else {
                            throw new Error(res.message || "Failed to create repository");
                        }
                    } catch (e) {
                        const errMsg = e.message || String(e);
                        
                        // Render modal dialog for the error so the link is clickable
                        const errOverlay = document.createElement("div");
                        applyTemplateDialogOverlayStyle(errOverlay, 10005);
                        const errPanel = document.createElement("div");
                        applyTemplateDialogPanelStyle(errPanel, {
                            minWidth: "320px",
                            maxWidth: "520px",
                            padding: "20px",
                            gap: "12px",
                        });
                        
                        const title = document.createElement("div");
                        title.textContent = "Repository Creation Failed";
                        title.style.fontSize = "16px";
                        title.style.fontWeight = "bold";
                        title.style.color = "#ff6b6b";
                        
                        const desc = document.createElement("div");
                        desc.style.fontSize = "13px";
                        desc.style.lineHeight = "1.4";
                        
                        if (errMsg.includes("settings/tokens") || errMsg.includes("Write") || errMsg.includes("token")) {
                            desc.innerHTML = `Permission denied. Your Hugging Face token may be invalid or missing 'Write' permissions.<br/><br/>Please create a new token with <strong>Write</strong> permissions at <a href="https://huggingface.co/settings/tokens" target="_blank" style="color: var(--primary-color, #4aa3ff); text-decoration: underline;">huggingface.co/settings/tokens</a> and configure it in your ComfyUI settings under HuggingFace Downloader.`;
                        } else {
                            desc.textContent = errMsg;
                        }
                        
                        const closeBtn = createButton("Close", "default");
                        closeBtn.onclick = () => errOverlay.remove();
                        const actionRow = document.createElement("div");
                        actionRow.style.display = "flex";
                        actionRow.style.justifyContent = "flex-end";
                        actionRow.appendChild(closeBtn);
                        
                        errPanel.appendChild(title);
                        errPanel.appendChild(desc);
                        errPanel.appendChild(actionRow);
                        errOverlay.appendChild(errPanel);
                        document.body.appendChild(errOverlay);
                    } finally {
                        setBusy(false);
                    }
                };

                modalActions.appendChild(cancelBtn);
                modalActions.appendChild(confirmBtn);
                modalPanel.appendChild(modalTitle);
                modalPanel.appendChild(modalDesc);
                modalPanel.appendChild(modalInput);
                modalPanel.appendChild(modalActions);
                modalOverlay.appendChild(modalPanel);
                document.body.appendChild(modalOverlay);
                modalInput.focus();
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

                const repoVal = repoInput ? parseRepoName(repoInput.value) : "";
                const url = repoVal ? `/backup_browser_tree?repo_name=${encodeURIComponent(repoVal)}` : "/backup_browser_tree";
                const payload = await requestJson(url);

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
                updateRunpodWarning(payload.is_runpod, payload.comfyui_backup_env, payload.repo_name);

                if (payload.backup_error) {
                    backupPanel.errorEl.style.display = "block";
                    if (payload.backup_error.includes("401") || payload.backup_error.includes("403") || payload.backup_error.includes("token")) {
                        backupPanel.errorEl.innerHTML = `Failed to access backup repository. Check your token permissions.<br/>Create a 'Write' token at <a href="https://huggingface.co/settings/tokens" target="_blank" style="color: #4aa3ff; text-decoration: underline;">huggingface.co/settings/tokens</a>.`;
                    } else {
                        backupPanel.errorEl.textContent = payload.backup_error;
                    }
                }

                updateActions();
            };

            backupDownloadAllBtn.onclick = async () => {
                const items = getSelectedItems(backupState);
                if (backupSelectionTouched && items.length) {
                    try {
                        showOperationProgress({
                            mode: "restore",
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
                            mode: "restore",
                            title: "Backup restore complete",
                            detail: `Restored ${restoredFiles} file(s).`,
                            showRefresh: true,
                        });
                        if (result.restart_required) {
                            showRestartDialog();
                        }
                    } catch (e) {
                        showOperationError({
                            mode: "restore",
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
                        mode: "restore",
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
                        mode: "restore",
                        title: "Backup restore complete",
                        detail: "Restored backup items.",
                        showRefresh: true,
                    });
                    if (result.restart_required) {
                        showRestartDialog();
                    }
                } catch (e) {
                    showOperationError({
                        mode: "restore",
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
                        mode: "upload",
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
                        mode: "upload",
                        title: "Backup upload complete",
                        detail: `Uploaded ${uploaded} item(s).`,
                        showRefresh: true,
                    });
                } catch (e) {
                    showOperationError({
                        mode: "upload",
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
