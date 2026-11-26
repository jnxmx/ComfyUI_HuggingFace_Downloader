/**
 * Shared scoped native overlay stack helper.
 *
 * Replaces per-module document.body subtree MutationObservers and permanent
 * window scroll/resize listeners by managing a single direct-child observer
 * on ComfyUI's top-right actionbars flex column ONLY while at least one
 * plugin panel is visible.
 */

const registeredEntries = new Map(); // id -> { id, element, priority, visible, onPlace }
let stackObserver = null;
let observedStackEl = null;
let layoutRafId = 0;
let fallbackResizeAttached = false;

export const findNativeStackContainer = () => {
    if (typeof document === "undefined") return null;
    const errorOverlayEl = document.querySelector('[data-testid="error-overlay"]');
    const errorOverlayWrapper = errorOverlayEl?.parentElement || null;
    const actionbarsEl = document.querySelector('[data-testid="top-menu-actionbars"]');
    const stackContainer =
        errorOverlayWrapper?.parentElement ||
        actionbarsEl?.parentElement ||
        null;
    return {
        stackContainer: stackContainer && stackContainer !== document.body ? stackContainer : null,
        actionbarsEl,
        errorOverlayWrapper,
    };
};

const getFallbackRightOffset = (ignoreEl) => {
    if (typeof window === "undefined" || typeof document === "undefined") return 16;
    const overlayContainer = document.querySelector(".pointer-events-none.flex.w-full.justify-end");
    if (overlayContainer && overlayContainer.offsetParent !== null) {
        const rect = overlayContainer.getBoundingClientRect();
        if (rect.width > 0 && rect.right < window.innerWidth) {
            const offset = window.innerWidth - rect.right + 12;
            if (offset > 12 && offset < window.innerWidth * 0.7) {
                return Math.round(offset);
            }
        }
    }
    const canvas = document.querySelector(".graph-canvas-container");
    if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const offset = window.innerWidth - rect.right + 12;
        if (offset > 12 && offset < window.innerWidth * 0.7) {
            return Math.round(offset);
        }
    }
    const sidebars = document.querySelectorAll(
        '.comfyui-body-right, [data-testid="sidebar-right"], [class*="sidebar"][class*="right"], aside'
    );
    for (const sb of sidebars) {
        if (!sb || (ignoreEl && sb.contains(ignoreEl))) continue;
        const style = window.getComputedStyle(sb);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        const rect = sb.getBoundingClientRect();
        if (rect.width > 80 && rect.left < window.innerWidth) {
            const offset = window.innerWidth - rect.left + 12;
            if (offset > 12 && offset < window.innerWidth * 0.7) {
                return Math.round(offset);
            }
        }
    }
    return 16;
};

const disconnectStackObserver = () => {
    if (stackObserver) {
        try {
            stackObserver.disconnect();
        } catch (_) {}
        stackObserver = null;
    }
    observedStackEl = null;
};

const detachFallbackResize = () => {
    if (!fallbackResizeAttached || typeof window === "undefined") return;
    window.removeEventListener("resize", scheduleLayout);
    fallbackResizeAttached = false;
};

const attachFallbackResize = () => {
    if (fallbackResizeAttached || typeof window === "undefined") return;
    window.addEventListener("resize", scheduleLayout, { passive: true });
    fallbackResizeAttached = true;
};

const syncStackLayout = () => {
    layoutRafId = 0;

    const visibleEntries = Array.from(registeredEntries.values())
        .filter((entry) => entry.visible && entry.element)
        .sort((a, b) => a.priority - b.priority);

    if (!visibleEntries.length) {
        disconnectStackObserver();
        detachFallbackResize();
        return;
    }

    const { stackContainer, actionbarsEl, errorOverlayWrapper } = findNativeStackContainer();

    if (stackContainer) {
        detachFallbackResize();
        if (observedStackEl !== stackContainer) {
            disconnectStackObserver();
            if (typeof MutationObserver !== "undefined") {
                stackObserver = new MutationObserver(() => {
                    scheduleLayout();
                });
                stackObserver.observe(stackContainer, {
                    childList: true,
                    subtree: false,
                });
                observedStackEl = stackContainer;
            }
        }

        let anchor =
            (errorOverlayWrapper && errorOverlayWrapper.parentElement === stackContainer && errorOverlayWrapper) ||
            (actionbarsEl && actionbarsEl.parentElement === stackContainer && actionbarsEl) ||
            null;

        for (const entry of visibleEntries) {
            const el = entry.element;
            if (!el) continue;
            el.style.position = "";
            el.style.top = "";
            el.style.right = "";
            el.style.bottom = "";
            el.style.left = "";
            el.style.zIndex = "";
            el.style.width = "";

            if (anchor && anchor.parentElement === stackContainer) {
                if (anchor.nextElementSibling !== el) {
                    anchor.insertAdjacentElement("afterend", el);
                }
            } else if (el.parentElement !== stackContainer) {
                stackContainer.appendChild(el);
            }
            anchor = el;
            entry.onPlace?.(stackContainer);
        }
        return;
    }

    // Fallback when native flex stack container isn't in DOM yet
    disconnectStackObserver();
    attachFallbackResize();
    let topCursor = 56;
    for (const entry of visibleEntries) {
        const el = entry.element;
        if (!el) continue;
        if (el.parentElement !== document.body) {
            document.body.appendChild(el);
        }
        const right = getFallbackRightOffset(el);
        Object.assign(el.style, {
            position: "fixed",
            top: `${topCursor}px`,
            right: `${right}px`,
            bottom: "auto",
            left: "auto",
            zIndex: "9999",
            width: "auto",
        });
        const rect = el.getBoundingClientRect();
        topCursor += (rect.height > 0 ? Math.round(rect.height) : 0) + 8;
        entry.onPlace?.(null);
    }
};

function scheduleLayout() {
    if (layoutRafId || typeof requestAnimationFrame !== "function") {
        if (typeof requestAnimationFrame !== "function") {
            syncStackLayout();
        }
        return;
    }
    layoutRafId = requestAnimationFrame(syncStackLayout);
}

/**
 * Registers or updates a panel inside the scoped native overlay stack.
 *
 * @param {HTMLElement} panelEl
 * @param {{ id?: string, priority?: number, visible?: boolean, onPlace?: Function }} options
 * @returns {() => void} cleanup / unmount function
 */
export const mountInNativeStack = (panelEl, options = {}) => {
    if (!panelEl) return () => {};
    const id = String(options.id || panelEl.id || `hf-stack-panel-${Math.random().toString(36).slice(2, 8)}`);
    const priority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 50;
    const visible = options.visible !== false;

    registeredEntries.set(id, {
        id,
        element: panelEl,
        priority,
        visible,
        onPlace: typeof options.onPlace === "function" ? options.onPlace : null,
    });

    syncStackLayout();

    return () => {
        unmountFromNativeStack(panelEl, id);
    };
};

export const setNativeStackPanelVisible = (idOrEl, visible, options = {}) => {
    let targetKey = typeof idOrEl === "string" ? idOrEl : null;
    if (!targetKey && idOrEl) {
        for (const [key, entry] of registeredEntries.entries()) {
            if (entry.element === idOrEl) {
                targetKey = key;
                break;
            }
        }
        if (!targetKey && idOrEl.id) {
            targetKey = idOrEl.id;
        }
    }
    if (!targetKey) return;

    const existing = registeredEntries.get(targetKey);
    if (existing) {
        existing.visible = Boolean(visible);
        if (options.priority !== undefined) {
            existing.priority = Number(options.priority);
        }
        syncStackLayout();
    } else if (visible && idOrEl instanceof HTMLElement) {
        mountInNativeStack(idOrEl, { id: targetKey, visible: true, ...options });
    }
};

export const unmountFromNativeStack = (panelEl, id = null) => {
    const targetId = id || (panelEl && panelEl.id) || null;
    if (targetId && registeredEntries.has(targetId)) {
        registeredEntries.delete(targetId);
    } else if (panelEl) {
        for (const [key, entry] of registeredEntries.entries()) {
            if (entry.element === panelEl) {
                registeredEntries.delete(key);
            }
        }
    }
    scheduleLayout();
};
