export const WECHAT_VOICE_REASON_MESSAGES = Object.freeze({
  not_configured: "实时语音需要正式 AppID 和服务端签名配置",
  feature_disabled: "实时语音尚未开通",
  approval_required: "请先在微信后台申请开通实时语音能力",
  privacy_not_configured: "请先完成麦克风隐私声明",
  real_device_required: "实时语音请使用正式 AppID 在真机中测试",
  api_unavailable: "当前微信版本不支持实时语音",
  signing_unavailable: "暂时无法获取语音房间凭证",
  permission_denied: "麦克风权限未开启",
  device_busy: "麦克风正被其他通话占用",
  interrupted: "语音已中断，点击后可重新加入",
  not_joined: "尚未加入语音",
  api_timeout: "语音平台响应超时，请重试",
});

const DEFAULT_WX_CALL_TIMEOUT_MS = 5_000;

function initialState() {
  return {
    status: "idle",
    joined: false,
    micMuted: true,
    speakerMuted: false,
    memberCount: 0,
    speakingCount: 0,
    speakingPlayerIds: [],
    errorCode: null,
  };
}

function callWx(
  api,
  method,
  options = {},
  timeoutMs = DEFAULT_WX_CALL_TIMEOUT_MS,
  { onLateSuccess } = {},
) {
  return new Promise((resolve, reject) => {
    const fn = api?.[method];
    if (typeof fn !== "function") {
      reject(Object.assign(new Error(`${method}_unavailable`), { errorCode: "api_unavailable" }));
      return;
    }
    let settled = false;
    let timedOut = false;
    let lateSuccessHandled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      finish(
        reject,
        Object.assign(new Error(`${method}_timeout`), { errorCode: "api_timeout" }),
      );
    }, Math.max(10, Number(timeoutMs) || DEFAULT_WX_CALL_TIMEOUT_MS));
    try {
      fn.call(api, {
        ...options,
        success: (result) => {
          if (settled) {
            if (timedOut && !lateSuccessHandled && typeof onLateSuccess === "function") {
              lateSuccessHandled = true;
              Promise.resolve()
                .then(() => onLateSuccess(result || {}))
                .catch(() => {});
            }
            return;
          }
          finish(resolve, result || {});
        },
        fail: (error) => finish(reject, error || new Error(`${method}_failed`)),
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}

function callBounded(
  operation,
  timeoutMs = DEFAULT_WX_CALL_TIMEOUT_MS,
  { onLateResolve } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let lateResolveHandled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      finish(
        reject,
        Object.assign(new Error("async_operation_timeout"), { errorCode: "api_timeout" }),
      );
    }, Math.max(10, Number(timeoutMs) || DEFAULT_WX_CALL_TIMEOUT_MS));
    Promise.resolve()
      .then(operation)
      .then((value) => {
        if (settled) {
          if (timedOut && !lateResolveHandled && typeof onLateResolve === "function") {
            lateResolveHandled = true;
            Promise.resolve()
              .then(() => onLateResolve(value))
              .catch(() => {});
          }
          return;
        }
        finish(resolve, value);
      })
      .catch((error) => finish(reject, error));
  });
}

function normalizedAppId(value) {
  return String(value || "").trim();
}

function uniqueIds(value, maxLength = 128) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const id = candidate.trim().slice(0, maxLength);
    if (id) unique.add(id);
  }
  return [...unique];
}

function platformName(api) {
  try {
    return String(api?.getSystemInfoSync?.().platform || "unknown").toLowerCase();
  } catch {
    return "unknown";
  }
}

function isValidCredentials(value) {
  const groupId = String(value?.groupId || "").trim();
  const signature = String(value?.signature || "").trim();
  const nonceStr = String(value?.nonceStr || "").trim();
  const timeStamp = Number(value?.timeStamp);
  return Boolean(
    groupId &&
      groupId.length <= 128 &&
      signature &&
      nonceStr &&
      nonceStr.length < 128 &&
      Number.isSafeInteger(timeStamp) &&
      timeStamp > 0,
  );
}

function joinErrorCode(error) {
  const code = Number(error?.errCode);
  const message = String(error?.errMsg || error?.message || "").toLowerCase();
  if (code === -2 || message.includes("occupied") || message.includes("占用")) return "device_busy";
  if (message.includes("auth") || message.includes("authorize") || message.includes("permission")) {
    return "permission_denied";
  }
  if (code === -3) return "interrupted";
  return error?.errorCode || "join_failed";
}

export class WechatVoiceChat {
  constructor({
    wxApi = globalThis.wx,
    appId = "",
    enabled = false,
    approvalGranted = false,
    privacyConfigured = false,
    requireRealDevice = true,
    getCredentials,
    resolveSpeakerPlayerIds,
    ensurePrivacyConsent,
    notifyLeave,
    onMembersChanged,
    onSpeakersChanged,
    onStateChange,
    onError,
    wxCallTimeoutMs = DEFAULT_WX_CALL_TIMEOUT_MS,
  } = {}) {
    this.wx = wxApi;
    this.appId = normalizedAppId(appId);
    this.enabled = enabled === true;
    this.approvalGranted = approvalGranted === true;
    this.privacyConfigured = privacyConfigured === true;
    this.requireRealDevice = requireRealDevice !== false;
    this.getCredentials = typeof getCredentials === "function" ? getCredentials : null;
    this.resolveSpeakerPlayerIds = typeof resolveSpeakerPlayerIds === "function"
      ? resolveSpeakerPlayerIds : null;
    this.ensurePrivacyConsent =
      typeof ensurePrivacyConsent === "function" ? ensurePrivacyConsent : null;
    this.notifyLeave = typeof notifyLeave === "function" ? notifyLeave : null;
    this.onMembersChanged = typeof onMembersChanged === "function" ? onMembersChanged : null;
    this.onSpeakersChanged = typeof onSpeakersChanged === "function" ? onSpeakersChanged : null;
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : null;
    this.onError = typeof onError === "function" ? onError : null;
    this.wxCallTimeoutMs = Math.max(
      10,
      Math.min(30_000, Number(wxCallTimeoutMs) || DEFAULT_WX_CALL_TIMEOUT_MS),
    );

    this._state = initialState();
    this._attempt = 0;
    this._destroyed = false;
    this._groupId = null;
    this._platformJoined = false;
    this._sessionAttempt = null;
    this._operationChain = Promise.resolve();
    this._listenersBound = false;
    this._memberListener = null;
    this._speakerListener = null;
    this._interruptedListener = null;
    this._speakerRevision = 0;
  }

  get state() {
    return {
      ...this._state,
      speakingPlayerIds: [...this._state.speakingPlayerIds],
    };
  }

  capability() {
    if (!this.appId || this.appId === "touristappid" || !this.appId.startsWith("wx")) {
      return this._unavailable("not_configured");
    }
    if (!this.enabled) return this._unavailable("feature_disabled");
    if (!this.approvalGranted) return this._unavailable("approval_required");
    if (!this.privacyConfigured) return this._unavailable("privacy_not_configured");
    if (this.requireRealDevice && platformName(this.wx) === "devtools") {
      return this._unavailable("real_device_required");
    }
    const requiredMethods = [
      "joinVoIPChat",
      "exitVoIPChat",
      "updateVoIPChatMuteConfig",
      "onVoIPChatMembersChanged",
      "offVoIPChatMembersChanged",
      "onVoIPChatSpeakersChanged",
      "offVoIPChatSpeakersChanged",
      "onVoIPChatInterrupted",
      "offVoIPChatInterrupted",
      "authorize",
    ];
    if (requiredMethods.some((method) => typeof this.wx?.[method] !== "function")) {
      return this._unavailable("api_unavailable");
    }
    if (!this.getCredentials) return this._unavailable("signing_unavailable");
    return { available: true, reason: null, message: "" };
  }

  join(context = {}) {
    if (this._destroyed) return this._failure("destroyed");
    const attempt = ++this._attempt;
    return this._enqueue(() => this._join(context, attempt));
  }

  async _join(context, attempt) {
    if (this._destroyed || attempt !== this._attempt) return this._failure("cancelled");
    const capability = this.capability();
    if (!capability.available) {
      this._setState({ ...initialState(), status: "unavailable", errorCode: capability.reason });
      return this._failure(capability.reason);
    }

    await this._leaveCurrent({ reason: "replace_session", notify: true });
    if (this._destroyed || attempt !== this._attempt) return this._failure("cancelled");
    this._setState({
      ...initialState(),
      status: "requesting_permission",
      micMuted: true,
      speakerMuted: false,
    });

    try {
      if (this.ensurePrivacyConsent) {
        const consented = await callBounded(
          () => this.ensurePrivacyConsent(),
          this.wxCallTimeoutMs,
        );
        if (this._destroyed || attempt !== this._attempt) {
          return this._failure("cancelled");
        }
        if (!consented) throw Object.assign(new Error("privacy_denied"), { errorCode: "permission_denied" });
      }
      const permissionReady = await this._ensureRecordPermission(attempt);
      if (!permissionReady || this._destroyed || attempt !== this._attempt) {
        return this._failure("cancelled");
      }

      this._setState({ status: "connecting", errorCode: null });
      const credentials = await callBounded(
        () => this.getCredentials(context),
        this.wxCallTimeoutMs,
        {
          onLateResolve: (value) => this._cleanupLateCredentials(attempt, value),
        },
      );
      if (this._destroyed || attempt !== this._attempt) {
        this._setState(initialState());
        const groupId = String(credentials?.groupId || "").trim();
        if (groupId) {
          await this._notifyLeave({ groupId, reason: "cancelled" });
        }
        return this._failure("cancelled");
      }
      if (!isValidCredentials(credentials)) {
        throw Object.assign(new Error("invalid_voice_credentials"), {
          errorCode: "signing_unavailable",
        });
      }

      this._groupId = credentials.groupId;
      this._sessionAttempt = attempt;
      this._bindListeners(attempt);
      const result = await callWx(this.wx, "joinVoIPChat", {
        roomType: "voice",
        signature: credentials.signature,
        nonceStr: credentials.nonceStr,
        timeStamp: Number(credentials.timeStamp),
        groupId: credentials.groupId,
        muteConfig: {
          muteMicrophone: true,
          muteEarphone: false,
        },
      }, this.wxCallTimeoutMs, {
        onLateSuccess: () => this._cleanupLatePlatformJoin(attempt),
      });
      this._platformJoined = true;
      if (this._destroyed || attempt !== this._attempt) {
        const groupId = this._groupId;
        this._groupId = null;
        this._sessionAttempt = null;
        this._unbindListeners();
        this._setState(initialState());
        const notifyPromise = groupId
          ? this._notifyLeave({ groupId, reason: "cancelled" })
          : Promise.resolve();
        await Promise.all([notifyPromise, this._exitPlatformRoom()]);
        return this._failure("cancelled");
      }

      this._setState({
        status: "joined",
        joined: true,
        micMuted: true,
        speakerMuted: false,
        memberCount: uniqueIds(result?.openIdList).length,
        errorCode: null,
      });
      return { ok: true, state: this.state };
    } catch (error) {
      let cancelled = this._destroyed || attempt !== this._attempt;
      const groupId = this._groupId;
      this._unbindListeners();
      if (this._platformJoined) {
        await this._exitPlatformRoom();
        cancelled ||= this._destroyed || attempt !== this._attempt;
      }
      this._groupId = null;
      this._sessionAttempt = null;
      if (groupId) {
        await this._notifyLeave({
          groupId,
          reason: cancelled ? "cancelled" : "join_failed",
        });
        cancelled ||= this._destroyed || attempt !== this._attempt;
      }
      if (cancelled) {
        this._setState(initialState());
        return this._failure("cancelled");
      }
      const errorCode = joinErrorCode(error);
      this._reportError(errorCode, error);
      this._setState({ ...initialState(), status: "error", errorCode });
      return this._failure(errorCode);
    }
  }

  setMicrophoneMuted(muted) {
    const attempt = this._attempt;
    return this._enqueue(() =>
      this._updateMuteConfig({ micMuted: Boolean(muted) }, attempt),
    );
  }

  setSpeakerMuted(muted) {
    const attempt = this._attempt;
    return this._enqueue(() =>
      this._updateMuteConfig({ speakerMuted: Boolean(muted) }, attempt),
    );
  }

  leave({ reason = "leave", notify = true } = {}) {
    ++this._attempt;
    this._unbindListeners();
    this._setState({ speakingCount: 0, speakingPlayerIds: [] });
    return this._enqueue(() => this._leaveCurrent({ reason, notify }));
  }

  async _leaveCurrent({ reason, notify }) {
    const wasActive = this._state.joined || ["connecting", "requesting_permission"].includes(this._state.status);
    const groupId = this._groupId;
    const shouldExitPlatform = this._platformJoined || this._state.joined;
    this._groupId = null;
    this._sessionAttempt = null;
    this._unbindListeners();
    this._setState(initialState());
    const notifyPromise = notify && wasActive && groupId
      ? this._notifyLeave({ groupId, reason })
      : Promise.resolve();
    const exitPromise = shouldExitPlatform ? this._exitPlatformRoom() : Promise.resolve();
    await Promise.all([notifyPromise, exitPromise]);
    return { ok: true, state: this.state };
  }

  handleDisconnect() {
    return this.leave({ reason: "socket_disconnect" });
  }

  handleHide() {
    return this.leave({ reason: "hide" });
  }

  handleShow() {
    if (this._state.status === "interrupted") {
      return this._failure("interrupted");
    }
    return { ok: true, state: this.state };
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    ++this._attempt;
    this._unbindListeners();
    await this._enqueue(() => this._leaveCurrent({ reason: "destroy", notify: true }));
  }

  async _ensureRecordPermission(attempt) {
    if (typeof this.wx?.getSetting === "function") {
      const settings = await callWx(this.wx, "getSetting", {}, this.wxCallTimeoutMs);
      if (this._destroyed || attempt !== this._attempt) return false;
      const current = settings?.authSetting?.["scope.record"];
      if (current === true) return true;
      if (current === false) {
        throw Object.assign(new Error("record_permission_denied"), {
          errorCode: "permission_denied",
        });
      }
    }
    if (this._destroyed || attempt !== this._attempt) return false;
    await callWx(this.wx, "authorize", { scope: "scope.record" }, this.wxCallTimeoutMs);
    return !this._destroyed && attempt === this._attempt;
  }

  async _updateMuteConfig(patch, attempt) {
    if (attempt !== this._attempt || !this._state.joined) {
      return this._failure(attempt !== this._attempt ? "cancelled" : "not_joined");
    }
    const next = { ...this._state, ...patch };
    try {
      await callWx(this.wx, "updateVoIPChatMuteConfig", {
        muteConfig: {
          muteMicrophone: next.micMuted,
          muteEarphone: next.speakerMuted,
        },
      }, this.wxCallTimeoutMs);
      if (attempt !== this._attempt || !this._state.joined) return this._failure("cancelled");
      this._setState({
        micMuted: next.micMuted,
        speakerMuted: next.speakerMuted,
        errorCode: null,
      });
      return { ok: true, state: this.state };
    } catch (error) {
      const errorCode = joinErrorCode(error);
      this._reportError(errorCode, error);
      return this._failure(errorCode);
    }
  }

  async _notifyLeave(payload) {
    if (!this.notifyLeave) return;
    try {
      await callBounded(
        () => this.notifyLeave(payload),
        this.wxCallTimeoutMs,
      );
    } catch (error) {
      this._reportError("leave_notify_failed", error);
    }
  }

  async _exitPlatformRoom() {
    try {
      await callWx(this.wx, "exitVoIPChat", {}, this.wxCallTimeoutMs);
    } catch (error) {
      this._reportError("exit_failed", error);
    } finally {
      this._platformJoined = false;
    }
  }

  _enqueue(operation) {
    const result = this._operationChain.then(operation, operation);
    this._operationChain = result.catch(() => {});
    return result;
  }

  _cleanupLatePlatformJoin(attempt) {
    return this._enqueue(async () => {
      if (this._sessionAttempt !== null && this._sessionAttempt !== attempt) return;
      await this._exitPlatformRoom();
    });
  }

  _cleanupLateCredentials(attempt, credentials) {
    if (!isValidCredentials(credentials)) return Promise.resolve();
    const groupId = String(credentials.groupId).trim();
    return this._enqueue(async () => {
      if (this._sessionAttempt !== null && this._sessionAttempt !== attempt) return;
      await this._notifyLeave({
        groupId,
        reason: "late_credentials",
      });
    });
  }

  _bindListeners(attempt) {
    if (this._listenersBound) return;
    this._memberListener = (event) => this._handleMembersChanged(event, attempt);
    this._speakerListener = (event) => this._handleSpeakersChanged(event, attempt);
    this._interruptedListener = (event) => this._handleInterrupted(event, attempt);
    this._listenersBound = true;
    try {
      this.wx.onVoIPChatMembersChanged(this._memberListener);
      this.wx.onVoIPChatSpeakersChanged(this._speakerListener);
      this.wx.onVoIPChatInterrupted(this._interruptedListener);
    } catch (error) {
      this._unbindListeners();
      throw error;
    }
  }

  _unbindListeners() {
    if (this._listenersBound) {
      this.wx?.offVoIPChatMembersChanged?.(this._memberListener);
      this.wx?.offVoIPChatSpeakersChanged?.(this._speakerListener);
      this.wx?.offVoIPChatInterrupted?.(this._interruptedListener);
    }
    this._speakerRevision += 1;
    this._listenersBound = false;
    this._memberListener = null;
    this._speakerListener = null;
    this._interruptedListener = null;
  }

  _handleMembersChanged(event = {}, attempt) {
    if (attempt !== this._attempt || !["connecting", "joined"].includes(this._state.status)) {
      return;
    }
    const memberCount = uniqueIds(event.openIdList).length;
    this._speakerRevision += 1;
    this._setState({ memberCount, speakingCount: 0, speakingPlayerIds: [] });
    this.onMembersChanged?.({ memberCount, errCode: event.errCode });
  }

  _handleSpeakersChanged(event = {}, attempt) {
    if (attempt !== this._attempt || !["connecting", "joined"].includes(this._state.status)) {
      return;
    }
    const openIds = uniqueIds(event.openIdList);
    const speakingCount = openIds.length;
    const speakerRevision = ++this._speakerRevision;
    this._setState({ speakingCount, speakingPlayerIds: [] });
    this.onSpeakersChanged?.({ speakingCount, errCode: event.errCode });
    if (!openIds.length || !this.resolveSpeakerPlayerIds) return;
    let resolution;
    try {
      resolution = this.resolveSpeakerPlayerIds(openIds);
    } catch {
      return;
    }
    Promise.resolve(resolution)
      .then((playerIds) => {
        if (
          this._destroyed ||
          attempt !== this._attempt ||
          speakerRevision !== this._speakerRevision ||
          !["connecting", "joined"].includes(this._state.status)
        ) return;
        this._setState({ speakingPlayerIds: uniqueIds(playerIds, 120) });
      })
      .catch(() => {});
  }

  _handleInterrupted(event = {}, attempt) {
    if (
      attempt !== this._attempt ||
      (!this._state.joined && this._state.status !== "connecting")
    ) return;
    const groupId = this._groupId;
    ++this._attempt;
    this._groupId = null;
    this._sessionAttempt = null;
    this._platformJoined = false;
    this._unbindListeners();
    this._setState({
      ...initialState(),
      status: "interrupted",
      errorCode: "interrupted",
    });
    void this._notifyLeave({ groupId, reason: "interrupted", errCode: event.errCode });
    this._reportError("interrupted", event);
  }

  _setState(patch) {
    this._state = { ...this._state, ...patch };
    this.onStateChange?.(this.state);
  }

  _unavailable(reason) {
    return {
      available: false,
      reason,
      message: WECHAT_VOICE_REASON_MESSAGES[reason] || "实时语音暂不可用",
    };
  }

  _reportError(errorCode, error) {
    this.onError?.({ errorCode, error });
  }

  _failure(errorCode) {
    return {
      ok: false,
      errorCode,
      message: WECHAT_VOICE_REASON_MESSAGES[errorCode] || "实时语音操作失败",
      state: this.state,
    };
  }
}
