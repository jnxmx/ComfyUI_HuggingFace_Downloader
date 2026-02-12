import { app } from "../../../scripts/app.js";

const MODEL_LIBRARY_SETTING_ID = "downloader.model_library_backend_enabled";
const MODEL_LIBRARY_DIALOG_ID = "hf-model-library-dialog";
const MODEL_LIBRARY_REFRESH_LIMIT = 5000;
const POLL_INTERVAL_MS = 1500;
const MODEL_LIBRARY_COMMAND_IDS = [
  "Workspace.ToggleSidebarTab.model-library",
  "Comfy.BrowseModelAssets",
];
const COMMAND_OVERRIDE_MARKER = "__hfDownloaderModelLibraryOverride";
const COMMAND_ORIGINAL_FN = "__hfDownloaderModelLibraryOriginalFn";
const COMMAND_OVERRIDE_RETRY_MS = 500;
const COMMAND_OVERRIDE_MAX_ATTEMPTS = 40;

app.registerExtension({
  name: "hfDownloaderModelLibrary",
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
        console.log(`[HF Model Library] ${summary}${payload.detail || "Notification"}`);
      }
    };

    const requestJson = async (url, init = {}) => {
      const options = { ...init };
      if (options.body && !options.headers) {
        options.headers = { "Content-Type": "application/json" };
      }
      const response = await fetch(url, options);
      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }
      if (!response.ok) {
        const message = data?.error || `Request failed (${response.status})`;
        throw new Error(message);
      }
      return data || {};
    };

    const getBackendSettingEnabled = () => {
      const settingsUi = app?.ui?.settings;
      if (!settingsUi?.getSettingValue) {
        return true;
      }
      const value = settingsUi.getSettingValue(MODEL_LIBRARY_SETTING_ID);
      return value !== false;
    };

    const normalizePath = (value) => String(value || "").replace(/\\/g, "/");

    const toModelRelativePath = (value) => {
      const normalized = normalizePath(value);
      const marker = "/models/";
      const idx = normalized.toLowerCase().indexOf(marker);
      if (idx === -1) return normalized;
      return normalized.slice(idx + marker.length);
    };

    const formatBytes = (value) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return "-";
      }
      const units = ["B", "KB", "MB", "GB", "TB"];
      let size = value;
      let unitIdx = 0;
      while (size >= 1024 && unitIdx < units.length - 1) {
        size /= 1024;
        unitIdx += 1;
      }
      return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIdx]}`;
    };

    const createActionButton = (text, onClick, variant = "secondary") => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      const palette = {
        primary: {
          bg: "var(--primary-background, #1f9cf0)",
          hover: "var(--primary-background-hover, #2b83f6)",
          fg: "var(--base-foreground, #ffffff)",
        },
        secondary: {
          bg: "var(--secondary-background, #353944)",
          hover: "var(--secondary-background-hover, #444b58)",
          fg: "var(--base-foreground, #ffffff)",
        },
      };
      const selected = palette[variant] || palette.secondary;
      Object.assign(button.style, {
        minHeight: "34px",
        padding: "0.35rem 0.9rem",
        borderRadius: "8px",
        border: "none",
        background: selected.bg,
        color: selected.fg,
        fontSize: "12px",
        fontWeight: "600",
        cursor: "pointer",
        transition: "background-color 120ms ease, opacity 120ms ease",
      });
      button.addEventListener("mouseenter", () => {
        if (!button.disabled) {
          button.style.background = selected.hover;
        }
      });
      button.addEventListener("mouseleave", () => {
        button.style.background = selected.bg;
      });
      if (typeof onClick === "function") {
        button.addEventListener("click", onClick);
      }
      return button;
    };

    const buildDownloadPayload = (item) => {
      const folder = (item.directory || "checkpoints").trim() || "checkpoints";
      return {
        filename: item.filename,
        folder,
        url: item.url,
        overwrite: false,
      };
    };

    const showModelLibraryDialog = () => {
      if (!getBackendSettingEnabled()) {
        showToast(
          {
            severity: "warn",
            summary: "Model Library backend disabled",
            detail: 'Enable "Use as Model Library backend" in settings.',
            life: 4500,
          },
          "warn"
        );
        return;
      }

      const existing = document.getElementById(MODEL_LIBRARY_DIALOG_ID);
      if (existing) {
        existing.remove();
      }

      const state = {
        items: [],
        filteredItems: [],
        selectedKey: "",
        queuedDownloads: new Map(),
        pollTimer: null,
        loading: false,
        query: "",
        status: "all",
        directory: "all",
        type: "all",
      };

      const overlay = document.createElement("div");
      overlay.id = MODEL_LIBRARY_DIALOG_ID;
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        background: "rgba(0, 0, 0, 0.55)",
        zIndex: "10010",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "14px",
        boxSizing: "border-box",
      });

      const panel = document.createElement("div");
      Object.assign(panel.style, {
        width: "min(1320px, 98vw)",
        maxHeight: "94vh",
        background: "var(--comfy-menu-bg, #202020)",
        color: "var(--input-text, #ddd)",
        border: "1px solid var(--border-subtle, var(--border-default, #3f434c))",
        borderRadius: "16px",
        boxShadow: "1px 1px 8px rgba(0,0,0,0.45)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: "var(--font-inter, Inter, sans-serif)",
      });

      const header = document.createElement("div");
      Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        height: "70px",
        padding: "0 20px",
        borderBottom: "1px solid var(--border-default, var(--border-color, #4e4e4e))",
        flexShrink: "0",
      });

      const titleWrap = document.createElement("div");
      const title = document.createElement("div");
      title.textContent = "Model Library";
      Object.assign(title.style, {
        fontSize: "16px",
        fontWeight: "600",
        lineHeight: "1.1",
      });
      const subtitle = document.createElement("div");
      subtitle.textContent = "Local backend with installed model discovery (HuggingFace only)";
      Object.assign(subtitle.style, {
        fontSize: "12px",
        color: "var(--descrip-text, #9aa4b6)",
        marginTop: "4px",
      });
      titleWrap.appendChild(title);
      titleWrap.appendChild(subtitle);

      const headerActions = document.createElement("div");
      Object.assign(headerActions.style, { display: "flex", alignItems: "center", gap: "8px" });
      const refreshButton = createActionButton("Refresh", () => {
        void loadLibrary();
      });
      const closeButton = createActionButton("Close", () => {
        closeDialog();
      });
      headerActions.appendChild(refreshButton);
      headerActions.appendChild(closeButton);

      header.appendChild(titleWrap);
      header.appendChild(headerActions);

      const controls = document.createElement("div");
      Object.assign(controls.style, {
        display: "grid",
        gridTemplateColumns: "minmax(240px, 2fr) repeat(3, minmax(130px, 1fr))",
        gap: "10px",
        padding: "12px 20px",
        borderBottom: "1px solid var(--border-default, var(--border-color, #4e4e4e))",
        flexShrink: "0",
      });

      const searchInput = document.createElement("input");
      searchInput.type = "text";
      searchInput.placeholder = "Search filename, URL, type...";
      Object.assign(searchInput.style, {
        background: "var(--comfy-input-bg, #222)",
        border: "1px solid var(--border-color, #4e4e4e)",
        color: "var(--input-text, #ddd)",
        padding: "8px 11px",
        borderRadius: "8px",
        width: "100%",
        minHeight: "36px",
        boxSizing: "border-box",
      });

      const statusSelect = document.createElement("select");
      const directorySelect = document.createElement("select");
      const typeSelect = document.createElement("select");
      [statusSelect, directorySelect, typeSelect].forEach((select) => {
        Object.assign(select.style, {
          background: "var(--comfy-input-bg, #222)",
          border: "1px solid var(--border-color, #4e4e4e)",
          color: "var(--input-text, #ddd)",
          padding: "8px 11px",
          borderRadius: "8px",
          width: "100%",
          minHeight: "36px",
        });
      });

      const setSelectOptions = (select, options, defaultValue = "all") => {
        select.innerHTML = "";
        for (const option of options) {
          const el = document.createElement("option");
          el.value = option.value;
          el.textContent = option.label;
          select.appendChild(el);
        }
        select.value = defaultValue;
      };

      setSelectOptions(statusSelect, [
        { value: "all", label: "All statuses" },
        { value: "installed", label: "Installed" },
        { value: "missing", label: "Not installed" },
      ]);
      setSelectOptions(directorySelect, [{ value: "all", label: "All directories" }]);
      setSelectOptions(typeSelect, [{ value: "all", label: "All types" }]);

      controls.appendChild(searchInput);
      controls.appendChild(statusSelect);
      controls.appendChild(directorySelect);
      controls.appendChild(typeSelect);

      const content = document.createElement("div");
      Object.assign(content.style, {
        display: "grid",
        gridTemplateColumns: "minmax(0, 3fr) minmax(280px, 1.2fr)",
        gap: "0",
        minHeight: "0",
        flex: "1",
      });

      const listPane = document.createElement("div");
      Object.assign(listPane.style, {
        minWidth: "0",
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid var(--border-default, var(--border-color, #4e4e4e))",
        minHeight: "0",
      });

      const summaryBar = document.createElement("div");
      Object.assign(summaryBar.style, {
        padding: "10px 14px",
        fontSize: "12px",
        color: "var(--descrip-text, #9aa4b6)",
        borderBottom: "1px solid var(--border-default, var(--border-color, #4e4e4e))",
      });
      summaryBar.textContent = "Loading...";

      const tableWrap = document.createElement("div");
      Object.assign(tableWrap.style, {
        overflowY: "auto",
        minHeight: "0",
      });
      const table = document.createElement("table");
      Object.assign(table.style, {
        width: "100%",
        borderCollapse: "collapse",
        tableLayout: "fixed",
      });

      const thead = document.createElement("thead");
      thead.innerHTML = `
        <tr>
          <th style="text-align:left;padding:10px 12px;font-size:11px;color:#95a1b6;border-bottom:1px solid var(--border-default, #3f434c);width:33%;">Model</th>
          <th style="text-align:left;padding:10px 12px;font-size:11px;color:#95a1b6;border-bottom:1px solid var(--border-default, #3f434c);width:14%;">Type</th>
          <th style="text-align:left;padding:10px 12px;font-size:11px;color:#95a1b6;border-bottom:1px solid var(--border-default, #3f434c);width:20%;">Directory</th>
          <th style="text-align:left;padding:10px 12px;font-size:11px;color:#95a1b6;border-bottom:1px solid var(--border-default, #3f434c);width:13%;">Status</th>
          <th style="text-align:left;padding:10px 12px;font-size:11px;color:#95a1b6;border-bottom:1px solid var(--border-default, #3f434c);width:20%;">Action</th>
        </tr>
      `;
      const tbody = document.createElement("tbody");
      table.appendChild(thead);
      table.appendChild(tbody);
      tableWrap.appendChild(table);

      listPane.appendChild(summaryBar);
      listPane.appendChild(tableWrap);

      const detailPane = document.createElement("div");
      Object.assign(detailPane.style, {
        display: "flex",
        flexDirection: "column",
        minHeight: "0",
      });

      const detailHeader = document.createElement("div");
      detailHeader.textContent = "Model Info";
      Object.assign(detailHeader.style, {
        padding: "10px 14px",
        fontSize: "13px",
        fontWeight: "600",
        borderBottom: "1px solid var(--border-default, var(--border-color, #4e4e4e))",
      });
      const detailBody = document.createElement("div");
      Object.assign(detailBody.style, {
        padding: "12px 14px",
        overflowY: "auto",
        fontSize: "12px",
        color: "var(--descrip-text, #9aa4b6)",
        minHeight: "0",
      });
      detailBody.textContent = "Select a model row to inspect details.";

      detailPane.appendChild(detailHeader);
      detailPane.appendChild(detailBody);

      content.appendChild(listPane);
      content.appendChild(detailPane);

      panel.appendChild(header);
      panel.appendChild(controls);
      panel.appendChild(content);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      const closeDialog = () => {
        if (state.pollTimer) {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
        }
        if (overlay.parentElement) {
          overlay.remove();
        }
      };

      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
          closeDialog();
        }
      });

      const selectedItem = () =>
        state.filteredItems.find((item) => String(item.filename) === state.selectedKey) || null;

      const renderDetails = () => {
        const item = selectedItem();
        if (!item) {
          detailBody.textContent = "Select a model row to inspect details.";
          return;
        }
        detailBody.innerHTML = "";

        const addField = (label, value) => {
          const block = document.createElement("div");
          block.style.marginBottom = "9px";
          const key = document.createElement("div");
          key.textContent = label;
          Object.assign(key.style, {
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "#8f97a5",
            marginBottom: "2px",
          });
          const val = document.createElement("div");
          val.textContent = value || "-";
          Object.assign(val.style, {
            color: "var(--input-text, #ddd)",
            wordBreak: "break-word",
          });
          block.appendChild(key);
          block.appendChild(val);
          detailBody.appendChild(block);
        };

        addField("Filename", item.filename);
        addField("Type", item.manager_type || item.type || "-");
        addField("Directory", item.directory || "-");
        addField("Provider", item.provider || "-");
        addField("Source", item.source_kind || item.source || "-");
        addField("Installed", item.installed ? "Yes" : "No");
        addField("Installed Paths", (item.installed_paths || []).join("\n") || "-");
        addField("Size", formatBytes(item.installed_bytes_total));

        if (item.url) {
          const urlBlock = document.createElement("div");
          urlBlock.style.marginTop = "8px";
          const urlLink = document.createElement("a");
          urlLink.href = item.url;
          urlLink.target = "_blank";
          urlLink.rel = "noreferrer";
          urlLink.textContent = "Open HuggingFace link";
          Object.assign(urlLink.style, {
            color: "#7cb3ff",
            textDecoration: "none",
            fontSize: "12px",
          });
          urlBlock.appendChild(urlLink);
          detailBody.appendChild(urlBlock);
        }
      };

      const setDirectoryAndTypeOptions = (items) => {
        const directoryCounts = new Map();
        const typeCounts = new Map();
        for (const item of items) {
          const directory = (item.directory || "").trim();
          if (directory) {
            directoryCounts.set(directory, (directoryCounts.get(directory) || 0) + 1);
          }
          const itemType = (item.manager_type || item.type || "").trim();
          if (itemType) {
            typeCounts.set(itemType, (typeCounts.get(itemType) || 0) + 1);
          }
        }
        const directoryOptions = [{ value: "all", label: "All directories" }].concat(
          Array.from(directoryCounts.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([name, count]) => ({ value: name, label: `${name} (${count})` }))
        );
        const typeOptions = [{ value: "all", label: "All types" }].concat(
          Array.from(typeCounts.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([name, count]) => ({ value: name, label: `${name} (${count})` }))
        );
        const prevDirectory = state.directory;
        const prevType = state.type;
        setSelectOptions(directorySelect, directoryOptions, "all");
        setSelectOptions(typeSelect, typeOptions, "all");
        if (directoryOptions.some((x) => x.value === prevDirectory)) {
          directorySelect.value = prevDirectory;
        }
        if (typeOptions.some((x) => x.value === prevType)) {
          typeSelect.value = prevType;
        }
      };

      const applyLocalFilters = () => {
        const q = state.query.trim().toLowerCase();
        const next = state.items.filter((item) => {
          const installed = Boolean(item.installed);
          if (state.status === "installed" && !installed) return false;
          if (state.status === "missing" && installed) return false;
          if (state.directory !== "all" && (item.directory || "") !== state.directory) return false;
          const itemType = (item.manager_type || item.type || "").trim();
          if (state.type !== "all" && itemType !== state.type) return false;
          if (q) {
            const haystack = [
              item.filename || "",
              item.url || "",
              item.type || "",
              item.manager_type || "",
              item.directory || "",
              item.provider || "",
            ]
              .join(" ")
              .toLowerCase();
            if (!haystack.includes(q)) return false;
          }
          return true;
        });
        state.filteredItems = next;
      };

      const markInstalled = (filename, localPath) => {
        const name = String(filename || "").toLowerCase();
        if (!name) return;
        for (const item of state.items) {
          if (String(item.filename || "").toLowerCase() !== name) continue;
          item.installed = true;
          item.downloadable = false;
          item.installed_count = Number(item.installed_count || 0) + 1;
          const relPath = toModelRelativePath(localPath || "");
          if (!Array.isArray(item.installed_paths)) item.installed_paths = [];
          if (relPath && !item.installed_paths.includes(relPath)) {
            item.installed_paths.push(relPath);
          }
        }
      };

      const statusPill = (item) => {
        if (item.installed) {
          return { text: "Installed", color: "#57d88f", bg: "rgba(63, 162, 102, 0.18)" };
        }
        if (item.__queueState) {
          if (item.__queueState === "failed") {
            return { text: "Failed", color: "#ff8f8f", bg: "rgba(184, 70, 70, 0.18)" };
          }
          return { text: "Queued", color: "#8cc4ff", bg: "rgba(67, 124, 190, 0.2)" };
        }
        return { text: "Missing", color: "#f4c16e", bg: "rgba(155, 117, 57, 0.2)" };
      };

      const refreshSummary = () => {
        const total = state.filteredItems.length;
        const installed = state.filteredItems.filter((x) => x.installed).length;
        const missing = total - installed;
        const localOnly = state.filteredItems.filter((x) => x.source_kind === "local").length;
        summaryBar.textContent = `Total: ${total} • Installed: ${installed} • Missing: ${missing} • Local-only: ${localOnly}`;
      };

      const renderList = () => {
        applyLocalFilters();
        refreshSummary();

        tbody.innerHTML = "";
        if (!state.filteredItems.length) {
          const tr = document.createElement("tr");
          const td = document.createElement("td");
          td.colSpan = 5;
          td.textContent = state.loading ? "Loading model library..." : "No models match current filters.";
          Object.assign(td.style, {
            padding: "16px 12px",
            color: "var(--descrip-text, #9aa4b6)",
            fontSize: "12px",
          });
          tr.appendChild(td);
          tbody.appendChild(tr);
          renderDetails();
          return;
        }

        if (!selectedItem()) {
          state.selectedKey = String(state.filteredItems[0]?.filename || "");
        }

        for (const item of state.filteredItems) {
          const tr = document.createElement("tr");
          tr.style.cursor = "pointer";
          const isSelected = String(item.filename) === state.selectedKey;
          tr.style.background = isSelected
            ? "color-mix(in srgb, var(--comfy-menu-bg, #202020) 78%, var(--base-foreground, #fff) 22%)"
            : "transparent";
          tr.addEventListener("mouseenter", () => {
            if (!isSelected) tr.style.background = "rgba(116, 133, 161, 0.12)";
          });
          tr.addEventListener("mouseleave", () => {
            tr.style.background = isSelected
              ? "color-mix(in srgb, var(--comfy-menu-bg, #202020) 78%, var(--base-foreground, #fff) 22%)"
              : "transparent";
          });
          tr.addEventListener("click", () => {
            state.selectedKey = String(item.filename);
            renderList();
          });

          const tdName = document.createElement("td");
          tdName.textContent = item.filename || "-";
          Object.assign(tdName.style, {
            padding: "10px 12px",
            fontSize: "12px",
            color: "var(--input-text, #ddd)",
            wordBreak: "break-word",
          });

          const tdType = document.createElement("td");
          tdType.textContent = item.manager_type || item.type || "-";
          Object.assign(tdType.style, {
            padding: "10px 12px",
            fontSize: "12px",
            color: "var(--descrip-text, #b3bccd)",
          });

          const tdDir = document.createElement("td");
          tdDir.textContent = item.directory || "-";
          Object.assign(tdDir.style, {
            padding: "10px 12px",
            fontSize: "12px",
            color: "var(--descrip-text, #b3bccd)",
            wordBreak: "break-word",
          });

          const tdStatus = document.createElement("td");
          const pill = statusPill(item);
          const badge = document.createElement("span");
          badge.textContent = pill.text;
          Object.assign(badge.style, {
            display: "inline-block",
            borderRadius: "999px",
            padding: "3px 8px",
            fontSize: "11px",
            fontWeight: "600",
            color: pill.color,
            background: pill.bg,
          });
          tdStatus.style.padding = "10px 12px";
          tdStatus.appendChild(badge);

          const tdAction = document.createElement("td");
          tdAction.style.padding = "10px 12px";

          if (item.installed) {
            const useButton = createActionButton("Use", async (event) => {
              event.stopPropagation();
              const value = (item.installed_paths && item.installed_paths[0]) || item.filename || "";
              try {
                if (navigator.clipboard?.writeText) {
                  await navigator.clipboard.writeText(value);
                  showToast({
                    severity: "success",
                    summary: "Copied",
                    detail: `Copied "${value}" to clipboard.`,
                    life: 2600,
                  });
                }
              } catch (_) {
                showToast({
                  severity: "info",
                  summary: "Use model",
                  detail: value,
                  life: 3000,
                });
              }
            });
            tdAction.appendChild(useButton);
          } else if (item.downloadable && item.url) {
            const queueState = item.__queueState;
            const isBusy = queueState === "queued" || queueState === "downloading";
            const downloadButton = createActionButton(
              isBusy ? "Queued" : "Download",
              async (event) => {
                event.stopPropagation();
                if (isBusy) return;
                try {
                  item.__queueState = "queued";
                  renderList();
                  const payload = { models: [buildDownloadPayload(item)] };
                  const response = await requestJson("/queue_download", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                  });
                  if (Array.isArray(response.rejected) && response.rejected.length) {
                    item.__queueState = "failed";
                    renderList();
                    showToast({
                      severity: "error",
                      summary: "Queue rejected",
                      detail: response.rejected[0]?.error || "Model rejected by backend",
                      life: 5000,
                    });
                    return;
                  }
                  const queuedItem = Array.isArray(response.queued) ? response.queued[0] : null;
                  if (queuedItem?.download_id) {
                    state.queuedDownloads.set(queuedItem.download_id, {
                      filename: item.filename,
                    });
                  }
                  startPolling();
                  showToast({
                    severity: "success",
                    summary: "Queued",
                    detail: `${item.filename} queued for download.`,
                    life: 3200,
                  });
                } catch (error) {
                  item.__queueState = "failed";
                  renderList();
                  showToast({
                    severity: "error",
                    summary: "Queue failed",
                    detail: error?.message || String(error),
                    life: 5200,
                  });
                }
              },
              "primary"
            );
            downloadButton.disabled = isBusy;
            tdAction.appendChild(downloadButton);
          } else {
            const span = document.createElement("span");
            span.textContent = "Unavailable";
            Object.assign(span.style, {
              fontSize: "11px",
              color: "#8d97a8",
            });
            tdAction.appendChild(span);
          }

          tr.appendChild(tdName);
          tr.appendChild(tdType);
          tr.appendChild(tdDir);
          tr.appendChild(tdStatus);
          tr.appendChild(tdAction);
          tbody.appendChild(tr);
        }
        renderDetails();
      };

      const updateFiltersFromInputs = () => {
        state.query = searchInput.value || "";
        state.status = statusSelect.value || "all";
        state.directory = directorySelect.value || "all";
        state.type = typeSelect.value || "all";
        renderList();
      };

      searchInput.addEventListener("input", updateFiltersFromInputs);
      statusSelect.addEventListener("change", updateFiltersFromInputs);
      directorySelect.addEventListener("change", updateFiltersFromInputs);
      typeSelect.addEventListener("change", updateFiltersFromInputs);

      const startPolling = () => {
        if (state.pollTimer) return;
        state.pollTimer = setInterval(async () => {
          if (!state.queuedDownloads.size) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
            return;
          }
          const ids = Array.from(state.queuedDownloads.keys());
          try {
            const status = await requestJson(`/download_status?ids=${encodeURIComponent(ids.join(","))}`);
            const downloads = status?.downloads || {};
            for (const id of ids) {
              const itemStatus = downloads[id];
              if (!itemStatus) continue;
              const current = String(itemStatus.status || "");
              const modelMeta = state.queuedDownloads.get(id);
              if (!modelMeta) continue;

              if (current === "queued" || current === "downloading" || current === "copying" || current === "finalizing" || current === "cleaning_cache") {
                const name = String(modelMeta.filename || "").toLowerCase();
                for (const item of state.items) {
                  if (String(item.filename || "").toLowerCase() === name) {
                    item.__queueState = "downloading";
                  }
                }
                continue;
              }

              if (current === "downloaded" || current === "completed") {
                markInstalled(modelMeta.filename, itemStatus.path || "");
                const name = String(modelMeta.filename || "").toLowerCase();
                for (const item of state.items) {
                  if (String(item.filename || "").toLowerCase() === name) {
                    item.__queueState = "";
                  }
                }
                state.queuedDownloads.delete(id);
                showToast({
                  severity: "success",
                  summary: "Downloaded",
                  detail: `${modelMeta.filename} downloaded.`,
                  life: 2600,
                });
                continue;
              }

              if (current === "failed" || current === "cancelled") {
                const name = String(modelMeta.filename || "").toLowerCase();
                for (const item of state.items) {
                  if (String(item.filename || "").toLowerCase() === name) {
                    item.__queueState = "failed";
                  }
                }
                state.queuedDownloads.delete(id);
                showToast({
                  severity: "warn",
                  summary: current === "failed" ? "Download failed" : "Download cancelled",
                  detail: itemStatus.error || modelMeta.filename,
                  life: 4200,
                });
              }
            }
            renderList();
          } catch (_) {
            // Keep poller alive; transient network/backend errors should not close dialog.
          }
        }, POLL_INTERVAL_MS);
      };

      const loadLibrary = async () => {
        state.loading = true;
        summaryBar.textContent = "Loading model library...";
        renderList();
        try {
          const params = new URLSearchParams({
            hf_only: "true",
            visible_only: "true",
            include_catalog: "true",
            include_local_only: "true",
            sort: "installed",
            limit: String(MODEL_LIBRARY_REFRESH_LIMIT),
            offset: "0",
          });
          const response = await requestJson(`/model_library?${params.toString()}`);
          const items = Array.isArray(response.items) ? response.items : [];
          state.items = items;
          setDirectoryAndTypeOptions(items);
          if (!state.selectedKey && items.length) {
            state.selectedKey = String(items[0].filename || "");
          }
          renderList();
        } catch (error) {
          state.items = [];
          renderList();
          showToast({
            severity: "error",
            summary: "Model Library error",
            detail: error?.message || String(error),
            life: 5200,
          });
        } finally {
          state.loading = false;
          renderList();
        }
      };

      void loadLibrary();
    };

    const installModelLibraryCommandOverrides = () => {
      let attempts = 0;
      let timer = null;

      const applyOverride = (commandId) => {
        const commands = app?.extensionManager?.command?.commands;
        if (!Array.isArray(commands)) {
          return false;
        }
        const command = commands.find((entry) => entry?.id === commandId);
        if (!command || typeof command.function !== "function") {
          return false;
        }
        if (command[COMMAND_OVERRIDE_MARKER]) {
          return true;
        }

        const originalFn = command.function;
        command[COMMAND_ORIGINAL_FN] = originalFn;
        command.function = async (metadata) => {
          if (getBackendSettingEnabled()) {
            showModelLibraryDialog();
            return;
          }
          const fallback = command[COMMAND_ORIGINAL_FN];
          if (typeof fallback === "function") {
            return await fallback(metadata);
          }
        };
        command[COMMAND_OVERRIDE_MARKER] = true;
        return true;
      };

      const runAttempt = () => {
        attempts += 1;
        let allApplied = true;
        for (const commandId of MODEL_LIBRARY_COMMAND_IDS) {
          if (!applyOverride(commandId)) {
            allApplied = false;
          }
        }

        if (allApplied || attempts >= COMMAND_OVERRIDE_MAX_ATTEMPTS) {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          if (!allApplied) {
            console.warn("[HF Model Library] Could not override all native Model Library commands.");
          }
        }
        return allApplied;
      };

      const firstApplied = runAttempt();
      if (!firstApplied && attempts < COMMAND_OVERRIDE_MAX_ATTEMPTS) {
        timer = setInterval(runAttempt, COMMAND_OVERRIDE_RETRY_MS);
      }
    };

    registerGlobalAction("showModelLibraryDialog", showModelLibraryDialog);
    installModelLibraryCommandOverrides();
  },
});
