const storagePrefix = "zaolu.wechat.";

function wxApi() {
  return globalThis.wx;
}

export function isWechatRuntime() {
  return Boolean(wxApi()?.getSystemInfoSync);
}

export function platformName() {
  try {
    return wxApi()?.getSystemInfoSync?.().platform || "browser";
  } catch {
    return "unknown";
  }
}

export function storageGet(key) {
  const fullKey = `${storagePrefix}${key}`;
  try {
    if (wxApi()?.getStorageSync) return wxApi().getStorageSync(fullKey) || null;
    return globalThis.localStorage?.getItem(fullKey) || null;
  } catch {
    return null;
  }
}

export function storageSet(key, value) {
  const fullKey = `${storagePrefix}${key}`;
  try {
    if (wxApi()?.setStorageSync) wxApi().setStorageSync(fullKey, value);
    else globalThis.localStorage?.setItem(fullKey, value);
  } catch {
    // Storage failure should not block a game session.
  }
}

export function storageRemove(key) {
  const fullKey = `${storagePrefix}${key}`;
  try {
    if (wxApi()?.removeStorageSync) wxApi().removeStorageSync(fullKey);
    else globalThis.localStorage?.removeItem(fullKey);
  } catch {
    // Storage failure should not block leaving a room.
  }
}

export function createId(prefix = "id") {
  const bytes = new Uint8Array(16);
  const api = wxApi();
  if (api?.getRandomValues) api.getRandomValues(bytes);
  else if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function copyText(value) {
  const text = String(value || "");
  if (wxApi()?.setClipboardData) {
    wxApi().setClipboardData({ data: text });
    return;
  }
  globalThis.navigator?.clipboard?.writeText?.(text).catch(() => {});
}

export function editText({ value = "", maxLength = 12, onChange, onDone }) {
  const api = wxApi();
  if (!api?.showKeyboard) {
    const next = globalThis.prompt?.("输入内容", value);
    if (next !== null && next !== undefined) {
      onChange?.(String(next).slice(0, maxLength));
      onDone?.(String(next).slice(0, maxLength));
    }
    return;
  }

  let finished = false;
  const cleanup = () => {
    api.offKeyboardInput?.(handleInput);
    api.offKeyboardConfirm?.(handleConfirm);
    api.offKeyboardComplete?.(handleComplete);
  };
  const finish = (nextValue) => {
    if (finished) return;
    finished = true;
    cleanup();
    onDone?.(String(nextValue ?? value).slice(0, maxLength));
  };
  const handleInput = (event) => onChange?.(String(event?.value ?? "").slice(0, maxLength));
  const handleConfirm = (event) => finish(event?.value);
  const handleComplete = (event) => finish(event?.value);
  api.onKeyboardInput?.(handleInput);
  api.onKeyboardConfirm?.(handleConfirm);
  api.onKeyboardComplete?.(handleComplete);
  api.showKeyboard({
    defaultValue: String(value),
    maxLength,
    multiple: false,
    confirmType: "done",
    fail: () => {
      cleanup();
      finished = true;
    },
  });
}

function callWx(method, options = {}, api = wxApi()) {
  return new Promise((resolve, reject) => {
    const fn = api?.[method];
    if (typeof fn !== "function") {
      reject(Object.assign(new Error(`${method}_unavailable`), { errorCode: "api_unavailable" }));
      return;
    }
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    try {
      fn.call(api, {
        ...options,
        success: (result) => finish(resolve, result || {}),
        fail: (error) => finish(reject, error || new Error(`${method}_failed`)),
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}

export async function wechatLoginCode() {
  const result = await callWx("login", { timeout: 5_000 });
  const code = String(result?.code || "").trim();
  if (!code) {
    throw Object.assign(new Error("wechat_login_code_missing"), {
      errorCode: "signing_unavailable",
    });
  }
  return code;
}

export async function ensureWechatPrivacyConsent() {
  const api = wxApi();
  if (typeof api?.getPrivacySetting !== "function") return true;
  let setting;
  try {
    setting = await callWx("getPrivacySetting", { needAuthorization: true });
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error("privacy_setting_failed"), {
      errorCode: "permission_denied",
    });
  }
  if (setting?.needAuthorization !== true) return true;
  if (typeof api.requirePrivacyAuthorize !== "function") return false;
  try {
    await callWx("requirePrivacyAuthorize");
    return true;
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error("privacy_authorize_failed"), {
      errorCode: "permission_denied",
    });
  }
}

const RECORD_PERMISSION_HELP = "麦克风权限仍未开启，请在微信设置 > 权限 > 麦克风中开启";

export async function recoverWechatRecordPermission(api = wxApi()) {
  if (typeof api?.getSetting !== "function" || typeof api?.openSetting !== "function") {
    return {
      ok: false,
      granted: false,
      opened: false,
      errorCode: "api_unavailable",
      message: "当前微信版本无法打开权限设置，请在系统设置中为微信开启麦克风",
    };
  }

  try {
    // callWx invokes the API synchronously before this first await, preserving the button gesture chain.
    const openPromise = callWx("openSetting", {}, api);
    await openPromise;
    const settings = await callWx("getSetting", {}, api);
    const granted = settings?.authSetting?.["scope.record"] === true;
    return granted
      ? { ok: true, granted: true, opened: true, errorCode: null, message: "麦克风权限已开启" }
      : { ok: false, granted: false, opened: true, errorCode: "permission_denied", message: RECORD_PERMISSION_HELP };
  } catch {
    return { ok: false, granted: false, opened: true, errorCode: "permission_denied", message: RECORD_PERMISSION_HELP };
  }
}

export function configuredMiniGameConfig() {
  return globalThis.ZAOLU_MINIGAME_CONFIG || globalThis.GameGlobal?.ZAOLU_MINIGAME_CONFIG || {};
}

export function configuredServerUrl() {
  return String(
    globalThis.ZAOLU_SERVER_URL ||
      globalThis.GameGlobal?.ZAOLU_SERVER_URL ||
      "http://127.0.0.1:3001",
  ).replace(/\/$/, "");
}

export function configuredSocketPath() {
  const config = configuredMiniGameConfig();
  const value = String(config?.socketPath || "/socket.io/");
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

export function canvasForGame() {
  if (globalThis.canvas) return globalThis.canvas;
  if (globalThis.GameGlobal?.canvas) return globalThis.GameGlobal.canvas;
  const existing = globalThis.document?.querySelector?.("canvas");
  if (existing) return existing;
  return wxApi()?.createCanvas?.() || null;
}
