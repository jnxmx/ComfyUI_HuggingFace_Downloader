import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "hfDownloaderStatusPanel",
    setup() {
        const PANEL_ID = "hf-downloader-panel";
        const STYLE_ID = "hf-downloader-panel-styles";
        const POLL_INTERVAL_MS = 1000;
        const TERMINAL_TTL_MS = 120000;

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

        let panel = null;
        let listBody = null;
        let countBadge = null;
        let refreshBtn = null;
        let refreshBusy = false;
        let bootstrapDone = false;
        const dismissedSuccessIds = new Set();

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
                    return "Finalizing";
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

        const ensureStyles = () => {
            if (document.getElementById(STYLE_ID)) return;
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = `
                #${PANEL_ID} {
                    position: fixed;
                    right: 16px;
                    bottom: 16px;
                    width: 360px;
                    max-height: 55vh;
                    background: #1f2128;
                    border: 1px solid #3c3c3c;
                    border-radius: 10px;
                    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.55);
                    color: #ddd;
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
                    padding: 8px 10px;
                    background: #23252d;
                    border-bottom: 1px solid #333;
                    font-weight: 600;
                }
                #${PANEL_ID} .hf-downloader-count {
                    background: #3b3f4b;
                    padding: 2px 6px;
                    border-radius: 10px;
                    font-size: 11px;
                }
                #${PANEL_ID} .hf-downloader-body {
                    overflow-y: auto;
                    padding: 8px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                }
                #${PANEL_ID} .hf-downloader-item {
                    background: #1a1c22;
                    border: 1px solid #2d2f36;
                    border-radius: 6px;
                    padding: 6px;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                #${PANEL_ID} .hf-downloader-row {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                }
                #${PANEL_ID} .hf-downloader-name {
                    font-size: 12px;
                    font-weight: 600;
                    color: #e3e5ea;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    flex: 1;
                }
                #${PANEL_ID} .hf-downloader-cancel {
                    border: none;
                    background: #3a1f26;
                    color: #ff9da8;
                    width: 18px;
                    height: 18px;
                    border-radius: 50%;
                    line-height: 18px;
                    font-size: 12px;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                }
                #${PANEL_ID} .hf-downloader-cancel:hover {
                    background: #4d2730;
                    color: #ffc1c8;
                }
                #${PANEL_ID} .hf-downloader-cancel:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                #${PANEL_ID} .hf-downloader-progress {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                #${PANEL_ID} .hf-downloader-spinner {
                    width: 14px;
                    height: 14px;
                    border-radius: 50%;
                    border: 2px solid #2a2d36;
                    border-top-color: #4aa3ff;
                    animation: hf-downloader-spin 0.9s linear infinite;
                }
                #${PANEL_ID} .hf-downloader-spinner.hidden {
                    visibility: hidden;
                }
                #${PANEL_ID} .hf-downloader-spinner.idle {
                    animation: none;
                    border-top-color: #2a2d36;
                }
                @keyframes hf-downloader-spin {
                    to { transform: rotate(360deg); }
                }
                #${PANEL_ID} .hf-downloader-meta {
                    font-size: 11px;
                    color: #aab1bc;
                    display: flex;
                    justify-content: space-between;
                    gap: 8px;
                }
                #${PANEL_ID} .hf-downloader-status-lower {
                    text-transform: uppercase;
                    letter-spacing: 0.3px;
                    font-weight: 600;
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
                    padding: 8px 10px;
                    border-top: 1px solid #333;
                    background: #20222a;
                }
                #${PANEL_ID} .hf-downloader-refresh {
                    border: 1px solid #3f8d4d;
                    background: #38a84f;
                    color: #fff;
                    border-radius: 6px;
                    padding: 6px 10px;
                    font-size: 12px;
                    cursor: pointer;
                    font-weight: 600;
                }
                #${PANEL_ID} .hf-downloader-refresh:hover {
                    background: #43b95c;
                }
                #${PANEL_ID} .hf-downloader-refresh:disabled {
                    opacity: 0.7;
                    cursor: not-allowed;
                }
            `;
            document.head.appendChild(style);
        };

        const ensurePanel = () => {
            if (panel) return panel;
            ensureStyles();

            panel = document.createElement("div");
            panel.id = PANEL_ID;

            const header = document.createElement("div");
            header.className = "hf-downloader-header";
            header.textContent = "Downloads";

            countBadge = document.createElement("div");
            countBadge.className = "hf-downloader-count";
            countBadge.textContent = "0";
            header.appendChild(countBadge);

            listBody = document.createElement("div");
            listBody.className = "hf-downloader-body";

            const footer = document.createElement("div");
            footer.className = "hf-downloader-footer";

            refreshBtn = document.createElement("button");
            refreshBtn.className = "hf-downloader-refresh";
            refreshBtn.textContent = "Refresh ComfyUI";
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

        const isDismissedSuccess = (entry) => {
            if (!dismissedSuccessIds.has(entry.id)) return false;
            return SUCCESS_STATUSES.has(entry.status);
        };

        const handleRefresh = async () => {
            if (refreshBusy || !refreshBtn) return;
            refreshBusy = true;
            refreshBtn.disabled = true;
            refreshBtn.textContent = "Refreshing...";

            // Hide all current successful entries; failed ones still reappear if verification fails later.
            if (listBody) {
                const cards = listBody.querySelectorAll("[data-download-id]");
                for (const card of cards) {
                    const id = card.getAttribute("data-download-id");
                    if (!id) continue;
                    dismissedSuccessIds.add(id);
                }
            }
            if (panel) {
                panel.style.display = "none";
            }

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
            } catch (err) {
                console.warn("[HF Downloader] Comfy refresh hook failed:", err);
            } finally {
                // Force refresh to reload node definitions from backend.
                window.location.reload();
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
                if (entry.status === "failed" || entry.status === "cancelled") {
                    const ts = (entry.finished_at || entry.updated_at || entry.started_at || 0) * 1000;
                    if (ts && (now - ts) > TERMINAL_TTL_MS) {
                        entry._expired = true;
                    }
                }
                if (entry.status === "failed") {
                    dismissedSuccessIds.delete(entry.id);
                }
            }

            if (!bootstrapDone) {
                const hasActiveOrFailed = rawEntries.some((entry) => (
                    RUNNING_STATUSES.has(entry.status) || entry.status === "failed"
                ));
                if (!hasActiveOrFailed) {
                    for (const entry of rawEntries) {
                        if (SUCCESS_STATUSES.has(entry.status)) {
                            dismissedSuccessIds.add(entry.id);
                        }
                    }
                }
                bootstrapDone = true;
            }

            const entries = rawEntries.filter((entry) => !entry._expired && !isDismissedSuccess(entry));

            if (!entries.length) {
                if (panel) panel.style.display = "none";
                return;
            }

            ensurePanel();
            panel.style.display = "flex";
            listBody.innerHTML = "";

            const runningCount = entries.filter((entry) => RUNNING_STATUSES.has(entry.status)).length;
            countBadge.textContent = String(runningCount);

            const hasFailed = entries.some((entry) => entry.status === "failed");
            const hasRunning = entries.some((entry) => RUNNING_STATUSES.has(entry.status));
            const hasSuccess = entries.some((entry) => SUCCESS_STATUSES.has(entry.status));

            refreshBtn.style.display = (!hasRunning && !hasFailed && hasSuccess) ? "inline-flex" : "none";
            if (refreshBtn.style.display === "none") {
                refreshBtn.disabled = false;
                refreshBtn.textContent = "Refresh ComfyUI";
                refreshBusy = false;
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

            for (const info of entries) {
                const item = document.createElement("div");
                item.className = "hf-downloader-item";
                item.setAttribute("data-download-id", info.id);

                const row = document.createElement("div");
                row.className = "hf-downloader-row";

                const name = document.createElement("div");
                name.className = "hf-downloader-name";
                name.textContent = info.filename || info.id || "unknown";
                name.title = name.textContent;
                row.appendChild(name);

                if (CAN_CANCEL_STATUSES.has(info.status)) {
                    const cancelBtn = document.createElement("button");
                    cancelBtn.className = "hf-downloader-cancel";
                    cancelBtn.textContent = "x";
                    cancelBtn.title = "Cancel download";
                    cancelBtn.addEventListener("click", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        cancelBtn.disabled = true;
                        void cancelDownload(info.id);
                    });
                    row.appendChild(cancelBtn);
                }

                const progress = document.createElement("div");
                progress.className = "hf-downloader-progress";

                const spinner = document.createElement("div");
                spinner.className = "hf-downloader-spinner";
                if (info.status === "queued" || info.status === "downloaded" || info.status === "cancelled") {
                    spinner.classList.add("hidden");
                } else if (info.status === "failed") {
                    spinner.classList.add("idle");
                    spinner.style.borderTopColor = "#ff6b6b";
                }
                progress.appendChild(spinner);

                const meta = document.createElement("div");
                meta.className = "hf-downloader-meta";

                const totalBytes = info.total_bytes || 0;
                const downloadedBytes = info.downloaded_bytes || 0;
                const sizeText = totalBytes
                    ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
                    : formatBytes(downloadedBytes);

                const leftMeta = document.createElement("div");
                leftMeta.textContent = sizeText;

                const rightMeta = document.createElement("div");
                rightMeta.className = "hf-downloader-status-lower";
                rightMeta.textContent = statusLabel(info.status);
                rightMeta.style.color = statusColor(info.status);

                meta.appendChild(leftMeta);
                meta.appendChild(rightMeta);

                item.appendChild(row);
                item.appendChild(progress);
                item.appendChild(meta);

                if (info.error) {
                    const err = document.createElement("div");
                    err.className = "hf-downloader-error";
                    err.textContent = info.error;
                    err.title = info.error;
                    item.appendChild(err);
                }

                listBody.appendChild(item);
            }
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

        pollStatus();
        setInterval(pollStatus, POLL_INTERVAL_MS);
    }
});
