// ==UserScript==
// @name         StarFarm V2 - Gacha Automation
// @namespace    https://ultrarouter.org/gacha/
// @version      2.0.0
// @description  All-in-one gacha assistant: dungeon farming, leveling, star-up, shard decomposition, gacha, gem socketing, shopping, squad optimizer. Server-authoritative settlement.
// @author       StarFarm
// @updateURL     https://raw.githubusercontent.com/mowsxc/starfarm/main/starfarm.user.js
// @downloadURL   https://raw.githubusercontent.com/mowsxc/starfarm/main/starfarm.user.js
// @match        https://ultrarouter.org/gacha/*
// @match        https://ultrarouter.org/gacha
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";
  if (window.__SF && window.__SF.ready) { console.warn("[SF] v2 already loaded"); return; }

  /* ============================================================
   * CONFIG — 所有可调参数集中于此
   * ============================================================ */
  const CFG = {
    // 副本
    rounds: Infinity,        // 副本场次上限，Infinity=不限
    minStamina: 1,           // 体力低于此值暂停副本
    bgMode: true,            // true=后台静默(不进战斗画面)  false=完整动画
    farmWhenNoToken: true,   // 今日代币池为0时仍继续刷
    gapMs: 500,              // 每场之间的间隔
    autoMulti: true,         // 自动维持双倍卡开启（E产出翻倍，核心！）
    // 召唤
    gachaCount: 10,          // 每次召唤张数(1或10)
    gachaLimit: Infinity,    // 召唤次数上限
    gachaReserve: 0,         // 召唤保留金币（0=只要够一次就抽）
    // 升级/升星
    levelReserve: 3000,      // 升级保留金币
    autoStar: true,          // 升级任务中是否顺便升星
    // 分解
    // (始终保留解锁/下一星所需碎片)
    // 资源
    // 通用
    mutateRetries: 4,
    logLimit: 60,
    uiTickMs: 1000,
  };

  /* ============================================================
   * STATE
   * ============================================================ */
  const S = {
    ready: false, installed: true,
    // 任务: running/abort 成对
    T: {
      farm:  { run: false, abort: false, n: 0 },
      level: { run: false, abort: false, n: 0 },
      star:  { run: false, abort: false, n: 0 },
      decomp:{ run: false, abort: false, n: 0 },
      gacha: { run: false, abort: false, n: 0 },
      gem:   { run: false, abort: false, n: 0 },
      shop:  { run: false, abort: false, n: 0 },
    },
    // 统计
    done: 0, wins: 0, fails: 0, stars3: 0,
    goldStart: 0, stamStart: 0, siteStart: null, siteEarned: 0,
    eStart: null, eGot: 0, eGotTotal: 0, runCount: 0,
    levelUps: 0, starUps: 0, decompDust: 0, gachaPulls: 0,
    gachaSSR: 0, gachaSR: 0, gachaNew: 0, gemsSet: 0,
    results: [], logs: [], errors: [],
    last: "", lastResult: null, startedAt: 0,
    hookDone: false,
    collapsed: false,
  };
  window.__SF = S;

  const $ = (id) => document.getElementById(id);
  const txt = (id) => ($(id) ? $(id).textContent.trim() : "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clock = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
  // E 数值统一两位小数，超长数字做紧凑显示（>=10万显示整数K）
  function fmtE(v) {
    if (v == null || !Number.isFinite(+v)) return "-";
    const n = +v;
    if (Math.abs(n) >= 100000) return (n / 1000).toFixed(1) + "K";
    return n.toFixed(2);
  }

  /* ============================================================
   * 实时数据读取（读内存，不看滞后的 DOM 顶栏）
   * ============================================================ */
  function gold() {
    if (typeof SAVE !== "undefined" && SAVE && Number.isFinite(SAVE.gold)) return SAVE.gold;
    return Number(String(txt("res-gold").replace(/,/g, ""))) || 0;
  }
  function stamina() {
    if (typeof SAVE !== "undefined" && SAVE && Number.isFinite(SAVE.stamina)) {
      return { cur: SAVE.stamina, max: SAVE.staminaMax || 120 };
    }
    const m = txt("res-stamina").match(/(\d+)\s*\/\s*(\d+)/);
    return m ? { cur: +m[1], max: +m[2] } : { cur: 0, max: 0 };
  }
  function siteE() {
    try {
      if (typeof SITE_ACCOUNT !== "undefined" && SITE_ACCOUNT && Number.isFinite(SITE_ACCOUNT.quota)) {
        const per = (typeof SITE !== "undefined" && SITE.quotaPerE) || 500000;
        return +(SITE_ACCOUNT.quota / per).toFixed(4);
      }
    } catch (e) {}
    const m = txt("res-site").match(/([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  }
  function tokens() { return (typeof SAVE !== "undefined" && SAVE && SAVE.token) || 0; }
  function budgetLeft() {
    if (typeof SAVE !== "undefined" && SAVE && SAVE.daily) {
      return Math.max(0, (typeof TOKEN_BUDGET !== "undefined" ? TOKEN_BUDGET : 100) - (SAVE.daily.tokenGained || 0));
    }
    return Number(txt("res-budget")) || 0;
  }
  // 今日站点额度产出（E）——来自服务器 profile.today
  function todayE() {
    try {
      const t = typeof Store !== "undefined" && Store.profile && Store.profile.today;
      const per = (typeof SITE !== "undefined" && SITE.quotaPerE) || 500000;
      return t && Number.isFinite(t.quota) ? +(t.quota / per).toFixed(4) : null;
    } catch (e) { return null; }
  }
  function todayRuns() {
    try { return (typeof Store !== "undefined" && Store.profile && Store.profile.today?.runs) || 0; }
    catch (e) { return 0; }
  }
  function teamPower() {
    try {
      if (typeof SAVE !== "undefined" && SAVE && Number.isFinite(SAVE.power)) return SAVE.power;
      if (typeof SAVE !== "undefined" && SAVE && typeof powerOf === "function") {
        return (SAVE.squad || []).reduce((a, id) => a + powerOf(id), 0);
      }
    } catch (e) {}
    return 0;
  }
  function squadHTML() {
    try {
      if (typeof SAVE === "undefined" || !SAVE) return "";
      return (SAVE.squad || []).map((id) => {
        const g = GIRLS.find((x) => x.id === id), o = SAVE.girls[id];
        if (!g || !o) return "";
        const el = (typeof ELEM !== "undefined" && ELEM[g.elem]) ? ELEM[g.elem].name : "";
        return `<span class="sf-sq"><b style="color:${RARITY[g.rarity].color}">${esc(g.name)}</b><small>${o.level}/${o.star}★ ${esc(el)}</small></span>`;
      }).join("");
    } catch (e) { return ""; }
  }
  function stageName(id) {
    try { return STAGES.find((s) => s.id === id)?.name || id; } catch (e) { return id; }
  }
  function latestStage() {
    try {
      const cleared = (typeof SAVE !== "undefined" && SAVE && SAVE.cleared) || {};
      let best = STAGES[0], changed = true;
      while (changed) {
        changed = false;
        for (const s of STAGES) {
          if (s.unlockStage && cleared[s.unlockStage] && s.enemyLv > best.enemyLv) { best = s; changed = true; }
        }
      }
      return best.id;
    } catch (e) { return "s12"; }
  }

  /* ============================================================
   * 核心：串行化 mutate（游戏有全局 mutationBusy 锁）
   * ============================================================ */
  let _chain = Promise.resolve();
  function enqueue(fn) {
    const p = _chain.then(fn, fn);
    _chain = p.catch(() => {});
    return p;
  }
  async function waitGameIdle(max) {
    for (let w = 0; w < (max || 80) && Store.mutationBusy; w++) await sleep(100);
  }
  function safeMutate(action, fields, opts) {
    opts = opts || {};
    const retries = opts.retries != null ? opts.retries : CFG.mutateRetries;
    return enqueue(async () => {
      const fp = JSON.stringify({ action, ...fields });
      for (let attempt = 0; attempt <= retries; attempt++) {
        await waitGameIdle();
        // 若有别的未确认操作，先冲掉它（同 fingerprint 复用 request_id，幂等）
        if (Store.pendingAction && Store.pendingAction.fingerprint !== fp) {
          try { await Store.retryPendingAction(); } catch (e) {}
          await waitGameIdle();
        }
        let res = await Store.mutate(action, fields);
        if (res) return res;
        // mutate 失败但保留了我的 pendingAction → 直接重试它（同一 request_id）
        if (Store.pendingAction && Store.pendingAction.fingerprint === fp) {
          await waitGameIdle();
          try { res = await Store.retryPendingAction(); } catch (e) {}
          if (res) return res;
        }
        await sleep(700 * (attempt + 1));
      }
      return null;
    });
  }

  /* ============================================================
   * 战斗结算冷却：等待 ready_at
   * ============================================================ */
  async function waitRunReady(run) {
    if (!run) return;
    const deadline = Number(run.ready_at);
    if (!Number.isFinite(deadline)) { await sleep(400); return; }
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      const left = deadline - (typeof Store !== "undefined" && Store.serverNow ? Store.serverNow() : Date.now());
      if (left <= 0) return;
      await sleep(Math.min(250, Math.max(30, left)));
    }
  }
  async function settleStuckRun() {
    for (let k = 0; k < 8 && Store.activeRun && Store.activeRun.id; k++) {
      await waitRunReady(Store.activeRun);
      const r = await Store.finishRun(Store.activeRun.id);
      if (r) return true;
      if (k === 7) { try { await Store.refresh(); } catch (e) {} }
    }
    return false;
  }

  /* ============================================================
   * 结算钩子：捕获服务器真实结果 → S.results
   * ============================================================ */
  function hookFinishRun() {
    if (S.hookDone || typeof Store === "undefined") return;
    S.hookDone = true;
    const orig = Store.finishRun.bind(Store);
    Store.finishRun = async function (runId, abandon) {
      const res = await orig(runId, abandon);
      try {
        if (res && !abandon && (res.win !== undefined || res.stars !== undefined)) {
          const item = {
            win: !!res.win, stars: res.stars || 0, rounds: res.rounds || 0,
            alive: `${res.alive_n ?? "?"}/${res.total_n ?? "?"}`,
            drops: Array.isArray(res.drops) ? res.drops.slice() : [],
            at: clock(), stage: stageName(latestStage()),
          };
          S.results.unshift(item);
          if (S.results.length > 30) S.results.pop();
          S.lastResult = item;
          if (item.win) S.wins++; else S.fails++;
          if (item.stars === 3) S.stars3++;
          // 从掉落文本提取本场 E 收益并累加
          let runE = 0;
          for (const d of item.drops) {
            const m = String(d).match(/[+＋]?([\d.]+)\s*E/i);
            if (m) runE += parseFloat(m[1]) || 0;
          }
          item.e = +runE.toFixed(4);
          if (runE > 0) { S.eGot += runE; S.eGotTotal += runE; S.runCount++; }
          if (item.e) S.results[0].e = item.e;
          render();
        }
      } catch (e) { S.errors.push("hook:" + e.message); }
      return res;
    };
  }

  /* ============================================================
   * 日志 & 渲染
   * ============================================================ */
  function log(msg, kind) {
    // 去重：与上次完全相同的消息只更新，不重复刷屏
    if (S.logs.length && S.logs[S.logs.length - 1].replace(/^\[[^\]]+\]\s*/, "") === msg) {
      S.last = `[${clock()}] ${msg}`;
      return;
    }
    S.last = `[${clock()}] ${msg}`;
    S.logs.push(S.last);
    if (S.logs.length > CFG.logLimit) S.logs.shift();
    console.log("[StarFarm]", msg);
    render();
  }
  function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]); }

  function buildFeed() {
    if (!S.results.length && !S.logs.length) return '<div class="sf-empty">暂无动态 · 点击上方功能开始</div>';
    let html = "";
    for (const r of S.results.slice(0, 12)) {
      const stars = "★".repeat(r.stars) + "☆".repeat(Math.max(0, 3 - r.stars));
      const drops = (r.drops || []).filter((d) => !/^代币 x0$/.test(d));
      html += `<div class="sf-rcard ${r.win ? "win" : "lose"}">
        <div class="sf-rtop"><span class="sf-rbadge">${r.win ? "胜利" : "失败"}</span>
          <span class="sf-rstars">${stars}</span>
          ${r.e ? `<span class="sf-re">+${fmtE(r.e)}E</span>` : ""}
          <span class="sf-rtime">${esc(r.at)}</span></div>
        <div class="sf-rmeta">${esc(r.stage)} · ${r.rounds}回合 · 存活${esc(r.alive)}</div>
        ${drops.length ? `<div class="sf-rdrops">${drops.map((d) => `<span>${esc(d)}</span>`).join("")}</div>` : ""}
      </div>`;
    }
    const others = S.logs.slice(-8).reverse().filter((l) => !l.includes("结算：") && !l.includes("掉落："));
    if (others.length) {
      html += `<div class="sf-other">${others.map((l) => {
        const bad = /失败|不足|异常|TIMEOUT|超时/.test(l);
        return `<div class="sf-oline ${bad ? "bad" : ""}">${esc(l.replace(/^\[[^\]]+\]\s*/, ""))}</div>`;
      }).join("")}</div>`;
    }
    return html;
  }

  function injectStyle() {
    if ($("sf-style")) return;
    const st = document.createElement("style");
    st.id = "sf-style";
    st.textContent = `
      #sf-panel{position:fixed;right:14px;top:14px;z-index:2147483600;width:336px;max-height:94vh;overflow-y:auto;overflow-x:hidden;
        background:linear-gradient(160deg,rgba(20,26,46,.97),rgba(10,14,26,.97));color:#e6edff;
        border:1px solid rgba(120,150,230,.35);border-radius:16px;box-shadow:0 10px 40px #000b,inset 0 1px 0 #ffffff12;
        font:12px/1.5 -apple-system,"Segoe UI",ui-monospace,Consolas,monospace;scrollbar-width:thin;scrollbar-color:#3a5bb0 transparent}
      #sf-panel::-webkit-scrollbar{width:6px}#sf-panel::-webkit-scrollbar-thumb{background:#3a5bb0;border-radius:3px}
      .sf-head{position:sticky;top:0;z-index:2;padding:11px 13px 9px;background:linear-gradient(135deg,#1e2a52,#141b36);
        border-bottom:1px solid #ffffff12;border-radius:16px 16px 0 0;display:flex;align-items:center;justify-content:space-between}
      .sf-title{font-size:14px;font-weight:700;background:linear-gradient(90deg,#ffd46b,#ff9d6b);-webkit-background-clip:text;background-clip:text;color:transparent}
      .sf-title small{font-size:10px;color:#8fa8d8;-webkit-text-fill-color:#8fa8d8;font-weight:400;margin-left:4px}
      .sf-badge{font-size:10px;padding:3px 9px;border-radius:20px;font-weight:600}
      .sf-badge.run{background:linear-gradient(90deg,#1e7a4d,#28a06a);color:#eafff2;box-shadow:0 0 12px #28a06a55}
      .sf-badge.idle{background:#2a3352;color:#9fb0d8}.sf-badge.wait{background:#6a5320;color:#ffe1a0}
      .sf-head-r{display:flex;align-items:center;gap:6px}
      .sf-fold{font-size:10px!important;font-weight:600!important;padding:3px 8px!important;letter-spacing:0!important;
        background:#232d50!important;border-color:#4a5f9a!important;color:#bcd0f5!important;border-radius:14px!important}
      .sf-fold:hover{filter:brightness(1.25)}
      .sf-body{padding:9px 11px 12px}
      .sf-card{background:linear-gradient(150deg,#1b2440,#151b32);border:1px solid #ffffff0d;border-radius:11px;padding:8px 10px;margin-bottom:8px}
      .sf-ct{font-size:11px;font-weight:700;color:#9fb4e8;margin-bottom:6px;display:flex;align-items:center;gap:6px;letter-spacing:1px}
      .sf-ct::before{content:"";width:3px;height:12px;border-radius:2px;background:linear-gradient(#ffd46b,#ff9d6b)}
      .sf-row{display:flex;gap:5px;align-items:center;margin:4px 0;flex-wrap:wrap}
      .sf-row label{color:#8fa8d8;font-size:11px;min-width:50px}
      #sf-panel input{background:#0e1428;color:#e6edff;border:1px solid #334473;border-radius:6px;padding:3px 6px;font:12px monospace;flex:1;min-width:56px;outline:none}
      #sf-panel input:focus{border-color:#6d8fe0;box-shadow:0 0 0 2px #6d8fe033}
      #sf-panel button{background:linear-gradient(150deg,#28335a,#1c2544);color:#dbe6ff;border:1px solid #3a5bb0;border-radius:8px;
        padding:7px 6px;cursor:pointer;font:12px/1.2 inherit;font-weight:600;letter-spacing:.3px;transition:transform .08s,filter .15s}
      #sf-panel button:hover{filter:brightness(1.25)}#sf-panel button:active{transform:scale(.96)}
      #sf-panel button.on{background:linear-gradient(150deg,#1e8a56,#146b41);border-color:#4fd693;color:#eafff2;box-shadow:0 0 12px #28a06a55}
      .sf-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.sf-grid button{padding:8px 3px;font-size:11px}
      .sf-stat{display:flex;justify-content:space-between;padding:3px 0;color:#aebfe6;font-size:11px;border-bottom:1px dashed #ffffff0c}
      .sf-stat:last-child{border-bottom:none}.sf-stat b{color:#eaf1ff;font-variant-numeric:tabular-nums}
      .sf-gold{color:#ffd46b!important}.sf-green{color:#6ee7a8!important}.sf-blue{color:#8fc9ff!important}
      .sf-bar{height:4px;border-radius:3px;background:#0e1428;overflow:hidden;margin-top:4px}
      .sf-bar>i{display:block;height:100%;background:linear-gradient(90deg,#4a7dff,#9a6bff);border-radius:3px;transition:width .3s}
      .sf-live{margin-top:5px;padding:5px 8px;background:#0d1c14;border:1px solid #28a06a33;border-radius:7px;color:#8fe0b4;font-size:11px;min-height:17px}
      #sf-feed{max-height:240px;overflow-y:auto;background:linear-gradient(160deg,#101a2e,#0c1220);border:1px solid #2a3a66;
        border-radius:8px;padding:6px;margin-top:6px;scrollbar-width:thin}
      .sf-empty{color:#7f92bd;font-size:11px;text-align:center;padding:12px 4px}
      .sf-rcard{background:linear-gradient(140deg,#1a2745,#141c34);border:1px solid #2a3a66;border-radius:9px;padding:7px 9px;margin-bottom:6px}
      .sf-rcard.win{border-left:3px solid #3fd68a}.sf-rcard.lose{border-left:3px solid #ff7a7a}
      .sf-rtop{display:flex;align-items:center;gap:7px}
      .sf-rbadge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px}
      .sf-rcard.win .sf-rbadge{background:#1e7a4d;color:#d8ffe9}.sf-rcard.lose .sf-rbadge{background:#8a3030;color:#ffd8d8}
      .sf-rstars{color:#ffd46b;font-size:12px;letter-spacing:1px}.sf-rtime{margin-left:auto;color:#6f81ad;font-size:9.5px}
      .sf-re{color:#6ee7a8;font-size:11px;font-weight:700}
      .sf-rmeta{color:#9fb0d8;font-size:10px;margin-top:4px}
      .sf-rdrops{display:flex;flex-wrap:wrap;gap:3px;margin-top:5px}
      .sf-rdrops span{background:#233157;color:#bcd0f5;font-size:9.5px;padding:1px 6px;border-radius:5px;white-space:nowrap}
      .sf-other{margin-top:4px;padding-top:4px;border-top:1px dashed #ffffff14}
      .sf-oline{color:#7f92bd;font-size:10px;padding:1px 3px}.sf-oline.bad{color:#ff8a8a}
      .sf-dots{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
      .sf-dot{font-size:9.5px;padding:2px 6px;border-radius:10px;background:#222c4a;color:#7183ad}
      .sf-dot.on{background:#1e7a4d;color:#d8ffe9;box-shadow:0 0 8px #28a06a55}
      /* E 收益看板 */
      .sf-hero{background:linear-gradient(140deg,#1a2c2a,#122522)!important;border-color:#2a6a55!important}
      .sf-e-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:2px}
      .sf-e-grid>div{background:#0f1f18;border:1px solid #1e3a2c;border-radius:7px;padding:5px 3px;text-align:center;min-width:0;overflow:hidden}
      .sf-e-grid span{display:block;font-size:9px;color:#7f9a8a;white-space:nowrap}
      .sf-e-grid b{display:block;font-size:12px;color:#d8ffe9;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .sf-on{color:#6ee7a8;font-size:10px}.sf-off{color:#ff8a8a;font-size:10px}
      .sf-power{display:flex;justify-content:space-between;align-items:baseline;padding:4px 8px;background:linear-gradient(90deg,#2a2340,#1a2745);
        border:1px solid #4a3a7a;border-radius:8px;margin-bottom:6px}
      .sf-power span{color:#a99fd8;font-size:11px}
      .sf-power b{color:#d9b8ff;font-size:17px;font-weight:800;font-variant-numeric:tabular-nums;text-shadow:0 0 10px #9a6bff66}
      .sf-squad{display:flex;gap:4px;margin-bottom:6px}
      .sf-sq{flex:1;text-align:center;background:#141b32;border:1px solid #2a3a66;border-radius:6px;padding:3px 2px;min-width:0}
      .sf-sq b{display:block;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .sf-sq small{display:block;font-size:8.5px;color:#7f92bd;white-space:nowrap}
    `;
    document.head.appendChild(st);
  }

  function ensurePanel() {
    injectStyle();
    let p = $("sf-panel");
    if (p) return p;
    p = document.createElement("div");
    p.id = "sf-panel";
    document.body.appendChild(p);
    return p;
  }

  function render() {
    const p = ensurePanel();
    // 保焦点
    const ae = document.activeElement;
    const fid = ae && ae.id && ae.id.indexOf("sf-") === 0 ? ae.id : null;
    let ss = null, se = null;
    if (fid && typeof ae.selectionStart === "number") { ss = ae.selectionStart; se = ae.selectionEnd; }

    const st = stamina();
    const anyOn = Object.values(S.T).some((t) => t.run);
    const badge = !S.ready ? '<span class="sf-badge wait">等待登录</span>'
      : anyOn ? '<span class="sf-badge run">运行中</span>' : '<span class="sf-badge idle">待机</span>';
    const dot = (k, label) => `<span class="sf-dot ${S.T[k].run ? "on" : ""}">${label}${S.T[k].n ? " " + S.T[k].n : ""}</span>`;
    const btn = (id, label, on, wide) => `<button id="${id}" class="${on ? "on" : ""}" ${wide ? 'style="grid-column:span 3"' : ""}>${label}</button>`;

    const foldBtn = `<button id="sf-fold" class="sf-fold" title="${S.collapsed ? "展开" : "收起"}">${S.collapsed ? "展开 ▾" : "收起 ▴"}</button>`;
    p.innerHTML = `
      <div class="sf-head"><div class="sf-title">⭐ StarFarm<small>E助手</small></div>
        <div class="sf-head-r">${badge}${foldBtn}</div></div>
      ${S.collapsed ? "" : `
      <div class="sf-body">
        <!-- E 收益看板（核心目标） -->
        <div class="sf-card sf-hero">
          <div class="sf-ct">E 收益看板</div>
          <div class="sf-e-grid">
            <div><span>E 总额</span><b class="sf-green">${fmtE(siteE())}</b></div>
            <div><span>今日产出</span><b class="sf-green">+${fmtE(todayE())}</b></div>
            <div><span>本会话</span><b class="sf-green">+${fmtE(S.eGot)}</b></div>
            <div><span>场均 E</span><b class="sf-gold">${fmtE(S.runCount ? S.eGot / S.runCount : null)}</b></div>
            <div><span>累计场次</span><b>${S.runCount}</b></div>
            <div><span>今日副本</span><b>${todayRuns()}</b></div>
          </div>
          <div class="sf-stat"><span>双倍卡 <b class="sf-gold">${(typeof SAVE !== "undefined" && SAVE) ? SAVE.multi : 0}张</b> ${(typeof SAVE !== "undefined" && SAVE && SAVE.multiOn) ? '<span class="sf-on">生效中</span>' : '<span class="sf-off">未开</span>'}</span><span>${CFG.autoMulti ? "自动维持:开" : "自动维持:关"}</span></div>
        </div>

        <div class="sf-card">
          <div class="sf-ct">资源状态</div>
          <div class="sf-stat"><span>体力 <b class="sf-blue">${st.cur}/${st.max}</b></span><span>金币 <b class="sf-gold">${gold().toLocaleString()}</b></span><span>代币 <b>${tokens()}</b></span></div>
          <div class="sf-bar"><i style="width:${st.max ? Math.round(st.cur / st.max * 100) : 0}%"></i></div>
          <div class="sf-dots">
            ${dot("farm", "副本")}${dot("level", "升级")}${dot("star", "升星")}${dot("decomp", "分解")}
            ${dot("gacha", "召唤")}${dot("gem", "宝石")}${dot("shop", "商店")}
          </div>
        </div>

        <div class="sf-card">
          <div class="sf-ct">刷本赚E</div>
          <div class="sf-stat"><span>当前副本</span><b>${esc(stageName(latestStage()))}</b></div>
          <div class="sf-row"><label>场次</label><input id="sf-rounds" type="number" min="1" value="${CFG.rounds === Infinity ? "" : CFG.rounds}" placeholder="不限">
            <label style="min-width:auto">体力≥</label><input id="sf-minsta" type="number" min="1" value="${CFG.minStamina}" style="max-width:44px"></div>
          <div class="sf-grid">
            ${btn("sf-farm", S.T.farm.run ? "停止副本" : "后台刷E", S.T.farm.run)}
            ${btn("sf-fg", CFG.bgMode ? "后台:开" : "后台:关", CFG.bgMode)}
            ${btn("sf-multi", CFG.autoMulti ? "双倍:开" : "双倍:关", CFG.autoMulti)}
            ${btn("sf-token", CFG.farmWhenNoToken ? "池零续刷:开" : "池零续刷:关", CFG.farmWhenNoToken)}
          </div>
          <div class="sf-stat" style="margin-top:5px"><span>${S.done} 场 · 胜 <b class="sf-green">${S.wins}</b> 负 ${S.fails} · 3★ <b class="sf-gold">${S.stars3}</b></span><button id="sf-farm0" style="padding:2px 8px;font-size:10px">清空</button></div>
        </div>

        <div class="sf-card">
          <div class="sf-ct">队伍养成 · 服务刷E</div>
          <div class="sf-power"><span>出战战力</span><b>${teamPower().toLocaleString()}</b></div>
          <div class="sf-squad">${squadHTML()}</div>
          <div class="sf-grid">
            ${btn("sf-level", S.T.level.run ? "停止升级" : "升级满级", S.T.level.run)}
            ${btn("sf-star", S.T.star.run ? "停止升星" : "自动升星", S.T.star.run)}
            ${btn("sf-decomp", S.T.decomp.run ? "停止分解" : "分解碎片", S.T.decomp.run)}
            ${btn("sf-gem", S.T.gem.run ? "停止镶嵌" : "自动镶嵌", S.T.gem.run)}
            ${btn("sf-opt", "编队优化", false)}
            ${btn("sf-gacha", S.T.gacha.run ? "停止召唤" : "自动召唤", S.T.gacha.run)}
          </div>
          <div class="sf-row" style="margin-top:5px"><label>张数</label>
            <select id="sf-gnum" style="background:#0e1428;color:#e6edff;border:1px solid #334473;border-radius:6px;padding:3px 6px;font:12px monospace;flex:1">
              <option value="10" ${CFG.gachaCount === 10 ? "selected" : ""}>十连(1400)</option>
              <option value="1" ${CFG.gachaCount === 1 ? "selected" : ""}>单抽(150)</option>
            </select>
            <label style="min-width:auto">次数</label><input id="sf-glimit" type="number" min="1" value="${CFG.gachaLimit === Infinity ? "" : CFG.gachaLimit}" placeholder="不限" style="max-width:50px"></div>
          <div class="sf-stat"><span>升级 ${S.levelUps} · 升星 ${S.starUps} · 尘 +${S.decompDust} · 宝石 ${S.gemsSet} · 召唤 ${S.gachaPulls}(SSR ${S.gachaSSR})</span></div>
        </div>

        <div class="sf-card">
          <div class="sf-ct">实时动态 · 运行日志</div>
          <div class="sf-live">${esc(S.last || (S.ready ? "待命中 · 点击「后台刷E」开始攒 E" : "正在确认站点登录…"))}</div>
          <div id="sf-feed">${buildFeed()}</div>
        </div>
      </div>`}
    `;

    $("sf-fold").onclick = () => { S.collapsed = !S.collapsed; render(); };

    // ---- 事件绑定 ----
    const on = (id, evt, fn) => { const el = $(id); if (el) el[evt] = fn; };
    on("sf-rounds", "onchange", (e) => { const v = e.target.value; CFG.rounds = v === "" ? Infinity : Math.max(1, +v || 1); });
    on("sf-minsta", "onchange", (e) => { CFG.minStamina = Math.max(1, +e.target.value || 1); });
    on("sf-gnum", "onchange", (e) => { CFG.gachaCount = +e.target.value || 10; });
    on("sf-glimit", "onchange", (e) => { const v = e.target.value; CFG.gachaLimit = v === "" ? Infinity : Math.max(1, +v || 1); });
    on("sf-farm", "onclick", () => toggleTask("farm", farmTask));
    on("sf-fg", "onclick", () => { CFG.bgMode = !CFG.bgMode; log(`后台模式 ${CFG.bgMode ? "开启" : "关闭"}`); });
    on("sf-token", "onclick", () => { CFG.farmWhenNoToken = !CFG.farmWhenNoToken; log(`池零续刷 ${CFG.farmWhenNoToken ? "开启" : "关闭"}`); });
    on("sf-farm0", "onclick", () => { S.results = []; log("已清空结果记录"); });
    on("sf-level", "onclick", () => toggleTask("level", levelTask));
    on("sf-star", "onclick", () => toggleTask("star", starTask));
    on("sf-decomp", "onclick", () => toggleTask("decomp", decompTask));
    on("sf-gem", "onclick", () => toggleTask("gem", gemTask));
    on("sf-opt", "onclick", () => optimizeSquad());
    on("sf-multi", "onclick", () => { CFG.autoMulti = !CFG.autoMulti; log(`自动双倍卡 ${CFG.autoMulti ? "开启：刷本前自动开双倍" : "关闭"}`); if (CFG.autoMulti) ensureMulti(); });
    on("sf-gacha", "onclick", () => toggleTask("gacha", gachaTask));

    if (fid) {
      const el = $(fid);
      if (el) { el.focus(); if (ss != null && typeof el.setSelectionRange === "function") { try { el.setSelectionRange(ss, se); } catch (e) {} } }
    }
  }

  /* ============================================================
   * 任务框架
   * ============================================================ */
  function toggleTask(key, fn) {
    const t = S.T[key];
    if (t.run) { t.abort = true; log(`${taskName(key)}：停止中`, "warn"); }
    else { t.run = true; t.abort = false; t.n = 0; render(); fn(); }
  }
  function taskName(k) {
    return { farm: "副本", level: "升级", star: "升星", decomp: "分解", gacha: "召唤", gem: "镶嵌", shop: "商店" }[k] || k;
  }
  function taskEnd(key, msg) {
    S.T[key].run = false; render();
    log(`${taskName(key)}结束：${msg}`, "warn");
  }

  /* ============================================================
   * 任务 1：副本（后台静默 / 前台动画）
   * ============================================================ */
  async function farmTask() {
    hookFinishRun();
    if (CFG.bgMode && typeof nav === "function" && document.body.dataset.page === "page-battle") nav("page-stage");
    log(`刷E启动：${stageName(latestStage())} · 目标 ${CFG.rounds === Infinity ? "∞" : CFG.rounds} 场 · 自动双倍 ${CFG.autoMulti ? "开" : "关"}`, "ok");
    S.goldStart = gold(); S.stamStart = stamina().cur; S.siteStart = siteE();
    S.eStart = todayE();
    while (S.T.farm.run && !S.T.farm.abort) {
      if (CFG.rounds !== Infinity && S.done >= CFG.rounds) { taskEnd("farm", `已达 ${CFG.rounds} 场`); break; }
      const st = stamina();
      if (st.cur < CFG.minStamina) { log(`体力 ${st.cur}/${st.max} 低于 ${CFG.minStamina}，暂停`, "warn"); S.T.farm.run = false; render(); break; }
      if (!CFG.farmWhenNoToken && budgetLeft() <= 0) { log("今日池为0且池零续刷关闭，暂停", "warn"); S.T.farm.run = false; render(); break; }
      if (typeof battleRunning !== "undefined" && battleRunning) { await sleep(400); continue; }
      // 每场前维持双倍卡开启（E 产出翻倍，攒 E 核心）
      if (CFG.autoMulti) await ensureMulti();
      const ok = CFG.bgMode ? await fastRun() : await animRun();
      if (!ok) { log("本场失败，场次不计数；2秒后重试", "warn"); await sleep(2000); continue; }
      S.done++;   // 只在结算成功后计场次
      const se = siteE();
      if (se != null && S.siteStart != null) S.siteEarned = +(se - S.siteStart).toFixed(4);
      await sleep(CFG.gapMs);
    }
  }
  async function fastRun() {
    try {
      // 自愈：清理挂起 run / 战斗动画 / 幂等键
      await settleStuckRun();
      if (typeof BAT !== "undefined" && BAT && !BAT.settled) BAT.abort = true;
      if (typeof battleRunning !== "undefined") battleRunning = false;
      Store.pendingStart = null;
      let run = await Store.startRun(latestStage());
      if (!run || !run.id) {
        Store.pendingStart = null;
        try { await Store.refresh(); } catch (e) {}
        await settleStuckRun();
        Store.pendingStart = null;
        run = await Store.startRun(latestStage());
      }
      if (!run || !run.id) { log(`开局失败：${Store.lastError || "无run"}`, "bad"); return false; }
      await waitRunReady(run);
      let res = await Store.finishRun(run.id);
      if (!res) { await sleep(1500); res = await Store.finishRun(run.id); }
      if (!res) { log(`结算失败：${Store.lastError || "无结果"}`, "bad"); return false; }
      return true;
    } catch (e) { log(`后台异常：${e.message}`, "bad"); S.errors.push(e.message); return false; }
  }
  async function animRun() {
    try {
      await startBattle(latestStage());
      // 原生流程会弹结算框，自动关闭并回副本页，避免卡住下一场
      try { closeModal(); } catch (e) {}
      if (typeof nav === "function") nav("page-stage");
      return true;
    }
    catch (e) { log(`开战异常：${e.message}`, "bad"); return false; }
  }

  /* ============================================================
   * 任务 2：升级满级（含可选自动升星）
   * ============================================================ */
  async function levelTask() {
    if (typeof SAVE === "undefined" || !SAVE || !SAVE.girls) { log("升级：档案未就绪", "warn"); S.T.level.run = false; render(); return; }
    const MAX = (typeof GROWTH !== "undefined" && GROWTH.maxLevel) || 60;
    log(`升级启动：出战队伍全员 Lv${MAX}${CFG.autoStar ? " + 自动升星" : ""}`, "ok");
    while (S.T.level.run && !S.T.level.abort) {
      const squad = (SAVE.squad || []).slice().sort((a, b) => (SAVE.girls[a]?.level || 0) - (SAVE.girls[b]?.level || 0));
      if (!squad.length) break;
      const allMax = squad.every((id) => (SAVE.girls[id]?.level || 0) >= MAX);
      if (allMax) { log(`队伍已全部满级 Lv${MAX}`, "ok"); break; }
      let progressed = false, blocked = false;
      for (const id of squad) {
        if (S.T.level.abort) break;
        const o = SAVE.girls[id];
        if (!o || o.star <= 0) continue;
        const lv = o.level || 1;
        if (lv >= MAX) continue;
        const cost = 20 + lv * 15;
        if (gold() - cost < CFG.levelReserve) { blocked = true; continue; }
        const ok = await safeMutate("level", { girl_id: id });
        if (ok) {
          progressed = true; S.levelUps++; S.T.level.n++;
          const g = GIRLS.find((x) => x.id === id);
          log(`升级 ${g ? g.name : id} Lv${lv}→${SAVE.girls[id].level}`, "ok");
        }
        await sleep(180);
      }
      // 顺便升星
      if (CFG.autoStar) {
        for (const id of squad) {
          if (S.T.level.abort) break;
          if (await tryStarUp(id, true)) progressed = true;
          await sleep(180);
        }
      }
      if (blocked && !progressed) { log(`金币不足，3秒后重试（可开副本赚钱）`, "warn"); await sleep(3000); }
      else if (!progressed) break;
      else await sleep(200);
    }
    taskEnd("level", `升级 ${S.levelUps} 次 / 升星 ${S.starUps} 次`);
  }

  /* ============================================================
   * 任务 3：自动升星
   * ============================================================ */
  async function tryStarUp(id, quiet) {
    try {
      const g = GIRLS.find((x) => x.id === id);
      const o = SAVE.girls[id];
      if (!g || !o || o.star <= 0 || o.star >= GROWTH.starMax) return false;
      const nextStar = o.star + 1;
      const needShard = GROWTH.starCost[nextStar] || 0;
      const shards = (o.shards || 0) + (SAVE.mats.shard_dust || 0);
      const matKey = MAT_BY_RARITY[g.rarity];
      const needMat = MAT_STAR_COST[g.rarity];
      if (shards < needShard || (SAVE.mats[matKey] || 0) < needMat) return false;
      const res = await safeMutate("star", { girl_id: id });
      if (res) {
        S.starUps++; S.T.star.n++;
        if (!quiet) log(`升星 ${g.name} → ${nextStar}★`, "ok");
        return true;
      }
    } catch (e) {}
    return false;
  }
  async function starTask() {
    log("升星启动：扫描所有角色", "ok");
    while (S.T.star.run && !S.T.star.abort) {
      let did = 0;
      const owned = Object.keys(SAVE.girls || {}).filter((id) => SAVE.girls[id].star > 0);
      // 优先升出战队伍，再按星级从高到低
      owned.sort((a, b) => (SAVE.squad.includes(b) ? 1 : 0) - (SAVE.squad.includes(a) ? 1 : 0) || SAVE.girls[b].star - SAVE.girls[a].star);
      for (const id of owned) {
        if (S.T.star.abort) break;
        if (await tryStarUp(id, false)) did++;
        await sleep(180);
      }
      if (!did) { log("暂无可升星角色（碎片/材料不足）", "warn"); break; }
      await sleep(400);
    }
    taskEnd("star", `共升星 ${S.starUps} 次`);
  }

  /* ============================================================
   * 任务 4：分解多余碎片
   * ============================================================ */
  function reserveOf(g, o) {
    if (!o || o.star < 1) return RARITY[g.rarity].shardToUnlock;
    if (o.star >= GROWTH.starMax) return 0;
    return GROWTH.starCost[o.star + 1] || 0;
  }
  async function decompTask() {
    log("分解启动：扫描所有角色多余碎片", "ok");
    let cnt = 0, dust = 0;
    for (const g of GIRLS) {
      if (S.T.decomp.abort) break;
      const o = SAVE.girls[g.id];
      const extra = Math.max(0, (o?.shards || 0) - reserveOf(g, o));
      if (extra < 1) continue;
      const res = await safeMutate("shard_decompose", { girl_id: g.id, count: extra });
      if (res && res.decomposition) {
        cnt++; dust += res.decomposition.dust || 0;
        log(`分解 ${g.name} ×${res.decomposition.shards} → 尘 +${res.decomposition.dust}`, "ok");
      } else log(`分解失败 ${g.name}`, "bad");
      await sleep(300);
    }
    S.decompDust += dust; S.T.decomp.n += cnt;
    taskEnd("decomp", `分解 ${cnt} 人，共鸣尘 +${dust}`);
  }

  /* ============================================================
   * 任务 5：自动召唤
   * ============================================================ */
  async function gachaTask() {
    if (typeof Store === "undefined" || !Store.ready()) { log("召唤：游戏未就绪", "warn"); S.T.gacha.run = false; render(); return; }
    const count = CFG.gachaCount;
    const cost = count === 10 ? 1400 : 150;
    log(`召唤启动：${count}连 / ${cost}金币 / 上限 ${CFG.gachaLimit === Infinity ? "∞" : CFG.gachaLimit}`, "ok");
    while (S.T.gacha.run && !S.T.gacha.abort) {
      if (CFG.gachaLimit !== Infinity && S.gachaPulls >= CFG.gachaLimit) break;
      if (gold() - cost < CFG.gachaReserve) { log(`金币不足（现 ${gold()}，需 ${cost}），3秒后重试`, "warn"); await sleep(3000); continue; }
      const res = await safeMutate("gacha", { count });
      if (!res) { log("召唤失败，3秒后重试", "bad"); await sleep(3000); continue; }
      S.gachaPulls++; S.T.gacha.n++;
      let ssr = 0, sr = 0, nw = 0; const names = [];
      for (const r of (res.results || [])) {
        const g = GIRLS.find((x) => x.id === r.girl_id);
        if (!g) continue;
        if (g.rarity === "SSR") ssr++; else if (g.rarity === "SR") sr++;
        if (r.is_new) nw++;
        names.push(`${g.name}${r.is_new ? "✨" : ""}${g.rarity === "SSR" ? "★" : ""}`);
      }
      S.gachaSSR += ssr; S.gachaSR += sr; S.gachaNew += nw;
      log(`第${S.gachaPulls}抽：${names.join("、")}${ssr ? "【出金】" : ""}`, ssr ? "ok" : "");
      await sleep(500);
    }
    taskEnd("gacha", `${S.gachaPulls}抽 · SSR${S.gachaSSR}/SR${S.gachaSR}/新${S.gachaNew}`);
  }

  /* ============================================================
   * 任务 6：自动镶嵌宝石
   * 策略：DPS→赤曜石(攻)/紫晶(暴)/风灵晶(速)；坦克→生命翡翠/坚壁蓝宝石；辅助→赤曜石/风灵晶
   * ============================================================ */
  async function gemTask() {
    log("镶嵌启动：开孔 + 镶最优宝石", "ok");
    const prefer = (role) => {
      if (role === "tank") return ["jade", "sapphire", "ruby"];
      if (role === "heal" || role === "support") return ["ruby", "wind", "jade"];
      return ["ruby", "amethyst", "wind"];
    };
    for (const id of (SAVE.squad || [])) {
      if (S.T.gem.abort) break;
      const g = GIRLS.find((x) => x.id === id), o = SAVE.girls[id];
      if (!g || !o || o.star <= 0) continue;
      const matKey = MAT_BY_RARITY[g.rarity];
      // 开孔
      for (let slot = (o.sockets || 0) + 1; slot <= 3; slot++) {
        const cost = GEM_SOCKET_COST[slot - 1];
        if (gold() < cost.gold || (SAVE.mats[matKey] || 0) < cost.mat) break;
        const r = await safeMutate("gem_socket", { girl_id: id, count: slot });
        if (!r) break;
        log(`${g.name} 开第${slot}孔`, "ok");
        await sleep(250);
      }
      // 镶嵌（补满已开的孔）
      const inv = SAVE.gem_inventory || {};
      const order = prefer(g.role);
      for (let slot = 1; slot <= (o.sockets || 0); slot++) {
        if (o.gems && o.gems[slot - 1]) continue;
        const gemId = order.find((x) => (inv[x] || 0) > 0);
        if (!gemId) break;
        const r = await safeMutate("gem_equip", { girl_id: id, count: slot, item_id: gemId });
        if (!r) break;
        S.gemsSet++; S.T.gem.n++;
        log(`${g.name} 第${slot}孔镶 ${GEMS[gemId].name}`, "ok");
        await sleep(250);
      }
    }
    taskEnd("gem", `镶嵌 ${S.gemsSet} 颗`);
  }

  // 攒E核心：有双倍卡且未开启时自动开启，让副本 E 产出翻倍。
  async function ensureMulti() {
    try {
      if (typeof SAVE === "undefined" || !SAVE) return;
      if (SAVE.multi <= 0) return;              // 没有双倍卡
      if (SAVE.multiOn) return;                 // 已开启
      const res = await safeMutate("multi", { enabled: true });
      if (res) log(`自动开启双倍卡（余 ${SAVE.multi} 张）· E 产出翻倍`, "ok");
    } catch (e) {}
  }

  /* ============================================================
   * 编队优化：按战力 + 职业搭配选最强 4 人
   * ============================================================ */
  async function optimizeSquad() {
    if (typeof SAVE === "undefined" || !SAVE) return;
    const owned = Object.keys(SAVE.girls).filter((id) => SAVE.girls[id].star > 0);
    const score = (id) => {
      const g = GIRLS.find((x) => x.id === id);
      const pw = typeof powerOf === "function" ? powerOf(id) : 0;
      const roleBonus = { tank: 1.05, heal: 1.05, support: 1.02, sdps: 1.04, adps: 1.03 }[g?.role] || 1;
      return Math.round(pw * roleBonus);
    };
    owned.sort((a, b) => score(b) - score(a));
    const pick = [];
    // 保证 1坦 1奶/辅（若有），其余填最高战力
    const tank = owned.find((id) => GIRLS.find((g) => g.id === id)?.role === "tank");
    const heal = owned.find((id) => ["heal", "support"].includes(GIRLS.find((g) => g.id === id)?.role));
    if (tank) pick.push(tank);
    if (heal && heal !== tank) pick.push(heal);
    for (const id of owned) { if (pick.length >= 4) break; if (!pick.includes(id)) pick.push(id); }
    const res = await safeMutate("squad", { squad: pick.slice(0, 4) });
    if (res) {
      log(`编队优化：${pick.slice(0, 4).map((id) => GIRLS.find((g) => g.id === id)?.name).join("、")}`, "ok");
    } else log("编队调整失败", "bad");
  }

  /* ============================================================
   * 分析（控制台）
   * ============================================================ */
  function analyze() {
    if (!S.ready || typeof SAVE === "undefined" || !SAVE) return "未就绪";
    const squad = (SAVE.squad || []).map((id, i) => {
      const g = GIRLS.find((x) => x.id === id), o = SAVE.girls[id];
      return { 位: i + 1, 名: g?.name, 稀有: g?.rarity, 元素: g && ELEM[g.elem]?.name, 职: g?.role, Lv: o?.level, 星: o?.star, 战力: typeof powerOf === "function" ? powerOf(id) : 0 };
    });
    const stages = STAGES.map((s) => ({ id: s.id, 名: s.name, 类型: s.type, Lv: s.enemyLv, 星: SAVE.stars?.[s.id] || 0, 通: !!SAVE.cleared?.[s.id], 币: s.tokenRange.join("-"), 金: s.gold.join("-") }));
    console.table(squad); console.table(stages);
    return { squad, stages };
  }

  /* ============================================================
   * 公共 API
   * ============================================================ */
  window.starfarm = {
    start: (key) => { const fn = { farm: farmTask, level: levelTask, star: starTask, decomp: decompTask, gacha: gachaTask, gem: gemTask }[key || "farm"]; if (fn) toggleTask(key || "farm", fn); return "started"; },
    stop: (key) => { if (key && S.T[key]) { S.T[key].abort = true; S.T[key].run = false; } else Object.values(S.T).forEach((t) => { t.abort = true; t.run = false; }); render(); return "stopped"; },
    set: (cfg) => { Object.assign(CFG, cfg); render(); return { ...CFG }; },
    status: () => ({
      ready: S.ready, tasks: JSON.parse(JSON.stringify(S.T)),
      gold: gold(), stamina: stamina(), siteE: siteE(), todayE: todayE(), todayRuns: todayRuns(),
      eGot: S.eGot, eGotTotal: S.eGotTotal, runCount: S.runCount,
      autoMulti: CFG.autoMulti, multiOn: (typeof SAVE !== "undefined" && SAVE) ? SAVE.multiOn : null, multiCards: (typeof SAVE !== "undefined" && SAVE) ? SAVE.multi : null,
      tokens: tokens(), budget: budgetLeft(), stage: stageName(latestStage()),
      teamPower: teamPower(), squad: (typeof SAVE !== "undefined" && SAVE) ? (SAVE.squad || []).slice() : [],
      done: S.done, wins: S.wins, fails: S.fails, stars3: S.stars3,
      stats: { levelUps: S.levelUps, starUps: S.starUps, decompDust: S.decompDust, gachaPulls: S.gachaPulls, gachaSSR: S.gachaSSR, gachaSR: S.gachaSR, gachaNew: S.gachaNew, gemsSet: S.gemsSet },
      results: S.results.slice(0, 5), errors: S.errors.slice(-5), cfg: { ...CFG },
    }),
    analyze,
    optimize: optimizeSquad,
    multi: () => { CFG.autoMulti = !CFG.autoMulti; log(`自动双倍卡 ${CFG.autoMulti ? "开启" : "关闭"}`); if (CFG.autoMulti) ensureMulti(); return CFG.autoMulti; },
  };

  /* ============================================================
   * 启动
   * ============================================================ */
  async function waitReady() {
    for (let i = 0; i < 120; i++) {
      if (typeof Store !== "undefined" && Store.ready && Store.ready()) {
        S.ready = true; hookFinishRun(); render(); log("已就绪", "ok"); return;
      }
      await sleep(500);
    }
    log("等待登录超时：请确认站点已登录", "warn");
  }
  render();
  setInterval(() => {
    // 用户正在操作下拉框时跳过本次重绘，避免把展开的菜单强制收起
    const a = document.activeElement;
    if (a && a.tagName === "SELECT" && a.id && a.id.indexOf("sf-") === 0) return;
    try { render(); } catch (e) {}
  }, CFG.uiTickMs);
  waitReady();
  console.log("%c[StarFarm V2] 已注入。控制台: starfarm.status() / start('farm'|'level'|...) / optimize() / analyze()", "color:#ffd46b;font-size:13px");
})();
