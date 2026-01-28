import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "hfDownloaderStatusPanel",
    setup() {
        const PANEL_ID = "hf-downloader-panel";
        const STYLE_ID = "hf-downloader-panel-styles";
        const POLL_INTERVAL_MS = 1000;
        const FINISHED_TTL_MS = 3000;
        const MAX_ATTACH_ATTEMPTS = 120;
        const QUEUE_ANCHOR_SELECTORS = [
            "#queue-panel",
            "#queue",
            ".queue-panel",
            ".queue-view",
            ".comfyui-queue",
            ".comfy-queue",
            "[data-testid='queue']"
        ];

        let panel = null;
        let listBody = null;
        let countBadge = null;
        let anchorEl = null;
        let attachAttempts = 0;

        const ensureStyles = () => {
            if (document.getElementById(STYLE_ID)) return;
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = `
                #${PANEL_ID} {
                    position: fixed;
                    top: 64px;
                    right: 12px;
                    width: 320px;
                    max-height: 50vh;
                    background: #1f2128;
                    border: 1px solid #3c3c3c;
                    border-radius: 8px;
                    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.5);
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
                    padding: 6px 8px 8px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                }
                #${PANEL_ID} .hf-downloader-empty {
                    color: #8f96a3;
                    font-style: italic;
                    padding: 6px 0;
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
                #${PANEL_ID} .hf-downloader-status {
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.4px;
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
                #${PANEL_ID} .hf-downloader-error {
                    color: #ff6b6b;
                    font-size: 11px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
            `;
            document.head.appendChild(style);
        };

        const findQueueAnchor = () => {
            for (const selector of QUEUE_ANCHOR_SELECTORS) {
                const el = document.querySelector(selector);
                if (el) return el;
            }
            return null;
        };

        const positionPanel = () => {
            if (!panel) return;
            const rect = anchorEl?.getBoundingClientRect();
            if (rect && rect.width) {
                const top = Math.round(rect.bottom + 8);
                const right = Math.max(8, Math.round(window.innerWidth - rect.right));
                panel.style.top = `${top}px`;
                panel.style.right = `${right}px`;
                return;
            }
            panel.style.top = "64px";
            panel.style.right = "12px";
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

            panel.appendChild(header);
            panel.appendChild(listBody);
            panel.style.display = "none";
            document.body.appendChild(panel);

            positionPanel();
            window.addEventListener("resize", positionPanel);

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

        const formatSpeed = (bps) => {
            if (!bps || !Number.isFinite(bps)) return "--";
            return `${formatBytes(bps)}/s`;
        };

        const statusColor = (status) => {
            switch (status) {
                case "downloading":
                    return "#4aa3ff";
                case "copying":
                case "cleaning_cache":
                case "downloaded":
                case "finalizing":
                    return "#9ad6ff";
                case "verifying":
                    return "#ffd166";
                case "completed":
                    return "#5bd98c";
                case "failed":
                    return "#ff6b6b";
                default:
                    return "#9aa1ad";
            }
        };

        const shouldDisplay = (info, now) => {
            if (!info) return false;
            if ((info.status === "completed" || info.status === "failed") && info.finished_at) {
                return (now - info.finished_at * 1000) <= FINISHED_TTL_MS;
            }
            return true;
        };

        const renderList = (downloads) => {
            const now = Date.now();

            const entries = Object.entries(downloads)
                .map(([id, info]) => ({ id, ...info }))
                .filter((entry) => shouldDisplay(entry, now));

            if (!entries.length) {
                if (panel) {
                    panel.style.display = "none";
                }
                return;
            }

            ensurePanel();
            panel.style.display = "flex";

            const activeStatuses = new Set([
                "queued",
                "downloading",
                "copying",
                "cleaning_cache",
                "verifying",
                "downloaded",
                "finalizing"
            ]);
            const activeCount = entries.filter((entry) => activeStatuses.has(entry.status)).length;
            countBadge.textContent = String(activeCount);

            listBody.innerHTML = "";

            const order = {
                downloading: 0,
                copying: 1,
                cleaning_cache: 2,
                verifying: 3,
                downloaded: 4,
                finalizing: 5,
                queued: 6,
                failed: 7,
                completed: 8
            };

            entries.sort((a, b) => {
                const aOrder = order[a.status] ?? 9;
                const bOrder = order[b.status] ?? 9;
                if (aOrder !== bOrder) return aOrder - bOrder;
                const aTime = a.started_at || a.queued_at || 0;
                const bTime = b.started_at || b.queued_at || 0;
                return aTime - bTime;
            });

            for (const info of entries) {
                const item = document.createElement("div");
                item.className = "hf-downloader-item";

                const row = document.createElement("div");
                row.className = "hf-downloader-row";

                const name = document.createElement("div");
                name.className = "hf-downloader-name";
                name.textContent = info.filename || info.id || "unknown";
                name.title = name.textContent;

                const status = document.createElement("div");
                status.className = "hf-downloader-status";
                status.textContent = info.status || "queued";
                status.style.color = statusColor(info.status);

                row.appendChild(name);
                row.appendChild(status);

                const progress = document.createElement("div");
                progress.className = "hf-downloader-progress";

                const spinner = document.createElement("div");
                spinner.className = "hf-downloader-spinner";
                if (info.status === "queued" || info.status === "downloaded") {
                    spinner.classList.add("hidden");
                } else if (info.status === "completed" || info.status === "failed") {
                    spinner.classList.add("idle");
                    spinner.style.borderTopColor = info.status === "failed" ? "#ff6b6b" : "#5bd98c";
                } else if (info.status === "verifying") {
                    spinner.style.borderTopColor = "#ffd166";
                }
                progress.appendChild(spinner);

                const meta = document.createElement("div");
                meta.className = "hf-downloader-meta";

                const totalBytes = info.total_bytes || 0;
                const downloadedBytes = info.downloaded_bytes || 0;
                const sizeText = totalBytes
                    ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
                    : formatBytes(downloadedBytes);

                const speedText = info.status === "downloading"
                    ? formatSpeed(info.speed_bps)
                    : "--";

                const leftMeta = document.createElement("div");
                leftMeta.textContent = sizeText;

                const rightMeta = document.createElement("div");
                rightMeta.textContent = speedText;

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

        const startPolling = () => {
            pollStatus();
            return setInterval(pollStatus, POLL_INTERVAL_MS);
        };

        const attachTimer = setInterval(() => {
            attachAttempts += 1;
            anchorEl = findQueueAnchor();
            if (anchorEl || attachAttempts >= MAX_ATTACH_ATTEMPTS) {
                clearInterval(attachTimer);
            }
            positionPanel();
        }, 500);

        pollStatus();
        startPolling();
    }
});
