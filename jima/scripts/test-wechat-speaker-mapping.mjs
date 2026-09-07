import assert from "node:assert/strict";

import { WechatVoiceChat } from "../src/wechat/WechatVoiceChat.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeWechatApi() {
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
    joinVoIPChat: ({ success }) => success({ openIdList: ["self-open", "peer-open"] }),
    exitVoIPChat: ({ success }) => success({}),
    updateVoIPChatMuteConfig: ({ success }) => success({}),
    onVoIPChatMembersChanged: (listener) => listeners.members.add(listener),
    offVoIPChatMembersChanged: (listener) => listeners.members.delete(listener),
    onVoIPChatSpeakersChanged: (listener) => listeners.speakers.add(listener),
    offVoIPChatSpeakersChanged: (listener) => listeners.speakers.delete(listener),
    onVoIPChatInterrupted: (listener) => listeners.interrupted.add(listener),
    offVoIPChatInterrupted: (listener) => listeners.interrupted.delete(listener),
  };
}

const wxApi = fakeWechatApi();
const resolutions = [];
const resolverInputs = [];
const voice = new WechatVoiceChat({
  wxApi,
  appId: "wx1234567890abcdef",
  enabled: true,
  approvalGranted: true,
  privacyConfigured: true,
  requireRealDevice: false,
  getCredentials: async () => ({
    groupId: "boltbound_TEST1",
    signature: "signed",
    nonceStr: "nonce",
    timeStamp: 1_700_000_000,
  }),
  resolveSpeakerPlayerIds: (openIdList) => {
    resolverInputs.push(openIdList);
    const pending = deferred();
    resolutions.push(pending);
    return pending.promise;
  },
});

assert.equal((await voice.join()).ok, true);
assert.deepEqual(voice.state.speakingPlayerIds, []);
const speakersChanged = [...wxApi.listeners.speakers][0];
const membersChanged = [...wxApi.listeners.members][0];

speakersChanged({ openIdList: [" old-open ", "old-open", null, 7] });
speakersChanged({ openIdList: ["new-open"] });
assert.equal(voice.state.speakingCount, 1);
assert.deepEqual(resolverInputs, [["old-open"], ["new-open"]]);

resolutions[1].resolve(["new-player", "new-player", "", null]);
await tick();
assert.deepEqual(voice.state.speakingPlayerIds, ["new-player"]);
assert.equal(JSON.stringify(voice.state).includes("new-open"), false);

resolutions[0].resolve(["old-player"]);
await tick();
assert.deepEqual(
  voice.state.speakingPlayerIds,
  ["new-player"],
  "an older async mapping response must not replace the newest speaker state",
);

speakersChanged({ openIdList: ["member-change-open"] });
membersChanged({ openIdList: ["self-open"] });
resolutions[2].resolve(["stale-player"]);
await tick();
assert.deepEqual(voice.state.speakingPlayerIds, []);
assert.equal(voice.state.speakingCount, 0);

speakersChanged({ openIdList: ["leave-open"] });
const leaveResolution = resolutions[3];
assert.equal((await voice.leave()).ok, true);
leaveResolution.resolve(["late-player"]);
await tick();
assert.deepEqual(voice.state.speakingPlayerIds, []);
assert.equal(voice.state.status, "idle");
assert.equal(JSON.stringify(voice.state).includes("open"), false);

console.log("wechat speaker mapping adapter: ok");
