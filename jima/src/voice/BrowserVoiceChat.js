const MAX_REMOTE_PEERS = 3;
const MAX_PENDING_ICE_CANDIDATES = 64;

const DEFAULT_AUDIO_CONSTRAINTS = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
});

const LOCAL_METER_FFT_SIZE = 256;
const LOCAL_SPEAKING_ON = 0.2;
const LOCAL_SPEAKING_OFF = 0.1;

function initialState(speakerVolume = 1, speakerMuted = false) {
  return {
    status: "idle",
    joined: false,
    micMuted: true,
    speakerMuted,
    speakerVolume,
    peerCount: 0,
    audiblePeerCount: 0,
    localLevel: 0,
    localSpeaking: false,
    peerLevels: {},
    speakingPeerIds: [],
    errorCode: null,
  };
}

function stopStream(stream) {
  for (const track of stream?.getTracks?.() || []) track.stop?.();
}

function defaultGetUserMedia(constraints) {
  const mediaDevices = globalThis.navigator?.mediaDevices;
  if (!mediaDevices?.getUserMedia) throw new Error("media_devices_unavailable");
  return mediaDevices.getUserMedia(constraints);
}

function defaultCreatePeerConnection(configuration) {
  if (typeof globalThis.RTCPeerConnection !== "function") {
    throw new Error("rtc_peer_connection_unavailable");
  }
  return new globalThis.RTCPeerConnection(configuration);
}

function defaultCreateAudioElement() {
  return globalThis.document?.createElement?.("audio") || null;
}

function defaultCreateAudioContext() {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  return typeof AudioContextClass === "function" ? new AudioContextClass() : null;
}

function defaultRequestFrame(callback) {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(callback, 50);
}

function defaultCancelFrame(handle) {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(handle);
    return;
  }
  globalThis.clearTimeout(handle);
}

function clampUnit(value) {
  return Math.max(0, Math.min(1, value));
}

function normalizedId(value) {
  return String(value || "").trim().slice(0, 120);
}

function mediaErrorCode(error) {
  if (["NotAllowedError", "SecurityError"].includes(error?.name)) return "permission_denied";
  if (["NotFoundError", "DevicesNotFoundError"].includes(error?.name)) return "device_unavailable";
  if (["NotReadableError", "TrackStartError"].includes(error?.name)) return "device_busy";
  if (String(error?.message || "").includes("unavailable")) return "unsupported";
  return "media_error";
}

export function browserVoiceCapability() {
  const mediaDevices = globalThis.navigator?.mediaDevices;
  const supported = typeof globalThis.RTCPeerConnection === "function";
  return {
    available: supported,
    reason: supported ? null : "unsupported",
    microphoneAvailable: typeof mediaDevices?.getUserMedia === "function",
    secureContext: globalThis.isSecureContext !== false,
  };
}

export class BrowserVoiceChat {
  constructor({
    getUserMedia = defaultGetUserMedia,
    createPeerConnection = defaultCreatePeerConnection,
    createAudioElement = defaultCreateAudioElement,
    createAudioContext = defaultCreateAudioContext,
    requestFrame = defaultRequestFrame,
    cancelFrame = defaultCancelFrame,
    sendSignal,
    notifyLeave,
    onRemoteStream,
    onRemoteStreamRemoved,
    onStateChange,
    onError,
  } = {}) {
    this.getUserMedia = getUserMedia;
    this.createPeerConnection = createPeerConnection;
    this.createAudioElement = createAudioElement;
    this.createAudioContext = createAudioContext;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.sendSignal = typeof sendSignal === "function" ? sendSignal : null;
    this.notifyLeave = typeof notifyLeave === "function" ? notifyLeave : null;
    this.onRemoteStream = typeof onRemoteStream === "function" ? onRemoteStream : null;
    this.onRemoteStreamRemoved =
      typeof onRemoteStreamRemoved === "function" ? onRemoteStreamRemoved : null;
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : null;
    this.onError = typeof onError === "function" ? onError : null;

    this._speakerVolume = 1;
    this._state = initialState(this._speakerVolume);
    this._localStream = null;
    this._peers = new Map();
    this._iceServers = [];
    this._playerId = null;
    this._sessionId = null;
    this._attempt = 0;
    this._microphoneIntent = 0;
    this._microphonePromise = null;
    this._localMeter = null;
    this._remoteMeter = null;
    this._destroyed = false;
  }

  get state() {
    return {
      ...this._state,
      peerLevels: { ...this._state.peerLevels },
      speakingPeerIds: [...this._state.speakingPeerIds],
    };
  }

  get localStream() {
    return this._localStream;
  }

  async join({
    playerId,
    sessionId,
    peerIds = [],
    iceServers = [],
    speakerMuted = false,
    speakerVolume = this._speakerVolume,
  } = {}) {
    if (this._destroyed) return this._failure("destroyed");
    const nextPlayerId = normalizedId(playerId);
    const nextSessionId = normalizedId(sessionId);
    if (!nextPlayerId || !nextSessionId || !this.sendSignal) {
      return this._failure("not_configured");
    }
    const capability = browserVoiceCapability();
    if (!capability.available || !capability.secureContext) {
      return this._failure(capability.available ? "secure_context_required" : capability.reason);
    }

    await this.leave({ reason: "replace_session", notify: false });
    const attempt = ++this._attempt;
    this._playerId = nextPlayerId;
    this._sessionId = nextSessionId;
    const numericVolume = Number(speakerVolume);
    this._speakerVolume = Number.isFinite(numericVolume)
      ? Math.max(0, Math.min(1, numericVolume))
      : this._speakerVolume;
    this._iceServers = Array.isArray(iceServers) ? iceServers.map((server) => ({ ...server })) : [];
    this._setState({
      status: "joined",
      joined: true,
      errorCode: null,
      micMuted: true,
      speakerMuted: Boolean(speakerMuted),
      speakerVolume: this._speakerVolume,
      peerCount: 0,
      audiblePeerCount: 0,
    });

    try {
      const uniquePeerIds = [...new Set((Array.isArray(peerIds) ? peerIds : []).map(normalizedId))]
        .filter((peerId) => peerId && peerId !== this._playerId)
        .slice(0, MAX_REMOTE_PEERS);
      for (const peerId of uniquePeerIds) await this.addPeer(peerId);
    } catch (error) {
      this._reportError("signaling_error", error);
      await this.leave({ reason: "join_failed" });
      this._setState({ ...initialState(), status: "error", errorCode: "signaling_error" });
      return this._failure("signaling_error");
    }

    return { ok: true, state: this.state };
  }

  async addPeer(playerId) {
    const peerId = normalizedId(playerId);
    if (!this._state.joined || !peerId || peerId === this._playerId) return false;
    if (this._peers.has(peerId)) return true;
    if (this._peers.size >= MAX_REMOTE_PEERS) return false;

    const peer = this._createPeer(peerId);
    this._peers.set(peerId, peer);
    this._setState({ peerCount: this._peers.size });
    for (const track of this._localStream?.getAudioTracks?.() || []) {
      await this._attachLocalTrack(peer, track, this._localStream);
    }

    if (this._playerId.localeCompare(peerId) < 0) await this._negotiate(peerId, peer);
    return this._isPeerCurrent(peerId, peer);
  }

  async handleSignal({ sessionId, fromPlayerId, description, candidate } = {}) {
    const peerId = normalizedId(fromPlayerId);
    const signalSessionId = normalizedId(sessionId);
    const attempt = this._attempt;
    if (
      !this._state.joined ||
      signalSessionId !== this._sessionId ||
      !peerId ||
      peerId === this._playerId
    ) return false;

    await this.addPeer(peerId);
    if (attempt !== this._attempt || signalSessionId !== this._sessionId) return false;
    const peer = this._peers.get(peerId);
    if (!peer || !this._isPeerCurrent(peerId, peer)) return false;

    try {
      if (description) {
        const readyForOffer =
          !peer.makingOffer &&
          (peer.connection.signalingState === "stable" || peer.isSettingRemoteAnswerPending);
        const offerCollision = description.type === "offer" && !readyForOffer;
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return false;

        if (
          offerCollision &&
          peer.polite &&
          peer.connection.signalingState !== "stable"
        ) {
          await peer.connection.setLocalDescription({ type: "rollback" });
        }

        peer.isSettingRemoteAnswerPending = description.type === "answer";
        try {
          await peer.connection.setRemoteDescription(description);
        } finally {
          peer.isSettingRemoteAnswerPending = false;
        }
        if (!this._isPeerCurrent(peerId, peer)) return false;
        await this._flushPendingCandidates(peerId, peer);
        if (
          description.type === "answer" &&
          peer.needsNegotiation &&
          peer.connection.signalingState === "stable"
        ) {
          peer.needsNegotiation = false;
          await this._negotiate(peerId, peer);
        }
        if (description.type === "offer") {
          const answer = await peer.connection.createAnswer();
          if (!this._isPeerCurrent(peerId, peer)) return false;
          await peer.connection.setLocalDescription(answer);
          await this._emitSignal(peerId, peer, {
            description: peer.connection.localDescription,
          });
        }
      }
      if (candidate && !peer.ignoreOffer) {
        if (peer.connection.remoteDescription?.type) {
          await peer.connection.addIceCandidate(candidate);
        } else if (peer.pendingCandidates.length < MAX_PENDING_ICE_CANDIDATES) {
          peer.pendingCandidates.push(candidate);
        }
      }
      return true;
    } catch (error) {
      this._reportError("signaling_error", error);
      return false;
    }
  }

  removePeer(playerId) {
    const peerId = normalizedId(playerId);
    const peer = this._peers.get(peerId);
    if (!peer) return false;
    this._peers.delete(peerId);
    peer.connection.onicecandidate = null;
    peer.connection.ontrack = null;
    peer.connection.onconnectionstatechange = null;
    peer.connection.onnegotiationneeded = null;
    peer.connection.onsignalingstatechange = null;
    this._stopRemoteMeter(peerId, peer);
    peer.remoteStream = null;
    peer.pendingCandidates.length = 0;
    peer.remoteAudioTracks.clear();
    peer.localSenders.clear();
    peer.connection.close?.();
    if (peer.audio) {
      peer.audio.pause?.();
      peer.audio.srcObject = null;
    }
    this.onRemoteStreamRemoved?.({ playerId: peerId });
    this._setState({
      peerCount: this._peers.size,
      audiblePeerCount: this._audiblePeerCount(),
    });
    return true;
  }

  async setMicrophoneMuted(muted) {
    const microphoneIntent = ++this._microphoneIntent;
    const nextMuted = Boolean(muted);
    if (!nextMuted && !this._localStream) {
      const acquired = await this.ensureMicrophone();
      if (!acquired.ok) return acquired;
    }
    if (microphoneIntent !== this._microphoneIntent) {
      return { ok: true, state: this.state };
    }
    this._setState({ micMuted: nextMuted });
    this._applyMicrophoneState();
    if (nextMuted) {
      this._stopLocalMeter();
    } else {
      await this._startLocalMeter();
      if (microphoneIntent !== this._microphoneIntent || this._state.micMuted) {
        this._stopLocalMeter();
      }
    }
    return { ok: true, state: this.state };
  }

  async setSpeakerMuted(muted) {
    const speakerMuted = Boolean(muted);
    const meterRecovery = speakerMuted ? null : this._recoverRemoteMeters();
    const playback = [];
    for (const peer of this._peers.values()) {
      if (peer.audio) {
        peer.audio.muted = speakerMuted;
        peer.audio.volume = this._speakerVolume;
        if (!speakerMuted) playback.push(this._playRemoteAudio(peer));
      }
    }
    this._setState({ speakerMuted, audiblePeerCount: speakerMuted ? 0 : this._audiblePeerCount() });
    await meterRecovery?.catch?.(() => {});
    const results = await Promise.all(playback);
    const result = {
      ok: results.every(Boolean),
      errorCode: results.includes(false) ? "playback_blocked" : null,
      state: this.state,
    };
    return result;
  }

  async resumePlayback() {
    if (!this._state.joined || this._state.speakerMuted) {
      return { ok: true, state: this.state };
    }
    const meterRecovery = this._recoverRemoteMeters();
    const playback = [];
    for (const peer of this._peers.values()) {
      if (
        !peer.audio ||
        (peer.playbackActive && peer.audio.paused === false)
      ) continue;
      peer.audio.muted = false;
      peer.audio.volume = this._speakerVolume;
      playback.push(this._playRemoteAudio(peer));
    }
    await meterRecovery.catch(() => {});
    const results = await Promise.all(playback);
    return {
      ok: results.every(Boolean),
      errorCode: results.includes(false) ? "playback_blocked" : null,
      state: this.state,
    };
  }

  async setSpeakerVolume(value) {
    const numeric = Number(value);
    this._speakerVolume = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 1;
    for (const peer of this._peers.values()) {
      if (peer.audio) peer.audio.volume = this._speakerVolume;
    }
    this._setState({ speakerVolume: this._speakerVolume });
    return { ok: true, state: this.state };
  }

  async ensureMicrophone() {
    if (!this._state.joined) return this._failure("not_joined");
    if (this._localStream) return { ok: true, state: this.state };
    if (this._microphonePromise) return this._microphonePromise;
    const capability = browserVoiceCapability();
    if (!capability.microphoneAvailable || !capability.secureContext) {
      const errorCode = capability.secureContext ? "unsupported" : "secure_context_required";
      this._reportError(errorCode, new Error(errorCode));
      return this._failure(errorCode);
    }

    const operation = this._acquireMicrophone();
    this._microphonePromise = operation;
    try {
      return await operation;
    } finally {
      if (this._microphonePromise === operation) this._microphonePromise = null;
    }
  }

  async _acquireMicrophone() {
    const attempt = this._attempt;
    this._setState({ status: "requesting", errorCode: null });
    let stream;
    try {
      stream = await this.getUserMedia({
        audio: { ...DEFAULT_AUDIO_CONSTRAINTS },
        video: false,
      });
    } catch (error) {
      if (attempt !== this._attempt) return this._failure("cancelled");
      const errorCode = mediaErrorCode(error);
      this._reportError(errorCode, error);
      this._setState({ status: "joined", errorCode });
      return this._failure(errorCode);
    }

    if (attempt !== this._attempt || this._destroyed || !this._state.joined) {
      stopStream(stream);
      return this._failure("cancelled");
    }

    this._localStream = stream;
    this._applyMicrophoneState();
    try {
      const negotiations = [];
      for (const [peerId, peer] of this._peers) {
        for (const track of stream.getAudioTracks?.() || []) {
          await this._attachLocalTrack(peer, track, stream);
        }
        negotiations.push(this._negotiate(peerId, peer));
      }
      await Promise.all(negotiations);
    } catch (error) {
      for (const peer of this._peers.values()) {
        for (const track of stream.getAudioTracks?.() || []) {
          const sender = peer.localSenders.get(track);
          if (sender) peer.connection.removeTrack?.(sender);
          peer.localSenders.delete(track);
          peer.localTracks.delete(track);
        }
      }
      stopStream(stream);
      if (this._localStream === stream) this._localStream = null;
      this._reportError("signaling_error", error);
      this._setState({ status: "joined", micMuted: true, errorCode: "signaling_error" });
      return this._failure("signaling_error");
    }
    this._setState({ status: "joined", errorCode: null });
    return { ok: true, state: this.state };
  }

  async leave({ reason = "leave", notify = true } = {}) {
    const sessionId = this._sessionId;
    ++this._attempt;
    ++this._microphoneIntent;
    this._microphonePromise = null;
    this._stopLocalMeter();
    for (const peerId of [...this._peers.keys()]) this.removePeer(peerId);
    this._stopAllRemoteMeters();
    stopStream(this._localStream);
    this._localStream = null;
    this._resetSession();
    this._setState(initialState(this._speakerVolume));
    if (notify && sessionId && this.notifyLeave) {
      try {
        await this.notifyLeave({ sessionId, reason });
      } catch (error) {
        this._reportError("leave_notify_failed", error);
      }
    }
    return { ok: true, state: this.state };
  }

  handleDisconnect() {
    return this.leave({ reason: "socket_disconnect" });
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    await this.leave({ reason: "destroy" });
  }

  _createPeer(peerId) {
    const connection = this.createPeerConnection({ iceServers: this._iceServers });
    const audioTransceiver = connection.addTransceiver?.("audio", { direction: "recvonly" }) || null;
    const peer = {
      connection,
      audioTransceiver,
      audio: null,
      sessionId: this._sessionId,
      attempt: this._attempt,
      polite: this._playerId.localeCompare(peerId) > 0,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      pendingCandidates: [],
      localTracks: new Set(),
      localSenders: new Map(),
      remoteAudioTracks: new Set(),
      remoteStream: null,
      connected: false,
      hasRemoteAudio: false,
      playbackActive: false,
      needsNegotiation: false,
    };
    connection.onicecandidate = ({ candidate }) => {
      if (!candidate || !this._isPeerCurrent(peerId, peer)) return;
      this._emitSignal(peerId, peer, { candidate }).catch((error) => {
        if (this._isPeerCurrent(peerId, peer)) this._reportError("signaling_error", error);
      });
    };
    connection.ontrack = (event) => {
      if (!this._isPeerCurrent(peerId, peer)) return;
      const stream = event.streams?.[0];
      if (!stream) return;
      peer.remoteStream = stream;
      if (!peer.audio) {
        peer.audio = this.createAudioElement?.() || null;
        if (peer.audio) {
          peer.audio.autoplay = true;
          peer.audio.playsInline = true;
          peer.audio.addEventListener?.("pause", () => {
            if (!this._isPeerCurrent(peerId, peer)) return;
            peer.playbackActive = false;
            this._refreshAudiblePeerCount();
          });
        }
      }
      if (peer.audio) {
        peer.playbackActive = false;
        peer.audio.srcObject = stream;
        peer.audio.muted = this._state.speakerMuted;
        peer.audio.volume = this._speakerVolume;
        void this._playRemoteAudio(peer);
      }
      const remoteTracks = stream.getAudioTracks?.();
      const audioTracks = remoteTracks?.length
        ? [...remoteTracks]
        : event.track?.kind === "audio" ? [event.track] : [];
      for (const track of audioTracks) {
        if (peer.remoteAudioTracks.has(track)) continue;
        peer.remoteAudioTracks.add(track);
        const handleEnded = () => {
          if (!this._isPeerCurrent(peerId, peer)) return;
          peer.remoteAudioTracks.delete(track);
          peer.hasRemoteAudio = peer.remoteAudioTracks.size > 0;
          if (!peer.hasRemoteAudio) {
            if (peer.remoteStream === stream) peer.remoteStream = null;
            peer.playbackActive = false;
            this._stopRemoteMeter(peerId, peer);
          }
          this._refreshAudiblePeerCount();
        };
        const handleMute = () => this._silenceRemoteMeter(peerId, peer);
        if (track.addEventListener) track.addEventListener("ended", handleEnded, { once: true });
        else track.onended = handleEnded;
        track.addEventListener?.("mute", handleMute);
      }
      peer.hasRemoteAudio = peer.remoteAudioTracks.size > 0;
      if (peer.hasRemoteAudio) void this._startRemoteMeter(peerId, peer, stream);
      this._refreshAudiblePeerCount();
      this.onRemoteStream?.({
        playerId: peerId,
        stream,
        speakerMuted: this._state.speakerMuted,
      });
    };
    connection.onsignalingstatechange = () => {
      if (
        peer.needsNegotiation &&
        connection.signalingState === "stable" &&
        this._isPeerCurrent(peerId, peer)
      ) {
        peer.needsNegotiation = false;
        this._negotiate(peerId, peer).catch((error) => {
          if (this._isPeerCurrent(peerId, peer)) this._reportError("signaling_error", error);
        });
      }
    };
    connection.onconnectionstatechange = () => {
      peer.connected = connection.connectionState === "connected";
      if (!peer.connected) this._silenceRemoteMeter(peerId, peer);
      this._refreshAudiblePeerCount();
      if (
        this._isPeerCurrent(peerId, peer) &&
        ["failed", "closed"].includes(connection.connectionState)
      ) {
        this.removePeer(peerId);
      }
    };
    connection.onnegotiationneeded = () => {
      this._negotiate(peerId, peer).catch((error) => {
        if (this._isPeerCurrent(peerId, peer)) this._reportError("signaling_error", error);
      });
    };
    return peer;
  }

  async _attachLocalTrack(peer, track, stream) {
    if (peer.localTracks.has(track)) return peer.localSenders.get(track) || null;
    let sender = peer.audioTransceiver?.sender || null;
    if (!sender?.track && typeof sender?.replaceTrack === "function") {
      await sender.replaceTrack(track);
      sender.setStreams?.(stream);
      if (peer.audioTransceiver.direction === "recvonly") {
        peer.audioTransceiver.direction = "sendrecv";
      } else if (peer.audioTransceiver.direction === "inactive") {
        peer.audioTransceiver.direction = "sendonly";
      }
    } else {
      sender = peer.connection.addTrack(track, stream);
    }
    peer.localTracks.add(track);
    peer.localSenders.set(track, sender);
    return sender;
  }

  async _negotiate(peerId, peer) {
    if (!this._isPeerCurrent(peerId, peer) || peer.makingOffer) return false;
    if (peer.connection.signalingState !== "stable") {
      peer.needsNegotiation = true;
      return false;
    }

    peer.makingOffer = true;
    try {
      const offer = peer.audioTransceiver
        ? await peer.connection.createOffer()
        : await peer.connection.createOffer({ offerToReceiveAudio: true });
      if (
        !this._isPeerCurrent(peerId, peer) ||
        peer.connection.signalingState !== "stable"
      ) return false;
      await peer.connection.setLocalDescription(offer);
      if (!this._isPeerCurrent(peerId, peer)) return false;
      await this._emitSignal(peerId, peer, {
        description: peer.connection.localDescription,
      });
      return true;
    } finally {
      peer.makingOffer = false;
    }
  }

  async _emitSignal(peerId, peer, payload) {
    if (!this.sendSignal || !this._isPeerCurrent(peerId, peer)) {
      throw new Error("signaling_session_expired");
    }
    await this.sendSignal({
      sessionId: peer.sessionId,
      toPlayerId: peerId,
      ...payload,
    });
  }

  async _flushPendingCandidates(peerId, peer) {
    const pendingCandidates = peer.pendingCandidates.splice(0);
    for (const pendingCandidate of pendingCandidates) {
      if (!this._isPeerCurrent(peerId, peer)) return;
      await peer.connection.addIceCandidate(pendingCandidate);
    }
  }

  async _playRemoteAudio(peer) {
    if (!peer.audio || peer.audio.muted) {
      peer.playbackActive = false;
      this._refreshAudiblePeerCount();
      return true;
    }
    try {
      await peer.audio.play?.();
      peer.playbackActive = true;
      this._refreshAudiblePeerCount();
      return true;
    } catch (error) {
      peer.playbackActive = false;
      this._refreshAudiblePeerCount();
      if ([...this._peers.values()].includes(peer)) {
        this._reportError("playback_blocked", error);
      }
      return false;
    }
  }

  _audiblePeerCount() {
    if (this._state.speakerMuted) return 0;
    let count = 0;
    for (const peer of this._peers.values()) {
      if (peer.connected && peer.hasRemoteAudio && peer.playbackActive) count += 1;
    }
    return count;
  }

  _refreshAudiblePeerCount() {
    const audiblePeerCount = this._audiblePeerCount();
    if (audiblePeerCount !== this._state.audiblePeerCount) {
      this._setState({ audiblePeerCount });
    }
  }

  _isPeerCurrent(peerId, peer) {
    return Boolean(
      this._state.joined &&
        this._peers.get(peerId) === peer &&
        peer.sessionId === this._sessionId &&
        peer.attempt === this._attempt,
    );
  }

  async _startLocalMeter() {
    if (this._localMeter || this._state.micMuted || !this._localStream) return false;
    let context;
    let source;
    try {
      context = this.createAudioContext?.();
      if (!context?.createAnalyser || !context?.createMediaStreamSource) return false;
      const analyser = context.createAnalyser();
      analyser.fftSize = LOCAL_METER_FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      source = context.createMediaStreamSource(this._localStream);
      source.connect(analyser);
      const meter = {
        context,
        source,
        analyser,
        samples: new Uint8Array(analyser.fftSize || LOCAL_METER_FFT_SIZE),
        frame: null,
        smoothedLevel: 0,
      };
      this._localMeter = meter;
      if (context.state === "suspended") await context.resume?.();
      if (this._localMeter !== meter || this._state.micMuted) {
        this._stopLocalMeter();
        return false;
      }
      this._scheduleLocalMeter(meter);
      return true;
    } catch {
      source?.disconnect?.();
      try {
        await context?.close?.();
      } catch {
        // Metering is optional; microphone transmission can continue without it.
      }
      this._localMeter = null;
      this._setLocalLevel(0, false);
      return false;
    }
  }

  _scheduleLocalMeter(meter) {
    meter.frame = this.requestFrame(() => {
      meter.frame = null;
      if (this._localMeter !== meter || this._state.micMuted) return;
      meter.analyser.getByteTimeDomainData(meter.samples);
      let sumSquares = 0;
      for (const sample of meter.samples) {
        const normalized = (sample - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / Math.max(1, meter.samples.length));
      const rawLevel = clampUnit((rms - 0.012) / 0.24);
      const blend = rawLevel > meter.smoothedLevel ? 0.72 : 0.24;
      meter.smoothedLevel += (rawLevel - meter.smoothedLevel) * blend;
      const level = Math.round(clampUnit(meter.smoothedLevel) * 10) / 10;
      const speaking = this._state.localSpeaking
        ? level >= LOCAL_SPEAKING_OFF
        : level >= LOCAL_SPEAKING_ON;
      this._setLocalLevel(level, speaking);
      this._scheduleLocalMeter(meter);
    });
  }

  _stopLocalMeter() {
    const meter = this._localMeter;
    this._localMeter = null;
    if (meter?.frame !== null && meter?.frame !== undefined) this.cancelFrame(meter.frame);
    meter?.source?.disconnect?.();
    try {
      const closing = meter?.context?.close?.();
      closing?.catch?.(() => {});
    } catch {
      // Cleanup must never prevent muting or leaving a room.
    }
    this._setLocalLevel(0, false);
  }

  _setLocalLevel(localLevel, localSpeaking) {
    if (
      localLevel === this._state.localLevel &&
      localSpeaking === this._state.localSpeaking
    ) return;
    this._setState({ localLevel, localSpeaking });
  }

  async _recoverRemoteMeters() {
    if (!this._state.joined) return false;
    const manager = this._remoteMeter;
    if (manager?.context?.state === "suspended") {
      try {
        await manager.context.resume?.();
      } catch {
        // A later user gesture may rebuild a meter that remains unavailable.
      }
      if (this._remoteMeter === manager) this._scheduleRemoteMeters(manager);
    }

    const starts = [];
    for (const [peerId, peer] of this._peers) {
      if (
        !this._isPeerCurrent(peerId, peer) ||
        !peer.hasRemoteAudio ||
        !peer.remoteStream ||
        this._remoteMeter?.meters.get(peerId)?.peer === peer
      ) continue;
      starts.push(this._startRemoteMeter(peerId, peer, peer.remoteStream));
    }
    if (!starts.length) return true;
    const results = await Promise.allSettled(starts);
    return results.some((result) => result.status === "fulfilled" && result.value === true);
  }

  async _startRemoteMeter(peerId, peer, stream) {
    if (!this._isPeerCurrent(peerId, peer) || !stream) return false;
    const existing = this._remoteMeter?.meters.get(peerId);
    if (existing?.stream === stream) return true;
    if (existing) this._stopRemoteMeter(peerId, peer);

    let manager = this._remoteMeter;
    if (!manager) {
      const context = this.createAudioContext?.();
      if (!context?.createAnalyser || !context?.createMediaStreamSource) return false;
      manager = { context, meters: new Map(), frame: null };
      this._remoteMeter = manager;
    }

    let source;
    let meter;
    try {
      const analyser = manager.context.createAnalyser();
      analyser.fftSize = LOCAL_METER_FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      source = manager.context.createMediaStreamSource(stream);
      source.connect(analyser);
      meter = {
        peer,
        stream,
        source,
        analyser,
        samples: new Uint8Array(analyser.fftSize || LOCAL_METER_FFT_SIZE),
        smoothedLevel: 0,
      };
      manager.meters.set(peerId, meter);
      this._setRemoteLevel(peerId, 0, false);
      if (manager.context.state === "suspended") await manager.context.resume?.();
      if (
        this._remoteMeter !== manager ||
        manager.meters.get(peerId) !== meter ||
        !this._isPeerCurrent(peerId, peer)
      ) {
        this._stopRemoteMeter(peerId, peer, { manager, meter });
        return false;
      }
      this._scheduleRemoteMeters(manager);
      return true;
    } catch {
      source?.disconnect?.();
      if (this._remoteMeter === manager && manager.meters.size === 0) {
        if (manager.frame !== null) this.cancelFrame(manager.frame);
        manager.frame = null;
        this._remoteMeter = null;
        try {
          const closing = manager.context?.close?.();
          closing?.catch?.(() => {});
        } catch {
          // Unsupported metering must not interrupt remote audio playback.
        }
      }
      this._stopRemoteMeter(peerId, peer, meter ? { manager, meter } : null);
      return false;
    }
  }

  _scheduleRemoteMeters(manager) {
    if (this._remoteMeter !== manager || manager.frame !== null || !manager.meters.size) return;
    manager.frame = this.requestFrame(() => {
      manager.frame = null;
      if (this._remoteMeter !== manager) return;
      for (const [peerId, meter] of [...manager.meters]) {
        if (!this._isPeerCurrent(peerId, meter.peer) || !meter.peer.hasRemoteAudio) {
          this._stopRemoteMeter(peerId, meter.peer);
          continue;
        }
        const activeTrack = [...meter.peer.remoteAudioTracks].some(
          (track) => track.readyState !== "ended" && track.muted !== true,
        );
        if (!meter.peer.connected || !activeTrack) {
          meter.smoothedLevel = 0;
          this._setRemoteLevel(peerId, 0, false);
          continue;
        }
        meter.analyser.getByteTimeDomainData(meter.samples);
        let sumSquares = 0;
        for (const sample of meter.samples) {
          const normalized = (sample - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / Math.max(1, meter.samples.length));
        const rawLevel = clampUnit((rms - 0.012) / 0.24);
        const blend = rawLevel > meter.smoothedLevel ? 0.72 : 0.24;
        meter.smoothedLevel += (rawLevel - meter.smoothedLevel) * blend;
        const level = Math.round(clampUnit(meter.smoothedLevel) * 10) / 10;
        const wasSpeaking = this._state.speakingPeerIds.includes(peerId);
        const speaking = wasSpeaking
          ? level >= LOCAL_SPEAKING_OFF
          : level >= LOCAL_SPEAKING_ON;
        this._setRemoteLevel(peerId, level, speaking);
      }
      this._scheduleRemoteMeters(manager);
    });
  }

  _silenceRemoteMeter(peerId, peer) {
    const meter = this._remoteMeter?.meters.get(peerId);
    if (!meter || meter.peer !== peer) return;
    meter.smoothedLevel = 0;
    this._setRemoteLevel(peerId, 0, false);
  }

  _stopRemoteMeter(peerId, peer = null, expected = null) {
    const manager = this._remoteMeter;
    const meter = manager?.meters.get(peerId);
    if (expected && (manager !== expected.manager || meter !== expected.meter)) {
      expected.meter?.source?.disconnect?.();
      return;
    }
    if (!manager || !meter || (peer && meter.peer !== peer)) {
      this._deleteRemoteLevel(peerId);
      return;
    }
    manager.meters.delete(peerId);
    meter.source?.disconnect?.();
    this._deleteRemoteLevel(peerId);
    if (manager.meters.size) return;
    if (manager.frame !== null) this.cancelFrame(manager.frame);
    manager.frame = null;
    this._remoteMeter = null;
    try {
      const closing = manager.context?.close?.();
      closing?.catch?.(() => {});
    } catch {
      // Remote activity is optional; cleanup must not prevent leaving voice.
    }
  }

  _stopAllRemoteMeters() {
    const manager = this._remoteMeter;
    if (!manager) {
      if (Object.keys(this._state.peerLevels).length || this._state.speakingPeerIds.length) {
        this._setState({ peerLevels: {}, speakingPeerIds: [] });
      }
      return;
    }
    if (manager.frame !== null) this.cancelFrame(manager.frame);
    for (const meter of manager.meters.values()) meter.source?.disconnect?.();
    manager.meters.clear();
    manager.frame = null;
    this._remoteMeter = null;
    try {
      const closing = manager.context?.close?.();
      closing?.catch?.(() => {});
    } catch {
      // Remote activity is optional; cleanup must not prevent leaving voice.
    }
    this._setState({ peerLevels: {}, speakingPeerIds: [] });
  }

  _setRemoteLevel(peerId, level, speaking) {
    const currentLevel = this._state.peerLevels[peerId];
    const wasSpeaking = this._state.speakingPeerIds.includes(peerId);
    if (currentLevel === level && wasSpeaking === speaking) return;
    const peerLevels = { ...this._state.peerLevels, [peerId]: level };
    const speakingIds = new Set(this._state.speakingPeerIds);
    if (speaking) speakingIds.add(peerId);
    else speakingIds.delete(peerId);
    this._setState({
      peerLevels,
      speakingPeerIds: [...speakingIds].sort(),
    });
  }

  _deleteRemoteLevel(peerId) {
    const hasLevel = Object.hasOwn(this._state.peerLevels, peerId);
    const wasSpeaking = this._state.speakingPeerIds.includes(peerId);
    if (!hasLevel && !wasSpeaking) return;
    const peerLevels = { ...this._state.peerLevels };
    delete peerLevels[peerId];
    this._setState({
      peerLevels,
      speakingPeerIds: this._state.speakingPeerIds.filter((id) => id !== peerId),
    });
  }

  _applyMicrophoneState() {
    for (const track of this._localStream?.getAudioTracks?.() || []) {
      track.enabled = !this._state.micMuted;
    }
  }

  _resetSession() {
    this._playerId = null;
    this._sessionId = null;
    this._iceServers = [];
  }

  _setState(patch) {
    this._state = { ...this._state, ...patch };
    this.onStateChange?.(this.state);
  }

  _reportError(errorCode, error) {
    this.onError?.({ errorCode, error });
  }

  _failure(errorCode) {
    return { ok: false, errorCode, state: this.state };
  }
}
