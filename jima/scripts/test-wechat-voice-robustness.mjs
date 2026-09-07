import assert from "node:assert/strict";
import test from "node:test";

import { WechatVoiceChat } from "../src/wechat/WechatVoiceChat.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => delay(0);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createWxMock(overrides = {}) {
  const listeners = {
    members: new Set(),
    speakers: new Set(),
    interrupted: new Set(),
  };
  return {
    listeners,
    getSystemInfoSync: () => ({ platform: "android" }),
    getSetting: ({ success }) => success({ authSetting: { "scope.record": true } }),
    authorize: ({ success }) => success({}),
    joinVoIPChat: ({ success }) => success({ openIdList: [] }),
    exitVoIPChat: ({ success }) => success({}),
    updateVoIPChatMuteConfig: ({ success }) => success({}),
    onVoIPChatMembersChanged: (listener) => listeners.members.add(listener),
    offVoIPChatMembersChanged: (listener) => listeners.members.delete(listener),
    onVoIPChatSpeakersChanged: (listener) => listeners.speakers.add(listener),
    offVoIPChatSpeakersChanged: (listener) => listeners.speakers.delete(listener),
    onVoIPChatInterrupted: (listener) => listeners.interrupted.add(listener),
    offVoIPChatInterrupted: (listener) => listeners.interrupted.delete(listener),
    ...overrides,
  };
}

function createVoice(wxApi, overrides = {}) {
  return new WechatVoiceChat({
    wxApi,
    appId: "wx1234567890abcdef",
    enabled: true,
    approvalGranted: true,
    privacyConfigured: true,
    requireRealDevice: false,
    wxCallTimeoutMs: 20,
    getCredentials: async ({ groupId = "voice-room" } = {}) => ({
      groupId,
      signature: "signed",
      nonceStr: "nonce",
      timeStamp: 1_800_000_000,
    }),
    ...overrides,
  });
}

test("wechat voice bounds a platform API that never calls back", async () => {
  const wxApi = createWxMock({ joinVoIPChat() {} });
  const voice = createVoice(wxApi);

  const outcome = await Promise.race([
    voice.join({ groupId: "hung-join" }),
    delay(120).then(() => ({ watchdogExpired: true })),
  ]);

  assert.equal(outcome.watchdogExpired, undefined, "join must settle before the watchdog");
  assert.equal(outcome.ok, false);
  assert.equal(voice.state.status, "error");
});

test("wechat voice compensates once when a timed-out platform join succeeds late", async () => {
  let joinOptions = null;
  let exitCalls = 0;
  const notifications = [];
  const wxApi = createWxMock({
    joinVoIPChat(options) {
      joinOptions = options;
    },
    exitVoIPChat({ success }) {
      exitCalls += 1;
      success({});
    },
  });
  const voice = createVoice(wxApi, {
    notifyLeave: async (event) => {
      notifications.push(event);
    },
  });

  const joining = voice.join({ groupId: "late-after-timeout" });
  for (let attempt = 0; attempt < 10 && !joinOptions; attempt += 1) await tick();
  assert.ok(joinOptions);

  const outcome = await joining;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "api_timeout");
  assert.equal(voice.state.status, "error");
  assert.equal(exitCalls, 0);
  assert.deepEqual(notifications, [{
    groupId: "late-after-timeout",
    reason: "join_failed",
  }]);

  joinOptions.success({ openIdList: ["late-open-id"] });
  joinOptions.success({ openIdList: ["duplicate-late-open-id"] });
  await tick();
  await tick();

  assert.equal(exitCalls, 1, "a late platform success must trigger exactly one compensating exit");
  assert.equal(voice.state.status, "error", "a late callback cannot resurrect the timed-out join");
  assert.deepEqual(notifications, [{
    groupId: "late-after-timeout",
    reason: "join_failed",
  }]);
});

test("wechat voice applies late platform cleanup only when no replacement owns the session", async () => {
  async function runScenario(replacementSucceeds) {
    let joinCount = 0;
    let oldJoinOptions = null;
    let exitCalls = 0;
    const wxApi = createWxMock({
      joinVoIPChat(options) {
        joinCount += 1;
        if (joinCount === 1) {
          oldJoinOptions = options;
          return;
        }
        if (replacementSucceeds) {
          options.success({ openIdList: ["replacement-open-id"] });
        } else {
          options.fail(new Error("replacement join failed"));
        }
      },
      exitVoIPChat({ success }) {
        exitCalls += 1;
        success({});
      },
    });
    const voice = createVoice(wxApi);

    const oldOutcome = await voice.join({ groupId: "old-platform-room" });
    assert.equal(oldOutcome.errorCode, "api_timeout");
    const replacementOutcome = await voice.join({ groupId: "replacement-platform-room" });

    oldJoinOptions.success({ openIdList: ["late-old-open-id"] });
    oldJoinOptions.success({ openIdList: ["duplicate-late-old-open-id"] });
    await tick();
    await voice.setSpeakerMuted(false);

    const result = {
      replacementOk: replacementOutcome.ok,
      status: voice.state.status,
      exitCalls,
    };
    await voice.leave({ notify: false });
    return result;
  }

  const [successfulReplacement, failedReplacement] = await Promise.all([
    runScenario(true),
    runScenario(false),
  ]);
  assert.deepEqual(successfulReplacement, {
    replacementOk: true,
    status: "joined",
    exitCalls: 0,
  });
  assert.deepEqual(failedReplacement, {
    replacementOk: false,
    status: "error",
    exitCalls: 1,
  });
});

test("wechat voice cleans late credentials only when no replacement owns the identity", async () => {
  async function runScenario(mode) {
    const pendingOldCredentials = deferred();
    const notifications = [];
    let credentialsCalls = 0;
    const voice = createVoice(createWxMock(), {
      getCredentials: async ({ groupId }) => {
        credentialsCalls += 1;
        if (credentialsCalls === 1) return pendingOldCredentials.promise;
        if (mode === "failed") {
          throw Object.assign(new Error("replacement credentials failed"), {
            errorCode: "signing_unavailable",
          });
        }
        return {
          groupId,
          signature: "replacement-signature",
          nonceStr: "replacement-nonce",
          timeStamp: 1_800_000_001,
        };
      },
      notifyLeave: async (event) => {
        notifications.push(event);
      },
    });

    const oldOutcome = await voice.join({ groupId: `old-credentials-${mode}` });
    assert.equal(oldOutcome.errorCode, "api_timeout");

    let replacementOutcome = null;
    if (mode !== "none") {
      replacementOutcome = await voice.join({ groupId: `replacement-credentials-${mode}` });
    }
    pendingOldCredentials.resolve({
      groupId: `old-credentials-${mode}`,
      signature: "late-old-signature",
      nonceStr: "late-old-nonce",
      timeStamp: 1_800_000_000,
    });
    await tick();
    await voice.setSpeakerMuted(false);

    const result = {
      replacementOk: replacementOutcome?.ok ?? null,
      status: voice.state.status,
      notifications,
    };
    await voice.leave({ notify: false });
    return result;
  }

  const [withoutReplacement, successfulReplacement, failedReplacement] = await Promise.all([
    runScenario("none"),
    runScenario("success"),
    runScenario("failed"),
  ]);
  assert.deepEqual(withoutReplacement, {
    replacementOk: null,
    status: "error",
    notifications: [{
      groupId: "old-credentials-none",
      reason: "late_credentials",
    }],
  });
  assert.deepEqual(successfulReplacement, {
    replacementOk: true,
    status: "joined",
    notifications: [],
  });
  assert.deepEqual(failedReplacement, {
    replacementOk: false,
    status: "error",
    notifications: [{
      groupId: "old-credentials-failed",
      reason: "late_credentials",
    }],
  });
});

test("wechat voice clears speaker state and invalidates callbacks as soon as it hides", async () => {
  const wxApi = createWxMock();
  const voice = createVoice(wxApi, {
    resolveSpeakerPlayerIds: async () => ["speaking-player"],
  });
  assert.equal((await voice.join({ groupId: "active-room" })).ok, true);

  const staleSpeakerListener = [...wxApi.listeners.speakers][0];
  staleSpeakerListener({ openIdList: ["private-open-id"] });
  await tick();
  assert.equal(voice.state.speakingCount, 1);
  assert.deepEqual(voice.state.speakingPlayerIds, ["speaking-player"]);

  const hiding = voice.handleHide();
  assert.equal(voice.state.speakingCount, 0, "hide must clear activity synchronously");
  assert.deepEqual(voice.state.speakingPlayerIds, []);

  staleSpeakerListener({ openIdList: ["late-private-open-id"] });
  await tick();
  assert.equal(voice.state.speakingCount, 0, "an old callback must be invalid immediately");
  assert.deepEqual(voice.state.speakingPlayerIds, []);

  assert.equal((await hiding).ok, true);
  assert.equal(voice.state.status, "idle");
});

test("wechat voice notifies server cleanup without waiting for a hung platform exit", async () => {
  let exitCalls = 0;
  const notifications = [];
  const wxApi = createWxMock({
    exitVoIPChat() {
      exitCalls += 1;
    },
  });
  const voice = createVoice(wxApi, {
    wxCallTimeoutMs: 200,
    notifyLeave: async (event) => {
      notifications.push(event);
    },
  });
  assert.equal((await voice.join({ groupId: "server-identity" })).ok, true);

  const leaving = voice.leave({ reason: "hide" });
  await tick();

  assert.equal(exitCalls, 1);
  assert.deepEqual(notifications, [{ groupId: "server-identity", reason: "hide" }]);
  assert.equal((await leaving).ok, true);
});

test("wechat voice clears the old server identity when a replacement join fails", async () => {
  const notifications = [];
  const wxApi = createWxMock();
  const voice = createVoice(wxApi, {
    getCredentials: async ({ groupId }) => {
      if (groupId === "replacement-room") {
        throw Object.assign(new Error("replacement credentials failed"), {
          errorCode: "signing_unavailable",
        });
      }
      return {
        groupId,
        signature: "signed",
        nonceStr: "nonce",
        timeStamp: 1_800_000_000,
      };
    },
    notifyLeave: async (event) => {
      notifications.push(event);
    },
  });

  assert.equal((await voice.join({ groupId: "old-room" })).ok, true);
  assert.equal(voice.state.joined, true);

  const replacement = await voice.join({ groupId: "replacement-room" });

  assert.equal(replacement.ok, false);
  assert.equal(replacement.errorCode, "signing_unavailable");
  assert.deepEqual(notifications, [{
    groupId: "old-room",
    reason: "replace_session",
  }]);
});

test("wechat voice preserves a connecting speaker ACK when platform join succeeds", async () => {
  let joinOptions = null;
  const wxApi = createWxMock({
    joinVoIPChat(options) {
      joinOptions = options;
    },
  });
  const voice = createVoice(wxApi, {
    resolveSpeakerPlayerIds: async () => ["mapped-player"],
  });

  const joining = voice.join({ groupId: "early-speaker-room" });
  for (let attempt = 0; attempt < 10 && !joinOptions; attempt += 1) await tick();
  assert.ok(joinOptions, "the adapter must reach the platform join call");
  assert.equal(voice.state.status, "connecting");

  const speakerListener = [...wxApi.listeners.speakers][0];
  speakerListener({ openIdList: ["private-speaker-open-id"] });
  await tick();
  assert.equal(voice.state.speakingCount, 1);
  assert.deepEqual(voice.state.speakingPlayerIds, ["mapped-player"]);

  joinOptions.success({ openIdList: ["self-open-id", "private-speaker-open-id"] });
  const joined = await joining;

  assert.equal(joined.ok, true);
  assert.equal(voice.state.status, "joined");
  assert.equal(voice.state.memberCount, 2);
  assert.equal(
    voice.state.speakingCount,
    1,
    "join success must not discard a newer connecting speaker callback",
  );
  assert.deepEqual(voice.state.speakingPlayerIds, ["mapped-player"]);
  await voice.leave();
});

test("wechat voice cleans a cancelled late platform join before a hung exit and only once", async () => {
  let joinOptions = null;
  let exitCalls = 0;
  const notifications = [];
  const wxApi = createWxMock({
    joinVoIPChat(options) {
      joinOptions = options;
    },
    exitVoIPChat() {
      exitCalls += 1;
    },
  });
  const voice = createVoice(wxApi, {
    wxCallTimeoutMs: 200,
    notifyLeave: async (event) => {
      notifications.push(event);
    },
  });

  const joining = voice.join({ groupId: "late-platform-room" });
  for (let attempt = 0; attempt < 10 && !joinOptions; attempt += 1) await tick();
  assert.ok(joinOptions);

  const hiding = voice.handleHide();
  joinOptions.success({ openIdList: ["self-open-id"] });
  await tick();

  assert.equal(exitCalls, 1);
  assert.deepEqual(notifications, [{
    groupId: "late-platform-room",
    reason: "cancelled",
  }]);

  const cancelled = await joining;
  assert.equal(cancelled.errorCode, "cancelled");
  assert.equal((await hiding).ok, true);
  assert.equal(voice.state.status, "idle");
  assert.deepEqual(
    notifications,
    [{ groupId: "late-platform-room", reason: "cancelled" }],
    "the queued hide cleanup must not notify the same server identity again",
  );
});

test("wechat voice cleans credentials that arrive after hide invalidates the join", async () => {
  const pendingCredentials = deferred();
  const notifications = [];
  let platformJoinCalls = 0;
  const wxApi = createWxMock({
    joinVoIPChat({ success }) {
      platformJoinCalls += 1;
      success({ openIdList: [] });
    },
  });
  const voice = createVoice(wxApi, {
    getCredentials: () => pendingCredentials.promise,
    notifyLeave: async (event) => {
      notifications.push(event);
    },
  });

  const joining = voice.join({ groupId: "late-credentials-room" });
  for (let attempt = 0; attempt < 10 && voice.state.status !== "connecting"; attempt += 1) {
    await tick();
  }
  assert.equal(voice.state.status, "connecting");

  const hiding = voice.handleHide();
  pendingCredentials.resolve({
    groupId: "late-credentials-room",
    signature: "signed",
    nonceStr: "nonce",
    timeStamp: 1_800_000_000,
  });

  const cancelled = await joining;
  assert.equal(cancelled.errorCode, "cancelled");
  assert.equal(platformJoinCalls, 0, "an invalidated join must never enter the platform room");
  assert.deepEqual(notifications, [{
    groupId: "late-credentials-room",
    reason: "cancelled",
  }]);

  assert.equal((await hiding).ok, true);
  assert.deepEqual(
    notifications,
    [{ groupId: "late-credentials-room", reason: "cancelled" }],
    "the queued hide cleanup must not repeat the credential cleanup",
  );
});

test("wechat voice does not request record permission after privacy consent is cancelled", async () => {
  const pendingConsent = deferred();
  let getSettingCalls = 0;
  let authorizeCalls = 0;
  const wxApi = createWxMock({
    getSetting({ success }) {
      getSettingCalls += 1;
      success({ authSetting: {} });
    },
    authorize({ success }) {
      authorizeCalls += 1;
      success({});
    },
  });
  const voice = createVoice(wxApi, {
    ensurePrivacyConsent: () => pendingConsent.promise,
  });

  const joining = voice.join({ groupId: "cancelled-privacy-room" });
  for (
    let attempt = 0;
    attempt < 10 && voice.state.status !== "requesting_permission";
    attempt += 1
  ) {
    await tick();
  }
  assert.equal(voice.state.status, "requesting_permission");

  const hiding = voice.handleHide();
  pendingConsent.resolve(true);

  const cancelled = await joining;
  assert.equal(cancelled.errorCode, "cancelled");
  assert.equal(getSettingCalls, 0, "a stale generation must stop before permission inspection");
  assert.equal(authorizeCalls, 0, "a stale generation must not show record authorization");
  assert.equal((await hiding).ok, true);
  assert.equal(voice.state.status, "idle");
});

test("wechat voice bounds injected async callbacks so the operation queue drains", async () => {
  const never = () => new Promise(() => {});
  const settleBeforeWatchdog = (promise) => Promise.race([
    promise.then((value) => ({ settled: true, value })),
    delay(120).then(() => ({ settled: false })),
  ]);

  async function hungPrivacyOutcome() {
    const voice = createVoice(createWxMock(), { ensurePrivacyConsent: never });
    const joining = voice.join({ groupId: "hung-privacy-room" });
    for (
      let attempt = 0;
      attempt < 10 && voice.state.status !== "requesting_permission";
      attempt += 1
    ) {
      await tick();
    }
    const hiding = voice.handleHide();
    const outcome = await settleBeforeWatchdog(Promise.all([joining, hiding]));
    return { settled: outcome.settled, status: voice.state.status };
  }

  async function hungCredentialsOutcome() {
    const voice = createVoice(createWxMock(), { getCredentials: never });
    const joining = voice.join({ groupId: "hung-credentials-room" });
    for (let attempt = 0; attempt < 10 && voice.state.status !== "connecting"; attempt += 1) {
      await tick();
    }
    const hiding = voice.handleHide();
    const outcome = await settleBeforeWatchdog(Promise.all([joining, hiding]));
    return { settled: outcome.settled, status: voice.state.status };
  }

  async function hungNotifyOutcome() {
    const voice = createVoice(createWxMock(), { notifyLeave: never });
    assert.equal((await voice.join({ groupId: "hung-notify-room" })).ok, true);
    const outcome = await settleBeforeWatchdog(voice.leave());
    return { settled: outcome.settled, status: voice.state.status };
  }

  const [privacy, credentials, notify] = await Promise.all([
    hungPrivacyOutcome(),
    hungCredentialsOutcome(),
    hungNotifyOutcome(),
  ]);
  assert.deepEqual(
    { privacy, credentials, notify },
    {
      privacy: { settled: true, status: "idle" },
      credentials: { settled: true, status: "idle" },
      notify: { settled: true, status: "idle" },
    },
  );
});

test("wechat voice cleans a stale failed or timed-out join once before replacement", async () => {
  async function runScenario(mode) {
    let joinCount = 0;
    let firstJoinOptions = null;
    const notifications = [];
    const wxApi = createWxMock({
      joinVoIPChat(options) {
        joinCount += 1;
        if (joinCount === 1) {
          firstJoinOptions = options;
          return;
        }
        options.success({ openIdList: ["replacement-open-id"] });
      },
    });
    const voice = createVoice(wxApi, {
      notifyLeave: async (event) => {
        notifications.push(event);
      },
    });

    const firstJoin = voice.join({ groupId: `old-${mode}-room` });
    for (let attempt = 0; attempt < 10 && !firstJoinOptions; attempt += 1) await tick();
    assert.ok(firstJoinOptions);
    const replacementJoin = voice.join({ groupId: `replacement-${mode}-room` });
    if (mode === "failure") firstJoinOptions.fail(new Error("old join failed"));

    const firstOutcome = await firstJoin;
    const replacementOutcome = await replacementJoin;
    const result = {
      firstErrorCode: firstOutcome.errorCode,
      firstStateStatus: firstOutcome.state.status,
      replacementOk: replacementOutcome.ok,
      finalStatus: voice.state.status,
      notifications,
    };
    await voice.leave({ notify: false });
    return result;
  }

  const [failure, timeout] = await Promise.all([
    runScenario("failure"),
    runScenario("timeout"),
  ]);
  for (const [mode, result] of [["failure", failure], ["timeout", timeout]]) {
    assert.deepEqual(result, {
      firstErrorCode: "cancelled",
      firstStateStatus: "idle",
      replacementOk: true,
      finalStatus: "joined",
      notifications: [{
        groupId: `old-${mode}-room`,
        reason: "cancelled",
      }],
    });
  }
});

test("wechat voice rechecks generation after delayed join cleanup", async () => {
  let joinCount = 0;
  let firstJoinOptions = null;
  const notifyStarted = deferred();
  const pendingNotify = deferred();
  const notifications = [];
  const wxApi = createWxMock({
    joinVoIPChat(options) {
      joinCount += 1;
      if (joinCount === 1) {
        firstJoinOptions = options;
        return;
      }
      options.success({ openIdList: ["replacement-open-id"] });
    },
  });
  const voice = createVoice(wxApi, {
    notifyLeave: (event) => {
      notifications.push(event);
      notifyStarted.resolve();
      return pendingNotify.promise;
    },
  });

  const firstJoin = voice.join({ groupId: "old-delayed-cleanup-room" });
  for (let attempt = 0; attempt < 10 && !firstJoinOptions; attempt += 1) await tick();
  assert.ok(firstJoinOptions);
  firstJoinOptions.fail(new Error("old join failed"));
  await notifyStarted.promise;

  const replacementJoin = voice.join({ groupId: "replacement-after-cleanup-room" });
  pendingNotify.resolve();

  const firstOutcome = await firstJoin;
  const replacementOutcome = await replacementJoin;
  assert.equal(firstOutcome.errorCode, "cancelled");
  assert.equal(firstOutcome.state.status, "idle");
  assert.equal(replacementOutcome.ok, true);
  assert.equal(voice.state.status, "joined");
  assert.deepEqual(notifications, [{
    groupId: "old-delayed-cleanup-room",
    reason: "join_failed",
  }]);
  await voice.leave({ notify: false });
});
