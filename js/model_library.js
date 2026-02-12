import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const MODEL_LIBRARY_SETTING_ID = "downloader.model_library_backend_enabled";
const ASSETS_ROUTE_PREFIX = "/assets";
const MODEL_LIBRARY_ASSET_ROUTE_PREFIX = "/hf_model_library_assets";
const FETCH_OVERRIDE_MARKER = "__hfDownloaderModelLibraryFetchOverride";
const FETCH_OVERRIDE_ORIGINAL = "__hfDownloaderModelLibraryOriginalFetch";

const getBackendSettingEnabled = () => {
  const settingsUi = app?.ui?.settings;
  if (!settingsUi?.getSettingValue) {
    return true;
  }
  return settingsUi.getSettingValue(MODEL_LIBRARY_SETTING_ID) !== false;
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

app.registerExtension({
  name: "hfDownloaderModelLibraryBackend",
  setup() {
    installFetchApiOverride();
  },
});
