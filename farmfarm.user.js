// ==UserScript==
// @name         FarmFarm - Ultra Router Farm Automation
// @namespace    https://ultrarouter.org/farm/
// @version      0.0.7
// @description  Auto farm for ultrarouter.org/farm: harvest, plant best crop, water/fertilize, steal from neighbors. Server-authoritative.
// @author       FarmFarm
// @updateURL     https://raw.githubusercontent.com/mowsxc/starfarm/main/farmfarm.user.js
// @downloadURL   https://raw.githubusercontent.com/mowsxc/starfarm/main/farmfarm.user.js
// @match        https://ultrarouter.org/farm
// @match        https://ultrarouter.org/farm/
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";
  if (window.__FF && window.__FF.ready) { console.warn("[FF] already loaded"); return; }

  /* ============================================================
   * CONFIG
   * ============================================================ */
  const CFG = {
    // 策略
    cropId: 17,          // 种植作物：17=杨梅(效率最高) 29=荔枝(单次最高) 0=自动选效率最高
    autoBest: true,      // 自动选当前可用作物中效率最高的
    // 操作开关
    autoHarvest: true,   // 自动收取成熟作物
    autoPlant: true,     // 自动补种空地/枯地
    autoWater: true,     // 自动浇水（每次 -1分钟生长）
    autoFert: true,      // 自动施肥（每次 -1分钟，每天20次）
    autoSteal: true,     // 自动偷邻居（每天10次）
    stealOnlyId: 29,     // 只偷这个作物：29=荔枝(单价172，全场最高)；0=偷当前刷出的最高单价
    minStealPrice: 60,   // 兜底阈值（stealOnlyId=0时使用）
    stealTopOnly: true,  // 偷当前最高单价一档（stealOnlyId=0时使用）
    stealRefreshMs: 8000,// 没高价值作物时，多久重刷一次邻居列表
    // 节奏
    tickMs: 3000,        // 主循环间隔
    stealInterval: 60000,// 偷菜扫描间隔
    // 通用
    logLimit: 60,
  };

  const S = {
    ready: false, installed: true,
    run: false, abort: false, cycle: 0,
    level: 0, exp: 0, expNext: 0, quota: 0,
    daily: {}, plots: [], neighbors: [],
    harvestE: 0, stealE: 0, harvestCount: 0, stealCount: 0, plantCount: 0,
    results: [], logs: [], errors: [], last: "",
    lastStealAt: 0, lastSyncAt: 0,
    lastStealScan: 0,
    gen: 0,   // 循环代次：stop/start 时递增，防止旧循环残留并行
    cropName: {},
  };
  window.__FF = S;

  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clock = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

  // 作物数据(id/pr=yield*price/tt/rh/se/lv)——从游戏源码提取
  const CROPS = [
    {id:1,lv:0,pr:34,y:16,se:1,rh:0,tt:600,exp:15,sp:125},
    {id:7,lv:1,pr:44,y:17,se:1,rh:0,tt:840,exp:19,sp:168},
    {id:24,lv:2,pr:42,y:18,se:1,rh:0,tt:840,exp:19,sp:168},
    {id:2,lv:3,pr:46,y:17,se:1,rh:0,tt:840,exp:19,sp:175},
    {id:21,lv:4,pr:48,y:18,se:1,rh:0,tt:900,exp:20,sp:188},
    {id:23,lv:5,pr:50,y:20,se:1,rh:0,tt:960,exp:21,sp:237},
    {id:19,lv:6,pr:52,y:21,se:1,rh:0,tt:1020,exp:22,sp:251},
    {id:18,lv:7,pr:54,y:22,se:1,rh:0,tt:1080,exp:23,sp:266},
    {id:25,lv:7,pr:54,y:21,se:1,rh:0,tt:1080,exp:23,sp:266},
    {id:28,lv:8,pr:56,y:24,se:1,rh:540,tt:1200,exp:25,sp:296},
    {id:16,lv:9,pr:60,y:25,se:1,rh:0,tt:1320,exp:27,sp:325},
    {id:3,lv:10,pr:54,y:24,se:2,rh:660,tt:1440,exp:20,sp:605},
    {id:5,lv:10,pr:48,y:23,se:2,rh:540,tt:1260,exp:18,sp:578},
    {id:6,lv:12,pr:64,y:29,se:2,rh:840,tt:1860,exp:25,sp:900},
    {id:22,lv:13,pr:80,y:32,se:2,rh:1080,tt:2520,exp:33,sp:1200},
    {id:4,lv:15,pr:90,y:30,se:2,rh:540,tt:1260,exp:28,sp:1800},
    {id:27,lv:16,pr:108,y:30,se:3,rh:1320,tt:3120,exp:34,sp:2425},
    {id:8,lv:17,pr:110,y:27,se:3,rh:1080,tt:2460,exp:16,sp:2600},
    {id:26,lv:17,pr:116,y:33,se:3,rh:1560,tt:3660,exp:39,sp:2855},
    {id:9,lv:19,pr:130,y:27,se:4,rh:1380,tt:3300,exp:32,sp:3720},
    {id:20,lv:22,pr:156,y:33,se:4,rh:1800,tt:4320,exp:42,sp:5527},
    {id:29,lv:23,pr:172,y:34,se:4,rh:1860,tt:4620,exp:44,sp:6588},
    {id:17,lv:27,pr:168,y:27,se:5,rh:840,tt:1860,exp:18,sp:6600},
  ];
  const CROP_BY_ID = {};
  CROPS.forEach(c => CROP_BY_ID[c.id] = c);
  // 效率 = 每季收益 / 整个生命周期时间；偷菜收益 = 单价（高单价优先）
  function cropRate(c) { return (c.y * c.pr * 40 / 500000) / ((c.tt + (c.se - 1) * c.rh) / 3600); }
  function stealValue(c) { return Math.min(3, Math.ceil(c.y * 0.2)) * c.pr; }

  /* ============================================================
   * iframe 访问
   * ============================================================ */
  let frame = null;
  function getFrame() {
    if (frame && frame.contentWindow && frame.contentWindow.api) return frame;
    frame = Array.from(document.querySelectorAll("iframe")).find(f => (f.src || "").includes("farm-assets/game.html")) || null;
    return frame;
  }
  function gw() { const f = getFrame(); return f ? f.contentWindow : null; }
  function ready() {
    const w = gw();
    return !!(w && typeof w.api === "function" && w.__farm && Array.isArray(w.__farm.plots));
  }
  async function api(path, body) {
    const w = gw();
    if (!w || typeof w.api !== "function") throw new Error("游戏未就绪");
    const d = await w.api(path, body);
    // 关键：游戏的 act() 会调 applyState(data.state) 更新 game；
    // 我们直接调 api() 绕过了它。这里手动把状态写回 window.__farm，
    // 否则 syncState() 永远读到旧数据（导致空收/空种/重复操作）。
    if (d && d.state && w.__farm) {
      try { w.applyState(d.state); } catch (e) {
        // applyState 不可访问时，手动合并关键字段
        const s = d.state;
        Object.assign(w.__farm, {
          level: s.level || w.__farm.level, exp: s.exp || w.__farm.exp,
          expNext: s.exp_next || w.__farm.expNext, quota: s.quota || w.__farm.quota,
          daily: s.daily || w.__farm.daily, records: s.records || w.__farm.records,
          plots: (s.plots || []).map(p => ({
            idx: p.idx, cropId: p.crop_id || 0, cropName: p.crop_name || "",
            season: p.season || 0, seasons: p.seasons || 1, withered: !!p.withered,
            watered: !!p.watered, growth: p.growth || 0, total: p.total || 0, ready: !!p.ready,
          })),
        });
      }
    }
    return d;
  }
  function syncState() {
    const w = gw();
    if (!w || !w.__farm) return;
    const g = w.__farm;
    S.level = g.level || 0; S.exp = g.exp || 0; S.expNext = g.expNext || 0;
    S.quota = g.quota || 0; S.daily = g.daily || {};
    S.plots = (g.plots || []).map(p => ({ ...p }));
  }

  /* ============================================================
   * 日志 & UI
   * ============================================================ */
  function log(msg, kind) {
    S.last = `[${clock()}] ${msg}`;
    S.logs.push(S.last);
    if (S.logs.length > CFG.logLimit) S.logs.shift();
    console.log("[FarmFarm]", msg);
    render();
  }
  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]); }
  function fmtE(q) { const n = (+q || 0) / 500000; return n >= 100 ? (n / 1000).toFixed(1) + "K" : n.toFixed(2); }
  function cropName(id) {
    try {
      const w = gw();
      const def = w && w.CROP_BY_ID && w.CROP_BY_ID[id];
      if (def && def.name) return def.name;
    } catch (e) {}
    // 游戏内 CROP_BY_ID 是顶层 const，油猴主世界可能读不到；用本地表兜底
    const NAMES = { 1:"白萝卜",7:"大白菜",24:"小麦",2:"玉米",21:"土豆",23:"茄子",19:"番茄",18:"红玫瑰",25:"豌豆",28:"辣椒",16:"南瓜",3:"草莓",5:"苹果",6:"香蕉",22:"桃子",4:"非洲菊",27:"石榴",8:"蘑菇",26:"柚子",9:"椰子",20:"樱桃",29:"荔枝",17:"杨梅" };
    return NAMES[id] || ("#" + id);
  }

  function buildFeed() {
    if (!S.results.length && !S.logs.length) return '<div class="ff-empty">暂无动态 · 点击「自动农场」开始</div>';
    let h = "";
    for (const r of S.results.slice(0, 12)) {
      h += `<div class="ff-card ${r.kind}"><div class="ff-ctop"><span class="ff-badge">${r.kind === "harvest" ? "收获" : r.kind === "steal" ? "偷取" : "播种"}</span>
        <b>+${fmtE(r.e)} E</b><span class="ff-time">${esc(r.at)}</span></div>
        <div class="ff-cmeta">${esc(r.name)}${r.n ? " ×" + r.n : ""}${r.extra ? " · " + esc(r.extra) : ""}</div></div>`;
    }
    const others = S.logs.slice(-6).reverse().filter(l => !l.includes("收获") && !l.includes("偷到") && !l.includes("种下"));
    if (others.length) h += `<div class="ff-other">${others.map(l => `<div>${esc(l.replace(/^\[[^\]]+\]\s*/, ""))}</div>`).join("")}</div>`;
    return h;
  }

  function injectStyle() {
    if ($("ff-style")) return;
    const st = document.createElement("style"); st.id = "ff-style";
    st.textContent = `
      #ff-panel{position:fixed;right:14px;top:14px;z-index:2147483600;width:330px;max-height:94vh;overflow-y:auto;overflow-x:hidden;
        background:linear-gradient(160deg,rgba(16,36,24,.97),rgba(8,20,14,.97));color:#e6f5ea;
        border:1px solid rgba(90,180,120,.4);border-radius:16px;box-shadow:0 10px 40px #000b;
        font:12px/1.5 -apple-system,"Segoe UI",ui-monospace,Consolas,monospace;scrollbar-width:thin;scrollbar-color:#3a7a55 transparent}
      #ff-panel::-webkit-scrollbar{width:6px}#ff-panel::-webkit-scrollbar-thumb{background:#3a7a55;border-radius:3px}
      .ff-head{position:sticky;top:0;z-index:2;padding:11px 13px 9px;background:linear-gradient(135deg,#1d4a32,#12301f);
        border-bottom:1px solid #ffffff12;border-radius:16px 16px 0 0;display:flex;align-items:center;justify-content:space-between}
      .ff-title{font-size:14px;font-weight:700;background:linear-gradient(90deg,#8fe0a8,#ffd46b);-webkit-background-clip:text;background-clip:text;color:transparent}
      .ff-title small{font-size:10px;color:#8fbf9a;-webkit-text-fill-color:#8fbf9a;font-weight:400;margin-left:4px}
      .ff-badge{font-size:10px;padding:3px 9px;border-radius:20px;background:#2a3352;color:#9fb0d8}
      .ff-badge.run{background:linear-gradient(90deg,#1e7a4d,#28a06a);color:#eafff2}
      .ff-body{padding:9px 11px 12px}
      .ff-cardbox{background:linear-gradient(150deg,#163024,#102018);border:1px solid #ffffff0d;border-radius:11px;padding:8px 10px;margin-bottom:8px}
      .ff-ct{font-size:11px;font-weight:700;color:#9fd8b0;margin-bottom:6px;display:flex;align-items:center;gap:6px;letter-spacing:1px}
      .ff-ct::before{content:"";width:3px;height:12px;border-radius:2px;background:linear-gradient(#8fe0a8,#ffd46b)}
      .ff-stat{display:flex;justify-content:space-between;padding:3px 0;color:#a9d8b8;font-size:11px;border-bottom:1px dashed #ffffff0c}
      .ff-stat b{color:#eaf1ff;font-variant-numeric:tabular-nums}
      .ff-green{color:#6ee7a8!important}.ff-gold{color:#ffd46b!important}.ff-blue{color:#8fc9ff!important}
      .ff-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:5px;margin-top:5px}
      #ff-panel button{background:linear-gradient(150deg,#21402e,#183024);color:#dbe6ff;border:1px solid #3a7a55;
        border-radius:8px;padding:7px 6px;cursor:pointer;font:12px/1.2 inherit;font-weight:600;transition:filter .15s}
      #ff-panel button:hover{filter:brightness(1.25)}
      #ff-panel button.on{background:linear-gradient(150deg,#1e8a56,#146b41);border-color:#4fd693;color:#eafff2}
      #ff-panel select,#ff-panel input{background:#0e1c14;color:#e6f5ea;border:1px solid #3a6a4a;border-radius:6px;padding:3px 6px;font:12px monospace;flex:1;min-width:50px;outline:none}
      .ff-row{display:flex;gap:6px;align-items:center;margin:5px 0;flex-wrap:wrap}
      .ff-row label{color:#8fbf9a;font-size:11px;min-width:44px}
      .ff-feed{max-height:250px;overflow-y:auto;background:#0a1810;border-radius:8px;padding:6px;margin-top:6px}
      .ff-empty{color:#7f9a8a;text-align:center;padding:12px;font-size:11px}
      .ff-card{background:linear-gradient(140deg,#153026,#102018);border:1px solid #2a5a3a;border-radius:9px;padding:6px 8px;margin-bottom:5px}
      .ff-card.steal{border-left:3px solid #b7d86e}.ff-card.harvest{border-left:3px solid #4fd693}.ff-card.plant{border-left:3px solid #6ea0ff}
      .ff-ctop{display:flex;align-items:center;gap:7px}.ff-badge{font-size:9px;padding:2px 7px;border-radius:20px;background:#1e5a38;color:#d8ffe9}
      .ff-ctop b{color:#6ee7a8;font-size:11px}.ff-time{margin-left:auto;color:#6f8a7a;font-size:9px}
      .ff-cmeta{color:#9fb4a8;font-size:10px;margin-top:3px}
      .ff-other div{color:#7f9a8a;font-size:10px;padding:1px 2px}
    `;
    document.head.appendChild(st);
  }
  function panel() {
    injectStyle();
    let p = $("ff-panel");
    if (!p) { p = document.createElement("div"); p.id = "ff-panel"; document.body.appendChild(p); }
    return p;
  }
  function render() {
    const p = panel();
    const st = S.plots.length;
    const ready = S.plots.filter(x => x.ready).length;
    const empty = S.plots.filter(x => !x.cropId || x.withered).length;
    const growing = S.plots.filter(x => x.cropId && !x.ready && !x.withered).length;
    const badge = !S.ready ? '<span class="ff-badge">等待游戏</span>' : S.run ? '<span class="ff-badge run">运行中</span>' : '<span class="ff-badge">待机</span>';
    const best = pickBestCrop();
    p.innerHTML = `
      <div class="ff-head"><div class="ff-title">🌾 FarmFarm<small>0.0.7</small></div>${badge}</div>
      <div class="ff-body">
        <div class="ff-cardbox">
          <div class="ff-ct">E 收益看板</div>
          <div class="ff-stat"><span>本次收获</span><b class="ff-green">+${S.harvestE.toFixed(2)} E</b></div>
          <div class="ff-stat"><span>本次偷取</span><b class="ff-gold">+${S.stealE.toFixed(2)} E</b></div>
          <div class="ff-stat"><span>今日收获额度</span><b>${fmtE(S.daily.harvest_quota || 0)} E</b></div>
          <div class="ff-stat"><span>等级 / 经验</span><b>Lv.${S.level} · ${S.exp}/${S.expNext}</b></div>
        </div>
        <div class="ff-cardbox">
          <div class="ff-ct">田地状态</div>
          <div class="ff-stat"><span>成熟 / 生长 / 空地</span><b><span class="ff-green">${ready}</span> / <span class="ff-blue">${growing}</span> / ${empty}</b></div>
          <div class="ff-stat"><span>当前作物</span><b>${esc(S.cropName[CFG.cropId] || ("#" + CFG.cropId))}</b></div>
          <div class="ff-stat"><span>推荐(效率最高)</span><b class="ff-gold">${esc(S.cropName[best] || ("#" + best))}</b></div>
          <div class="ff-row"><label>种植</label>
            <select id="ff-crop">
              <option value="0" ${CFG.cropId === 0 ? "selected" : ""}>自动选最优</option>
              <option value="17" ${CFG.cropId === 17 ? "selected" : ""}>杨梅(效率王)</option>
              <option value="29" ${CFG.cropId === 29 ? "selected" : ""}>荔枝(单次最高)</option>
              <option value="20" ${CFG.cropId === 20 ? "selected" : ""}>樱桃</option>
            </select>
          </div>
          <div class="ff-grid">
            <button id="ff-run" class="${S.run ? "on" : ""}">${S.run ? "停止农场" : "自动农场"}</button>
            <button id="ff-once">执行一次</button>
          </div>
        </div>
        <div class="ff-cardbox">
          <div class="ff-ct">实时动态</div>
          <div class="ff-feed">${buildFeed()}</div>
        </div>
      </div>
    `;
    $("ff-run").onclick = () => toggle();
    $("ff-once").onclick = () => oneCycle();
    $("ff-crop").onchange = e => { CFG.cropId = +e.target.value; log("种植作物：" + (CFG.cropId ? cropName(CFG.cropId) : "自动最优")); };
  }

  /* ============================================================
   * 策略
   * ============================================================ */
  function pickBestCrop() {
    if (CFG.cropId && CFG.cropId !== 0) return CFG.cropId;
    const w = gw();
    const lv = (w && w.__farm && w.__farm.level) || S.level || 99;
    const avail = CROPS.filter(c => c.lv <= lv);
    avail.sort((a, b) => cropRate(b) - cropRate(a));
    return avail[0] ? avail[0].id : 17;
  }
  function pushResult(kind, e, name, n, extra) {
    S.results.unshift({ kind, e: +e.toFixed(4), name, n, extra, at: clock() });
    if (S.results.length > 30) S.results.pop();
  }
  async function doAct(path, body, label) {
    try {
      const d = await api(path, body);
      // act() 只更新游戏内部 game 状态，我们的 S.plots 是快照；
      // 每次操作后立即重同步，避免用旧快照判断（空收/空种/重复施肥）。
      syncState();
      return d;
    } catch (e) { S.errors.push(label + ":" + e.message); log(label + "失败：" + e.message, "bad"); return null; }
  }

  async function oneCycle() {
    if (!ready()) { log("游戏未就绪，请从侧边栏「我的农场」进入", "warn"); return; }
    syncState();
    // 1) 收获成熟
    if (CFG.autoHarvest) {
      const beforeQuota = S.daily.harvest_quota || 0;
      const mature = S.plots.filter(p => p.ready && !p.withered);
      if (mature.length) {
        const d = await doAct("/harvest-all", {}, "收取");
        if (d) {
          const gained = Math.max(0, (S.daily.harvest_quota || 0) - beforeQuota);
          const e = gained / 500000 || (d.reward_quota || 0) / 500000;
          S.harvestE += e; S.harvestCount += mature.length;
          if (gained > 0) {
            pushResult("harvest", e, "一键收取", mature.length, d.message || "");
            log(`收取 ${mature.length} 块地 · +${e.toFixed(2)} E`, "ok");
          }
        }
      }
    }
    // 2) 清枯地
    const withered = S.plots.filter(p => p.withered);
    if (withered.length && CFG.autoPlant) {
      const d = await doAct("/shovel-all", {}, "掘地");
      if (d) log(`清理 ${withered.length} 块枯地`, "ok");
    }
    // 3) 补种空地
    const cropId = pickBestCrop();
    const empty = S.plots.filter(p => !p.cropId || p.withered);
    if (CFG.autoPlant && empty.length) {
      let planted = 0;
      for (const p of empty) {
        // 用最新快照复查，跳过已经种上的地
        const cur = S.plots.find(x => x.idx === p.idx);
        if (cur && cur.cropId && !cur.withered) continue;
        const d = await doAct("/plant", { idx: p.idx, crop_id: cropId }, "播种");
        if (d) planted++;
        await sleep(120);
      }
      if (planted) {
        S.plantCount += planted;
        pushResult("plant", 0, cropName(cropId) || "播种", planted, "");
        log(`种下 ${planted} 块 ${cropName(cropId)}`, "ok");
      }
    }
    // 4) 浇水/施肥（成长中的地）
    const growing = S.plots.filter(p => p.cropId && !p.ready && !p.withered);
    if (CFG.autoWater && growing.some(p => !p.watered)) {
      const d = await doAct("/water-all", {}, "浇水");
      if (d) log("一键浇水 · 全体生长 -1分钟", "ok");
    }
    if (CFG.autoFert && (S.daily.fert_left || 0) > 0 && growing.length) {
      const d = await doAct("/fert-all", {}, "施肥");
      if (d) log(`一键施肥 · 剩余 ${S.daily.fert_left || 0} 次`, "ok");
    }
    syncState();
    render();
  }

  async function stealPass() {
    try {
      const d = await api("/neighbors");
      const list = (d && d.neighbors) || [];
      if (!list.length) return;
      // 收集所有可偷作物，按单价降序（荔枝>杨梅>樱桃...）
      const targets = [];
      for (const nb of list) for (const p of (nb.plots || [])) {
        const c = CROP_BY_ID[p.crop_id];
        // 跳过低价值作物：偷菜次数有限（10次/天），全用在高单价上
        if (c && c.pr < CFG.minStealPrice) continue;
        targets.push({ uid: nb.user_id, idx: p.idx, cropId: p.crop_id, count: p.count || 1, value: c ? stealValue(c) : 0 });
      }
      targets.sort((a, b) => b.value - a.value);
      if (!targets.length) {
        S.lastStealScan = Date.now();
        return;
      }
      // 偷菜选择：默认严格只偷荔枝(29)；没荔枝且 stealOnlyId=0 时才按最高单价偷
      let pool = targets;
      if (CFG.stealOnlyId) {
        pool = targets.filter(t => t.cropId === CFG.stealOnlyId);
      } else if (CFG.stealTopOnly) {
        const top = targets[0].value;
        pool = targets.filter(t => t.value >= top);
      }
      let stole = 0;
      for (const t of pool) {
        if ((S.daily.steal_left || 0) <= 0) break;
        const r = await doAct("/steal", { user_id: t.uid, idx: t.idx }, "偷菜");
        if (r) {
          // 服务端把偷取收益放在 message 里（"+E0.040320 额度"），字段 reward_quota 可能为空
          let e = (r.reward_quota || 0) / 500000;
          const m = String(r.message || "").match(/\+E?([\d.]+)\s*额度/i) || String(r.message || "").match(/\+([\d.]+)\s*E/i);
          if (m && !e) e = parseFloat(m[1]) || 0;
          S.stealE += e; S.stealCount++;
          stole++;
          pushResult("steal", e, cropName(t.cropId), t.count, r.message || "");
          log(`偷 ${cropName(t.cropId)} ×${t.count} · +${e.toFixed(3)} E（剩 ${S.daily.steal_left || 0}次）`, "ok");
          await sleep(250);
        }
      }
      if (!stole) S.lastStealScan = Date.now();  // 有目标但没偷成（可能已被别人偷），稍后重刷
    } catch (e) { log("偷菜扫描失败：" + e.message, "warn"); }
  }

  async function loop() {
    const gen = S.gen;
    log("自动农场启动 · 目标作物 " + (CFG.cropId ? cropName(CFG.cropId) : "自动最优"), "ok");
    while (S.run && !S.abort && S.gen === gen) {
      S.cycle++;
      const before = S.daily.harvest_quota || 0;
      try { await oneCycle(); } catch (e) { log("循环异常：" + e.message, "bad"); }
      // 田地节奏：有作物在生长就 30 秒巡检；否则按 tickMs 快速跟进
      const waiting = S.plots.some(p => p.cropId && !p.ready && !p.withered);
      await sleep(waiting ? 30000 : CFG.tickMs);
    }
    S.run = false; render(); log("自动农场已停止", "warn");
  }
  function toggle() {
    S.gen++;  // 每次切换都让旧循环失效
    if (S.run) { S.abort = true; S.run = false; log("停止中", "warn"); render(); }
    else { S.run = true; S.abort = false; render(); loop(); stealLoop(); }
  }

  // 偷菜独立循环：每 8 秒刷一次邻居，只偷最高价值作物，直到次数用完。
  async function stealLoop() {
    const gen = S.gen;
    log(`偷菜循环启动：只偷${CFG.stealOnlyId ? (cropName(CFG.stealOnlyId) || "荔枝") : "最高单价"}作物`, "ok");
    while (S.run && !S.abort && S.gen === gen) {
      if (CFG.autoSteal && (S.daily.steal_left || 0) > 0 && ready()) {
        try {
          syncState();
          await stealPass();
        } catch (e) {}
      }
      await sleep(CFG.stealRefreshMs);
    }
  }

  /* ============================================================
   * 公共 API + 启动
   * ============================================================ */
  window.farmfarm = {
    start: () => { if (!S.run) toggle(); return "started"; },
    stop: () => { if (S.run) toggle(); return "stopped"; },
    once: () => oneCycle(),
    status: () => ({ ready: S.ready, run: S.run, cycle: S.cycle, level: S.level, quota: S.quota,
      daily: { ...S.daily }, plots: S.plots.length, readyPlots: S.plots.filter(p => p.ready).length,
      harvestE: S.harvestE, stealE: S.stealE, cropId: CFG.cropId, best: pickBestCrop(),
      results: S.results.slice(0, 5), errors: S.errors.slice(-5) }),
    set: cfg => { Object.assign(CFG, cfg); render(); return { ...CFG }; },
  };

  // 等 iframe 游戏就绪（拿到 token 后 window.__farm 才有数据）
  async function waitReady() {
    for (let i = 0; i < 120; i++) {
      if (ready()) {
        S.ready = true;
        const w = gw();
        try {
          (w.CROPS || []).forEach(c => S.cropName[c.id] = c.name);
          if (!Object.keys(S.cropName).length) CROPS.forEach(c => S.cropName[c.id] = "#" + c.id);
        } catch (e) { CROPS.forEach(c => S.cropName[c.id] = "#" + c.id); }
        syncState(); render(); log("农场已就绪 · Lv." + S.level, "ok");
        return;
      }
      await sleep(500);
    }
    log("等待游戏超时：请确认已登录并从侧边栏进入农场", "warn");
  }
  render();
  setInterval(() => { try { if (ready()) { syncState(); render(); } } catch (e) {} }, 2000);
  waitReady();
  console.log("%c[FarmFarm] 已注入。控制台: farmfarm.start() / once() / status() / set({cropId:29})", "color:#8fe0a8;font-size:13px");
})();
