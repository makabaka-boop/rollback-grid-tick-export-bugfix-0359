/*!
 * replay-core.js — 确定性 12×12 双人格点回放内核（UMD，零依赖）
 *
 * 同一份权威实现运行于：浏览器主线程、Blob/Worker、Node（测试）。
 * 裁决规则（与指令到达顺序无关，只与最终日志内容有关）：
 *   1. 先分别独立计算两人的“尝试位置”（撞墙/越界则留在原位并记 wall 事件）；
 *   2. 两人尝试位置相同（同格相遇，含一方撞向停留中的另一方）→ 双方都退回原位；
 *   3. 两人尝试位置恰好互换（swap）→ 双方都退回原位；
 *   4. 其余位置生效；追尾串行使（前车驶离，后车进入）；
 *   5. 在最终位置上按 A 先 B 后结算一次性拾取物（同格不可能同时到达）。
 *
 * 检查点：tick 0,10,20,… 保存帧快照。补录/改动 t 时，从 floor(t/10)*10
 * 的检查点恢复并重算其后的全部帧，摘要逐帧重新生成，而非只改当前画面。
 */
(function (root, factory) {
  const api = factory();
  api.FACTORY = factory; // 页面可把工厂序列化进 Blob Worker，保证仍是同一份代码
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root === 'object' && root) root.ReplayCore = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const GRID = 12;
  const MAX_TICKS = 300;
  const CHECKPOINT_EVERY = 10;
  const PICKUP_VALUE = 1;

  const DIR_VECTORS = {
    up: { dx: 0, dy: -1 },
    down: { dx: 0, dy: 1 },
    left: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 },
    stay: { dx: 0, dy: 0 }
  };
  const DIR_NAMES = ['up', 'down', 'left', 'right', 'stay'];
  const DIR_CN = { up: '上', down: '下', left: '左', right: '右', stay: '停留' };

  // 固定墙体：先写一半，再做 180° 镜像，保证布局中心对称
  const WALLS = (function () {
    const half = [
      [2, 2], [3, 2], [2, 3],
      [5, 3], [6, 3],
      [3, 5], [3, 6],
      [8, 2], [9, 3],
      [5, 5]
    ];
    const s = new Set();
    const add = (x, y) => {
      if (x >= 0 && y >= 0 && x < GRID && y < GRID) s.add(x + ',' + y);
    };
    for (const [x, y] of half) {
      add(x, y);
      add(GRID - 1 - x, GRID - 1 - y);
    }
    for (const [x, y] of [[5, 5], [6, 5], [5, 6], [6, 6]]) add(x, y); // 中央 2×2
    return s;
  })();

  // 固定的一次性拾取物（不与墙体/出生点重叠），180° 成对
  const PICKUP_LIST = [
    [2, 0], [9, 11],
    [0, 2], [11, 9],
    [5, 0], [6, 11],
    [0, 6], [11, 5],
    [2, 11], [9, 0]
  ];
  const PICKUP_SET = new Set(PICKUP_LIST.map(([x, y]) => x + ',' + y));

  const SPAWN_A = { x: 0, y: 0 };
  const SPAWN_B = { x: GRID - 1, y: GRID - 1 };

  const key = (x, y) => x + ',' + y;

  function makeInitialFrame() {
    return {
      tick: 0,
      a: { x: SPAWN_A.x, y: SPAWN_A.y },
      b: { x: SPAWN_B.x, y: SPAWN_B.y },
      scoreA: 0,
      scoreB: 0,
      collected: {}, // "x,y" -> 拾取发生的 tick
      events: []
    };
  }

  /** 独立计算某一名角色的尝试位置；撞墙/越界（仅对真实移动指令）则原地不动。 */
  function attempt(pos, dir) {
    const v = DIR_VECTORS[dir] || DIR_VECTORS.stay;
    const nx = pos.x + v.dx;
    const ny = pos.y + v.dy;
    const moving = dir === 'up' || dir === 'down' || dir === 'left' || dir === 'right';
    if (moving && (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID || WALLS.has(key(nx, ny)))) {
      return { x: pos.x, y: pos.y, blocked: true };
    }
    return { x: nx, y: ny, blocked: false };
  }

  /**
   * 由上一帧与双方指令推进一帧。纯函数：同输入必同输出，
   * 不读取提交顺序、时间戳或任何外部状态。
   */
  function stepFrame(prev, cmdA, cmdB) {
    cmdA = DIR_VECTORS[cmdA] ? cmdA : 'stay';
    cmdB = DIR_VECTORS[cmdB] ? cmdB : 'stay';

    const ta = attempt(prev.a, cmdA);
    const tb = attempt(prev.b, cmdB);

    const events = [];
    if (ta.blocked) events.push({ type: 'wall', who: 'A' });
    if (tb.blocked) events.push({ type: 'wall', who: 'B' });

    let ax = ta.x, ay = ta.y, bx = tb.x, by = tb.y;

    const sameTarget = ax === bx && ay === by;
    const swap =
      !sameTarget &&
      ax === prev.b.x && ay === prev.b.y &&
      bx === prev.a.x && by === prev.a.y;

    if (sameTarget || swap) {
      // 同格相遇或位置互换：裁决固定为双方退回，与谁先到达无关
      events.push({ type: swap ? 'swap_blocked' : 'meet_blocked' });
      ax = prev.a.x; ay = prev.a.y;
      bx = prev.b.x; by = prev.b.y;
    }

    const collected = Object.assign({}, prev.collected);
    let scoreA = prev.scoreA;
    let scoreB = prev.scoreB;

    const grab = (x, y, who) => {
      const k = key(x, y);
      if (PICKUP_SET.has(k) && !Object.prototype.hasOwnProperty.call(collected, k)) {
        collected[k] = prev.tick + 1;
        if (who === 'A') scoreA += PICKUP_VALUE;
        else scoreB += PICKUP_VALUE;
        events.push({ type: 'pickup', who: who, x: x, y: y, value: PICKUP_VALUE });
      }
    };
    grab(ax, ay, 'A');
    grab(bx, by, 'B');

    return {
      tick: prev.tick + 1,
      a: { x: ax, y: ay },
      b: { x: bx, y: by },
      scoreA: scoreA,
      scoreB: scoreB,
      collected: collected,
      events: events
    };
  }

  function validateLength(length) {
    if (!Number.isInteger(length) || length < 0 || length > MAX_TICKS) {
      throw new Error('length 必须是 0..' + MAX_TICKS + ' 的整数，收到: ' + length);
    }
    return length;
  }

  function validateTick(t, length) {
    if (!Number.isInteger(t) || t < 0 || t >= length) {
      throw new Error('tick 必须位于 [0,' + (length - 1) + ']，收到: ' + t);
    }
  }

  function validateDir(d) {
    if (!DIR_VECTORS[d]) throw new Error('非法指令: ' + d);
  }

  function cloneFrame(f) {
    return JSON.parse(JSON.stringify(f));
  }

  /**
   * 有状态回放器：持有指令日志、全部帧与每 10 tick 一个检查点。
   * reset  = 全新日志重算；
   * patch  = 补录/修改/删除/追加/缩短，从最近的不受影响检查点继续。
   */
  class Replayer {
    constructor() {
      this.cmds = new Map(); // tick -> {a?: dir, b?: dir}，缺省即 stay
      this.frames = [makeInitialFrame()];
      this.checkpoints = [this.frames[0]]; // tick 为 CHECKPOINT_EVERY 倍数的帧
      this.length = 0;
    }

    _loadEntry(slot0, e, length, allowClear) {
      validateTick(e.tick, length);
      const pairs = [];
      if (e.who !== undefined) pairs.push([e.who, e.dir]);
      if (e.a !== undefined) pairs.push(['a', e.a]);
      if (e.b !== undefined) pairs.push(['b', e.b]);
      const slot = slot0 || {};
      for (const [who, raw] of pairs) {
        if (who !== 'a' && who !== 'b') throw new Error('who 必须是 a/b: ' + who);
        if (raw === null || raw === undefined) {
          if (allowClear) delete slot[who];
          continue;
        }
        validateDir(raw);
        slot[who] = raw;
      }
      return slot;
    }

    reset(entries, length) {
      length = validateLength(length);
      const cmds = new Map();
      const list = entries instanceof Map
        ? Array.from(entries.entries()).map(([tick, v]) => Object.assign({ tick: tick }, v))
        : (entries || []);
      for (const e of list) {
        const slot = this._loadEntry(cmds.get(e.tick), e, length, false);
        if (slot.a !== undefined || slot.b !== undefined) cmds.set(e.tick, slot);
      }
      this.cmds = cmds;
      this.frames = [makeInitialFrame()];
      this.checkpoints = [this.frames[0]];
      this.length = 0;
      this._simulate(length);
    }

    /**
     * @param edits  [{tick,a?,b?}]（字段给 null/缺省=清除；只给其一也行）
     *               或 [{tick, who:'a'|'b', dir|null}]
     * @param length 新的已提交 tick 数；省略表示不变。可缩短日志。
     * 校验失败时整体抛出且不改动现有状态。
     */
    patch(edits, length) {
      const oldLength = this.length;
      const newLength = length === undefined ? oldLength : validateLength(length);
      if (!Array.isArray(edits)) edits = [];

      // 1) 先校验并归并（同一 tick 的多条编辑按数组顺序覆盖），全部合法才落盘
      const changes = new Map();
      for (const e of edits) {
        validateTick(e.tick, newLength);
        const pairs = [];
        if (e.who !== undefined) pairs.push([e.who, e.dir]);
        if (e.a !== undefined) pairs.push(['a', e.a]);
        if (e.b !== undefined) pairs.push(['b', e.b]);
        for (const [who, raw] of pairs) {
          if (who !== 'a' && who !== 'b') throw new Error('who 必须是 a/b: ' + who);
          const val = raw === null || raw === undefined ? null : raw;
          if (val !== null) validateDir(val);
          if (!changes.has(e.tick)) changes.set(e.tick, {});
          changes.get(e.tick)[who] = val;
        }
      }

      // 2) 找出最早的实际变动 tick（追加/缩短同样影响一段区间）
      let dirtyMin = Infinity;
      for (const [t, chg] of changes) {
        const cur = this.cmds.get(t) || {};
        for (const who of ['a', 'b']) {
          if (!(who in chg)) continue;
          const want = chg[who] === null ? undefined : chg[who];
          if (cur[who] !== want) dirtyMin = Math.min(dirtyMin, t);
        }
      }
      if (newLength > oldLength) dirtyMin = Math.min(dirtyMin, oldLength);
      if (newLength < oldLength) dirtyMin = Math.min(dirtyMin, newLength);

      // 3) 应用编辑并清理越界 tick
      for (const [t, chg] of changes) {
        const slot = this.cmds.get(t) || {};
        for (const who of ['a', 'b']) {
          if (!(who in chg)) continue;
          if (chg[who] === null) delete slot[who];
          else slot[who] = chg[who];
        }
        if (slot.a !== undefined || slot.b !== undefined) this.cmds.set(t, slot);
        else this.cmds.delete(t);
      }
      if (newLength < oldLength) {
        for (const t of Array.from(this.cmds.keys())) {
          if (t >= newLength) this.cmds.delete(t);
        }
      }

      // 4) 从最近的不受影响检查点恢复；无变动则什么都不重算
      let base;
      if (dirtyMin === Infinity) {
        base = newLength;
      } else {
        base = Math.floor(Math.min(dirtyMin, newLength) / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
        if (base > oldLength) base = Math.floor(oldLength / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
      }
      if (base < 0 || base > oldLength) base = 0;

      if (base < this.frames.length) {
        const cp = this.checkpoints.filter((c) => c.tick <= base);
        const anchor = cp[cp.length - 1];
        if (!anchor || anchor.tick !== base) {
          throw new Error('缺少 tick=' + base + ' 的检查点（内部错误）');
        }
        this.checkpoints = cp;
        this.frames.length = base + 1;
        this.frames[base] = anchor;
        this.length = base;
      }
      this._simulate(newLength);
    }

    _simulate(target) {
      while (this.length < target) {
        const t = this.length;
        const c = this.cmds.get(t) || {};
        const f = stepFrame(this.frames[t], c.a, c.b);
        this.frames.push(f);
        this.length = t + 1;
        if (this.length % CHECKPOINT_EVERY === 0) this.checkpoints.push(f);
      }
    }

    getFramesSnapshot() {
      return this.frames.map(cloneFrame);
    }

    getResult() {
      return { frames: this.getFramesSnapshot(), length: this.length };
    }
  }

  /** 从头完整重放（测试参照实现）。 */
  function replayFrames(entries, length) {
    const r = new Replayer();
    r.reset(entries, length);
    return r.getResult();
  }

  /** 确定性 PRNG（测试与演示用，保证可复现）。 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 把一个端口变成回放 Worker。
   * 浏览器：serveWorker(self)（addEventListener）
   * Node：serveWorker(parentPort)（worker_threads 的 EventEmitter）
   *
   * 协议（主 -> Worker）:
   *   {id, gen, type:'reset', entries, length}
   *   {id, gen, type:'patch', edits, length}
   * 协议（Worker -> 主）:
   *   {type:'update', id, gen, frames, length}
   *   {type:'error',  id, gen, message}
   */
  function serveWorker(port) {
    const rep = new Replayer();
    const send = (m) => port.postMessage(m);
    const handle = (data) => {
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'reset' && data.type !== 'patch') return;
      try {
        if (data.type === 'reset') rep.reset(data.entries, data.length);
        else rep.patch(data.edits, data.length);
        const out = rep.getResult();
        send({ type: 'update', id: data.id, gen: data.gen, frames: out.frames, length: out.length });
      } catch (err) {
        send({ type: 'error', id: data.id, gen: data.gen, message: String((err && err.message) || err) });
      }
    };
    if (typeof port.addEventListener === 'function') {
      port.addEventListener('message', (ev) => handle(ev.data));
    } else {
      port.on('message', (data) => handle(data));
    }
    return rep;
  }

  /**
   * 主线程侧客户端：代次（gen）单调递增，只接受“当前最新一代”的结果，
   * 旧 gen 的 Worker 响应（即使延迟到达）一律丢弃，绝不覆盖新日志的画面。
   * busy 标记“最新一代请求是否仍在途”：在途时 result.frames 可能落后于
   * 已提交日志，需要版本一致的操作（导出）必须等 busy 解除。
   * 播放 / 单步 / 跳转 / 导出全部读取这里持有的同一份 result。
   */
  function createReplayClient(post) {
    let seq = 0;
    const client = {
      gen: 0,
      lastSentGen: 0,
      // 是否有一代请求尚在途（Worker 尚未对“最新一代”给出 update/error）。
      // 在途期间 frames 可能落后于调用方已提交的日志，导出等需要版本一致的操作应等待。
      busy: false,
      dropped: 0,
      errors: 0,
      result: { frames: [makeInitialFrame()], length: 0 },
      _send(msg) {
        msg.id = ++seq;
        this.lastSentGen = msg.gen;
        this.busy = true;
        post(msg);
        return msg.id;
      },
      reset(entries, length) {
        const gen = ++this.gen;
        return this._send({ type: 'reset', gen: gen, entries: entries, length: length });
      },
      patch(edits, length) {
        const gen = ++this.gen;
        return this._send({ type: 'patch', gen: gen, edits: edits, length: length });
      },
      /** @returns {boolean} 是否被接受；false 表示旧代次/无关消息，已丢弃 */
      accept(msg) {
        if (!msg || typeof msg !== 'object') return false;
        // 只有“最新一代”的终结消息（update 或 error）能解除 busy；
        // 旧代次的迟到回复不改变状态，busy 仍属于更新的在途代次。
        if (msg.gen === this.lastSentGen) this.busy = false;
        if (msg.type === 'error') {
          this.errors++;
          return false;
        }
        if (msg.type === 'update' && msg.gen === this.lastSentGen) {
          this.result = { frames: msg.frames, length: msg.length };
          return true;
        }
        this.dropped++;
        return false;
      }
    };
    return client;
  }

  return {
    GRID: GRID,
    MAX_TICKS: MAX_TICKS,
    CHECKPOINT_EVERY: CHECKPOINT_EVERY,
    PICKUP_VALUE: PICKUP_VALUE,
    DIR_NAMES: DIR_NAMES,
    DIR_CN: DIR_CN,
    WALLS: WALLS,
    PICKUP_LIST: PICKUP_LIST,
    SPAWN_A: SPAWN_A,
    SPAWN_B: SPAWN_B,
    makeInitialFrame: makeInitialFrame,
    stepFrame: stepFrame,
    Replayer: Replayer,
    replayFrames: replayFrames,
    serveWorker: serveWorker,
    createReplayClient: createReplayClient,
    mulberry32: mulberry32
  };
});
