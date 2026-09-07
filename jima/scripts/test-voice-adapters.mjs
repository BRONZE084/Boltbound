import assert from "node:assert/strict";
import test from "node:test";

import { BrowserVoiceChat } from "../src/voice/BrowserVoiceChat.js";
import { WechatVoiceChat } from "../src/wechat/WechatVoiceChat.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

class MockPeerConnection {
  constructor() {
    this.signalingState = "stable";
    this.connectionState = "new";
    this.localDescription = null;
    this.remoteDescription = null;
    this.addedCandidates = [];
    this.addedTracks = [];
    this.addedTransceivers = [];
    this.removedTracks = [];
    this.localDescriptionHistory = [];
    this.closed = false;
  }

  addTrack(track) {
    const sender = { track };
    this.addedTracks.push(track);
    return sender;
  }

  addTransceiver(kind, init = {}) {
    const sender = {
      track: null,
      streams: [],
      async replaceTrack(track) { this.track = track; },
      setStreams(...streams) { this.streams = streams; },
    };
    const transceiver = {
      kind,
      direction: init.direction || "sendrecv",
      sender,
    };
    this.addedTransceivers.push(transceiver);
    return transceiver;
  }

  removeTrack(sender) {
    this.removedTracks.push(sender.track);
  }

  async createOffer() {
    return { type: "offer", sdp: "local-offer" };
  }

  async createAnswer() {
    return { type: "answer", sdp: "local-answer" };
  }

  async setLocalDescription(description) {
    this.localDescriptionHistory.push(description);
    if (description.type === "rollback") {
      this.localDescription = null;
      this.signalingState = "stable";
      return;
    }
    this.localDescription = description;
    this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  }

  async addIceCandidate(candidate) {
    assert.ok(this.remoteDescription, "ICE must wait for a remote description");
    this.addedCandidates.push(candidate);
  }

  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
}

function streamMock(name) {
  const track = {
    kind: "audio",
    enabled: true,
    stopped: false,
    stop() { this.stopped = true; },
    addEventListener(type, listener) {
      if (type === "ended") this.onended = listener;
    },
  };
  return {
    name,
    track,
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalRtc = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
const originalSecureContext = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");

test.before(() => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia() {} } },
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    value: MockPeerConnection,
  });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
});

test.after(() => {
  for (const [key, descriptor] of [
    ["navigator", originalNavigator],
    ["RTCPeerConnection", originalRtc],
    ["isSecureContext", originalSecureContext],
  ]) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

test("browser voice queues ICE, resolves glare, retries playback, and isolates old peers", async () => {
  const connections = [];
  const signals = [];
  const errors = [];
  const localStream = streamMock("local-one");
  let gumCalls = 0;
  const audio = {
    muted: false,
    srcObject: null,
    playCalls: 0,
    pauseCalls: 0,
    play() { this.playCalls += 1; return Promise.resolve(); },
    pause() { this.pauseCalls += 1; },
  };
  const voice = new BrowserVoiceChat({
    getUserMedia: async () => {
      gumCalls += 1;
      return localStream;
    },
    createPeerConnection: () => {
      const connection = new MockPeerConnection();
      connections.push(connection);
      return connection;
    },
    createAudioElement: () => audio,
    sendSignal: async (signal) => signals.push(signal),
    onError: (error) => errors.push(error),
  });

  assert.equal((await voice.join({ playerId: "z", sessionId: "room-one" })).ok, true);
  assert.equal(gumCalls, 0, "receiver-only join must not request microphone permission");
  assert.equal(voice.localStream, null);
  assert.equal(voice.state.micMuted, true);
  const candidate = { candidate: "candidate-before-description" };
  assert.equal(await voice.handleSignal({
    sessionId: "room-one",
    fromPlayerId: "a",
    candidate,
  }), true);
  assert.equal(connections[0].addedCandidates.length, 0);

  const remoteStream = streamMock("remote-stream");
  connections[0].ontrack({ track: remoteStream.track, streams: [remoteStream] });
  assert.equal(audio.playCalls, 1);
  assert.equal(voice.state.audiblePeerCount, 0, "a track alone is not yet audible");
  connections[0].connectionState = "connected";
  connections[0].onconnectionstatechange();
  await tick();
  assert.equal(voice.state.audiblePeerCount, 1);
  remoteStream.track.onended();
  assert.equal(voice.state.audiblePeerCount, 0, "ended remote tracks must not remain audible");
  await voice.setSpeakerMuted(true);
  await voice.setSpeakerMuted(false);
  assert.equal(audio.playCalls, 2, "unmuting retries browser playback");

  assert.equal(await voice.handleSignal({
    sessionId: "room-one",
    fromPlayerId: "a",
    description: { type: "offer", sdp: "remote-offer" },
  }), true);
  assert.deepEqual(connections[0].addedCandidates, [candidate]);
  assert.equal(signals.at(-1).description.type, "answer");

  connections[0].signalingState = "have-local-offer";
  connections[0].localDescription = { type: "offer", sdp: "glare" };
  assert.equal(await voice.handleSignal({
    sessionId: "room-one",
    fromPlayerId: "a",
    description: { type: "offer", sdp: "colliding-offer" },
  }), true);
  assert.equal(connections[0].localDescriptionHistory.at(-2).type, "rollback");
  assert.equal(connections[0].localDescription.type, "answer");

  assert.equal((await voice.setMicrophoneMuted(false)).ok, true);
  assert.equal(gumCalls, 1);
  assert.equal(connections[0].addedTracks.length, 0);
  assert.equal(connections[0].addedTransceivers.length, 1);
  assert.equal(connections[0].addedTransceivers[0].sender.track, localStream.track);
  assert.equal(connections[0].addedTransceivers[0].direction, "sendrecv");
  assert.equal(localStream.track.enabled, true);
  assert.equal(signals.at(-1).description.type, "offer", "lazy microphone addTrack must renegotiate");
  const offerCount = signals.filter((signal) => signal.description?.type === "offer").length;
  assert.equal((await voice.setMicrophoneMuted(true)).ok, true);
  assert.equal(localStream.track.enabled, false);
  assert.equal((await voice.setMicrophoneMuted(false)).ok, true);
  assert.equal(gumCalls, 1, "reenabling an acquired microphone must reuse its stream");
  assert.equal(connections[0].addedTracks.length, 0);
  assert.equal(signals.filter((signal) => signal.description?.type === "offer").length, offerCount);

  const staleIceHandler = connections[0].onicecandidate;
  assert.equal((await voice.join({ playerId: "z", sessionId: "room-two" })).ok, true);
  const signalCount = signals.length;
  staleIceHandler({ candidate: { candidate: "stale" } });
  await tick();
  assert.equal(signals.length, signalCount, "old peer cannot signal into a replacement session");
  assert.equal(connections[0].closed, true);
  assert.equal(localStream.track.stopped, true);
  assert.equal(audio.pauseCalls, 1);
  assert.equal(errors.length, 0);
  await voice.destroy();
});

test("browser receiver-only initiator reserves an audio media section before microphone permission", async () => {
  const connections = [];
  const signals = [];
  const localStream = streamMock("late-sender");
  let gumCalls = 0;
  const voice = new BrowserVoiceChat({
    getUserMedia: async () => {
      gumCalls += 1;
      return localStream;
    },
    createPeerConnection: () => {
      const connection = new MockPeerConnection();
      connections.push(connection);
      return connection;
    },
    sendSignal: async (signal) => signals.push(signal),
  });

  assert.equal((await voice.join({ playerId: "a", sessionId: "receiver-first", peerIds: ["z"] })).ok, true);
  assert.equal(gumCalls, 0, "receiver-only join must not request microphone permission");
  assert.equal(connections[0].addedTransceivers.length, 1);
  assert.equal(connections[0].addedTransceivers[0].kind, "audio");
  assert.equal(connections[0].addedTransceivers[0].direction, "recvonly");
  assert.equal(signals.at(-1).description.type, "offer");
  await voice.handleSignal({
    sessionId: "receiver-first",
    fromPlayerId: "z",
    description: { type: "answer", sdp: "remote-answer" },
  });
  assert.equal((await voice.setMicrophoneMuted(false)).ok, true);
  assert.equal(gumCalls, 1);
  assert.equal(connections[0].addedTransceivers[0].sender.track, localStream.track);
  assert.equal(connections[0].addedTransceivers[0].direction, "sendrecv");
  await voice.destroy();
});

test("browser voice serializes lazy microphone intent and cancels media after leave", async () => {
  const firstMedia = deferred();
  const firstStream = streamMock("lazy");
  let requestCount = 0;
  const connections = [];
  const voice = new BrowserVoiceChat({
    getUserMedia: () => {
      requestCount += 1;
      return firstMedia.promise;
    },
    createPeerConnection: () => {
      const connection = new MockPeerConnection();
      connections.push(connection);
      return connection;
    },
    sendSignal: async () => {},
  });

  assert.equal((await voice.join({ playerId: "z", sessionId: "lazy-room", peerIds: ["a"] })).ok, true);
  const firstEnable = voice.setMicrophoneMuted(false);
  const secondEnable = voice.setMicrophoneMuted(false);
  await tick();
  assert.equal(requestCount, 1, "concurrent enables must share one getUserMedia request");
  assert.equal((await voice.setMicrophoneMuted(true)).ok, true);
  firstMedia.resolve(firstStream);
  assert.equal((await firstEnable).ok, true);
  assert.equal((await secondEnable).ok, true);
  assert.equal(voice.state.micMuted, true, "a later mute intent wins over pending enables");
  assert.equal(firstStream.track.enabled, false);
  assert.equal(connections[0].addedTracks.length, 0);
  assert.equal(connections[0].addedTransceivers[0].sender.track, firstStream.track);
  assert.equal((await voice.setMicrophoneMuted(false)).ok, true);
  assert.equal(requestCount, 1);
  assert.equal(firstStream.track.enabled, true);
  await voice.leave();

  const lateMedia = deferred();
  const lateStream = streamMock("late");
  const lateVoice = new BrowserVoiceChat({
    getUserMedia: () => lateMedia.promise,
    createPeerConnection: () => new MockPeerConnection(),
    sendSignal: async () => {},
  });
  await lateVoice.join({ playerId: "a", sessionId: "late-room" });
  const lateEnable = lateVoice.setMicrophoneMuted(false);
  await tick();
  await lateVoice.leave();
  lateMedia.resolve(lateStream);
  assert.equal((await lateEnable).errorCode, "cancelled");
  assert.equal(lateStream.track.stopped, true);
});

test("browser voice exposes autoplay blocks and speaker clicks retry playback", async () => {
  let playCalls = 0;
  const audio = {
    muted: false,
    volume: 1,
    play() {
      playCalls += 1;
      return playCalls === 1 ? Promise.reject(new Error("autoplay")) : Promise.resolve();
    },
    pause() {},
  };
  const errors = [];
  const voice = new BrowserVoiceChat({
    createPeerConnection: () => new MockPeerConnection(),
    createAudioElement: () => audio,
    sendSignal: async () => {},
    onError: ({ errorCode }) => errors.push(errorCode),
  });
  await voice.join({ playerId: "z", sessionId: "playback", peerIds: ["a"] });
  const remote = streamMock("remote");
  voice._peers.get("a").connection.ontrack({ track: remote.track, streams: [remote] });
  voice._peers.get("a").connection.connectionState = "connected";
  voice._peers.get("a").connection.onconnectionstatechange();
  await tick();
  assert.deepEqual(errors, ["playback_blocked"]);
  assert.equal(voice.state.audiblePeerCount, 0, "blocked audio must not be reported as audible");
  const retry = await voice.resumePlayback();
  assert.equal(retry.ok, true);
  assert.equal(playCalls, 2);
  assert.equal(voice.state.audiblePeerCount, 1, "a successful gesture retry becomes audible");
  await voice.leave();
});

test("browser voice meters the local microphone only while explicitly unmuted", async () => {
  const frames = new Map();
  const audioContexts = [];
  let nextFrameId = 0;
  const localStream = streamMock("metered-local");
  const voice = new BrowserVoiceChat({
    getUserMedia: async () => localStream,
    createPeerConnection: () => new MockPeerConnection(),
    createAudioContext: () => {
      const analyser = {
        fftSize: 0,
        smoothingTimeConstant: 0,
        getByteTimeDomainData(buffer) {
          for (let index = 0; index < buffer.length; index += 1) {
            buffer[index] = index % 2 ? 176 : 80;
          }
        },
      };
      const source = {
        connectedTo: null,
        disconnected: false,
        connect(target) { this.connectedTo = target; },
        disconnect() { this.disconnected = true; },
      };
      const context = {
        state: "suspended",
        analyser,
        source,
        resumeCalls: 0,
        closeCalls: 0,
        createAnalyser: () => analyser,
        createMediaStreamSource: (stream) => {
          assert.equal(stream, localStream);
          return source;
        },
        async resume() { this.resumeCalls += 1; this.state = "running"; },
        async close() { this.closeCalls += 1; this.state = "closed"; },
      };
      audioContexts.push(context);
      return context;
    },
    requestFrame: (callback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
    sendSignal: async () => {},
  });

  await voice.join({ playerId: "meter", sessionId: "meter-room" });
  assert.equal(audioContexts.length, 0, "joining or listening must not create a meter");
  assert.equal(voice.state.localLevel, 0);
  assert.equal(voice.state.localSpeaking, false);

  assert.equal((await voice.setMicrophoneMuted(false)).ok, true);
  assert.equal(audioContexts.length, 1);
  assert.equal(audioContexts[0].resumeCalls, 1);
  assert.equal(audioContexts[0].source.connectedTo, audioContexts[0].analyser);
  const firstFrame = [...frames.values()][0];
  frames.clear();
  firstFrame();
  assert.ok(voice.state.localLevel >= 0.5, "a strong input should produce a visible level");
  assert.equal(voice.state.localSpeaking, true);

  await voice.setMicrophoneMuted(true);
  assert.equal(voice.state.localLevel, 0);
  assert.equal(voice.state.localSpeaking, false);
  assert.equal(audioContexts[0].source.disconnected, true);
  assert.equal(audioContexts[0].closeCalls, 1);
  assert.equal(frames.size, 0);

  await voice.setMicrophoneMuted(false);
  assert.equal(audioContexts.length, 2, "reenabling creates a fresh analyser without reacquiring media");
  await voice.leave();
  assert.equal(audioContexts[1].closeCalls, 1);
  assert.equal(voice.state.localLevel, 0);
  assert.equal(voice.state.localSpeaking, false);
});

test("browser voice attributes remote activity to each player and clears stale meters", async () => {
  const frames = new Map();
  const contexts = [];
  const connections = [];
  let nextFrameId = 0;
  const streams = {
    loud: streamMock("remote-loud"),
    quiet: streamMock("remote-quiet"),
  };
  streams.loud.level = "loud";
  streams.quiet.level = "quiet";

  const voice = new BrowserVoiceChat({
    createPeerConnection: () => {
      const connection = new MockPeerConnection();
      connections.push(connection);
      return connection;
    },
    createAudioElement: () => ({
      muted: false,
      paused: false,
      play: () => Promise.resolve(),
      pause() { this.paused = true; },
    }),
    createAudioContext: () => {
      const analysers = [];
      const sources = [];
      const createAnalyser = () => ({
        fftSize: 0,
        smoothingTimeConstant: 0,
        stream: null,
        getByteTimeDomainData(buffer) {
          const loud = this.stream?.level === "loud";
          for (let index = 0; index < buffer.length; index += 1) {
            buffer[index] = loud ? (index % 2 ? 176 : 80) : 128;
          }
        },
      });
      const context = {
        state: "running",
        analysers,
        sources,
        closeCalls: 0,
        createAnalyser: () => {
          const analyser = createAnalyser();
          analysers.push(analyser);
          return analyser;
        },
        createMediaStreamSource: (stream) => {
          analysers.at(-1).stream = stream;
          const source = {
            disconnected: false,
            connect() {},
            disconnect() { this.disconnected = true; },
          };
          sources.push(source);
          return source;
        },
        async close() { this.closeCalls += 1; this.state = "closed"; },
      };
      contexts.push(context);
      return context;
    },
    requestFrame: (callback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
    sendSignal: async () => {},
  });

  await voice.join({ playerId: "self", sessionId: "remote-meter", peerIds: ["loud", "quiet"] });
  for (let index = 0; index < connections.length; index += 1) {
    const stream = index === 0 ? streams.loud : streams.quiet;
    connections[index].ontrack({ track: stream.track, streams: [stream] });
    connections[index].connectionState = "connected";
    connections[index].onconnectionstatechange();
  }
  await tick();
  for (const frame of [...frames.values()]) frame();

  assert.ok(voice.state.peerLevels.loud >= 0.5);
  assert.equal(voice.state.peerLevels.quiet, 0);
  assert.deepEqual(voice.state.speakingPeerIds, ["loud"]);

  streams.loud.track.onended();
  assert.equal(Object.hasOwn(voice.state.peerLevels, "loud"), false);
  assert.deepEqual(voice.state.speakingPeerIds, []);
  assert.equal(contexts[0].sources[0].disconnected, true);
  assert.equal(contexts[0].closeCalls, 0, "the shared context remains for the quiet peer");

  voice.removePeer("quiet");
  assert.equal(Object.hasOwn(voice.state.peerLevels, "quiet"), false);
  assert.equal(contexts[0].sources[1].disconnected, true);
  assert.equal(contexts[0].closeCalls, 1);
  assert.equal(contexts.length, 1, "remote peers share one audio context");

  const snapshot = voice.state;
  snapshot.peerLevels.fake = 1;
  snapshot.speakingPeerIds.push("fake");
  assert.equal(Object.hasOwn(voice.state.peerLevels, "fake"), false, "public state must be defensive");
  assert.deepEqual(voice.state.speakingPeerIds, []);

  await voice.leave();
  assert.deepEqual(voice.state.peerLevels, {});
  assert.deepEqual(voice.state.speakingPeerIds, []);
});

test("browser voice releases a remote meter context when analyser setup is unsupported", async () => {
  const connection = new MockPeerConnection();
  const context = {
    state: "running",
    closeCalls: 0,
    createAnalyser() { throw new Error("remote analyser unsupported"); },
    createMediaStreamSource() { throw new Error("must not be reached"); },
    async close() { this.closeCalls += 1; this.state = "closed"; },
  };
  const voice = new BrowserVoiceChat({
    createPeerConnection: () => connection,
    createAudioElement: () => ({
      muted: false,
      paused: false,
      play: () => Promise.resolve(),
      pause() {},
    }),
    createAudioContext: () => context,
    sendSignal: async () => {},
  });

  await voice.join({ playerId: "self", sessionId: "unsupported-meter", peerIds: ["peer"] });
  const remote = streamMock("unsupported-remote");
  connection.ontrack({ track: remote.track, streams: [remote] });
  await tick();

  assert.equal(context.closeCalls, 1, "failed optional metering must release its AudioContext");
  assert.deepEqual(voice.state.peerLevels, {});
  assert.deepEqual(voice.state.speakingPeerIds, []);
  assert.equal(voice.state.joined, true, "optional meter failure must not drop voice signaling");
  await voice.leave();
});

test("browser voice retries remote activity metering from the playback gesture", async () => {
  const frames = new Map();
  const contexts = [];
  const connection = new MockPeerConnection();
  const remote = streamMock("retry-remote-meter");
  remote.level = "loud";
  let nextFrameId = 0;

  const voice = new BrowserVoiceChat({
    createPeerConnection: () => connection,
    createAudioElement: () => ({
      muted: false,
      paused: false,
      srcObject: null,
      play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; },
    }),
    createAudioContext: () => {
      const rejectResume = contexts.length === 0;
      const analyser = {
        fftSize: 0,
        smoothingTimeConstant: 0,
        stream: null,
        getByteTimeDomainData(buffer) {
          for (let index = 0; index < buffer.length; index += 1) {
            buffer[index] = this.stream?.level === "loud" ? (index % 2 ? 176 : 80) : 128;
          }
        },
      };
      const context = {
        state: rejectResume ? "suspended" : "running",
        closeCalls: 0,
        resumeCalls: 0,
        createAnalyser: () => analyser,
        createMediaStreamSource: (stream) => {
          analyser.stream = stream;
          return { connect() {}, disconnect() {} };
        },
        async resume() {
          this.resumeCalls += 1;
          if (rejectResume) throw new Error("gesture_required");
          this.state = "running";
        },
        async close() { this.closeCalls += 1; this.state = "closed"; },
      };
      contexts.push(context);
      return context;
    },
    requestFrame: (callback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
    sendSignal: async () => {},
  });

  await voice.join({ playerId: "self", sessionId: "retry-meter", peerIds: ["peer"] });
  connection.ontrack({ track: remote.track, streams: [remote] });
  connection.connectionState = "connected";
  connection.onconnectionstatechange();
  await tick();
  await tick();

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].closeCalls, 1);
  assert.deepEqual(voice.state.peerLevels, {});

  assert.equal((await voice.resumePlayback()).ok, true);
  await tick();
  assert.equal(contexts.length, 2, "the playback gesture must rebuild a failed remote meter");
  const frame = [...frames.values()][0];
  frames.clear();
  frame();
  assert.ok(voice.state.peerLevels.peer >= 0.5);
  assert.deepEqual(voice.state.speakingPeerIds, ["peer"]);
  await voice.leave();
});

test("browser voice keeps a replacement stream when an older resume finishes late", async () => {
  const firstResume = deferred();
  const frames = new Map();
  const contexts = [];
  const connection = new MockPeerConnection();
  const oldStream = streamMock("old-remote-stream");
  const newStream = streamMock("new-remote-stream");
  oldStream.level = "quiet";
  newStream.level = "loud";
  let nextFrameId = 0;

  const voice = new BrowserVoiceChat({
    createPeerConnection: () => connection,
    createAudioElement: () => ({
      muted: false,
      paused: false,
      srcObject: null,
      play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; },
    }),
    createAudioContext: () => {
      const first = contexts.length === 0;
      const analyser = {
        fftSize: 0,
        smoothingTimeConstant: 0,
        stream: null,
        getByteTimeDomainData(buffer) {
          for (let index = 0; index < buffer.length; index += 1) {
            buffer[index] = this.stream?.level === "loud" ? (index % 2 ? 176 : 80) : 128;
          }
        },
      };
      const context = {
        state: first ? "suspended" : "running",
        closeCalls: 0,
        createAnalyser: () => analyser,
        createMediaStreamSource: (stream) => {
          analyser.stream = stream;
          return { connect() {}, disconnect() {} };
        },
        async resume() {
          if (first) await firstResume.promise;
          this.state = "running";
        },
        async close() { this.closeCalls += 1; this.state = "closed"; },
      };
      contexts.push(context);
      return context;
    },
    requestFrame: (callback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
    sendSignal: async () => {},
  });

  await voice.join({ playerId: "self", sessionId: "replace-meter", peerIds: ["peer"] });
  connection.ontrack({ track: oldStream.track, streams: [oldStream] });
  connection.connectionState = "connected";
  connection.onconnectionstatechange();
  await tick();
  connection.ontrack({ track: newStream.track, streams: [newStream] });
  await tick();
  assert.equal(contexts.length, 2);

  firstResume.resolve();
  await tick();
  await tick();
  const frame = [...frames.values()][0];
  frames.clear();
  frame();
  assert.ok(voice.state.peerLevels.peer >= 0.5, "the newer stream must retain its meter");
  assert.deepEqual(voice.state.speakingPeerIds, ["peer"]);
  assert.equal(contexts[1].closeCalls, 0, "the stale resume must not close the replacement context");
  await voice.leave();
});

function createWxMock() {
  const listeners = {
    members: new Set(),
    speakers: new Set(),
    interrupted: new Set(),
  };
  const log = [];
  let deferredFirstJoin = null;
  let joinCount = 0;
  const api = {
    listeners,
    log,
    deferFirstJoin() {
      deferredFirstJoin = deferred();
      return deferredFirstJoin;
    },
    getSystemInfoSync: () => ({ platform: "android" }),
    getSetting: ({ success }) => success({ authSetting: { "scope.record": true } }),
    authorize: ({ success }) => success({}),
    joinVoIPChat(options) {
      joinCount += 1;
      log.push(`join:${options.groupId}`);
      if (joinCount === 1 && deferredFirstJoin) {
        deferredFirstJoin.promise.then(() => options.success({ openIdList: ["one"] }));
        return;
      }
      options.success({ openIdList: ["one", "two"] });
    },
    exitVoIPChat: ({ success }) => { log.push("exit"); success({}); },
    updateVoIPChatMuteConfig: ({ success }) => success({}),
    onVoIPChatMembersChanged: (listener) => listeners.members.add(listener),
    offVoIPChatMembersChanged: (listener) => listeners.members.delete(listener),
    onVoIPChatSpeakersChanged: (listener) => listeners.speakers.add(listener),
    offVoIPChatSpeakersChanged: (listener) => listeners.speakers.delete(listener),
    onVoIPChatInterrupted: (listener) => listeners.interrupted.add(listener),
    offVoIPChatInterrupted: (listener) => listeners.interrupted.delete(listener),
  };
  return api;
}

function wechatVoice(wxApi, overrides = {}) {
  return new WechatVoiceChat({
    wxApi,
    appId: "wx1234567890abcdef",
    enabled: true,
    approvalGranted: true,
    privacyConfigured: true,
    getCredentials: async ({ groupId = "default" } = {}) => ({
      groupId,
      signature: "signed",
      nonceStr: "nonce",
      timeStamp: 1_800_000_000,
    }),
    ...overrides,
  });
}

test("wechat voice gates visitor/privacy modes without touching platform APIs", async () => {
  const visitor = new WechatVoiceChat({
    wxApi: {},
    appId: "touristappid",
    enabled: true,
    approvalGranted: true,
    privacyConfigured: true,
  });
  assert.equal(visitor.capability().reason, "not_configured");
  assert.equal((await visitor.join()).errorCode, "not_configured");

  const wxApi = createWxMock();
  const privacyBlocked = wechatVoice(wxApi, { privacyConfigured: false });
  assert.equal(privacyBlocked.capability().reason, "privacy_not_configured");
  assert.equal((await privacyBlocked.join()).errorCode, "privacy_not_configured");
  assert.deepEqual(wxApi.log, []);
});

test("wechat voice serializes session replacement and cleans listeners on hide", async () => {
  const wxApi = createWxMock();
  const firstPlatformJoin = wxApi.deferFirstJoin();
  const voice = wechatVoice(wxApi);

  const firstJoin = voice.join({ groupId: "first" });
  await tick();
  const secondJoin = voice.join({ groupId: "second" });
  firstPlatformJoin.resolve();

  assert.equal((await firstJoin).errorCode, "cancelled");
  assert.equal((await secondJoin).ok, true);
  assert.deepEqual(wxApi.log, ["join:first", "exit", "join:second"]);
  assert.equal(wxApi.listeners.members.size, 1);
  assert.equal(wxApi.listeners.speakers.size, 1);
  assert.equal(wxApi.listeners.interrupted.size, 1);

  const speakersChanged = [...wxApi.listeners.speakers][0];
  const speakerEvents = [];
  voice.onSpeakersChanged = (event) => speakerEvents.push(event);
  speakersChanged({ openIdList: ["one", "two", "two", null, 123, {}] });
  assert.equal(voice.state.speakingCount, 2);
  assert.equal("activeSpeakerIds" in voice.state, false, "WeChat openIds must not leak into public state");
  assert.deepEqual(speakerEvents, [{ speakingCount: 2, errCode: undefined }]);
  assert.equal("openIdList" in speakerEvents[0], false, "speaker callbacks expose only an anonymous count");

  await voice.setMicrophoneMuted(true);
  assert.equal(voice.state.speakingCount, 2, "microphone state must not impersonate room speaker activity");

  const membersChanged = [...wxApi.listeners.members][0];
  const memberEvents = [];
  voice.onMembersChanged = (event) => memberEvents.push(event);
  membersChanged({ openIdList: ["one"] });
  assert.equal(voice.state.memberCount, 1);
  assert.equal(voice.state.speakingCount, 0, "a membership change clears a potentially stale speaker callback");
  assert.deepEqual(memberEvents, [{ memberCount: 1, errCode: undefined }]);
  assert.equal("openIdList" in memberEvents[0], false, "member callbacks expose only an anonymous count");
  speakersChanged({ openIdList: ["one"] });
  assert.equal(voice.state.speakingCount, 1);

  assert.equal((await voice.handleHide()).ok, true);
  assert.equal(voice.state.status, "idle");
  assert.equal(voice.state.speakingCount, 0);
  speakersChanged({ openIdList: ["one"] });
  assert.equal(voice.state.speakingCount, 0, "a stale listener cannot restore activity after hide");
  assert.equal(wxApi.listeners.members.size, 0);
  assert.equal(wxApi.listeners.speakers.size, 0);
  assert.equal(wxApi.listeners.interrupted.size, 0);
  assert.deepEqual(wxApi.log, ["join:first", "exit", "join:second", "exit"]);
});

test("wechat voice cleans listeners after interruption and contains notify errors", async () => {
  const wxApi = createWxMock();
  const errors = [];
  const voice = wechatVoice(wxApi, {
    notifyLeave: async () => { throw new Error("offline"); },
    onError: (event) => errors.push(event.errorCode),
  });
  assert.equal((await voice.join({ groupId: "interrupt" })).ok, true);
  const speakersChanged = [...wxApi.listeners.speakers][0];
  speakersChanged({ openIdList: ["one"] });
  assert.equal(voice.state.speakingCount, 1);
  const interrupted = [...wxApi.listeners.interrupted][0];
  interrupted({ errCode: -3 });
  await tick();

  assert.equal(voice.state.status, "interrupted");
  assert.equal(voice.state.speakingCount, 0);
  assert.equal(wxApi.listeners.members.size, 0);
  assert.equal(wxApi.listeners.speakers.size, 0);
  assert.equal(wxApi.listeners.interrupted.size, 0);
  assert.deepEqual(errors.sort(), ["interrupted", "leave_notify_failed"].sort());
  await voice.destroy();
});
