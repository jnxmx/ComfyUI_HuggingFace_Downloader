import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "hfDownloaderStatusPanel",
    setup() {
        const PANEL_ID = "hf-downloader-panel";
        const STYLE_ID = "hf-downloader-panel-styles";
        const POLL_INTERVAL_MS = 1000;
        const FAILED_TTL_MS = 120000;
        const CANCELLED_TTL_MS = 1500;

        const RUNNING_STATUSES = new Set([
            "queued",
            "downloading",
            "copying",
            "cleaning_cache",
            "finalizing",
            "cancelling"
        ]);
        const CAN_CANCEL_STATUSES = new Set([
            "queued",
            "downloading",
            "copying",
            "cleaning_cache",
            "finalizing",
            "cancelling"
        ]);
        const SUCCESS_STATUSES = new Set(["downloaded", "completed", "verifying"]);

        const dismissedEntryIds = new Set();
        const itemNodes = new Map();

        let panel = null;
        let listBody = null;
        let countBadge = null;
        let minimizeBtn = null;
        let refreshBtn = null;
        let refreshBusy = false;
        let bootstrapDone = false;
        let panelMinimized = false;
        let lastVisibleCount = 0;
        let lastHasRunning = false;

        const PANEL_RIGHT_MARGIN = 16;
        const PANEL_TOP_MARGIN = 10;

        const registerGlobalAction = (name, action) => {
            if (typeof window === "undefined") return;
            if (!window.hfDownloader) {
                window.hfDownloader = {};
            }
            window.hfDownloader[name] = action;
        };

        const getPanelState = () => ({
            minimized: panelMinimized,
            hasRunning: lastHasRunning,
            hasEntries: lastVisibleCount > 0
        });

        const publishPanelState = () => {
            if (typeof window === "undefined") return;
            if (!window.hfDownloader) {
                window.hfDownloader = {};
            }
            const state = getPanelState();
            window.hfDownloader.downloadPanelState = state;
            window.dispatchEvent(new CustomEvent("hfDownloader:panelState", { detail: state }));
        };

        const applyPanelVisibility = () => {
            if (!panel) return;
            if (!lastVisibleCount || panelMinimized) {
                panel.style.display = "none";
            } else {
                panel.style.display = "flex";
            }
        };

        const setPanelMinimized = (value) => {
            panelMinimized = Boolean(value);
            applyPanelVisibility();
            publishPanelState();
        };

        registerGlobalAction("restoreDownloadPanel", () => {
            setPanelMinimized(false);
            updatePanelPosition();
        });
        registerGlobalAction("minimizeDownloadPanel", () => {
            setPanelMinimized(true);
        });
        registerGlobalAction("toggleDownloadPanel", () => {
            setPanelMinimized(!panelMinimized);
        });
        registerGlobalAction("getDownloadPanelState", () => getPanelState());

        const toUiStatus = (status) => {
            if (status === "verifying" || status === "completed") return "downloaded";
            return status || "queued";
        };

        const statusLabel = (status) => {
            switch (status) {
                case "queued":
                    return "Queued";
                case "downloading":
                    return "Downloading";
                case "copying":
                    return "Copying";
                case "cleaning_cache":
                case "finalizing":
                    return "Finalizing";
                case "downloaded":
                    return "Downloaded";
                case "failed":
                    return "Failed";
                case "cancelled":
                    return "Cancelled";
                case "cancelling":
                    return "Cancelling";
                default:
                    return "Queued";
            }
        };

        const statusColor = (status) => {
            switch (status) {
                case "downloading":
                    return "#4aa3ff";
                case "copying":
                case "cleaning_cache":
                case "finalizing":
                    return "#9ad6ff";
                case "downloaded":
                    return "#5bd98c";
                case "failed":
                    return "#ff6b6b";
                case "cancelled":
                case "cancelling":
                    return "#f5b14c";
                default:
                    return "#9aa1ad";
            }
        };

        const resolveStatusText = (info) => {
            const phase = String(info?.phase || "").trim();
            if (!phase) {
                return statusLabel(info?.status);
            }

            const phaseLower = phase.toLowerCase();
            const genericPhases = new Set([
                "queued",
                "downloading",
                "copying",
                "cleaning_cache",
                "finalizing",
                "downloaded",
                "failed",
                "cancelled",
                "cancelling",
                "verifying",
                "completed"
            ]);
            if (genericPhases.has(phaseLower)) {
                return statusLabel(info?.status);
            }
            return phase;
        };

        const ensureStyles = () => {
            if (document.getElementById(STYLE_ID)) return;

            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = `
                #${PANEL_ID} {
                    position: fixed;
                    right: 16px;
                    top: 16px;
                    width: 380px;
                    max-height: 60vh;
                    background: var(--comfy-input-bg, var(--comfy-menu-bg, var(--p-surface-900, #141922)));
                    border: 1px solid var(--border-color, var(--p-content-border-color, #3c4452));
                    border-radius: 14px;
                    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.55);
                    color: var(--fg-color, var(--p-text-color, #ddd));
                    font-size: 12px;
                    z-index: 10000;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                #${PANEL_ID} .hf-downloader-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 8px 12px;
                    border-bottom: 1px solid var(--border-color, var(--p-content-border-color, #333));
                    background: transparent;
                }
                #${PANEL_ID} .hf-downloader-header-title {
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--input-text, var(--p-text-color, #e5e7eb));
                }
                #${PANEL_ID} .hf-downloader-header-controls {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                }
                #${PANEL_ID} .hf-downloader-count {
                    background: var(--secondary-background, var(--p-surface-800, #3b3f4b));
                    color: var(--input-text, var(--p-text-color, #e5e7eb));
                    padding: 2px 8px;
                    border-radius: 999px;
                    font-size: 11px;
                    font-weight: 700;
                }
                #${PANEL_ID} .hf-downloader-minimize {
                    border: none;
                    background: transparent;
                    color: var(--descrip-text, var(--p-text-muted-color, #aab1bc));
                    width: 24px;
                    height: 24px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 18px;
                    line-height: 1;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                }
                #${PANEL_ID} .hf-downloader-minimize:hover {
                    background: var(--secondary-background-hover, var(--p-surface-700, #2d3240));
                    color: var(--input-text, var(--p-text-color, #e5e7eb));
                }
                #${PANEL_ID} .hf-downloader-body {
                    overflow-y: auto;
                    padding: 6px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                }
                #${PANEL_ID} .hf-downloader-item {
                    background: var(--secondary-background, var(--p-surface-800, #2f323a));
                    border: none;
                    border-radius: 12px;
                    min-height: 84px;
                    box-sizing: border-box;
                    padding: 10px 8px 8px 12px;
                    position: relative;
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    gap: 4px;
                    transition: background-color 140ms ease-in-out;
                }
                #${PANEL_ID} .hf-downloader-item:hover {
                    background: var(--secondary-background-hover, var(--p-surface-700, #3a3f48));
                }
                #${PANEL_ID} .hf-downloader-row {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 6px;
                    padding-right: 38px;
                }
                #${PANEL_ID} .hf-downloader-name {
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--input-text, var(--p-text-color, #e3e5ea));
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    flex: 1;
                    opacity: 0.95;
                }
                #${PANEL_ID} .hf-downloader-cancel {
                    border: none;
                    background: var(--destructive-background, #e25252);
                    color: #fff;
                    width: 36px;
                    height: 36px;
                    border-radius: 12px;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity 140ms ease-in-out, transform 140ms ease-in-out, background-color 120ms ease-in-out;
                    transform: translateY(2px);
                    flex: 0 0 36px;
                    position: absolute;
                    right: 6px;
                    top: 6px;
                }
                #${PANEL_ID} .hf-downloader-cancel i {
                    font-size: 14px;
                    line-height: 1;
                }
                #${PANEL_ID} .hf-downloader-item:hover .hf-downloader-cancel,
                #${PANEL_ID} .hf-downloader-cancel:focus-visible {
                    opacity: 1;
                    pointer-events: auto;
                    transform: translateY(0);
                }
                #${PANEL_ID} .hf-downloader-cancel:hover {
                    background: var(--destructive-background-hover, #f06464);
                }
                #${PANEL_ID} .hf-downloader-cancel:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                    pointer-events: none;
                }
                #${PANEL_ID} .hf-downloader-meta {
                    font-size: 12px;
                    color: var(--descrip-text, var(--p-text-muted-color, #aab1bc));
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                }
                #${PANEL_ID} .hf-downloader-size {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                #${PANEL_ID} .hf-downloader-spinner {
                    width: 13px;
                    height: 13px;
                    border-radius: 50%;
                    border: 2px solid var(--secondary-background-hover, #2a2d36);
                    border-top-color: #4aa3ff;
                    border-right-color: #4aa3ff;
                    animation: hf-downloader-spin 0.9s linear infinite;
                    flex: 0 0 auto;
                }
                #${PANEL_ID} .hf-downloader-spinner.hidden {
                    visibility: hidden;
                }
                @keyframes hf-downloader-spin {
                    to { transform: rotate(360deg); }
                }
                #${PANEL_ID} .hf-downloader-status-lower {
                    font-weight: 600;
                    letter-spacing: 0.01em;
                    white-space: nowrap;
                    flex: 0 0 auto;
                }
                #${PANEL_ID} .hf-downloader-item.can-cancel:hover .hf-downloader-status-lower {
                    display: none;
                }
                #${PANEL_ID} .hf-downloader-error {
                    color: #ff6b6b;
                    font-size: 11px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                #${PANEL_ID} .hf-downloader-footer {
                    display: flex;
                    justify-content: flex-end;
                    padding: 8px 12px;
                    border-top: 1px solid var(--border-color, var(--p-content-border-color, #333));
                    background: transparent;
                }
                #${PANEL_ID} .hf-downloader-refresh {
                    border: 1px solid var(--border-color, var(--p-content-border-color, #4b5563));
                    background: var(--secondary-background, var(--p-surface-800, #2f323a));
                    color: var(--input-text, var(--p-text-color, #e5e7eb));
                    border-radius: 8px;
                    padding: 7px 12px;
                    font-size: 13px;
                    line-height: 1.2;
                    font-weight: 600;
                    min-height: 32px;
                    cursor: pointer;
                }
                #${PANEL_ID} .hf-downloader-refresh:hover {
                    background: var(--secondary-background-hover, var(--p-surface-700, #3a3f48));
                }
                #${PANEL_ID} .hf-downloader-refresh:disabled {
                    opacity: 0.7;
                    cursor: not-allowed;
                }
            `;
            document.head.appendChild(style);
        };

        const getTopAnchor = () => {
            const appAnchor = app?.menu?.settingsGroup?.element?.parentElement;
            if (appAnchor?.getBoundingClientRect) return appAnchor;

            const selectors = [
                ".comfyui-menu-bar",
                ".comfyui-menu",
                ".comfyui-header",
                ".p-menubar",
                "header"
            ];
            for (const selector of selectors) {
                const el = document.querySelector(selector);
                if (el?.getBoundingClientRect) return el;
            }
            return null;
        };

        const updatePanelPosition = () => {
            if (!panel) return;

            const anchor = getTopAnchor();
            let top = 16;
            if (anchor) {
                const rect = anchor.getBoundingClientRect();
                if (Number.isFinite(rect.bottom)) {
                    top = Math.max(8, Math.round(rect.bottom + PANEL_TOP_MARGIN));
                }
            }

            panel.style.top = `${top}px`;
            panel.style.right = `${PANEL_RIGHT_MARGIN}px`;
            panel.style.bottom = "auto";
            panel.style.left = "auto";
            panel.style.maxHeight = `calc(100vh - ${top + 16}px)`;
        };

        const ensurePanel = () => {
            if (panel) return panel;
            ensureStyles();

            panel = document.createElement("div");
            panel.id = PANEL_ID;

            const header = document.createElement("div");
            header.className = "hf-downloader-header";

            const title = document.createElement("div");
            title.className = "hf-downloader-header-title";
            title.textContent = "Downloads";

            const controls = document.createElement("div");
            controls.className = "hf-downloader-header-controls";

            countBadge = document.createElement("div");
            countBadge.className = "hf-downloader-count";
            countBadge.textContent = "0";

            minimizeBtn = document.createElement("button");
            minimizeBtn.type = "button";
            minimizeBtn.className = "hf-downloader-minimize";
            minimizeBtn.textContent = "−";
            minimizeBtn.title = "Minimize downloads";
            minimizeBtn.addEventListener("click", () => {
                setPanelMinimized(true);
            });

            controls.appendChild(countBadge);
            controls.appendChild(minimizeBtn);
            header.appendChild(title);
            header.appendChild(controls);

            listBody = document.createElement("div");
            listBody.className = "hf-downloader-body";

            const footer = document.createElement("div");
            footer.className = "hf-downloader-footer";

            refreshBtn = document.createElement("button");
            refreshBtn.className = "hf-downloader-refresh";
            refreshBtn.textContent = "Refresh";
            refreshBtn.style.display = "none";
            refreshBtn.addEventListener("click", () => {
                void handleRefresh();
            });
            footer.appendChild(refreshBtn);

            panel.appendChild(header);
            panel.appendChild(listBody);
            panel.appendChild(footer);
            panel.style.display = "none";
            document.body.appendChild(panel);
            updatePanelPosition();

            return panel;
        };

        const formatBytes = (value) => {
            if (value === null || value === undefined) return "--";
            const units = ["B", "KB", "MB", "GB", "TB"];
            let size = value;
            let unitIndex = 0;
            while (size >= 1024 && unitIndex < units.length - 1) {
                size /= 1024;
                unitIndex += 1;
            }
            const decimals = size >= 10 || unitIndex === 0 ? 0 : 1;
            return `${size.toFixed(decimals)} ${units[unitIndex]}`;
        };

        const cancelDownload = async (downloadId) => {
            if (!downloadId) return;
            try {
                await fetch("/cancel_download", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ download_id: downloadId })
                });
            } catch (err) {
                console.warn("[HF Downloader] Failed to cancel download:", err);
            }
        };

        const isDismissedEntry = (entry) => {
            if (!dismissedEntryIds.has(entry.id)) return false;
            return SUCCESS_STATUSES.has(entry.status) || entry.status === "cancelled";
        };

        const entryTimestampMs = (entry) => {
            return (
                (entry.finished_at || entry.updated_at || entry.started_at || entry.queued_at || 0) * 1000
            );
        };

        const createItemNode = () => {
            const item = document.createElement("div");
            item.className = "hf-downloader-item";

            const row = document.createElement("div");
            row.className = "hf-downloader-row";

            const name = document.createElement("div");
            name.className = "hf-downloader-name";

            const cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className = "hf-downloader-cancel";
            cancelBtn.title = "Cancel download";
            cancelBtn.innerHTML = "<i class=\"pi pi-trash\"></i>";
            cancelBtn.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                cancelBtn.disabled = true;
                const downloadId = item.getAttribute("data-download-id");
                void cancelDownload(downloadId);
            });

            row.appendChild(name);
            row.appendChild(cancelBtn);

            const meta = document.createElement("div");
            meta.className = "hf-downloader-meta";

            const sizeWrap = document.createElement("div");
            sizeWrap.className = "hf-downloader-size";

            const spinner = document.createElement("div");
            spinner.className = "hf-downloader-spinner";

            const sizeText = document.createElement("div");
            sizeText.className = "hf-downloader-size-text";

            sizeWrap.appendChild(spinner);
            sizeWrap.appendChild(sizeText);

            const status = document.createElement("div");
            status.className = "hf-downloader-status-lower";

            meta.appendChild(sizeWrap);
            meta.appendChild(status);

            const error = document.createElement("div");
            error.className = "hf-downloader-error";
            error.style.display = "none";

            item.appendChild(row);
            item.appendChild(meta);
            item.appendChild(error);

            return {
                root: item,
                name,
                cancelBtn,
                spinner,
                sizeText,
                status,
                error
            };
        };

        const updateItemNode = (refs, info) => {
            refs.root.setAttribute("data-download-id", info.id);

            const rawName = String(info.filename || info.id || "unknown").replace(/\/+$/, "");
            refs.name.textContent = rawName;
            refs.name.title = rawName;
            if (String(info.download_mode || "").toLowerCase() === "folder") {
                refs.name.style.color = "#f5b14c";
            } else {
                refs.name.style.color = "var(--input-text, #e3e5ea)";
            }

            const canCancel = CAN_CANCEL_STATUSES.has(info.status);
            refs.root.classList.toggle("can-cancel", canCancel);
            refs.cancelBtn.style.display = canCancel ? "inline-flex" : "none";
            if (!canCancel) {
                refs.cancelBtn.disabled = false;
            }

            const totalBytes = info.total_bytes || 0;
            const downloadedBytes = info.downloaded_bytes || 0;
            refs.sizeText.textContent = totalBytes
                ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
                : formatBytes(downloadedBytes);

            const shouldSpin = RUNNING_STATUSES.has(info.status) && info.status !== "queued";
            refs.spinner.classList.toggle("hidden", !shouldSpin);

            refs.status.textContent = resolveStatusText(info);
            refs.status.style.color = statusColor(info.status);

            const errorText = String(info.error || "").trim();
            if (errorText) {
                refs.error.textContent = errorText;
                refs.error.title = errorText;
                refs.error.style.display = "block";
            } else {
                refs.error.textContent = "";
                refs.error.title = "";
                refs.error.style.display = "none";
            }
        };

        const handleRefresh = async () => {
            if (refreshBusy || !refreshBtn) return;
            refreshBusy = true;
            refreshBtn.disabled = true;
            refreshBtn.textContent = "Refreshing...";

            const justCompletedIds = [];
            if (listBody) {
                const cards = listBody.querySelectorAll("[data-download-id]");
                for (const card of cards) {
                    const id = card.getAttribute("data-download-id");
                    if (id) justCompletedIds.push(id);
                }
            }

            let refreshSucceeded = false;
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
                refreshSucceeded = true;
            } catch (err) {
                console.warn("[HF Downloader] Comfy refresh hook failed:", err);
            } finally {
                if (refreshSucceeded) {
                    for (const id of justCompletedIds) {
                        dismissedEntryIds.add(id);
                    }
                }
                refreshBusy = false;
                if (refreshBtn) {
                    refreshBtn.disabled = false;
                    refreshBtn.textContent = "Refresh";
                }
            }
        };

        const renderList = (downloads) => {
            const now = Date.now();
            const rawEntries = Object.entries(downloads || {}).map(([id, info]) => ({
                id,
                ...(info || {})
            }));

            for (const entry of rawEntries) {
                entry.status = toUiStatus(entry.status);

                if (entry.status === "failed") {
                    const ts = entryTimestampMs(entry);
                    if (ts && (now - ts) > FAILED_TTL_MS) {
                        entry._expired = true;
                    }
                    dismissedEntryIds.delete(entry.id);
                }

                if (entry.status === "cancelled") {
                    const ts = entryTimestampMs(entry);
                    if (!ts || (now - ts) > CANCELLED_TTL_MS) {
                        dismissedEntryIds.add(entry.id);
                        entry._expired = true;
                    }
                }
            }

            if (!bootstrapDone) {
                const hasActiveOrFailed = rawEntries.some(
                    (entry) => RUNNING_STATUSES.has(entry.status) || entry.status === "failed"
                );
                if (!hasActiveOrFailed) {
                    for (const entry of rawEntries) {
                        if (SUCCESS_STATUSES.has(entry.status) || entry.status === "cancelled") {
                            dismissedEntryIds.add(entry.id);
                        }
                    }
                }
                bootstrapDone = true;
            }

            const entries = rawEntries.filter((entry) => !entry._expired && !isDismissedEntry(entry));

            if (!entries.length) {
                if (listBody) listBody.replaceChildren();
                itemNodes.clear();
                panelMinimized = false;
                lastVisibleCount = 0;
                lastHasRunning = false;
                applyPanelVisibility();
                publishPanelState();
                return;
            }

            ensurePanel();
            updatePanelPosition();

            const runningCount = entries.filter((entry) => RUNNING_STATUSES.has(entry.status)).length;
            if (countBadge) {
                countBadge.textContent = String(runningCount);
            }

            const hasFailed = entries.some((entry) => entry.status === "failed");
            const hasRunning = runningCount > 0;
            const hasSuccess = entries.some((entry) => SUCCESS_STATUSES.has(entry.status));
            if (refreshBtn) {
                refreshBtn.style.display = (!hasRunning && !hasFailed && hasSuccess) ? "inline-flex" : "none";
                if (refreshBtn.style.display === "none") {
                    refreshBtn.disabled = false;
                    refreshBtn.textContent = "Refresh";
                    refreshBusy = false;
                }
            }

            const order = {
                failed: 0,
                downloading: 1,
                copying: 2,
                cleaning_cache: 3,
                finalizing: 4,
                queued: 5,
                cancelling: 6,
                downloaded: 7,
                cancelled: 8
            };

            entries.sort((a, b) => {
                const aOrder = order[a.status] ?? 99;
                const bOrder = order[b.status] ?? 99;
                if (aOrder !== bOrder) return aOrder - bOrder;
                const aTime = a.started_at || a.queued_at || 0;
                const bTime = b.started_at || b.queued_at || 0;
                return aTime - bTime;
            });

            const idsInOrder = entries.map((entry) => entry.id);
            const idsSet = new Set(idsInOrder);

            for (const [id, refs] of itemNodes.entries()) {
                if (!idsSet.has(id)) {
                    refs.root.remove();
                    itemNodes.delete(id);
                }
            }

            for (const info of entries) {
                let refs = itemNodes.get(info.id);
                if (!refs) {
                    refs = createItemNode();
                    itemNodes.set(info.id, refs);
                }
                updateItemNode(refs, info);
            }

            const currentOrder = listBody
                ? Array.from(listBody.children).map((child) => child.getAttribute("data-download-id"))
                : [];
            let needsReorder = currentOrder.length !== idsInOrder.length;
            if (!needsReorder) {
                for (let i = 0; i < idsInOrder.length; i += 1) {
                    if (currentOrder[i] !== idsInOrder[i]) {
                        needsReorder = true;
                        break;
                    }
                }
            }

            if (needsReorder && listBody) {
                const fragment = document.createDocumentFragment();
                for (const id of idsInOrder) {
                    const refs = itemNodes.get(id);
                    if (refs) fragment.appendChild(refs.root);
                }
                listBody.replaceChildren(fragment);
            }

            lastVisibleCount = entries.length;
            lastHasRunning = hasRunning;
            applyPanelVisibility();
            publishPanelState();
        };

        const pollStatus = async () => {
            try {
                const resp = await fetch("/download_status");
                if (resp.status !== 200) return;
                const data = await resp.json();
                renderList(data.downloads || {});
            } catch (err) {
                console.warn("[HF Downloader] Failed to fetch download status:", err);
            }
        };

        publishPanelState();
        pollStatus();
        setInterval(pollStatus, POLL_INTERVAL_MS);
        window.addEventListener("resize", updatePanelPosition, { passive: true });
        window.addEventListener("scroll", updatePanelPosition, { passive: true });
    }
});
