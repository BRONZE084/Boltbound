export const NATIVE_LANDSCAPE_WAIT_MS = 800;
export const NATIVE_CALL_TIMEOUT_MS = 650;

function errorCode(error) {
  return error?.name || error?.code || "rejected";
}

function callNativeWithTimeout(invoke, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      settle({ ok: false, errorCode: "timeout" });
    }, Math.max(0, Number(timeoutMs) || 0));
    Promise.resolve()
      .then(invoke)
      .then(
        () => settle({ ok: true, errorCode: null }),
        (error) => settle({ ok: false, errorCode: errorCode(error) }),
      );
  });
}

export function isActualLandscape({
  mediaMatches = false,
  viewportWidth = 0,
  viewportHeight = 0,
} = {}) {
  return Boolean(
    mediaMatches ||
    (Number.isFinite(viewportWidth) &&
      Number.isFinite(viewportHeight) &&
      viewportWidth > viewportHeight),
  );
}

export function readLandscapeSnapshot(windowRef = globalThis.window) {
  const visualViewport = windowRef?.visualViewport;
  const viewportWidth = Number(visualViewport?.width ?? windowRef?.innerWidth ?? 0);
  const viewportHeight = Number(visualViewport?.height ?? windowRef?.innerHeight ?? 0);
  let mediaMatches = false;
  try {
    mediaMatches = Boolean(windowRef?.matchMedia?.("(orientation: landscape)")?.matches);
  } catch {
    mediaMatches = false;
  }
  return {
    mediaMatches,
    viewportWidth,
    viewportHeight,
    actualLandscape: isActualLandscape({ mediaMatches, viewportWidth, viewportHeight }),
  };
}

export async function waitForActualLandscape({
  readSnapshot = () => readLandscapeSnapshot(),
  timeoutMs = NATIVE_LANDSCAPE_WAIT_MS,
  pollIntervalMs = 40,
  now = () => performance.now(),
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  const startedAt = now();
  let snapshot = readSnapshot();
  while (!snapshot.actualLandscape) {
    const elapsedMs = Math.max(0, now() - startedAt);
    if (elapsedMs >= timeoutMs) break;
    await sleep(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
    snapshot = readSnapshot();
  }
  return {
    ...snapshot,
    elapsedMs: Math.max(0, now() - startedAt),
  };
}

export async function requestNativeLandscape({
  root = globalThis.document?.documentElement,
  documentRef = globalThis.document,
  screenRef = globalThis.screen,
  observe = () => waitForActualLandscape(),
  nativeCallTimeoutMs = NATIVE_CALL_TIMEOUT_MS,
} = {}) {
  const fullscreenRequest = root?.requestFullscreen || root?.webkitRequestFullscreen;
  const fullscreenActive = Boolean(
    documentRef?.fullscreenElement || documentRef?.webkitFullscreenElement,
  );
  const fullscreen = {
    supported: typeof fullscreenRequest === "function",
    attempted: false,
    alreadyActive: fullscreenActive,
    granted: fullscreenActive,
    retriedWithoutOptions: false,
    firstErrorCode: null,
    errorCode: null,
  };

  if (!fullscreenActive && fullscreen.supported) {
    fullscreen.attempted = true;
    const firstRequest = await callNativeWithTimeout(
      () => fullscreenRequest.call(root, { navigationUI: "hide" }),
      nativeCallTimeoutMs,
    );
    if (firstRequest.ok) {
      fullscreen.granted = true;
    } else {
      fullscreen.firstErrorCode = firstRequest.errorCode;
      fullscreen.retriedWithoutOptions = true;
      const retryRequest = await callNativeWithTimeout(
        () => fullscreenRequest.call(root),
        nativeCallTimeoutMs,
      );
      fullscreen.granted = retryRequest.ok;
      fullscreen.errorCode = retryRequest.errorCode;
    }
  }

  const lock = screenRef?.orientation?.lock;
  const orientationLock = {
    supported: typeof lock === "function",
    attempted: false,
    granted: false,
    errorCode: null,
  };
  if (orientationLock.supported) {
    orientationLock.attempted = true;
    const lockRequest = await callNativeWithTimeout(
      () => lock.call(screenRef.orientation, "landscape"),
      nativeCallTimeoutMs,
    );
    orientationLock.granted = lockRequest.ok;
    orientationLock.errorCode = lockRequest.errorCode;
  }

  const observation = await observe();
  return {
    fullscreen,
    orientationLock,
    observation,
    actualLandscape: Boolean(observation?.actualLandscape),
  };
}

export function resolveLandscapePresentation({
  gameActive = false,
  coarsePointer = false,
  actualLandscape = false,
  virtualLandscape = false,
} = {}) {
  if (!gameActive || !coarsePointer) return "inactive";
  if (actualLandscape) return "native";
  if (virtualLandscape) return "virtual";
  return "gate";
}

export function mapVirtualPointerToCanvas({ clientX, clientY, canvasRect }) {
  const width = Number(canvasRect?.width || 0);
  const height = Number(canvasRect?.height || 0);
  if (!(width > 0) || !(height > 0)) {
    return { clientX: Number(clientX) || 0, clientY: Number(clientY) || 0 };
  }
  const left = Number(canvasRect.left || 0);
  const top = Number(canvasRect.top || 0);
  const right = Number(canvasRect.right ?? left + width);
  return {
    clientX: left + ((Number(clientY) - top) / height) * width,
    clientY: top + ((right - Number(clientX)) / width) * height,
  };
}

function clonedPointerInit(event, point) {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: event.view || event.target?.ownerDocument?.defaultView || null,
    detail: event.detail,
    screenX: point.clientX,
    screenY: point.clientY,
    clientX: point.clientX,
    clientY: point.clientY,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    button: event.button,
    buttons: event.buttons,
    relatedTarget: event.relatedTarget,
    pointerId: event.pointerId,
    width: event.width,
    height: event.height,
    pressure: event.pressure,
    tangentialPressure: event.tangentialPressure,
    tiltX: event.tiltX,
    tiltY: event.tiltY,
    twist: event.twist,
    pointerType: event.pointerType,
    isPrimary: event.isPrimary,
  };
}

export function installVirtualPointerAdapter(canvas, {
  isActive,
  PointerEventCtor = globalThis.PointerEvent,
} = {}) {
  if (!canvas || typeof PointerEventCtor !== "function") {
    return { destroy() {}, releaseActivePointers() {} };
  }

  const syntheticEvents = new WeakSet();
  const activePointers = new Map();
  const eventTypes = ["pointerdown", "pointermove", "pointerup", "pointercancel"];

  const dispatch = (type, init) => {
    const synthetic = new PointerEventCtor(type, init);
    syntheticEvents.add(synthetic);
    canvas.dispatchEvent(synthetic);
  };

  const handlePointer = (event) => {
    if (syntheticEvents.has(event) || !isActive?.()) return;
    if (event.type !== "pointerdown" && !activePointers.has(event.pointerId)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "pointerdown") {
      try {
        canvas.setPointerCapture?.(event.pointerId);
      } catch {
        // Pointer capture is optional in embedded Android browsers.
      }
    }

    const point = mapVirtualPointerToCanvas({
      clientX: event.clientX,
      clientY: event.clientY,
      canvasRect: canvas.getBoundingClientRect(),
    });
    const init = clonedPointerInit(event, point);
    activePointers.set(event.pointerId, init);
    dispatch(event.type, init);

    if (event.type === "pointerup" || event.type === "pointercancel") {
      activePointers.delete(event.pointerId);
      try {
        canvas.releasePointerCapture?.(event.pointerId);
      } catch {
        // Ignore capture implementations that already released this pointer.
      }
    }
  };

  for (const type of eventTypes) {
    canvas.addEventListener(type, handlePointer, { capture: true, passive: false });
  }

  return {
    releaseActivePointers() {
      for (const init of activePointers.values()) dispatch("pointercancel", init);
      activePointers.clear();
    },
    destroy() {
      this.releaseActivePointers();
      for (const type of eventTypes) {
        canvas.removeEventListener(type, handlePointer, { capture: true });
      }
    },
  };
}
