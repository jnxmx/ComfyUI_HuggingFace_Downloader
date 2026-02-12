import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const MODEL_LIBRARY_SETTING_ID = "downloader.model_library_backend_enabled";
const ASSET_API_SETTING_ID = "Comfy.Assets.UseAssetAPI";
const ASSETS_ROUTE_PREFIX = "/assets";
const MODEL_LIBRARY_ASSET_ROUTE_PREFIX = "/hf_model_library_assets";
const FETCH_OVERRIDE_MARKER = "__hfDownloaderModelLibraryFetchOverride";
const FETCH_OVERRIDE_ORIGINAL = "__hfDownloaderModelLibraryOriginalFetch";
const MODEL_LIBRARY_COMMAND_IDS = [
  "Workspace.ToggleSidebarTab.model-library",
  "Comfy.BrowseModelAssets",
];
const COMMAND_OVERRIDE_MARKER = "__hfDownloaderModelLibraryCommandOverride";
const COMMAND_OVERRIDE_ORIGINAL_FN = "__hfDownloaderModelLibraryCommandOriginalFn";
const COMMAND_OVERRIDE_RETRY_MS = 500;
const COMMAND_OVERRIDE_MAX_ATTEMPTS = 40;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getBackendSettingEnabled = () => {
  const settingsUi = app?.ui?.settings;
  if (!settingsUi?.getSettingValue) {
    return true;
  }
  return settingsUi.getSettingValue(MODEL_LIBRARY_SETTING_ID) !== false;
};

const getAssetApiEnabled = () => {
  const settingsUi = app?.ui?.settings;
  if (!settingsUi?.getSettingValue) {
    return true;
  }
  return settingsUi.getSettingValue(ASSET_API_SETTING_ID) === true;
};

const ensureAssetApiEnabledForNativeLibrary = async () => {
  if (!getBackendSettingEnabled()) {
    return;
  }
  if (getAssetApiEnabled()) {
    return;
  }

  const settingsUi = app?.ui?.settings;
  if (!settingsUi) {
    return;
  }

  try {
    if (typeof settingsUi.setSettingValueAsync === "function") {
      await settingsUi.setSettingValueAsync(ASSET_API_SETTING_ID, true);
    } else if (typeof settingsUi.setSettingValue === "function") {
      settingsUi.setSettingValue(ASSET_API_SETTING_ID, true);
    }
  } catch (error) {
    console.warn("[HF Model Library] Failed to enable Comfy.Assets.UseAssetAPI:", error);
    return;
  }

  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (getAssetApiEnabled()) {
      return;
    }
    await wait(100);
  }
};

const normalizeRoute = (route) => {
  const value = String(route || "").trim();
  if (!value) return "/";
  return value.startsWith("/") ? value : `/${value}`;
};

const splitRoute = (route) => {
  const normalized = normalizeRoute(route);
  const index = normalized.indexOf("?");
  if (index === -1) {
    return { path: normalized, query: "" };
  }
  return {
    path: normalized.slice(0, index),
    query: normalized.slice(index + 1),
  };
};

const getMethod = (options) => String(options?.method || "GET").toUpperCase();

const includeTagsContainModels = (query) => {
  const params = new URLSearchParams(query || "");
  const includeTags = params.get("include_tags") || "";
  if (!includeTags) return false;
  return includeTags
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .includes("models");
};

const isAssetDetailPath = (path) => /^\/assets\/[^/]+$/.test(path);
const isAssetTagsPath = (path) => /^\/assets\/[^/]+\/tags$/.test(path);

const shouldInterceptRoute = (path, query, method) => {
  if (path === ASSETS_ROUTE_PREFIX && method === "GET") {
    return includeTagsContainModels(query);
  }
  if (path === `${ASSETS_ROUTE_PREFIX}/download` && method === "POST") {
    return true;
  }
  if (path === `${ASSETS_ROUTE_PREFIX}/remote-metadata` && method === "GET") {
    return true;
  }
  if (isAssetDetailPath(path) && (method === "GET" || method === "PUT")) {
    return true;
  }
  if (isAssetTagsPath(path) && (method === "POST" || method === "DELETE")) {
    return true;
  }
  return false;
};

const rewriteRoute = (path, query) => {
  if (path === ASSETS_ROUTE_PREFIX) {
    return `${MODEL_LIBRARY_ASSET_ROUTE_PREFIX}${query ? `?${query}` : ""}`;
  }
  if (path.startsWith(`${ASSETS_ROUTE_PREFIX}/`)) {
    const suffix = path.slice(ASSETS_ROUTE_PREFIX.length);
    return `${MODEL_LIBRARY_ASSET_ROUTE_PREFIX}${suffix}${query ? `?${query}` : ""}`;
  }
  return `${path}${query ? `?${query}` : ""}`;
};

const shouldFallbackToNativeAssets = (path) => {
  if (path === `${ASSETS_ROUTE_PREFIX}/download`) return false;
  if (path === `${ASSETS_ROUTE_PREFIX}/remote-metadata`) return false;
  if (path === ASSETS_ROUTE_PREFIX) return false;
  return isAssetDetailPath(path) || isAssetTagsPath(path);
};

const installFetchApiOverride = () => {
  if (!api || api[FETCH_OVERRIDE_MARKER]) {
    return;
  }

  const originalFetchApi = api.fetchApi.bind(api);
  api[FETCH_OVERRIDE_ORIGINAL] = originalFetchApi;

  api.fetchApi = async (route, options = {}) => {
    const method = getMethod(options);
    const { path, query } = splitRoute(route);

    if (!getBackendSettingEnabled()) {
      return originalFetchApi(normalizeRoute(route), options);
    }

    if (!shouldInterceptRoute(path, query, method)) {
      return originalFetchApi(normalizeRoute(route), options);
    }

    const rewrittenRoute = rewriteRoute(path, query);
    const response = await originalFetchApi(rewrittenRoute, options);

    if (
      response?.status === 404 &&
      shouldFallbackToNativeAssets(path)
    ) {
      return originalFetchApi(normalizeRoute(route), options);
    }

    return response;
  };

  api[FETCH_OVERRIDE_MARKER] = true;
};

const installNativeModelLibraryCommandOverrides = () => {
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
    command[COMMAND_OVERRIDE_ORIGINAL_FN] = originalFn;
    command.function = async (metadata) => {
      if (getBackendSettingEnabled()) {
        await ensureAssetApiEnabledForNativeLibrary();
      }
      const fallback = command[COMMAND_OVERRIDE_ORIGINAL_FN];
      return typeof fallback === "function" ? await fallback(metadata) : undefined;
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
        console.warn("[HF Model Library] Could not override native Model Library commands.");
      }
    }
    return allApplied;
  };

  const firstApplied = runAttempt();
  if (!firstApplied && attempts < COMMAND_OVERRIDE_MAX_ATTEMPTS) {
    timer = setInterval(runAttempt, COMMAND_OVERRIDE_RETRY_MS);
  }
};

app.registerExtension({
  name: "hfDownloaderModelLibraryBackend",
  async setup() {
    installFetchApiOverride();
    installNativeModelLibraryCommandOverrides();
    await ensureAssetApiEnabledForNativeLibrary();
  },
});
