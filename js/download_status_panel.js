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
        let footer = null;
        let refreshBtn = null;
        let refreshBusy = false;
        let bootstrapDone = false;
        let panelMinimized = false;
        let lastVisibleCount = 0;
        let lastHasRunning = false;

        const PANEL_RIGHT_MARGIN = 16;
        const PANEL_TOP_MARGIN = 10;
        const BUTTON_BASE_CLASS = "relative inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap appearance-none border-none rounded-md text-sm font-medium font-inter transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
        const BUTTON_DESTRUCTIVE_CLASS = `${BUTTON_BASE_CLASS} bg-destructive-background text-base-foreground hover:bg-destructive-background-hover size-8`;
        const BUTTON_TEXONLY_ICON_CLASS = `${BUTTON_BASE_CLASS} text-base-foreground bg-transparent hover:bg-secondary-background-hover size-8`;
        const PANEL_CLASS = "pointer-events-auto flex w-[350px] min-w-[310px] max-h-[60vh] flex-col overflow-hidden rounded-lg border border-interface-stroke bg-interface-panel-surface font-inter transition-colors duration-200 ease-in-out shadow-interface";
        const ITEM_CLASS = "hf-downloader-item relative flex items-center justify-between gap-2 overflow-hidden rounded-lg border border-secondary-background bg-secondary-background p-1 text-[12px] text-text-primary transition-colors duration-150 ease-in-out hover:border-secondary-background-hover hover:bg-secondary-background-hover";

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
                    width: 350px;
                    min-width: 310px;
                    max-height: 60vh;
                    background: var(--interface-panel-surface, var(--hf-queue-bg, var(--p-content-background, var(--comfy-menu-bg, #1f2128))));
                    border: 1px solid var(--interface-stroke, var(--hf-queue-border, var(--border-color, var(--p-content-border-color, #3c4452))));
                    border-radius: 8px;
                    color: var(--fg-color, var(--p-text-color, #ddd));
                    z-index: 10000;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                #${PANEL_ID} .hf-downloader-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                    min-height: 48px;
                    padding: 0 8px;
                    border-bottom: 1px solid var(--interface-stroke, var(--border-color, var(--p-content-border-color, #333)));
                    background: transparent;
                }
                #${PANEL_ID} .hf-downloader-header-title {
                    padding: 0 8px;
                    font-size: 14px;
                    font-weight: 400;
                    color: var(--text-color, var(--input-text, var(--p-text-color, #e5e7eb)));
                }
                #${PANEL_ID} .hf-downloader-header-controls {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                }
                #${PANEL_ID} .hf-downloader-count {
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
                #${PANEL_ID} .hf-downloader-minimize {
                    font-size: 16px;
                    line-height: 1;
                }
                #${PANEL_ID} .hf-downloader-body {
                    flex: 1 1 auto;
                    min-height: 0;
                    overflow-y: auto;
                    padding: 6px 10px;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                }
                #${PANEL_ID} .hf-downloader-item {
                    height: 48px;
                    min-height: 48px;
                    max-height: 48px;
                    box-sizing: border-box;
                }
                #${PANEL_ID} .hf-downloader-item.has-detail {
                    height: auto;
                    min-height: 74px;
                    max-height: none;
                    align-items: flex-start;
                    padding-top: 8px;
                    padding-bottom: 8px;
                }
                #${PANEL_ID} .hf-downloader-content {
                    min-width: 0;
                    flex: 1 1 auto;
                    padding-right: 48px;
                }
                #${PANEL_ID} .hf-downloader-item.has-detail .hf-downloader-content {
                    padding-right: 56px;
                }
                #${PANEL_ID} .hf-downloader-name {
                    font-weight: 600;
                    color: var(--text-color, var(--input-text, var(--p-text-color, #e3e5ea)));
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    opacity: 0.95;
                }
                #${PANEL_ID} .hf-downloader-meta {
                    margin-top: 2px;
                    color: var(--descrip-text, var(--p-text-muted-color, #aab1bc));
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 6px;
                    min-width: 0;
                    font-size: 12px;
                    line-height: 1;
                }
                #${PANEL_ID} .hf-downloader-size-text {
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                #${PANEL_ID} .hf-downloader-state-icon {
                    width: 16px;
                    height: 16px;
                    display: inline-block;
                }
                #${PANEL_ID} .hf-downloader-status-lower {
                    font-size: 9px;
                    font-weight: 600;
                    letter-spacing: 0.03em;
                    white-space: nowrap;
                    position: absolute;
                    right: 8px;
                    bottom: 8px;
                    line-height: 1;
                    pointer-events: none;
                    z-index: 2;
                    text-transform: uppercase;
                }
                #${PANEL_ID} .hf-downloader-cancel {
                    position: absolute;
                    right: 8px;
                    top: 50%;
                    opacity: 0;
                    pointer-events: none;
                    transform: translateY(calc(-50% + 2px));
                    transition: opacity 140ms ease-in-out, transform 140ms ease-in-out;
                    z-index: 5;
                }
                #${PANEL_ID} .hf-downloader-item:hover .hf-downloader-cancel,
                #${PANEL_ID} .hf-downloader-cancel:focus-visible {
                    opacity: 1;
                    pointer-events: auto;
                    transform: translateY(-50%);
                }
                #${PANEL_ID} .hf-downloader-item.can-cancel:hover .hf-downloader-status-lower {
                    visibility: hidden;
                }
                #${PANEL_ID} .hf-downloader-error {
                    margin-top: 6px;
                    font-size: 11px;
                    line-height: 1.25;
                    color: #ffb4b4;
                    white-space: normal;
                    word-break: break-word;
                    display: none;
                }
                #${PANEL_ID} .hf-downloader-actions {
                    margin-top: 6px;
                    display: none;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 8px;
                }
                #${PANEL_ID} .hf-downloader-actions.visible {
                    display: inline-flex;
                }
                #${PANEL_ID} .hf-downloader-agreement-hint {
                    font-size: 11px;
                    color: var(--descrip-text, #9aa4b6);
                }
                #${PANEL_ID} .hf-downloader-repo-link {
                    font-size: 11px;
                    color: #9ad6ff;
                    text-decoration: underline;
                    cursor: pointer;
                }
                #${PANEL_ID} .hf-downloader-footer {
                    display: none;
                    justify-content: flex-end;
                    padding: 8px 12px 10px;
                    background: transparent;
                }
                #${PANEL_ID} .hf-downloader-footer.visible {
                    display: flex;
                    border-top: 1px solid var(--interface-stroke, var(--border-color, var(--p-content-border-color, #333)));
                }
                #${PANEL_ID} .hf-downloader-refresh.p-button {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.35rem;
                    height: 1.5rem;
                    min-height: 1.5rem;
                    min-width: 4.4rem;
                    padding: 0 0.5rem;
                    font-size: 0.75rem;
                    line-height: 1;
                    font-weight: 500;
                    font-family: var(--font-inter, Inter, sans-serif);
                    border-radius: 0.25rem;
                    cursor: pointer;
                }
                #${PANEL_ID} .hf-downloader-refresh:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                }
            `;
            document.head.appendChild(style);
        };

        const syncPanelThemeFromJobQueue = () => {
            if (!panel || typeof window === "undefined" || !window.getComputedStyle) return;

            const textNodes = document.querySelectorAll("h1, h2, h3, h4, span, div");
            let jobQueueTitle = null;
            for (const node of textNodes) {
                if ((node.textContent || "").trim() !== "Job Queue") continue;
                if (node.closest(`#${PANEL_ID}`)) continue;
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
                jobQueueTitle.parentElement
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
            syncPanelThemeFromJobQueue();
        };

        const ensurePanel = () => {
            if (panel) return panel;
            ensureStyles();

            panel = document.createElement("div");
            panel.id = PANEL_ID;
            panel.className = PANEL_CLASS;

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
            minimizeBtn.className = `${BUTTON_TEXONLY_ICON_CLASS} hf-downloader-minimize`;
            minimizeBtn.innerHTML = "<i class=\"pi pi-minus\"></i>";
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

            footer = document.createElement("div");
            footer.className = "hf-downloader-footer";

            refreshBtn = document.createElement("button");
            refreshBtn.className = "hf-downloader-refresh";
            refreshBtn.classList.add("p-button", "p-component", "p-button-success");
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

        const retryDownload = async (payload) => {
            if (!payload || typeof payload !== "object") return null;
            try {
                const resp = await fetch("/queue_download", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ models: [payload] })
                });
                if (!resp.ok) return null;
                const data = await resp.json();
                const queued = Array.isArray(data?.queued) ? data.queued : [];
                return queued[0] || null;
            } catch (err) {
                console.warn("[HF Downloader] Retry request failed:", err);
                return null;
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

        const stateIconForStatus = (status) => {
            switch (status) {
                case "downloading":
                case "copying":
                case "cleaning_cache":
                case "finalizing":
                case "cancelling":
                    return {
                        key: "loading",
                        className: "icon-[lucide--loader-circle] size-4 animate-spin text-primary-background"
                    };
                case "queued":
                    return {
                        key: "queued",
                        className: "icon-[lucide--loader-circle] size-4 animate-spin text-white"
                    };
                case "downloaded":
                    return {
                        key: "downloaded",
                        className: "icon-[lucide--check-check] size-4 text-green-400"
                    };
                case "failed":
                    return {
                        key: "failed",
                        className: "icon-[lucide--alert-circle] size-4 text-red-400"
                    };
                case "cancelled":
                    return {
                        key: "cancelled",
                        className: "icon-[lucide--x-circle] size-4 text-yellow-400"
                    };
                default:
                    return {
                        key: "default",
                        className: "icon-[lucide--circle] size-4 text-text-secondary"
                    };
            }
        };

        const createItemNode = () => {
            const item = document.createElement("div");
            item.className = ITEM_CLASS;

            const leading = document.createElement("div");
            leading.className = "relative flex items-center gap-1";

            const iconWrap = document.createElement("div");
            iconWrap.className = "inline-flex h-6 w-6 items-center justify-center overflow-hidden rounded-[6px]";

            const stateIcon = document.createElement("i");
            stateIcon.className = "hf-downloader-state-icon icon-[lucide--clock-3] size-4 text-text-secondary";
            iconWrap.appendChild(stateIcon);
            leading.appendChild(iconWrap);

            const content = document.createElement("div");
            content.className = "hf-downloader-content relative min-w-0 flex-1";

            const name = document.createElement("div");
            name.className = "hf-downloader-name truncate opacity-90";

            content.appendChild(name);

            const cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className = `${BUTTON_DESTRUCTIVE_CLASS} hf-downloader-cancel`;
            cancelBtn.title = "Cancel download";
            cancelBtn.innerHTML = "<i class=\"icon-[lucide--trash-2] size-4\"></i>";
            cancelBtn.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                cancelBtn.disabled = true;
                const downloadId = item.getAttribute("data-download-id");
                void cancelDownload(downloadId);
            });

            const meta = document.createElement("div");
            meta.className = "hf-downloader-meta";

            const sizeText = document.createElement("div");
            sizeText.className = "hf-downloader-size-text";

            const status = document.createElement("div");
            status.className = "hf-downloader-status-lower";

            meta.appendChild(sizeText);
            content.appendChild(meta);

            const error = document.createElement("div");
            error.className = "hf-downloader-error";
            error.style.display = "none";

            const actions = document.createElement("div");
            actions.className = "hf-downloader-actions";

            const agreementHint = document.createElement("span");
            agreementHint.className = "hf-downloader-agreement-hint";
            agreementHint.textContent = "Accept model agreement and retry download.";

            const repoLink = document.createElement("a");
            repoLink.className = "hf-downloader-repo-link";
            repoLink.textContent = "Open model page";
            repoLink.target = "_blank";
            repoLink.rel = "noopener noreferrer";
            repoLink.style.display = "none";

            const retryBtn = document.createElement("button");
            retryBtn.type = "button";
            retryBtn.className = "hf-downloader-retry p-button p-component p-button-sm p-button-warning";
            retryBtn.textContent = "Retry";
            retryBtn.style.display = "none";

            actions.appendChild(agreementHint);
            actions.appendChild(repoLink);
            actions.appendChild(retryBtn);

            item.appendChild(leading);
            item.appendChild(content);
            item.appendChild(status);
            item.appendChild(cancelBtn);
            content.appendChild(error);
            content.appendChild(actions);

            return {
                root: item,
                name,
                cancelBtn,
                stateIcon,
                sizeText,
                status,
                error,
                actions,
                agreementHint,
                repoLink,
                retryBtn
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

            const iconMeta = stateIconForStatus(info.status);
            if (refs.stateIcon.dataset.iconKey !== iconMeta.key) {
                refs.stateIcon.className = `hf-downloader-state-icon ${iconMeta.className}`;
                refs.stateIcon.dataset.iconKey = iconMeta.key;
            }

            refs.status.textContent = resolveStatusText(info);
            refs.status.style.color = statusColor(info.status);

            const errorText = String(info.error || "").trim();
            const isFailed = info.status === "failed";
            const errorCode = String(info.error_code || "").trim().toLowerCase();
            const hasGatedMarkers = /gated|accept (its|model) terms|request access|agreement/i.test(errorText);
            const isGated = isFailed && (errorCode === "gated_repo" || hasGatedMarkers);
            const repoUrl = String(info.repo_url || "").trim();
            const actionMessage = String(info.action_message || "").trim();
            const retryPayload = info.retry_payload && typeof info.retry_payload === "object" ? info.retry_payload : null;

            if (isFailed && errorText) {
                const renderedError = isGated
                    ? "Gated repository. Accept the model agreement on Hugging Face, then retry."
                    : errorText;
                refs.error.textContent = renderedError;
                refs.error.title = renderedError;
                refs.error.style.display = "block";
            } else {
                refs.error.textContent = "";
                refs.error.title = "";
                refs.error.style.display = "none";
            }

            refs.root.classList.toggle("has-detail", isFailed && !!errorText);
            refs.actions.classList.toggle("visible", isGated);
            refs.agreementHint.textContent = actionMessage || "Accept model agreement and retry download.";
            refs.agreementHint.style.display = isGated ? "inline" : "none";

            if (isGated && repoUrl) {
                refs.repoLink.href = repoUrl;
                refs.repoLink.style.display = "inline";
            } else {
                refs.repoLink.removeAttribute("href");
                refs.repoLink.style.display = "none";
            }

            refs.retryBtn.style.display = isGated ? "inline-flex" : "none";
            refs.retryBtn.disabled = !retryPayload;
            refs.retryBtn.onclick = isGated
                ? async (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!retryPayload || refs.retryBtn.disabled) return;
                      refs.retryBtn.disabled = true;
                      refs.retryBtn.textContent = "Retrying...";
                      const queued = await retryDownload(retryPayload);
                      if (queued?.download_id) {
                          dismissedEntryIds.add(info.id);
                      }
                      refs.retryBtn.textContent = queued?.download_id ? "Queued" : "Retry";
                      if (!queued?.download_id) {
                          refs.retryBtn.disabled = false;
                      }
                  }
                : null;
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
            for (const id of justCompletedIds) {
                dismissedEntryIds.add(id);
            }
            if (listBody) {
                listBody.replaceChildren();
            }
            itemNodes.clear();
            lastVisibleCount = 0;
            lastHasRunning = false;
            applyPanelVisibility();
            publishPanelState();

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
                const showRefresh = !hasRunning && !hasFailed && hasSuccess;
                refreshBtn.style.display = showRefresh ? "inline-flex" : "none";
                footer?.classList.toggle("visible", showRefresh);
                if (!showRefresh) {
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
