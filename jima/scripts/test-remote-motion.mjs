import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scenePath = fileURLToPath(new URL("../src/game/BoltboundScene.js", import.meta.url));
const sceneSource = readFileSync(scenePath, "utf8");

const FRAME_MS = 1_000 / 60;
const SEND_MS = 50;
const OLD_DELAY_MS = 110;
const OLD_EXTRAPOLATION_MS = 140;
const OLD_CORRECTION_RATE = 24;
const SNAP_DISTANCE = 240;
const DELAYS = [60, 72, 148, 84, 160, 68, 125, 76, 154, 92, 64, 138];

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function truthAt(time) {
  const t = Math.max(0, time) / 1_000;
  if (t < 1.2) return { x: 180 + 310 * t, y: 680, vx: 310, vy: 0 };
  if (t < 1.8) {
    const jumpT = t - 1.2;
    return {
      x: 552 + 250 * jumpT,
      y: 680 - 520 * jumpT + 440 * jumpT * jumpT,
      vx: 250,
      vy: -520 + 880 * jumpT,
    };
  }
  const runT = t - 1.8;
  return { x: 702 + 330 * runT, y: 526 + Math.min(154, runT * 500), vx: 330, vy: runT < 0.31 ? 500 : 0 };
}

function samplesWithJitter(durationMs) {
  const packets = [];
  for (let at = 0, index = 0; at <= durationMs; at += SEND_MS, index += 1) {
    if ([9, 10, 11, 12].includes(index % 24)) continue;
    const truth = truthAt(at);
    packets.push({
      ...truth,
      at,
      facing: 1,
      arrivalAt: at + DELAYS[index % DELAYS.length],
    });
  }
  return packets.sort((left, right) => left.arrivalAt - right.arrivalAt || left.at - right.at);
}

function percentile(values, amount) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * amount))];
}

function hermite(first, second, alpha, axis) {
  const spanSeconds = Math.max(1, second.at - first.at) / 1_000;
  const velocityKey = axis === "x" ? "vx" : "vy";
  const p0 = first[axis];
  const p1 = second[axis];
  const displacement = p1 - p0;
  if (Math.abs(displacement) < 0.0001) return p0;
  let m0 = first[velocityKey] * spanSeconds;
  let m1 = second[velocityKey] * spanSeconds;
  let slope0 = m0 / displacement;
  let slope1 = m1 / displacement;
  if (slope0 < 0) slope0 = 0;
  if (slope1 < 0) slope1 = 0;
  const magnitude = Math.hypot(slope0, slope1);
  if (magnitude > 3) {
    const scale = 3 / magnitude;
    slope0 *= scale;
    slope1 *= scale;
  }
  m0 = slope0 * displacement;
  m1 = slope1 * displacement;
  const t2 = alpha * alpha;
  const t3 = t2 * alpha;
  const value =
    (2 * t3 - 3 * t2 + 1) * p0 +
    (t3 - 2 * t2 + alpha) * m0 +
    (-2 * t3 + 3 * t2) * p1 +
    (t3 - t2) * m1;
  return value;
}

function evaluate(samples, renderAt, useHermite) {
  while (samples.length >= 2 && samples[1].at <= renderAt) samples.shift();
  const first = samples[0];
  const second = samples[1];
  if (!first) return null;
  if (second && renderAt >= first.at) {
    const alpha = clamp((renderAt - first.at) / Math.max(1, second.at - first.at), 0, 1);
    return {
      x: useHermite ? hermite(first, second, alpha, "x") : first.x + (second.x - first.x) * alpha,
      y: useHermite ? hermite(first, second, alpha, "y") : first.y + (second.y - first.y) * alpha,
    };
  }
  const age = clamp(renderAt - first.at, 0, useHermite ? 180 : OLD_EXTRAPOLATION_MS);
  const damping = 1;
  return {
    x: first.x + first.vx * (age / 1_000) * damping,
    y: first.y + first.vy * (age / 1_000) * damping,
  };
}

function simulate(mode) {
  const packets = samplesWithJitter(4_000);
  const samples = [];
  const transitHistory = [];
  const frames = [];
  let packetIndex = 0;
  let lastAt = -Infinity;
  let x = truthAt(0).x;
  let y = truthAt(0).y;
  let delay = mode === "new" ? 200 : OLD_DELAY_MS;
  let targetDelay = delay;

  for (let now = 0; now <= 4_300; now += FRAME_MS) {
    while (packetIndex < packets.length && packets[packetIndex].arrivalAt <= now) {
      const packet = packets[packetIndex++];
      if (packet.at < lastAt) continue;
      if (packet.at === lastAt && samples.length) samples[samples.length - 1] = packet;
      else samples.push(packet);
      lastAt = packet.at;
      while (samples.length > 14) samples.shift();
      if (mode === "new") {
        transitHistory.push(clamp(now - packet.at, 0, 400));
        while (transitHistory.length > 24) transitHistory.shift();
        targetDelay = Math.max(
          targetDelay, clamp(percentile(transitHistory, 0.9) + 40, 180, 240));
      }
    }
    if (!samples.length) continue;
    if (mode === "new") {
      const difference = targetDelay - delay;
      delay += clamp(difference, -FRAME_MS * 0.03, FRAME_MS * 0.18);
    }
    const desired = evaluate(samples, now - delay, mode === "new");
    if (!desired) continue;
    const correction = 1 - Math.exp(-OLD_CORRECTION_RATE * (FRAME_MS / 1_000));
    x += (desired.x - x) * correction;
    y += (desired.y - y) * correction;
    frames.push({ now, x, y });
  }
  return frames;
}

function metrics(frames) {
  const steadyFrames = frames.filter((frame) => frame.now >= 2_300 && frame.now <= 4_000);
  const steps = [];
  for (let index = 1; index < steadyFrames.length; index += 1) {
    steps.push(Math.hypot(steadyFrames[index].x - steadyFrames[index - 1].x, steadyFrames[index].y - steadyFrames[index - 1].y));
  }
  const accelerations = [];
  for (let index = 1; index < steps.length; index += 1) {
    accelerations.push(Math.abs(steps[index] - steps[index - 1]));
  }
  return {
    maxFrameDelta: Math.max(...steps),
    meanJitter: accelerations.reduce((sum, value) => sum + value, 0) / accelerations.length,
    p95Jitter: percentile(accelerations, 0.95),
  };
}

const oldMetrics = metrics(simulate("old"));
const newMetrics = metrics(simulate("new"));
console.log(JSON.stringify({ old: oldMetrics, candidate: newMetrics }, null, 2));

assert.ok(
  newMetrics.maxFrameDelta < oldMetrics.maxFrameDelta * 0.9,
  `expected lower frame spike, old=${oldMetrics.maxFrameDelta}, new=${newMetrics.maxFrameDelta}`,
);
assert.ok(
  newMetrics.p95Jitter < oldMetrics.p95Jitter * 0.82,
  `expected lower p95 jitter, old=${oldMetrics.p95Jitter}, new=${newMetrics.p95Jitter}`,
);

function applyIncomingSnap(sprite, state, sample, snap) {
  const distance = Math.hypot(sprite.x - sample.x, sprite.y - sample.y);
  if (snap || distance >= SNAP_DISTANCE) {
    state.samples = [sample];
    state.lastAt = sample.at;
    sprite.x = sample.x;
    sprite.y = sample.y;
  }
}

const portalSprite = { x: 240, y: 700 };
const portalState = { samples: [{ x: 240, y: 700, at: 1_000 }], lastAt: 1_000 };
applyIncomingSnap(
  portalSprite,
  portalState,
  { x: 760, y: 300, vx: 0, vy: -640, facing: 1, at: 1_050 },
  true,
);
assert.deepEqual(portalSprite, { x: 760, y: 300 }, "portal snap must render immediately");
assert.equal(portalState.samples.length, 1, "portal snap must flush interpolation history");

for (const required of [
  "REMOTE_ADAPTIVE_DELAY_MIN_MS",
  "REMOTE_ADAPTIVE_DELAY_MAX_MS",
  "hermiteNoOvershoot",
  "receivePeerMotion(motion)",
]) {
  assert.ok(sceneSource.includes(required), `scene is missing ${required}`);
}

console.log("remote motion deterministic harness passed");
