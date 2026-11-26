import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { forceRefreshModels } from "./comfy_stores.js";
import { mountInNativeStack, setNativeStackPanelVisible } from "./native_stack.js";

app.registerExtension({
    name: "hfDownloaderStatusPanel",
    setup() {
        const WRAPPER_ID = "hf-downloader-panel-wrapper";
        const PANEL_ID = "hf-downloader-panel";
        const STYLE_ID = "hf-downloader-panel-styles";
        const WATCHDOG_INTERVAL_MS = 3000;
        const WS_STALE_THRESHOLD_MS = 4000;
        const FAILED_TTL_MS = 120000;
        const CANCELLED_TTL_MS = 1500;

        const RUNNING_STATUSES = new Set([
            "queued",
            "downloading",
            "uploading",
            "copying",
            "cleaning_cache",
            "finalizing",
            "verifying",
            "pausing",
            "cancelling"
        ]);
        const ACTIVE_NON_TERMINAL_STATUSES = new Set([
            "queued",
            "downloading",
            "uploading",
            "copying",
            "cleaning_cache",
            "finalizing",
            "verifying",
            "pausing",
            "paused",
            "cancelling"
        ]);
        const PAUSABLE_STATUSES = new Set([
            "queued",
            "downloading",
            "copying",
            "cleaning_cache",
            "finalizing",
            "verifying"
        ]);
        const CAN_CANCEL_STATUSES = new Set([
            "queued",
            "downloading",
            "uploading",
            "copying",
            "cleaning_cache",
            "finalizing",
            "verifying",
            "pausing",
            "paused",
            "cancelling"
        ]);
        const SUCCESS_STATUSES = new Set(["downloaded", "completed", "verifying"]);
        const DISK_READY_STATUSES = new Set(["downloaded", "completed"]);

        const dismissedEntryIds = new Set();
        const itemNodes = new Map();
        const processedDownloadIds = new Set();

        let panelWrapper = null;
        let panel = null;
        let listBody = null;
        let headerTitleEl = null;
        let pauseAllBtn = null;
        let cancelAllBtn = null;
        let minimizeBtn = null;
        let footer = null;
        let clearFinishedBtn = null;
        let dismissAllBtn = null;
        let lastRenderedDownloads = {};
        let lastRenderedBackupTasks = {};
        let bootstrapDone = false;
        let panelMinimized = false;
        let lastVisibleCount = 0;
        let lastHasRunning = false;

        const BUTTON_BASE_CLASS =
            "relative inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap appearance-none border border-solid border-border/60 rounded-md text-xs font-medium font-inter transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
        const ACTION_ICON_BTN_CLASS =
            "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
        const HEADER_ICON_BTN_CLASS =
            "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
        const WRAPPER_CLASS =
            "pointer-events-none flex w-full justify-end transition-all duration-300 ease-out";
        const PANEL_CLASS =
            "pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-solid border-border bg-background text-foreground shadow-lg";
        const ITEM_CLASS =
            "hf-downloader-item relative flex items-center gap-2.5 overflow-hidden rounded-lg px-2.5 py-2 text-xs text-foreground transition-colors duration-150 ease-in-out";

        const registerGlobalAction = (name, action) => {
            if (typeof window === "undefined") return;
            if (!window.hfDownloader) {
                window.hfDownloader = {};
            }
            window.hfDownloader[name] = action;
        };

        const getPanelState = () => ({
            minimized: panelMinimized,
            collapsed: false,
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
            if (!panel || !panelWrapper) return;
            const visible = Boolean(lastVisibleCount && !panelMinimized);
            if (!visible) {
                panel.style.display = "none";
                panelWrapper.style.display = "none";
                setNativeStackPanelVisible(WRAPPER_ID, false);
            } else {
                panelWrapper.style.display = "flex";
                panel.style.display = "flex";
                setNativeStackPanelVisible(panelWrapper, true, { id: WRAPPER_ID, priority: 20 });
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
        registerGlobalAction("pollDownloadStatusNow", () => pollStatus());

        const toUiStatus = (status) => {
            const norm = String(status || "").trim().toLowerCase();
            if (norm === "verifying" || norm === "completed") return "downloaded";
            if (norm === "interrupted") return "interrupted";
            return norm || "queued";
        };

        const statusLabel = (status) => {
            switch (status) {
                case "queued":
                    return "Queued";
                case "downloading":
                    return "Downloading";
                case "uploading":
                    return "Uploading";
                case "pausing":
                    return "Pausing";
                case "paused":
                    return "Paused";
                case "copying":
                    return "Copying";
                case "cleaning_cache":
                case "finalizing":
                    return "Finalizing";
                case "downloaded":
                    return "Completed";
                case "failed":
                    return "Failed";
                case "cancelled":
                    return "Cancelled";
                case "cancelling":
                    return "Cancelling";
                case "interrupted":
                    return "Interrupted";
                default:
                    return "Queued";
            }
        };

        const statusColor = (status) => {
            switch (status) {
                case "downloading":
                case "uploading":
                    return "#60a5fa";
                case "copying":
                case "cleaning_cache":
                case "finalizing":
                    return "#93c5fd";
                case "paused":
                case "pausing":
                    return "var(--warning, #f59e0b)";
                case "downloaded":
                    return "#4ade80";
                case "failed":
                    return "#f87171";
                case "cancelled":
                case "cancelling":
                    return "#9ca3af";
                case "interrupted":
                    return "var(--warning, #f59e0b)";
                default:
                    return "#9ca3af";
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
                "uploading",
                "pausing",
                "paused",
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

        const formatBytes = (value) => {
            if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
            const units = ["B", "KB", "MB", "GB", "TB"];
            let size = Number(value);
            let unitIndex = 0;
            while (size >= 1024 && unitIndex < units.length - 1) {
                size /= 1024;
                unitIndex += 1;
            }
            const decimals = size >= 10 || unitIndex === 0 ? 0 : 1;
            return `${size.toFixed(decimals)} ${units[unitIndex]}`;
        };

        const formatSpeed = (speedBps) => {
            const num = Number(speedBps || 0);
            if (!Number.isFinite(num) || num <= 0) return "";
            return `${formatBytes(num)}/s`;
        };

        const ensureStyles = () => {
            if (document.getElementById(STYLE_ID)) return;

            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = `
                #${PANEL_ID} {
                    position: relative;
                    width: min(350px, calc(100vw - 32px));
                    max-width: min(350px, calc(100vw - 32px));
                    min-width: min(310px, calc(100vw - 32px));
                    max-height: min(60vh, 520px);
                    box-sizing: border-box;
                    border-radius: 12px;
                    border: 1px solid var(--hf-queue-border, var(--border-default, rgba(255, 255, 255, 0.12)));
                    background: var(--hf-queue-bg, var(--comfy-menu-bg, var(--background, #1c1d22)));
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
                    overflow: hidden;
                    pointer-events: auto;
                }
                #${PANEL_ID} .hf-queue-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                    padding: 10px 12px;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                    background: transparent;
                }
                #${PANEL_ID} .hf-queue-header-title {
                    font-size: 14px;
                    font-weight: 600;
                    line-height: 1.2;
                    color: var(--foreground, #f3f4f6);
                    min-width: 0;
                    flex: 1 1 auto;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                #${PANEL_ID} .hf-queue-header-controls {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    flex-shrink: 0;
                }
                #${PANEL_ID} .hf-queue-action-pill {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    height: 28px;
                    padding: 0 9px;
                    border-radius: 8px;
                    border: none;
                    font-size: 12px;
                    font-weight: 500;
                    cursor: pointer;
                    white-space: nowrap;
                    transition: background-color 150ms ease, color 150ms ease, opacity 150ms ease;
                }
                #${PANEL_ID} .hf-queue-action-pill:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                #${PANEL_ID} .hf-queue-pause-all {
                    background: var(--secondary, rgba(255, 255, 255, 0.08));
                    color: var(--foreground, #e5e7eb);
                }
                #${PANEL_ID} .hf-queue-pause-all:hover:not(:disabled) {
                    background: var(--accent, rgba(255, 255, 255, 0.15));
                }
                #${PANEL_ID} .hf-queue-cancel-all {
                    background: var(--secondary, rgba(255, 255, 255, 0.08));
                    color: var(--foreground, #e5e7eb);
                }
                #${PANEL_ID} .hf-queue-cancel-all:hover:not(:disabled) {
                    background: rgba(239, 68, 68, 0.25);
                    color: #fca5a5;
                }
                #${PANEL_ID} .hf-queue-tabs {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    padding: 8px 12px 4px 12px;
                }
                #${PANEL_ID} .hf-queue-tab {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    height: 28px;
                    padding: 0 11px;
                    border-radius: 8px;
                    border: none;
                    background: transparent;
                    color: var(--muted-foreground, #9ca3af);
                    font-size: 12px;
                    font-weight: 500;
                    cursor: pointer;
                    transition: background-color 150ms ease, color 150ms ease;
                }
                #${PANEL_ID} .hf-queue-tab:hover {
                    color: var(--foreground, #f3f4f6);
                }
                #${PANEL_ID} .hf-queue-tab.active {
                    background: var(--secondary, rgba(255, 255, 255, 0.1));
                    color: var(--foreground, #ffffff);
                    font-weight: 600;
                }
                #${PANEL_ID} .hf-downloader-body {
                    flex: 1 1 auto;
                    min-height: 0;
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    padding: 6px 10px 10px 10px;
                }
                #${PANEL_ID} .hf-downloader-item {
                    min-height: 52px;
                    box-sizing: border-box;
                    background: transparent;
                }
                #${PANEL_ID} .hf-downloader-item:hover {
                    background: rgba(255, 255, 255, 0.04);
                }
                #${PANEL_ID} .hf-downloader-item.is-active-row {
                    background: var(--secondary, rgba(255, 255, 255, 0.07));
                }
                #${PANEL_ID} .hf-downloader-item.has-detail {
                    align-items: flex-start;
                }
                #${PANEL_ID} .hf-downloader-icon-tile {
                    width: 36px;
                    height: 36px;
                    border-radius: 8px;
                    background: rgba(255, 255, 255, 0.07);
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                }
                #${PANEL_ID} .hf-downloader-content {
                    min-width: 0;
                    flex: 1 1 auto;
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                }
                #${PANEL_ID} .hf-downloader-name {
                    font-size: 13px;
                    font-weight: 500;
                    line-height: 1.3;
                    color: var(--foreground, #f3f4f6);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                #${PANEL_ID} .hf-downloader-subtitle {
                    font-size: 11px;
                    line-height: 1.3;
                    color: var(--muted-foreground, #9ca3af);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                #${PANEL_ID} .hf-downloader-row-actions {
                    display: inline-flex;
                    align-items: center;
                    gap: 2px;
                    flex-shrink: 0;
                }
                #${PANEL_ID} .hf-downloader-progress-container {
                    position: absolute;
                    left: 0;
                    bottom: 0;
                    right: 0;
                    height: 2px;
                    background: rgba(255, 255, 255, 0.08);
                    pointer-events: none;
                    overflow: hidden;
                }
                #${PANEL_ID} .hf-downloader-progress-bar {
                    height: 100%;
                    width: 0%;
                    background: #60a5fa;
                    transition: width 200ms ease-out, background-color 200ms ease-in-out;
                }
                #${PANEL_ID} .hf-downloader-progress-bar.indeterminate {
                    width: 40% !important;
                    animation: hf-queue-indeterminate 1.25s ease-in-out infinite;
                }
                @keyframes hf-queue-indeterminate {
                    0% { transform: translateX(-110%); }
                    100% { transform: translateX(260%); }
                }
                #${PANEL_ID} .hf-downloader-error {
                    margin-top: 3px;
                    font-size: 11px;
                    line-height: 1.3;
                    color: #fca5a5;
                    white-space: normal;
                    word-break: break-word;
                    display: none;
                }
                #${PANEL_ID} .hf-downloader-error a {
                    color: #60a5fa;
                    text-decoration: underline;
                    cursor: pointer;
                }
                #${PANEL_ID} .hf-downloader-gated-callout {
                    margin-top: 6px;
                    padding: 7px 9px;
                    border-radius: 8px;
                    background: rgba(245, 158, 11, 0.10);
                    border: 1px solid rgba(245, 158, 11, 0.35);
                    color: #fbbf24;
                    font-size: 11px;
                    line-height: 1.35;
                    display: none;
                    align-items: flex-start;
                    gap: 7px;
                    word-break: break-word;
                }
                #${PANEL_ID} .hf-downloader-gated-text {
                    min-width: 0;
                    flex: 1 1 auto;
                }
                #${PANEL_ID} .hf-downloader-actions {
                    margin-top: 6px;
                    display: none;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 6px;
                }
                #${PANEL_ID} .hf-downloader-actions.visible {
                    display: inline-flex;
                }
                #${PANEL_ID} .hf-downloader-agreement-hint {
                    font-size: 11px;
                    color: var(--muted-foreground, #9ca3af);
                }
                #${PANEL_ID} .hf-downloader-action-btn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 5px;
                    height: 26px;
                    padding: 0 9px;
                    border-radius: 6px;
                    font-size: 11px;
                    font-weight: 500;
                    line-height: 1;
                    text-decoration: none;
                }
                #${PANEL_ID} .hf-downloader-action-btn-amber {
                    background: rgba(245, 158, 11, 0.16);
                    border: 1px solid rgba(245, 158, 11, 0.42);
                    color: #fbbf24;
                }
                #${PANEL_ID} .hf-downloader-action-btn-amber:hover {
                    background: rgba(245, 158, 11, 0.26);
                }
                #${PANEL_ID} .hf-downloader-empty-filter {
                    padding: 18px 12px;
                    text-align: center;
                    font-size: 12px;
                    color: var(--muted-foreground, #9ca3af);
                    display: none;
                }
                #${PANEL_ID} .hf-downloader-footer {
                    display: none;
                    align-items: center;
                    justify-content: flex-end;
                    gap: 6px;
                    padding: 8px 12px 10px 12px;
                    border-top: 1px solid rgba(255, 255, 255, 0.08);
                    background: transparent;
                }
                #${PANEL_ID} .hf-downloader-footer.visible {
                    display: flex;
                }
                #${PANEL_ID} .hf-downloader-footer-btn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 4px;
                    height: 28px;
                    padding: 0 10px;
                    font-size: 12px;
                    line-height: 1;
                    font-weight: 500;
                    border-radius: 7px;
                    cursor: pointer;
                }
                #${PANEL_ID}.hf-downloader-collapsed .hf-queue-tabs,
                #${PANEL_ID}.hf-downloader-collapsed .hf-downloader-body,
                #${PANEL_ID}.hf-downloader-collapsed .hf-downloader-footer {
                    display: none !important;
                }
            `;
            document.head.appendChild(style);
        };

        const updatePanelPosition = () => {
            if (!panel || !panelWrapper) return;
            const visible = Boolean(lastVisibleCount && !panelMinimized);
            if (visible) {
                setNativeStackPanelVisible(panelWrapper, true, { id: WRAPPER_ID, priority: 20 });
            } else {
                setNativeStackPanelVisible(WRAPPER_ID, false);
            }
        };

        const apiFetch = (url, options) => {
            if (api && typeof api.fetchApi === "function") {
                return api.fetchApi(url, options);
            }
            return fetch(url, options);
        };

        const postJson = async (url, payload) => {
            const resp = await apiFetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload || {})
            });
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }
            return resp.json().catch(() => ({}));
        };

        const CONTROL_PENDING_TTL_MS = 2500;
        const pendingControlActions = new Map(); // id -> { kind, statusAtClick, expiresAt }

        const markControlPending = (id, kind, currentStatus) => {
            if (!id) return;
            pendingControlActions.set(id, {
                kind,
                statusAtClick: String(currentStatus || ""),
                expiresAt: Date.now() + CONTROL_PENDING_TTL_MS,
            });
        };

        const isControlPendingFor = (id, kind, currentStatus) => {
            const entry = pendingControlActions.get(id);
            if (!entry) return false;
            if (Date.now() > entry.expiresAt || String(currentStatus || "") !== entry.statusAtClick) {
                pendingControlActions.delete(id);
                return false;
            }
            return entry.kind === kind || entry.kind === "cancel";
        };

        const triggerControlFollowUpPoll = () => {
            void pollStatus();
            setTimeout(() => {
                void pollStatus();
            }, 400);
        };

        const cancelDownload = async (downloadId, currentStatus = "") => {
            if (!downloadId) return;
            markControlPending(downloadId, "cancel", currentStatus);
            try {
                await postJson("/cancel_download", { download_id: downloadId });
                triggerControlFollowUpPoll();
            } catch (err) {
                pendingControlActions.delete(downloadId);
                console.warn("[HF Downloader] Failed to cancel download:", err);
            }
        };

        const pauseDownload = async (downloadId, currentStatus = "") => {
            if (!downloadId) return;
            markControlPending(downloadId, "pause", currentStatus);
            try {
                await postJson("/pause_download", { download_id: downloadId });
                triggerControlFollowUpPoll();
            } catch (err) {
                pendingControlActions.delete(downloadId);
                console.warn("[HF Downloader] Failed to pause download:", err);
            }
        };

        const resumeDownload = async (downloadId, currentStatus = "") => {
            if (!downloadId) return;
            markControlPending(downloadId, "resume", currentStatus);
            try {
                await postJson("/resume_download", { download_id: downloadId });
                triggerControlFollowUpPoll();
            } catch (err) {
                pendingControlActions.delete(downloadId);
                console.warn("[HF Downloader] Failed to resume download:", err);
            }
        };

        const cancelBackupTask = async (taskId, currentStatus = "") => {
            if (!taskId) return;
            markControlPending(taskId, "cancel", currentStatus);
            try {
                await postJson("/cancel_backup_task", { task_id: taskId });
                triggerControlFollowUpPoll();
            } catch (err) {
                pendingControlActions.delete(taskId);
                console.warn("[HF Downloader] Failed to cancel backup task:", err);
            }
        };

        const pauseOrResumeAll = async () => {
            if (!pauseAllBtn) return;
            const mode = pauseAllBtn.dataset.mode || "pause";
            pauseAllBtn.disabled = true;
            try {
                if (mode === "resume") {
                    await postJson("/resume_download", { resume_all: true });
                } else {
                    await postJson("/pause_download", { pause_all: true });
                }
                triggerControlFollowUpPoll();
            } catch (err) {
                console.warn(`[HF Downloader] Failed to ${mode} all downloads:`, err);
            } finally {
                if (pauseAllBtn) pauseAllBtn.disabled = false;
            }
        };

        const cancelAllDownloadsAndBackups = async () => {
            if (cancelAllBtn) cancelAllBtn.disabled = true;
            try {
                await postJson("/cancel_download", { cancel_all: true, include_backups: true });
                triggerControlFollowUpPoll();
            } catch (err) {
                console.warn("[HF Downloader] Failed to cancel all items:", err);
            } finally {
                if (cancelAllBtn) cancelAllBtn.disabled = false;
            }
        };

        const retryDownload = async (payload) => {
            if (!payload || typeof payload !== "object") return null;
            try {
                const data = await postJson("/queue_download", { models: [payload] });
                const queued = Array.isArray(data?.queued) ? data.queued : [];
                return queued[0] || null;
            } catch (err) {
                console.warn("[HF Downloader] Retry request failed:", err);
                return null;
            }
        };

        const resumeInterrupted = async (downloadId) => {
            if (!downloadId) return null;
            try {
                const data = await postJson("/resume_interrupted", { download_id: downloadId });
                const queued = Array.isArray(data?.queued) ? data.queued : [];
                return queued[0] || null;
            } catch (err) {
                console.warn("[HF Downloader] Resume request failed:", err);
                return null;
            }
        };

        const dismissInterrupted = async (downloadId) => {
            if (!downloadId) return false;
            try {
                const resp = await apiFetch("/dismiss_interrupted", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ download_id: downloadId })
                });
                return resp.ok;
            } catch (err) {
                console.warn("[HF Downloader] Dismiss request failed:", err);
                return false;
            }
        };

        const dismissEntriesByStatus = (includeFailed = false) => {
            const combined = [
                ...Object.entries(lastRenderedDownloads || {}).map(([id, info]) => ({ id, ...(info || {}) })),
                ...Object.entries(lastRenderedBackupTasks || {}).map(([id, info]) => ({ id, ...(info || {}) }))
            ];
            for (const info of combined) {
                const status = toUiStatus(info?.status);
                if (ACTIVE_NON_TERMINAL_STATUSES.has(status)) continue;
                if (!includeFailed && status === "failed") continue;
                if (status === "interrupted") {
                    void dismissInterrupted(info.id);
                }
                dismissedEntryIds.add(info.id);
            }
            renderList(lastRenderedDownloads, lastRenderedBackupTasks);
        };

        const ensurePanel = () => {
            if (panel && panelWrapper) return panel;
            ensureStyles();

            panelWrapper = document.createElement("div");
            panelWrapper.id = WRAPPER_ID;
            panelWrapper.setAttribute("data-testid", "hf-downloads-overlay");
            panelWrapper.className = WRAPPER_CLASS;
            panelWrapper.style.display = "none";

            panel = document.createElement("div");
            panel.id = PANEL_ID;
            panel.className = PANEL_CLASS;
            panel.style.display = "none";

            const header = document.createElement("div");
            header.className = "hf-queue-header";

            headerTitleEl = document.createElement("div");
            headerTitleEl.className = "hf-queue-header-title";
            headerTitleEl.setAttribute("data-testid", "hf-queue-header-title");
            headerTitleEl.textContent = "Downloads";

            const controls = document.createElement("div");
            controls.className = "hf-queue-header-controls";

            pauseAllBtn = document.createElement("button");
            pauseAllBtn.type = "button";
            pauseAllBtn.setAttribute("data-testid", "hf-queue-pause-all-btn");
            pauseAllBtn.className = "hf-queue-action-pill hf-queue-pause-all";
            pauseAllBtn.style.display = "none";
            pauseAllBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                void pauseOrResumeAll();
            });

            cancelAllBtn = document.createElement("button");
            cancelAllBtn.type = "button";
            cancelAllBtn.setAttribute("data-testid", "hf-queue-cancel-all-btn");
            cancelAllBtn.className = "hf-queue-action-pill hf-queue-cancel-all";
            cancelAllBtn.title = "Cancel all active downloads & backup tasks";
            cancelAllBtn.innerHTML =
                `<i class="icon-[lucide--x-circle] size-3.5 shrink-0"></i><span>Cancel all</span>`;
            cancelAllBtn.style.display = "none";
            cancelAllBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                void cancelAllDownloadsAndBackups();
            });

            minimizeBtn = document.createElement("button");
            minimizeBtn.type = "button";
            minimizeBtn.setAttribute("data-testid", "hf-downloader-minimize-btn");
            minimizeBtn.className = `${HEADER_ICON_BTN_CLASS} hf-downloader-minimize`;
            minimizeBtn.innerHTML = `<i class="icon-[lucide--chevron-up] size-4"></i>`;
            minimizeBtn.title = "Minimize downloads";
            minimizeBtn.setAttribute("aria-label", "Minimize downloads");
            minimizeBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                setPanelMinimized(true);
            });

            controls.appendChild(pauseAllBtn);
            controls.appendChild(cancelAllBtn);
            controls.appendChild(minimizeBtn);
            header.appendChild(headerTitleEl);
            header.appendChild(controls);

            listBody = document.createElement("div");
            listBody.className = "hf-downloader-body";

            footer = document.createElement("div");
            footer.className = "hf-downloader-footer";

            clearFinishedBtn = document.createElement("button");
            clearFinishedBtn.type = "button";
            clearFinishedBtn.className = `${BUTTON_BASE_CLASS} hf-downloader-footer-btn bg-secondary text-foreground hover:bg-accent`;
            clearFinishedBtn.textContent = "Clear finished";
            clearFinishedBtn.style.display = "none";
            clearFinishedBtn.addEventListener("click", () => {
                dismissEntriesByStatus(false);
            });

            dismissAllBtn = document.createElement("button");
            dismissAllBtn.type = "button";
            dismissAllBtn.className = `${BUTTON_BASE_CLASS} hf-downloader-footer-btn bg-secondary text-foreground hover:bg-accent`;
            dismissAllBtn.textContent = "Dismiss all";
            dismissAllBtn.style.display = "none";
            dismissAllBtn.addEventListener("click", () => {
                dismissEntriesByStatus(true);
            });

            footer.appendChild(clearFinishedBtn);
            footer.appendChild(dismissAllBtn);

            panel.appendChild(header);
            panel.appendChild(listBody);
            panel.appendChild(footer);
            panelWrapper.appendChild(panel);

            updatePanelPosition();
            return panel;
        };

        const isDismissedEntry = (entry) => {
            if (!dismissedEntryIds.has(entry.id)) return false;
            return (
                SUCCESS_STATUSES.has(entry.status) ||
                entry.status === "cancelled" ||
                entry.status === "interrupted" ||
                entry.status === "failed"
            );
        };

        const entryTimestampMs = (entry) => {
            return (
                (entry.finished_at || entry.updated_at || entry.started_at || entry.queued_at || 0) * 1000
            );
        };

        const stateIconForEntry = (entry) => {
            const status = entry.status;
            const kind = entry._kind || "download";

            if (status === "downloaded") {
                return {
                    key: "downloaded",
                    className: "icon-[lucide--check-check] size-4 text-green-400"
                };
            }
            if (status === "failed") {
                return {
                    key: "failed",
                    className: "icon-[lucide--alert-circle] size-4 text-red-400"
                };
            }
            if (status === "cancelled") {
                return {
                    key: "cancelled",
                    className: "icon-[lucide--x-circle] size-4 text-muted-foreground"
                };
            }
            if (status === "interrupted") {
                return {
                    key: "interrupted",
                    className: "icon-[lucide--triangle-alert] size-4 text-warning"
                };
            }
            if (status === "paused" || status === "pausing") {
                return {
                    key: "paused",
                    className: "icon-[lucide--pause] size-4 text-warning"
                };
            }
            if (kind === "backup_upload") {
                return {
                    key: `backup-up-${status}`,
                    className: status === "uploading"
                        ? "icon-[lucide--upload] size-4 text-blue-400"
                        : "icon-[lucide--upload] size-4 text-muted-foreground"
                };
            }
            if (kind === "backup_download") {
                return {
                    key: `backup-dl-${status}`,
                    className: status === "downloading"
                        ? "icon-[lucide--download] size-4 text-blue-400"
                        : "icon-[lucide--download] size-4 text-muted-foreground"
                };
            }
            if (status === "queued") {
                return {
                    key: "queued",
                    className: "icon-[lucide--clock] size-4 text-muted-foreground"
                };
            }
            return {
                key: `spin-${status}`,
                className: "pi pi-spinner-dotted pi-spin inline-flex size-4 items-center justify-center text-sm leading-none text-blue-400"
            };
        };

        const renderErrorWithLinks = (container, text) => {
            container.innerHTML = "";
            if (!text) return;
            const urlRegex = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
            const parts = text.split(urlRegex);
            for (const part of parts) {
                if (urlRegex.test(part)) {
                    const link = document.createElement("a");
                    link.href = part;
                    link.textContent = part;
                    link.target = "_blank";
                    link.rel = "noopener noreferrer";
                    container.appendChild(link);
                } else {
                    container.appendChild(document.createTextNode(part));
                }
            }
        };

        const isGatedEntry = (info) => {
            if (!info || typeof info !== "object") return false;
            const kind = info._kind || "download";
            const isBackup = kind === "backup_upload" || kind === "backup_download";
            if (isBackup || toUiStatus(info.status) !== "failed") return false;
            const errorCode = String(info.error_code || "").trim();
            const errorText = String(info.error || "").trim();
            const hasGatedMarkers =
                /gated|accept (its|the|model) terms|acceptance of its conditions|request access|ask for access|authorized list|restricted|agreement|agree to the license|license agreement|403/i.test(
                    errorText
                );
            return errorCode === "gated_repo" || errorCode === "hf_forbidden" || hasGatedMarkers;
        };

        const createItemNode = () => {
            const item = document.createElement("div");
            item.className = ITEM_CLASS;

            const content = document.createElement("div");
            content.className = "hf-downloader-content";

            const name = document.createElement("div");
            name.className = "hf-downloader-name";

            const subtitle = document.createElement("div");
            subtitle.className = "hf-downloader-subtitle";

            const error = document.createElement("div");
            error.className = "hf-downloader-error";
            error.style.display = "none";

            const gatedCallout = document.createElement("div");
            gatedCallout.className = "hf-downloader-gated-callout";
            gatedCallout.style.display = "none";
            const gatedLockIcon = document.createElement("i");
            gatedLockIcon.className = "icon-[lucide--lock] size-3.5 shrink-0";
            gatedLockIcon.style.marginTop = "1px";
            gatedLockIcon.setAttribute("aria-hidden", "true");
            const gatedText = document.createElement("span");
            gatedText.className = "hf-downloader-gated-text";
            gatedCallout.appendChild(gatedLockIcon);
            gatedCallout.appendChild(gatedText);

            const actions = document.createElement("div");
            actions.className = "hf-downloader-actions";

            const agreementHint = document.createElement("span");
            agreementHint.className = "hf-downloader-agreement-hint";
            agreementHint.textContent = "Accept model agreement and retry download.";

            const repoLink = document.createElement("a");
            repoLink.className = `${BUTTON_BASE_CLASS} hf-downloader-action-btn hf-downloader-action-btn-amber`;
            const repoLinkIcon = document.createElement("i");
            repoLinkIcon.className = "icon-[lucide--external-link] size-3 shrink-0";
            repoLinkIcon.setAttribute("aria-hidden", "true");
            const repoLinkLabel = document.createElement("span");
            repoLinkLabel.textContent = "Accept license";
            repoLink.appendChild(repoLinkIcon);
            repoLink.appendChild(repoLinkLabel);
            repoLink.target = "_blank";
            repoLink.rel = "noopener noreferrer";
            repoLink.style.display = "none";

            const retryBtn = document.createElement("button");
            retryBtn.type = "button";
            retryBtn.className = `${BUTTON_BASE_CLASS} hf-downloader-action-btn bg-secondary text-foreground hover:bg-accent`;
            retryBtn.textContent = "Retry";
            retryBtn.style.display = "none";

            const dismissBtn = document.createElement("button");
            dismissBtn.type = "button";
            dismissBtn.className = `${BUTTON_BASE_CLASS} hf-downloader-action-btn bg-secondary text-foreground hover:bg-accent`;
            dismissBtn.textContent = "Dismiss";
            dismissBtn.style.display = "none";

            actions.appendChild(agreementHint);
            actions.appendChild(repoLink);
            actions.appendChild(retryBtn);
            actions.appendChild(dismissBtn);

            content.appendChild(name);
            content.appendChild(subtitle);
            content.appendChild(error);
            content.appendChild(gatedCallout);
            content.appendChild(actions);

            const rowActions = document.createElement("div");
            rowActions.className = "hf-downloader-row-actions";

            const pauseResumeBtn = document.createElement("button");
            pauseResumeBtn.type = "button";
            pauseResumeBtn.className = ACTION_ICON_BTN_CLASS;
            pauseResumeBtn.style.display = "none";

            const cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className = `${ACTION_ICON_BTN_CLASS} hover:text-red-400`;
            cancelBtn.innerHTML = `<i class="icon-[lucide--x] size-4"></i>`;
            cancelBtn.style.display = "none";

            rowActions.appendChild(pauseResumeBtn);
            rowActions.appendChild(cancelBtn);

            const progressContainer = document.createElement("div");
            progressContainer.className = "hf-downloader-progress-container";
            const progressBar = document.createElement("div");
            progressBar.className = "hf-downloader-progress-bar";
            progressContainer.appendChild(progressBar);

            item.appendChild(content);
            item.appendChild(rowActions);
            item.appendChild(progressContainer);

            const refs = {
                root: item,
                name,
                subtitle,
                pauseResumeBtn,
                cancelBtn,
                error,
                gatedCallout,
                gatedText,
                actions,
                agreementHint,
                repoLink,
                retryBtn,
                dismissBtn,
                progressContainer,
                progressBar,
                pauseResumeMode: "none",
                currentDownloadId: "",
                currentIsBackup: false,
                lastStatus: ""
            };

            pauseResumeBtn.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!refs.currentDownloadId || refs.currentIsBackup) return;
                if (refs.pauseResumeMode === "pause") {
                    pauseResumeBtn.disabled = true;
                    void pauseDownload(refs.currentDownloadId, refs.lastStatus);
                } else if (refs.pauseResumeMode === "resume") {
                    pauseResumeBtn.disabled = true;
                    void resumeDownload(refs.currentDownloadId, refs.lastStatus);
                }
            });

            cancelBtn.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!refs.currentDownloadId) return;
                cancelBtn.disabled = true;
                if (refs.currentIsBackup) {
                    void cancelBackupTask(refs.currentDownloadId, refs.lastStatus);
                } else {
                    void cancelDownload(refs.currentDownloadId, refs.lastStatus);
                }
            });

            return refs;
        };

        const buildSubtitleParts = (info) => {
            const isBackup = info._kind === "backup_upload" || info._kind === "backup_download";
            const stText = resolveStatusText(info);
            const parts = [];

            if (info._kind === "backup_upload") {
                parts.push("Backup upload");
                parts.push(isGatedEntry(info) ? "License required" : stText);
                return parts.join(" • ");
            }

            if (info._kind === "backup_download") {
                parts.push("Backup restore");
                parts.push(isGatedEntry(info) ? "License required" : stText);
                if (info.total_files > 0) {
                    parts.push(`${info.completed_files || 0}/${info.total_files} files`);
                }
                return parts.join(" • ");
            }

            parts.push(isGatedEntry(info) ? "License required" : stText);
            const totalBytes = info.total_bytes || 0;
            const downloadedBytes = info.downloaded_bytes || 0;
            if (totalBytes && downloadedBytes && (info.status === "downloading" || info.status === "paused" || info.status === "pausing")) {
                parts.push(`${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`);
            } else if (totalBytes) {
                parts.push(formatBytes(totalBytes));
            } else if (downloadedBytes) {
                parts.push(formatBytes(downloadedBytes));
            }

            if (info.status === "downloading") {
                const spd = formatSpeed(info.speed_bps);
                if (spd) parts.push(spd);
            }

            if (isBackup) return parts.join(" • ");
            return parts.join(" • ");
        };

        const updateItemNode = (refs, info) => {
            refs.lastInfo = info;
            const isBackup = info._kind === "backup_upload" || info._kind === "backup_download";
            refs.root.setAttribute("data-download-id", info.id);
            refs.root.setAttribute("data-entry-kind", info._kind || "download");
            refs.root.setAttribute("data-entry-status", info.status || "queued");

            const rawName = String(info.display_name || info.folder || info.requested_path || info.filename || info.id || "unknown").replace(/\/+$/, "");
            refs.name.textContent = rawName;
            refs.name.title = rawName;
            if (String(info.download_mode || "").toLowerCase() === "folder" && !isBackup) {
                refs.name.style.color = "#f5b14c";
            } else {
                refs.name.style.color = "";
            }

            const isActivelyRunning =
                info.status === "downloading" ||
                info.status === "uploading" ||
                info.status === "copying" ||
                info.status === "cleaning_cache" ||
                info.status === "finalizing" ||
                info.status === "verifying";
            refs.root.classList.toggle("is-active-row", isActivelyRunning);

            const isGated = isGatedEntry(info);
            refs.subtitle.textContent = buildSubtitleParts(info);
            refs.subtitle.style.color = isGated
                ? "var(--warning, #f59e0b)"
                : (info.status === "failed" || info.status === "paused" || info.status === "pausing"
                    ? statusColor(info.status)
                    : "");

            refs.currentDownloadId = info.id;
            refs.currentIsBackup = isBackup;
            refs.lastStatus = info.status || "queued";

            // Pause / Resume button (for model downloads) - only update DOM structure when mode changes so WS ticks never drop clicks
            const nextPauseMode =
                !isBackup && PAUSABLE_STATUSES.has(info.status)
                    ? "pause"
                    : !isBackup && info.status === "paused"
                        ? "resume"
                        : "none";

            if (nextPauseMode === "pause") {
                if (refs.pauseResumeMode !== "pause") {
                    refs.pauseResumeMode = "pause";
                    refs.pauseResumeBtn.style.display = "inline-flex";
                    refs.pauseResumeBtn.setAttribute("data-testid", "hf-item-pause-btn");
                    refs.pauseResumeBtn.title = "Pause download";
                    refs.pauseResumeBtn.setAttribute("aria-label", "Pause download");
                    refs.pauseResumeBtn.innerHTML = `<i class="icon-[lucide--pause] size-3.5"></i>`;
                }
                refs.pauseResumeBtn.disabled = isControlPendingFor(info.id, "pause", info.status);
            } else if (nextPauseMode === "resume") {
                if (refs.pauseResumeMode !== "resume") {
                    refs.pauseResumeMode = "resume";
                    refs.pauseResumeBtn.style.display = "inline-flex";
                    refs.pauseResumeBtn.setAttribute("data-testid", "hf-item-resume-btn");
                    refs.pauseResumeBtn.title = "Resume download";
                    refs.pauseResumeBtn.setAttribute("aria-label", "Resume download");
                    refs.pauseResumeBtn.innerHTML = `<i class="icon-[lucide--play] size-3.5 text-green-400"></i>`;
                }
                refs.pauseResumeBtn.disabled = isControlPendingFor(info.id, "resume", info.status);
            } else if (refs.pauseResumeMode !== "none") {
                refs.pauseResumeMode = "none";
                refs.pauseResumeBtn.style.display = "none";
                refs.pauseResumeBtn.removeAttribute("data-testid");
                refs.pauseResumeBtn.disabled = false;
            }

            // Cancel button (model downloads + backup uploads/downloads)
            const canCancel = CAN_CANCEL_STATUSES.has(info.status);
            if (canCancel) {
                const expectedTestId = isBackup ? "hf-backup-item-cancel-btn" : "hf-item-cancel-btn";
                if (refs.cancelBtn.style.display !== "inline-flex" || refs.cancelBtn.getAttribute("data-testid") !== expectedTestId) {
                    refs.cancelBtn.style.display = "inline-flex";
                    refs.cancelBtn.setAttribute("data-testid", expectedTestId);
                    refs.cancelBtn.title = isBackup ? "Cancel backup task" : "Cancel download";
                    refs.cancelBtn.setAttribute("aria-label", isBackup ? "Cancel backup task" : "Cancel download");
                }
                refs.cancelBtn.disabled =
                    info.status === "cancelling" || isControlPendingFor(info.id, "cancel", info.status);
            } else if (refs.cancelBtn.style.display !== "none") {
                refs.cancelBtn.style.display = "none";
                refs.cancelBtn.removeAttribute("data-testid");
                refs.cancelBtn.disabled = false;
            }

            // Progress bar
            let pct = 0;
            let indeterminate = false;
            if (info._kind === "backup_upload") {
                if (info.status === "uploading" || info.status === "cancelling") {
                    indeterminate = true;
                } else if (SUCCESS_STATUSES.has(info.status)) {
                    pct = 100;
                }
            } else if (info._kind === "backup_download") {
                if (info.status === "downloading") {
                    const tot = info.total_files || 0;
                    const done = info.completed_files || 0;
                    if (tot > 0) {
                        pct = Math.min(100, Math.max(4, (done / tot) * 100));
                    } else {
                        indeterminate = true;
                    }
                } else if (SUCCESS_STATUSES.has(info.status)) {
                    pct = 100;
                }
            } else {
                const totalBytes = info.total_bytes || 0;
                const downloadedBytes = info.downloaded_bytes || 0;
                if (SUCCESS_STATUSES.has(info.status)) {
                    pct = 100;
                } else if (
                    info.status === "downloading" ||
                    info.status === "paused" ||
                    info.status === "pausing" ||
                    info.status === "copying" ||
                    info.status === "finalizing"
                ) {
                    pct = totalBytes ? Math.min(100, Math.max(0, (downloadedBytes / totalBytes) * 100)) : 0;
                }
            }

            const showProgress =
                isActivelyRunning ||
                info.status === "paused" ||
                info.status === "pausing";
            refs.progressContainer.style.display = showProgress ? "block" : "none";
            if (refs.progressBar) {
                refs.progressBar.classList.toggle("indeterminate", indeterminate);
                if (!indeterminate) {
                    refs.progressBar.style.width = `${pct}%`;
                }
                refs.progressBar.style.backgroundColor = statusColor(info.status);
            }

            const errorText = String(info.error || "").trim();
            const isFailed = info.status === "failed";
            let repoUrl = String(info.repo_url || "").trim();
            if (!repoUrl && info.repo_id) {
                repoUrl = `https://huggingface.co/${info.repo_id}`;
            }
            if (!repoUrl) {
                const match = errorText.match(/https:\/\/huggingface\.co\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/i);
                if (match) {
                    repoUrl = match[0].replace(/[.,;:)]+$/, "");
                }
            }
            let repoId = String(info.repo_id || "").trim();
            if (!repoId && repoUrl) {
                const m = repoUrl.match(/https?:\/\/huggingface\.co\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/i);
                if (m) repoId = m[1];
            }
            const retryPayload =
                info.retry_payload && typeof info.retry_payload === "object" ? info.retry_payload : null;
            const needsToken =
                Boolean(info.needs_token) ||
                /add your hugging face token|hf_token/i.test(errorText);

            if (isGated) {
                renderErrorWithLinks(refs.error, "");
                refs.error.title = "";
                refs.error.style.display = "none";
                refs.gatedCallout.style.display = "flex";
                refs.gatedText.textContent = needsToken
                    ? "Gated model — add your HF token in Settings and accept the license."
                    : "Gated model — accept the license on Hugging Face, then retry.";
                refs.gatedCallout.title = errorText;
            } else if (isFailed && errorText) {
                refs.gatedCallout.style.display = "none";
                refs.gatedText.textContent = "";
                refs.gatedCallout.title = "";
                renderErrorWithLinks(refs.error, errorText);
                refs.error.title = errorText;
                refs.error.style.display = "block";
            } else {
                refs.gatedCallout.style.display = "none";
                refs.gatedText.textContent = "";
                refs.gatedCallout.title = "";
                renderErrorWithLinks(refs.error, "");
                refs.error.title = "";
                refs.error.style.display = "none";
            }

            const isInterrupted = !isBackup && info.status === "interrupted";

            refs.root.classList.toggle("has-detail", (isFailed && !!errorText) || isInterrupted || isGated);
            refs.actions.classList.toggle("visible", isGated || isInterrupted);
            refs.agreementHint.textContent = "";
            refs.agreementHint.style.display = "none";

            if (isGated && repoUrl) {
                refs.repoLink.href = repoUrl;
                refs.repoLink.title = repoId
                    ? `Open ${repoId} on Hugging Face`
                    : "Open model page on Hugging Face";
                refs.repoLink.style.display = "inline-flex";
            } else {
                refs.repoLink.removeAttribute("href");
                refs.repoLink.removeAttribute("title");
                refs.repoLink.style.display = "none";
            }

            if (isInterrupted) {
                refs.retryBtn.style.display = "inline-flex";
                refs.retryBtn.textContent = "Resume";
                refs.retryBtn.disabled = !retryPayload;
                refs.retryBtn.onclick = async (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!retryPayload || refs.retryBtn.disabled) return;
                    refs.retryBtn.disabled = true;
                    refs.retryBtn.textContent = "Resuming...";
                    const queued = await resumeInterrupted(info.id);
                    if (queued?.download_id) {
                        dismissedEntryIds.add(info.id);
                    }
                    refs.retryBtn.textContent = queued?.download_id ? "Resumed" : "Resume";
                    if (!queued?.download_id) {
                        refs.retryBtn.disabled = false;
                    }
                };
            } else {
                refs.retryBtn.textContent = "Retry";
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
            }

            if (isInterrupted) {
                refs.dismissBtn.style.display = "inline-flex";
                refs.dismissBtn.onclick = async (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    refs.dismissBtn.disabled = true;
                    refs.dismissBtn.textContent = "Dismissing...";
                    const ok = await dismissInterrupted(info.id);
                    if (ok) {
                        dismissedEntryIds.add(info.id);
                        if (refs.root.parentNode) {
                            refs.root.remove();
                        }
                    } else {
                        refs.dismissBtn.disabled = false;
                        refs.dismissBtn.textContent = "Dismiss";
                    }
                };
            } else {
                refs.dismissBtn.style.display = "none";
                refs.dismissBtn.onclick = null;
            }
        };

        const matchesActiveFilter = (entry) => {
            if (activeFilter === "active") {
                return ACTIVE_NON_TERMINAL_STATUSES.has(entry.status);
            }
            if (activeFilter === "completed") {
                return SUCCESS_STATUSES.has(entry.status);
            }
            if (activeFilter === "failed") {
                return entry.status === "failed" || entry.status === "interrupted" || entry.status === "cancelled";
            }
            return true;
        };

        const renderList = (downloads, backupTasks = {}) => {
            lastRenderedDownloads = downloads || {};
            lastRenderedBackupTasks = backupTasks || {};
            const now = Date.now();

            const rawEntries = [
                ...Object.entries(downloads || {}).map(([id, info]) => ({
                    id,
                    _kind: "download",
                    ...(info || {})
                })),
                ...Object.entries(backupTasks || {}).map(([id, info]) => ({
                    id,
                    _kind: info?.kind || "backup_upload",
                    ...(info || {})
                }))
            ];

            for (const entry of rawEntries) {
                entry.status = toUiStatus(entry.status);

                if (entry.status === "failed") {
                    const ts = entryTimestampMs(entry);
                    if (ts && (now - ts) > FAILED_TTL_MS) {
                        entry._expired = true;
                    }
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
                    (entry) => ACTIVE_NON_TERMINAL_STATUSES.has(entry.status) || entry.status === "failed"
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
            const pausedCount = entries.filter((entry) => entry.status === "paused").length;
            const pausableCount = entries.filter(
                (entry) => entry._kind === "download" && PAUSABLE_STATUSES.has(entry.status)
            ).length;
            const cancelableCount = entries.filter((entry) => CAN_CANCEL_STATUSES.has(entry.status)).length;
            const downloadingCount = entries.filter(
                (entry) => entry.status === "downloading" || entry.status === "uploading"
            ).length;

            if (headerTitleEl) {
                if (runningCount > 0) {
                    headerTitleEl.textContent =
                        runningCount === 1 && downloadingCount === 1
                            ? "1 downloading"
                            : `${runningCount} active`;
                } else if (pausedCount > 0) {
                    headerTitleEl.textContent = `${pausedCount} paused`;
                } else {
                    const failedCount = entries.filter((entry) => entry.status === "failed").length;
                    const gatedFailedCount = entries.filter((entry) => isGatedEntry(entry)).length;
                    if (failedCount > 0) {
                        headerTitleEl.textContent =
                            gatedFailedCount === failedCount
                                ? (gatedFailedCount === 1 ? "1 needs access" : `${gatedFailedCount} need access`)
                                : `${failedCount} failed`;
                    } else {
                        headerTitleEl.textContent = `${entries.length} completed`;
                    }
                }
            }

            if (pauseAllBtn) {
                const nextAllMode = pausableCount > 0 ? "pause" : pausedCount > 0 ? "resume" : "none";
                if (nextAllMode === "pause") {
                    if (pauseAllBtn.dataset.mode !== "pause") {
                        pauseAllBtn.style.display = "inline-flex";
                        pauseAllBtn.dataset.mode = "pause";
                        pauseAllBtn.title = "Pause all downloads";
                        pauseAllBtn.innerHTML = `<i class="icon-[lucide--pause] size-3.5 shrink-0"></i><span>Pause all</span>`;
                    }
                } else if (nextAllMode === "resume") {
                    if (pauseAllBtn.dataset.mode !== "resume") {
                        pauseAllBtn.style.display = "inline-flex";
                        pauseAllBtn.dataset.mode = "resume";
                        pauseAllBtn.title = "Resume all paused downloads";
                        pauseAllBtn.innerHTML = `<i class="icon-[lucide--play] size-3.5 shrink-0"></i><span>Resume all</span>`;
                    }
                } else if (pauseAllBtn.dataset.mode !== "none") {
                    pauseAllBtn.dataset.mode = "none";
                    pauseAllBtn.style.display = "none";
                }
            }

            if (cancelAllBtn) {
                cancelAllBtn.style.display = cancelableCount > 0 ? "inline-flex" : "none";
            }

            const hasFailed = entries.some((entry) => entry.status === "failed");
            const hasNonActive = entries.some((entry) => !ACTIVE_NON_TERMINAL_STATUSES.has(entry.status));
            const hasClearableFinished = entries.some(
                (entry) => !ACTIVE_NON_TERMINAL_STATUSES.has(entry.status) && entry.status !== "failed"
            );

            const showClearFinished = hasClearableFinished;
            const showDismissAll = hasNonActive && (hasFailed || !hasClearableFinished);

            if (clearFinishedBtn) {
                clearFinishedBtn.style.display = showClearFinished ? "inline-flex" : "none";
            }
            if (dismissAllBtn) {
                dismissAllBtn.style.display = showDismissAll ? "inline-flex" : "none";
            }
            footer?.classList.toggle("visible", showClearFinished || showDismissAll);

            const order = {
                failed: 0,
                downloading: 1,
                uploading: 1,
                copying: 2,
                cleaning_cache: 3,
                finalizing: 4,
                pausing: 5,
                paused: 6,
                queued: 7,
                cancelling: 8,
                downloaded: 9,
                cancelled: 10
            };

            const filteredEntries = [...entries];
            filteredEntries.sort((a, b) => {
                const aOrder = order[a.status] ?? 99;
                const bOrder = order[b.status] ?? 99;
                if (aOrder !== bOrder) return aOrder - bOrder;
                const aTime = a.started_at || a.queued_at || 0;
                const bTime = b.started_at || b.queued_at || 0;
                return aTime - bTime;
            });

            const idsInOrder = filteredEntries.map((entry) => entry.id);
            const idsSet = new Set(idsInOrder);

            for (const [id, refs] of itemNodes.entries()) {
                if (!idsSet.has(id)) {
                    refs.root.remove();
                    itemNodes.delete(id);
                }
            }

            for (const info of filteredEntries) {
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
            lastHasRunning = hasAnyActiveOrPaused;
            applyPanelVisibility();
            publishPanelState();
        };

        let hasCompletedInitialPoll = false;
        let lastWsStatusAt = 0;
        let activeWatchdogTimer = null;

        const stopWatchdog = () => {
            if (activeWatchdogTimer) {
                clearInterval(activeWatchdogTimer);
                activeWatchdogTimer = null;
            }
        };

        const syncWatchdogForActivity = (hasActive) => {
            if (!hasActive) {
                stopWatchdog();
                return;
            }
            if (!activeWatchdogTimer) {
                activeWatchdogTimer = setInterval(() => {
                    if (!lastHasRunning) {
                        stopWatchdog();
                        return;
                    }
                    if (Date.now() - lastWsStatusAt > WS_STALE_THRESHOLD_MS) {
                        void pollStatus();
                    }
                }, WATCHDOG_INTERVAL_MS);
            }
        };

        const applyStatusSnapshot = async (data) => {
            if (!data || typeof data !== "object") return;
            const downloads = data.downloads || {};
            const backupTasks = data.backup_tasks || {};
            const completedPaths = [];
            for (const [id, info] of Object.entries(downloads)) {
                if (info && DISK_READY_STATUSES.has(toUiStatus(info.status)) && !processedDownloadIds.has(id)) {
                    processedDownloadIds.add(id);
                    if (hasCompletedInitialPoll) {
                        if (info.path) completedPaths.push(info.path);
                        if (info.filename) completedPaths.push(info.filename);
                    }
                }
            }
            hasCompletedInitialPoll = true;

            const currentIds = new Set(Object.keys(downloads));
            for (const id of processedDownloadIds) {
                if (!currentIds.has(id)) {
                    processedDownloadIds.delete(id);
                }
            }

            if (completedPaths.length > 0) {
                try {
                    const openAutoDownloadDlg = document.getElementById("auto-download-dialog");
                    if (openAutoDownloadDlg && typeof openAutoDownloadDlg.__hfPruneCompletedModels === "function") {
                        openAutoDownloadDlg.__hfPruneCompletedModels(completedPaths);
                    }
                    await forceRefreshModels();
                } catch (e) {
                    console.warn("[HF Downloader] Failed to refresh models after download:", e);
                }
            }

            renderList(downloads, backupTasks);
            syncWatchdogForActivity(lastHasRunning);
        };

        const pollStatus = async () => {
            try {
                const resp = await apiFetch("/download_status");
                if (resp.status !== 200) return;
                const data = await resp.json();
                await applyStatusSnapshot(data);
            } catch (err) {
                console.warn("[HF Downloader] Failed to fetch download status:", err);
            }
        };

        publishPanelState();
        void pollStatus();

        if (api && typeof api.addEventListener === "function") {
            api.addEventListener("hf_download_status", (event) => {
                lastWsStatusAt = Date.now();
                void applyStatusSnapshot(event?.detail);
            });
        }
    }
});
