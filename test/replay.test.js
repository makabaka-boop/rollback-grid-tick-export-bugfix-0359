'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const C = require('../replay-core.js');

const DIRS = C.DIR_NAMES;

function entriesOf(slots) {
  return slots
    .map((s, t) => (s ? Object.assign({ tick: t }, s) : null))
    .filter(Boolean)
}

function full(slots, length) {
  return C.replayFrames(entriesOf(slots), length);
}

function randSlots(rnd, n, dense) {
  const slots = [];
  for (let t = 0; t < n; t++) {
    if (dense || rnd() < 0.7) {
      const s = {};
      if (dense || rnd() < 0.85) s.a = DIRS[Math.floor(rnd() * 5)];
      if (dense || rnd() < 0.85) s.b = DIRS[Math.floor(rnd() * 5)];
      slots[t] = s;
    }
  }
  return slots;
}

// ---------------------------------------------------------------- 固定棋盘与基础裁决
test('棋盘为 12×12，墙体与拾取物固定且对称、不重叠', () => {
  assert.equal(C.GRID, 12);
  assert.ok(C.WALLS.size >= 8);
  for (const w of C.WALLS) {
    const [x, y] = w.split(',').map(Number);
    const mirrored = (C.GRID - 1 - x) + ',' + (C.GRID - 1 - y);
    assert.ok(C.WALLS.has(mirrored), '墙体必须中心对称: ' + w);
    assert.ok(!C.PICKUP_LIST.some((p) => p[0] === x && p[1] === y), '拾取物不能压在墙上');
  }
  for (const [x, y] of C.PICKUP_LIST) {
    const mirrored = [C.GRID - 1 - x, C.GRID - 1 - y];
    assert.ok(C.PICKUP_LIST.some((p) => p[0] === mirrored[0] && p[1] === mirrored[1]));
  }
  assert.ok(!C.WALLS.has('0,0'));
  assert.ok(!C.WALLS.has('11,11'));
  assert.ok(!C.PICKUP_LIST.some(([x, y]) => (x === 0 && y === 0) || (x === 11 && y === 11)));
});

test('撞墙/越界：留在原位并产生 wall 事件；裁决不受另一人影响', () => {
  const f0 = C.makeInitialFrame();
  let f = C.stepFrame(f0, 'left', 'right');
  assert.deepEqual(f.a, { x: 0, y: 0 });
  assert.deepEqual(f.b, { x: 11, y: 11 });
  assert.equal(f.events.filter((e) => e.type === 'wall').length, 2);

  f = C.stepFrame(f0, 'up', 'down');
  assert.deepEqual(f.a, { x: 0, y: 0 });
  assert.deepEqual(f.b, { x: 11, y: 11 });
  assert.equal(f.events.length, 2);

  // 走到固定墙 (2,2) 前再尝试向下
  const rep = new C.Replayer();
  rep.reset(entriesOf([{ a: 'right' }, { a: 'right' }, { a: 'down' }, { a: 'down' }]), 4);
  const f4 = rep.frames[4];
  assert.deepEqual(f4.a, { x: 2, y: 1 }, '(2,2) 是墙，应停在 (2,1)');
  assert.ok(f4.events.some((e) => e.type === 'wall' && e.who === 'A'));
});

test('互换位置：双方退回原位，记 swap_blocked', () => {
  const prev = { tick: 10, a: { x: 4, y: 4 }, b: { x: 5, y: 4 },
    scoreA: 0, scoreB: 0, collected: {}, events: [] };
  const f = C.stepFrame(prev, 'right', 'left');
  assert.deepEqual(f.a, { x: 4, y: 4 });
  assert.deepEqual(f.b, { x: 5, y: 4 });
  assert.ok(f.events.some((e) => e.type === 'swap_blocked'));
});

test('同格相遇：双方退回原位，记 meet_blocked（含撞向停留者）', () => {
  const prev = { tick: 1, a: { x: 3, y: 4 }, b: { x: 5, y: 4 },
    scoreA: 0, scoreB: 0, collected: {}, events: [] };
  let f = C.stepFrame(prev, 'right', 'left');
  assert.deepEqual(f.a, { x: 3, y: 4 });
  assert.deepEqual(f.b, { x: 5, y: 4 });
  assert.ok(f.events.some((e) => e.type === 'meet_blocked'));

  // A 向右撞上停留的 B，也必须退回
  const prev2 = { tick: 1, a: { x: 3, y: 4 }, b: { x: 4, y: 4 },
    scoreA: 0, scoreB: 0, collected: {}, events: [] };
  f = C.stepFrame(prev2, 'right', 'stay');
  assert.deepEqual(f.a, { x: 3, y: 4 });
  assert.deepEqual(f.b, { x: 4, y: 4 });
  assert.ok(f.events.some((e) => e.type === 'meet_blocked'));
});

test('追尾串行使：前车驶离后车进入', () => {
  const prev = { tick: 1, a: { x: 3, y: 4 }, b: { x: 4, y: 4 },
    scoreA: 0, scoreB: 0, collected: {}, events: [] };
  const f = C.stepFrame(prev, 'right', 'right');
  assert.deepEqual(f.a, { x: 4, y: 4 });
  assert.deepEqual(f.b, { x: 5, y: 4 });
  assert.equal(f.events.length, 0);
});

test('一次性拾取物：只计一次分，重复经过不再加分', () => {
  const rep = new C.Replayer();
  // A 从 (0,0) 向下到 (0,2) 拾取，然后离开再回来
  rep.reset(entriesOf([
    { a: 'down' }, { a: 'down' }, { a: 'down' }, { a: 'up' }, { a: 'down' }
  ]), 5);
  assert.equal(rep.frames[2].scoreA, 1);
  assert.equal(rep.frames[2].collected['0,2'], 2);
  assert.equal(rep.frames[5].scoreA, 1);
  assert.equal(Object.keys(rep.frames[5].collected).length, 1);
});

test('分数恒等式：总得分 == 已拾取格子数；得分单调不减', () => {
  const rnd = C.mulberry32(4242);
  for (let trial = 0; trial < 5; trial++) {
    const slots = randSlots(rnd, 120, true);
    const r = full(slots, 120);
    let prevA = 0, prevB = 0;
    for (let t = 1; t <= 120; t++) {
      const f = r.frames[t];
      assert.ok(f.scoreA >= prevA && f.scoreB >= prevB);
      prevA = f.scoreA; prevB = f.scoreB;
      assert.equal(f.scoreA + f.scoreB, Object.keys(f.collected).length);
    }
  }
});

// ---------------------------------------------------------------- 指令到达顺序无关
test('裁决与指令到达顺序无关：双人/单人、乱序、分批写入逐状态全等', () => {
  const rnd = C.mulberry32(7);
  const slots = randSlots(rnd, 180, false);
  const ref = full(slots, 180);

  // 方式 1：每个 tick 一条 {a,b}
  let r1 = new C.Replayer();
  r1.reset(entriesOf(slots), 180);
  assert.deepEqual(r1.getResult(), ref);

  // 方式 2：先到全部 A，再补全部 B（patch，长度不变）
  let r2 = new C.Replayer();
  r2.reset(slots.map((s, t) => (s && s.a ? { tick: t, a: s.a } : null)).filter(Boolean), 180);
  r2.patch(slots.map((s, t) => (s && s.b ? { tick: t, b: s.b } : null)).filter(Boolean), 180);
  assert.deepEqual(r2.getResult(), ref);

  // 方式 3：先 B 后 A，且按 tick 倒序到达
  let r3 = new C.Replayer();
  r3.reset(slots.map((s, t) => (s && s.b ? { tick: t, b: s.b } : null)).filter(Boolean), 180);
  const aEdits = [];
  for (let t = 179; t >= 0; t--) if (slots[t] && slots[t].a) aEdits.push({ tick: t, a: slots[t].a });
  r3.patch(aEdits, 180);
  assert.deepEqual(r3.getResult(), ref);

  // 方式 4：who 字段形式、A/B 交错且乱序
  let r4 = new C.Replayer();
  const mixed = [];
  slots.forEach((s, t) => {
    if (!s) return;
    if (s.a) mixed.push({ tick: t, who: 'a', dir: s.a });
    if (s.b) mixed.push({ tick: t, who: 'b', dir: s.b });
  });
  for (let i = mixed.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
  }
  r4.reset([], 180);
  r4.patch(mixed, 180);
  assert.deepEqual(r4.getResult(), ref);

  // 方式 5：完全相同的日志，切成任意小批按顺序追加（tick 编号绝对定位）
  let r5 = new C.Replayer();
  r5.reset([], 0);
  let cursor = 0;
  while (cursor < 180) {
    const take = 1 + Math.floor(rnd() * 12);
    const end = Math.min(180, cursor + take);
    const edits = [];
    for (let t = cursor; t < end; t++) {
      if (slots[t]) edits.push(Object.assign({ tick: t }, slots[t]));
    }
    r5.patch(edits, end);
    cursor = end;
  }
  assert.deepEqual(r5.getResult(), ref);
});

// ---------------------------------------------------------------- 分批送入 + 追补：核心需求
test('相同日志分批送入：每个中间前缀都与从头重放一致', () => {
  const rnd = C.mulberry32(99);
  for (const n of [1, 9, 10, 11, 37, 100, 300]) {
    const slots = randSlots(rnd, n, true);
    const ref = full(slots, n);
    const inc = new C.Replayer();
    inc.reset([], 0);
    let end = 0;
    while (end < n) {
      const take = 1 + Math.floor(rnd() * 13);
      const next = Math.min(n, end + take);
      const edits = [];
      for (let t = end; t < next; t++) {
        if (slots[t]) edits.push(Object.assign({ tick: t }, slots[t]));
      }
      inc.patch(edits, next);
      // 每一批之后，0..next 的每一帧都必须与完整重放相同
      assert.equal(inc.length, next);
      assert.deepEqual(inc.getResult().frames, ref.frames.slice(0, next + 1));
      end = next;
    }
    assert.deepEqual(inc.getResult(), ref);
  }
});

test('在不同 tick 追补/改动过去指令：从最近检查点重放，逐帧摘要全部重建', () => {
  const rnd = C.mulberry32(20260930);
  const slots = randSlots(rnd, 300, true);
  const inc = new C.Replayer();
  inc.reset(entriesOf(slots), 300);
  assert.equal(inc.checkpoints.length, 31); // tick 0..300

  const backfillTicks = [299, 250, 255, 101, 100, 99, 50, 29, 10, 9, 1, 0, 150, 300];
  for (const t of backfillTicks) {
    if (t >= 300) {
      // 300 不可编辑（长度 300 时 tick 范围 0..299），改为缩短测试
      continue;
    }
    const newA = DIRS[Math.floor(rnd() * 5)];
    const newB = DIRS[Math.floor(rnd() * 5)];
    slots[t] = { a: newA, b: newB };
    inc.patch([{ tick: t, a: newA, b: newB }], 300);
    const ref = full(slots, 300);
    assert.deepEqual(inc.getResult(), ref,
      '改动 tick ' + t + ' 后必须与从头完整重放逐状态一致');
    assert.equal(inc.checkpoints.length, 31);
  }

  // 稀疏日志：只给少量 tick，再在“空洞”里补录
  const sparse = new Array(120);
  sparse[5] = { a: 'right', b: 'up' };
  sparse[119] = { a: 'down', b: 'left' };
  const inc2 = new C.Replayer();
  inc2.reset(entriesOf(sparse), 120);
  for (const t of [0, 60, 10, 11, 119, 109, 3]) {
    sparse[t] = { a: DIRS[t % 5], b: DIRS[(t + 2) % 5] };
    inc2.patch([{ tick: t, a: sparse[t].a, b: sparse[t].b }], 120);
    assert.deepEqual(inc2.getResult(), full(sparse, 120), '稀疏补录 tick ' + t);
  }
});

test('检查点复用：不受影响区间保留帧对象，受影响区间重建', () => {
  const rnd = C.mulberry32(3);
  const slots = randSlots(rnd, 300, true);
  const rep = new C.Replayer();
  rep.reset(entriesOf(slots), 300);

  const cp290 = rep.frames[290];
  rep.patch([{ tick: 299, a: 'left', b: 'left' }], 300);
  assert.strictEqual(rep.frames[290], cp290, '改最后一 tick，tick290 检查点帧应原样复用');

  const cp250 = rep.frames[250];
  rep.patch([{ tick: 255, a: 'up' }], 300);
  assert.strictEqual(rep.frames[250], cp250, '改 tick255，tick250 检查点帧应原样复用');
  assert.notStrictEqual(rep.frames[260], cp290);

  rep.patch([{ tick: 0, a: 'left' }], 300);
  assert.notStrictEqual(rep.frames[290], cp290, '改 tick0 后 tick290 帧必须重建');
  assert.strictEqual(rep.frames[0], rep.checkpoints[0]);
  assert.equal(rep.checkpoints.length, 31);
});

test('缩短日志后再增长、删除某 tick 指令：仍与从头重放一致', () => {
  const rnd = C.mulberry32(11);
  const slots = randSlots(rnd, 200, true);
  const rep = new C.Replayer();
  rep.reset(entriesOf(slots), 200);

  rep.patch([], 127); // 缩短
  assert.equal(rep.length, 127);
  assert.equal(rep.checkpoints.length, 13); // 0..120
  assert.deepEqual(rep.getResult(), full(slots.slice(0, 127), 127));
  assert.ok(![...rep.cmds.keys()].some((t) => t >= 127), '越界指令必须被清理');

  rep.patch([], 200); // 再增长（后半指令此前被清理，按停留处理）
  const truncated = new Array(200);
  for (let t = 0; t < 127; t++) if (slots[t]) truncated[t] = slots[t];
  assert.deepEqual(rep.getResult(), full(truncated, 200));

  // 删除 tick 5 的 A 指令（缺省=停留）
  rep.patch([{ tick: 5, a: null }], 200);
  delete truncated[5].a;
  assert.deepEqual(rep.getResult(), full(truncated, 200));
});

test('300 tick 满长：末位 tick 299 编辑从 tick290 检查点重放，结果与完整重放一致', () => {
  const slots = randSlots(C.mulberry32(300), C.MAX_TICKS, true);
  const rep = new C.Replayer();
  rep.reset(entriesOf(slots), C.MAX_TICKS);
  assert.equal(rep.frames.length, 301);
  assert.equal(rep.checkpoints.length, 31);

  const anchor = rep.frames[290];
  slots[299] = { a: 'left', b: 'up' };
  rep.patch([{ tick: 299, a: 'left', b: 'up' }], C.MAX_TICKS);
  assert.strictEqual(rep.frames[290], anchor, 'tick290 检查点应复用');
  assert.deepEqual(rep.getResult(), full(slots, C.MAX_TICKS));

  // no-op patch（内容相同、长度不变）：不重算任何帧，对象全部保留
  const allBefore = rep.frames;
  rep.patch([{ tick: 299, a: 'left', b: 'up' }], C.MAX_TICKS);
  assert.strictEqual(rep.frames, allBefore);
});

test('长度上限 300 与参数校验；失败的 patch 不改动现有状态', () => {  const rep = new C.Replayer();
  assert.throws(() => rep.reset([], 301), /0\.\.300/);
  assert.throws(() => rep.reset([], -1));
  assert.throws(() => rep.reset([{ tick: 0, a: 'nope' }], 1), /非法指令/);

  rep.reset(entriesOf(randSlots(C.mulberry32(1), 40, true)), 40);
  const before = rep.getResult();
  assert.throws(() => rep.patch([{ tick: 40, a: 'up' }], 40), /tick/);
  assert.throws(() => rep.patch([{ tick: 0, a: 'sideways' }], 40), /非法指令/);
  assert.deepEqual(rep.getResult(), before, '校验失败必须整体回滚，状态不变');
});

// ---------------------------------------------------------------- Worker（真实 worker_threads）
test('Worker 端到端：分批结果与主线程一致，旧代次响应不得覆盖新日志', async (t) => {
  const worker = new Worker(path.join(__dirname, '..', 'replay-worker.js'));
  await new Promise((res, rej) => {
    worker.once('online', res);
    worker.once('error', rej);
  });

  const client = C.createReplayClient((m) => worker.postMessage(m));
  const queue = [];
  let resolver = null;
  worker.on('message', (m) => {
    client.accept(m);
    if (resolver) { const r = resolver; resolver = null; r(m); }
    else queue.push(m);
  });
  const recv = () => queue.length
    ? Promise.resolve(queue.shift())
    : new Promise((r) => { resolver = r; });

  await t.test('Worker 结果（gen1，200 tick）虽被丢弃，其内容仍与完整重放一致', async () => {
    const slots200 = randSlots(C.mulberry32(71), 200, true);
    const slots10 = randSlots(C.mulberry32(72), 10, true);
    client.reset(entriesOf(slots200), 200); // gen 1
    client.reset(entriesOf(slots10), 10);   // gen 2，立刻使 gen1 过期
    const stale = await recv();
    assert.equal(stale.gen, 1);
    assert.equal(stale.type, 'update');
    assert.deepEqual(stale.frames, full(slots200, 200).frames);
    assert.equal(client.result.length, 0, '旧代次结果不得覆盖画面');
    assert.equal(client.dropped, 1);

    const fresh = await recv();
    assert.equal(fresh.gen, 2);
    assert.equal(client.result.length, 10);
    assert.deepEqual(client.result, full(slots10, 10));
  });

  await t.test('通过 Worker 分批追加 50→140→300，每一前缀都等于完整重放', async () => {
    const slots = randSlots(C.mulberry32(88), 300, true);
    client.reset(entriesOf(slots.slice(0, 50)), 50);
    await recv();
    assert.deepEqual(client.result, full(slots.slice(0, 50), 50));

    const editsAbs = (a, b) => {
      const out = [];
      for (let t = a; t < b; t++) if (slots[t]) out.push(Object.assign({ tick: t }, slots[t]));
      return out;
    };
    client.patch(editsAbs(50, 140), 140);
    await recv();
    assert.deepEqual(client.result.frames, full(slots.slice(0, 140), 140).frames);

    client.patch(editsAbs(140, 300), 300);
    await recv();
    assert.deepEqual(client.result, full(slots, 300));
  });

  await t.test('Worker 中追补 tick 0/123/299 后等于从头重放；连续 patch 旧响应被丢弃', async () => {
    const slots = randSlots(C.mulberry32(88), 300, true);
    client.patch([{ tick: 0, a: 'up' }], 300); // gen N
    slots[0] = { a: 'up', b: slots[0].b };
    client.patch([{ tick: 123, b: 'down' }], 300); // gen N+1，使上一请求过期
    slots[123] = { a: slots[123].a, b: 'down' };
    const stale = await recv();
    assert.equal(stale.type, 'update');
    assert.equal(client.dropped >= 2, true);
    const ok = await recv();
    assert.equal(ok.length, 300);
    assert.deepEqual(client.result, full(slots, 300));

    // 错误以 error 消息返回，不更新结果
    const lenBefore = client.result.length;
    client.reset([], 99999);
    const err = await recv();
    assert.equal(err.type, 'error');
    assert.equal(client.result.length, lenBefore);
  });

  await worker.terminate();
});
