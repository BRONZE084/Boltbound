import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import net from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = await findFreePort();
assert.notEqual(port, 32_145, "voice QA must never use the formal service port");
const baseUrl = `http://127.0.0.1:${port}`;
const fakeAudioPath = resolve(projectRoot, "public/assets/audio/bgm-industrial-run.wav");
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const desktopClientId = process.env.VOICE_QA_DESKTOP_CLIENT_ID || "voice-zzzz-desktop";
const mobileClientId = process.env.VOICE_QA_MOBILE_CLIENT_ID || "voice-aaaa-mobile";

async function findFreePort() {
  for (;;) {
    const candidate = await new Promise((resolvePort, reject) => {
      const reservation = net.createServer();
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", () => {
        const address = reservation.address();
        const assignedPort = typeof address === "object" && address ? address.port : 0;
        reservation.close((error) => error ? reject(error) : resolvePort(assignedPort));
      });
    });
    if (candidate > 0 && candidate !== 32_145) return candidate;
  }
}

function portAcceptsConnections(targetPort) {
  return new Promise((resolveOpen) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: targetPort });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveOpen(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

async function assertPortReleased(targetPort) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await portAcceptsConnections(targetPort))) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.fail(`voice QA port ${targetPort} is still accepting connections after cleanup`);
}

async function waitForServer(server, url) {
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`voice QA server exited early\n${output}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The isolated server may still be binding the port.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`voice QA server did not become ready\n${output}`);
}

async function installVoiceCapture(page, { failFirstRemotePlay = false, clientId = "" } = {}) {
  await page.addInitScript(({ shouldFailFirstRemotePlay, fixedClientId }) => {
    if (fixedClientId) localStorage.setItem("boltbound.clientId", fixedClientId);
    const capture = {
      getUserMediaCalls: 0,
      peerConnections: [],
      remoteTracks: 0,
      remotePlayCalls: 0,
      remotePlaySuccesses: 0,
      blockRemotePlayback: shouldFailFirstRemotePlay,
      remotePlayFailures: 0,
      failureInjected: false,
    };
    Object.defineProperty(window, "__voiceQa", { value: capture, configurable: false });

    const OriginalPeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class VoiceQaPeerConnection extends OriginalPeerConnection {
      constructor(...args) {
        super(...args);
        const record = {
          connectionState: this.connectionState,
          signalingState: this.signalingState,
          localDescriptionType: this.localDescription?.type || null,
          remoteDescriptionType: this.remoteDescription?.type || null,
          tracks: 0,
        };
        capture.peerConnections.push(record);
        const refreshState = () => {
          record.connectionState = this.connectionState;
          record.signalingState = this.signalingState;
          record.localDescriptionType = this.localDescription?.type || null;
          record.remoteDescriptionType = this.remoteDescription?.type || null;
        };
        this.addEventListener("connectionstatechange", () => {
          refreshState();
        });
        this.addEventListener("signalingstatechange", refreshState);
        this.addEventListener("track", () => {
          record.tracks += 1;
          capture.remoteTracks += 1;
        });
      }
    };

    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function voiceQaPlay(...args) {
      const remote = Boolean(this.srcObject);
      if (remote) capture.remotePlayCalls += 1;
      if (remote && capture.blockRemotePlayback) {
        capture.failureInjected = true;
        capture.remotePlayFailures += 1;
        return Promise.reject(new DOMException("QA autoplay block", "NotAllowedError"));
      }
      let playback;
      try {
        playback = originalPlay.apply(this, args);
      } catch (error) {
        if (remote) capture.remotePlayFailures += 1;
        throw error;
      }
      return Promise.resolve(playback).then((value) => {
        if (remote) capture.remotePlaySuccesses += 1;
        return value;
      }, (error) => {
        if (remote) capture.remotePlayFailures += 1;
        throw error;
      });
    };

    const mediaDevices = navigator.mediaDevices;
    const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: (...args) => {
        capture.getUserMediaCalls += 1;
        return originalGetUserMedia(...args);
      },
    });
  }, { shouldFailFirstRemotePlay: failFirstRemotePlay, fixedClientId: clientId });
}

async function joinRoom(page, { name, code }) {
  await page.locator("#player-name").fill(name);
  if (code) {
    await page.locator("#room-code-input").fill(code);
    await page.locator("#join-room").click();
  } else {
    await page.locator("#create-room").click();
  }
  await page.locator("#room-view:not([hidden])").waitFor({ state: "visible" });
  await page.locator("#voice-controls:not([hidden])").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const status = document.querySelector("#voice-status")?.textContent || "";
    return status.includes("仅收听") || status.includes("等待") ||
      status.includes("正在连接") || status.includes("点击扬声器");
  });
}

async function enableMicrophone(page) {
  const meter = page.locator("#voice-meter");
  const before = await meter.boundingBox();
  assert.ok(before && before.width > 0 && before.height > 0, "muted meter must reserve stable space");
  assert.equal(await page.locator("#voice-mic").getAttribute("aria-pressed"), "false");
  assert.equal(await page.evaluate(() => window.__voiceQa.getUserMediaCalls), 0);
  await page.locator("#voice-mic").click();
  await page.waitForFunction(() => {
    const output = document.querySelector("#voice-meter");
    return output?.classList.contains("speaking") && Number(output.getAttribute("aria-valuenow")) > 0;
  }, null, { timeout: 12_000 });
  const after = await meter.boundingBox();
  assert.deepEqual(
    { width: after?.width, height: after?.height },
    { width: before.width, height: before.height },
    "meter activity must not shift the voice toolbar",
  );
  assert.equal(await page.locator("#voice-mic").getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => window.__voiceQa.getUserMediaCalls), 1);
}

async function recoverBlockedSpeaker(page) {
  try {
    await page.waitForFunction(() => (document.querySelector("#voice-status")?.textContent || "").includes("点击扬声器继续收听"));
  } catch (error) {
    const snapshot = await page.evaluate(() => ({
      status: document.querySelector("#voice-status")?.textContent || "",
      speakerPressed: document.querySelector("#voice-speaker")?.getAttribute("aria-pressed"),
      micPressed: document.querySelector("#voice-mic")?.getAttribute("aria-pressed"),
      meterValue: document.querySelector("#voice-meter")?.getAttribute("aria-valuenow"),
      qa: window.__voiceQa,
    }));
    throw new Error(`autoplay block state timeout: ${JSON.stringify(snapshot)}; ${error.message}`);
  }
  const speaker = page.locator("#voice-speaker");
  assert.equal(await speaker.getAttribute("aria-pressed"), "true");
  await page.evaluate(() => { window.__voiceQa.blockRemotePlayback = false; });
  await speaker.click();
  await page.waitForFunction(() => window.__voiceQa.remotePlaySuccesses >= 1 && !(document.querySelector("#voice-status")?.textContent || "").includes("点击扬声器"));
  assert.equal(await speaker.getAttribute("aria-pressed"), "true", "autoplay retry must not toggle the speaker off");
}

async function waitForMutualAudio(page, label) {
  try {
    await page.waitForFunction(() => {
      const status = document.querySelector("#voice-status")?.textContent || "";
      return status.includes("可听 1 人") && window.__voiceQa.remoteTracks >= 1 && window.__voiceQa.remotePlaySuccesses >= 1;
    }, null, { timeout: 15_000 });
  } catch (error) {
    const snapshot = await page.evaluate(() => ({
      status: document.querySelector("#voice-status")?.textContent || "",
      speakerPressed: document.querySelector("#voice-speaker")?.getAttribute("aria-pressed"),
      micPressed: document.querySelector("#voice-mic")?.getAttribute("aria-pressed"),
      meterValue: document.querySelector("#voice-meter")?.getAttribute("aria-valuenow"),
      qa: window.__voiceQa,
    }));
    throw new Error(`${label} mutual audio timeout: ${JSON.stringify(snapshot)}; ${error.message}`);
  }
}

async function waitForPlayerVoice(page, name, { speaking, available }) {
  try {
    await page.waitForFunction(({ expectedName, expectedSpeaking, expectedAvailable }) => {
    const row = [...document.querySelectorAll("#player-list [data-player-id]")]
      .find((candidate) => candidate.querySelector("strong")?.textContent === expectedName);
    const indicator = row?.querySelector("[data-player-voice]");
    if (!row || !indicator) return false;
    const actualSpeaking = row.dataset.voiceSpeaking === "true";
    const label = row.getAttribute("aria-label") || "";
    const speakingMatches = expectedSpeaking === null || actualSpeaking === expectedSpeaking;
    const labelMatches = expectedSpeaking === true
      ? label.includes("正在说话")
      : expectedSpeaking === false
        ? /未发言|无语音/.test(label)
        : true;
    return (
      speakingMatches &&
      !indicator.hidden === expectedAvailable &&
      indicator.classList.contains("speaking") === actualSpeaking &&
      labelMatches &&
      (!expectedAvailable || Boolean(indicator.title))
    );
  }, {
    expectedName: name,
    expectedSpeaking: speaking,
    expectedAvailable: available,
  }, { timeout: 12_000 });
  } catch (error) {
    const rows = await page.evaluate(() => [...document.querySelectorAll("#player-list [data-player-id]")]
      .map((row) => {
        const indicator = row.querySelector("[data-player-voice]");
        return {
          name: row.querySelector("strong")?.textContent || "",
          playerId: row.dataset.playerId,
          speaking: row.dataset.voiceSpeaking,
          label: row.getAttribute("aria-label"),
          indicatorHidden: indicator?.hidden,
          indicatorSpeaking: indicator?.classList.contains("speaking"),
          indicatorStyle: indicator?.getAttribute("style") || "",
        };
      }));
    const meter = await page.locator("#voice-meter").evaluate((node) => ({
      speaking: node.classList.contains("speaking"),
      level: node.getAttribute("aria-valuenow"),
    }));
    throw new Error(`${name} voice state timeout: ${JSON.stringify({ speaking, available, rows, meter })}; ${error.message}`);
  }
}

async function playerVoiceLabel(page, name) {
  return page.locator("#player-list [data-player-id]", { hasText: name }).first().getAttribute("aria-label");
}

async function assertAvatarVoiceGeometry(page, { containerSelector, label }) {
  const geometry = await page.locator(containerSelector).first().evaluate((container) => {
    const wrapper = container.querySelector(".player-avatar-wrap");
    const indicator = container.querySelector("[data-player-voice]");
    const containerStyle = getComputedStyle(container);
    const wrapperStyle = wrapper ? getComputedStyle(wrapper) : null;
    const indicatorStyle = indicator ? getComputedStyle(indicator) : null;
    const firstTrack = Number.parseFloat(containerStyle.gridTemplateColumns.split(" ")[0]);
    const containerRect = container.getBoundingClientRect();
    const indicatorRect = indicator?.getBoundingClientRect();
    return {
      firstTrack,
      wrapperWidth: Number.parseFloat(wrapperStyle?.width || "0"),
      wrapperHeight: Number.parseFloat(wrapperStyle?.height || "0"),
      indicatorWidth: Number.parseFloat(indicatorStyle?.width || "0"),
      indicatorHeight: Number.parseFloat(indicatorStyle?.height || "0"),
      indicatorHidden: indicator?.hidden ?? true,
      indicatorInsideContainer: Boolean(
        indicatorRect &&
        indicatorRect.left >= containerRect.left - 1 &&
        indicatorRect.right <= containerRect.right + 1 &&
        indicatorRect.top >= containerRect.top - 1 &&
        indicatorRect.bottom <= containerRect.bottom + 1
      ),
    };
  });
  assert.ok(geometry.firstTrack > 0, `${label} must expose a stable avatar grid track`);
  assert.ok(
    geometry.wrapperWidth <= geometry.firstTrack + 0.75,
    `${label} wrapper ${geometry.wrapperWidth}px must fit its ${geometry.firstTrack}px grid track`,
  );
  assert.ok(geometry.wrapperHeight > 0);
  assert.equal(geometry.indicatorHidden, false, `${label} speaking badge must be visible`);
  assert.ok(geometry.indicatorWidth >= 10 && geometry.indicatorHeight >= 10, `${label} badge must remain legible`);
  assert.equal(geometry.indicatorInsideContainer, true, `${label} badge must not be clipped by its player container`);
}

async function assertMobileLayout(page) {
  const layout = await page.evaluate(() => {
    const toolbar = document.querySelector("#voice-controls").getBoundingClientRect();
    const meter = document.querySelector("#voice-meter").getBoundingClientRect();
    const mic = document.querySelector("#voice-mic").getBoundingClientRect();
    const speaker = document.querySelector("#voice-speaker").getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      toolbar: { left: toolbar.left, right: toolbar.right, top: toolbar.top, bottom: toolbar.bottom },
      widths: [meter.width, mic.width, speaker.width],
      ordered: meter.right <= mic.left && mic.right <= speaker.left,
    };
  });
  assert.ok(layout.toolbar.left >= 0 && layout.toolbar.right <= layout.viewport.width);
  assert.ok(layout.toolbar.top >= 0 && layout.toolbar.bottom <= layout.viewport.height);
  assert.ok(layout.scrollWidth <= layout.viewport.width, "mobile voice UI must not cause horizontal overflow");
  assert.equal(layout.ordered, true, "meter, mic and speaker controls must not overlap");
  assert.ok(layout.widths.every((width) => width >= 20), "mobile voice indicators must remain legible");
}

let server;
let browser;
let desktopContext;
let mobileContext;
try {
  server = spawn(process.execPath, ["server/index.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "test",
      VOICE_WEB_ENABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  await waitForServer(server, `${baseUrl}/health`);

  browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${fakeAudioPath}`,
    ],
  });
  desktopContext = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    permissions: ["microphone"],
  });
  mobileContext = await browser.newContext({
    viewport: { width: 844, height: 390 },
    hasTouch: true,
    isMobile: true,
    permissions: ["microphone"],
  });
  const desktop = await desktopContext.newPage();
  const mobile = await mobileContext.newPage();
  const browserErrors = [];
  for (const [label, page, failFirstRemotePlay, clientId] of [
    ["desktop", desktop, false, desktopClientId],
    ["mobile", mobile, true, mobileClientId],
  ]) {
    page.on("pageerror", (error) => browserErrors.push(`${label}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`${label}: ${message.text()}`);
    });
    await installVoiceCapture(page, { failFirstRemotePlay, clientId });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
  }

  await joinRoom(desktop, { name: "VoicePC" });
  const roomCode = (await desktop.locator("#room-code").textContent())?.trim();
  assert.match(roomCode || "", /^[A-Z2-9]{5}$/);
  await enableMicrophone(desktop);

  await joinRoom(mobile, { name: "VoicePhone", code: roomCode });
  await recoverBlockedSpeaker(mobile);
  await Promise.all([
    waitForPlayerVoice(desktop, "VoicePC", { speaking: true, available: true }),
    waitForPlayerVoice(desktop, "VoicePhone", { speaking: false, available: false }),
    waitForPlayerVoice(mobile, "VoicePC", { speaking: true, available: true }),
    waitForPlayerVoice(mobile, "VoicePhone", { speaking: false, available: false }),
  ]);

  await enableMicrophone(mobile);
  await Promise.all([
    waitForMutualAudio(desktop, "desktop"),
    waitForMutualAudio(mobile, "mobile"),
    waitForPlayerVoice(desktop, "VoicePC", { speaking: true, available: true }),
    waitForPlayerVoice(desktop, "VoicePhone", { speaking: true, available: true }),
    waitForPlayerVoice(mobile, "VoicePC", { speaking: true, available: true }),
    waitForPlayerVoice(mobile, "VoicePhone", { speaking: true, available: true }),
  ]);
  const desktopSpeakingLabel = await playerVoiceLabel(desktop, "VoicePhone");
  assert.match(desktopSpeakingLabel || "", /正在说话/);
  assert.doesNotMatch(desktopSpeakingLabel || "", /音量\s*\d+%/, "aria-live labels must not track meter percentages");
  await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  assert.equal(
    await playerVoiceLabel(desktop, "VoicePhone"),
    desktopSpeakingLabel,
    "a continuously speaking player must keep a stable live-region label",
  );
  await assertAvatarVoiceGeometry(mobile, {
    containerSelector: "#player-list [data-player-id][data-voice-speaking='true']",
    label: "mobile lobby avatar",
  });

  await mobile.locator("#voice-mic").click();
  await Promise.all([
    waitForPlayerVoice(desktop, "VoicePC", { speaking: null, available: true }),
    waitForPlayerVoice(desktop, "VoicePhone", { speaking: false, available: true }),
    waitForPlayerVoice(mobile, "VoicePC", { speaking: null, available: true }),
    waitForPlayerVoice(mobile, "VoicePhone", { speaking: false, available: false }),
  ]);
  await mobile.locator("#voice-mic").click();
  await Promise.all([
    waitForPlayerVoice(desktop, "VoicePhone", { speaking: true, available: true }),
    waitForPlayerVoice(mobile, "VoicePhone", { speaking: true, available: true }),
  ]);
  await assertMobileLayout(mobile);

  await desktop.locator("#start-game").click();
  await Promise.all([
    desktop.locator("#game-view:not([hidden])").waitFor({ state: "visible" }),
    mobile.locator("#game-view:not([hidden])").waitFor({ state: "visible" }),
  ]);
  await mobile.waitForFunction(() => {
    const badge = document.querySelector("#score-strip [data-player-id][data-voice-speaking='true'] [data-player-voice]");
    return badge && !badge.hidden;
  });
  await assertAvatarVoiceGeometry(mobile, {
    containerSelector: "#score-strip [data-player-id][data-voice-speaking='true']",
    label: "mobile landscape score avatar",
  });
  await mobile.evaluate(() => document.documentElement.classList.add("virtual-landscape"));
  await assertAvatarVoiceGeometry(mobile, {
    containerSelector: "#score-strip [data-player-id][data-voice-speaking='true']",
    label: "virtual landscape score avatar",
  });

  await mobile.screenshot({ path: resolve(projectRoot, "output/playwright/web-voice-mobile-844x390.png") });
  const [desktopQa, mobileQa] = await Promise.all([
    desktop.evaluate(() => window.__voiceQa),
    mobile.evaluate(() => window.__voiceQa),
  ]);
  for (const [label, qa] of [["desktop", desktopQa], ["mobile", mobileQa]]) {
    assert.equal(qa.getUserMediaCalls, 1, `${label} must request the microphone exactly once`);
    assert.ok(qa.remoteTracks >= 1, `${label} must receive a remote audio track`);
    assert.ok(qa.remotePlaySuccesses >= 1, `${label} must successfully play remote audio`);
    assert.ok(qa.peerConnections.some((peer) => peer.connectionState === "connected"), `${label} WebRTC peer must connect`);
  }
  assert.equal(desktopQa.remotePlayFailures, 0);
  assert.ok(mobileQa.remotePlayFailures >= 1, "mobile QA must exercise the autoplay recovery path");
  assert.equal(mobileQa.failureInjected, true);
  assert.deepEqual(browserErrors, []);
  console.log(JSON.stringify({ port, roomCode, desktop: desktopQa, mobile: mobileQa }, null, 2));
  console.log("desktop/mobile browser voice + local meter: ok");
} finally {
  await desktopContext?.close().catch(() => {});
  await mobileContext?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 1_000))]);
  }
  await assertPortReleased(port);
}
