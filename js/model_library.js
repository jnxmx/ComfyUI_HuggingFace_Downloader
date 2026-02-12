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
const STORE_BRIDGE_RETRY_MS = 500;
const STORE_BRIDGE_MAX_ATTEMPTS = 80;
const STORE_BRIDGE_PINIA_ASSETS_ID = "assets";
const STORE_BRIDGE_PINIA_MODEL_TO_NODE_ID = "modelToNode";
const STORE_BRIDGE_IMPORT_CANDIDATES = [
  {
    assets: "../../../stores/assetsStore.js",
    modelToNode: "../../../stores/modelToNodeStore.js",
    label: "stores",
  },
  {
    assets: "/stores/assetsStore.js",
    modelToNode: "/stores/modelToNodeStore.js",
    label: "/stores",
  },
  {
    assets: "../../../scripts/stores/assetsStore.js",
    modelToNode: "../../../scripts/stores/modelToNodeStore.js",
    label: "scripts/stores",
  },
  {
    assets: "/scripts/stores/assetsStore.js",
    modelToNode: "/scripts/stores/modelToNodeStore.js",
    label: "/scripts/stores",
  },
];
const MODEL_FETCH_PAGE_SIZE = 500;
const MODEL_FETCH_MAX_PAGES = 20;
const FALLBACK_NODE_TYPE_TO_CATEGORY = {
  CheckpointLoaderSimple: "checkpoints",
  ImageOnlyCheckpointLoader: "checkpoints",
  LoraLoader: "loras",
  LoraLoaderModelOnly: "loras",
  VAELoader: "vae",
  ControlNetLoader: "controlnet",
  UNETLoader: "diffusion_models",
  UpscaleModelLoader: "upscale_models",
  StyleModelLoader: "style_models",
  GLIGENLoader: "gligen",
  CLIPVisionLoader: "clip_vision",
  CLIPLoader: "text_encoders",
  AudioEncoderLoader: "audio_encoders",
  ModelPatchLoader: "model_patches",
  ADE_LoadAnimateDiffModel: "animatediff_models",
  ADE_AnimateDiffLoRALoader: "animatediff_motion_lora",
  DownloadAndLoadSAM2Model: "sam2",
  SAMLoader: "sams",
  UltralyticsDetectorProvider: "ultralytics",
  DownloadAndLoadDepthAnythingV2Model: "depthanything",
  IPAdapterModelLoader: "ipadapter",
};

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

let importedStoreFactoriesPromise = null;

const resolveImportedStoreFactories = async () => {
  if (importedStoreFactoriesPromise) {
    return importedStoreFactoriesPromise;
  }

  importedStoreFactoriesPromise = (async () => {
    for (const candidate of STORE_BRIDGE_IMPORT_CANDIDATES) {
      try {
        const [storesModule, modelToNodeModule] = await Promise.all([
          import(candidate.assets),
          import(candidate.modelToNode),
        ]);
        const useAssetsStore = storesModule?.useAssetsStore;
        const useModelToNodeStore = modelToNodeModule?.useModelToNodeStore;
        if (typeof useAssetsStore === "function") {
          return {
            source: candidate.label,
            useAssetsStore,
            useModelToNodeStore:
              typeof useModelToNodeStore === "function" ? useModelToNodeStore : null,
          };
        }
      } catch (_) {
        // Try next import candidate.
      }
    }
    return null;
  })();

  return importedStoreFactoriesPromise;
};

const resolveStoresFromImportedFactories = async () => {
  const factories = await resolveImportedStoreFactories();
  if (!factories) {
    return null;
  }

  try {
    const assetsStore = factories.useAssetsStore?.();
    const modelToNodeStore = factories.useModelToNodeStore?.() || null;
    if (!assetsStore) {
      return null;
    }
    return {
      source: `import:${factories.source}`,
      assetsStore,
      modelToNodeStore,
    };
  } catch (_) {
    return null;
  }
};

const isPiniaInstance = (value) => {
  return Boolean(
    value &&
      typeof value === "object" &&
      value._s instanceof Map
  );
};

const resolveStoresFromPinia = () => {
  if (typeof document === "undefined") {
    return null;
  }
  const rootElement = document.getElementById("vue-app");
  const vueApp = rootElement?.__vue_app__;
  const provides = vueApp?._context?.provides;
  if (!provides || typeof provides !== "object") {
    return null;
  }

  let pinia = provides.pinia;
  if (!isPiniaInstance(pinia)) {
    for (const key of Reflect.ownKeys(provides)) {
      const candidate = provides[key];
      if (isPiniaInstance(candidate)) {
        pinia = candidate;
        break;
      }
    }
  }
  if (!isPiniaInstance(pinia)) {
    return null;
  }

  const assetsStore = pinia._s.get(STORE_BRIDGE_PINIA_ASSETS_ID);
  if (!assetsStore) {
    return null;
  }

  const modelToNodeStore = pinia._s.get(STORE_BRIDGE_PINIA_MODEL_TO_NODE_ID) || null;
  return {
    source: "pinia",
    assetsStore,
    modelToNodeStore,
  };
};

const resolveStoresForBridge = async () => {
  const imported = await resolveStoresFromImportedFactories();
  if (imported?.assetsStore) {
    return imported;
  }
  return resolveStoresFromPinia();
};

const installLocalAssetsStoreBridgeOnStores = (
  assetsStore,
  modelToNodeStore,
  sourceLabel = "unknown"
) => {
  if (!assetsStore || assetsStore.__hfModelBridgeInstalled) {
    return true;
  }

  const getCategoryForNodeType = (nodeType) => {
    const mapped = modelToNodeStore?.getCategoryForNodeType?.(nodeType);
    if (typeof mapped === "string" && mapped) {
      return mapped;
    }
    return FALLBACK_NODE_TYPE_TO_CATEGORY[String(nodeType || "")] || null;
  };

  const stateByCategory = new Map();
  assetsStore.__hfModelBridgeInstalled = true;
  assetsStore.__hfModelBridgeVersion = 0;

  const bumpBridgeVersion = () => {
    const current = Number(assetsStore.__hfModelBridgeVersion || 0);
    assetsStore.__hfModelBridgeVersion = current + 1;
  };

  const resolveCategory = (key) => {
    if (typeof key !== "string" || !key) return null;
    if (key.startsWith("tag:")) return key;
    return getCategoryForNodeType(key);
  };

  const getEntry = (category) => {
    if (!stateByCategory.has(category)) {
      stateByCategory.set(category, {
        assets: new Map(),
        isLoading: false,
        hasMore: false,
        error: undefined,
      });
    }
    return stateByCategory.get(category);
  };

  const readJsonResponse = async (response) => {
    try {
      return await response.json();
    } catch (_) {
      return {};
    }
  };

  const fetchAssetsByTags = async (tags) => {
    const merged = new Map();
    let offset = 0;
    let page = 0;
    let keepGoing = true;

    while (keepGoing && page < MODEL_FETCH_MAX_PAGES) {
      page += 1;
      const params = new URLSearchParams();
      params.set("include_tags", tags.join(","));
      params.set("include_public", "true");
      params.set("limit", String(MODEL_FETCH_PAGE_SIZE));
      params.set("offset", String(offset));

      const response = await api.fetchApi(`/assets?${params.toString()}`);
      if (!response.ok) {
        const payload = await readJsonResponse(response);
        const message = payload?.error?.message || payload?.message || `Failed to load assets (${response.status})`;
        throw new Error(message);
      }
      const payload = await readJsonResponse(response);
      const assets = Array.isArray(payload?.assets) ? payload.assets : [];
      assets.forEach((asset) => {
        if (asset?.id) {
          merged.set(String(asset.id), asset);
        }
      });

      const hasMore = payload?.has_more === true;
      const total = typeof payload?.total === "number" ? payload.total : null;
      offset += assets.length;
      keepGoing = Boolean(
        hasMore ||
          (total !== null && offset < total) ||
          assets.length >= MODEL_FETCH_PAGE_SIZE
      );
      if (!assets.length) {
        keepGoing = false;
      }
    }

    return Array.from(merged.values());
  };

  const refreshCategory = async (category, tags) => {
    const entry = getEntry(category);
    entry.isLoading = true;
    entry.error = undefined;
    bumpBridgeVersion();

    try {
      const assets = await fetchAssetsByTags(tags);
      entry.assets = new Map(
        assets
          .filter((asset) => asset?.id)
          .map((asset) => [String(asset.id), asset])
      );
      entry.hasMore = assets.length >= MODEL_FETCH_PAGE_SIZE;
      entry.error = undefined;
    } catch (error) {
      entry.error = error instanceof Error ? error : new Error(String(error));
      entry.assets = new Map();
      entry.hasMore = false;
      console.warn("[HF Model Library] Local store bridge fetch failed:", error);
    } finally {
      entry.isLoading = false;
      bumpBridgeVersion();
    }
  };

  const updateAssetInAllCategories = (assetId, updatedAsset) => {
    if (!assetId) return;
    let changed = false;
    stateByCategory.forEach((entry) => {
      if (entry.assets.has(assetId)) {
        entry.assets.set(assetId, updatedAsset);
        changed = true;
      }
    });
    if (changed) {
      bumpBridgeVersion();
    }
  };

  assetsStore.getAssets = (key) => {
    void assetsStore.__hfModelBridgeVersion;
    const category = resolveCategory(key);
    if (!category) return [];
    const entry = stateByCategory.get(category);
    if (!entry) return [];
    return Array.from(entry.assets.values());
  };

  assetsStore.isModelLoading = (key) => {
    void assetsStore.__hfModelBridgeVersion;
    const category = resolveCategory(key);
    if (!category) return false;
    return Boolean(stateByCategory.get(category)?.isLoading);
  };

  assetsStore.getError = (key) => {
    void assetsStore.__hfModelBridgeVersion;
    const category = resolveCategory(key);
    if (!category) return undefined;
    return stateByCategory.get(category)?.error;
  };

  assetsStore.hasMore = (key) => {
    void assetsStore.__hfModelBridgeVersion;
    const category = resolveCategory(key);
    if (!category) return false;
    return Boolean(stateByCategory.get(category)?.hasMore);
  };

  assetsStore.hasAssetKey = (key) => {
    void assetsStore.__hfModelBridgeVersion;
    const category = resolveCategory(key);
    if (!category) return false;
    return stateByCategory.has(category);
  };

  assetsStore.invalidateCategory = (category) => {
    if (!category) return;
    stateByCategory.delete(category);
    bumpBridgeVersion();
  };

  assetsStore.updateModelsForNodeType = async (nodeType) => {
    const category = getCategoryForNodeType(nodeType);
    if (!category) return;
    await refreshCategory(category, ["models", category]);
  };

  assetsStore.updateModelsForTag = async (tag) => {
    const safeTag = String(tag || "").trim();
    if (!safeTag) return;
    const category = `tag:${safeTag}`;
    await refreshCategory(category, [safeTag]);
  };

  assetsStore.updateAssetMetadata = async (asset, userMetadata) => {
    if (!asset?.id) return;
    const response = await api.fetchApi(`/assets/${asset.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_metadata: userMetadata || {} }),
    });
    if (!response.ok) {
      return;
    }
    const updated = await readJsonResponse(response);
    if (updated?.id) {
      updateAssetInAllCategories(String(updated.id), updated);
    }
  };

  assetsStore.updateAssetTags = async (asset, newTags) => {
    if (!asset?.id || !Array.isArray(newTags)) return;

    const current = Array.isArray(asset.tags) ? asset.tags : [];
    const currentLower = new Set(current.map((x) => String(x).toLowerCase()));
    const nextLower = new Set(newTags.map((x) => String(x).toLowerCase()));
    const toAdd = newTags.filter((x) => !currentLower.has(String(x).toLowerCase()));
    const toRemove = current.filter((x) => !nextLower.has(String(x).toLowerCase()));

    if (toRemove.length) {
      await api.fetchApi(`/assets/${asset.id}/tags`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: toRemove }),
      });
    }
    if (toAdd.length) {
      await api.fetchApi(`/assets/${asset.id}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: toAdd }),
      });
    }

    const detailResp = await api.fetchApi(`/assets/${asset.id}`);
    if (detailResp.ok) {
      const updated = await readJsonResponse(detailResp);
      if (updated?.id) {
        updateAssetInAllCategories(String(updated.id), updated);
      }
    }
  };

  if (typeof assetsStore.updateModelsForTag === "function") {
    void assetsStore.updateModelsForTag("models").catch((error) => {
      console.warn("[HF Model Library] Initial model tag refresh failed:", error);
    });
  }

  console.log(`[HF Model Library] Installed local assets store bridge (${sourceLabel}).`);
  return true;
};

const installLocalAssetsStoreBridge = () => {
  let attempts = 0;
  let timer = null;

  const runAttempt = async () => {
    attempts += 1;

    const resolved = await resolveStoresForBridge();
    const installed = Boolean(
      resolved?.assetsStore &&
        installLocalAssetsStoreBridgeOnStores(
          resolved.assetsStore,
          resolved.modelToNodeStore,
          resolved.source
        )
    );

    if (installed || attempts >= STORE_BRIDGE_MAX_ATTEMPTS) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (!installed) {
        console.warn("[HF Model Library] Could not attach local assets store bridge.");
      }
    }

    return installed;
  };

  void (async () => {
    const applied = await runAttempt();
    if (!applied && attempts < STORE_BRIDGE_MAX_ATTEMPTS) {
      timer = setInterval(() => {
        void runAttempt();
      }, STORE_BRIDGE_RETRY_MS);
    }
  })();
};

app.registerExtension({
  name: "hfDownloaderModelLibraryBackend",
  async setup() {
    installFetchApiOverride();
    installNativeModelLibraryCommandOverrides();
    installLocalAssetsStoreBridge();
    await ensureAssetApiEnabledForNativeLibrary();
  },
});
