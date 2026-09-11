import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { CATALOG } from "../src/lab/catalog.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = new URL("../artifacts/trap-lab-browser/", import.meta.url);
const port = 32181;
const url = `http://127.0.0.1:${port}`;
await mkdir(artifacts, { recursive: true });
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", ...(process.env.LAB_TEST_DEV ? [] : ["preview"]),
  "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let serverOutput = "";
server.stdout.on("data", (data) => { serverOutput += data; });
server.stderr.on("data", (data) => { serverOutput += data; });
let browser;
let page;
const errors = [];
try {
  let listening = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) throw new Error(serverOutput);
    try { if ((await fetch(`${url}/lab.html`)).ok) { listening = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(listening, `lab server did not start: ${serverOutput}`);
  const executablePath = process.env.LAB_BROWSER_PATH || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
  browser = await chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(() => {
    let value;
    Object.defineProperty(window, "Phaser", {
      configurable: true, get: () => value,
      set(next) {
        value = next;
        if (!next?.Game || next.Game.__labCaptured) return;
        const OriginalGame = next.Game;
        class CaptureGame extends OriginalGame {
          constructor(...args) { super(...args); window.__LAB_GAME__ = this; }
        }
        CaptureGame.__labCaptured = true;
        next.Game = CaptureGame;
      },
    });
  });
  await page.goto(`${url}/lab.html`);
  await page.waitForFunction(() => document.getElementById("scene-loading").hidden, null, { timeout: 20000 });
  assert.equal(await page.locator(".lab-card").count(), CATALOG.length);
  assert.ok(await page.evaluate(() => window.__LAB_GAME__?.scene.getScene("Boltbound")?.playerSprites.size === 2));
  const select = async (type) => page.locator(`.lab-card[data-type="${type}"]`).click();
  const count = async (expected) => {
    assert.equal(await page.locator("#placement-count").textContent(), `${expected} 件零件`);
  };
  const exact = async (type, x, y) => {
    await select(type);
    await page.locator("#place-x").fill(String(x));
    await page.locator("#place-y").fill(String(y));
    await page.locator("#place-exact").click();
  };
  const worldClick = async (x, y) => {
    const bounds = await page.locator("#lab-canvas canvas").boundingBox();
    await page.mouse.click(bounds.x + x / 1600 * bounds.width, bounds.y + y / 900 * bounds.height);
  };
  const setSpawn = async (x, y) => {
    await page.locator('[data-tool="spawn"]').click();
    await worldClick(x, y);
  };
  const sceneValue = async (expression) => page.evaluate((source) => {
    const scene = window.__LAB_GAME__.scene.getScene("Boltbound");
    return new Function("scene", "local", `return (${source});`)(scene, scene.playerSprites.get(scene.myPlayerId).sprite);
  }, expression);

  for (const entry of CATALOG) {
    await select(entry.type);
    assert.equal(await page.locator("#selected-name").textContent(), entry.label);
  }
  await page.locator("#catalog-search").fill("烟雾");
  assert.equal(await page.locator(".lab-card").count(), 1);
  await page.locator("#catalog-search").fill("");
  await exact("beam", 480, 320);
  await count(1);
  await page.locator("#place-exact").click();
  await count(1);
  assert.match(await page.locator("#placement-feedback").textContent(), /冲突/);
  await page.locator("#rotate").click();
  await page.locator("#place-x").fill("800");
  await page.locator("#place-y").fill("600");
  await page.locator("#place-exact").click();
  await count(2);
  assert.equal(await sceneValue("scene.roomState.placements[1].rotation"), 90);
  await page.locator("#undo").click(); await count(1);
  await page.locator("#redo").click(); await count(2);
  await page.locator('[data-tool="erase"]').click(); await worldClick(800, 600); await count(1);
  await page.locator("#undo").click(); await count(2);
  await page.locator("#clear-map").click(); await count(0);
  await page.locator("#undo").click(); await count(2);

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-plan").click();
  const download = await downloadPromise;
  const planPath = fileURLToPath(new URL("roundtrip.json", artifacts));
  await download.saveAs(planPath);
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  assert.equal(plan.placements.length, 2);
  await page.locator("#clear-map").click();
  await page.locator("#plan-file").setInputFiles(planPath);
  await page.waitForFunction(() => document.getElementById("placement-count").textContent === "2 件零件");
  await page.reload();
  await page.waitForFunction(() => document.getElementById("scene-loading").hidden);
  await count(2);

  // 通过实际鼠标预览复现方箱贴在横梁上的放置过程，
  // 再让人物站上三层结构，验证游戏原有碰撞体的承托效果。
  await page.locator("#clear-map").click();
  await exact("beam", 480, 320);
  await select("crate");
  const canvasBounds = await page.locator("#lab-canvas canvas").boundingBox();
  await page.mouse.move(canvasBounds.x + 480 / 1600 * canvasBounds.width,
    canvasBounds.y + 260 / 900 * canvasBounds.height);
  await page.waitForFunction(() => {
    const scene = window.__LAB_GAME__.scene.getScene("Boltbound");
    return scene.preview?.x === 480 && scene.preview?.y === 260 && scene.previewValid;
  });
  assert.match(await page.locator("#placement-feedback").textContent(), /可放置/);
  await page.mouse.down();
  await page.mouse.up();
  await count(2);
  await exact("crate", 480, 280);
  await count(2);
  assert.match(await page.locator("#placement-feedback").textContent(), /冲突/);
  await exact("ice", 480, 200);
  await count(3);
  await page.reload();
  await page.waitForFunction(() => document.getElementById("scene-loading").hidden);
  await count(3);
  await setSpawn(480, 100);
  await page.locator("#mode-test").click();
  await page.waitForFunction(() => {
    const scene = window.__LAB_GAME__.scene.getScene("Boltbound");
    const body = scene.playerSprites.get(scene.myPlayerId).sprite.body;
    return body.blocked.down && Math.abs(body.bottom - 180) < 1;
  });
  await page.locator("#lab-canvas canvas").screenshot({ path: fileURLToPath(new URL("stacking.png", artifacts)) });
  await page.locator("#mode-build").click();

  // 验证路障使用独立显示层，能够沿横纵两个方向穿过零件，
  // 同时保留对人物的碰撞承托效果。
  await page.locator("#clear-map").click();
  await exact("barrier", 480, 600);
  await exact("crate", 600, 600);
  await exact("crate", 1040, 440);
  await select("barrier");
  await page.locator("#rotate").click();
  await page.locator("#place-x").fill("1040");
  await page.locator("#place-y").fill("560");
  await page.locator("#place-exact").click();
  await count(4);
  await setSpawn(480, 520);
  await page.locator("#mode-test").click();
  await page.waitForFunction(() => {
    const scene = window.__LAB_GAME__.scene.getScene("Boltbound");
    const local = scene.playerSprites.get(scene.myPlayerId).sprite.body;
    const barrier = scene.movingBarriers[0].sprite.body;
    return (local.blocked.down || local.touching.down) && Math.abs(local.bottom - barrier.top) < 1;
  });
  assert.ok(await sceneValue("scene.movingBarriers.every(({ sprite }) => sprite.displayList === scene.barrierLayer)"));
  assert.ok(await sceneValue("scene.barrierLayer.depth < scene.mapDecorations.find((image) => image.texture?.key === 'piece-crate').depth"));
  await page.waitForFunction(() => {
    const scene = window.__LAB_GAME__.scene.getScene("Boltbound");
    return scene.movingBarriers[0].sprite.body.center.x > 590;
  });
  await page.locator("#lab-canvas canvas").screenshot({ path: fileURLToPath(new URL("barrier-crossing.png", artifacts)) });
  await page.waitForFunction(() => {
    const scene = window.__LAB_GAME__.scene.getScene("Boltbound");
    return scene.movingBarriers[1].sprite.body.center.y < 450;
  });
  assert.equal(await sceneValue("scene.roomState.placements.find((piece) => piece.type === 'crate').x"), 600);
  await page.locator("#mode-build").click();
  assert.equal(await sceneValue("scene.movingBarriers[0].sprite.body.center.x"), 480);
  assert.equal(await sceneValue("scene.movingBarriers[1].sprite.body.center.y"), 560);

  await page.locator("#clear-map").click();
  await exact("portal", 480, 600);
  await exact("portal", 1000, 320);
  await exact("beam", 480, 320);
  await count(3);
  await page.locator('[data-tool="erase"]').click();
  await worldClick(1000, 320);
  await count(1);
  await page.locator("#undo").click();
  await count(3);

  // Real original-scene physics: stand on a constructed platform, jump, move,
  // receive negative effects, cleanse them, and blast away the platform.
  await page.locator("#clear-map").click();
  await exact("beam", 480, 320);
  await setSpawn(480, 240);
  await page.locator("#mode-test").click();
  await page.waitForFunction(() => {
    const scene = window.__LAB_GAME__.scene.getScene("Boltbound");
    return scene.playerSprites.get(scene.myPlayerId).sprite.body.blocked.down;
  });
  const groundedY = await sceneValue("local.y");
  await page.keyboard.press("Space");
  await page.waitForFunction((y) => {
    const scene = window.__LAB_GAME__.scene.getScene("Boltbound");
    return scene.playerSprites.get(scene.myPlayerId).sprite.y < y - 30;
  }, groundedY);
  await page.locator("#respawn").click();
  await select("reverse"); await page.locator("#use-item").click();
  assert.equal(await sceneValue("scene.activeItemEffect(scene.myPlayerId, 'debuff').type"), "reverse");
  await page.keyboard.down("KeyD");
  await page.waitForFunction(() => {
    const scene = window.__LAB_GAME__.scene.getScene("Boltbound");
    return scene.playerSprites.get(scene.myPlayerId).sprite.body.velocity.x < -10;
  });
  await page.keyboard.up("KeyD");
  await select("shield"); await page.locator("#use-item").click();
  assert.equal(await sceneValue("scene.activeItemEffect(scene.myPlayerId, 'debuff')"), null);
  assert.equal(await sceneValue("scene.activeItemEffect(scene.myPlayerId, 'self').type"), "shield");
  await page.locator("#clear-effects").click();
  await select("fog"); await page.locator("#use-item").click();
  await page.waitForFunction(() => window.__LAB_GAME__.scene.getScene("Boltbound").fogRects.some((rect) => rect.visible));
  await page.locator("#clear-effects").click();
  await page.waitForFunction(() => window.__LAB_GAME__.scene.getScene("Boltbound").fogRects.every((rect) => !rect.visible));
  await page.locator("#respawn").click();
  await select("bomb"); await page.locator("#use-item").click(); await count(0);
  await page.locator("#reset-test").click(); await count(1);
  await page.locator("#mode-build").click();

  // A spike collision really kills the avatar, and respawn enables its body again.
  await page.locator("#clear-map").click();
  await exact("spikes", 480, 320);
  await setSpawn(480, 245);
  await page.locator("#mode-test").click();
  await page.waitForFunction(() => document.getElementById("player-status").textContent.includes("已死亡"));
  assert.equal(await sceneValue("local.body.enable"), false);
  await page.locator("#respawn").click();
  assert.equal(await sceneValue("local.body.enable"), true);
  await page.locator("#mode-build").click();

  // Leave a representative overview screenshot, then exercise a narrow viewport.
  await page.locator("#clear-map").click();
  await exact("beam", 480, 320);
  await exact("spring", 480, 260);
  await exact("saw", 1020, 560);
  await exact("ice", 740, 620);
  await select("spring");
  await page.locator("#debug-bodies").check();
  await page.locator("#debug-bodies").uncheck();
  await page.locator("#lab-toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: fileURLToPath(new URL("desktop.png", artifacts)), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await select("turbo");
  await page.locator("#use-item").click();
  await page.locator("#use-item").click();
  assert.equal(await sceneValue("scene.activeItemEffect(scene.myPlayerId, 'self').type"), "turbo");
  const rightControl = page.locator('[data-control="right"]');
  await rightControl.scrollIntoViewIfNeeded();
  const controlBounds = await rightControl.boundingBox();
  await page.mouse.move(controlBounds.x + controlBounds.width / 2, controlBounds.y + controlBounds.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => {
    const scene = window.__LAB_GAME__.scene.getScene("Boltbound");
    return scene.playerSprites.get(scene.myPlayerId).sprite.body.velocity.x > 10;
  });
  await page.mouse.up();
  assert.equal(await sceneValue("scene.touch.right"), false);
  await page.screenshot({ path: fileURLToPath(new URL("mobile.png", artifacts)), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(new URL("result.json", artifacts), JSON.stringify({ ok: true, catalog: CATALOG.length, errors,
    checked: ["source catalog", "placement validation", "rotation", "delete", "undo/redo", "JSON roundtrip", "reload persistence",
      "贴边叠放预览与鼠标放置", "叠放实体穿入拒绝", "叠放结构刷新恢复与碰撞承托",
      "路障独立显示层", "路障横纵穿行", "路障承托人物与返回搭建复位",
      "paired portal deletion", "real jumping", "reverse input", "shield cleansing", "fog", "bomb recovery", "spike death", "respawn", "responsive layout"] }, null, 2));
  console.log("Trap lab browser checks passed; screenshots and report: artifacts/trap-lab-browser/");
} catch (error) {
  await page?.screenshot({ path: fileURLToPath(new URL("failure.png", artifacts)), fullPage: true }).catch(() => {});
  console.error("Browser errors:", errors);
  throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null) server.kill();
}
