/* ============================================================================
 * 智感云联 v2 · core.js  —— 数据层 / 通信层 / 设备域
 * ----------------------------------------------------------------------------
 * 设计约束（为了能原样搬进 uni-app）：
 *   1. 本文件【零 DOM 依赖】，只做 state / IO / 业务规则。
 *   2. 全部通过 App.xxx 挂载，等价于 Pinia 的一个 module。
 *   3. 状态变更统一走 store.set()，UI 只订阅、不反查 DOM。
 * ==========================================================================*/
(function (global) {
  'use strict';

  const App = (global.App = global.App || {});

  /* ---------------------------------------------------------------- utils */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now();
  const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const pad2 = (n) => String(n).padStart(2, '0');
  const hhmmss = (ts) => {
    const d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  };

  /* --------------------------------------------------------------- CONFIG */
  const CONFIG = {
    // ⚠️ 联调真机时：改成 false，并把 BASE_URL 换成 Flask 地址（建议走 /api 网关代理避开 CORS）
    USE_MOCK: true,
    BASE_URL: 'http://127.0.0.1:5000',
    SAMPLE_MS: 1000,          // 遥测采样周期（真机建议后端聚合到 1~2s，不要 100ms 直推）
    HISTORY_LEN: 120,         // 前端环形缓冲长度
    TIMEOUT_MS: 6000,         // 普通请求超时
    ACK_TIMEOUT_MS: 7000,     // 指令回执超时（物联网写操作必须比读操作更宽松）
    RELAY_COOLDOWN_MS: 8000,  // 继电器冷却：两次动作最小间隔，防频繁启停烧触点
    MAX_RUN_SEC: 300,         // 单次最长运行，超时强制断电
    OFFLINE_GAP_MS: 5000,     // 5s 没收到任何遥测 → 判定链路断开
  };
  App.CONFIG = CONFIG;

  /* ------------------------------------------------------------- ApiError */
  class ApiError extends Error {
    constructor(message, code, detail) {
      super(message);
      this.name = 'ApiError';
      this.code = code || 'ERROR';
      this.detail = detail || null;
    }
  }
  App.ApiError = ApiError;

  /* ----------------------------------------------------------------- store */
  function createStore(initial) {
    let state = initial;
    const subs = new Set();
    let scheduled = false;

    function flush() {
      scheduled = false;
      // 快照遍历：订阅回调里再次 set() 也不会漏掉本轮新增订阅
      Array.from(subs).forEach((fn) => {
        try { fn(state); } catch (e) { console.error('[store] subscriber error', e); }
      });
    }

    /**
     * 一帧内合并所有渲染。
     * ⚠️ 关键坑：rAF 在"后台标签页 / 无绘制环境"下会被暂停甚至永不触发。
     *    如果只用 rAF，scheduled 会永远停在 true，此后整个 UI 再也不刷新（本文件
     *    的第一版就踩了这个坑）。所以必须有一个 setTimeout 兜底。
     */
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      let fired = false;
      const run = () => { if (fired) return; fired = true; flush(); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      setTimeout(run, 60);
    }

    return {
      get state() { return state; },
      set(patch) {
        state = Object.assign({}, state, patch);
        schedule();
      },
      subscribe(fn, immediate) {
        subs.add(fn);
        // 首帧渲染也要隔离异常：一个渲染函数写错，不能连坐整个 boot 流程
        if (immediate !== false) {
          try { fn(state); } catch (e) { console.error('[store] immediate subscriber error', e); }
        }
        return () => subs.delete(fn);
      },
    };
  }

  /* ------------------------------------------------------------- event bus */
  const bus = (() => {
    const map = new Map();
    return {
      on(evt, fn) {
        if (!map.has(evt)) map.set(evt, new Set());
        map.get(evt).add(fn);
        return () => map.get(evt).delete(fn);   // 返回 off()，必须被调用，否则就是内存泄漏
      },
      emit(evt, payload) {
        const set = map.get(evt);
        if (set) Array.from(set).forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } });
      },
    };
  })();

  /* ------------------------------------------------------------- 业务常量 */
  const Metrics = {
    temp:  { key: 'temp',  label: '空气温度', unit: '℃',   min: 0, max: 45,    safe: [18, 30],       digits: 1 },
    humi:  { key: 'humi',  label: '空气湿度', unit: '%RH', min: 0, max: 100,   safe: [55, 80],       digits: 1 },
    soil:  { key: 'soil',  label: '土壤水分', unit: '%',   min: 0, max: 100,   safe: [22, 60],       digits: 1 },
    light: { key: 'light', label: '光照强度', unit: 'lx',  min: 0, max: 60000, safe: [8000, 50000],  digits: 0, group: true },
  };

  const PLOTS = {
    A: { key: 'A', name: '1号棚 · 番茄', planted: '2026-09-05', soilInit: 26.4, tempBase: 17 },
    B: { key: 'B', name: '2号棚 · 草莓', planted: '2026-10-02', soilInit: 41.0, tempBase: 15 },
  };

  const STAGES = [
    { name: '育苗期',     from: 0,  to: 14, tip: '保持基质湿润，昼夜温差控制在 8℃ 以内，避免徒长。' },
    { name: '幼苗期',     from: 15, to: 29, tip: '适当控水促根，土壤水分维持 20%–28%，光照逐步加强。' },
    { name: '旺盛生长期', from: 30, to: 54, tip: '水肥需求高峰，土壤水分建议 25%–35%，缺水 2 小时内必须补水。' },
    { name: '开花坐果期', from: 55, to: 79, tip: '避免大水漫灌，空气湿度维持在 60% 上下，防止落花。' },
    { name: '成熟采收期', from: 80, to: 99, tip: '采前 7 天减水，可提升糖度与耐储性。' },
  ];

  function stageOf(key) {
    const p = PLOTS[key] || PLOTS.A;
    const t0 = new Date(p.planted + 'T08:00:00').getTime();
    const days = Math.max(1, Math.floor((now() - t0) / 86400000));
    let idx = STAGES.findIndex((s) => days >= s.from && days <= s.to);
    if (idx < 0) idx = days < 0 ? 0 : STAGES.length - 1;
    return { days, index: idx, stage: STAGES[idx], plot: p };
  }

  /* -------------------------------------------------------------- 初始状态 */
  const store = createStore({
    plot: 'A',
    sensors: { ts: 0, temp: 0, humi: 0, soil: 0, light: 0 },
    history: [],
    link: { online: true, lastSeenAt: now(), gap: 0, rtt: 0, simOffline: false },
    shadow: { power: false, ts: 0, source: 'init' },
    cmd: null,
    alerts: [],
    audit: [],
    rules: [
      { id: 'r1', name: '干旱自动灌溉', desc: '土壤水分 < 22% 且处于白天 → 自动补水 120s', enabled: true, lastFire: 0, cooldown: 180000 },
      { id: 'r2', name: '高温停灌保护', desc: '气温 > 33℃ 时拦截一切灌溉指令（防烫根）', enabled: true, lastFire: 0 },
      { id: 'r3', name: '夜间静默', desc: '22:00–06:00 不自动执行，只推送告警', enabled: true, lastFire: 0 },
      { id: 'r4', name: '超时断电保护', desc: '单次运行 > 5min 强制断开继电器', enabled: true, lastFire: 0 },
    ],
    stage: null,
    stats: { pumpSec: 0, waterL: 0, energyWh: 0, runs: 0 },
    voice: true,
    ai: { status: 'idle' },
  });
  store.set({ stage: stageOf('A') });

  /* ------------------------------------------------------------ HTTP 层 */
  async function request(path, opt) {
    opt = opt || {};
    const method = opt.method || 'GET';
    const timeout = opt.timeout || CONFIG.TIMEOUT_MS;
    const retry = opt.retry || 0;

    if (CONFIG.USE_MOCK) return Mock.handle(path, { method, body: opt.body });

    let lastErr = null;
    for (let attempt = 0; attempt <= retry; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);   // 网络超时兜底，否则 fetch 可能永久挂起
      const t0 = performance.now();
      try {
        const res = await fetch(CONFIG.BASE_URL + path, {
          method,
          signal: ctrl.signal,
          headers: opt.body ? { 'Content-Type': 'application/json' } : undefined,
          body: opt.body ? JSON.stringify(opt.body) : undefined,
          credentials: 'include',                             // 后端必须回 Access-Control-Allow-Credentials
        });
        store.set({ link: Object.assign({}, store.state.link, { rtt: Math.round(performance.now() - t0) }) });
        if (!res.ok) throw new ApiError('HTTP ' + res.status, 'HTTP_' + res.status);
        const json = await res.json();
        if (json.code !== 0 && json.code !== 200) throw new ApiError(json.msg || '业务异常', json.code);
        return json.data;
      } catch (e) {
        lastErr = e.name === 'AbortError' ? new ApiError('请求超时（' + timeout + 'ms）', 'TIMEOUT') : e;
        // 写操作（POST）超时不重试：可能导致继电器二次动作，宁可由上层提示人工确认
        if (e.name === 'AbortError' || method !== 'GET') break;
        if (attempt < retry) await sleep(300 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  const api = {
    get: (p, o) => request(p, Object.assign({ method: 'GET' }, o)),
    post: (p, body, o) => request(p, Object.assign({ method: 'POST', body: body }, o)),
  };
  App.api = api;

  /* ------------------------------------------------------- 硬件模拟器 */
  // 不是纯随机数：带蒸发/补水/日照曲线的物理近似，数字"讲得通"，
  // 评委问"为什么土壤会掉"你能解释。演示环境做了加速。
  const Sim = {
    mode: 'normal',      // normal | offline | noack
    pumpOn: false,
    plot: 'A',
    soil: 26.4, temp: 26, humi: 70, light: 0,
    dropRate: 0.012,     // 遥测丢包率
    timer: null,
    reset(key) {
      const p = PLOTS[key] || PLOTS.A;
      this.plot = p.key;
      this.soil = p.soilInit;
      this.temp = p.tempBase + 8;
      this.humi = 72;
      this.light = 12000;
      this.pumpOn = false;
    },
    tick() {
      if (this.mode === 'offline') return null;
      if (Math.random() < this.dropRate) return null;

      const d = new Date();
      const h = d.getHours() + d.getMinutes() / 60;
      const sun = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));  // 06:00–18:00 日照曲线
      const noise = Math.random() - 0.5;

      this.light = clamp(sun * 48000 + noise * 1600 + 400, 0, 62000);
      this.temp = clamp(PLOTS[this.plot].tempBase + 11 * sun + noise * 0.6, 5, 45);
      this.humi = clamp(88 - 32 * sun + noise * 1.2, 20, 99);

      const evap = (this.temp / 25) * 0.05 + sun * 0.06;   // 蒸发
      const intake = this.pumpOn ? 0.42 : 0;               // 补水（演示加速）
      this.soil = clamp(this.soil - evap + intake + noise * 0.05, 0, 100);

      return {
        ts: now(),
        temp: +this.temp.toFixed(1),
        humi: +this.humi.toFixed(1),
        soil: +this.soil.toFixed(1),
        light: Math.round(this.light),
      };
    },
    start() { if (!this.timer) this.timer = setInterval(() => { const f = Sim.tick(); if (f) ingest(f); }, CONFIG.SAMPLE_MS); },
    stop() { clearInterval(this.timer); this.timer = null; },
  };

  /* --------------------------------------------------------- 告警中心 */
  const AlertCenter = {
    add(opt) {
      const list = store.state.alerts;
      const exist = list.find((a) => a.key === opt.key && a.status === 'active');
      if (exist) {
        // 同一类告警只更新描述，不重复刷屏
        exist.desc = opt.desc;
        exist.ts = now();
        store.set({ alerts: list.slice() });
        return exist;
      }
      const item = {
        id: uid('al'), key: opt.key, level: opt.level || 'warn',
        title: opt.title, desc: opt.desc,
        status: 'active', ts: now(), action: opt.action || '',
        value: opt.value == null ? null : opt.value,
      };
      store.set({ alerts: [item].concat(list) });
      if (item.level === 'critical') bus.emit('alert:critical', item);  // 交给 UI 做声光/语音
      return item;
    },
    resolve(key, note) {
      // 只有真的存在 active 项才写 state，否则每秒一次的心跳会把整张告警列表重渲染
      if (!store.state.alerts.some((a) => a.key === key && a.status === 'active')) return;
      const list = store.state.alerts.map((a) =>
        a.key === key && a.status === 'active'
          ? Object.assign({}, a, { status: 'resolved', resolvedAt: now(), note: note || '' })
          : a);
      store.set({ alerts: list });
    },
    ack(id) {
      const list = store.state.alerts.map((a) =>
        a.id === id ? Object.assign({}, a, { status: 'acked', ackedAt: now() }) : a);
      store.set({ alerts: list });
    },
    activeCount() { return store.state.alerts.filter((a) => a.status === 'active').length; },
    /** 根据遥测做阈值判定（心跳式，不在渲染里做） */
    evaluate(s, online) {
      if (!online) return;
      if (s.soil < 22) {
        AlertCenter.add({
          key: 'drought', level: 'critical',
          title: '土壤极度干旱',
          desc: '当前 ' + s.soil.toFixed(1) + '%，低于安全阈值 22%，作物根系已进入缺水胁迫。建议立即灌溉。',
          value: s.soil, action: 'irrigate',
        });
      } else if (s.soil > 22 && s.soil < 26) {
        AlertCenter.add({ key: 'drought-warn', level: 'warn', title: '土壤水分偏低', desc: '当前 ' + s.soil.toFixed(1) + '%，接近阈值下限，建议在 2 小时内补水。', value: s.soil });
      } else {
        AlertCenter.resolve('drought', '水分已恢复');
        AlertCenter.resolve('drought-warn', '水分已恢复');
      }
      if (s.temp > 34) {
        AlertCenter.add({ key: 'heat', level: 'warn', title: '高温胁迫', desc: '气温 ' + s.temp.toFixed(1) + '℃，已触发高温停灌保护，请开启通风。', value: s.temp });
      } else {
        AlertCenter.resolve('heat', '温度回落');
      }
    },
    /** 指令流水写入审计 */
    log(cmd) {
      const row = {
        id: cmd.id, ts: cmd.ts, action: cmd.action, state: cmd.state,
        source: cmd.source, latency: cmd.latency || 0, error: cmd.error || '',
      };
      const list = [row].concat(store.state.audit).slice(0, 40);
      store.set({ audit: list });
    },
  };

  /* ------------------------------------------------------------ 设备域 */
  const setShadow = (function () {
    return function (next) {
      const prev = store.state.shadow;
      const merged = Object.assign({}, prev, next, { source: next.source || 'device' });
      if (merged.power && !prev.power) {
        App.Device.runStartedAt = now();
        const st = Object.assign({}, store.state.stats); st.runs += 1;
        store.set({ stats: st });
      }
      if (!merged.power) App.Device.runStartedAt = 0;
      store.set({ shadow: merged });
      bus.emit('shadow', merged);     // 先改 state 再广播，订阅方读到的永远是新值
    };
  })();

  const Device = {
    runStartedAt: 0,
    cooldownUntil: 0,

    canCommand() {
      const s = store.state;
      if (!s.link.online) return { ok: false, msg: '链路中断，指令已被安全拦截' };
      if (s.cmd && s.cmd.state === 'pending') return { ok: false, msg: '上一条指令仍在执行中' };
      if (now() < Device.cooldownUntil) return { ok: false, msg: '继电器冷却中，' + Math.ceil((Device.cooldownUntil - now()) / 1000) + 's 后可再次操作' };
      return { ok: true };
    },

    /**
     * 悲观确认模型：UI 在收到设备回执前【不】把状态改成"运行中"。
     * 这是继电器类设备唯一正确的做法——乐观更新会让农户误以为水已经在浇。
     */
    async command(action, meta) {
      meta = meta || {};
      const want = action === 'on';
      const s = store.state;

      if (s.shadow.power === want) throw new ApiError('设备已处于该状态', 'NOOP');
      const gate = Device.canCommand();
      if (!gate.ok) throw new ApiError(gate.msg, 'BLOCKED');

      const cmd = {
        id: uid('cmd'), action: want ? 'on' : 'off', ts: now(), step: 1,
        state: 'pending', source: meta.auto ? '自动策略' : (meta.source || '手动'),
        durationSec: meta.durationSec || 0, error: '', latency: 0,
      };
      store.set({ cmd: cmd });
      bus.emit('cmd:update', cmd);
      const t0 = performance.now();

      try {
        await api.post('/api/device/pump', { cmdId: cmd.id, action: cmd.action, durationSec: cmd.durationSec }, { timeout: CONFIG.TIMEOUT_MS });
        cmd.step = 2;
        store.set({ cmd: Object.assign({}, cmd) });
        bus.emit('cmd:update', cmd);

        await Device.waitAck(want, CONFIG.ACK_TIMEOUT_MS);

        cmd.step = 4; cmd.state = 'acked'; cmd.latency = Math.round(performance.now() - t0);
        store.set({ cmd: Object.assign({}, cmd) });
        bus.emit('cmd:update', cmd);
        AlertCenter.log(cmd);
        if (want && !meta.auto) AlertCenter.resolve('drought', '已手动开启灌溉');
        return true;
      } catch (e) {
        cmd.state = e.code === 'ACK_TIMEOUT' ? 'timeout' : 'failed';
        cmd.error = e.message || '未知错误';
        cmd.latency = Math.round(performance.now() - t0);
        // 保留 cmd.step，让 UI 能精确标出"卡在哪一步"
        store.set({ cmd: Object.assign({}, cmd) });
        bus.emit('cmd:update', cmd);
        AlertCenter.log(cmd);
        if (e.code === 'ACK_TIMEOUT') {
          // 回执超时 = 状态未知，必须要求人工到现场确认，不能假设成功或失败
          AlertCenter.add({
            key: 'ack-timeout', level: 'critical',
            title: '指令回执超时，设备状态未知',
            desc: '指令 ' + cmd.id + ' 已下发 7 秒未收到设备回执，继电器可能已动作或未动作。请到现场确认后手动刷新设备影子。',
          });
        }
        throw e;
      } finally {
        Device.cooldownUntil = now() + CONFIG.RELAY_COOLDOWN_MS;
      }
    },

    waitAck(want, ms) {
      return new Promise((resolve, reject) => {
        let done = false;
        const off = bus.on('shadow', (sh) => {
          if (!!sh.power === want && !done) { done = true; cleanup(); resolve(sh); }
        });
        const timer = setTimeout(() => {
          if (done) return;
          done = true; cleanup();
          reject(new ApiError('设备回执超时', 'ACK_TIMEOUT'));
        }, ms);
        function cleanup() { off(); clearTimeout(timer); }   // ★ 必须双清，否则监听器常驻
      });
    },

    /** 紧急停止：跳过所有业务校验，直接断电 */
    async estop() {
      if (!store.state.link.online) throw new ApiError('链路中断，无法远距离断电', 'OFFLINE');
      const id = uid('cmd');
      store.set({ cmd: { id: id, action: 'off', ts: now(), step: 1, state: 'pending', source: '紧急停止', durationSec: 0, error: '', latency: 0 } });
      try {
        await api.post('/api/device/pump', { cmdId: id, action: 'off', priority: 'urgent' });
        await Device.waitAck(false, 3000);
        AlertCenter.add({ key: 'estop', level: 'ok', title: '已执行紧急停止', desc: '继电器已断开。请排查触发原因后再恢复自动化策略。' });
      } catch (e) {
        AlertCenter.add({ key: 'estop', level: 'critical', title: '紧急停止失败', desc: e.message + '。请立即到现场手动断电！' });
        throw e;
      } finally {
        Device.cooldownUntil = now() + 3000;
      }
    },
  };
  App.Device = Device;
  App.setShadow = setShadow;

  /* ------------------------------------------------------- 规则引擎 */
  const Rules = {
    _lastGuardOff: 0,   // 保护性断电的节流，防止"断电失败 → 每秒重试 → 刷屏审计"
    toggle(id) {
      const list = store.state.rules.map((r) => r.id === id ? Object.assign({}, r, { enabled: !r.enabled }) : r);
      store.set({ rules: list });
    },
    isOn(id) { const r = store.state.rules.find((x) => x.id === id); return !!(r && r.enabled); },
    evaluate(sensors, shadow, online) {
      if (!online) return;
      const hour = new Date().getHours();
      const st = store.state;

      // r4 超时断电：最高优先级
      if (Rules.isOn('r4') && shadow.power && Device.runStartedAt && now() - Device.runStartedAt > CONFIG.MAX_RUN_SEC * 1000) {
        if (now() - Rules._lastGuardOff > 30000) {
          Rules._lastGuardOff = now();
          Device.command('off', { auto: true, source: '超时保护' }).catch(() => {});
          AlertCenter.add({ key: 'max-run', level: 'warn', title: '触发超时断电', desc: '单次运行已超过 ' + (CONFIG.MAX_RUN_SEC / 60) + ' 分钟，已自动断开继电器。' });
        }
        return;
      }

      // r2 高温 → 停灌
      if (Rules.isOn('r2') && sensors.temp > 33 && shadow.power) {
        if (now() - Rules._lastGuardOff > 30000) {
          Rules._lastGuardOff = now();
          Device.command('off', { auto: true, source: '高温保护' }).catch(() => {});
        }
        return;
      }

      // r1 干旱自动灌溉
      const r1 = st.rules.find((r) => r.id === 'r1');
      if (!r1 || !r1.enabled) return;
      if (shadow.power) return;
      if (now() - (r1.lastFire || 0) < r1.cooldown) return;
      if (Rules.isOn('r3') && (hour >= 22 || hour < 6)) return;   // 夜间静默
      if (sensors.soil < 22 && sensors.soil > 0) {
        const list = st.rules.map((r) => r.id === 'r1' ? Object.assign({}, r, { lastFire: now() }) : r);
        store.set({ rules: list });
        Device.command('on', { auto: true, durationSec: 120 }).catch((e) => {
          console.warn('[rule r1] 自动灌溉未执行:', e.message);
        });
      }
    },
  };
  App.Rules = Rules;
  App.AlertCenter = AlertCenter;

  /* --------------------------------------------- 离线暂存（不自动执行） */
  const LS_KEY = 'scl.pending_intent';
  const Offline = {
    save(action) {
      try { localStorage.setItem(LS_KEY, JSON.stringify({ action: action, ts: now() })); } catch (e) { /* file:// 下可能禁用 */ }
    },
    peek() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (now() - o.ts > 300000) { Offline.clear(); return null; }   // 5 分钟过期，避免"僵尸指令"半夜放水
        return o;
      } catch (e) { return null; }
    },
    clear() { try { localStorage.removeItem(LS_KEY); } catch (e) {} },
  };
  App.Offline = Offline;

  /* --------------------------------------------------- 数据入口 / 心跳 */
  let lastSecond = 0;

  function ingest(frame) {
    const s = store.state;
    const history = s.history.concat([frame]).slice(-CONFIG.HISTORY_LEN);
    store.set({
      sensors: frame,
      history: history,
      link: Object.assign({}, s.link, {
        lastSeenAt: now(), online: true,
        // 真机换成 api 层实测的 RTT；联调前给一个抖动值，方便观察链路质量
        rtt: CONFIG.USE_MOCK ? 32 + Math.round(Math.random() * 58) : s.link.rtt,
      }),
    });
  }

  function heartbeat() {
    const s = store.state;
    const gap = now() - s.link.lastSeenAt;
    // simOffline：演示用的强制断网开关；真机没有这个字段，等价于 false
    const online = !s.link.simOffline && gap < CONFIG.OFFLINE_GAP_MS;

    if (online !== s.link.online) {
      store.set({ link: Object.assign({}, s.link, { online: online, gap: gap }) });
      bus.emit(online ? 'link:up' : 'link:down');
    }

    // 运行时长 / 用水量（只有真在跑才累加，不靠 UI 计时器）
    if (s.shadow.power) {
      const st = Object.assign({}, s.stats);
      st.pumpSec += 1;
      st.waterL = +(st.pumpSec * 0.115).toFixed(2);
      st.energyWh = +(st.pumpSec * 12 / 3600).toFixed(3);
      store.set({ stats: st });
    }

    AlertCenter.evaluate(s.sensors, online);
    if (now() - lastSecond >= 1000) {
      lastSecond = now();
      Rules.evaluate(s.sensors, s.shadow, online);
    }
  }

  /* --------------------------------------------------- 大模型 Payload */
  function aggregate(list) {
    if (!list.length) return { avg: 0, min: 0, max: 0 };
    const sum = list.reduce((a, b) => a + b, 0);
    return {
      avg: +(sum / list.length).toFixed(1),
      min: +Math.min.apply(null, list).toFixed(1),
      max: +Math.max.apply(null, list).toFixed(1),
    };
  }

  function buildPayload(cycleLabel) {
    const s = store.state;
    const h = s.history;
    const st = stageOf(s.plot);
    return {
      plot: st.plot.name,
      stage: st.stage.name + '（第 ' + st.days + ' 天）',
      cycle: cycleLabel || '12小时',
      window: {
        samples: h.length,
        from: h.length ? new Date(h[0].ts).toISOString() : null,
        to: h.length ? new Date(h[h.length - 1].ts).toISOString() : null,
      },
      metrics: {
        temp: aggregate(h.map((x) => x.temp)),
        humi: aggregate(h.map((x) => x.humi)),
        soil: aggregate(h.map((x) => x.soil)),
        light: aggregate(h.map((x) => x.light)),
      },
      thresholds: { soil_safe: Metrics.soil.safe, temp_safe: Metrics.temp.safe, humi_safe: Metrics.humi.safe },
      device: { runs: s.stats.runs, water_l: s.stats.waterL, energy_kwh: +(s.stats.energyWh / 1000).toFixed(4), pump_on: s.shadow.power },
      alerts: s.alerts.filter((a) => a.status !== 'resolved').map((a) => ({ key: a.key, level: a.level, title: a.title })),
    };
  }
  App.buildPayload = buildPayload;

  function buildReport(p) {
    const m = p.metrics;
    const soilLow = m.soil.min < 22;
    return [
      '【智感云联 · 农事诊断报告】',
      '地块：' + p.plot + '　|　生育期：' + p.stage + '　|　周期：' + p.cycle,
      '采样：' + p.window.samples + ' 条（' + p.window.from + ' → ' + p.window.to + '）',
      '',
      '一、环境概况',
      '· 气温 均值 ' + m.temp.avg + '℃（' + m.temp.min + '~' + m.temp.max + '℃），适宜区间 ' + p.thresholds.temp_safe.join('–') + '℃；',
      '· 空气湿度 均值 ' + m.humi.avg + '%RH，适宜区间 ' + p.thresholds.humi_safe.join('–') + '%RH；',
      '· 土壤水分 均值 ' + m.soil.avg + '%，最低 ' + m.soil.min + '%，适宜区间 ' + p.thresholds.soil_safe.join('–') + '%；',
      '· 光照 均值 ' + m.light.avg + 'lx，峰值 ' + m.light.max + 'lx。',
      '',
      '二、风险判断',
      soilLow
        ? '· 【高风险】土壤水分最低触及 ' + m.soil.min + '%，已跌破 22% 的根系吸水临界点。番茄在' + p.stage + '对水分最敏感，持续 2 小时以上会引发落花与脐腐。'
        : '· 土壤水分全程处于安全区间，未出现缺水胁迫。',
      m.temp.max > 33 ? '· 【中风险】最高气温 ' + m.temp.max + '℃，中午时段存在蒸腾过强、授粉不良风险。' : '· 温度曲线平缓，无高温胁迫。',
      p.device.runs > 0 ? '· 本周期执行 ' + p.device.runs + ' 次灌溉，累计用水 ' + p.device.water_l + ' L，耗电 ' + p.device.energy_kwh + ' kWh。' : '· 本周期未执行灌溉，节水表现良好。',
      '',
      '三、大白话建议',
      soilLow ? '① 今天上午 9 点前浇水 10 分钟，别等中午，中午浇水蒸发损失能到三成。' : '① 暂时不用浇水，按当前蒸发速度还能撑一天。',
      '② 白天棚内湿度如果掉到 55% 以下，先开侧窗通风再考虑喷雾，闷着比干着更坏事。',
      '③ 采收前 7 天开始减水，果子更甜、更耐放。',
      '',
      '—— 报告由环境数据自动生成，仅供参考，重大农事操作请结合实地情况判断。',
    ].join('\n');
  }
  App.buildReport = buildReport;

  /* --------------------------------------------------------- Mock 路由 */
  let ackSeq = 0;
  const Mock = {
    async handle(path, opt) {
      await sleep(55 + Math.random() * 130);       // 模拟 RTT，别让 UI 在"零延迟"假象下开发
      const s = store.state;

      if (path.indexOf('/api/sensor/current') === 0) {
        if (Sim.mode === 'offline') throw new ApiError('网关无响应', 'OFFLINE');
        return s.sensors;
      }

      if (path.indexOf('/api/device/pump') === 0) {
        if (Sim.mode === 'offline') throw new ApiError('链路不可用，指令未送达', 'OFFLINE');
        Mock.applyToDevice(opt.body || {});
        return { accepted: true, cmdId: (opt.body || {}).cmdId || 'mock' };
      }

      if (path.indexOf('/api/device/shadow') === 0) return s.shadow;

      if (path.indexOf('/api/ai/report') === 0) {
        return { report: buildReport(opt.body || buildPayload()) };
      }

      // ★ 未匹配的路径必须抛错。老版本里 Promise 永远 pending，页面会静默卡死。
      throw new ApiError('Mock 未实现该接口: ' + path, 'NOT_IMPLEMENTED');
    },

    applyToDevice(body) {
      const want = body.action === 'on';
      if (Sim.mode === 'noack') return;            // 演练：设备收到但不回执 → 走 7s 超时分支
      ackSeq++;
      const id = ackSeq;
      setTimeout(() => { if (id === ackSeq) bus.emit('cmd:step', { step: 2 }); }, 420);
      setTimeout(() => { if (id === ackSeq) bus.emit('cmd:step', { step: 3 }); }, 900);
      setTimeout(() => {
        if (id !== ackSeq) return;
        Sim.pumpOn = want;
        setShadow({ power: want, ts: now(), source: 'device' });
        bus.emit('cmd:step', { step: 4 });
      }, 1350);
    },
  };

  /* ----------------------------------------------------------- 对外 API */
  App.store = store;
  App.bus = bus;
  App.Metrics = Metrics;
  App.PLOTS = PLOTS;
  App.STAGES = STAGES;
  App.stageOf = stageOf;
  App.hhmmss = hhmmss;

  App.setPlot = function (key) {
    if (!PLOTS[key]) return;
    Sim.reset(key);
    store.set({
      plot: key, stage: stageOf(key), history: [],
      stats: { pumpSec: 0, waterL: 0, energyWh: 0, runs: 0 },
    });
    Device.runStartedAt = 0;
    setShadow({ power: false, ts: now(), source: 'plot-switch' });
    store.set({ cmd: null });
    seedHistory(60);
  };

  App.setSimMode = function (mode) {
    if (mode === 'drought') {
      // 一键制造干旱：立刻推一帧，让告警/规则引擎马上有数据可判
      Sim.mode = 'normal';
      Sim.soil = 15.5;
      store.set({ link: Object.assign({}, store.state.link, { online: true, simOffline: false, lastSeenAt: now() }) });
      const f = Sim.tick();
      if (f) ingest(f);
      return;
    }
    Sim.mode = mode;
    if (mode === 'offline') {
      store.set({ link: Object.assign({}, store.state.link, { online: false, simOffline: true, gap: 99999 }) });
      bus.emit('link:down');
    } else {
      store.set({ link: Object.assign({}, store.state.link, { online: true, simOffline: false, lastSeenAt: now(), gap: 0 }) });
      bus.emit('link:up');
    }
  };

  function seedHistory(n) {
    const base = Sim;
    const arr = [];
    let soil = base.soil;
    for (let i = n; i > 0; i--) {
      soil = clamp(soil + (Math.random() - 0.5) * 0.35 - 0.06, 0, 100);
      arr.push({
        ts: now() - i * CONFIG.SAMPLE_MS,
        temp: +(base.temp + (Math.random() - 0.5) * 1.2).toFixed(1),
        humi: +(base.humi + (Math.random() - 0.5) * 2).toFixed(1),
        soil: +soil.toFixed(1),
        light: Math.round(base.light + (Math.random() - 0.5) * 2400),
      });
    }
    store.set({ history: arr.slice(-CONFIG.HISTORY_LEN) });
  }

  App.start = function () {
    Sim.reset('A');
    // 只补历史，不污染 sensors（sensors 由第一帧真实数据决定，启动页靠它关掉）
    const hist = [];
    let soil = Sim.soil;
    for (let i = 60; i > 0; i--) {
      soil = clamp(soil + (Math.random() - 0.5) * 0.35 - 0.06, 0, 100);
      hist.push({
        ts: now() - i * CONFIG.SAMPLE_MS,
        temp: +(Sim.temp + (Math.random() - 0.5) * 1.2).toFixed(1),
        humi: +(Sim.humi + (Math.random() - 0.5) * 2).toFixed(1),
        soil: +soil.toFixed(1),
        light: Math.round(Sim.light + (Math.random() - 0.5) * 2400),
      });
    }
    store.set({ history: hist });

    const first = Sim.tick();
    if (first) ingest(first);

    Sim.start();
    setInterval(heartbeat, 1000);
    bus.emit('app:ready');
  };

})(window);
