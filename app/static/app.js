/* 野球スコア β 画面
   1つのHTMLで、URLに応じて画面を切り替える
   記録の計算はすべてサーバー（Python）側 画面は「入力を送る」「結果を表示する」だけ */
"use strict";

// ================================================================ 共通
const $app = document.getElementById("app");
const $sheetRoot = document.getElementById("sheet-root");
const POS_JA = { 1: "投", 2: "捕", 3: "一", 4: "二", 5: "三", 6: "遊", 7: "左", 8: "中", 9: "右" };
const POS_CODES = ["P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH"];
const POS_CODE_JA = { P: "投", C: "捕", "1B": "一", "2B": "二", "3B": "三", SS: "遊", LF: "左", CF: "中", RF: "右", DH: "DH" };
const BASE_JA = { 1: "一塁", 2: "二塁", 3: "三塁", 4: "本塁" };
const HOW_JA = { sb: "盗塁", cs: "盗塁死", wp: "暴投", pb: "捕逸", bk: "ボーク", po: "牽制死", error: "失策", adv: "進塁", force: "封殺", tag: "タッチアウト", doubled_off: "帰塁できず", tagup: "タッチアップ", fc: "野選", other: "その他" };
const PITCH_SHORT = { ball: "B", called_strike: "見", swinging_strike: "空", foul: "F", foul_bunt: "BF", foul_tip: "FT", hbp: "死", in_play: "打", unknown: "?" };

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* プライベートモード等は保存しない */ } },
};
function clientId() {
  let id = store.get("bs_client");
  if (!id) { id = "c" + Math.random().toString(36).slice(2) + Date.now().toString(36); store.set("bs_client", id); }
  return id;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
let toastTimer;
function toast(msg, isErr = false) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ""; }, isErr ? 4500 : 2200);
}
function halfJa(h) { return h === "top" ? "表" : "裏"; }
function pname(p) { return p ? (p.number ? `${p.number} ${p.name}` : p.name) : "—"; }

class ApiError extends Error {
  constructor(status, data) { super(data?.message || "通信に失敗しました"); this.status = status; this.data = data || {}; }
}
async function api(path, { method = "GET", body, headers = {} } = {}) {
  const h = { ...headers };
  const pass = store.get("bs_pass");
  if (pass) h["X-Passcode"] = pass;
  if (body !== undefined) h["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, { message: "通信できませんでした 電波の状況を確認して、もう一度押してください" });
  }
  let data = null;
  try { data = await res.json(); } catch { /* JSON以外 */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
// 管理用パスコードが必要な操作：違っていたら入力を求めてやり直す
async function apiAdmin(path, opts) {
  try { return await api(path, opts); } catch (e) {
    if (e.status !== 401) throw e;
    const pass = await askText("管理用パスコード", "チーム登録・試合作成に必要です", "", "password");
    if (pass === null) throw e;
    store.set("bs_pass", pass);
    return api(path, opts);
  }
}

// ---------------------------------------------------------------- シート（下から出る入力欄）
let sheetClose = null;
function openSheet(html, mount) {
  closeSheet();
  $sheetRoot.innerHTML = `<div class="sheet-bg"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  const el = $sheetRoot.querySelector(".sheet");
  $sheetRoot.querySelector(".sheet-bg").onclick = () => closeSheet();
  sheetClose = null;
  if (mount) sheetClose = mount(el) || null;
  return el;
}
function closeSheet() {
  if (typeof sheetClose === "function") sheetClose();
  sheetClose = null;
  $sheetRoot.innerHTML = "";
}
function askText(title, hint, value = "", type = "text") {
  return new Promise(resolve => {
    let done = false;
    openSheet(`<h2>${esc(title)}</h2><p class="muted">${esc(hint)}</p>
      <input id="ask" type="${type}" value="${esc(value)}" autocomplete="off">
      <div class="sheet-actions"><button class="btn" data-a="cancel">やめる</button><button class="btn primary" data-a="ok">決定</button></div>`, el => {
      const input = el.querySelector("#ask");
      setTimeout(() => input.focus(), 50);
      const finish = v => { if (!done) { done = true; resolve(v); } };
      el.querySelector("[data-a=ok]").onclick = () => { const v = input.value.trim(); finish(v); closeSheet(); };
      el.querySelector("[data-a=cancel]").onclick = () => { finish(null); closeSheet(); };
      input.onkeydown = ev => { if (ev.key === "Enter") el.querySelector("[data-a=ok]").click(); };
      return () => finish(null);
    });
  });
}
function confirmSheet(title, body, okLabel, danger = false) {
  return new Promise(resolve => {
    let done = false;
    openSheet(`<h2>${esc(title)}</h2><p>${body}</p>
      <div class="sheet-actions"><button class="btn" data-a="cancel">やめる</button><button class="btn ${danger ? "danger" : "primary"}" data-a="ok">${esc(okLabel)}</button></div>`, el => {
      const finish = v => { if (!done) { done = true; resolve(v); } };
      el.querySelector("[data-a=ok]").onclick = () => { finish(true); closeSheet(); };
      el.querySelector("[data-a=cancel]").onclick = () => { finish(false); closeSheet(); };
      return () => finish(false);
    });
  });
}

// ================================================================ 画面の切り替え
let pollTimer = null, lockTimer = null;
function go(path) { history.pushState(null, "", path); route(); }
window.addEventListener("popstate", () => route());
document.addEventListener("click", ev => {
  const a = ev.target.closest("a[data-link]");
  if (a) { ev.preventDefault(); go(a.getAttribute("href")); }
});
function route() {
  clearInterval(pollTimer); clearInterval(lockTimer); closeSheet();
  const parts = location.pathname.split("/").filter(Boolean);
  window.scrollTo(0, 0);
  if (parts[0] === "e" && parts[1]) return Editor.start(parts[1]);
  if (parts[0] === "g" && parts[1]) return Viewer.start(parts[1]);
  if (parts[0] === "p" && parts[1]) return pagePlayer(parts[1]);
  if (parts[0] === "t" && parts[1]) return pageTeam(parts[1]);
  if (parts[0] === "teams") return pageTeams();
  if (parts[0] === "new") return pageNew();
  return pageHome();
}
function topbar(title, right = "") {
  return `<header class="topbar"><a class="btnlink" href="/" data-link aria-label="トップへ">トップ</a><div class="title">${esc(title)}</div>${right}</header>`;
}
function showError(e) { toast(e.message || String(e), true); }

// ================================================================ トップ
async function pageHome() {
  const mine = store.get("bs_mygames", []);
  $app.innerHTML = `<header class="topbar"><div class="title">野球スコア β</div></header>
  <div class="wrap">
    <div class="row-btns" style="margin-top:16px">
      <a class="btn primary" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="/new" data-link>試合をつくる</a>
      <a class="btn" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="/teams" data-link>チーム・選手</a>
    </div>
    <h2>この端末で入力できる試合</h2>
    ${mine.length ? `<ul class="list">${mine.map(g => `<li><a href="/e/${esc(g.edit_token)}" data-link><span class="grow">${esc(g.label)}<br><span class="muted">${esc(g.date || "")}</span></span><span class="tag">入力</span></a></li>`).join("")}</ul>`
      : `<p class="muted">まだありません 試合をつくるか、共有された入力用URLを開くとここに出ます</p>`}
    <h2>最近の試合</h2>
    <div id="recent"><p class="muted">読み込み中…</p></div>
    <h2>検証用</h2>
    <p class="muted">2026年10月18日 Nexus Tokyo 対 EDOSEN（2－6）の記録を、新しい試合として読み込みます</p>
    <button class="btn block" id="fx">検証試合を読み込む</button>
  </div>`;
  document.getElementById("fx").onclick = async () => {
    try {
      const r = await apiAdmin("/api/admin/import-fixture", { method: "POST" });
      rememberGame({ edit_token: r.edit_token, view_token: r.view_token, label: "【検証】Nexus Tokyo 対 EDOSEN", date: "2026-10-18" });
      toast("検証試合を読み込みました");
      go(`/e/${r.edit_token}`);
    } catch (e) { showError(e); }
  };
  try {
    const games = await api("/api/games");
    document.getElementById("recent").innerHTML = games.length ? `<ul class="list">${games.map(g => {
      const s = g.summary || {};
      const st = s.status === "final" ? `<span class="tag">試合終了</span>` : s.status === "live" ? `<span class="tag live">${s.inning}回${halfJa(s.half)}</span>` : `<span class="tag">開始前</span>`;
      return `<li><a href="/g/${esc(g.view_token)}" data-link><span class="grow">${esc(g.away)} 対 ${esc(g.home)} ${st}<br><span class="muted">${esc(g.date)}${g.venue ? " " + esc(g.venue) : ""}</span></span><span class="score">${s.away ?? 0}-${s.home ?? 0}</span></a></li>`;
    }).join("")}</ul>` : `<p class="muted">まだ試合がありません</p>`;
  } catch (e) { document.getElementById("recent").innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
function rememberGame(g) {
  const list = store.get("bs_mygames", []).filter(x => x.edit_token !== g.edit_token);
  list.unshift(g); store.set("bs_mygames", list.slice(0, 30));
}

// ================================================================ チーム・選手
async function pageTeams() {
  $app.innerHTML = topbar("チーム・選手") + `<div class="wrap"><div id="body"><p class="muted">読み込み中…</p></div></div>`;
  const draw = async () => {
    const teams = await api("/api/teams");
    document.getElementById("body").innerHTML = `
      <button class="btn primary block" id="add">チームを追加</button>
      ${teams.length ? `<ul class="list">${teams.map(t => `<li><a href="/t/${esc(t.id)}" data-link><span class="grow">${esc(t.name)}</span><span class="muted">${t.players}人</span></a></li>`).join("")}</ul>` : `<p class="muted">チームがまだありません 「チームを追加」から登録してください</p>`}`;
    document.getElementById("add").onclick = async () => {
      const name = await askText("チームを追加", "チーム名を入力してください");
      if (!name) return;
      try { const t = await apiAdmin("/api/teams", { method: "POST", body: { name } }); go(`/t/${t.id}`); } catch (e) { showError(e); }
    };
  };
  try { await draw(); } catch (e) { showError(e); }
}
async function pageTeam(id) {
  $app.innerHTML = topbar("選手一覧") + `<div class="wrap"><div id="body"><p class="muted">読み込み中…</p></div></div>`;
  const draw = async () => {
    const t = await api(`/api/teams/${id}`);
    document.querySelector(".topbar .title").textContent = t.name;
    document.getElementById("body").innerHTML = `
      <div class="row-btns"><button class="btn primary" id="add">選手を追加</button><button class="btn" id="ren">チーム名を変更</button></div>
      ${t.players.length ? `<ul class="list">${t.players.map(p => `<li><button class="item" data-pid="${esc(p.id)}"><span class="num" style="width:2.2em;font-size:1.2rem">${esc(p.number || "")}</span><span class="grow">${esc(p.name)}${p.active ? "" : ' <span class="tag">登録外</span>'}</span><a href="/p/${esc(p.id)}" data-link class="muted">成績</a></button></li>`).join("")}</ul>` : `<p class="muted">選手がまだいません</p>`}`;
    document.getElementById("add").onclick = () => playerForm(id, null, draw);
    document.getElementById("ren").onclick = async () => {
      const name = await askText("チーム名を変更", "新しいチーム名", t.name);
      if (!name) return;
      try { await apiAdmin(`/api/teams/${id}`, { method: "PATCH", body: { name } }); draw(); } catch (e) { showError(e); }
    };
    document.querySelectorAll("[data-pid]").forEach(b => b.onclick = ev => {
      if (ev.target.closest("a")) return;
      playerForm(id, t.players.find(p => p.id === b.dataset.pid), draw);
    });
  };
  try { await draw(); } catch (e) { showError(e); }
}
function playerForm(teamId, p, after, editToken = null) {
  return new Promise(resolve => {
    openSheet(`<h2>${p ? "選手を編集" : "選手を追加"}</h2>
      <label class="f" for="pn">名前</label><input id="pn" type="text" value="${esc(p?.name || "")}" autocomplete="off">
      <label class="f" for="pno">背番号（なくても可）</label><input id="pno" type="text" inputmode="numeric" value="${esc(p?.number || "")}">
      ${p ? `<label class="check"><input id="pact" type="checkbox" ${p.active ? "checked" : ""}> 登録中（外すと入力の選択肢に出ません）</label>` : ""}
      <div class="sheet-actions"><button class="btn" data-a="c">やめる</button><button class="btn primary" data-a="ok">${p ? "保存" : "追加"}</button></div>`, el => {
      setTimeout(() => el.querySelector("#pn").focus(), 50);
      el.querySelector("[data-a=c]").onclick = () => { closeSheet(); resolve(null); };
      el.querySelector("[data-a=ok]").onclick = async () => {
        const name = el.querySelector("#pn").value.trim();
        const number = el.querySelector("#pno").value.trim();
        if (!name) { toast("名前を入力してください", true); return; }
        try {
          let r;
          if (p) r = await apiAdmin(`/api/players/${p.id}`, { method: "PATCH", body: { name, number, active: el.querySelector("#pact").checked } });
          else r = await (editToken ? api : apiAdmin)(`/api/teams/${teamId}/players`, { method: "POST", body: { name, number }, headers: editToken ? { "X-Edit-Token": editToken } : {} });
          closeSheet(); toast(p ? "保存しました" : `${name}を追加しました`);
          if (after) await after(r);
          resolve(r);
        } catch (e) { showError(e); }
      };
    });
  });
}

// ================================================================ 試合をつくる
async function pageNew() {
  $app.innerHTML = topbar("試合をつくる") + `<div class="wrap"><div id="body"><p class="muted">読み込み中…</p></div></div>`;
  let teams;
  try { teams = await api("/api/teams"); } catch (e) { showError(e); return; }
  const opts = teams.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  document.getElementById("body").innerHTML = teams.length < 2 ? `<p>試合をつくるには、チームが2つ以上必要です</p><a class="btn primary block" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="/teams" data-link>チームを登録する</a>` : `
    <label class="f" for="d">日付</label><input id="d" type="date" value="${today}">
    <label class="f" for="a">先攻</label><select id="a">${opts}</select>
    <label class="f" for="h">後攻</label><select id="h">${opts}</select>
    <label class="f" for="v">球場（なくても可）</label><input id="v" type="text">
    <label class="f" for="inn">規定の回数</label><input id="inn" type="number" min="1" max="20" value="9" inputmode="numeric">
    <label class="check"><input id="xh" type="checkbox"> 打順10人以上（守備に就かない打者を入れる）</label>
    <details><summary class="muted" style="min-height:44px;display:flex;align-items:center">その他のルール（通常は変更不要）</summary>
      <label class="check"><input id="re" type="checkbox" checked> 再出場あり</label>
      <label class="check"><input id="dh" type="checkbox" checked> DHあり（投手が打順に入らなくてもよい）</label>
      <label class="check"><input id="tr" type="checkbox" checked> 臨時代走あり</label>
    </details>
    <button class="btn primary block" id="go" style="margin-top:20px">試合をつくる</button>`;
  const sel = document.getElementById("h");
  if (sel && teams[1]) sel.value = teams[1].id;
  const btn = document.getElementById("go");
  if (!btn) return;
  btn.onclick = async () => {
    const body = {
      date: document.getElementById("d").value, away_team_id: document.getElementById("a").value,
      home_team_id: document.getElementById("h").value, venue: document.getElementById("v").value || null,
      innings: parseInt(document.getElementById("inn").value || "9", 10), extra_hitters: document.getElementById("xh").checked,
      reentry: document.getElementById("re").checked, dh: document.getElementById("dh").checked, temp_runner: document.getElementById("tr").checked,
    };
    try {
      const r = await apiAdmin("/api/games", { method: "POST", body });
      const label = `${teams.find(t => t.id === body.away_team_id).name} 対 ${teams.find(t => t.id === body.home_team_id).name}`;
      rememberGame({ edit_token: r.edit_token, view_token: r.view_token, label, date: body.date });
      shareSheet(r.edit_token, r.view_token, () => go(`/e/${r.edit_token}`));
    } catch (e) { showError(e); }
  };
}
function shareSheet(editToken, viewToken, after) {
  const eu = `${location.origin}/e/${editToken}`, vu = `${location.origin}/g/${viewToken}`;
  openSheet(`<h2>URLの共有</h2>
    <p class="sec">閲覧用（誰に送っても大丈夫 見るだけ）</p><div class="urlbox">${esc(vu)}</div>
    <div class="row-btns"><button class="btn small" data-c="${esc(vu)}">コピー</button>${navigator.share ? `<button class="btn small" data-s="${esc(vu)}">送る</button>` : ""}</div>
    <p class="sec">入力用（入力する人にだけ送る 知っている人は誰でも書き込めます）</p><div class="urlbox">${esc(eu)}</div>
    <div class="row-btns"><button class="btn small" data-c="${esc(eu)}">コピー</button>${navigator.share ? `<button class="btn small" data-s="${esc(eu)}">送る</button>` : ""}</div>
    <div class="sheet-actions"><button class="btn primary" data-a="ok">${after ? "入力をはじめる" : "閉じる"}</button></div>`, el => {
    el.querySelectorAll("[data-c]").forEach(b => b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.c); toast("コピーしました"); } catch { toast("コピーできませんでした 長押しで選択してください", true); }
    });
    el.querySelectorAll("[data-s]").forEach(b => b.onclick = () => navigator.share({ url: b.dataset.s }).catch(() => {}));
    el.querySelector("[data-a=ok]").onclick = () => { closeSheet(); if (after) after(); };
  });
}

// ================================================================ スコアボード・走者の表示（入力・閲覧で共通）
function boardHtml(v) {
  const inn = Math.max(v.linescore.away.length, v.linescore.home.length, v.rules.innings || 9);
  const cols = Array.from({ length: inn }, (_, i) => i + 1);
  const row = side => {
    const cells = cols.map(i => {
      const val = v.linescore[side][i - 1];
      const cur = v.status === "live" && i === v.inning && v.batting_side === side;
      const txt = val === null ? "×" : val === undefined ? "" : val;
      return `<td class="num${cur ? " cur" : ""}">${txt}</td>`;
    }).join("");
    return `<tr class="${v.status === "live" && v.batting_side === side ? "batting" : ""}"><td class="team">${esc(v.team_names[side])}</td>${cells}<td class="num r">${v.rhe[side].R}</td><td class="num">${v.rhe[side].H}</td><td class="num">${v.rhe[side].E}</td></tr>`;
  };
  const lamps = (n, k, max) => Array.from({ length: max }, (_, i) => `<i class="lamp ${k}${i < n ? " on" : ""}"></i>`).join("");
  const state = v.status === "final" ? `<span class="final-flag">試合終了</span>`
    : v.status === "pregame" ? `<span class="inning">開始前</span>`
      : `<span class="inning">${v.inning}<small>回${halfJa(v.half)}</small></span>`;
  return `<section class="board" aria-label="スコアボード">
    <div class="ls-wrap"><table class="ls${inn > 9 ? " many" : ""}"><thead><tr><th></th>${cols.map(i => `<th>${i}</th>`).join("")}<th>R</th><th>H</th><th>E</th></tr></thead>
    <tbody>${row("away")}${row("home")}</tbody></table></div>
    <div class="state">${state}${v.status === "live" ? `<div class="lamps" aria-label="ボール${v.balls} ストライク${v.strikes} アウト${v.outs}">
      <span><b>B</b>${lamps(v.balls, "b", 3)}</span><span><b>S</b>${lamps(v.strikes, "s", 2)}</span><span><b>O</b>${lamps(v.outs, "o", 2)}</span></div>` : ""}</div>
  </section>`;
}
function diamondHtml(v) {
  const b = v.bases;
  const nm = r => r ? esc(((r.temp ? r.temp.name + "*" : r.name) || "").slice(0, 6)) : "";
  const base = (n, x, y) => `<rect class="base${b[n] ? " on" : ""}" x="${x - 9}" y="${y - 9}" width="18" height="18" transform="rotate(45 ${x} ${y})"/>`;
  return `<svg class="diamond" viewBox="0 0 132 112" role="img" aria-label="走者 ${[1, 2, 3].map(n => b[n] ? BASE_JA[n] + b[n].name : "").filter(Boolean).join(" ") || "なし"}">
    <path class="path" d="M66 96 L112 54 L66 14 L20 54 Z"/>
    ${base(2, 66, 14)}${base(1, 112, 54)}${base(3, 20, 54)}
    <rect class="base" x="58" y="88" width="16" height="16" />
    <text x="66" y="40" text-anchor="middle">${nm(b[2])}</text>
    <text x="112" y="80" text-anchor="middle">${nm(b[1])}</text>
    <text x="20" y="80" text-anchor="middle">${nm(b[3])}</text>
  </svg>`;
}
function whoHtml(v) {
  if (v.status === "final" || !v.batter) return "";
  const STRIKES = ["called_strike", "swinging_strike", "foul", "foul_bunt", "foul_tip"];
  const seq = (v.pa_pitches || []).map(p => `<span class="pchip ${p === "ball" ? "b" : STRIKES.includes(p) ? "s" : ""}">${PITCH_SHORT[p] || "?"}</span>`).join("");
  return `<div class="who">
    <div class="row"><span class="role">打者</span><span class="name">${v.batter ? `${v.batter.order}番 ${esc(pname(v.batter))}` : "—"}</span></div>
    <div class="row"><span class="role">次</span><span class="muted">${esc(pname(v.ondeck))}</span></div>
    <div class="row"><span class="role">投手</span><span class="name">${esc(pname(v.pitcher))}</span><span class="muted num">${v.pitcher ? v.pitcher.pitches + "球" : ""}</span></div>
    <div class="pseq" aria-label="この打席の投球">${seq}</div>
  </div>`;
}

// ---------------------------------------------------------------- 経過・成績・スコア表（共通）
function eventsHtml(v, editable) {
  const halt = v.halted;
  const pending = new Set(halt ? halt.pending.slice(1) : []);
  const items = [...v.events].reverse();
  let lastHead = "";
  let html = "";
  for (const e of items) {
    const isPending = halt && (halt.event_id === e.id || pending.has(e.id));
    const head = isPending ? "要確認・未計算の記録" : e.inning ? `${e.inning}回${halfJa(e.half)}` : "試合前";
    if (head !== lastHead) { html += `<li class="half-head">${head}</li>`; lastHead = head; }
    const cls = halt && halt.event_id === e.id ? "halt" : pending.has(e.id) ? "pending" : "";
    const tags = [
      e.unconfirmed ? `<span class="tag note">未確認</span>` : "",
      e.corrected ? `<span class="tag">訂正済み</span>` : "",
      halt && halt.event_id === e.id ? `<span class="tag warn">要確認</span>` : "",
      pending.has(e.id) ? `<span class="tag">未計算</span>` : "",
    ].join("");
    const desc = e.desc || e.summary || typeJa(e.type);
    const sc = e.after ? `${e.after.outs_shown ?? e.after.outs}アウト ${e.after.score.away}-${e.after.score.home}` : "";
    const inner = `<span class="grow">${esc(desc)}${tags}<small>${esc(sc)}${e.note ? " ／ " + esc(e.note) : ""}${halt && halt.event_id === e.id ? " ／ " + esc(halt.message) : ""}</small></span>`;
    html += editable ? `<li class="ev ${cls}"><button class="item" data-ev="${esc(e.id)}">${inner}</button></li>` : `<li class="ev ${cls}"><div class="item">${inner}</div></li>`;
  }
  return `<ul class="list">${html || `<li class="ev">まだ記録がありません</li>`}</ul>`;
}
function typeJa(t) { return { lineup: "スタメン", pitch: "投球", pa_result: "打席結果", runner: "走塁", sub: "交代", end: "試合終了", decision: "勝敗投手" }[t] || t; }

function boxHtml(v) {
  const team = side => {
    const b = v.box[side];
    const bat = b.batting.map(r => `<tr><td class="l">${r.order ?? ""}</td><td class="l name"><a href="/p/${esc(r.id)}" data-link>${esc(r.name)}</a></td><td>${r.PA}</td><td>${r.AB}</td><td>${r.H}</td><td>${r.HR}</td><td>${r.RBI}</td><td>${r.R}</td><td>${r.SO}</td><td>${r.BB + r.HBP}</td><td>${r.SB}</td><td>${r.AVG ?? "-"}</td></tr>`).join("");
    const t = b.batting_total;
    const pit = b.pitching.map(r => `<tr><td class="l name"><a href="/p/${esc(r.id)}" data-link>${esc(r.name)}</a>${r.decision ? ` <span class="tag">${r.decision}</span>` : ""}</td><td>${r.IP}</td><td>${r.BF}</td><td>${r.pitches}${r.pitches_incomplete ? "+" : ""}</td><td>${r.H}</td><td>${r.HR}</td><td>${r.SO}</td><td>${r.BB}</td><td>${r.HBP}</td><td>${r.WP}</td><td>${r.R}</td><td>${r.ER}</td></tr>`).join("");
    const fld = b.fielding.filter(r => r.PO || r.A || r.E || r.PB).map(r => `<tr><td class="l name">${esc(r.name)}</td><td>${r.PO}</td><td>${r.A}</td><td>${r.E}</td><td>${r.PB}</td></tr>`).join("");
    return `<h3>${esc(v.team_names[side])}</h3>
      <div class="scroll-x"><table class="stats"><thead><tr><th class="l">順</th><th class="l">打者</th><th>打席</th><th>打数</th><th>安打</th><th>本塁打</th><th>打点</th><th>得点</th><th>三振</th><th>四死球</th><th>盗塁</th><th>打率</th></tr></thead>
      <tbody>${bat}<tr class="total"><td></td><td class="l">計</td><td>${t.PA}</td><td>${t.AB}</td><td>${t.H}</td><td>${t.HR}</td><td>${t.RBI}</td><td>${t.R}</td><td>${t.SO}</td><td>${t.BB + t.HBP}</td><td>${t.SB}</td><td>${t.AVG ?? "-"}</td></tr></tbody></table></div>
      <div class="scroll-x"><table class="stats" style="margin-top:10px"><thead><tr><th class="l">投手</th><th>回</th><th>打者</th><th>球数</th><th>安打</th><th>本塁打</th><th>三振</th><th>四球</th><th>死球</th><th>暴投</th><th>失点</th><th>自責</th></tr></thead><tbody>${pit}</tbody></table></div>
      ${fld ? `<div class="scroll-x"><table class="stats" style="margin-top:10px"><thead><tr><th class="l">守備</th><th>刺殺</th><th>補殺</th><th>失策</th><th>捕逸</th></tr></thead><tbody>${fld}</tbody></table></div>` : ""}
      ${b.po_unknown ? `<p class="muted">守備者が未確認のアウト：${b.po_unknown}（刺殺・補殺に数えていません）</p>` : ""}`;
  };
  const d = v.decisions || {};
  const dec = v.status === "final" && (d.win || d.loss) ? `<p>勝：${esc(d.win?.name || "—")} ／ 敗：${esc(d.loss?.name || "—")}</p>${d.note ? `<p class="muted">${esc(d.note)}</p>` : ""}` : "";
  const unrec = v.pa_log.some(p => p.unrecorded) ? `<p class="muted">球数の「+」は、投球を記録していない打席があることを表します</p>` : "";
  return `<div class="wrap">${dec}${team("away")}${team("home")}${unrec}
    <p class="muted">自責点は簡易判定です（失策で出塁した走者の得点・失策がなければ3アウトだった後の得点を除外） 判断が必要な場面は経過から訂正できます</p></div>`;
}
function bookHtml(v) {
  const team = side => {
    const bk = v.scorebook[side];
    const cols = Array.from({ length: bk.innings }, (_, i) => i + 1);
    const names = {};
    for (const p of v.pa_log) if (p.side === side && p.order && !names[p.order]) names[p.order] = p.batter?.name;
    for (const s of v.lineups[side].slots) names[s.order] = names[s.order] || s.name;
    return `<h3>${esc(v.team_names[side])}</h3><div class="scroll-x"><table class="stats book"><thead><tr><th class="l">順</th><th class="l">打者</th>${cols.map(i => `<th>${i}</th>`).join("")}</tr></thead><tbody>
      ${bk.rows.map(r => `<tr><td class="l">${r.order}</td><td class="l name">${esc(names[r.order] || "")}</td>${cols.map(i => `<td class="${(r.cells[i] || []).length > 1 ? "cell-multi" : ""}">${(r.cells[i] || []).map(esc).join("<br>")}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div>`;
  };
  return `<div class="wrap">${team("away")}${team("home")}<p class="muted">記号：6-3＝遊ゴロ（遊撃手→一塁手）、3A＝一塁手が自分で踏んだゴロ、中飛＝センターフライ、二直＝セカンドライナー、左安・中2・右3・左本＝安打・二塁打・三塁打・本塁打と方向、遊失＝遊撃手の失策、(6-4)＝併殺崩れ、併＝併殺</p></div>`;
}

// ================================================================ 閲覧画面
const Viewer = {
  token: null, v: null, tab: "play",
  async start(token) {
    this.token = token; this.tab = "play";
    $app.innerHTML = `<p class="boot">読み込み中…</p>`;
    try { this.v = await api(`/api/view/${token}`); } catch (e) { $app.innerHTML = topbar("閲覧") + `<div class="wrap"><p>${esc(e.message)}</p></div>`; return; }
    this.render();
    pollTimer = setInterval(() => this.poll(), 5000);
  },
  async poll() {
    if (document.hidden) return;
    try {
      const r = await api(`/api/view/${this.token}?since=${this.v.game.version}`);
      if (!r.unchanged) { this.v = r; this.render(); }
    } catch { /* 次回また試す */ }
  },
  render() {
    const v = this.v;
    const body = this.tab === "play" ? `${diamondHtml(v) ? `<div class="field">${diamondHtml(v)}${whoHtml(v)}</div>` : ""}<div class="wrap">${eventsHtml(v, false)}</div>`
      : this.tab === "box" ? boxHtml(v) : bookHtml(v);
    $app.innerHTML = topbar(`${v.game.date} ${v.team_names.away} 対 ${v.team_names.home}`) + boardHtml(v) + body +
      `<nav class="tabs three">${[["play", "速報"], ["box", "成績"], ["book", "スコア"]].map(([k, l]) => `<button class="${this.tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</nav>`;
    $app.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { this.tab = b.dataset.tab; this.render(); window.scrollTo(0, 0); });
  },
};

// ================================================================ 入力画面
const Editor = {
  token: null, v: null, tab: "input", mode: null, mv: null, busy: false,

  async start(token) {
    this.token = token; this.tab = "input"; this.mode = null; this.mv = null; this._lineupSide = null;
    $app.innerHTML = `<p class="boot">読み込み中…</p>`;
    try { this.v = await api(`/api/edit/${token}`); } catch (e) { $app.innerHTML = topbar("入力") + `<div class="wrap"><p>${esc(e.message)}</p></div>`; return; }
    rememberGame({ edit_token: token, view_token: this.v.game.view_token, label: `${this.v.team_names.away} 対 ${this.v.team_names.home}`, date: this.v.game.date });
    if (!store.get("bs_name")) {
      const n = await askText("入力する人の名前", "訂正履歴に「誰が入力したか」として残ります", "");
      if (n) store.set("bs_name", n);
    }
    await this.claimLock(false);
    this.render();
    // 入力中は1分ごとに入力権を延長、他の端末の更新も確認する
    lockTimer = setInterval(() => this.heartbeat(), 60000);
  },
  get view() { return this.mode ? this.mv : this.v; },
  myLock() { const l = this.v.lock; return !l || !l.client || l.client === clientId(); },
  async claimLock(takeover) {
    try {
      const r = await api(`/api/edit/${this.token}/lock`, { method: "POST", body: { client_id: clientId(), name: store.get("bs_name"), takeover } });
      this.v.lock = r.lock;
      if (r.ok && r.version !== this.v.game.version) await this.reload();
      return r.ok;
    } catch (e) { showError(e); return false; }
  },
  async heartbeat() {
    if (document.hidden || !this.myLock()) return;
    const ok = await this.claimLock(false);
    if (!ok) this.render();
  },
  async reload() {
    this.v = await api(`/api/edit/${this.token}`);
    if (this.mode) { try { this.mv = await api(`/api/edit/${this.token}/before/${this.mode.target}`); } catch { this.exitMode(); } }
    this.render();
  },

  // ---------------- 送信（訂正・追加モードなら包んで送る）
  async send(type, payload, meta = {}) {
    if (this.busy) return null;
    this.busy = true;
    let body = { type, payload, meta };
    if (this.mode) {
      const inner = { type, payload, meta };
      body = this.mode.kind === "correct" ? { type: "correct", payload: { target: this.mode.target, event: inner }, meta: {} }
        : { type: "insert", payload: { before: this.mode.target, event: inner }, meta: {} };
    }
    try {
      const v = await api(`/api/edit/${this.token}/events`, {
        method: "POST",
        body: { ...body, client_id: clientId(), author: store.get("bs_name"), expected_version: this.v.game.version },
      });
      const wasMode = this.mode;
      this.v = v; this.mode = null; this.mv = null;
      closeSheet();
      if (wasMode) { toast(wasMode.kind === "correct" ? "訂正しました" : "追加しました"); this.tab = "log"; }
      this.render();
      if (v.halted) toast("後のプレーと矛盾があります 経過の「要確認」を直してください", true);
      return v;
    } catch (e) {
      if (e.status === 423) { this.v.lock = e.data.lock; closeSheet(); this.render(); }
      else if (e.status === 409) { await this.reload(); }
      showError(e);
      return null;
    } finally { this.busy = false; }
  },
  async undo() {
    const last = [...this.v.events].reverse()[0];
    if (!last) return;
    const ok = await confirmSheet("1つ前に戻す", `「${esc(last.desc || typeJa(last.type))}」を取り消します 記録は履歴に残り、後から戻せます`, "取り消す", true);
    if (!ok) return;
    try {
      this.v = await api(`/api/edit/${this.token}/undo`, { method: "POST", body: { client_id: clientId(), author: store.get("bs_name"), expected_version: this.v.game.version } });
      toast("取り消しました"); this.render();
    } catch (e) { if (e.status === 409) await this.reload(); showError(e); }
  },
  async enterMode(kind, target, desc) {
    try {
      this.mv = await api(`/api/edit/${this.token}/before/${target}`);
      this.mode = { kind, target, desc };
      if (kind === "correct" && this.modeEventType() === "lineup") this._lineupSide = desc.includes("後攻") ? "home" : "away";
      this.tab = "input"; this.render(); window.scrollTo(0, 0);
    } catch (e) { showError(e); }
  },
  exitMode() { this.mode = null; this.mv = null; this.render(); },

  // ---------------- 描画
  render() {
    const v = this.view;
    const menu = `<button id="menu" aria-label="メニュー">メニュー</button>`;
    let banners = "";
    if (!this.myLock() && !this.mode) {
      banners += `<div class="banner warn">${esc(this.v.lock.name || "別の端末")}が入力中です この端末からは書き込めません<button class="btn small block" id="take">この端末で入力を引き継ぐ</button></div>`;
    }
    if (this.mode) {
      banners += `<div class="banner note"><b>${this.mode.kind === "correct" ? "訂正" : "記録の追加"}</b>：「${esc(this.mode.desc)}」${this.mode.kind === "correct" ? "を入力し直してください" : "の直前に入れる記録を入力してください"}<br><span class="muted">画面はそのプレーの直前の状況です</span><button class="btn small block" id="exitmode">やめる</button></div>`;
    } else if (this.v.halted) {
      banners += `<div class="banner warn">訂正の影響で、後のプレーと矛盾が出ています：${esc(this.v.halted.message)}<button class="btn small block" id="tolog">経過で確認する</button></div>`;
    }
    let body;
    if (this.tab === "input") body = this.inputHtml(v);
    else if (this.tab === "log") body = `<div class="wrap"><p class="muted" style="margin-top:12px">プレーを押すと、訂正・取消・直前への追加ができます</p>${eventsHtml(this.v, true)}</div>`;
    else if (this.tab === "box") body = boxHtml(this.v);
    else body = bookHtml(this.v);
    $app.innerHTML = topbar(`${this.v.team_names.away} 対 ${this.v.team_names.home}`, menu) + boardHtml(v) + banners + body +
      `<nav class="tabs">${[["input", "入力"], ["log", "経過"], ["box", "成績"], ["book", "スコア"]].map(([k, l]) => `<button class="${this.tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</nav>`;
    $app.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { this.tab = b.dataset.tab; this.render(); window.scrollTo(0, 0); });
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    on("menu", () => this.menuSheet());
    on("take", async () => { if (await this.claimLock(true)) { toast("この端末で入力します"); this.render(); } });
    on("exitmode", () => this.exitMode());
    on("tolog", () => { this.tab = "log"; this.render(); });
    if (this.tab === "input") this.bindInput(v);
    if (this.tab === "log") $app.querySelectorAll("[data-ev]").forEach(b => b.onclick = () => this.eventSheet(b.dataset.ev));
  },

  inputHtml(v) {
    const ls = v.lineups;
    if (!ls.away.set || !ls.home.set || (this.mode && this.mode.kind === "correct" && this.modeEventType() === "lineup")) {
      return this.lineupHtml(v);
    }
    if (v.status === "final") {
      return `<div class="wrap"><h2>試合終了</h2><p>${esc(v.team_names.away)} ${v.rhe.away.R} － ${v.rhe.home.R} ${esc(v.team_names.home)}</p>
        <p class="muted">記録を直す場合は「経過」から該当のプレーを訂正するか、下のボタンで最後の記録を取り消してください</p>
        <button class="btn block" id="undo">最後の記録を取り消す</button>
        <button class="btn block" id="share">URLを共有</button>
        <a class="btn block" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="/api/edit/${esc(this.token)}/export">バックアップを書き出す</a></div>`;
    }
    const occupied = [1, 2, 3].some(n => v.bases[n]);
    return `<div class="field">${diamondHtml(v)}${whoHtml(v)}</div>
      <div class="pad" role="group" aria-label="投球">
        <button class="k-ball" data-p="ball">ボール</button>
        <button class="k-strike" data-p="called_strike">見逃し</button>
        <button class="k-strike" data-p="swinging_strike">空振り</button>
        <button class="k-strike" data-p="foul">ファウル</button>
        <button class="k-play wide" data-act="inplay">打球</button>
        <button data-p="hbp">死球</button>
        <button data-act="otherpitch">その他</button>
      </div>
      <div class="pad" role="group" aria-label="その他の入力">
        <button class="k-sub" data-act="runner" ${occupied ? "" : "disabled"}>走塁</button>
        <button class="k-sub" data-act="result">結果のみ</button>
        <button class="k-sub" data-act="sub">交代</button>
        <button class="k-sub" data-act="undo" ${this.mode ? "disabled" : ""}>1つ戻す</button>
      </div>`;
  },
  modeEventType() {
    const e = this.mode && this.v.events.find(x => x.id === this.mode.target);
    return e ? e.type : null;
  },
  bindInput(v) {
    const ls = v.lineups;
    if (!ls.away.set || !ls.home.set || (this.mode && this.mode.kind === "correct" && this.modeEventType() === "lineup")) { this.bindLineup(v); return; }
    const on = (sel, fn) => $app.querySelectorAll(sel).forEach(b => b.onclick = () => fn(b));
    if (v.status === "final") {
      on("#undo", () => this.undo());
      on("#share", () => shareSheet(this.token, this.v.game.view_token));
      return;
    }
    on("[data-p]", b => this.pitch(b.dataset.p));
    on("[data-act=inplay]", () => ResultSheet.open(this, "in_play"));
    on("[data-act=result]", () => ResultSheet.open(this, "pa"));
    on("[data-act=runner]", () => RunnerSheet.open(this));
    on("[data-act=sub]", () => SubSheet.open(this));
    on("[data-act=undo]", () => this.undo());
    on("[data-act=otherpitch]", () => this.otherPitchSheet());
  },
  async pitch(kind) {
    const v = this.view;
    if (!this.myLock() && !this.mode) { toast("この端末は入力権がありません 「引き継ぐ」を押してください", true); return; }
    if ((kind === "called_strike" || kind === "swinging_strike") && v.strikes === 2) { this.strikeoutSheet(kind); return; }
    await this.send("pitch", { result: kind });
  },
  otherPitchSheet() {
    const v = this.view;
    openSheet(`<h2>その他の投球</h2><div class="chips">
      <button class="chip" data-k="foul_bunt">バントファウル${v.strikes === 2 ? "（三振）" : ""}</button>
      <button class="chip" data-k="foul_tip">ファウルチップ${v.strikes === 2 ? "（三振）" : ""}</button>
      <button class="chip" data-k="unknown">投球（内容不明）</button>
      <button class="chip" data-k="ibb">申告敬遠</button></div>
      <p class="muted">内容不明：球数だけ数え、カウントは進めません</p>
      <div class="sheet-actions"><button class="btn" data-a="c">閉じる</button></div>`, el => {
      el.querySelector("[data-a=c]").onclick = closeSheet;
      el.querySelectorAll("[data-k]").forEach(b => b.onclick = async () => {
        if (b.dataset.k === "ibb") await this.send("pa_result", { result: "ibb", pitches_recorded: true });
        else await this.send("pitch", { result: b.dataset.k });
      });
    });
  },
  strikeoutSheet(kind) {
    const v = this.view;
    const canDrop = !v.bases[1] || v.outs === 2;
    const occupied = [1, 2, 3].some(n => v.bases[n]);
    openSheet(`<h2>${kind === "called_strike" ? "見逃し" : "空振り"}三振</h2>
      <button class="btn primary block" data-k="k">三振</button>
      ${occupied ? `<button class="btn block" data-k="krun">三振＋走者の動き（盗塁・盗塁死など）</button>` : ""}
      <p class="sec">捕手が捕れなかったとき（振り逃げ）</p>
      ${canDrop ? `<div class="chips"><button class="chip" data-k="d_wp">暴投で出塁</button><button class="chip" data-k="d_pb">捕逸で出塁</button><button class="chip" data-k="d_error">失策で出塁</button><button class="chip" data-k="d_out">一塁でアウト（2-3）</button></div>`
        : `<p class="muted">一塁に走者がいて2アウト未満のため、振り逃げはできません（打者アウト）</p>`}
      <div class="sheet-actions"><button class="btn" data-a="c">やめる</button></div>`, el => {
      el.querySelector("[data-a=c]").onclick = closeSheet;
      el.querySelectorAll("[data-k]").forEach(b => b.onclick = async () => {
        const k = b.dataset.k;
        if (k === "k") await this.send("pitch", { result: kind });
        else if (k === "krun") RunnerSheet.open(this, kind);
        else if (k === "d_out") await this.send("pitch", { result: kind, dropped: { reached: false, fielders: [2, 3] } });
        else {
          const how = k.slice(2);
          const dropped = { reached: true, how };
          if (how === "error") dropped.error_pos = 2;
          await this.send("pitch", { result: kind, dropped });
        }
      });
    });
  },
  menuSheet() {
    openSheet(`<h2>メニュー</h2>
      <button class="btn block" data-m="share">URLを共有（閲覧用・入力用）</button>
      <button class="btn block" data-m="end" ${this.v.status !== "live" ? "disabled" : ""}>試合終了にする（時間切れ・コールドなど）</button>
      <button class="btn block" data-m="name">入力者の名前を変える（今：${esc(store.get("bs_name") || "未設定")}）</button>
      <a class="btn block" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="/api/edit/${esc(this.token)}/export">バックアップを書き出す</a>
      <a class="btn block" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="/g/${esc(this.v.game.view_token)}" data-link>閲覧画面を開く</a>
      <p class="muted">バックアップはファイルとして保存されます iPhoneでは「ファイル」アプリからiCloud Driveに保存できます</p>
      <div class="sheet-actions"><button class="btn" data-a="c">閉じる</button></div>`, el => {
      el.querySelector("[data-a=c]").onclick = closeSheet;
      el.querySelector("[data-m=share]").onclick = () => shareSheet(this.token, this.v.game.view_token);
      el.querySelector("[data-m=name]").onclick = async () => { const n = await askText("入力者の名前", "", store.get("bs_name") || ""); if (n) { store.set("bs_name", n); toast("変更しました"); } };
      el.querySelector("[data-m=end]").onclick = () => this.endSheet();
    });
  },
  endSheet() {
    openSheet(`<h2>試合終了にする</h2><p>今の得点で試合を終わらせます（規定の回数での終了・サヨナラは自動で終了します）</p>
      <div class="chips"><button class="chip on" data-r="time">時間切れ</button><button class="chip" data-r="called">コールド</button><button class="chip" data-r="other">その他</button></div>
      <div class="sheet-actions"><button class="btn" data-a="c">やめる</button><button class="btn primary" data-a="ok">試合終了にする</button></div>`, el => {
      let reason = "time";
      el.querySelectorAll("[data-r]").forEach(b => b.onclick = () => { reason = b.dataset.r; el.querySelectorAll("[data-r]").forEach(x => x.classList.toggle("on", x === b)); });
      el.querySelector("[data-a=c]").onclick = closeSheet;
      el.querySelector("[data-a=ok]").onclick = () => this.send("end", { reason });
    });
  },
  eventSheet(id) {
    const e = this.v.events.find(x => x.id === id);
    if (!e) return;
    const halt = this.v.halted;
    openSheet(`<h2>${esc(e.desc || typeJa(e.type))}</h2>
      ${halt && halt.event_id === id ? `<p class="banner warn" style="margin:0 0 8px">${esc(halt.message)}</p>` : ""}
      ${e.author ? `<p class="muted">入力：${esc(e.author)}</p>` : ""}
      <button class="btn block" data-a="fix">このプレーを訂正する</button>
      <button class="btn block" data-a="ins" ${e.type === "lineup" ? "disabled" : ""}>この直前に記録を追加する（記録漏れ）</button>
      <button class="btn block danger" data-a="void">このプレーを取り消す</button>
      <div class="sheet-actions"><button class="btn" data-a="c">閉じる</button></div>`, el => {
      el.querySelector("[data-a=c]").onclick = closeSheet;
      el.querySelector("[data-a=fix]").onclick = () => { closeSheet(); this.enterMode("correct", id, e.desc || typeJa(e.type)); };
      el.querySelector("[data-a=ins]").onclick = () => { closeSheet(); this.enterMode("insert", id, e.desc || typeJa(e.type)); };
      el.querySelector("[data-a=void]").onclick = async () => {
        closeSheet();
        const ok = await confirmSheet("プレーを取り消す", `「${esc(e.desc || typeJa(e.type))}」を取り消し、その後の記録を計算し直します`, "取り消す", true);
        if (!ok) return;
        this.mode = null; this.mv = null;
        await this.send("void", { target: id });
      };
    });
  },

  // ---------------- スタメン
  lineupHtml(v) {
    const r = this.v.roster;
    const rules = this.v.game.rules || {};
    const n = rules.extra_hitters ? Math.max(10, v.lineups.away.slots.length, v.lineups.home.slots.length) : 9;
    const side = this._lineupSide || (v.lineups.away.set && !this.mode ? "home" : "away");
    this._lineupSide = side;
    const cur = v.lineups[side];
    // 訂正のときは、元のスタメン（交代前）を初期値にする
    const fixing = this.mode && this.mode.kind === "correct";
    const prev = fixing ? this.v.lineups[side].starting.map(x => ({ ...x, position: (this.v.lineups[side].slots.find(y => y.id === x.id) || {}).position })) : cur.slots;
    const players = r[side];
    const popts = sel => `<option value="">（選ぶ）</option>` + players.map(p => `<option value="${esc(p.id)}" ${p.id === sel ? "selected" : ""}>${esc(pname(p))}</option>`).join("");
    const posopts = sel => `<option value="">守備</option>` + POS_CODES.map(c => `<option value="${c}" ${c === sel ? "selected" : ""}>${POS_CODE_JA[c]}</option>`).join("");
    const rows = Array.from({ length: n }, (_, i) => `<div class="lineup-row"><span class="o">${i + 1}</span><select data-slot="${i}">${popts(prev[i]?.id)}</select><select data-pos="${i}">${posopts(prev[i]?.position)}</select></div>`).join("");
    return `<div class="wrap">
      <div class="chips" style="margin-top:14px">${["away", "home"].map(s => `<button class="chip ${s === side ? "on" : ""}" data-side="${s}">${s === "away" ? "先攻" : "後攻"} ${esc(this.v.team_names[s])}${v.lineups[s].set ? " ✓" : ""}</button>`).join("")}</div>
      <h2>${esc(this.v.team_names[side])} のスタメン</h2>
      ${rows}
      <label class="f" for="sp">先発投手（打順に「投」がいなければ、打順外の投手を選ぶ）</label>
      <select id="sp">${popts(cur.pitcher && !prev.some(s => s.id === cur.pitcher.id) ? cur.pitcher.id : "")}</select>
      <div class="row-btns"><button class="btn" id="addp">選手を追加</button><button class="btn primary" id="saveL">このスタメンで登録</button></div>
      ${rules.extra_hitters ? `<button class="btn small" id="more">打順を1人増やす</button>` : ""}
      <p class="muted">守備位置が分からない選手は空欄でも登録できます（守備成績は「選手未登録」として集計）</p></div>`;
  },
  bindLineup(v) {
    $app.querySelectorAll("[data-side]").forEach(b => b.onclick = () => { this._lineupSide = b.dataset.side; this.render(); });
    const side = this._lineupSide;
    const teamId = this.v.game[side === "away" ? "away_team" : "home_team"].id;
    document.getElementById("addp").onclick = () => playerForm(teamId, null, async () => { await this.reload(); }, this.token);
    const more = document.getElementById("more");
    if (more) more.onclick = () => {
      const wrap = $app.querySelector(".lineup-row:last-of-type");
      const i = $app.querySelectorAll(".lineup-row").length;
      const clone = wrap.cloneNode(true);
      clone.querySelector(".o").textContent = i + 1;
      clone.querySelector("[data-slot]").dataset.slot = i; clone.querySelector("[data-slot]").value = "";
      clone.querySelector("[data-pos]").dataset.pos = i; clone.querySelector("[data-pos]").value = "";
      wrap.after(clone);
    };
    document.getElementById("saveL").onclick = async () => {
      const slots = [...$app.querySelectorAll("[data-slot]")].map(s => ({ player_id: s.value, position: $app.querySelector(`[data-pos="${s.dataset.slot}"]`).value || null }))
        .filter((s, i, arr) => s.player_id || i < 9);
      const sp = document.getElementById("sp").value || null;
      const r = await this.send("lineup", { side, slots, pitcher_id: sp });
      if (r) { toast("スタメンを登録しました"); if (side === "away" && !r.lineups.home.set) { this._lineupSide = "home"; this.render(); } }
    };
  },
};

// ================================================================ 打球・打席結果の入力
const RESULT_CATS = {
  hit: { label: "安打", items: [["single", "単打"], ["double", "二塁打"], ["triple", "三塁打"], ["home_run", "本塁打"]] },
  ground: { label: "ゴロ", items: [["ground_out", "ゴロアウト"], ["ground_dp", "併殺打"], ["force_out", "併殺崩れ・封殺"], ["fielders_choice", "野選"], ["reach_on_error_g", "失策で出塁"], ["sac_bunt", "犠打"]] },
  fly: { label: "フライ・ライナー", items: [["fly_out", "フライ"], ["line_out", "ライナー"], ["foul_fly", "ファウルフライ"], ["infield_fly", "インフィールドフライ"], ["sac_fly", "犠飛"], ["reach_on_error", "失策で出塁"]] },
  other: { label: "その他", items: [["interference", "打撃妨害"], ["batter_out_other", "守備妨害などでアウト"]] },
  kbb: { label: "三振・四死球", items: [["strikeout", "空振り三振"], ["strikeout_l", "見逃し三振"], ["strikeout_dropped", "振り逃げ（出塁）"], ["walk", "四球"], ["ibb", "申告敬遠"], ["hbp", "死球"]] },
};
const NEEDS_POS = new Set(["single", "double", "triple", "home_run", "ground_out", "ground_dp", "force_out", "fielders_choice", "reach_on_error_g", "reach_on_error", "sac_bunt", "fly_out", "line_out", "foul_fly", "infield_fly", "sac_fly"]);
const BATTER_OUT = new Set(["ground_out", "ground_dp", "fly_out", "line_out", "foul_fly", "infield_fly", "sac_fly", "sac_bunt", "strikeout", "strikeout_l", "batter_out_other"]);

const ResultSheet = {
  ed: null, kind: "in_play", st: null,
  open(ed, kind) {
    if (!ed.myLock() && !ed.mode) { toast("この端末は入力権がありません 「引き継ぐ」を押してください", true); return; }
    this.ed = ed; this.kind = kind;
    this.st = { cat: kind === "pa" ? "kbb" : "hit", ui: null, pos: null, moves: null, fielders: "", rbi: null, unconfirmed: false, note: "" };
    this.draw();
  },
  engineResult(ui) {
    return { ground_dp: "ground_out", reach_on_error_g: "reach_on_error", strikeout_l: "strikeout" }[ui] || ui;
  },
  defaultFielders(ui, pos) {
    if (!pos) return "";
    if (["ground_out", "sac_bunt"].includes(ui)) return pos === 3 ? "3" : `${pos}-3`;
    if (ui === "ground_dp") return pos === 3 ? "3" : "4-3";
    if (["fly_out", "line_out", "foul_fly", "infield_fly", "sac_fly"].includes(ui)) return String(pos);
    return "";
  },
  async loadMoves() {
    const s = this.st;
    if (!s.ui || (NEEDS_POS.has(s.ui) && !s.pos)) { s.moves = null; return; }
    const res = this.engineResult(s.ui);
    const req = s.ui === "ground_dp" ? "force_out" : res;
    try {
      const r = await api(`/api/edit/${this.ed.token}/suggest`, { method: "POST", body: { result: req, pos: s.pos, before: this.ed.mode?.target || null } });
      s.moves = r.moves.map(m => ({ ...m }));
      if (s.ui === "ground_dp") {
        const b = s.moves.find(m => m.from === "B"); b.to = "out";
        s.moves.filter(m => m.from !== "B" && m.to !== "out").forEach(m => { m.to = Math.min(4, m.from + 1); });
      }
      s.fielders = this.defaultFielders(s.ui, s.pos);
    } catch (e) { s.moves = null; showError(e); s.ui = null; }
  },
  draw() {
    const v = this.ed.view, s = this.st;
    const cats = this.kind === "pa" ? ["kbb", "hit", "ground", "fly", "other"] : ["hit", "ground", "fly", "other"];
    const cat = RESULT_CATS[s.cat];
    const needsPos = s.ui && NEEDS_POS.has(s.ui);
    const runners = s.moves ? this.runnersHtml(v) : "";
    const ready = s.ui && (!needsPos || s.pos) && s.moves;
    openSheet(`<h2>${this.kind === "pa" ? "打席の結果だけを入力" : "打球の結果"}</h2>
      ${this.kind === "pa" ? `<p class="muted">投球を記録しないで結果だけを残します（球数は数えません）</p>` : ""}
      <div class="chips">${cats.map(c => `<button class="chip ${c === s.cat ? "on" : ""}" data-cat="${c}">${RESULT_CATS[c].label}</button>`).join("")}</div>
      <p class="sec">結果</p>
      <div class="chips">${cat.items.map(([k, l]) => `<button class="chip ${k === s.ui ? "on" : ""}" data-ui="${k}">${l}</button>`).join("")}</div>
      ${needsPos ? `<p class="sec">${["single", "double", "triple", "home_run"].includes(s.ui) ? "打球の方向" : "打球を処理した野手"}</p>
        <div class="posfield">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="chip p${n} ${s.pos === n ? "on" : ""}" data-pos="${n}">${POS_JA[n]}</button>`).join("")}</div>` : ""}
      ${runners}
      <div class="sheet-actions"><button class="btn" data-a="c">やめる</button><button class="btn primary" data-a="ok" ${ready ? "" : "disabled"}>記録する</button></div>`, el => this.bind(el));
  },
  runnersHtml(v) {
    const s = this.st;
    const res = this.engineResult(s.ui);
    const rows = [];
    const bm = s.moves.find(m => m.from === "B");
    const batterOutFixed = BATTER_OUT.has(s.ui) && s.ui !== "sac_bunt";
    const bName = v.batter ? `${v.batter.order}番 ${pname(v.batter)}` : "打者";
    rows.push(`<div class="runner-row"><div class="who2">打者 <small>${esc(bName)}</small></div><div class="chips">
      ${[1, 2, 3, 4].map(b => `<button class="chip ${bm.to === b ? "on" : ""}" data-m="B" data-to="${b}" ${batterOutFixed ? "disabled" : ""}>${b === 4 ? "本塁" : BASE_JA[b]}</button>`).join("")}
      <button class="chip out ${bm.to === "out" ? "on" : ""}" data-m="B" data-to="out" ${!batterOutFixed && ["walk", "ibb", "hbp", "interference"].includes(res) ? "disabled" : ""}>アウト</button></div>
      ${bm.to === "out" && !["strikeout", "strikeout_l"].includes(s.ui) ? `<div class="opts"><label class="f" for="fl">アウトの守備の流れ（例 6-3、一塁手が自ら踏んだら 3）</label><input id="fl" type="text" inputmode="numeric" value="${esc(s.fielders)}"></div>` : ""}</div>`);
    for (const b of [3, 2, 1]) {
      const r = v.bases[b];
      if (!r) continue;
      let m = s.moves.find(x => x.from === b);
      if (!m) { m = { from: b, to: b, how: "adv" }; s.moves.push(m); }
      const hows = m.to === "out" ? ["force", "tag", "doubled_off"] : m.to === b ? [] : ["adv", "error", "tagup", "fc"];
      rows.push(`<div class="runner-row"><div class="who2">${BASE_JA[b]}走者 <small>${esc(r.order ? r.order + "番 " : "")}${esc(r.name)}</small></div><div class="chips">
        <button class="chip ${m.to === b ? "on" : ""}" data-m="${b}" data-to="${b}">そのまま</button>
        ${[2, 3, 4].filter(x => x > b).map(x => `<button class="chip ${m.to === x ? "on" : ""}" data-m="${b}" data-to="${x}">${x === 4 ? "生還" : BASE_JA[x]}</button>`).join("")}
        <button class="chip out ${m.to === "out" ? "on" : ""}" data-m="${b}" data-to="out">アウト</button></div>
        ${hows.length ? `<div class="chips opts">${hows.map(h => `<button class="chip ${m.how === h ? "on" : ""}" data-h="${b}" data-how="${h}">${HOW_JA[h]}</button>`).join("")}</div>` : ""}
        ${m.to === "out" ? `<div class="opts"><input type="text" inputmode="numeric" data-rf="${b}" placeholder="守備の流れ（例 6-4） 分からなければ空欄" value="${esc((m.fielders || []).join("-"))}"></div>` : ""}</div>`);
    }
    const outs = s.moves.filter(m => m.to === "out").length;
    const runs = s.moves.filter(m => m.to === 4).length;
    const after = v.outs + outs;
    const rbiTxt = s.rbi === null ? "自動" : `${s.rbi}（手入力）`;
    return `<p class="sec">走者の動き（初期値は一般的な動き 違えば押して直す）</p>${rows.join("")}
      <div class="outcome">${after >= 3 ? "3アウト 攻撃終了" : `${after}アウト`}${runs ? ` ／ 生還 ${runs}人` : ""}${after >= 3 && runs ? "<br><span class='muted'>3アウト目が打者・封殺のときは得点になりません</span>" : ""}</div>
      <div class="row-btns"><button class="btn small" data-a="rbi">打点：${rbiTxt}</button><button class="btn small ${s.unconfirmed ? "primary" : ""}" data-a="unc">${s.unconfirmed ? "未確認として記録 ✓" : "未確認として記録"}</button></div>`;
  },
  bind(el) {
    const s = this.st;
    el.querySelector("[data-a=c]").onclick = closeSheet;
    el.querySelectorAll("[data-cat]").forEach(b => b.onclick = () => { s.cat = b.dataset.cat; s.ui = null; s.pos = null; s.moves = null; this.draw(); });
    el.querySelectorAll("[data-ui]").forEach(b => b.onclick = async () => {
      s.ui = b.dataset.ui; s.moves = null; s.rbi = null;
      if (!NEEDS_POS.has(s.ui)) s.pos = null;
      await this.loadMoves(); this.draw();
    });
    el.querySelectorAll("[data-pos]").forEach(b => b.onclick = async () => { s.pos = parseInt(b.dataset.pos, 10); await this.loadMoves(); this.draw(); });
    el.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
      const from = b.dataset.m === "B" ? "B" : parseInt(b.dataset.m, 10);
      const to = b.dataset.to === "out" ? "out" : parseInt(b.dataset.to, 10);
      const m = s.moves.find(x => x.from === from);
      m.to = to;
      if (from !== "B") m.how = to === "out" ? "force" : (m.how && !["force", "tag", "doubled_off"].includes(m.how) ? m.how : "adv");
      this.keepInputs(el); this.draw();
    });
    el.querySelectorAll("[data-h]").forEach(b => b.onclick = () => {
      const m = s.moves.find(x => x.from === parseInt(b.dataset.h, 10)); m.how = b.dataset.how; this.keepInputs(el); this.draw();
    });
    const rbi = el.querySelector("[data-a=rbi]");
    if (rbi) rbi.onclick = async () => {
      this.keepInputs(el);
      const val = await askText("打点", "空欄にすると自動計算に戻します", s.rbi ?? "", "number");
      if (val !== null) s.rbi = val === "" ? null : Math.max(0, parseInt(val, 10) || 0);
      this.draw();
    };
    const unc = el.querySelector("[data-a=unc]");
    if (unc) unc.onclick = () => { this.keepInputs(el); s.unconfirmed = !s.unconfirmed; this.draw(); };
    const ok = el.querySelector("[data-a=ok]");
    ok.onclick = () => { this.keepInputs(el); this.submit(); };
  },
  keepInputs(el) {
    const s = this.st;
    const fl = el.querySelector("#fl");
    if (fl) s.fielders = fl.value;
    el.querySelectorAll("[data-rf]").forEach(i => {
      const m = s.moves.find(x => x.from === parseInt(i.dataset.rf, 10));
      if (m) m.fielders = parseSeq(i.value);
    });
  },
  async submit() {
    const s = this.st, ed = this.ed;
    const res = this.engineResult(s.ui);
    const moves = s.moves.map(m => {
      const o = { from: m.from, to: m.to, how: m.how || (m.from === "B" ? undefined : "adv") };
      if (m.fielders && m.fielders.length) o.fielders = m.fielders; else if (m.to === "out" && m.from !== "B") o.fielders_unknown = true;
      if (o.how === undefined) delete o.how;
      return o;
    }).filter(m => m.from === "B" || m.to !== m.from);
    const play = { result: res, pos: s.pos, moves };
    const seq = parseSeq(s.fielders);
    const bm = s.moves.find(m => m.from === "B");
    if (bm.to === "out" && seq.length) play.fielders = seq;
    else if (bm.to === "out" && !["strikeout"].includes(res)) play.fielders_unknown = true;
    if (s.rbi !== null) play.rbi = s.rbi;
    if (s.ui === "strikeout_l") play.looking = true;
    if (s.ui === "reach_on_error_g") play.ground = true;
    if (s.unconfirmed) play.unconfirmed = true;
    if (res === "strikeout_dropped") play.how = "wp";
    const meta = s.unconfirmed ? { unconfirmed: true } : {};
    if (this.kind === "pa") await ed.send("pa_result", play, meta);
    else await ed.send("pitch", { result: "in_play", play }, meta);
  },
};
function parseSeq(t) {
  return String(t || "").split(/[^0-9]+/).filter(Boolean).flatMap(x => x.length > 1 && !String(t).includes("-") ? x.split("") : [x]).map(Number).filter(n => n >= 1 && n <= 9);
}

// ================================================================ 走塁（盗塁・暴投・牽制など）
const RunnerSheet = {
  ed: null, st: null,
  open(ed, withPitch = null) {
    if (!ed.myLock() && !ed.mode) { toast("この端末は入力権がありません 「引き継ぐ」を押してください", true); return; }
    this.ed = ed;
    const v = ed.view;
    this.st = { pitch: withPitch, fixedPitch: !!withPitch, moves: {} };
    for (const b of [1, 2, 3]) if (v.bases[b]) this.st.moves[b] = { to: b, how: "sb", fielders: "" };
    this.draw();
  },
  draw() {
    const v = this.ed.view, s = this.st;
    const pitches = [["none", "投球なし（牽制・ボークなど）"], ["ball", "ボール"], ["called_strike", "見逃し"], ["swinging_strike", "空振り"], ["unknown", "投球（内容不明）"]];
    const rows = [3, 2, 1].filter(b => v.bases[b]).map(b => {
      const m = s.moves[b], r = v.bases[b];
      const hows = m.to === "out" ? ["cs", "po", "tag", "other"] : m.to === b ? [] : ["sb", "wp", "pb", "bk", "error", "adv", "other"];
      return `<div class="runner-row"><div class="who2">${BASE_JA[b]}走者 <small>${esc(r.order ? r.order + "番 " : "")}${esc(r.name)}</small></div>
        <div class="chips"><button class="chip ${m.to === b ? "on" : ""}" data-m="${b}" data-to="${b}">そのまま</button>
        ${[2, 3, 4].filter(x => x > b).map(x => `<button class="chip ${m.to === x ? "on" : ""}" data-m="${b}" data-to="${x}">${x === 4 ? "生還" : BASE_JA[x]}</button>`).join("")}
        <button class="chip out ${m.to === "out" ? "on" : ""}" data-m="${b}" data-to="out">アウト</button></div>
        ${hows.length ? `<div class="chips opts">${hows.map(h => `<button class="chip ${m.how === h ? "on" : ""}" data-h="${b}" data-how="${h}">${HOW_JA[h]}</button>`).join("")}</div>` : ""}
        ${m.to === "out" ? `<div class="opts"><input type="text" inputmode="numeric" data-rf="${b}" placeholder="守備の流れ（例 2-6） 分からなければ空欄" value="${esc(m.fielders)}"></div>` : ""}</div>`;
    }).join("");
    const changed = Object.entries(s.moves).some(([b, m]) => m.to !== parseInt(b, 10));
    const ready = changed && s.pitch;
    const pitchNote = s.pitch === "ball" && v.balls === 3 ? "（四球）" : (["called_strike", "swinging_strike"].includes(s.pitch) && v.strikes === 2 ? "（三振）" : "");
    openSheet(`<h2>走塁</h2>
      ${s.fixedPitch ? `<p>同時の投球：<b>${s.pitch === "called_strike" ? "見逃し" : "空振り"}三振</b></p>` : `<p class="sec">同時に投げられた球</p>
      <div class="chips">${pitches.map(([k, l]) => `<button class="chip ${s.pitch === k ? "on" : ""}" data-p="${k}">${l}</button>`).join("")}</div>${pitchNote ? `<p class="muted">この球で${pitchNote.slice(1, -1)}になります</p>` : ""}`}
      <p class="sec">走者の動き</p>${rows}
      <div class="sheet-actions"><button class="btn" data-a="c">やめる</button><button class="btn primary" data-a="ok" ${ready ? "" : "disabled"}>記録する</button></div>`, el => this.bind(el));
  },
  bind(el) {
    const s = this.st;
    el.querySelector("[data-a=c]").onclick = closeSheet;
    el.querySelectorAll("[data-p]").forEach(b => b.onclick = () => { this.keep(el); s.pitch = b.dataset.p; this.draw(); });
    el.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
      this.keep(el);
      const base = parseInt(b.dataset.m, 10), m = s.moves[base];
      m.to = b.dataset.to === "out" ? "out" : parseInt(b.dataset.to, 10);
      m.how = m.to === "out" ? (s.pitch === "none" ? "po" : "cs") : (["cs", "po", "tag"].includes(m.how) || m.to === base ? (s.pitch === "none" ? "bk" : "sb") : m.how);
      this.draw();
    });
    el.querySelectorAll("[data-h]").forEach(b => b.onclick = () => { this.keep(el); s.moves[parseInt(b.dataset.h, 10)].how = b.dataset.how; this.draw(); });
    el.querySelector("[data-a=ok]").onclick = async () => {
      this.keep(el);
      const moves = Object.entries(s.moves).filter(([b, m]) => m.to !== parseInt(b, 10)).map(([b, m]) => {
        const o = { from: parseInt(b, 10), to: m.to, how: m.how };
        const f = parseSeq(m.fielders);
        if (m.to === "out") { if (f.length) o.fielders = f; else o.fielders_unknown = true; }
        return o;
      });
      if (s.pitch === "none") await this.ed.send("runner", { moves });
      else await this.ed.send("pitch", { result: s.pitch, runners: moves });
    };
  },
  keep(el) { el.querySelectorAll("[data-rf]").forEach(i => { this.st.moves[parseInt(i.dataset.rf, 10)].fielders = i.value; }); },
};

// ================================================================ 選手交代
const SubSheet = {
  ed: null, st: null,
  open(ed) {
    if (!ed.myLock() && !ed.mode) { toast("この端末は入力権がありません 「引き継ぐ」を押してください", true); return; }
    this.ed = ed;
    this.st = { kind: "pinch_hitter", side: ed.view.batting_side, base: null, inP: "", outP: "", pos: "" };
    this.draw();
  },
  draw() {
    const v = this.ed.view, s = this.st, r = this.ed.v.roster;
    const kinds = [["pinch_hitter", "代打"], ["pinch_runner", "代走"], ["temp_runner", "臨時代走"], ["pitcher", "投手交代"], ["defense", "守備交代"], ["position", "守備位置の変更"]];
    if (["pinch_hitter", "pinch_runner", "temp_runner"].includes(s.kind)) s.side = v.batting_side;
    const lu = v.lineups[s.side];
    const inLineup = new Set(lu.slots.map(x => x.id));
    const removed = new Set(lu.removed);
    const benchOpts = r[s.side].filter(p => !inLineup.has(p.id) && (!lu.pitcher || p.id !== lu.pitcher.id || s.kind === "position"))
      .map(p => `<option value="${esc(p.id)}" ${s.inP === p.id ? "selected" : ""}>${esc(pname(p))}${removed.has(p.id) ? "（再出場）" : ""}</option>`).join("");
    const lineupOpts = lu.slots.map(x => `<option value="${esc(x.id)}" ${s.outP === x.id ? "selected" : ""}>${x.order}番 ${esc(x.name)}${x.position ? "（" + POS_CODE_JA[x.position] + "）" : ""}</option>`).join("");
    const posOpts = POS_CODES.filter(c => c !== "P").map(c => `<option value="${c}" ${s.pos === c ? "selected" : ""}>${POS_CODE_JA[c]}</option>`).join("");
    const bases = [1, 2, 3].filter(b => v.bases[b]);
    let fields = "";
    if (s.kind === "pinch_hitter") {
      fields = `<p>交代する打者：<b>${v.batter ? esc(`${v.batter.order}番 ${v.batter.name}`) : "—"}</b></p>
        <label class="f" for="inP">代打の選手</label><select id="inP"><option value="">（選ぶ）</option>${benchOpts}</select>`;
    } else if (s.kind === "pinch_runner" || s.kind === "temp_runner") {
      fields = `<p class="sec">塁</p><div class="chips">${bases.map(b => `<button class="chip ${s.base === b ? "on" : ""}" data-b="${b}">${BASE_JA[b]} ${esc(v.bases[b].name)}</button>`).join("") || "<span class='muted'>走者がいません</span>"}</div>
        <label class="f" for="inP">${s.kind === "temp_runner" ? "臨時代走の選手（成績は元の走者に付きます）" : "代走の選手"}</label>
        <select id="inP"><option value="">（選ぶ）</option>${s.kind === "temp_runner" ? r[s.side].map(p => `<option value="${esc(p.id)}" ${s.inP === p.id ? "selected" : ""}>${esc(pname(p))}</option>`).join("") : benchOpts}</select>`;
    } else if (s.kind === "pitcher") {
      fields = `<p>今の投手：<b>${esc(lu.pitcher ? lu.pitcher.name : "—")}</b></p>
        <label class="f" for="inP">新しい投手</label><select id="inP"><option value="">（選ぶ）</option>${r[s.side].filter(p => !lu.pitcher || p.id !== lu.pitcher.id).map(p => `<option value="${esc(p.id)}" ${s.inP === p.id ? "selected" : ""}>${esc(pname(p))}${inLineup.has(p.id) ? "（守備から）" : ""}</option>`).join("")}</select>
        <label class="f" for="outP">打順で入れ替わる選手（DHで打順に入らないなら空欄）</label><select id="outP"><option value="">（なし）</option>${lineupOpts}</select>`;
    } else if (s.kind === "defense") {
      fields = `<label class="f" for="outP">退く選手</label><select id="outP"><option value="">（選ぶ）</option>${lineupOpts}</select>
        <label class="f" for="inP">入る選手</label><select id="inP"><option value="">（選ぶ）</option>${benchOpts}</select>
        <label class="f" for="pos">守備位置</label><select id="pos"><option value="">（選ぶ）</option>${posOpts}</select>`;
    } else {
      fields = `<label class="f" for="inP">選手</label><select id="inP"><option value="">（選ぶ）</option>${lineupOpts.replaceAll("outP", "inP")}</select>
        <label class="f" for="pos">新しい守備位置</label><select id="pos"><option value="">（選ぶ）</option>${posOpts}</select>`;
    }
    const sidePick = ["pitcher", "defense", "position"].includes(s.kind)
      ? `<div class="chips" style="margin-top:10px">${["away", "home"].map(x => `<button class="chip ${s.side === x ? "on" : ""}" data-side="${x}">${esc(this.ed.v.team_names[x])}</button>`).join("")}</div>` : "";
    openSheet(`<h2>選手交代</h2><div class="chips">${kinds.map(([k, l]) => `<button class="chip ${s.kind === k ? "on" : ""}" data-k="${k}">${l}</button>`).join("")}</div>
      ${sidePick}${fields}
      <div class="sheet-actions"><button class="btn" data-a="c">やめる</button><button class="btn primary" data-a="ok">交代を記録</button></div>`, el => this.bind(el));
  },
  bind(el) {
    const s = this.st, v = this.ed.view;
    const keep = () => { ["inP", "outP", "pos"].forEach(id => { const x = el.querySelector("#" + id); if (x) s[id] = x.value; }); };
    el.querySelector("[data-a=c]").onclick = closeSheet;
    el.querySelectorAll("[data-k]").forEach(b => b.onclick = () => {
      keep(); s.kind = b.dataset.k; s.inP = s.outP = s.pos = ""; s.base = null;
      s.side = s.kind === "pitcher" ? (v.batting_side === "away" ? "home" : "away") : v.batting_side; this.draw();
    });
    el.querySelectorAll("[data-side]").forEach(b => b.onclick = () => { keep(); s.side = b.dataset.side; s.inP = s.outP = ""; this.draw(); });
    el.querySelectorAll("[data-b]").forEach(b => b.onclick = () => { keep(); s.base = parseInt(b.dataset.b, 10); this.draw(); });
    el.querySelector("[data-a=ok]").onclick = async () => {
      keep();
      if (!s.inP) { toast("選手を選んでください", true); return; }
      const p = { kind: s.kind, side: s.side, in_player: s.inP };
      if (["pinch_runner", "temp_runner"].includes(s.kind)) { if (!s.base) { toast("塁を選んでください", true); return; } p.base = s.base; }
      if (s.kind === "pitcher" && s.outP) p.out_player = s.outP;
      if (s.kind === "defense") { if (!s.outP || !s.pos) { toast("退く選手と守備位置を選んでください", true); return; } p.out_player = s.outP; p.position = s.pos; }
      if (s.kind === "position") { if (!s.pos) { toast("守備位置を選んでください", true); return; } p.position = s.pos; }
      const r = await this.ed.send("sub", p);
      if (r) toast("交代を記録しました");
    };
  },
};

// ================================================================ 選手の通算成績
async function pagePlayer(id) {
  $app.innerHTML = topbar("選手成績") + `<div class="wrap"><p class="muted">読み込み中…</p></div>`;
  try {
    const d = await api(`/api/players/${id}/stats`);
    const b = d.career.batting, p = d.career.pitching;
    document.querySelector(".topbar .title").textContent = d.player.name;
    document.querySelector(".wrap").innerHTML = `<h1>${esc(pname(d.player))}</h1><p class="muted">${esc(d.player.team)} ／ ${d.career.games}試合</p>
      <h2>打撃</h2><div class="scroll-x"><table class="stats"><thead><tr><th>打率</th><th>出塁率</th><th>長打率</th><th>打席</th><th>打数</th><th>安打</th><th>二塁打</th><th>三塁打</th><th>本塁打</th><th>打点</th><th>得点</th><th>三振</th><th>四球</th><th>死球</th><th>犠打</th><th>犠飛</th><th>盗塁</th></tr></thead>
      <tbody><tr><td>${b.AVG ?? "-"}</td><td>${b.OBP ?? "-"}</td><td>${b.SLG ?? "-"}</td><td>${b.PA}</td><td>${b.AB}</td><td>${b.H}</td><td>${b["2B"]}</td><td>${b["3B"]}</td><td>${b.HR}</td><td>${b.RBI}</td><td>${b.R}</td><td>${b.SO}</td><td>${b.BB}</td><td>${b.HBP}</td><td>${b.SH}</td><td>${b.SF}</td><td>${b.SB}</td></tr></tbody></table></div>
      ${p.OUTS || p.BF ? `<h2>投手</h2><div class="scroll-x"><table class="stats"><thead><tr><th>防御率</th><th>勝</th><th>敗</th><th>投球回</th><th>打者</th><th>球数</th><th>安打</th><th>本塁打</th><th>三振</th><th>四球</th><th>死球</th><th>失点</th><th>自責</th></tr></thead>
      <tbody><tr><td>${p.ERA ?? "-"}</td><td>${p.W}</td><td>${p.L}</td><td>${p.IP}</td><td>${p.BF}</td><td>${p.pitches}</td><td>${p.H}</td><td>${p.HR}</td><td>${p.SO}</td><td>${p.BB}</td><td>${p.HBP}</td><td>${p.R}</td><td>${p.ER}</td></tr></tbody></table></div><p class="muted">防御率は9回換算</p>` : ""}
      <h2>出場試合</h2><ul class="list">${d.games.map(g => `<li><a href="/g/${esc(g.view_token)}" data-link><span class="grow">${esc(g.date)} ${esc(g.away)} 対 ${esc(g.home)}<br><span class="muted">${g.bat.PA ? `${g.bat.AB || 0}打数${g.bat.H || 0}安打${g.bat.RBI ? " " + g.bat.RBI + "打点" : ""}` : ""}${g.decision ? " " + g.decision : ""}</span></span><span class="score">${g.summary?.away ?? 0}-${g.summary?.home ?? 0}</span></a></li>`).join("") || "<li class='ev'>まだありません</li>"}</ul>`;
  } catch (e) { showError(e); }
}

route();
