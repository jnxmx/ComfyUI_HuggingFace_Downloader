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
const MODEL_FETCH_MAX_PAGES = 500;
const MODEL_LIBRARY_MODAL_SELECTOR = '[data-component-id="AssetBrowserModal"]';
const MODEL_LIBRARY_CARD_SELECTOR = '[data-component-id="AssetCard"][data-asset-id]';
const MODEL_LIBRARY_ACTION_BUTTON_SELECTOR = "button.shrink-0";
const MODEL_LIBRARY_USE_LABEL = "Use";
const MODEL_LIBRARY_DOWNLOAD_AND_USE_LABEL = "Download & Use";
const MODEL_LIBRARY_DOWNLOADING_LABEL = "Downloading...";
const MODEL_LIBRARY_DOWNLOAD_BY_LINK_LABEL = "Download by link";
const MODEL_LIBRARY_IMPORT_BUTTON_PATCH_MARKER = "hfModelLibraryImportButtonPatched";
const MODEL_LIBRARY_HEADER_BUTTON_ID = "hf-model-library-download-by-link-button";
const MODEL_LIBRARY_HEADER_FLOATING_RIGHT_PX = 132;
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
const modelLibraryAssetById = new Map();
const modelLibraryInstalledById = new Map();
const modelLibraryDownloadInProgress = new Set();
const modelLibraryBypassClickOnce = new Set();
let modelLibraryUiObserverInstalled = false;
let modelLibraryUiListenerInstalled = false;
let modelLibraryUiRefreshScheduled = false;
const TEXT_NODE_TYPE = typeof Node !== "undefined" ? Node.TEXT_NODE : 3;

const isPlainObject = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const asStringArray = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item || "").trim())
    .filter((item) => Boolean(item));
};

const resolveAssetId = (asset) => {
  const assetId = String(asset?.id || "").trim();
  return assetId || null;
};

const resolveInstalledState = (asset) => {
  if (!asset || typeof asset !== "object") {
    return null;
  }

  const userInstalled = asset?.user_metadata?.installed;
  if (typeof userInstalled === "boolean") {
    return userInstalled;
  }
  const metadataInstalled = asset?.metadata?.installed;
  if (typeof metadataInstalled === "boolean") {
    return metadataInstalled;
  }
  if (typeof asset?.is_immutable === "boolean") {
    return !asset.is_immutable;
  }
  return null;
};

const rememberModelLibraryAsset = (asset) => {
  const assetId = resolveAssetId(asset);
  if (!assetId) {
    return;
  }
  modelLibraryAssetById.set(assetId, asset);

  const installed = resolveInstalledState(asset);
  if (typeof installed === "boolean") {
    modelLibraryInstalledById.set(assetId, installed);
  }
};

const rememberModelLibraryAssetsFromPayload = (payload) => {
  if (Array.isArray(payload?.assets)) {
    payload.assets.forEach(rememberModelLibraryAsset);
    return;
  }
  if (isPlainObject(payload) && resolveAssetId(payload)) {
    rememberModelLibraryAsset(payload);
  }
};

const readJsonResponse = async (response) => {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
};

const shouldTrackAssetStateFromRoute = (path, method) => {
  if (path === ASSETS_ROUTE_PREFIX && method === "GET") {
    return true;
  }
  if (path === `${ASSETS_ROUTE_PREFIX}/download` && method === "POST") {
    return true;
  }
  if (isAssetDetailPath(path) && (method === "GET" || method === "PUT")) {
    return true;
  }
  return false;
};

const requestUiRefresh = () => {
  if (modelLibraryUiRefreshScheduled) {
    return;
  }
  modelLibraryUiRefreshScheduled = true;
  const run = () => {
    modelLibraryUiRefreshScheduled = false;
    refreshModelLibraryActionButtons();
    patchModelLibraryImportButtons();
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run);
    return;
  }
  setTimeout(run, 0);
};

const trackModelLibraryAssetStateFromResponse = async (path, method, response) => {
  if (!response?.ok) {
    return;
  }
  if (!shouldTrackAssetStateFromRoute(path, method)) {
    return;
  }
  const payload = await readJsonResponse(response.clone());
  rememberModelLibraryAssetsFromPayload(payload);
  requestUiRefresh();
};

const setButtonLabel = (button, label) => {
  if (!button) return;

  let textNode = null;
  for (const child of Array.from(button.childNodes || [])) {
    if (child?.nodeType === TEXT_NODE_TYPE && String(child.nodeValue || "").trim()) {
      textNode = child;
      break;
    }
  }
  if (!textNode) {
    textNode = document.createTextNode(label);
    button.insertBefore(textNode, button.firstChild || null);
  } else {
    textNode.nodeValue = label;
  }
};

const setButtonVisibleLabel = (button, label) => {
  if (!button) return;

  const explicitLabel = button.querySelector(
    ".p-button-label, .button-label, [data-pc-section='label']"
  );
  if (explicitLabel) {
    explicitLabel.textContent = label;
    return;
  }

  const candidateSpans = Array.from(button.querySelectorAll("span")).filter((node) => {
    const text = String(node?.textContent || "").trim();
    if (!text) {
      return false;
    }
    const className = String(node?.className || "").toLowerCase();
    return !className.includes("icon");
  });
  if (candidateSpans.length) {
    candidateSpans[0].textContent = label;
    return;
  }

  setButtonLabel(button, label);
};

const openManualDownloadDialog = () => {
  const action =
    globalThis?.hfDownloader?.showManualDownloadDialog ||
    window?.hfDownloader?.showManualDownloadDialog;
  if (typeof action !== "function") {
    return false;
  }
  action();
  return true;
};

const findModelLibraryHeaderActionContainer = (modal) => {
  if (!modal) return null;
  const closeButton = modal.querySelector(
    "button[aria-label='Close'], button[aria-label='close'], button[aria-label='Dismiss']"
  );
  if (closeButton?.parentElement) {
    return closeButton.parentElement;
  }

  const topRowButtons = Array.from(modal.querySelectorAll("button")).filter((button) => {
    if (button.closest(MODEL_LIBRARY_CARD_SELECTOR)) {
      return false;
    }
    const text = String(button.textContent || "").trim().toLowerCase();
    return (
      text === "import" ||
      text === MODEL_LIBRARY_DOWNLOAD_BY_LINK_LABEL.toLowerCase() ||
      button.getAttribute("aria-label")?.toLowerCase() === "close"
    );
  });
  if (topRowButtons.length) {
    return topRowButtons[0].parentElement || null;
  }

  const nonCardButtons = Array.from(modal.querySelectorAll("button")).filter((button) => {
    return !button.closest(MODEL_LIBRARY_CARD_SELECTOR);
  });
  if (nonCardButtons.length) {
    let best = null;
    nonCardButtons.forEach((button) => {
      const rect = button.getBoundingClientRect();
      if (!best) {
        best = { button, top: rect.top, right: rect.right };
        return;
      }
      if (rect.top < best.top - 1) {
        best = { button, top: rect.top, right: rect.right };
        return;
      }
      if (Math.abs(rect.top - best.top) <= 1 && rect.right > best.right) {
        best = { button, top: rect.top, right: rect.right };
      }
    });
    if (best?.button?.parentElement) {
      return best.button.parentElement;
    }
  }
  return null;
};

const ensureModelLibraryHeaderDownloadButton = () => {
  if (typeof document === "undefined") {
    return;
  }
  const modal = document.querySelector(MODEL_LIBRARY_MODAL_SELECTOR);
  if (!modal) {
    return;
  }

  const existing = modal.querySelector(`#${MODEL_LIBRARY_HEADER_BUTTON_ID}`);
  if (existing) {
    return;
  }

  const button = document.createElement("button");
  button.id = MODEL_LIBRARY_HEADER_BUTTON_ID;
  button.type = "button";
  button.textContent = MODEL_LIBRARY_DOWNLOAD_BY_LINK_LABEL;

  const importLikeButton = Array.from(modal.querySelectorAll("button")).find((candidate) => {
    if (candidate.closest(MODEL_LIBRARY_CARD_SELECTOR)) {
      return false;
    }
    const text = String(candidate.textContent || "").trim().toLowerCase();
    return (
      text === "import" ||
      text === MODEL_LIBRARY_DOWNLOAD_BY_LINK_LABEL.toLowerCase()
    );
  });

  const container = findModelLibraryHeaderActionContainer(modal);

  if (importLikeButton) {
    button.className = importLikeButton.className;
    button.style.cssText = importLikeButton.style.cssText;
  } else {
    button.className = "p-button p-component";
    Object.assign(button.style, {
      minHeight: "40px",
      padding: "0.45rem 1rem",
      borderRadius: "10px",
      border: "none",
      background: "var(--primary-background, #1f9cf0)",
      color: "var(--base-foreground, #ffffff)",
      fontSize: "14px",
      fontWeight: "600",
      cursor: "pointer",
    });
  }
  button.setAttribute("aria-label", MODEL_LIBRARY_DOWNLOAD_BY_LINK_LABEL);
  button.addEventListener(
    "click",
    (event) => {
      if (!getBackendSettingEnabled()) {
        return;
      }
      if (!openManualDownloadDialog()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
    },
    true
  );

  // If native Import is missing in this UI build, top-right icon groups can
  // hide extra controls due to constrained layout. Use a floating fallback.
  if (!importLikeButton || !container) {
    let host = modal;
    if (!(host instanceof HTMLElement)) {
      return;
    }
    try {
      const hostComputed = window.getComputedStyle(host);
      if (!hostComputed || hostComputed.position === "static") {
        host.style.position = "relative";
      }
    } catch (_) {
      host.style.position = "relative";
    }
    Object.assign(button.style, {
      position: "absolute",
      top: "16px",
      right: `${MODEL_LIBRARY_HEADER_FLOATING_RIGHT_PX}px`,
      zIndex: "6",
      whiteSpace: "nowrap",
    });
    host.appendChild(button);
    return;
  }

  container.insertBefore(button, container.firstChild || null);
};

const patchModelLibraryImportButtons = () => {
  if (typeof document === "undefined") {
    return;
  }
  const modal = document.querySelector(MODEL_LIBRARY_MODAL_SELECTOR);
  if (!modal) {
    return;
  }

  const buttons = modal.querySelectorAll("button");
  buttons.forEach((button) => {
    if (button.closest(MODEL_LIBRARY_CARD_SELECTOR)) {
      return;
    }

    const text = String(button.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!text) {
      return;
    }
    if (
      text !== "import" &&
      text !== MODEL_LIBRARY_DOWNLOAD_BY_LINK_LABEL.toLowerCase()
    ) {
      return;
    }

    setButtonVisibleLabel(button, MODEL_LIBRARY_DOWNLOAD_BY_LINK_LABEL);
    button.setAttribute("aria-label", MODEL_LIBRARY_DOWNLOAD_BY_LINK_LABEL);

    if (button.dataset[MODEL_LIBRARY_IMPORT_BUTTON_PATCH_MARKER] === "1") {
      return;
    }
    button.dataset[MODEL_LIBRARY_IMPORT_BUTTON_PATCH_MARKER] = "1";
    button.addEventListener(
      "click",
      (event) => {
        if (!getBackendSettingEnabled()) {
          return;
        }
        if (!openManualDownloadDialog()) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
      },
      true
    );
  });
  ensureModelLibraryHeaderDownloadButton();
};

const getActionButtonFromCard = (card) => {
  if (!card || typeof card.querySelector !== "function") {
    return null;
  }
  return card.querySelector(MODEL_LIBRARY_ACTION_BUTTON_SELECTOR);
};

function refreshModelLibraryActionButtons() {
  if (typeof document === "undefined") {
    return;
  }

  const cards = document.querySelectorAll(
    `${MODEL_LIBRARY_MODAL_SELECTOR} ${MODEL_LIBRARY_CARD_SELECTOR}`
  );
  cards.forEach((card) => {
    const assetId = String(card.getAttribute("data-asset-id") || "").trim();
    if (!assetId) {
      return;
    }
    const button = getActionButtonFromCard(card);
    if (!button) {
      return;
    }

    const installed = modelLibraryInstalledById.get(assetId);
    const downloading = modelLibraryDownloadInProgress.has(assetId);
    let label = MODEL_LIBRARY_USE_LABEL;
    if (downloading) {
      label = MODEL_LIBRARY_DOWNLOADING_LABEL;
    } else if (installed === false) {
      label = MODEL_LIBRARY_DOWNLOAD_AND_USE_LABEL;
    }

    button.disabled = downloading;
    button.dataset.hfModelLibraryAction = installed === false ? "download-and-use" : "use";
    setButtonLabel(button, label);
  });
}

const installModelLibraryUiObserver = () => {
  if (modelLibraryUiObserverInstalled || typeof document === "undefined") {
    return;
  }
  const root = document.body;
  if (!root || typeof MutationObserver === "undefined") {
    return;
  }

  const observer = new MutationObserver(() => {
    requestUiRefresh();
  });
  observer.observe(root, { childList: true, subtree: true });
  modelLibraryUiObserverInstalled = true;
  requestUiRefresh();
};

const getAssetSourceUrl = (asset) => {
  const candidates = [
    asset?.user_metadata?.source_url,
    asset?.metadata?.repo_url,
    asset?.url,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
};

const buildDownloadPayload = (asset) => {
  const sourceUrl = getAssetSourceUrl(asset);
  if (!sourceUrl) {
    return null;
  }
  const tags = asStringArray(asset?.tags);
  const userMetadata = isPlainObject(asset?.user_metadata)
    ? { ...asset.user_metadata }
    : {};
  if (!userMetadata.source_url) {
    userMetadata.source_url = sourceUrl;
  }
  return {
    source_url: sourceUrl,
    tags,
    user_metadata: userMetadata,
  };
};

const dispatchUseActionClick = (button) => {
  if (!button) {
    return;
  }
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  button.dispatchEvent(event);
};

const downloadAndUseModelAsset = async (assetId, button) => {
  if (!assetId || modelLibraryDownloadInProgress.has(assetId)) {
    return;
  }
  const sourceAsset = modelLibraryAssetById.get(assetId);
  const payload = buildDownloadPayload(sourceAsset);
  if (!payload) {
    console.warn(`[HF Model Library] Missing source URL for asset ${assetId}.`);
    return;
  }

  modelLibraryDownloadInProgress.add(assetId);
  requestUiRefresh();
  try {
    const response = await api.fetchApi("/assets/download", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response?.ok) {
      const errorPayload = await readJsonResponse(response.clone());
      const message = errorPayload?.message || errorPayload?.error || `HTTP ${response.status}`;
      throw new Error(String(message));
    }

    const downloadedAsset = await readJsonResponse(response.clone());
    rememberModelLibraryAssetsFromPayload(downloadedAsset);
    modelLibraryInstalledById.set(assetId, true);
    modelLibraryBypassClickOnce.add(assetId);
    modelLibraryDownloadInProgress.delete(assetId);
    requestUiRefresh();
    dispatchUseActionClick(button);
  } catch (error) {
    console.error(`[HF Model Library] Download failed for asset ${assetId}:`, error);
  } finally {
    modelLibraryDownloadInProgress.delete(assetId);
    requestUiRefresh();
  }
};

const getModelLibraryCardFromEventTarget = (target) => {
  if (!(target instanceof Element)) {
    return null;
  }
  const button = target.closest(MODEL_LIBRARY_ACTION_BUTTON_SELECTOR);
  if (!button) {
    return null;
  }
  const card = button.closest(MODEL_LIBRARY_CARD_SELECTOR);
  if (!card) {
    return null;
  }
  const modal = card.closest(MODEL_LIBRARY_MODAL_SELECTOR);
  if (!modal) {
    return null;
  }
  const assetId = String(card.getAttribute("data-asset-id") || "").trim();
  if (!assetId) {
    return null;
  }
  return { assetId, button };
};

const handleModelLibraryActionEvent = (event) => {
  if (!getBackendSettingEnabled()) {
    return;
  }

  const context = getModelLibraryCardFromEventTarget(event.target);
  if (!context) {
    return;
  }

  const { assetId, button } = context;

  if (modelLibraryBypassClickOnce.has(assetId)) {
    modelLibraryBypassClickOnce.delete(assetId);
    return;
  }

  if (modelLibraryInstalledById.get(assetId) !== false) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") {
    event.stopImmediatePropagation();
  }
  void downloadAndUseModelAsset(assetId, button);
};

const handleModelLibraryActionKeydown = (event) => {
  if (event?.key !== "Enter" && event?.key !== " ") {
    return;
  }
  handleModelLibraryActionEvent(event);
};

const installModelLibraryActionInterceptors = () => {
  if (modelLibraryUiListenerInstalled || typeof document === "undefined") {
    return;
  }
  document.addEventListener("click", handleModelLibraryActionEvent, true);
  document.addEventListener("keydown", handleModelLibraryActionKeydown, true);
  modelLibraryUiListenerInstalled = true;
};

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

const normalizeModelsListQuery = (path, query) => {
  if (path !== ASSETS_ROUTE_PREFIX) {
    return query;
  }
  if (!includeTagsContainModels(query)) {
    return query;
  }
  const params = new URLSearchParams(query || "");
  // Keep cloud/marketplace assets visible even if caller asks for imported-only.
  params.set("include_public", "true");
  return params.toString();
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
    const normalizedQuery = normalizeModelsListQuery(path, query);

    if (!getBackendSettingEnabled()) {
      return originalFetchApi(normalizeRoute(route), options);
    }

    if (!shouldInterceptRoute(path, normalizedQuery, method)) {
      return originalFetchApi(normalizeRoute(route), options);
    }

    const rewrittenRoute = rewriteRoute(path, normalizedQuery);
    let response = await originalFetchApi(rewrittenRoute, options);

    if (
      response?.status === 404 &&
      shouldFallbackToNativeAssets(path)
    ) {
      response = await originalFetchApi(normalizeRoute(route), options);
    }

    void trackModelLibraryAssetStateFromResponse(path, method, response);
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

    if (keepGoing && page >= MODEL_FETCH_MAX_PAGES) {
      console.warn(
        `[HF Model Library] Reached pagination safety cap (${MODEL_FETCH_MAX_PAGES} pages) while fetching tags: ${tags.join(",")}`
      );
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
    console.log("[HF Model Library] UI/backend hack is temporarily disabled.");
    return;

    installFetchApiOverride();
    installNativeModelLibraryCommandOverrides();
    installLocalAssetsStoreBridge();
    installModelLibraryUiObserver();
    installModelLibraryActionInterceptors();
    await ensureAssetApiEnabledForNativeLibrary();
  },
});
