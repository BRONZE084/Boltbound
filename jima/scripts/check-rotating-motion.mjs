import assert from "node:assert/strict";

export async function checkRotatingMotion(page) {
  const result = await page.evaluate(() => {
    const game = window.__LAB_GAME__;
    const scene = game.scene.getScene("Boltbound");
    game.loop.stop();
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    const step = (delta = 1000 / 60) => { now += delta; scene.sys.step(now, delta); };
    const setup = (type, rotation = 0, extra = []) => {
      const state = structuredClone(scene.roomState);
      state.phase = "race";
      state.mapRevision += 1;
      state.players.forEach((player) => { player.status = "racing"; });
      state.race = { countdownAt: now, effects: {}, itemCooldowns: {} };
      state.placements = [{ id: "rotor", type, x: 400, y: 560, rotation,
        ...scene.pieceDimensions(type, rotation) }, ...extra];
      scene.serverTimeOffset = 0;
      scene.applyRoomState(state, scene.myPlayerId);
      scene.resetForRace();
      scene.physics.resume();
      scene.physics.world._elapsed = 0;
      scene.touch.left = scene.touch.right = false;
      return scene.playerSprites.get(scene.myPlayerId).sprite;
    };
    const stand = (local, x, top) => {
      local.body.updateFromGameObject();
      local.body.reset(x, top - (local.body.bottom - local.y));
      local.body.updateFromGameObject();
    };
    try {
      const windmill = [];
      for (const [rate, intervals] of [["30 FPS", [1000 / 30]], ["60 FPS", [1000 / 60]],
        ["120 FPS", [1000 / 120]], ["不均匀帧间隔", [8, 24, 12, 36, 16, 20]]]) {
        const local = setup("windmill");
        const start = now;
        const pads = scene.movingBarriers.map((entry) => entry.sprite);
        const pad = pads[0];
        stand(local, pad.x, pad.body.top);
        let error = 0;
        let orbitError = 0;
        let frame = 0;
        while (now - start < 8000) {
          step(intervals[frame % intervals.length]);
          error = Math.max(error, Math.abs(local.x - pad.x), Math.abs(local.body.bottom - pad.body.top));
          for (const platform of pads) {
            orbitError = Math.max(orbitError, Math.abs(Math.hypot(platform.x - 400, platform.y - 560) - 120));
          }
          frame += 1;
        }
        scene.queueJumpPress();
        for (let index = 0; index < 15; index += 1) step();
        windmill.push({ rate, platforms: pads.length, error, orbitError,
          jump: local.body.bottom < pad.body.top - 20, alive: local.body.enable });
      }
      let local = setup("rotatingCrate");
      let crate = scene.rotatingCrates[0];
      stand(local, crate.shape.x, crate.shape.y - 40 - 60);
      let supported = 0;
      let maxDepth = 0;
      const start = now;
      for (let frame = 0; frame < 65; frame += 1) {
        step();
        if (scene.rotatingSupport) supported += 1;
        // 用世界坐标中的四条箱边和人物角点投影，检查是否穿进箱体。
        const angle = crate.shape.angle;
        const c = Math.cos(angle), s = Math.sin(angle);
        let depth = Infinity;
        const body = local.body;
        for (const [ax, ay] of [[1, 0], [0, 1], [c, s], [-s, c]]) {
          const d = Math.abs((body.center.x - crate.shape.x) * ax + (body.center.y - crate.shape.y) * ay);
          const extent = (Math.abs(ax) * body.width + Math.abs(ay) * body.height) / 2 +
            40 * (Math.abs(ax * c + ay * s) + Math.abs(-ax * s + ay * c));
          depth = Math.min(depth, extent - d);
        }
        maxDepth = Math.max(maxDepth, depth);
      }
      const turned = crate.image.rotation > 0.1 && crate.image.rotation < Math.PI / 2;
      scene.queueJumpPress();
      for (let frame = 0; frame < 12; frame += 1) step();
      const crateJump = !scene.rotatingSupport && local.body.velocity.y < 0;
      const pauses = [];
      for (const rotation of [0, 90]) {
        setup("rotatingCrate", rotation);
        const clockStart = now;
        for (const elapsed of [1500, 1675, 1850, 3000, 3175, 3350, 6000, 6175, 6350]) {
          step(elapsed - (now - clockStart));
          pauses.push({ rotation, elapsed, angle: scene.rotatingCrates[0].shape.angle });
        }
      }
      // 在 45° 外接方框的空角放人物，不能产生虚假的方形碰撞。
      local = setup("rotatingCrate");
      step(925);
      crate = scene.rotatingCrates[0];
      local.body.setAllowGravity(false);
      local.setVelocity(0, 0);
      local.body.reset(465, 455);
      local.body.updateFromGameObject();
      const emptyCorner = { x: local.x, y: local.y };
      scene.resolveRotatingCrates();
      const emptyCornerShift = Math.hypot(local.x - emptyCorner.x, local.y - emptyCorner.y);
      scene.resetForRace();
      const resetAngle = crate.image.rotation;
      return { windmill, supported, maxDepth, turned, pauses, crateJump, emptyCornerShift, resetAngle,
        motionLayer: scene.barrierLayer.depth, actorLayer: local.depth };
    } finally { Date.now = originalNow; }
  });
  for (const row of result.windmill) {
    assert.equal(row.platforms, 4, "风车必须有四个平台");
    assert.ok(row.error < 0.01, `${row.rate}：风车搭乘人物应贴合平台，偏差 ${row.error}`);
    assert.ok(row.orbitError < 0.01, `${row.rate}：四个平台必须保持回转半径`);
    assert.ok(row.jump && row.alive, `${row.rate}：人物应能主动跳离风车`);
  }
  assert.ok(result.supported > 5, "人物必须能自然落到旋转方箱上");
  assert.ok(result.maxDepth < 0.01, `人物不能穿入旋转方箱，穿入 ${result.maxDepth}`);
  assert.ok(result.turned, "旋转方箱在停顿结束后应开始转动");
  for (const pause of result.pauses) {
    const expected = pause.rotation * Math.PI / 180 + Math.floor(pause.elapsed / 1500) * Math.PI / 2;
    assert.ok(Math.abs(pause.angle - expected) < 0.0001, `${pause.rotation}° 初始角、${pause.elapsed}ms：应停在 90° 的整数角度`);
  }
  assert.ok(result.crateJump, "人物应能主动跳离旋转方箱");
  assert.ok(result.emptyCornerShift < 0.01, "旋转方箱的外接方框空角不得产生碰撞");
  assert.equal(result.resetAngle, 0, "重置后方箱回到初始角度");
  assert.ok(result.motionLayer > 5 && result.motionLayer < result.actorLayer, "运动件应位于静止结构之上、人物之下");
  return result;
}
