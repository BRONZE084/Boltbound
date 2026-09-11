import assert from "node:assert/strict";

// 运行真实 Phaser 场景的完整帧流程，检查物理同步、轨迹与人物承托。
// 固定测试时钟与帧间隔，避免浏览器负载掩盖重复位移或低帧率问题。
export async function checkBarrierMotion(page) {
  const results = await page.evaluate(() => {
    const game = window.__LAB_GAME__;
    const scene = game.scene.getScene("Boltbound");
    game.loop.stop();
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    const results = [];
    try {
      for (const [rate, intervals] of [
        ["30 FPS", [1000 / 30]], ["60 FPS", [1000 / 60]],
        ["120 FPS", [1000 / 120]], ["不均匀帧间隔", [8, 24, 12, 36, 16, 20]],
      ]) {
        for (const rotation of [0, 90, 180, 270]) {
          const start = now;
          const state = structuredClone(scene.roomState);
          state.phase = "race";
          state.mapRevision += 1;
          state.players.forEach((player) => { player.status = "racing"; });
          state.race = { countdownAt: start, effects: {}, itemCooldowns: {} };
          state.placements = [{ id: "motion-test", type: "barrier", x: 480, y: 560, rotation,
            ...scene.pieceDimensions("barrier", rotation) }];
          scene.serverTimeOffset = 0;
          scene.applyRoomState(state, scene.myPlayerId);
          scene.resetForRace();
          scene.physics.resume();
          scene.physics.world._elapsed = 0;
          const barrier = scene.movingBarriers[0];
          const local = scene.playerSprites.get(scene.myPlayerId).sprite;
          scene.touch.left = false;
          scene.touch.right = false;
          local.body.updateFromGameObject();
          const footOffset = local.body.bottom - local.y;
          local.body.reset(barrier.baseX, barrier.sprite.body.top - footOffset);
          local.body.updateFromGameObject();
          const initialOffsetX = local.x - barrier.sprite.x;
          let maxSpriteBodyError = 0;
          let maxTrajectoryError = 0;
          let maxRiderOffset = 0;
          let maxFootGap = 0;
          let frames = 0;
          let supportedFrames = 0;
          while (now - start < 5600) {
            const delta = intervals[frames % intervals.length];
            now += delta;
            scene.sys.step(now, delta);
            const body = barrier.sprite.body;
            const offset = Math.sin((now - start) * Math.PI * 2 / 2800) * 120;
            const expectedX = 480 + (rotation === 0 ? offset : rotation === 180 ? -offset : 0);
            const expectedY = 560 + (rotation === 90 ? offset : rotation === 270 ? -offset : 0);
            maxSpriteBodyError = Math.max(maxSpriteBodyError,
              Math.hypot(barrier.sprite.x - body.center.x, barrier.sprite.y - body.center.y));
            maxTrajectoryError = Math.max(maxTrajectoryError,
              Math.hypot(barrier.sprite.x - expectedX, barrier.sprite.y - expectedY));
            maxRiderOffset = Math.max(maxRiderOffset, Math.abs(local.x - barrier.sprite.x - initialOffsetX));
            maxFootGap = Math.max(maxFootGap, Math.abs(local.body.bottom - body.top));
            if (local.body.blocked.down || local.body.touching.down) supportedFrames += 1;
            frames += 1;
          }
          let jumpCleared = null;
          {
            // 承托只在接触时生效，人物仍能主动跳离任意方向的路障。
            scene.queueJumpPress();
            for (let frame = 0; frame < 20; frame += 1) {
              now += 1000 / 60;
              scene.sys.step(now, 1000 / 60);
            }
            jumpCleared = local.body.bottom < barrier.sprite.body.top - 30;
          }
          results.push({ rate, rotation, frames, maxSpriteBodyError, maxTrajectoryError,
            maxRiderOffset, maxFootGap, riderHeight: local.body.height, supportedFrames,
            alive: local.body.enable, jumpCleared });
        }
      }
    } finally {
      Date.now = originalNow;
    }
    return results;
  });
  return results;
}

export function assertBarrierMotion(results) {
  for (const result of results) {
    const label = `${result.rate}、${result.rotation}°`;
    assert.ok(result.maxSpriteBodyError < 0.01, `${label}：路障图片和碰撞体应始终对齐，实际偏差 ${result.maxSpriteBodyError}`);
    assert.ok(result.maxTrajectoryError < 0.01, `${label}：路障应沿既定轨迹平稳运动，实际偏差 ${result.maxTrajectoryError}`);
    assert.ok(result.alive, `${label}：站在路障上的人物不能自行掉落死亡`);
    assert.ok(result.supportedFrames > 0, `${label}：人物与路障必须产生真实承托接触`);
    assert.ok(result.maxRiderOffset < 0.01, `${label}：人物应随路障移动，实际相对偏移 ${result.maxRiderOffset}`);
    assert.ok(result.maxFootGap < 0.01, `${label}：人物脚底应始终贴合承托面，实际偏差 ${result.maxFootGap}`);
    assert.ok(result.jumpCleared, `${label}：人物应能正常跳离路障`);
  }
}


// 使用真实场景验证承托的建立与解除，避免仅验证静止人物的理想情况。
export async function checkBarrierInteractions(page) {
  const result = await page.evaluate(() => {
    const game = window.__LAB_GAME__;
    const scene = game.scene.getScene("Boltbound");
    game.loop.stop();
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    const step = () => { now += 1000 / 60; scene.sys.step(now, 1000 / 60); };
    const setup = (rotation = 0, obstacles = [], gap = 0) => {
      const state = structuredClone(scene.roomState);
      state.phase = "race";
      state.mapRevision += 1;
      state.players.forEach((player) => { player.status = "racing"; });
      state.race = { countdownAt: now, effects: {}, itemCooldowns: {} };
      state.placements = [{ id: "rider-platform", type: "barrier", x: 480, y: 560, rotation,
        ...scene.pieceDimensions("barrier", rotation) }, ...obstacles];
      scene.serverTimeOffset = 0;
      scene.applyRoomState(state, scene.myPlayerId);
      scene.resetForRace();
      scene.physics.resume();
      scene.physics.world._elapsed = 0;
      scene.touch.left = false;
      scene.touch.right = false;
      const local = scene.playerSprites.get(scene.myPlayerId).sprite;
      const platform = scene.movingBarriers[0].sprite;
      local.body.updateFromGameObject();
      const footOffset = local.body.bottom - local.y;
      local.body.reset(480, platform.body.top - footOffset - gap);
      local.body.updateFromGameObject();
      return { local, platform };
    };
    try {
      const blocked = [];
      for (const [name, rotation, obstacle] of [
        ["侧墙", 0, { type: "crate", x: 600, y: 500, rotation: 0 }],
        ["顶板", 270, { type: "crate", x: 480, y: 340, rotation: 0 }],
      ]) {
        const { local, platform } = setup(rotation, [obstacle]);
        let released = false;
        let penetration = 0;
        let maxFootGap = 0;
        let maxRelativeSlide = 0;
        for (let frame = 0; frame < 42; frame += 1) {
          step();
          released ||= scene.ignoredBarrierSupports.size > 0;
          const body = local.body;
          maxRelativeSlide = Math.max(maxRelativeSlide, Math.abs(local.x - platform.x));
          maxFootGap = Math.max(maxFootGap, Math.abs(body.bottom - platform.body.top));
          const overlapX = Math.min(body.right, obstacle.x + 40) - Math.max(body.left, obstacle.x - 40);
          const overlapY = Math.min(body.bottom, obstacle.y + 40) - Math.max(body.top, obstacle.y - 40);
          penetration = Math.max(penetration, Math.min(overlapX, overlapY));
        }
        blocked.push({ name, released, penetration, maxFootGap, maxRelativeSlide });
      }
      const landings = [];
      for (const rotation of [0, 90, 180, 270]) {
        const { local, platform } = setup(rotation, [], 100);
        let landed = false;
        for (let frame = 0; frame < 100; frame += 1) {
          step();
          if (scene.barrierSupport === platform) { landed = true; break; }
        }
        let maxGap = 0;
        for (let frame = 0; frame < 100 && landed; frame += 1) {
          step();
          maxGap = Math.max(maxGap, Math.abs(local.body.bottom - platform.body.top));
        }
        landings.push({ rotation, landed, maxGap });
      }
      let { local, platform } = setup();
      step();
      scene.touch.right = true;
      let walkedOff = false;
      for (let frame = 0; frame < 60; frame += 1) {
        step();
        if (!scene.barrierSupport && local.body.left >= platform.body.right) {
          walkedOff = local.body.allowGravity;
          break;
        }
      }
      ({ local } = setup());
      step();
      const teleported = scene.restoreLocalMotion({ x: 1000, y: 100, vx: 0, vy: 0 });
      step();
      const teleportReleased = teleported && !scene.barrierSupport && local.body.allowGravity && Math.abs(local.x - 1000) < 0.01;
      ({ local } = setup());
      step();
      scene.roomState.placements = [];
      scene.rebuildMap();
      step();
      const removalReleased = !scene.barrierSupport && local.body.allowGravity && local.body.velocity.y > 0;
      ({ local } = setup());
      step();
      scene.resetForRace();
      const resetReleased = !scene.barrierSupport && local.body.allowGravity;
      return { blocked, landings, walkedOff, teleportReleased, removalReleased, resetReleased };
    } finally { Date.now = originalNow; }
  });
  for (const blocked of result.blocked) {
    if (blocked.name === "顶板") assert.ok(blocked.released, "纵向受阻后应解除承托");
    else {
      assert.ok(blocked.maxFootGap < 0.01, "碰到侧墙时脚底仍应保持承托");
      assert.ok(blocked.maxRelativeSlide > 30, "碰到侧墙时允许平台从人物脚下滑过");
    }
    assert.ok(blocked.penetration < 0.01, `${blocked.name}：平台不能把人物送入固定实体，穿入 ${blocked.penetration}`);
  }
  for (const landing of result.landings) {
    assert.ok(landing.landed, `${landing.rotation}°：下落人物应能落到移动平台上`);
    assert.ok(landing.maxGap < 0.01, `${landing.rotation}°：落地后脚底应保持贴合，间隙 ${landing.maxGap}`);
  }
  for (const [key, label] of Object.entries({ walkedOff: "走下平台", teleportReleased: "传送复位",
    removalReleased: "移除承托平台", resetReleased: "重置试用" })) {
    assert.ok(result[key], `${label}后不能保留过期承托关系`);
  }
  return result;
}
