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
            typeof document !== "undefined" ? document.getElementById("vue-app")?.__vue_app__ : null,
            typeof document !== "undefined" ? document.getElementById("app")?.__vue_app__ : null,
            typeof document !== "undefined" ? document.getElementById("root")?.__vue_app__ : null,
            typeof document !== "undefined" ? document.querySelector("[data-v-app]")?.__vue_app__ : null,
            typeof document !== "undefined" ? document.body?.__vue_app__ : null,
        ];
        for (const vueApp of candidates) {
            const provides = vueApp?._context?.provides;
            if (!provides || typeof provides !== "object") continue;
            const symbols = Object.getOwnPropertySymbols(provides);
            for (const sym of symbols) {
                const desc = String(sym.description || sym.toString() || "");
                const val = provides[sym];
                const isPinia =
                    desc.includes("pinia") ||
                    Boolean(val && typeof val === "object" && (val._s instanceof Map || val.stores) && typeof val.use === "function");
                if (isPinia && val && (val._s || val.stores)) {
                    cachedPinia = val;
                    return cachedPinia;
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

const resolveStoreAsync = async (storeId, maxRetries = 50, retryDelayMs = 300) => {
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

export const resolveMissingModelStore = () => resolveStoreAsync("missingModel", 3, 50);
export const resolveExecutionErrorStore = () => resolveStoreAsync("executionError", 3, 50);
export const resolveModelStore = async () => {
    const sync = findPiniaStore("models") || findPiniaStore("model");
    if (sync) return sync;
    return (await resolveStoreAsync("models", 1, 0)) || findPiniaStore("model");
};
export const resolveRightSidePanelStore = () => resolveStoreAsync("rightSidePanel", 3, 50);

export const getMissingModelCandidates = () => {
    const store = findPiniaStore("missingModel");
    if (!store) return [];
    const list = unwrapStoreValue(store.missingModelCandidates);
    return Array.isArray(list) ? list : [];
};

const pendingStoreSubscriptions = new Set();

export const rebindPendingStoreSubscriptions = () => {
    let reboundCount = 0;
    for (const entry of Array.from(pendingStoreSubscriptions)) {
        const store = findPiniaStore(entry.storeId);
        if (store && entry.bind(store)) {
            reboundCount += 1;
        }
    }
    return reboundCount;
};

const observePiniaStore = (storeId, attachFn, { immediate = false } = {}) => {
    let cancelled = false;
    let bound = false;
    let cleanupFn = null;
    let pendingEntry = null;

    const tryBind = (store) => {
        if (cancelled || bound || !store) return false;
        bound = true;
        if (pendingEntry) {
            pendingStoreSubscriptions.delete(pendingEntry);
            pendingEntry = null;
        }
        cleanupFn = attachFn(store, immediate);
        return true;
    };

    const syncStore = findPiniaStore(storeId);
    if (syncStore) {
        tryBind(syncStore);
    } else {
        pendingEntry = { storeId, bind: tryBind };
        pendingStoreSubscriptions.add(pendingEntry);
        void resolveStoreAsync(storeId).then((store) => {
            if (store) {
                tryBind(store);
            }
        });
    }

    return () => {
        cancelled = true;
        if (pendingEntry) {
            pendingStoreSubscriptions.delete(pendingEntry);
            pendingEntry = null;
        }
        try {
            if (typeof cleanupFn === "function") cleanupFn();
        } catch (_) {}
    };
};

export const subscribeMissingModels = (callback, { immediate = false } = {}) => {
    if (typeof callback !== "function") {
        return () => {};
    }
    return observePiniaStore(
        "missingModel",
        (store, shouldEmitImmediate) => {
            let storeUnsub = null;
            let actionUnsub = null;
            const emitCurrent = () => {
                const candidates = unwrapStoreValue(store.missingModelCandidates);
                callback(Array.isArray(candidates) ? candidates : [], store);
            };
            if (typeof store.$subscribe === "function") {
                storeUnsub = store.$subscribe(
                    () => {
                        emitCurrent();
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
                        after(() => emitCurrent());
                    }
                }, true);
            }
            if (shouldEmitImmediate) {
                emitCurrent();
            }
            return () => {
                try {
                    if (typeof storeUnsub === "function") storeUnsub();
                } catch (_) {}
                try {
                    if (typeof actionUnsub === "function") actionUnsub();
                } catch (_) {}
            };
        },
        { immediate }
    );
};

export const subscribeExecutionErrors = (callback, { immediate = false } = {}) => {
    if (typeof callback !== "function") {
        return () => {};
    }
    const watchedActions = new Set([
        "showErrorOverlay",
        "showExecutionError",
        "recordExecutionError",
        "recordNodeErrors",
        "recordPromptError",
        "surfaceMissingMedia",
    ]);
    return observePiniaStore(
        "executionError",
        (store, shouldEmitImmediate) => {
            let storeUnsub = null;
            let actionUnsub = null;
            const emitCurrent = (fromAction = null) => {
                callback({
                    isErrorOverlayOpen: Boolean(unwrapStoreValue(store?.isErrorOverlayOpen)),
                    lastNodeErrors: unwrapStoreValue(store?.lastNodeErrors) || null,
                    surfacedNodeErrors: unwrapStoreValue(store?.surfacedNodeErrors) || null,
                    hasMissingError: Boolean(unwrapStoreValue(store?.hasMissingError)),
                    hasAnyError: Boolean(unwrapStoreValue(store?.hasAnyError)),
                    lastExecutionError: unwrapStoreValue(store?.lastExecutionError) || null,
                    store,
                    fromAction,
                });
            };
            if (typeof store.$subscribe === "function") {
                storeUnsub = store.$subscribe(
                    () => {
                        emitCurrent(null);
                    },
                    { detached: true }
                );
            }
            if (typeof store.$onAction === "function") {
                actionUnsub = store.$onAction(({ name, after }) => {
                    if (watchedActions.has(name)) {
                        after(() => emitCurrent(name));
                    }
                }, true);
            }
            if (shouldEmitImmediate) {
                emitCurrent(null);
            }
            return () => {
                try {
                    if (typeof storeUnsub === "function") storeUnsub();
                } catch (_) {}
                try {
                    if (typeof actionUnsub === "function") actionUnsub();
                } catch (_) {}
            };
        },
        { immediate }
    );
};

export const subscribeRightSidePanel = (callback, { immediate = false } = {}) => {
    if (typeof callback !== "function") {
        return () => {};
    }
    let lastOpen = null;
    let lastTab = null;

    const emitFromPanelStore = (panelStore, force = false) => {
        const isOpen = Boolean(unwrapStoreValue(panelStore?.isOpen));
        const activeTab = unwrapStoreValue(panelStore?.activeTab) ?? null;
        if (!force && isOpen === lastOpen && activeTab === lastTab) {
            return;
        }
        lastOpen = isOpen;
        lastTab = activeTab;
        callback({
            isOpen,
            activeTab,
            store: panelStore || null,
        });
    };

    const unsubPanel = observePiniaStore(
        "rightSidePanel",
        (store, shouldEmitImmediate) => {
            let storeUnsub = null;
            let actionUnsub = null;
            if (typeof store.$subscribe === "function") {
                storeUnsub = store.$subscribe(
                    () => {
                        emitFromPanelStore(store, false);
                    },
                    { detached: true }
                );
            }
            if (typeof store.$onAction === "function") {
                actionUnsub = store.$onAction(({ after }) => {
                    after(() => emitFromPanelStore(store, true));
                }, true);
            }
            if (shouldEmitImmediate) {
                emitFromPanelStore(store, true);
            }
            return () => {
                try {
                    if (typeof storeUnsub === "function") storeUnsub();
                } catch (_) {}
                try {
                    if (typeof actionUnsub === "function") actionUnsub();
                } catch (_) {}
            };
        },
        { immediate }
    );

    const unsubSetting = observePiniaStore(
        "setting",
        (settingStore) => {
            let settingUnsub = null;
            let settingActionUnsub = null;
            const onSettingChange = () => {
                const panelStore = findPiniaStore("rightSidePanel");
                if (panelStore) {
                    emitFromPanelStore(panelStore, false);
                }
            };
            if (typeof settingStore.$subscribe === "function") {
                settingUnsub = settingStore.$subscribe(onSettingChange, { detached: true });
            }
            if (typeof settingStore.$onAction === "function") {
                settingActionUnsub = settingStore.$onAction(({ name, args, after }) => {
                    if (name === "set" && String(args?.[0] || "") === "Comfy.RightSidePanel.IsOpen") {
                        after(onSettingChange);
                    }
                }, true);
            }
            return () => {
                try {
                    if (typeof settingUnsub === "function") settingUnsub();
                } catch (_) {}
                try {
                    if (typeof settingActionUnsub === "function") settingActionUnsub();
                } catch (_) {}
            };
        },
        { immediate: false }
    );

    return () => {
        try {
            unsubPanel();
        } catch (_) {}
        try {
            unsubSetting();
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

let modelRefreshInFlight = null;
let modelRefreshPending = false;

const waitForNativeRefreshIdle = async (store, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (Boolean(unwrapStoreValue(store?.isRefreshingMissingModels)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

const executeSingleForcedModelRefresh = async () => {
    const missingModelStore = await resolveMissingModelStore();
    if (missingModelStore && typeof missingModelStore.refreshMissingModels === "function") {
        await waitForNativeRefreshIdle(missingModelStore);
        if (!Boolean(unwrapStoreValue(missingModelStore.isRefreshingMissingModels))) {
            await missingModelStore.refreshMissingModels();
        } else if (app && typeof app.refreshMissingModels === "function") {
            await app.refreshMissingModels({ silent: true });
        }
    } else if (app && typeof app.refreshMissingModels === "function") {
        await app.refreshMissingModels({ silent: true });
    } else if (app && typeof app.reloadNodeDefs === "function") {
        await app.reloadNodeDefs();
    }

    try {
        if (app?.graph && typeof app.graph.setDirtyCanvas === "function") {
            app.graph.setDirtyCanvas(true, true);
        }
        if (app?.canvas && typeof app.canvas.setDirty === "function") {
            app.canvas.setDirty(true, true);
        }
    } catch (_) {}
};

export const forceRefreshModels = async () => {
    if (modelRefreshInFlight) {
        modelRefreshPending = true;
        return modelRefreshInFlight;
    }

    const runner = (async () => {
        try {
            do {
                modelRefreshPending = false;
                await executeSingleForcedModelRefresh();
            } while (modelRefreshPending);
            return true;
        } catch (err) {
            console.warn("[HF Downloader] forceRefreshModels failed:", err);
            return false;
        } finally {
            if (modelRefreshInFlight === runner) {
                modelRefreshInFlight = null;
            }
        }
    })();

    modelRefreshInFlight = runner;
    return runner;
};
