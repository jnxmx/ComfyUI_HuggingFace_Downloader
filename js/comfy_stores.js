import { app } from "../../../scripts/app.js";

let cachedPinia = null;
const cachedStores = new Map();
const pendingStorePromises = new Map();

export const unwrapStoreValue = (value) =>
    value && typeof value === "object" && "value" in value ? value.value : value;

export const getExtensionManager = () => {
    try {
        return app?.extensionManager || null;
    } catch (_) {
        return null;
    }
};

export const getWorkflowStore = () => {
    try {
        return unwrapStoreValue(app?.extensionManager?.workflow) || null;
    } catch (_) {
        return null;
    }
};

export const getActiveWorkflow = () => {
    try {
        const wfStore = getWorkflowStore();
        return unwrapStoreValue(wfStore?.activeWorkflow) || null;
    } catch (_) {
        return null;
    }
};

const resolvePiniaInstance = () => {
    if (cachedPinia && (cachedPinia._s || cachedPinia.stores)) {
        return cachedPinia;
    }
    try {
        const candidates = [
            app?.vueApp,
            typeof document !== "undefined" ? document.getElementById("app")?.__vue_app__ : null,
            typeof document !== "undefined" ? document.getElementById("root")?.__vue_app__ : null,
            typeof document !== "undefined" ? document.body?.__vue_app__ : null,
        ];
        for (const vueApp of candidates) {
            const provides = vueApp?._context?.provides;
            if (!provides || typeof provides !== "object") continue;
            const symbols = Object.getOwnPropertySymbols(provides);
            for (const sym of symbols) {
                const desc = String(sym.description || sym.toString() || "");
                if (desc.includes("pinia")) {
                    const pinia = provides[sym];
                    if (pinia && (pinia._s || pinia.stores)) {
                        cachedPinia = pinia;
                        return cachedPinia;
                    }
                }
            }
        }
    } catch (err) {
        console.warn("[HF Downloader] Failed resolving Pinia instance:", err);
    }
    return null;
};

export const findPiniaStore = (storeId) => {
    if (!storeId) return null;
    if (cachedStores.has(storeId)) {
        return cachedStores.get(storeId);
    }
    try {
        const pinia = resolvePiniaInstance();
        if (!pinia) return null;
        const storeMap = pinia._s || pinia.stores;
        if (storeMap && typeof storeMap.get === "function" && storeMap.has(storeId)) {
            const store = storeMap.get(storeId);
            if (store) {
                cachedStores.set(storeId, store);
                return store;
            }
        }
    } catch (err) {
        console.warn("[HF Downloader] Error finding Pinia store:", storeId, err);
    }
    return null;
};

const resolveStoreAsync = async (storeId, maxRetries = 6, retryDelayMs = 120) => {
    const syncStore = findPiniaStore(storeId);
    if (syncStore) return syncStore;

    if (pendingStorePromises.has(storeId)) {
        return pendingStorePromises.get(storeId);
    }

    const promise = (async () => {
        for (let i = 0; i < maxRetries; i += 1) {
            const found = findPiniaStore(storeId);
            if (found) return found;
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
        return findPiniaStore(storeId);
    })();

    pendingStorePromises.set(storeId, promise);
    try {
        const store = await promise;
        if (!store) {
            pendingStorePromises.delete(storeId);
        }
        return store;
    } catch (_) {
        pendingStorePromises.delete(storeId);
        return null;
    }
};

export const resolveMissingModelStore = () => resolveStoreAsync("missingModel");
export const resolveExecutionErrorStore = () => resolveStoreAsync("executionError");
export const resolveModelStore = () => resolveStoreAsync("model");
export const resolveRightSidePanelStore = () => resolveStoreAsync("rightSidePanel");

export const getMissingModelCandidates = () => {
    const store = findPiniaStore("missingModel");
    if (!store) return [];
    const list = unwrapStoreValue(store.missingModelCandidates);
    return Array.isArray(list) ? list : [];
};

export const subscribeMissingModels = (callback, { immediate = false } = {}) => {
    if (typeof callback !== "function") {
        return () => {};
    }
    let cancelled = false;
    let storeUnsub = null;
    let actionUnsub = null;

    const emitCurrent = (store) => {
        if (cancelled || !store) return;
        const candidates = unwrapStoreValue(store.missingModelCandidates);
        callback(Array.isArray(candidates) ? candidates : [], store);
    };

    void resolveMissingModelStore().then((store) => {
        if (cancelled || !store) return;
        if (typeof store.$subscribe === "function") {
            storeUnsub = store.$subscribe(
                () => {
                    emitCurrent(store);
                },
                { detached: true }
            );
        } else if (typeof store.$onAction === "function") {
            actionUnsub = store.$onAction(({ name, after }) => {
                if (
                    name === "setMissingModels" ||
                    name === "addMissingModels" ||
                    name === "clearMissingModels" ||
                    name.startsWith("removeMissingModel")
                ) {
                    after(() => emitCurrent(store));
                }
            }, true);
        }
        if (immediate) {
            emitCurrent(store);
        }
    });

    return () => {
        cancelled = true;
        try {
            if (typeof storeUnsub === "function") storeUnsub();
        } catch (_) {}
        try {
            if (typeof actionUnsub === "function") actionUnsub();
        } catch (_) {}
    };
};

export const subscribeExecutionErrors = (callback, { immediate = false } = {}) => {
    if (typeof callback !== "function") {
        return () => {};
    }
    let cancelled = false;
    let storeUnsub = null;
    let actionUnsub = null;

    const readSnapshot = (store, fromAction = null) => ({
        isErrorOverlayOpen: Boolean(unwrapStoreValue(store?.isErrorOverlayOpen)),
        lastNodeErrors: unwrapStoreValue(store?.lastNodeErrors) || null,
        surfacedNodeErrors: unwrapStoreValue(store?.surfacedNodeErrors) || null,
        hasMissingError: Boolean(unwrapStoreValue(store?.hasMissingError)),
        hasAnyError: Boolean(unwrapStoreValue(store?.hasAnyError)),
        lastExecutionError: unwrapStoreValue(store?.lastExecutionError) || null,
        store,
        fromAction,
    });

    const emitCurrent = (store, fromAction = null) => {
        if (cancelled || !store) return;
        callback(readSnapshot(store, fromAction));
    };

    void resolveExecutionErrorStore().then((store) => {
        if (cancelled || !store) return;
        if (typeof store.$subscribe === "function") {
            storeUnsub = store.$subscribe(
                () => {
                    emitCurrent(store, null);
                },
                { detached: true }
            );
        }
        if (typeof store.$onAction === "function") {
            const watchedActions = new Set([
                "showErrorOverlay",
                "showExecutionError",
                "recordNodeErrors",
                "recordPromptError",
                "surfaceMissingMedia",
            ]);
            actionUnsub = store.$onAction(({ name, after }) => {
                if (watchedActions.has(name)) {
                    after(() => emitCurrent(store, name));
                }
            }, true);
        }
        if (immediate) {
            emitCurrent(store, null);
        }
    });

    return () => {
        cancelled = true;
        try {
            if (typeof storeUnsub === "function") storeUnsub();
        } catch (_) {}
        try {
            if (typeof actionUnsub === "function") actionUnsub();
        } catch (_) {}
    };
};

export const subscribeRightSidePanel = (callback, { immediate = false } = {}) => {
    if (typeof callback !== "function") {
        return () => {};
    }
    let cancelled = false;
    let storeUnsub = null;
    let actionUnsub = null;

    const readSnapshot = (store) => ({
        isOpen: Boolean(unwrapStoreValue(store?.isOpen)),
        activeTab: unwrapStoreValue(store?.activeTab) ?? null,
        store,
    });

    const emitCurrent = (store) => {
        if (cancelled || !store) return;
        callback(readSnapshot(store));
    };

    void resolveRightSidePanelStore().then((store) => {
        if (cancelled || !store) return;
        if (typeof store.$subscribe === "function") {
            storeUnsub = store.$subscribe(
                () => {
                    emitCurrent(store);
                },
                { detached: true }
            );
        }
        if (typeof store.$onAction === "function") {
            actionUnsub = store.$onAction(({ after }) => {
                after(() => emitCurrent(store));
            }, true);
        }
        if (immediate) {
            emitCurrent(store);
        }
    });

    return () => {
        cancelled = true;
        try {
            if (typeof storeUnsub === "function") storeUnsub();
        } catch (_) {}
        try {
            if (typeof actionUnsub === "function") actionUnsub();
        } catch (_) {}
    };
};

export const dismissNativeErrorDialog = async () => {
    const executionErrorStore = await resolveExecutionErrorStore();
    if (!executionErrorStore || typeof executionErrorStore !== "object") {
        return false;
    }
    try {
        if (typeof executionErrorStore.dismissErrorOverlay === "function") {
            executionErrorStore.dismissErrorOverlay();
            return true;
        }
        if ("isErrorOverlayOpen" in executionErrorStore) {
            executionErrorStore.isErrorOverlayOpen = false;
            return true;
        }
    } catch (_) {}
    return false;
};
