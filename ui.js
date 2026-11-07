/* ============================================================================
 * 智感云联 v2 · ui.js  —— 视图层（唯一允许碰 DOM 的地方）
 * ----------------------------------------------------------------------------
 * 三条铁律：
 *   1. 只有这里能写 document.xxx / querySelector。
 *   2. 渲染一律由 store.subscribe 驱动，禁止在业务回调里直接改 DOM。
 *   3. 数据来自后端时一律 esc() 转义，绝不把字符串直接拼进 innerHTML。
 * ==========================================================================*/
(function () {
  'use strict';

  const A = window.App;
  const { store, bus, api, Device, AlertCenter, Rules, CONFIG, Metrics, STAGES, Offline } = A;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ======================================================== 1. 通用工具 */

  /** 只订阅关心的那个值：值没变就不重渲染（避免每秒全页重绘） */
  function subscribeKey(sel, fn, immediate) {
    let prev;
    let first = true;
    return store.subscribe((s) => {
      const v = sel(s);
      if (first || v !== prev) { prev = v; first = false; fn(v, s); }
    }, immediate !== false);
  }

  /** 数字补间：1Hz 数据 + 60fps 视觉，避免"跳字" */
  function tweenTo(el, to, digits, group) {
    if (!el || !isFinite(to)) return;
    if (el._raf) { cancelAnimationFrame(el._raf); el._raf = null; }
    const fmt = (v) => group ? Math.round(v).toLocaleString('zh-CN') : v.toFixed(digits);
    // ★ 起点必须取"上一次真正画出来的值"，不能取上一次的目标值：
    //   否则数据比动画快时（掉帧/后台节流）数字会在两个目标之间乱跳。
    const from = el._cur == null ? to : el._cur;
    if (Math.abs(to - from) < Math.pow(10, -digits) / 2) {
      el._cur = to; el.textContent = fmt(to); return;
    }
    const t0 = performance.now();
    el._raf = requestAnimationFrame(function step() {
      // ⚠️ 不要用 rAF 回调参数当时间戳：它在虚拟时间/某些 WebView 里与
      //    performance.now() 不同基准，相减会得到负数，缓动曲线会被指数放大
      //    （表现为数字突然变成几亿）。统一用 performance.now() 并夹紧到 [0,1]。
      const p = Math.min(1, Math.max(0, (performance.now() - t0) / 620));
      const e = 1 - Math.pow(1 - p, 3);
      const v = from + (to - from) * e;
      el._cur = v;
      el.textContent = fmt(v);
      if (p < 1) el._raf = requestAnimationFrame(step);
      else { el._cur = to; el.textContent = fmt(to); el._raf = null; }
    });
  }

  function toast(msg, type, ms) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    $('#toast-wrap').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s,transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-8px)';
      setTimeout(() => el.remove(), 260);
    }, ms || 2600);
  }

  /** Promise 化的确认框，替代原来"点确认按钮绑 onclick 全局函数"的做法 */
  function askConfirm(opt) {
    return new Promise((resolve) => {
      const m = $('#modal');
      $('#modal-title').textContent = opt.title;
      $('#modal-desc').textContent = opt.desc;
      const ok = $('#modal-ok');
      const cancel = $('#modal-cancel');
      ok.className = opt.danger ? 'danger' : '';
      ok.textContent = opt.okText || '确认执行';
      m.classList.add('show');

      function onKey(e) { if (e.key === 'Escape') close(false); }
      function close(v) {
        m.classList.remove('show');
        ok.onclick = null; cancel.onclick = null;
        document.removeEventListener('keydown', onKey);
        resolve(v);
      }
      ok.onclick = () => { sfx(); close(true); };
      cancel.onclick = () => { sfx(); close(false); };
      document.addEventListener('keydown', onKey);
    });
  }

  /* 音效：必须 disconnect，否则每次点击都会在音频图里留一个节点 */
  let audioCtx = null;
  function sfx() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(760, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(320, audioCtx.currentTime + 0.09);
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.1);
      osc.connect(gain).connect(audioCtx.destination);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
      osc.start();
      osc.stop(audioCtx.currentTime + 0.1);
    } catch (e) { /* 静默降级 */ }
  }

  /* 鼠标火花：单 canvas + 粒子池，替代原来"每次 mousemove 建一个 div" */
  const Sparks = (function () {
    const cv = $('#trail');
    const ctx = cv.getContext('2d');
    let pts = [], raf = null, W = 0, H = 0, dpr = 1;
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth; H = window.innerHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function loop() {
      ctx.clearRect(0, 0, W, H);
      for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        p.life -= 0.045;
        p.x += p.vx; p.y += p.vy;
        if (p.life <= 0) { pts.splice(i, 1); continue; }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * p.life, 0, 6.2832);
        ctx.fillStyle = 'rgba(16,185,129,' + (p.life * 0.55).toFixed(3) + ')';
        ctx.fill();
      }
      raf = pts.length ? requestAnimationFrame(loop) : null;   // 没粒子就停帧，不空转
    }
    function onMove(e) {
      if (pts.length > 26) return;
      pts.push({
        x: e.clientX, y: e.clientY, life: 1,
        r: 1.5 + Math.random() * 2.5,
        vx: (Math.random() - 0.5) * 0.7,
        vy: (Math.random() - 0.5) * 0.7,
      });
      if (!raf) raf = requestAnimationFrame(loop);
    }
    return {
      init() {
        resize();
        window.addEventListener('resize', resize, { passive: true });
        window.addEventListener('mousemove', onMove, { passive: true });
      },
    };
  })();

  /* ======================================================== 2. 趋势图 */
  const Chart = (function () {
    let cv, ctx, tipEl, W = 0, H = 0, dpr = 1, hover = -1, data = [];
    const PAD = { l: 34, r: 38, t: 14, b: 20 };
    const C = { soil: '#10b981', humi: '#3b82f6', temp: '#f59e0b' };
    const MONO = '10px ui-monospace, Consolas, monospace';

    function init() {
      cv = $('#trend');
      ctx = cv.getContext('2d');
      tipEl = $('#chart-tip');
      new ResizeObserver(() => resize()).observe(cv.parentElement);
      cv.addEventListener('mousemove', onMove);
      cv.addEventListener('mouseleave', () => { hover = -1; tipEl.style.display = 'none'; render(); });
      resize();
    }

    function resize() {
      if (!cv) return;
      const rect = cv.getBoundingClientRect();
      if (rect.width < 20) return;                 // 页面隐藏时不要按 0 宽重算
      W = Math.round(rect.width);
      H = Math.round(rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      render();
    }

    function geo() {
      const x0 = PAD.l, x1 = W - PAD.r;
      const y0 = PAD.t, y1 = H - PAD.b;
      const n = data.length;
      return {
        x0, x1, y0, y1, w: x1 - x0, h: y1 - y0, n,
        px: (i) => x0 + (n <= 1 ? 0 : (x1 - x0) * i / (n - 1)),
        pyPct: (v) => y0 + (1 - v / 100) * (y1 - y0),
        pyTemp: (v) => y0 + (1 - v / 45) * (y1 - y0),
      };
    }

    function smooth(g, pts) {
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const xc = (a.x + b.x) / 2;
        g.bezierCurveTo(xc, a.y, xc, b.y, b.x, b.y);
      }
    }

    function render() {
      if (!ctx || !W) return;
      data = store.state.history || [];
      ctx.clearRect(0, 0, W, H);
      if (data.length < 2) return;

      const g0 = geo();

      // --- 网格 + 双轴刻度 ---
      ctx.font = MONO;
      ctx.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) {
        const y = g0.y0 + (g0.h * i) / 4;
        ctx.beginPath();
        ctx.moveTo(g0.x0, y);
        ctx.lineTo(g0.x1, y);
        ctx.strokeStyle = 'rgba(255,255,255,.055)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#5d6c82';
        ctx.textAlign = 'right';
        ctx.fillText(String(100 - i * 25), g0.x0 - 7, y);
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(245,158,11,.55)';
        ctx.fillText(String(Math.round(45 - i * 11.25)), g0.x1 + 7, y);
      }

      // --- 土壤安全区带 ---
      const yTop = g0.pyPct(60), yBot = g0.pyPct(22);
      const grad = ctx.createLinearGradient(0, yTop, 0, yBot);
      grad.addColorStop(0, 'rgba(16,185,129,.05)');
      grad.addColorStop(1, 'rgba(16,185,129,.13)');
      ctx.fillStyle = grad;
      ctx.fillRect(g0.x0, yTop, g0.w, yBot - yTop);

      // 干旱红线
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.moveTo(g0.x0, yBot);
      ctx.lineTo(g0.x1, yBot);
      ctx.strokeStyle = 'rgba(239,68,68,.45)';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(239,68,68,.7)';
      ctx.textAlign = 'right';
      ctx.fillText('阈值 22%', g0.x1 - 6, yBot - 8);

      // --- 面积（土壤） ---
      const soilPts = data.map((d, i) => ({ x: g0.px(i), y: g0.pyPct(d.soil) }));
      smooth(ctx, soilPts);
      ctx.lineTo(soilPts[soilPts.length - 1].x, g0.y1);
      ctx.lineTo(soilPts[0].x, g0.y1);
      ctx.closePath();
      const area = ctx.createLinearGradient(0, g0.y0, 0, g0.y1);
      area.addColorStop(0, 'rgba(16,185,129,.28)');
      area.addColorStop(1, 'rgba(16,185,129,0)');
      ctx.fillStyle = area;
      ctx.fill();

      // --- 三条线 ---
      const drawLine = (pts, color, width, dash) => {
        smooth(ctx, pts);
        ctx.setLineDash(dash || []);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.setLineDash([]);
      };
      drawLine(soilPts, C.soil, 2);
      drawLine(data.map((d, i) => ({ x: g0.px(i), y: g0.pyPct(d.humi) })), C.humi, 1.4, [5, 3]);
      drawLine(data.map((d, i) => ({ x: g0.px(i), y: g0.pyTemp(d.temp) })), C.temp, 1.4);

      // --- 末端光点 ---
      const last = soilPts[soilPts.length - 1];
      ctx.beginPath();
      ctx.arc(last.x, last.y, 3.2, 0, 6.2832);
      ctx.fillStyle = C.soil;
      ctx.shadowColor = 'rgba(16,185,129,.9)';
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;

      // --- X 轴时间 ---
      ctx.fillStyle = '#5d6c82';
      ctx.textAlign = 'center';
      [0, Math.floor((data.length - 1) / 2), data.length - 1].forEach((i, k) => {
        if (!data[i]) return;
        const x = g0.px(i);
        ctx.textAlign = k === 0 ? 'left' : k === 2 ? 'right' : 'center';
        const xx = k === 0 ? g0.x0 : k === 2 ? g0.x1 : x;
        ctx.fillText(A.hhmmss(data[i].ts), xx, H - 8);
      });

      // --- 悬停十字线 ---
      if (hover >= 0 && hover < data.length) {
        const x = g0.px(hover);
        ctx.beginPath();
        ctx.moveTo(x, g0.y0);
        ctx.lineTo(x, g0.y1);
        ctx.strokeStyle = 'rgba(255,255,255,.22)';
        ctx.lineWidth = 1;
        ctx.stroke();
        [[g0.pyPct(data[hover].soil), C.soil], [g0.pyPct(data[hover].humi), C.humi], [g0.pyTemp(data[hover].temp), C.temp]]
          .forEach(([y, c]) => {
            ctx.beginPath(); ctx.arc(x, y, 3, 0, 6.2832);
            ctx.fillStyle = '#0b1426'; ctx.fill();
            ctx.lineWidth = 1.6; ctx.strokeStyle = c; ctx.stroke();
          });
      }
    }

    function onMove(e) {
      if (!data.length) return;
      const rect = cv.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const g0 = geo();
      const ratio = (x - g0.x0) / Math.max(1, g0.w);
      let idx = Math.round(ratio * (data.length - 1));
      idx = Math.max(0, Math.min(data.length - 1, idx));
      hover = idx;
      render();

      const d = data[idx];
      tipEl.innerHTML =
        '<b>' + esc(A.hhmmss(d.ts)) + '</b>' +
        '<span>土壤 <em style="color:' + C.soil + '">' + d.soil.toFixed(1) + '%</em></span>' +
        '<span>湿度 <em style="color:' + C.humi + '">' + d.humi.toFixed(1) + '%</em></span>' +
        '<span>温度 <em style="color:' + C.temp + '">' + d.temp.toFixed(1) + '℃</em></span>';
      tipEl.style.display = 'block';

      const tw = tipEl.offsetWidth;
      const left = Math.max(tw / 2 + 4, Math.min(W - tw / 2 - 4, g0.px(idx)));
      tipEl.style.left = left + 'px';
      tipEl.style.top = Math.max(64, g0.pyPct(d.soil)) + 'px';
    }

    /**
     * 尺寸自检：ResizeObserver 的回调和 rAF 一样走渲染步骤，在后台/无绘制环境
     * 可能不触发。每秒比对一次真实盒子尺寸，变了才重算，成本可以忽略。
     */
    function sync() {
      if (!cv) return;
      const r = cv.getBoundingClientRect();
      if (r.width < 20) return;
      if (Math.abs(r.width - W) > 1 || Math.abs(r.height - H) > 1) resize();
    }

    return { init, render, resize, sync };
  })();

  /* ======================================================== 3. KPI 卡片 */
  function buildKpis() {
    const grid = $('#kpi-grid');
    grid.innerHTML = Object.values(Metrics).map((m) => `
      <div class="kpi">
        <div class="kpi-head"><span class="kpi-name">${esc(m.label)}</span><span class="kpi-delta" id="d-${m.key}">—</span></div>
        <div class="kpi-val"><b id="k-${m.key}">--</b><i>${esc(m.unit)}</i></div>
        <div class="kpi-bar">
          <span class="kpi-band" data-band="${m.key}"></span>
          <span class="kpi-mark" id="m-${m.key}"></span>
        </div>
        <div class="kpi-foot"><span>适宜 ${m.safe[0]}~${m.safe[1]}</span><span class="kpi-state" id="s-${m.key}">—</span></div>
      </div>`).join('');

    Object.values(Metrics).forEach((m) => {
      const band = grid.querySelector('[data-band="' + m.key + '"]');
      const l = ((m.safe[0] - m.min) / (m.max - m.min)) * 100;
      const r = ((m.safe[1] - m.min) / (m.max - m.min)) * 100;
      band.style.left = l + '%';
      band.style.width = (r - l) + '%';
    });
  }

  function renderKpis() {
    Object.values(Metrics).forEach((m) => {
      subscribeKey((s) => s.sensors[m.key], (v, s) => {
        if (!s.sensors.ts) return;              // 首帧还没到，别先渲染一个 0 出来
        tweenTo($('#k-' + m.key), v, m.digits, m.group);
        const mark = $('#m-' + m.key);
        const ratio = Math.max(0, Math.min(1, (v - m.min) / (m.max - m.min)));
        mark.style.left = (ratio * 100) + '%';
        const st = v < m.safe[0] ? 'low' : v > m.safe[1] ? 'high' : 'ok';
        mark.className = 'kpi-mark ' + (st === 'ok' ? '' : st);
        const label = $('#s-' + m.key);
        label.textContent = st === 'ok' ? '适宜' : st === 'low' ? '偏低' : '偏高';
        label.className = 'kpi-state ' + st;
      });
    });

    // 变化量：和 30 个采样点前比（写在这一个订阅里，避免额外定时器）
    subscribeKey((s) => s.history, (h) => {
      Chart.render();
      // AI 页的数据包预览：让"发给大模型的东西"在上屏前就可见
      $('#ai-samples').textContent = h.length;
      if (h.length) {
        $('#ai-window').textContent = A.hhmmss(h[0].ts);
        const avg = h.reduce((a, b) => a + b.soil, 0) / h.length;
        $('#ai-soil').textContent = avg.toFixed(1) + '%';
      }
      if (store.state.stage) $('#ai-stage').textContent = store.state.stage.stage.name;

      if (h.length < 31) return;
      const cur = h[h.length - 1], old = h[h.length - 31];
      Object.values(Metrics).forEach((m) => {
        const el = $('#d-' + m.key);
        if (!el) return;
        const diff = cur[m.key] - old[m.key];
        if (Math.abs(diff) < 0.05) { el.textContent = '—'; el.className = 'kpi-delta'; return; }
        el.textContent = (diff > 0 ? '↑ ' : '↓ ') + Math.abs(diff).toFixed(m.digits);
        el.className = 'kpi-delta ' + (diff > 0 ? 'up' : 'down');
      });
    });
  }

  /* ======================================================== 4. 设备影子 */
  const RING_C = 2 * Math.PI * 66;

  function renderLifecycle(cmd) {
    const steps = $$('#lifecycle .step');
    const step = cmd ? cmd.step : 0;
    const failed = cmd && (cmd.state === 'failed' || cmd.state === 'timeout');
    const failIdx = cmd && cmd.state === 'timeout' ? 3 : 0;

    steps.forEach((el, i) => {
      el.classList.remove('done', 'active', 'fail');
      if (failed) { if (i === failIdx) el.classList.add('fail'); else if (i < failIdx) el.classList.add('done'); return; }
      if (step > i) el.classList.add('done');
      else if (step === i && cmd && cmd.state === 'pending') el.classList.add('active');
    });
  }

  function updatePumpUI() {
    const s = store.state;
    const on = s.shadow.power;
    const pending = s.cmd && s.cmd.state === 'pending';
    const cooling = Date.now() < Device.cooldownUntil;
    const online = s.link.online;

    const btn = $('#btn-pump');
    btn.className = 'btn-primary' + (on ? ' stop' : '');
    btn.disabled = pending || cooling || !online;
    btn.textContent = pending ? '指令执行中…' : on ? '⏹ 关闭水泵' : '💧 一键抽水灌溉';

    const st = $('#pump-status');
    st.textContent = on ? '运行中' : pending ? '等待设备回执' : '已关闭';
    st.className = 'pump-status' + (on ? ' on' : '');
    $('#pump-sub').textContent = !online ? '链路中断 · 控制已锁定'
      : on ? '继电器闭合 · 水泵运转中' : '继电器断开 · 无电流';

    $('#btn-estop').disabled = !online;

    // 环形进度 = 本次运行 / 上限
    const fg = $('#pump-ring-fg');
    const runSec = on && Device.runStartedAt ? (Date.now() - Device.runStartedAt) / 1000 : 0;
    const p = Math.min(1, runSec / CONFIG.MAX_RUN_SEC);
    fg.style.strokeDasharray = RING_C;
    fg.style.strokeDashoffset = RING_C * (1 - p);
    // SVG 元素的 className 是只读的 SVGAnimatedString，必须走 setAttribute
    fg.setAttribute('class', 'fg' + (on ? '' : ' off'));

    const hint = $('#cooldown-hint');
    if (!online) hint.textContent = '⛔ 断网状态下已禁止下发指令';
    else if (cooling) hint.textContent = '继电器冷却 ' + Math.ceil((Device.cooldownUntil - Date.now()) / 1000) + 's（防频繁启停）';
    else hint.textContent = '安全锁已就绪 · 二次确认 + 回执校验';
  }

  function renderShadow(sh) {
    const el = $('#shadow-state');
    const pending = store.state.cmd && store.state.cmd.state === 'pending';
    el.className = 'shadow-state' + (sh.power ? ' on' : pending ? ' pending' : '');
    el.innerHTML = '<span class="dot"></span><span>' + (sh.power ? '运行中' : pending ? '待确认' : '已关闭') + '</span>';
    $('#shadow-sub').textContent = sh.ts ? '最后变更 ' + A.hhmmss(sh.ts) + ' · 来源 ' + esc(sh.source) : '等待设备上报…';
    $('#shadow-since').textContent = sh.ts ? A.hhmmss(sh.ts) : '—';
    updatePumpUI();
  }

  function renderCmd(cmd) {
    renderLifecycle(cmd);
    if (cmd && cmd.latency) $('#shadow-latency').textContent = cmd.latency + ' ms';
    updatePumpUI();
  }

  /* ======================================================== 5. 生长周期 */
  function renderStage(st) {
    if (!st) return;
    $('#stage-name').textContent = st.stage.name;
    $('#stage-day').textContent = '第 ' + st.days + ' 天';
    $('#stage-plot').textContent = st.plot.name;
    $('#stage-tip').textContent = '【' + st.stage.name + '】' + st.stage.tip;
    $('#stage-track').innerHTML = STAGES.map((s, i) =>
      '<div class="stage-node ' + (i < st.index ? 'done' : i === st.index ? 'active' : '') + '">' + esc(s.name) + '</div>'
    ).join('');
    $('#foot-plot').textContent = st.plot.name.split(' · ')[0];
  }

  /* ======================================================== 6. 规则 / 审计 */
  function renderRules(rules) {
    $('#rules-list').innerHTML = rules.map((r) => `
      <div class="rule">
        <div class="rule-text">
          <div class="rule-name">${esc(r.name)}</div>
          <div class="rule-desc">${esc(r.desc)}</div>
        </div>
        <button class="switch ${r.enabled ? 'on' : ''}" data-rule="${esc(r.id)}" aria-label="切换 ${esc(r.name)}"></button>
      </div>`).join('');
  }

  function renderAudit(list) {
    const box = $('#audit-list');
    $('#audit-count').textContent = list.length ? '最近 ' + list.length + ' 条' : '';

    // 指令成功率（运行概览）
    if (list.length) {
      const ok = list.filter((r) => r.state === 'acked').length;
      $('#ov-ok').textContent = Math.round((ok / list.length) * 100) + '%';
    }

    if (!list.length) {
      box.innerHTML = '<div class="audit-empty">暂无指令记录 · 每次操作都会留痕，可追溯到人与时间</div>';
      return;
    }
    box.innerHTML = list.slice(0, 10).map((r) => {
      const pill = r.state === 'acked' ? '<span class="pill ok">成功</span>'
        : r.state === 'pending' ? '<span class="pill wait">执行中</span>'
        : '<span class="pill fail">' + (r.state === 'timeout' ? '超时' : '失败') + '</span>';
      const act = r.action === 'on' ? '<b>开启灌溉</b>' : '<b>关闭灌溉</b>';
      return '<div class="audit-row">' +
        '<span class="t">' + esc(A.hhmmss(r.ts)) + '</span>' +
        '<span class="d">' + act + ' · ' + esc(r.source) + (r.error ? ' · ' + esc(r.error) : '') + '</span>' +
        '<span class="l">' + (r.latency ? r.latency + 'ms' : '—') + '</span>' +
        pill +
        '</div>';
    }).join('');
  }

  /* ======================================================== 7. 告警 */
  function renderAlerts(list) {
    const box = $('#alert-list');
    const active = list.filter((a) => a.status === 'active');
    const done = list.filter((a) => a.status !== 'active');

    const activeCount = active.length;
    const badge = $('#nav-badge');
    badge.hidden = activeCount === 0;
    badge.textContent = activeCount;

    if (!list.length) {
      box.innerHTML = '<div class="audit-empty">当前无任何告警，环境指标全部处于安全区间</div>';
      return;
    }

    const row = (a, isActive) => {
      const icon = a.level === 'critical' ? '⚠️' : a.level === 'warn' ? '🔔' : '✅';
      const cls = a.level === 'critical' ? '' : a.level === 'warn' ? 'warn' : 'ok';
      const btns = isActive
        ? (a.action === 'irrigate'
          ? '<button class="btn-mini primary" data-act="irrigate" data-id="' + esc(a.id) + '">立即灌溉</button>'
          : '<button class="btn-mini" data-act="ack" data-id="' + esc(a.id) + '">标记已处理</button>')
        : '<span class="pill ok" style="align-self:center">已闭环</span>';
      return '<div class="alert-item ' + cls + (isActive && a.level === 'critical' ? ' pulse' : '') + '">' +
        '<div class="alert-ic">' + icon + '</div>' +
        '<div class="alert-body">' +
        '<div class="alert-title">' + esc(a.title) + '</div>' +
        '<div class="alert-desc">' + esc(a.desc) + '</div>' +
        '<div class="alert-meta"><span>' + esc(A.hhmmss(a.ts)) + '</span>' +
        (a.resolvedAt ? '<span>处理于 ' + esc(A.hhmmss(a.resolvedAt)) + '</span>' : '') +
        '</div></div>' + btns + '</div>';
    };

    box.innerHTML = active.map((a) => row(a, true)).join('') + done.map((a) => row(a, false)).join('');
  }

  /* ======================================================== 8. AI 顾问 */
  let streamToken = null;

  function streamText(el, text, token) {
    return new Promise((resolve) => {
      let i = 0;
      let stopped = false;
      const chunk = Math.max(1, Math.round(text.length / 160));  // 分块写入，60fps 下约 2.7s 走完

      function cleanup() {
        stopped = true;
        el.classList.remove('streaming');
        el.removeEventListener('click', skip);
      }
      function finish() { el.textContent = text; cleanup(); resolve(); }
      function skip() { token.cancelled = true; finish(); }

      function frame() {
        if (stopped) return;
        if (token.cancelled) return finish();
        i += chunk;
        if (i >= text.length) return finish();
        el.textContent = text.slice(0, i);   // 只改文本节点，不重建 DOM
        queue();
      }
      // 和 store 调度器同样的双保险：rAF 不触发时（后台标签页）用定时器兜底，
      // 否则报告会永远停在半句话上。
      function queue() {
        let fired = false;
        const run = () => { if (fired) return; fired = true; frame(); };
        requestAnimationFrame(run);
        setTimeout(run, 40);
      }

      el.addEventListener('click', skip);
      queue();
    });
  }

  function currentCycleLabel() {
    const v = $('#cycle-select').value;
    if (v !== 'custom') return v;
    const h = Number($('#custom-hour').value);
    return h > 0 ? h + '小时' : '未填写周期';
  }

  async function generateAI() {
    const btn = $('#btn-ai');
    const box = $('#report-box');
    if (streamToken) streamToken.cancelled = true;
    const token = { cancelled: false };
    streamToken = token;

    btn.disabled = true;
    btn.textContent = '正在打包数据…';
    box.classList.add('show', 'streaming');
    box.textContent = '';

    const payload = A.buildPayload(currentCycleLabel());
    $('#payload-box').textContent = JSON.stringify(payload, null, 2);

    try {
      const data = await api.post('/api/ai/report', payload);
      if (streamToken !== token) return;          // 已被新请求接管，别去动按钮
      box.textContent = '';
      btn.textContent = '生成中…';
      await streamText(box, data.report, token);
      if (streamToken !== token) return;
      btn.disabled = false;
      btn.textContent = '重新生成报告';
    } catch (e) {
      if (streamToken !== token) return;
      box.classList.remove('streaming');
      box.textContent = '生成失败：' + e.message + '\n（请求已超时/失败，请检查 Flask 服务与跨域配置）';
      btn.disabled = false;
      btn.textContent = '重试';
      toast('AI 报告生成失败：' + e.message, 'err');
    }
  }

  /* ======================================================== 9. 联动 */
  async function doIrrigate(source) {
    const ok = await askConfirm({
      title: '安全确认 · 开启灌溉',
      desc: '即将向 ESP32 下发继电器闭合指令，水泵将运行约 120 秒。请确认现场无人员作业、水源充足。',
      okText: '确认开启',
    });
    if (!ok) return;
    try {
      await Device.command('on', { durationSec: 120, source: source || '手动' });
      toast('水泵已启动，等待 120s 后自动关闭', 'ok');
    } catch (e) {
      if (e.code === 'BLOCKED' && !store.state.link.online) {
        Offline.save('on');
        toast('已离线暂存指令，网络恢复后需你再次确认', 'warn', 3600);
        $('#offline-act').style.display = 'inline-flex';
      } else {
        toast(e.message, 'err', 3200);
      }
    }
  }

  async function doStop() {
    if (!store.state.shadow.power) { toast('水泵当前未运行', 'warn'); return; }
    const ok = await askConfirm({
      title: '安全确认 · 关闭灌溉', desc: '将立即断开继电器。若正在补水，作物不会受影响。', okText: '确认关闭',
    });
    if (!ok) return;
    try {
      await Device.command('off', { source: '手动' });
      toast('水泵已关闭', 'ok');
    } catch (e) { toast(e.message, 'err', 3200); }
  }

  /* ======================================================== 10. 页面切换 */
  const TITLES = {
    dashboard: ['实时环境监测大屏', 'ESP32 边缘节点 · MQTT 双向链路'],
    control: ['设备控制中心', '悲观确认模型 · 继电器冷却 · 超时保护'],
    advisor: ['AI 农事顾问', '结构化数据 → 大模型 → 大白话建议'],
    alert: ['告警与复盘', '三级回退触达 · 指令全程可追溯'],
  };

  function switchPage(id) {
    if (!TITLES[id]) id = 'dashboard';
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === id));
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + id));
    const t = TITLES[id] || ['', ''];
    $('#page-title').textContent = t[0];
    $('#page-sub').textContent = t[1];
    // 简易 hash 路由：支持深链、刷新后停在原页面
    if (location.hash !== '#' + id) location.hash = id;
    // 切回来时容器宽度可能变过，必须重算 canvas（否则图表被拉伸/模糊）
    requestAnimationFrame(() => Chart.resize());
  }

  /* ======================================================== 11. 启动 */
  function boot() {
    buildKpis();
    renderKpis();          // ★ 别漏：KPI 的数值订阅在这里注册
    Sparks.init();
    Chart.init();
    renderStage(store.state.stage);

    /* --- 订阅 --- */
    subscribeKey((s) => s.shadow, renderShadow);
    subscribeKey((s) => s.cmd, renderCmd);
    subscribeKey((s) => s.stage, renderStage);
    subscribeKey((s) => s.rules, renderRules);
    subscribeKey((s) => s.audit, renderAudit);
    subscribeKey((s) => s.alerts, renderAlerts);
    subscribeKey((s) => s.stats, (st) => {
      $('#shadow-water').textContent = st.waterL.toFixed(2) + ' L';
      $('#ov-water').textContent = st.waterL.toFixed(2) + ' L';
    });

    /* --- 链路状态 --- */
    bus.on('link:down', () => {
      $('#link-pill').classList.add('off');
      $('#link-text').textContent = '链路断开';
      $('#offline-banner').classList.add('show');
      $('#offline-text').textContent = '已 ' + Math.round(CONFIG.OFFLINE_GAP_MS / 1000) + 's 未收到遥测 · 控制指令已被安全拦截';
      updatePumpUI();
      toast('链路中断，控制已锁定', 'err', 3200);
    });
    bus.on('link:up', async () => {
      $('#link-pill').classList.remove('off');
      $('#link-text').textContent = '链路正常';
      $('#offline-banner').classList.remove('show');
      updatePumpUI();
      const pending = Offline.peek();
      if (pending) {
        // 断网期间的指令【绝不静默补发】——恢复后必须人工再确认，否则半夜可能自己放水
        $('#offline-act').style.display = 'inline-flex';
        $('#offline-act').textContent = '确认执行暂存的「' + (pending.action === 'on' ? '灌溉' : '停水') + '」指令';
        toast('网络已恢复，有 1 条离线暂存指令待你确认', 'warn', 4000);
      } else {
        toast('链路已恢复', 'ok');
      }
    });

    /* --- 指令步骤动画（仅用于把 4 段式进度点亮得更顺滑） --- */
    bus.on('cmd:step', (p) => {
      const cmd = store.state.cmd;
      if (!cmd || cmd.state !== 'pending') return;
      if (p.step > cmd.step && p.step <= 3) {
        cmd.step = p.step;
        store.set({ cmd: Object.assign({}, cmd) });
      }
    });

    /* --- 声光 / 语音告警 --- */
    bus.on('alert:critical', (a) => {
      if (!store.state.voice) return;
      try {
        const u = new SpeechSynthesisUtterance('警告，' + a.title + '。' + a.desc);
        u.lang = 'zh-CN';
        u.rate = 1.05;
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      } catch (e) { /* 不支持则忽略 */ }
    });

    /* --- 1Hz 定时器：只做"时间相关"的更新，不碰数据渲染 --- */
    let lastImg = '';
    setInterval(() => {
      const runSec = store.state.shadow.power && Device.runStartedAt
        ? Math.floor((Date.now() - Device.runStartedAt) / 1000) : 0;
      const mm = String(Math.floor(runSec / 60)).padStart(2, '0');
      const ss = String(runSec % 60).padStart(2, '0');
      $('#pump-ring-text').textContent = mm + ':' + ss;
      $('#shadow-runtime').textContent = runSec ? mm + ':' + ss : '—';
      updatePumpUI();

      const d = new Date();
      const txt = A.hhmmss(d.getTime());
      if (txt !== lastImg) { $('#clock').textContent = txt; lastImg = txt; }
      $('#ov-rtt').textContent = store.state.link.rtt ? store.state.link.rtt + ' ms' : '— ms';
      Chart.sync();
    }, 1000);

    /* --- 事件绑定（全部走委托，不再写 onclick="xxx()"） --- */
    $$('.nav-item').forEach((b) => b.addEventListener('click', () => { sfx(); switchPage(b.dataset.page); }));

    window.addEventListener('hashchange', () => {
      const id = location.hash.slice(1);
      if (TITLES[id]) switchPage(id);
    });
    // 首次进入按 hash 落位（刷新/分享链接不丢当前页面）
    const initHash = location.hash.slice(1);
    if (TITLES[initHash]) switchPage(initHash);

    $('#btn-pump').addEventListener('click', () => {
      sfx();
      if (store.state.shadow.power) doStop(); else doIrrigate('手动');
    });

    $('#btn-estop').addEventListener('click', async () => {
      sfx();
      const ok = await askConfirm({ title: '紧急停止', desc: '将跳过所有业务校验，立即下发断电指令。仅在异常情况下使用。', okText: '立即断电', danger: true });
      if (!ok) return;
      try { await Device.estop(); toast('已紧急断电', 'ok'); }
      catch (e) { toast(e.message, 'err', 4000); }
    });

    $('#rules-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-rule]');
      if (!btn) return;
      sfx();
      Rules.toggle(btn.dataset.rule);
      toast('策略已' + (btn.classList.contains('on') ? '关闭' : '开启'), 'ok', 1600);
    });

    $('#alert-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      sfx();
      if (btn.dataset.act === 'irrigate') doIrrigate('告警联动');
      else { AlertCenter.ack(btn.dataset.id); toast('已标记处理', 'ok', 1600); }
    });

    $('#btn-ai').addEventListener('click', () => { sfx(); generateAI(); });
    $('#cycle-select').addEventListener('change', (e) => {
      $('#custom-hour').style.display = e.target.value === 'custom' ? 'inline-block' : 'none';
    });
    $('#payload-toggle').addEventListener('click', () => {
      const box = $('#payload-box');
      box.classList.toggle('show');
      $('#payload-toggle').textContent = (box.classList.contains('show') ? '▾ ' : '▸ ') + '查看本周期实际发送给大模型的 Payload（可解释性）';
    });

    $('#voice-chip').addEventListener('click', () => {
      sfx();
      const on = !store.state.voice;
      store.set({ voice: on });
      $('#voice-chip').textContent = on ? '🔊 语音播报已开启' : '🔇 语音播报已关闭';
      if (on) toast('语音播报已开启', 'ok');
    });

    $('#plot-select').addEventListener('change', (e) => {
      A.setPlot(e.target.value);
      toast('已切换到 ' + A.PLOTS[e.target.value].name, 'ok', 2000);
      Chart.resize();
    });

    $('#sim-mode').addEventListener('change', (e) => {
      A.setSimMode(e.target.value);
      const tip = {
        noack: ['演练：设备将收到指令但不回执，7s 后触发超时', 'warn'],
        drought: ['演练：土壤水分已降至 15.5%，触发干旱告警', 'warn'],
        offline: ['演练：链路已切断，遥测停止、控制锁定', 'warn'],
      }[e.target.value];
      if (tip) toast(tip[0], tip[1], 4000);
    });

    $('#btn-export').addEventListener('click', () => {
      const rows = [['时间', '温度(℃)', '湿度(%RH)', '土壤水分(%)', '光照(lx)']];
      store.state.history.forEach((f) => {
        rows.push([new Date(f.ts).toLocaleString('zh-CN'), f.temp, f.humi, f.soil, f.light]);
      });
      const csv = '\ufeff' + rows.map((r) => r.join(',')).join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sensor_' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('已导出 ' + store.state.history.length + ' 条采样', 'ok');
    });

    $('#offline-act').addEventListener('click', async () => {
      const p = Offline.peek();
      Offline.clear();
      $('#offline-act').style.display = 'none';
      if (!p) return;
      if (p.action === 'on') { await doIrrigate('离线补发'); }
      else doStop();
    });

    /* --- 启动数据引擎 --- */
    A.start();

    /* --- 启动页：等首帧真实遥测，而不是固定 2.2s --- */
    let closed = false;
    const closeSplash = () => {
      if (closed) return;
      closed = true;
      $('#splash').classList.add('hide');
    };
    const un = store.subscribe((s) => {
      if (s.sensors.ts) {
        $('#splash-tip').textContent = '首帧遥测已接收 · ' + s.sensors.temp + '℃';
        un();
        setTimeout(closeSplash, 420);
      }
    });
    setTimeout(closeSplash, 2600);   // 兜底，免得接口挂了页面永远卡在启动页
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
