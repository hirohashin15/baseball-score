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
const POS_CODE_NAME = { P: "投手", C: "捕手", "1B": "一塁手", "2B": "二塁手", "3B": "三塁手", SS: "遊撃手", LF: "左翼手", CF: "中堅手", RF: "右翼手", DH: "指名打者" };
const BASE_JA = { 1: "一塁", 2: "二塁", 3: "三塁", 4: "本塁" };
const HOW_JA = { sb: "盗塁", cs: "盗塁死", wp: "暴投", pb: "捕逸", bk: "ボーク", po: "牽制死", error: "失策", adv: "進塁", force: "封殺", tag: "タッチアウト", doubled_off: "帰塁できず", tagup: "タッチアップ", fc: "野選", other: "その他" };
const PITCH_JA = { ball: "ボール", called_strike: "見逃し", swinging_strike: "空振り", foul: "ファウル", foul_bunt: "バントファウル", foul_tip: "ファウルチップ", hbp: "死球", in_play: "打球", unknown: "内容不明" };
const PITCH_SHORT = { ball: "B", called_strike: "見", swinging_strike: "空", foul: "F", foul_bunt: "BF", foul_tip: "FT", hbp: "死", in_play: "打", unknown: "?" };
const STRIKES = ["called_strike", "swinging_strike", "foul", "foul_bunt", "foul_tip"];

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
function toast(msg, kind = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "show" + (kind === true || kind === "err" ? " err" : kind === "ok" ? " ok" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ""; }, kind === true || kind === "err" ? 4500 : 2000);
}
// 押したときの手応え（iPhoneは振動の仕組みが限られるため、対応している端末だけ）
function haptic() {
  try {
    if (navigator.vibrate) { navigator.vibrate(12); return; }
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox"; input.setAttribute("switch", "");
    label.style.cssText = "position:fixed;opacity:0;pointer-events:none;left:-99px";
    label.appendChild(input); document.body.appendChild(label);
    label.click(); label.remove();
  } catch { /* 振動できない端末は何もしない */ }
}
document.addEventListener("pointerdown", ev => {
  const b = ev.target.closest("button, a.btn, .chip");
  if (b && !b.disabled) haptic();
}, { passive: true });
function halfJa(h) { return h === "top" ? "表" : "裏"; }
function pname(p) { return p ? (p.number ? `${p.number} ${p.name}` : p.name) : "—"; }
function linkBtn(href, label, cls = "") {
  return `<a class="btn ${cls}" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="${esc(href)}" data-link>${esc(label)}</a>`;
}

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
  if (!res.ok) {
    if (res.status === 422 && data && Array.isArray(data.detail)) data = { message: "入力内容を確認してください（未入力の項目があります）" };
    throw new ApiError(res.status, data);
  }
  return data;
}
// 管理用パスコードが必要な操作：違っていたら入力を求めてやり直す
async function apiAdmin(path, opts) {
  try { return await api(path, opts); } catch (e) {
    if (e.status !== 401) throw e;
    const pass = await askText("管理用パスコード", "チーム登録・試合作成・削除に必要です", "", "password");
    if (pass === null) throw e;
    store.set("bs_pass", pass);
    return api(path, opts);
  }
}
let healthInfo = null;
async function health() {
  if (!healthInfo) { try { healthInfo = await api("/api/health"); } catch { healthInfo = {}; } }
  return healthInfo;
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
let pollTimer = null, lockTimer = null, navDepth = 0;
function go(path) { history.pushState({ d: ++navDepth }, "", path); route(); }
function back() { if (navDepth > 0) { navDepth--; history.back(); } else { history.replaceState(null, "", "/"); route(); } }
window.addEventListener("popstate", ev => { navDepth = ev.state?.d ? ev.state.d : 0; route(); });
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
  if (parts[0] === "s" && parts[1]) return pageScorebook(parts[1]);
  if (parts[0] === "t" && parts[1]) return pageTeam(parts[1]);
  if (parts[0] === "teams") return pageTeams();
  if (parts[0] === "new") return pageNew();
  return pageHome();
}
// 上部バー：左に「戻る」、右に「トップ」（とメニュー）
function topbar(title, right = "", home = false) {
  return `<header class="topbar">${home ? "" : `<button id="nav-back" aria-label="前の画面に戻る">戻る</button>`}
    <div class="title">${esc(title)}</div>${right}${home ? "" : `<a class="btnlink" href="/" data-link>トップ</a>`}</header>`;
}
function bindTopbar() { const b = document.getElementById("nav-back"); if (b) b.onclick = back; }
function showError(e) { toast(e.message || String(e), "err"); }

// ================================================================ トップ
async function pageHome() {
  const mine = store.get("bs_mygames", []);
  const myTeam = store.get("bs_myteam");
  $app.innerHTML = topbar("野球スコア β", "", true) + `
  <div class="wrap">
    ${myTeam ? `<p class="muted" style="margin-top:14px">自分のチーム：<b>${esc(myTeam.name)}</b></p>` : ""}
    <div class="row-btns" style="margin-top:12px">${linkBtn("/new", "試合をつくる", "primary")}${linkBtn("/teams", "チーム・選手")}</div>
    <h2>この端末で入力できる試合</h2>
    ${mine.length ? `<ul class="list">${mine.map(g => `<li><a href="/e/${esc(g.edit_token)}" data-link><span class="grow">${esc(g.label)}<br><span class="muted">${esc(g.date || "")}</span></span><span class="tag">入力</span></a></li>`).join("")}</ul>`
      : `<p class="muted">まだありません 試合をつくるか、共有された入力用URLを開くとここに出ます</p>`}
    <h2>最近の試合</h2>
    <div id="recent"><p class="muted">読み込み中…</p></div>
    <div id="fxbox"></div>
  </div>`;
  bindTopbar();
  const h = await health();
  if (h.fixture) {
    document.getElementById("fxbox").innerHTML = `<h2>検証用</h2><p class="muted">2026年10月18日 Nexus Tokyo 対 EDOSEN（2－6）の記録を読み込みます</p><button class="btn block" id="fx">検証試合を読み込む</button>`;
    document.getElementById("fx").onclick = async () => {
      try {
        const r = await apiAdmin("/api/admin/import-fixture", { method: "POST" });
        rememberGame({ edit_token: r.edit_token, view_token: r.view_token, label: "【検証】Nexus Tokyo 対 EDOSEN", date: "2026-10-18" });
        go(`/e/${r.edit_token}`);
      } catch (e) { showError(e); }
    };
  }
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
function forgetGame(editToken) { store.set("bs_mygames", store.get("bs_mygames", []).filter(x => x.edit_token !== editToken)); }

// ================================================================ チーム・選手
function teamForm(t) {
  return new Promise(resolve => {
    openSheet(`<h2>${t ? "チームを編集" : "チームを追加"}</h2>
      <label class="f" for="tn">チーム名</label><input id="tn" type="text" value="${esc(t?.name || "")}" autocomplete="off">
      <label class="f" for="ts">略称（スコアボードに出る名前 8文字まで）</label><input id="ts" type="text" maxlength="8" value="${esc(t?.short_name || "")}" autocomplete="off">
      <div class="sheet-actions"><button class="btn" data-a="c">やめる</button><button class="btn primary" data-a="ok">${t ? "保存" : "追加"}</button></div>`, el => {
      setTimeout(() => el.querySelector("#tn").focus(), 50);
      el.querySelector("[data-a=c]").onclick = () => { closeSheet(); resolve(null); };
      el.querySelector("[data-a=ok]").onclick = async () => {
        const name = el.querySelector("#tn").value.trim(), short_name = el.querySelector("#ts").value.trim();
        if (!name || !short_name) { toast("チーム名と略称を入力してください", "err"); return; }
        try {
          const r = t ? await apiAdmin(`/api/teams/${t.id}`, { method: "PATCH", body: { name, short_name } })
            : await apiAdmin("/api/teams", { method: "POST", body: { name, short_name } });
          closeSheet(); toast(t ? "保存しました" : `${name}を追加しました`, "ok"); resolve(r);
        } catch (e) { showError(e); }
      };
    });
  });
}
async function pageTeams() {
  $app.innerHTML = topbar("チーム・選手") + `<div class="wrap"><div id="body"><p class="muted">読み込み中…</p></div></div>`;
  bindTopbar();
  const my = store.get("bs_myteam");
  try {
    const teams = await api("/api/teams");
    document.getElementById("body").innerHTML = `
      <button class="btn primary block" id="add" style="margin-top:14px">チームを追加</button>
      ${teams.length ? `<ul class="list">${teams.map(t => `<li><a href="/t/${esc(t.id)}" data-link><span class="grow">${esc(t.name)}${my && my.id === t.id ? ' <span class="tag">自分のチーム</span>' : ""}<br><span class="muted">略称：${esc(t.short_name || "未設定")}</span></span><span class="muted">${t.players}人</span></a></li>`).join("")}</ul>`
        : `<p class="muted">チームがまだありません 「チームを追加」から登録してください</p>`}`;
    document.getElementById("add").onclick = async () => { const t = await teamForm(null); if (t) go(`/t/${t.id}`); };
  } catch (e) { showError(e); }
}
async function pageTeam(id) {
  $app.innerHTML = topbar("選手一覧") + `<div class="wrap"><div id="body"><p class="muted">読み込み中…</p></div></div>`;
  bindTopbar();
  const draw = async () => {
    const t = await api(`/api/teams/${id}`);
    const my = store.get("bs_myteam");
    document.querySelector(".topbar .title").textContent = t.name;
    document.getElementById("body").innerHTML = `
      <p class="muted" style="margin-top:12px">略称：${esc(t.short_name || "未設定")}${my && my.id === t.id ? " ／ 自分のチーム" : ""}</p>
      <div class="row-btns"><button class="btn primary" id="add">選手を追加</button><button class="btn" id="edit">チーム名・略称</button></div>
      ${t.players.length ? `<div class="tiles">${t.players.map(p => `<button class="tile${p.active ? "" : " off"}" data-pid="${esc(p.id)}"><span class="no num">${esc(p.number || "－")}</span><span class="nm">${esc(p.name)}</span></button>`).join("")}</div>
        <p class="muted">選手を押すと編集・成績の確認ができます</p>` : `<p class="muted">選手がまだいません</p>`}
      <div class="row-btns" style="margin-top:24px">
        <button class="btn" id="mine" ${my && my.id === t.id ? "disabled" : ""}>自分のチームにする</button>
        <button class="btn danger" id="del">チームを削除</button></div>`;
    document.getElementById("add").onclick = () => playerForm(id, null, draw);
    document.getElementById("edit").onclick = async () => { if (await teamForm(t)) draw(); };
    document.getElementById("mine").onclick = () => { store.set("bs_myteam", { id: t.id, name: t.name }); toast("自分のチームにしました", "ok"); draw(); };
    document.getElementById("del").onclick = async () => {
      if (t.games) { toast(`このチームの試合が${t.games}件残っているため削除できません`, "err"); return; }
      if (!(await confirmSheet("チームを削除", `「${esc(t.name)}」と登録選手を削除します 元に戻せません`, "削除する", true))) return;
      try { await apiAdmin(`/api/teams/${id}`, { method: "DELETE" }); if (my && my.id === id) store.set("bs_myteam", null); toast("削除しました"); go("/teams"); } catch (e) { showError(e); }
    };
    document.querySelectorAll("[data-pid]").forEach(b => b.onclick = () => {
      const p = t.players.find(x => x.id === b.dataset.pid);
      openSheet(`<h2>${esc(pname(p))}</h2><button class="btn block" data-a="stats">成績を見る</button><button class="btn block" data-a="edit">名前・背番号を編集</button>
        <div class="sheet-actions"><button class="btn" data-a="c">閉じる</button></div>`, el => {
        el.querySelector("[data-a=c]").onclick = closeSheet;
        el.querySelector("[data-a=stats]").onclick = () => go(`/p/${p.id}`);
        el.querySelector("[data-a=edit]").onclick = () => playerForm(id, p, draw);
      });
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
        if (!name) { toast("名前を入力してください", "err"); return; }
        try {
          let r;
          if (p) r = await apiAdmin(`/api/players/${p.id}`, { method: "PATCH", body: { name, number, active: el.querySelector("#pact").checked } });
          else r = await (editToken ? api : apiAdmin)(`/api/teams/${teamId}/players`, { method: "POST", body: { name, number }, headers: editToken ? { "X-Edit-Token": editToken } : {} });
          closeSheet(); toast(p ? "保存しました" : `${name}を追加しました`, "ok");
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
  bindTopbar();
  let teams;
  try { teams = await api("/api/teams"); } catch (e) { showError(e); return; }
  let my = store.get("bs_myteam");
  if (my && !teams.some(t => t.id === my.id)) my = null;
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const st = { mine: my?.id || "", opp: "", side: "away" };
  const draw = () => {
    const opts = (sel, excl) => teams.filter(t => t.id !== excl).map(t => `<option value="${esc(t.id)}" ${t.id === sel ? "selected" : ""}>${esc(t.name)}</option>`).join("");
    document.getElementById("body").innerHTML = `
      <label class="f" for="d">日付</label><input id="d" type="date" value="${esc(st.date || today)}">
      <label class="f" for="mine">自分のチーム</label>
      <select id="mine"><option value="">（選ぶ）</option>${opts(st.mine)}</select>
      ${!teams.length ? `<p class="muted">先に<a href="/teams" data-link>チーム・選手</a>で自分のチームを登録してください</p>` : ""}
      <p class="sec muted" style="margin:14px 0 6px">自分のチームは</p>
      <div class="chips"><button class="chip ${st.side === "away" ? "on" : ""}" data-side="away">先攻</button><button class="chip ${st.side === "home" ? "on" : ""}" data-side="home">後攻</button></div>
      <label class="f" for="opp">相手チーム</label>
      <select id="opp"><option value="">（選ぶ）</option>${opts(st.opp, st.mine)}<option value="__new" ${st.opp === "__new" ? "selected" : ""}>＋ 新しい相手チームを登録</option></select>
      ${st.opp === "__new" ? `<div class="newopp"><label class="f" for="on">相手のチーム名</label><input id="on" type="text" value="${esc(st.on || "")}" autocomplete="off">
        <label class="f" for="os">略称（8文字まで）</label><input id="os" type="text" maxlength="8" value="${esc(st.os || "")}" autocomplete="off">
        <p class="muted">相手の選手は、試合のスタメン入力のときに追加できます</p></div>` : ""}
      <label class="f" for="v">球場（なくても可）</label><input id="v" type="text" value="${esc(st.v || "")}">
      <label class="f" for="inn">規定の回数</label><input id="inn" type="number" min="1" max="20" value="${esc(st.inn || 9)}" inputmode="numeric">
      <label class="check"><input id="xh" type="checkbox" ${st.xh ? "checked" : ""}> 打順10人以上（守備に就かない打者を入れる）</label>
      <details><summary class="muted" style="min-height:44px;display:flex;align-items:center">その他のルール（通常は変更不要）</summary>
        <label class="check"><input id="re" type="checkbox" checked> 再出場あり</label>
        <label class="check"><input id="dh" type="checkbox" checked> DHあり（投手が打順に入らなくてもよい）</label>
        <label class="check"><input id="tr" type="checkbox" checked> 臨時代走あり</label>
      </details>
      <button class="btn primary block" id="go" style="margin-top:20px">試合をつくる</button>`;
    const keep = () => {
      st.date = document.getElementById("d").value; st.mine = document.getElementById("mine").value; st.opp = document.getElementById("opp").value;
      st.v = document.getElementById("v").value; st.inn = document.getElementById("inn").value; st.xh = document.getElementById("xh").checked;
      const on = document.getElementById("on"); if (on) { st.on = on.value; st.os = document.getElementById("os").value; }
    };
    document.getElementById("mine").onchange = () => { keep(); if (st.opp === st.mine) st.opp = ""; draw(); };
    document.getElementById("opp").onchange = () => { keep(); draw(); };
    document.querySelectorAll("[data-side]").forEach(b => b.onclick = () => { keep(); st.side = b.dataset.side; draw(); });
    document.getElementById("go").onclick = async () => {
      keep();
      if (!st.mine) { toast("自分のチームを選んでください", "err"); return; }
      try {
        let opp = st.opp;
        if (!opp) { toast("相手チームを選んでください", "err"); return; }
        if (opp === "__new") {
          if (!st.on?.trim() || !st.os?.trim()) { toast("相手のチーム名と略称を入力してください", "err"); return; }
          const t = await apiAdmin("/api/teams", { method: "POST", body: { name: st.on.trim(), short_name: st.os.trim() } });
          teams.push({ ...t, players: 0 }); opp = t.id; st.opp = t.id;
        }
        const mineT = teams.find(t => t.id === st.mine);
        store.set("bs_myteam", { id: mineT.id, name: mineT.name });
        const away = st.side === "away" ? st.mine : opp, home = st.side === "away" ? opp : st.mine;
        const body = {
          date: st.date, away_team_id: away, home_team_id: home, venue: st.v || null,
          innings: parseInt(st.inn || "9", 10), extra_hitters: st.xh,
          reentry: document.getElementById("re").checked, dh: document.getElementById("dh").checked, temp_runner: document.getElementById("tr").checked,
        };
        const r = await apiAdmin("/api/games", { method: "POST", body });
        const label = `${teams.find(t => t.id === away).name} 対 ${teams.find(t => t.id === home).name}`;
        rememberGame({ edit_token: r.edit_token, view_token: r.view_token, label, date: body.date });
        shareSheet(r.edit_token, r.view_token, () => go(`/e/${r.edit_token}`));
      } catch (e) { showError(e); }
    };
  };
  draw();
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
      try { await navigator.clipboard.writeText(b.dataset.c); toast("コピーしました", "ok"); } catch { toast("コピーできませんでした 長押しで選択してください", "err"); }
    });
    el.querySelectorAll("[data-s]").forEach(b => b.onclick = () => navigator.share({ url: b.dataset.s }).catch(() => {}));
    el.querySelector("[data-a=ok]").onclick = () => { closeSheet(); if (after) after(); };
  });
}

// ================================================================ スコアボード・走者の表示（入力・閲覧で共通）
function shortName(v, side) { return (v.team_short && v.team_short[side]) || v.team_names[side]; }
// スコアボードの各マスの値（前回と比べて変わったところだけ光らせる）
function boardKeys(v) {
  const k = {};
  if (!v) return k;
  for (const side of ["away", "home"]) {
    v.linescore[side].forEach((x, i) => { k[`ls-${side}-${i + 1}`] = x; });
    k[`R-${side}`] = v.rhe[side].R; k[`H-${side}`] = v.rhe[side].H; k[`E-${side}`] = v.rhe[side].E;
  }
  k.B = v.balls; k.S = v.strikes; k.O = v.outs; k.J = (v.judge || []).join(",") + "@" + (v.game?.version ?? "");
  k.inn = `${v.inning}${v.half}${v.status}`;
  return k;
}
function boardDiff(prev, cur) {
  if (!prev) return new Set();
  const a = boardKeys(prev), b = boardKeys(cur);
  const out = new Set();
  for (const key of Object.keys(b)) if (a[key] !== b[key]) out.add(key);
  if (out.has("J") && !(cur.judge || []).length) out.delete("J");
  return out;
}
function boardHtml(v, changed = new Set()) {
  const inn = Math.max(v.linescore.away.length, v.linescore.home.length, v.rules.innings || 9);
  const cols = Array.from({ length: inn }, (_, i) => i + 1);
  const chg = key => changed.has(key) ? " chg" : "";
  const row = side => {
    const cells = cols.map(i => {
      const val = v.linescore[side][i - 1];
      const cur = v.status === "live" && i === v.inning && v.batting_side === side;
      const txt = val === null ? "×" : val === undefined ? "" : val;
      const can = val !== undefined && val !== null;
      return `<td class="num${cur ? " cur" : ""}${chg(`ls-${side}-${i}`)}">${can ? `<button class="cell" data-inn="${i}" data-side="${side}" aria-label="${i}回${side === "away" ? "表" : "裏"}の1球ごとの記録">${txt}</button>` : txt}</td>`;
    }).join("");
    return `<tr class="${v.status === "live" && v.batting_side === side ? "batting" : ""}"><td class="team">${esc(shortName(v, side))}</td>${cells}<td class="num r${chg(`R-${side}`)}">${v.rhe[side].R}</td><td class="num${chg(`H-${side}`)}">${v.rhe[side].H}</td><td class="num${chg(`E-${side}`)}">${v.rhe[side].E}</td></tr>`;
  };
  const lamps = (n, k, max) => Array.from({ length: max }, (_, i) => `<i class="lamp ${k}${i < n ? " on" : ""}"></i>`).join("");
  const state = v.status === "final" ? `<span class="final-flag">試合終了</span>`
    : v.status === "pregame" ? `<span class="inning">開始前</span>`
      : `<span class="inning${chg("inn")}">${v.inning}<small>回${halfJa(v.half)}</small></span>`;
  const j = new Set(v.judge || []);
  const judge = v.status !== "pregame" ? `<div class="judge${chg("J")}" aria-label="直前のプレーの判定 ${[...j].map(x => ({ H: "安打", E: "失策", FC: "野選" }[x])).join(" ") || "なし"}">
      <i class="jl${j.has("H") ? " on" : ""}">H</i><i class="jl${j.has("E") ? " on" : ""}">E</i><i class="jl fc${j.has("FC") ? " on" : ""}">Fc</i></div>` : "";
  return `<section class="board" aria-label="スコアボード">
    <div class="ls-wrap"><table class="ls${inn > 9 ? " many" : ""}"><thead><tr><th></th>${cols.map(i => `<th>${i}</th>`).join("")}<th>R</th><th>H</th><th>E</th></tr></thead>
    <tbody>${row("away")}${row("home")}</tbody></table></div>
    <div class="state">${state}${judge}${v.status === "live" ? `<div class="lamps" aria-label="ボール${v.balls} ストライク${v.strikes} アウト${v.outs}">
      <span class="${chg("B").trim()}"><b>B</b>${lamps(v.balls, "b", 3)}</span><span class="${chg("S").trim()}"><b>S</b>${lamps(v.strikes, "s", 2)}</span><span class="${chg("O").trim()}"><b>O</b>${lamps(v.outs, "o", 2)}</span></div>` : ""}</div>
  </section>`;
}
function bindBoard(v, ed = null) {
  $app.querySelectorAll(".board .cell").forEach(b => b.onclick = () => halfInningSheet(v, parseInt(b.dataset.inn, 10), b.dataset.side, ed));
}
// スコアボードの回を押したとき：その回の1球ごとの記録（入力画面ではそれぞれ修正できる）
function halfInningSheet(v, inning, side, ed = null) {
  const half = side === "away" ? "top" : "bottom";
  const pas = v.pa_log.filter(p => p.inning === inning && p.side === side);
  const runs = v.linescore[side][inning - 1] || 0;
  const filter = e => e.inning === inning && e.half === half && e.type !== "lineup";
  openSheet(`<h2>${inning}回${halfJa(half)} ${esc(v.team_names[side])}</h2>
    <p class="muted">${runs}点${pas.length ? ` ／ ${pas.length}打席` : ""}${ed ? " ／ 1球を押すと修正できます" : " ／ 1球を押すと詳細が見られます"}</p>
    ${eventsHtml(v, !!ed, filter, true)}
    <div class="sheet-actions"><button class="btn" data-a="c">閉じる</button></div>`, el => {
    el.querySelector("[data-a=c]").onclick = closeSheet;
    el.querySelectorAll("[data-ev]").forEach(b => b.onclick = () => eventDetailSheet(ed ? ed.v : v, b.dataset.ev, ed, () => halfInningSheet(ed ? ed.v : v, inning, side, ed)));
  });
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
  const seq = (v.pa_pitches || []).map(p => `<span class="pchip ${p === "ball" ? "b" : STRIKES.includes(p) ? "s" : ""}">${PITCH_SHORT[p] || "?"}</span>`).join("");
  return `<div class="who">
    <div class="row"><span class="role">打者</span><span class="name">${v.batter ? `${v.batter.order}番 ${esc(pname(v.batter))}` : "—"}</span></div>
    <div class="row"><span class="role">次</span><span class="muted">${esc(pname(v.ondeck))}</span></div>
    <div class="row"><span class="role">投手</span><span class="name">${esc(pname(v.pitcher))}</span><span class="muted num">${v.pitcher ? v.pitcher.pitches + "球" : ""}</span></div>
    <div class="pseq" aria-label="この打席の投球">${seq}</div>
  </div>`;
}

// ---------------------------------------------------------------- 経過（打席ごと・1球ごと）
function typeJa(t) { return { lineup: "スタメン", pitch: "投球", pa_result: "打席結果", runner: "走塁", sub: "交代", end: "試合終了", decision: "勝敗投手" }[t] || t; }
function eventLine(e) {
  const body = (e.desc || e.summary || typeJa(e.type)).replace(/^\d+回[表裏] /, "");
  if (e.type === "pitch") return `${e.pitch_no ? e.pitch_no + "球目 " : ""}${body}`;
  if (e.type === "pa_result" && body.includes("：")) return "結果のみ：" + body.split("：").slice(1).join("：");
  return body;
}
function eventsHtml(v, editable, filter = null, oldestFirst = false) {
  const halt = v.halted;
  const pending = new Set(halt ? halt.pending.slice(1) : []);
  const paMap = {};
  for (const p of v.pa_log) paMap[p.no] = p;
  // 打席ごとにまとめる（打席に属さない交代などはそのまま）
  const groups = [];
  for (const e of v.events) {
    if (filter && !filter(e)) continue;
    const isPending = halt && (halt.event_id === e.id || pending.has(e.id));
    const key = isPending ? "pending" : e.pa_no ? "pa" + e.pa_no : "x" + e.id;
    let g = groups.length && groups[groups.length - 1].key === key ? groups[groups.length - 1] : null;
    if (!g) { g = { key, pa_no: isPending ? null : e.pa_no, items: [], pending: isPending, first: e }; groups.push(g); }
    g.items.push(e);
  }
  let html = "", lastHead = "";
  for (const g of (oldestFirst ? groups : groups.reverse())) {
    const e0 = g.first;
    const head = g.pending ? "要確認・未計算の記録" : e0.inning ? `${e0.inning}回${halfJa(e0.half)}` : "試合前";
    if (head !== lastHead) { html += `<li class="half-head">${head}</li>`; lastHead = head; }
    const pa = g.pa_no ? paMap[g.pa_no] : null;
    const cur = !pa && g.pa_no && v.status === "live" && v.batter;
    if (g.pa_no) {
      const who = pa ? `${pa.order}番 ${esc(pa.batter?.name || "")}` : cur ? `${v.batter.order}番 ${esc(v.batter.name)}（打席中）` : "";
      html += `<li class="pa-head"><span>${who}</span>${pa ? `<b>${esc(pa.label)}</b>` : ""}${pa && pa.seq ? `<span class="muted">${esc(pa.seq)}</span>` : ""}${pa && pa.rbi ? `<span class="tag">${pa.rbi}打点</span>` : ""}</li>`;
    }
    for (const e of g.items) {
      const cls = halt && halt.event_id === e.id ? "halt" : pending.has(e.id) ? "pending" : "";
      const tags = [
        e.unconfirmed ? `<span class="tag note">未確認</span>` : "",
        e.corrected ? `<span class="tag">訂正済み</span>` : "",
        halt && halt.event_id === e.id ? `<span class="tag warn">要確認</span>` : "",
        pending.has(e.id) ? `<span class="tag">未計算</span>` : "",
      ].join("");
      const a = e.after;
      const sc = a ? `${a.outs_shown ?? a.outs}アウト${a.status === "live" && (a.balls || a.strikes) ? ` ${a.balls}-${a.strikes}` : ""} ／ ${a.score.away}-${a.score.home}` : "";
      const inner = `<span class="grow">${esc(e.desc ? eventLine(e) : (e.summary || typeJa(e.type)))}${tags}<small>${esc(sc)}${e.note ? " ／ " + esc(e.note) : ""}${halt && halt.event_id === e.id ? " ／ " + esc(halt.message) : ""}</small></span>`;
      html += `<li class="ev ${cls} ${g.pa_no ? "in-pa" : ""}"><button class="item" data-ev="${esc(e.id)}">${inner}</button></li>`;
    }
  }
  return `<ul class="list">${html || `<li class="ev"><div class="item">まだ記録がありません</div></li>`}</ul>`;
}
function stateHtml(a) {
  if (!a) return "";
  const lamp = (n, k, max) => Array.from({ length: max }, (_, i) => `<i class="lamp ${k}${i < n ? " on" : ""}"></i>`).join("");
  return `<div class="mini-board">
    <div class="mb-top"><span class="inning">${a.inning}<small>回${halfJa(a.half)}</small></span><span class="num mb-score">${a.score.away} - ${a.score.home}</span></div>
    <div class="lamps"><span><b>B</b>${lamp(a.balls, "b", 3)}</span><span><b>S</b>${lamp(a.strikes, "s", 2)}</span><span><b>O</b>${lamp(Math.min(a.outs_shown ?? a.outs, 3), "o", 3)}</span></div>
    <div class="mb-bases">${[1, 2, 3].map(b => `<span>${BASE_JA[b]}：${esc(a.bases[b] || "なし")}</span>`).join("")}</div>
    ${a.batter_name ? `<div class="muted">次の打者：${esc(a.batter_name)} ／ 投手：${esc(a.pitcher_name || "")}</div>` : ""}
  </div>`;
}
function eventDetailSheet(v, id, ed = null, onBack = null) {
  const e = v.events.find(x => x.id === id);
  if (!e) return;
  const halt = v.halted;
  const p = e.payload || {};
  const isPitch = e.type === "pitch";
  const hasRunners = isPitch && (p.runners || []).length > 0;
  const actions = ed ? `
    ${isPitch && p.result !== "in_play" ? `<p class="sec">球種を変える</p><div class="chips">${["ball", "called_strike", "swinging_strike", "foul", "hbp", "unknown"].map(k => `<button class="chip ${p.result === k ? "on" : ""}" data-pt="${k}">${PITCH_JA[k]}</button>`).join("")}</div>` : ""}
    ${hasRunners ? `<button class="btn block" data-a="norun">この球の走塁だけ取り消す（投球は残す）</button>` : ""}
    <button class="btn block" data-a="fix">${isPitch ? "この球を入力し直す" : "このプレーを入力し直す"}</button>
    <button class="btn block" data-a="ins" ${e.type === "lineup" ? "disabled" : ""}>この直前に記録を追加する（記録漏れ）</button>
    <button class="btn block danger" data-a="void">${isPitch ? "この球を取り消す" : "このプレーを取り消す"}</button>` : "";
  openSheet(`<h2>${esc(e.desc ? eventLine(e) : (e.summary || typeJa(e.type)))}</h2>
    ${halt && halt.event_id === id ? `<p class="banner warn" style="margin:0 0 8px">${esc(halt.message)}</p>` : ""}
    <p class="muted">${e.inning ? `${e.inning}回${halfJa(e.half)} ` : ""}${e.author ? `入力：${esc(e.author)}` : ""}</p>
    ${e.after ? `<p class="sec">このプレーの直後</p>${stateHtml(e.after)}` : ""}
    ${actions}
    <div class="sheet-actions">${onBack ? `<button class="btn" data-a="back">回の一覧に戻る</button>` : ""}<button class="btn" data-a="c">閉じる</button></div>`, el => {
    el.querySelector("[data-a=c]").onclick = closeSheet;
    const bk = el.querySelector("[data-a=back]");
    if (bk) bk.onclick = onBack;
    if (!ed) return;
    el.querySelectorAll("[data-pt]").forEach(b => b.onclick = () => {
      if (b.dataset.pt === p.result) return;
      ed.sendRaw("correct", { target: id, event: { type: "pitch", payload: { ...p, result: b.dataset.pt, play: undefined, dropped: undefined } } }, "球種を変更しました");
    });
    const nr = el.querySelector("[data-a=norun]");
    if (nr) nr.onclick = () => ed.sendRaw("correct", { target: id, event: { type: "pitch", payload: { ...p, runners: [] } } }, "走塁を取り消しました");
    el.querySelector("[data-a=fix]").onclick = () => { closeSheet(); ed.enterMode("correct", id, eventLine(e)); };
    el.querySelector("[data-a=ins]").onclick = () => { closeSheet(); ed.enterMode("insert", id, eventLine(e)); };
    el.querySelector("[data-a=void]").onclick = async () => {
      closeSheet();
      if (!(await confirmSheet("取り消す", `「${esc(eventLine(e))}」を取り消し、その後の記録を計算し直します`, "取り消す", true))) return;
      ed.sendRaw("void", { target: id }, "取り消しました");
    };
  });
}

// ---------------------------------------------------------------- 成績（打撃・守備）
function battingHtml(v) {
  const team = side => {
    const b = v.box[side];
    const cols = [["AB", "打数"], ["R", "得点"], ["H", "安打"], ["RBI", "打点"], ["2B", "二塁打"], ["3B", "三塁打"], ["HR", "本塁打"], ["TB", "塁打"], ["SB", "盗塁"], ["CS", "盗塁刺"], ["SH", "犠打"], ["SF", "犠飛"], ["BB", "四球"], ["IBB", "故意四球"], ["HBP", "死球"], ["SO", "三振"], ["GIDP", "併殺打"]];
    const t = b.batting_total;
    return `<h3>${esc(v.team_names[side])}</h3>
      <div class="scroll-x"><table class="stats"><thead><tr><th class="l">順</th><th class="l">位置</th><th class="l">選手</th>${cols.map(c => `<th>${c[1]}</th>`).join("")}<th>打率</th></tr></thead>
      <tbody>${b.batting.map(r => `<tr><td class="l">${r.order ?? ""}</td><td class="l">${esc(r.positions || "")}</td><td class="l name"><a href="/p/${esc(r.id)}" data-link>${esc(r.name)}</a></td>${cols.map(c => `<td>${r[c[0]]}</td>`).join("")}<td>${r.AVG ?? "-"}</td></tr>`).join("")}
      <tr class="total"><td></td><td></td><td class="l">計</td>${cols.map(c => `<td>${t[c[0]]}</td>`).join("")}<td>${t.AVG ?? "-"}</td></tr></tbody></table></div>
      <p class="muted">残塁 ${t.LOB}</p>`;
  };
  return `<div class="wrap">${team("away")}${team("home")}<p class="muted">打率はこの試合の数字 通算は選手名から確認できます</p></div>`;
}
function fieldingHtml(v) {
  const d = v.decisions || {};
  const dec = v.status === "final" ? `<p class="decisions">勝：${esc(d.win?.name || "—")} ／ 敗：${esc(d.loss?.name || "—")}${d.save ? ` ／ S：${esc(d.save.name)}` : ""}${(d.holds || []).length ? ` ／ H：${d.holds.map(h => esc(h.name)).join("、")}` : ""}</p>${d.note ? `<p class="muted">${esc(d.note)}</p>` : ""}` : "";
  const team = side => {
    const b = v.box[side];
    const pc = [["IP", "投球回"], ["BF", "打者"], ["pitches", "球数"], ["H", "安打"], ["HR", "本塁打"], ["BB", "四球"], ["IBB", "故意四球"], ["HBP", "死球"], ["SO", "三振"], ["WP", "暴投"], ["BK", "ボーク"], ["R", "失点"], ["ER", "自責点"]];
    const fc = [["PO", "刺殺"], ["A", "補殺"], ["E", "失策"], ["DP", "併殺"]];
    const catchers = b.fielding.filter(r => r.positions.includes("捕") || r.PB || r.SB_A || r.CS_C);
    return `<h3>${esc(v.team_names[side])}</h3>
      <p class="sec muted">投手</p>
      <div class="scroll-x"><table class="stats"><thead><tr><th class="l">投手</th><th></th>${pc.map(c => `<th>${c[1]}</th>`).join("")}<th>防御率</th></tr></thead>
      <tbody>${b.pitching.map(r => `<tr><td class="l name"><a href="/p/${esc(r.id)}" data-link>${esc(r.name)}</a></td><td>${r.decision ? `<span class="tag">${r.decision}</span>` : ""}</td>${pc.map(c => `<td>${c[0] === "pitches" ? r.pitches + (r.pitches_incomplete ? "+" : "") : r[c[0]]}</td>`).join("")}<td>${r.ERA ?? "-"}</td></tr>`).join("")}</tbody></table></div>
      ${b.team_er !== b.pitching.reduce((a, r) => a + r.ER, 0) ? `<p class="muted">チーム自責点 ${b.team_er}（投手の交代で、個人の自責点の合計と一致しないことがあります）</p>` : ""}
      <p class="sec muted">野手</p>
      <div class="scroll-x"><table class="stats"><thead><tr><th class="l">選手</th><th class="l">位置</th>${fc.map(c => `<th>${c[1]}</th>`).join("")}<th>守備率</th></tr></thead>
      <tbody>${b.fielding.map(r => `<tr><td class="l name">${esc(r.name)}</td><td class="l">${esc(r.positions)}</td>${fc.map(c => `<td>${r[c[0]]}</td>`).join("")}<td>${r.FPCT ?? "-"}</td></tr>`).join("")}</tbody></table></div>
      ${catchers.length ? `<p class="sec muted">捕手</p><div class="scroll-x"><table class="stats"><thead><tr><th class="l">捕手</th><th>刺殺</th><th>うち三振</th><th>捕逸</th><th>許盗塁</th><th>盗塁刺</th><th>阻止率</th></tr></thead>
      <tbody>${catchers.map(r => `<tr><td class="l name">${esc(r.name)}</td><td>${r.PO}</td><td>${r.PO_K}</td><td>${r.PB}</td><td>${r.SB_A}</td><td>${r.CS_C}</td><td>${r.CS_PCT ?? "-"}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted">三振のアウトは捕手の刺殺として記録されます（公認野球規則9.09）</p>` : ""}
      ${b.po_unknown ? `<p class="muted">守備者が未確認のアウト：${b.po_unknown}（刺殺・補殺に数えていません）</p>` : ""}`;
  };
  const unrec = v.pa_log.some(p => p.unrecorded) ? `<p class="muted">球数の「+」は、投球を記録していない打席があることを表します</p>` : "";
  return `<div class="wrap">${dec}${team("away")}${team("home")}${unrec}
    <p class="muted">自責点は公認野球規則9.16に沿って得点した時点で判定（判断が分かれる場面は投手に有利な側） 防御率は${v.rules.innings || 9}回換算</p></div>`;
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
  return `<div class="wrap"><a class="btn block" style="display:flex;align-items:center;justify-content:center;text-decoration:none;margin-top:14px" href="/s/${esc(v.game.view_token)}" data-link>スコアブック形式で表示（印刷・PDF保存）</a>${team("away")}${team("home")}<p class="muted">左安・中2・右3・左本＝安打・二塁打・三塁打・本塁打と方向、空三振・見三振＝空振り・見逃しの三振、併＝併殺、併崩＝併殺崩れ 守備の流れ（6-3など）は経過に出ます</p></div>`;
}

// ================================================================ 閲覧画面
const Viewer = {
  token: null, v: null, tab: "play",
  async start(token) {
    this.token = token; this.tab = "play";
    $app.innerHTML = `<p class="boot">読み込み中…</p>`;
    try { this.v = await api(`/api/view/${token}`); } catch (e) { $app.innerHTML = topbar("閲覧") + `<div class="wrap"><p>${esc(e.message)}</p></div>`; bindTopbar(); return; }
    this.render();
    pollTimer = setInterval(() => this.poll(), 5000);
  },
  async poll() {
    if (document.hidden || $sheetRoot.innerHTML) return;
    try {
      const r = await api(`/api/view/${this.token}?since=${this.v.game.version}`);
      if (!r.unchanged) { const prev = this.v; this.v = r; this.render(boardDiff(prev, r)); }
    } catch { /* 次回また試す */ }
  },
  render(changed = new Set()) {
    const v = this.v;
    const latest = [...v.pa_log].reverse()[0];
    const body = this.tab === "play"
      ? `<div class="field">${diamondHtml(v)}${whoHtml(v)}</div>${latest ? `<div class="banner note">直前の打席：${latest.order}番 ${esc(latest.batter?.name || "")} <b>${esc(latest.label)}</b></div>` : ""}<div class="wrap"><p class="muted" style="margin-top:12px">1球ごとの記録を押すと、その時点の状況が見られます スコアボードの数字を押すと、その回の結果が見られます</p>${eventsHtml(v, false)}</div>`
      : this.tab === "bat" ? battingHtml(v) : this.tab === "fld" ? fieldingHtml(v) : bookHtml(v);
    $app.innerHTML = topbar(`${v.team_names.away} 対 ${v.team_names.home}`) + boardHtml(v, changed) + body +
      `<nav class="tabs">${[["play", "速報"], ["bat", "打撃"], ["fld", "守備"], ["book", "スコア"]].map(([k, l]) => `<button class="${this.tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</nav>`;
    bindTopbar(); bindBoard(v);
    $app.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { this.tab = b.dataset.tab; this.render(); window.scrollTo(0, 0); });
    $app.querySelectorAll("[data-ev]").forEach(b => b.onclick = () => eventDetailSheet(this.v, b.dataset.ev));
  },
};

// ================================================================ 入力画面
const Editor = {
  token: null, v: null, tab: "input", mode: null, mv: null, busy: false, _changed: new Set(),

  async start(token) {
    this.token = token; this.tab = "input"; this.mode = null; this.mv = null; this._lineupSide = null; this._draft = {}; this._luMode = "order";
    $app.innerHTML = `<p class="boot">読み込み中…</p>`;
    try { this.v = await api(`/api/edit/${token}`); } catch (e) { $app.innerHTML = topbar("入力") + `<div class="wrap"><p>${esc(e.message)}</p></div>`; bindTopbar(); return; }
    rememberGame({ edit_token: token, view_token: this.v.game.view_token, label: `${this.v.team_names.away} 対 ${this.v.team_names.home}`, date: this.v.game.date });
    if (!store.get("bs_name")) {
      const n = await askText("入力する人の名前", "訂正履歴に「誰が入力したか」として残ります", "");
      if (n) store.set("bs_name", n);
    }
    await this.claimLock(false);
    this.render();
    lockTimer = setInterval(() => this.heartbeat(), 60000);
  },
  get view() { return this.mode ? this.mv : this.v; },
  myLock() { const l = this.v.lock; return !l || !l.client || l.client === clientId(); },
  canInput() {
    if (!this.myLock() && !this.mode) { toast("この端末は入力権がありません 「引き継ぐ」を押してください", "err"); return false; }
    return true;
  },
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
    if (this.mode) { try { this.mv = await api(`/api/edit/${this.token}/before/${this.mode.target}`); } catch { this.mode = null; this.mv = null; } }
    this.render();
  },

  // ---------------- 送信（訂正・追加モードなら包んで送る）
  async send(type, payload, meta = {}) {
    let body = { type, payload, meta };
    if (this.mode) {
      const inner = { type, payload, meta };
      body = this.mode.kind === "correct" ? { type: "correct", payload: { target: this.mode.target, event: inner }, meta: {} }
        : { type: "insert", payload: { before: this.mode.target, event: inner }, meta: {} };
    }
    const wasMode = this.mode;
    const v = await this.post(body);
    if (!v) return null;
    if (wasMode) { toast(wasMode.kind === "correct" ? "✓ 訂正しました" : "✓ 追加しました", "ok"); this.tab = "log"; this.render(); }
    else this.confirmFeedback(v);
    return v;
  },
  async sendRaw(type, payload, okMsg) {
    this.mode = null; this.mv = null;
    const v = await this.post({ type, payload, meta: {} });
    if (v) toast("✓ " + okMsg, "ok");
    return v;
  },
  async post(body) {
    if (this.busy) return null;
    this.busy = true;
    try {
      const v = await api(`/api/edit/${this.token}/events`, {
        method: "POST",
        body: { ...body, client_id: clientId(), author: store.get("bs_name"), expected_version: this.v.game.version },
      });
      this._changed = boardDiff(this.v, v);
      this.v = v; this.mode = null; this.mv = null;
      closeSheet();
      this.render();
      this._changed = new Set();
      if (v.halted) setTimeout(() => toast("後のプレーと矛盾があります 経過の「要確認」を直してください", "err"), 1600);
      return v;
    } catch (e) {
      if (e.status === 423) { this.v.lock = e.data.lock; closeSheet(); this.render(); }
      else if (e.status === 409) { await this.reload(); }
      showError(e);
      return null;
    } finally { this.busy = false; }
  },
  // 入力できたことが一目でわかるように、記録された内容を表示する
  confirmFeedback(v) {
    const e = v.events[v.events.length - 1];
    if (!e) return;
    const a = e.after;
    const count = a && a.status === "live" ? `（${a.balls}-${a.strikes}／${a.outs_shown ?? a.outs}アウト）` : "";
    toast(`✓ ${eventLine(e)}${count}`, "ok");
  },
  async undo() {
    const last = [...this.v.events].reverse()[0];
    if (!last) return;
    const ok = await confirmSheet("1つ前に戻す", `「${esc(last.desc ? eventLine(last) : typeJa(last.type))}」を取り消します 記録は履歴に残り、後から戻せます`, "取り消す", true);
    if (!ok) return;
    try {
      const nv = await api(`/api/edit/${this.token}/undo`, { method: "POST", body: { client_id: clientId(), author: store.get("bs_name"), expected_version: this.v.game.version } });
      this._changed = boardDiff(this.v, nv); this.v = nv;
      toast("✓ 取り消しました", "ok"); this.render(); this._changed = new Set();
    } catch (e) { if (e.status === 409) await this.reload(); showError(e); }
  },
  async enterMode(kind, target, desc) {
    try {
      this.mv = await api(`/api/edit/${this.token}/before/${target}`);
      this.mode = { kind, target, desc };
      if (kind === "correct" && this.modeEventType() === "lineup") { this._lineupSide = desc.includes("後攻") ? "home" : "away"; this._draft = {}; }
      this.tab = "input"; this.render(); window.scrollTo(0, 0);
    } catch (e) { showError(e); }
  },
  exitMode() { this.mode = null; this.mv = null; this.render(); },
  modeEventType() {
    const e = this.mode && this.v.events.find(x => x.id === this.mode.target);
    return e ? e.type : null;
  },
  lineupScreen(v) {
    return !v.lineups.away.set || !v.lineups.home.set || (this.mode && this.mode.kind === "correct" && this.modeEventType() === "lineup");
  },

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
    else if (this.tab === "log") body = `<div class="wrap"><p class="muted" style="margin-top:12px">1球・1プレーを押すと、その時点の状況の確認と、訂正・取消・直前への追加ができます</p>${eventsHtml(this.v, true)}</div>`;
    else if (this.tab === "bat") body = battingHtml(this.v);
    else if (this.tab === "fld") body = fieldingHtml(this.v);
    else body = bookHtml(this.v);
    $app.innerHTML = topbar(`${this.v.team_names.away} 対 ${this.v.team_names.home}`, menu) + boardHtml(v, this.mode ? new Set() : this._changed) + banners + body +
      `<nav class="tabs five">${[["input", "入力"], ["log", "経過"], ["bat", "打撃"], ["fld", "守備"], ["book", "スコア"]].map(([k, l]) => `<button class="${this.tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</nav>`;
    bindTopbar(); bindBoard(this.v, this);
    $app.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { this.tab = b.dataset.tab; this.render(); window.scrollTo(0, 0); });
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    on("menu", () => this.menuSheet());
    on("take", async () => { if (await this.claimLock(true)) { toast("この端末で入力します", "ok"); this.render(); } });
    on("exitmode", () => this.exitMode());
    on("tolog", () => { this.tab = "log"; this.render(); });
    if (this.tab === "input") this.bindInput(v);
    if (this.tab === "log") $app.querySelectorAll("[data-ev]").forEach(b => b.onclick = () => eventDetailSheet(this.v, b.dataset.ev, this));
  },

  inputHtml(v) {
    if (this.lineupScreen(v)) return this.lineupHtml(v);
    if (v.status === "final") {
      return `<div class="wrap"><h2>試合終了</h2><p>${esc(v.team_names.away)} ${v.rhe.away.R} － ${v.rhe.home.R} ${esc(v.team_names.home)}</p>
        <p class="muted">記録を直す場合は「経過」から該当のプレーを訂正するか、下のボタンで最後の記録を取り消してください</p>
        <button class="btn block" id="undo">最後の記録を取り消す</button>
        <button class="btn block" id="share">URLを共有</button>
        <a class="btn block" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="/api/edit/${esc(this.token)}/export">バックアップを書き出す</a></div>`;
    }
    const occupied = [1, 2, 3].some(n => v.bases[n]);
    const dis = occupied ? "" : "disabled";
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
      <div class="pad three" role="group" aria-label="走塁">
        <button class="k-sub" data-act="steal" ${dis}>盗塁</button>
        <button class="k-sub" data-act="wild" ${dis}>暴投・捕逸</button>
        <button class="k-sub" data-act="pickoff" ${dis}>牽制</button>
        <button class="k-sub" data-act="result">結果のみ</button>
        <button class="k-sub" data-act="sub">交代</button>
        <button class="k-sub" data-act="undo" ${this.mode ? "disabled" : ""}>1つ戻す</button>
      </div>`;
  },
  bindInput(v) {
    if (this.lineupScreen(v)) { this.bindLineup(v); return; }
    const on = (sel, fn) => $app.querySelectorAll(sel).forEach(b => b.onclick = () => fn(b));
    if (v.status === "final") {
      on("#undo", () => this.undo());
      on("#share", () => shareSheet(this.token, this.v.game.view_token));
      return;
    }
    on("[data-p]", b => this.pitch(b.dataset.p, b));
    on("[data-act=inplay]", () => this.canInput() && ResultSheet.open(this, "in_play"));
    on("[data-act=result]", () => this.canInput() && ResultSheet.open(this, "pa"));
    on("[data-act=steal]", () => this.canInput() && RunnerSheet.open(this, { mode: "steal" }));
    on("[data-act=wild]", () => this.canInput() && RunnerSheet.open(this, { mode: "wild" }));
    on("[data-act=pickoff]", () => this.canInput() && this.pickoffSheet());
    on("[data-act=sub]", () => this.canInput() && SubSheet.open(this));
    on("[data-act=undo]", () => this.undo());
    on("[data-act=otherpitch]", () => this.canInput() && this.otherPitchSheet());
  },
  async pitch(kind, btn) {
    const v = this.view;
    if (!this.canInput()) return;
    if (btn) { btn.classList.remove("pressed"); void btn.offsetWidth; btn.classList.add("pressed"); }
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
        else if (k === "krun") RunnerSheet.open(this, { mode: "steal", pitch: kind });
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
  pickoffSheet() {
    const v = this.view;
    const bases = [1, 2, 3].filter(b => v.bases[b]);
    const st = { base: bases[0], result: "safe", fl: "" };
    const defaultFl = b => `1-${{ 1: 3, 2: 6, 3: 5 }[b]}`;
    const draw = () => openSheet(`<h2>牽制</h2>
      <p class="sec">牽制した塁</p><div class="chips">${bases.map(b => `<button class="chip ${st.base === b ? "on" : ""}" data-b="${b}">${BASE_JA[b]} ${esc(v.bases[b].name)}</button>`).join("")}</div>
      <p class="sec">結果</p><div class="chips">
        <button class="chip ${st.result === "safe" ? "on" : ""}" data-r="safe">セーフ（記録だけ残す）</button>
        <button class="chip out ${st.result === "out" ? "on" : ""}" data-r="out">アウト（牽制死）</button>
        <button class="chip ${st.result === "error" ? "on" : ""}" data-r="error">悪送球で進塁（投手の失策）</button></div>
      ${st.result === "out" ? `<label class="f" for="fl">守備の流れ（例 1-3）</label><input id="fl" type="text" inputmode="numeric" value="${esc(st.fl || defaultFl(st.base))}">` : ""}
      <div class="sheet-actions"><button class="btn" data-a="c">やめる</button><button class="btn primary" data-a="ok">記録する</button></div>`, el => {
      const keep = () => { const f = el.querySelector("#fl"); if (f) st.fl = f.value; };
      el.querySelector("[data-a=c]").onclick = closeSheet;
      el.querySelectorAll("[data-b]").forEach(b => b.onclick = () => { keep(); st.base = parseInt(b.dataset.b, 10); st.fl = ""; draw(); });
      el.querySelectorAll("[data-r]").forEach(b => b.onclick = () => { keep(); st.result = b.dataset.r; draw(); });
      el.querySelector("[data-a=ok]").onclick = async () => {
        keep();
        if (st.result === "safe") await this.send("runner", { moves: [], attempt: true, base: st.base });
        else if (st.result === "out") {
          const f = parseSeq(st.fl || defaultFl(st.base));
          await this.send("runner", { moves: [{ from: st.base, to: "out", how: "po", ...(f.length ? { fielders: f } : { fielders_unknown: true }) }] });
        } else await this.send("runner", { moves: [{ from: st.base, to: Math.min(4, st.base + 1), how: "error", error_pos: 1 }] });
      };
    });
    draw();
  },
  menuSheet() {
    openSheet(`<h2>メニュー</h2>
      <button class="btn block" data-m="share">URLを共有（閲覧用・入力用）</button>
      <button class="btn block" data-m="end" ${this.v.status !== "live" ? "disabled" : ""}>試合終了にする（時間切れ・コールドなど）</button>
      <button class="btn block" data-m="name">入力者の名前を変える（今：${esc(store.get("bs_name") || "未設定")}）</button>
      <a class="btn block" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="/api/edit/${esc(this.token)}/export">バックアップを書き出す</a>
      <a class="btn block" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="/g/${esc(this.v.game.view_token)}" data-link>閲覧画面を開く</a>
      <button class="btn block danger" data-m="del">この試合を削除する</button>
      <p class="muted">バックアップはファイルとして保存されます iPhoneでは「ファイル」アプリからiCloud Driveに保存できます</p>
      <div class="sheet-actions"><button class="btn" data-a="c">閉じる</button></div>`, el => {
      el.querySelector("[data-a=c]").onclick = closeSheet;
      el.querySelector("[data-m=share]").onclick = () => shareSheet(this.token, this.v.game.view_token);
      el.querySelector("[data-m=name]").onclick = async () => { const n = await askText("入力者の名前", "", store.get("bs_name") || ""); if (n) { store.set("bs_name", n); toast("変更しました", "ok"); } };
      el.querySelector("[data-m=end]").onclick = () => this.endSheet();
      el.querySelector("[data-m=del]").onclick = async () => {
        if (!(await confirmSheet("試合を削除", "この試合の記録をすべて削除します 元に戻せません", "削除する", true))) return;
        try { await apiAdmin(`/api/edit/${this.token}`, { method: "DELETE" }); forgetGame(this.token); toast("削除しました"); go("/"); } catch (e) { showError(e); }
      };
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

  // ---------------- スタメン（打順で入力 / 守備位置で入力）
  draftFor(side, v) {
    if (this._draft[side]) return this._draft[side];
    const rules = this.v.game.rules || {};
    const lu = v.lineups[side];
    const fixing = this.mode && this.mode.kind === "correct";
    const src = fixing ? this.v.lineups[side].starting.map(x => ({ id: x.id, position: (this.v.lineups[side].slots.find(y => y.id === x.id) || {}).position })) : lu.slots;
    const n = rules.extra_hitters ? Math.max(10, src.length) : 9;
    const slots = Array.from({ length: n }, (_, i) => ({ pid: src[i]?.id || "", pos: src[i]?.position || "" }));
    const pitcher = fixing ? (this.v.lineups[side].pitcher?.id || "") : (lu.pitcher?.id || "");
    const extraP = pitcher && !slots.some(s => s.pid === pitcher) ? pitcher : "";
    this._draft[side] = { slots, extraP };
    return this._draft[side];
  },
  lineupHtml(v) {
    const side = this._lineupSide || (v.lineups.away.set && !this.mode ? "home" : "away");
    this._lineupSide = side;
    const dr = this.draftFor(side, v);
    const players = this.v.roster[side];
    const q = (this._luSearch || "").trim();
    const match = p => !q || p.name.includes(q) || (p.number && String(p.number) === q);
    const popts = sel => `<option value="">（選ぶ）</option>` + players.filter(p => p.id === sel || match(p)).map(p => `<option value="${esc(p.id)}" ${p.id === sel ? "selected" : ""}>${esc(pname(p))}</option>`).join("");
    const posopts = sel => `<option value="">守備</option>` + POS_CODES.map(c => `<option value="${c}" ${c === sel ? "selected" : ""}>${POS_CODE_JA[c]}</option>`).join("");
    const n = dr.slots.length;
    let rows;
    if (this._luMode === "order") {
      rows = dr.slots.map((s, i) => `<div class="lineup-row"><span class="o">${i + 1}</span><select data-slot="${i}" aria-label="${i + 1}番の選手">${popts(s.pid)}</select><select data-pos="${i}" aria-label="${i + 1}番の守備位置">${posopts(s.pos)}</select></div>`).join("");
      rows += `<label class="f" for="sp">打順に入らない先発投手（DHのとき）</label><select id="sp">${popts(dr.extraP)}</select>`;
    } else {
      // 守備位置ごとに選手と打順を選ぶ
      rows = POS_CODES.map(code => {
        const idx = dr.slots.findIndex(s => s.pos === code);
        const isExtraP = code === "P" && idx < 0 && dr.extraP;
        const pid = idx >= 0 ? dr.slots[idx].pid : isExtraP ? dr.extraP : "";
        const ord = idx >= 0 ? String(idx + 1) : isExtraP ? "out" : "";
        const ordOpts = `<option value="">打順</option>${Array.from({ length: n }, (_, i) => `<option value="${i + 1}" ${ord === String(i + 1) ? "selected" : ""}>${i + 1}番</option>`).join("")}${code === "P" ? `<option value="out" ${ord === "out" ? "selected" : ""}>打順外</option>` : ""}`;
        return `<div class="lineup-row pos"><span class="o">${POS_CODE_JA[code]}</span><select data-ppos="${code}" aria-label="${POS_CODE_NAME[code]}">${popts(pid)}</select><select data-pord="${code}" aria-label="${POS_CODE_NAME[code]}の打順">${ordOpts}</select></div>`;
      }).join("");
      const noPos = dr.slots.map((s, i) => s.pid && !s.pos ? `${i + 1}番 ${esc(players.find(p => p.id === s.pid)?.name || "")}` : "").filter(Boolean);
      if (noPos.length) rows += `<p class="muted">守備位置なし：${noPos.join("、")}</p>`;
    }
    return `<div class="wrap">
      <div class="chips" style="margin-top:14px">${["away", "home"].map(s => `<button class="chip ${s === side ? "on" : ""}" data-side="${s}">${s === "away" ? "先攻" : "後攻"} ${esc(shortName(this.v, s))}${v.lineups[s].set ? " ✓" : ""}</button>`).join("")}</div>
      <h2>${esc(this.v.team_names[side])} のスタメン</h2>
      <div class="chips"><button class="chip ${this._luMode === "order" ? "on" : ""}" data-lum="order">打順で入力</button><button class="chip ${this._luMode === "pos" ? "on" : ""}" data-lum="pos">守備位置で入力</button></div>
      <input id="lusearch" type="text" placeholder="名前・背番号で絞り込む" value="${esc(this._luSearch || "")}" style="margin-top:10px" autocomplete="off">
      ${rows}
      <div class="row-btns"><button class="btn" id="addp">選手を追加</button><button class="btn primary" id="saveL">このスタメンで登録</button></div>
      ${(this.v.game.rules || {}).extra_hitters ? `<button class="btn small" id="more">打順を1人増やす</button>` : ""}
      <p class="muted">守備位置が分からない選手は空欄でも登録できます</p></div>`;
  },
  bindLineup(v) {
    const side = this._lineupSide;
    const dr = this.draftFor(side, v);
    $app.querySelectorAll("[data-side]").forEach(b => b.onclick = () => { this._lineupSide = b.dataset.side; this.render(); });
    $app.querySelectorAll("[data-lum]").forEach(b => b.onclick = () => { this._luMode = b.dataset.lum; this.render(); });
    const search = document.getElementById("lusearch");
    search.oninput = () => {
      this._luSearch = search.value;
      const pos = search.selectionStart;
      this.render();
      const s2 = document.getElementById("lusearch"); s2.focus(); try { s2.setSelectionRange(pos, pos); } catch { /* 古い端末 */ }
    };
    // 打順モード
    $app.querySelectorAll("[data-slot]").forEach(s => s.onchange = () => {
      const i = parseInt(s.dataset.slot, 10);
      dr.slots.forEach((x, j) => { if (j !== i && x.pid === s.value) x.pid = ""; });
      if (dr.extraP === s.value) dr.extraP = "";
      dr.slots[i].pid = s.value; this.render();
    });
    $app.querySelectorAll("[data-pos]").forEach(s => s.onchange = () => {
      const i = parseInt(s.dataset.pos, 10);
      if (s.value && s.value !== "DH") dr.slots.forEach((x, j) => { if (j !== i && x.pos === s.value) x.pos = ""; });
      if (s.value === "P") dr.extraP = "";
      dr.slots[i].pos = s.value; this.render();
    });
    const sp = document.getElementById("sp");
    if (sp) sp.onchange = () => { dr.extraP = sp.value; if (sp.value) dr.slots.forEach(x => { if (x.pid === sp.value) x.pid = ""; if (x.pos === "P") x.pos = ""; }); this.render(); };
    // 守備位置モード
    $app.querySelectorAll("[data-ppos]").forEach(s => s.onchange = () => this.setByPos(dr, s.dataset.ppos, s.value, null));
    $app.querySelectorAll("[data-pord]").forEach(s => s.onchange = () => this.setByPos(dr, s.dataset.pord, null, s.value));
    const teamId = this.v.game[side === "away" ? "away_team" : "home_team"].id;
    document.getElementById("addp").onclick = () => playerForm(teamId, null, async () => { await this.reload(); }, this.token);
    const more = document.getElementById("more");
    if (more) more.onclick = () => { dr.slots.push({ pid: "", pos: "" }); this.render(); };
    document.getElementById("saveL").onclick = async () => {
      const slots = dr.slots.map(s => ({ player_id: s.pid, position: s.pos || null })).filter((s, i) => s.player_id || i < 9);
      const r = await this.send("lineup", { side, slots, pitcher_id: dr.extraP || null });
      if (r) {
        delete this._draft[side];
        toast("✓ スタメンを登録しました", "ok");
        if (side === "away" && !r.lineups.home.set) { this._lineupSide = "home"; this.render(); }
      }
    };
  },
  // 守備位置モードでの変更（選手か打順のどちらかが変わる）
  setByPos(dr, code, pid, ord) {
    const idx = dr.slots.findIndex(x => x.pos === code);
    const curPid = idx >= 0 ? dr.slots[idx].pid : (code === "P" ? dr.extraP : "");
    const curOrd = idx >= 0 ? String(idx + 1) : (code === "P" && dr.extraP ? "out" : "");
    const newPid = pid !== null ? pid : curPid;
    const newOrd = ord !== null ? ord : curOrd;
    // この守備位置の今の割り当てをいったん外す
    if (idx >= 0) { dr.slots[idx].pos = ""; dr.slots[idx].pid = ""; }
    if (code === "P") dr.extraP = "";
    if (!newPid) { this.render(); return; }
    // 同じ選手が他の打順・守備位置にいたら外す
    dr.slots.forEach(x => { if (x.pid === newPid) { x.pid = ""; x.pos = ""; } });
    if (dr.extraP === newPid) dr.extraP = "";
    if (newOrd === "out") dr.extraP = newPid;
    else {
      const j = newOrd ? parseInt(newOrd, 10) - 1 : dr.slots.findIndex(x => !x.pid);
      if (j < 0) { toast("空いている打順がありません 打順を選んでください", "err"); this.render(); return; }
      dr.slots[j].pid = newPid; dr.slots[j].pos = code;
    }
    this.render();
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
    this.ed = ed; this.kind = kind;
    this.st = { cat: kind === "pa" ? "kbb" : "hit", ui: null, pos: null, moves: null, fielders: "", rbi: null, unconfirmed: false };
    this.hist = [];
    this.draw();
  },
  // 1つ戻る：操作のたびに直前の状態を積んでおき、押されたら1つ前に戻す
  push(el) { this.keepInputs(el); this.hist.push(JSON.stringify(this.st)); },
  back() { if (!this.hist.length) return; this.st = JSON.parse(this.hist.pop()); this.redrawKeepScroll(); 
  },
  engineResult(ui) { return { ground_dp: "ground_out", reach_on_error_g: "reach_on_error", strikeout_l: "strikeout" }[ui] || ui; },
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
  draw(scrollToRunners = false) {
    const v = this.ed.view, s = this.st;
    const cats = this.kind === "pa" ? ["kbb", "hit", "ground", "fly", "other"] : ["hit", "ground", "fly", "other"];
    const cat = RESULT_CATS[s.cat];
    const needsPos = s.ui && NEEDS_POS.has(s.ui);
    const ready = s.ui && (!needsPos || s.pos) && s.moves;
    const step = !s.ui ? 1 : needsPos && !s.pos ? 2 : 3;
    const resLabel = s.ui ? cat.items.find(x => x[0] === s.ui)?.[1] || "" : "";
    const summary = s.ui ? `<div class="pick-summary">${esc(resLabel)}${s.pos ? ` ／ ${["single", "double", "triple", "home_run"].includes(s.ui) ? "方向" : "野手"}：${POS_JA[s.pos]}` : ""}</div>` : "";
    openSheet(`<h2>${this.kind === "pa" ? "打席の結果だけを入力" : "打球の結果"}</h2>
      ${this.kind === "pa" ? `<p class="muted">投球を記録しないで結果だけを残します（球数は数えません）</p>` : ""}
      <ol class="steps"><li class="${step === 1 ? "on" : "done"}">結果</li><li class="${step === 2 ? "on" : step > 2 ? "done" : ""}">${needsPos || !s.ui ? "位置" : "—"}</li><li class="${step === 3 ? "on" : ""}">走者</li></ol>
      <div class="chips cats">${cats.map(c => `<button class="chip ${c === s.cat ? "on" : ""}" data-cat="${c}">${RESULT_CATS[c].label}</button>`).join("")}</div>
      <div class="res-grid">${cat.items.map(([k, l]) => `<button class="res ${k === s.ui ? "on" : ""}" data-ui="${k}">${l}</button>`).join("")}</div>
      ${needsPos ? `<p class="sec">${["single", "double", "triple", "home_run"].includes(s.ui) ? "打球の方向" : "打球を処理した野手"}</p>
        <div class="posgrid">${[7, 8, 9, 5, 6, 4, 3, 1, 2].map(n => `<button class="pos-btn ${s.pos === n ? "on" : ""}" data-pos="${n}">${POS_JA[n]}<small>${n}</small></button>`).join("")}</div>` : ""}
      <div id="runners-anchor"></div>
      ${s.moves ? summary + this.runnersHtml(v) : ""}
      <div class="sheet-actions"><button class="btn" data-a="back" ${this.hist.length ? "" : "disabled"}>1つ戻る</button><button class="btn" data-a="c">やめる</button><button class="btn primary" data-a="ok" ${ready ? "" : "disabled"}>記録する</button></div>`, el => {
      this.bind(el);
      if (scrollToRunners) { const a = el.querySelector("#runners-anchor"); if (a) a.scrollIntoView({ block: "start", behavior: "smooth" }); }
    });
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
      <div class="outcome">記録後：<b>${after >= 3 ? "3アウト 攻撃終了" : `${after}アウト`}</b>${runs ? ` ／ <b>生還 ${runs}人</b>` : ""}${after >= 3 && runs ? "<br><span class='muted'>3アウト目が打者・封殺のときは得点になりません</span>" : ""}</div>
      <div class="row-btns"><button class="btn small" data-a="rbi">打点：${rbiTxt}</button><button class="btn small ${s.unconfirmed ? "primary" : ""}" data-a="unc">${s.unconfirmed ? "未確認として記録 ✓" : "未確認として記録"}</button></div>`;
  },
  bind(el) {
    const s = this.st;
    el.querySelector("[data-a=c]").onclick = closeSheet;
    el.querySelector("[data-a=back]").onclick = () => this.back();
    el.querySelectorAll("[data-cat]").forEach(b => b.onclick = () => { if (b.dataset.cat === s.cat) return; this.push(el); s.cat = b.dataset.cat; s.ui = null; s.pos = null; s.moves = null; this.draw(); });
    el.querySelectorAll("[data-ui]").forEach(b => b.onclick = async () => {
      if (b.dataset.ui === s.ui) return;
      this.push(el);
      s.ui = b.dataset.ui; s.moves = null; s.rbi = null;
      if (!NEEDS_POS.has(s.ui)) s.pos = null;
      await this.loadMoves(); this.draw(!!s.moves);
    });
    el.querySelectorAll("[data-pos]").forEach(b => b.onclick = async () => { if (parseInt(b.dataset.pos, 10) === s.pos) return; this.push(el); s.pos = parseInt(b.dataset.pos, 10); await this.loadMoves(); this.draw(true); });
    el.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
      const from = b.dataset.m === "B" ? "B" : parseInt(b.dataset.m, 10);
      const to = b.dataset.to === "out" ? "out" : parseInt(b.dataset.to, 10);
      this.push(el);
      const m = s.moves.find(x => x.from === from);
      m.to = to;
      if (from !== "B") m.how = to === "out" ? "force" : (m.how && !["force", "tag", "doubled_off"].includes(m.how) ? m.how : "adv");
      this.keepInputs(el); this.redrawKeepScroll();
    });
    el.querySelectorAll("[data-h]").forEach(b => b.onclick = () => {
      this.push(el);
      const m = s.moves.find(x => x.from === parseInt(b.dataset.h, 10)); m.how = b.dataset.how; this.keepInputs(el); this.redrawKeepScroll();
    });
    const rbi = el.querySelector("[data-a=rbi]");
    if (rbi) rbi.onclick = async () => {
      this.keepInputs(el);
      const val = await askText("打点", "空欄にすると自動計算に戻します", s.rbi ?? "", "number");
      if (val !== null) this.hist.push(JSON.stringify(s));
      if (val !== null) s.rbi = val === "" ? null : Math.max(0, parseInt(val, 10) || 0);
      this.draw(true);
    };
    const unc = el.querySelector("[data-a=unc]");
    if (unc) unc.onclick = () => { this.push(el); s.unconfirmed = !s.unconfirmed; this.redrawKeepScroll(); };
    el.querySelector("[data-a=ok]").onclick = () => { this.keepInputs(el); this.submit(); };
  },
  redrawKeepScroll() {
    const y = $sheetRoot.querySelector(".sheet")?.scrollTop || 0;
    this.draw();
    const sh = $sheetRoot.querySelector(".sheet"); if (sh) sh.scrollTop = y;
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

// ================================================================ 走塁（盗塁・暴投・捕逸）
const RunnerSheet = {
  ed: null, st: null,
  open(ed, { mode = "steal", pitch = null } = {}) {
    this.ed = ed;
    const v = ed.view;
    this.st = { mode, pitch, fixedPitch: !!pitch, moves: {} };
    this.hist = [];
    const how = mode === "wild" ? "wp" : "sb";
    for (const b of [1, 2, 3]) if (v.bases[b]) this.st.moves[b] = { to: mode === "wild" ? Math.min(4, b + 1) : b, how, fielders: "" };
    this.draw();
  },
  draw() {
    const v = this.ed.view, s = this.st;
    const wild = s.mode === "wild";
    const pitches = wild ? [["ball", "ボール"], ["called_strike", "見逃し"], ["swinging_strike", "空振り"], ["unknown", "内容不明"]]
      : [["ball", "ボール"], ["called_strike", "見逃し"], ["swinging_strike", "空振り"], ["foul", "ファウル"], ["unknown", "内容不明"], ["none", "投球なし（ディレードスチールなど）"]];
    const rows = [3, 2, 1].filter(b => v.bases[b]).map(b => {
      const m = s.moves[b], r = v.bases[b];
      const hows = m.to === "out" ? ["cs", "tag", "other"] : m.to === b ? [] : wild ? ["wp", "pb", "error", "other"] : ["sb", "wp", "pb", "error", "adv", "other"];
      return `<div class="runner-row"><div class="who2">${BASE_JA[b]}走者 <small>${esc(r.order ? r.order + "番 " : "")}${esc(r.name)}</small></div>
        <div class="chips"><button class="chip ${m.to === b ? "on" : ""}" data-m="${b}" data-to="${b}">そのまま</button>
        ${[2, 3, 4].filter(x => x > b).map(x => `<button class="chip ${m.to === x ? "on" : ""}" data-m="${b}" data-to="${x}">${x === 4 ? "生還" : BASE_JA[x]}</button>`).join("")}
        <button class="chip out ${m.to === "out" ? "on" : ""}" data-m="${b}" data-to="out">アウト</button></div>
        ${hows.length ? `<div class="chips opts">${hows.map(h => `<button class="chip ${m.how === h ? "on" : ""}" data-h="${b}" data-how="${h}">${HOW_JA[h]}</button>`).join("")}</div>` : ""}
        ${m.to === "out" ? `<div class="opts"><input type="text" inputmode="numeric" data-rf="${b}" placeholder="守備の流れ（例 2-6） 分からなければ空欄" value="${esc(m.fielders)}"></div>` : ""}</div>`;
    }).join("");
    const changed = Object.entries(s.moves).some(([b, m]) => m.to !== parseInt(b, 10));
    const ready = changed && s.pitch;
    const pitchNote = s.pitch === "ball" && v.balls === 3 ? "この球で四球になります" : (["called_strike", "swinging_strike"].includes(s.pitch) && v.strikes === 2 ? "この球で三振になります" : "");
    openSheet(`<h2>${wild ? "暴投・捕逸" : "盗塁・走塁"}</h2>
      ${wild ? `<div class="chips"><button class="chip ${Object.values(s.moves).every(m => m.how !== "pb") ? "on" : ""}" data-w="wp">暴投（投手）</button><button class="chip ${Object.values(s.moves).some(m => m.how === "pb") ? "on" : ""}" data-w="pb">捕逸（捕手）</button></div>` : ""}
      ${s.fixedPitch ? `<p>同時の投球：<b>${s.pitch === "called_strike" ? "見逃し" : "空振り"}三振</b></p>` : `<p class="sec">その時の投球</p>
      <div class="chips">${pitches.map(([k, l]) => `<button class="chip ${s.pitch === k ? "on" : ""}" data-p="${k}">${l}</button>`).join("")}</div>${pitchNote ? `<p class="muted">${pitchNote}</p>` : ""}`}
      <p class="sec">走者の動き</p>${rows}
      <div class="sheet-actions"><button class="btn" data-a="back" ${this.hist.length ? "" : "disabled"}>1つ戻る</button><button class="btn" data-a="c">やめる</button><button class="btn primary" data-a="ok" ${ready ? "" : "disabled"}>記録する</button></div>`, el => this.bind(el));
  },
  push(el) { this.keep(el); this.hist.push(JSON.stringify(this.st)); },
  bind(el) {
    const s = this.st;
    el.querySelector("[data-a=c]").onclick = closeSheet;
    el.querySelector("[data-a=back]").onclick = () => { if (this.hist.length) { this.st = JSON.parse(this.hist.pop()); this.draw(); } };
    el.querySelectorAll("[data-w]").forEach(b => b.onclick = () => { this.push(el); Object.values(s.moves).forEach(m => { if (m.to !== "out" && ["wp", "pb"].includes(m.how)) m.how = b.dataset.w; }); this.draw(); });
    el.querySelectorAll("[data-p]").forEach(b => b.onclick = () => { this.push(el); s.pitch = b.dataset.p; this.draw(); });
    el.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
      this.push(el);
      const base = parseInt(b.dataset.m, 10), m = s.moves[base];
      m.to = b.dataset.to === "out" ? "out" : parseInt(b.dataset.to, 10);
      if (m.to === "out") m.how = "cs";
      else if (["cs", "tag"].includes(m.how) || m.to === base) m.how = s.mode === "wild" ? "wp" : "sb";
      this.draw();
    });
    el.querySelectorAll("[data-h]").forEach(b => b.onclick = () => { this.push(el); s.moves[parseInt(b.dataset.h, 10)].how = b.dataset.how; this.draw(); });
    el.querySelector("[data-a=ok]").onclick = async () => {
      this.keep(el);
      const moves = Object.entries(s.moves).filter(([b, m]) => m.to !== parseInt(b, 10)).map(([b, m]) => {
        const o = { from: parseInt(b, 10), to: m.to, how: m.how };
        const f = parseSeq(m.fielders);
        if (m.to === "out") { if (f.length) o.fielders = f; else o.fielders_unknown = true; }
        if (m.how === "error") o.error_pos = 2;
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
    this.ed = ed;
    this.st = { kind: "pinch_hitter", side: ed.view.batting_side, base: null, inP: "", outP: "", pos: "" };
    this.hist = [];
    this.draw();
  },
  draw() {
    const v = this.ed.view, s = this.st, r = this.ed.v.roster;
    const kinds = [["pinch_hitter", "代打"], ["pinch_runner", "代走"], ["temp_runner", "臨時代走"], ["pitcher", "投手交代"], ["defense", "守備交代"], ["position", "守備位置の変更"]];
    if (["pinch_hitter", "pinch_runner", "temp_runner"].includes(s.kind)) s.side = v.batting_side;
    const lu = v.lineups[s.side];
    const inLineup = new Set(lu.slots.map(x => x.id));
    const removed = new Set(lu.removed);
    const benchOpts = r[s.side].filter(p => !inLineup.has(p.id) && (!lu.pitcher || p.id !== lu.pitcher.id))
      .map(p => `<option value="${esc(p.id)}" ${s.inP === p.id ? "selected" : ""}>${esc(pname(p))}${removed.has(p.id) ? "（再出場）" : ""}</option>`).join("");
    const lineupOpts = sel => lu.slots.map(x => `<option value="${esc(x.id)}" ${sel === x.id ? "selected" : ""}>${x.order}番 ${esc(x.name)}${x.position ? "（" + POS_CODE_JA[x.position] + "）" : ""}</option>`).join("");
    const posOpts = POS_CODES.filter(c => c !== "P").map(c => `<option value="${c}" ${s.pos === c ? "selected" : ""}>${POS_CODE_NAME[c]}</option>`).join("");
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
        <label class="f" for="outP">打順で入れ替わる選手（DHで打順に入らないなら空欄）</label><select id="outP"><option value="">（なし）</option>${lineupOpts(s.outP)}</select>`;
    } else if (s.kind === "defense") {
      fields = `<label class="f" for="outP">退く選手</label><select id="outP"><option value="">（選ぶ）</option>${lineupOpts(s.outP)}</select>
        <label class="f" for="inP">入る選手</label><select id="inP"><option value="">（選ぶ）</option>${benchOpts}</select>
        <label class="f" for="pos">守備位置</label><select id="pos"><option value="">（選ぶ）</option>${posOpts}</select>`;
    } else {
      fields = `<label class="f" for="inP">選手</label><select id="inP"><option value="">（選ぶ）</option>${lineupOpts(s.inP)}</select>
        <label class="f" for="pos">新しい守備位置</label><select id="pos"><option value="">（選ぶ）</option>${posOpts}</select>`;
    }
    const sidePick = ["pitcher", "defense", "position"].includes(s.kind)
      ? `<div class="chips" style="margin-top:10px">${["away", "home"].map(x => `<button class="chip ${s.side === x ? "on" : ""}" data-side="${x}">${esc(this.ed.v.team_names[x])}</button>`).join("")}</div>` : "";
    openSheet(`<h2>選手交代</h2><div class="chips">${kinds.map(([k, l]) => `<button class="chip ${s.kind === k ? "on" : ""}" data-k="${k}">${l}</button>`).join("")}</div>
      ${sidePick}${fields}
      <div class="sheet-actions"><button class="btn" data-a="back" ${this.hist.length ? "" : "disabled"}>1つ戻る</button><button class="btn" data-a="c">やめる</button><button class="btn primary" data-a="ok">交代を記録</button></div>`, el => this.bind(el));
  },
  bind(el) {
    const s = this.st, v = this.ed.view;
    const keep = () => { ["inP", "outP", "pos"].forEach(id => { const x = el.querySelector("#" + id); if (x) s[id] = x.value; }); };
    const push = () => { keep(); this.hist.push(JSON.stringify(this.st)); };
    el.querySelector("[data-a=c]").onclick = closeSheet;
    el.querySelector("[data-a=back]").onclick = () => { if (this.hist.length) { this.st = JSON.parse(this.hist.pop()); this.draw(); } };
    ["inP", "outP", "pos"].forEach(id => { const x = el.querySelector("#" + id); if (x) { x.onfocus = () => { this._snap = JSON.stringify(this.st); }; x.onchange = () => { if (this._snap) this.hist.push(this._snap); keep(); this.draw(); }; } });
    el.querySelectorAll("[data-k]").forEach(b => b.onclick = () => {
      push(); s.kind = b.dataset.k; s.inP = s.outP = s.pos = ""; s.base = null;
      s.side = s.kind === "pitcher" ? (v.batting_side === "away" ? "home" : "away") : v.batting_side; this.draw();
    });
    el.querySelectorAll("[data-side]").forEach(b => b.onclick = () => { push(); s.side = b.dataset.side; s.inP = s.outP = ""; this.draw(); });
    el.querySelectorAll("[data-b]").forEach(b => b.onclick = () => { push(); s.base = parseInt(b.dataset.b, 10); this.draw(); });
    el.querySelector("[data-a=ok]").onclick = async () => {
      keep();
      if (!s.inP) { toast("選手を選んでください", "err"); return; }
      const p = { kind: s.kind, side: s.side, in_player: s.inP };
      if (["pinch_runner", "temp_runner"].includes(s.kind)) { if (!s.base) { toast("塁を選んでください", "err"); return; } p.base = s.base; }
      if (s.kind === "pitcher" && s.outP) p.out_player = s.outP;
      if (s.kind === "defense") { if (!s.outP || !s.pos) { toast("退く選手と守備位置を選んでください", "err"); return; } p.out_player = s.outP; p.position = s.pos; }
      if (s.kind === "position") { if (!s.pos) { toast("守備位置を選んでください", "err"); return; } p.position = s.pos; }
      await this.ed.send("sub", p);
    };
  },
};

// ================================================================ 選手の通算成績
async function pagePlayer(id) {
  $app.innerHTML = topbar("選手成績") + `<div class="wrap"><p class="muted">読み込み中…</p></div>`;
  bindTopbar();
  try {
    const d = await api(`/api/players/${id}/stats`);
    const b = d.career.batting, p = d.career.pitching, f = d.career.fielding;
    const table = (cols, row) => `<div class="scroll-x"><table class="stats"><thead><tr>${cols.map(c => `<th>${c[1]}</th>`).join("")}</tr></thead><tbody><tr>${cols.map(c => `<td>${row[c[0]] ?? "-"}</td>`).join("")}</tr></tbody></table></div>`;
    document.querySelector(".topbar .title").textContent = d.player.name;
    document.querySelector(".wrap").innerHTML = `<h1>${esc(pname(d.player))}</h1><p class="muted">${esc(d.player.team)} ／ ${d.career.games}試合</p>
      <h2>打撃成績</h2>${table([["G", "試合"], ["AVG", "打率"], ["PA", "打席"], ["AB", "打数"], ["R", "得点"], ["H", "安打"], ["2B", "二塁打"], ["3B", "三塁打"], ["HR", "本塁打"], ["TB", "塁打"], ["RBI", "打点"], ["SB", "盗塁"], ["CS", "盗塁刺"], ["SH", "犠打"], ["SF", "犠飛"], ["BB", "四球"], ["IBB", "故意四球"], ["HBP", "死球"], ["SO", "三振"], ["GIDP", "併殺打"], ["SLG", "長打率"], ["OBP", "出塁率"]], b)}
      ${p.G ? `<h2>投手成績</h2>${table([["G", "登板"], ["W", "勝利"], ["L", "敗北"], ["SV", "セーブ"], ["HLD", "ホールド"], ["IP", "投球回"], ["BF", "打者"], ["pitches", "投球数"], ["H", "安打"], ["HR", "本塁打"], ["BB", "四球"], ["IBB", "故意四球"], ["HBP", "死球"], ["SO", "三振"], ["WP", "暴投"], ["BK", "ボーク"], ["R", "失点"], ["ER", "自責点"], ["ERA", "防御率"]], p)}` : ""}
      ${f.G ? `<h2>守備成績</h2>${table([["G", "試合"], ["PO", "刺殺"], ["A", "補殺"], ["E", "失策"], ["DP", "併殺"], ["PB", "捕逸"], ["FPCT", "守備率"]], f)}` : ""}
      <h2>出場試合</h2><ul class="list">${d.games.map(g => `<li><a href="/g/${esc(g.view_token)}" data-link><span class="grow">${esc(g.date)} ${esc(g.away)} 対 ${esc(g.home)}<br><span class="muted">${g.bat.PA ? `${g.bat.AB || 0}打数${g.bat.H || 0}安打${g.bat.RBI ? " " + g.bat.RBI + "打点" : ""}` : ""}${g.decision ? " " + g.decision : ""}</span></span><span class="score">${g.summary?.away ?? 0}-${g.summary?.home ?? 0}</span></a></li>`).join("") || "<li class='ev'><div class='item'>まだありません</div></li>"}</ul>`;
  } catch (e) { showError(e); }
}

// ================================================================ スコアブック形式の出力（早稲田式・印刷/PDF保存用）
// マスの作り：左の細い欄＝ボールカウント、右の正方形を4つの角に分けて
//   右下＝一塁、右上＝二塁、左上＝三塁、左下＝本塁、中央＝走者の最終結果（〇＝得点、Ⅰ〜Ⅲ＝アウト、l＝残塁）
const WS_HOW = { sb: "S", wp: "WP", pb: "PB", bk: "BK", error: "E", obstruction: "OB", interference: "IF", fc: "FC" };
const WS_PITCH = { ball: "●", called_strike: "○", swinging_strike: "×", foul: "∨", foul_bunt: "∨", foul_tip: "×", hbp: "●", unknown: "・" };
const ROMAN = ["", "Ⅰ", "Ⅱ", "Ⅲ"];
const WS_X0 = 14, WS_S = 64;                       // 正方形の左端と一辺
const WS_CORNER = { 0: [WS_X0, WS_S], 1: [WS_X0 + WS_S, WS_S], 2: [WS_X0 + WS_S, 0], 3: [WS_X0, 0], 4: [WS_X0, WS_S] };
const WS_REGION = { 1: [WS_X0 + WS_S - 16, WS_S - 10], 2: [WS_X0 + WS_S - 16, 15], 3: [WS_X0 + 16, 15], 4: [WS_X0 + 16, WS_S - 10] };
function wsText(x, y, t, cls = "t") { return `<text x="${x}" y="${y}" class="${cls}" text-anchor="middle">${esc(t)}</text>`; }
// 打者の打席結果（一塁の区画に書く）
function wsResult(c) {
  const [x, y] = WS_REGION[1];
  const f = (c.fielders || []).map(String);
  const pos = c.pos ? String(c.pos) : "";
  const arcOver = (cx, cy) => `<path d="M${cx - 5} ${cy - 10} Q${cx} ${cy - 18} ${cx + 5} ${cy - 10}" class="arc"/>`;
  // ゴロ：数字と数字の間に∪の弧を描く（6∪3、一塁手が自分で踏んだら 3∪A）
  const ground = (a, b) => wsText(x - 8, y, a, "t") + `<path d="M${x - 4} ${y - 8} Q${x - 1} ${y + 1} ${x + 2} ${y - 8}" class="arc"/>` + wsText(x + 7, y, b, b.length > 1 ? "t sm" : "t");
  switch (c.result) {
    case "single": case "double": case "triple": case "home_run": {
      const box = c.pos && c.pos <= 6 ? `<rect x="${x - 7}" y="${y - 10}" width="14" height="13" class="box hit"/>` : "";
      return box + wsText(x, y, pos || "安", "t hit") + `<circle cx="${x + 8}" cy="${y - 9}" r="1.4" class="dot"/>`;
    }
    case "ground_out": case "sac_bunt": {
      const g = f.length >= 2 ? ground(f[0], f.slice(1).join("")) : ground(f[0] || pos, f.length === 1 ? "A" : "");
      return (c.result === "sac_bunt" ? `<path d="M${x} ${y - 17} l9 9 -9 9 -9 -9 z" class="box"/>` : "") + g;
    }
    case "fly_out": case "sac_fly": case "infield_fly":
      return (c.result === "sac_fly" ? `<path d="M${x} ${y - 13} l7 7 -7 7 -7 -7 z" class="box"/>` : "") +
        arcOver(x, y) + wsText(x, y, c.result === "infield_fly" ? `IFF${pos}` : pos, c.result === "infield_fly" ? "t sm" : "t");
    case "foul_fly": return arcOver(x + 3, y) + wsText(x, y, `F${pos}`);
    case "line_out": return `<line x1="${x - 5}" y1="${y - 10}" x2="${x + 5}" y2="${y - 10}" class="arc"/>` + wsText(x, y, pos);
    case "strikeout": return wsText(x, y, "K", "t k");
    case "strikeout_dropped": return `<text x="${x}" y="${y}" class="t k" text-anchor="middle" transform="translate(${2 * x} 0) scale(-1 1)">K</text>`;
    case "walk": case "ibb": return wsText(x, y, c.result === "ibb" ? "IB" : "B");
    case "hbp": return wsText(x, y, "DB");
    case "reach_on_error": return wsText(x, y, `${c.error_pos || pos}E`, "t err");
    case "fielders_choice": return wsText(x, y, "FC");
    case "force_out": return ground(pos, "");
    case "interference": return wsText(x, y, "IF");
    default: return wsText(x, y, "?");
  }
}
function sbCellSvg(c, v) {
  const parts = [];
  // 正方形と4区画の線
  const X = WS_X0, S = WS_S, m = S / 2;
  parts.push(`<rect x="${X}" y="0" width="${S}" height="${S}" class="frame"/>`);
  parts.push(`<path d="M${X + m} 0 L${X + S} ${m} L${X + m} ${S} L${X} ${m} Z" class="inner"/>`);
  // ボールカウント（左の細い欄）
  const ps = (c.pitches || []).filter(p => p !== "in_play").map(p => WS_PITCH[p] || "・");
  const step = ps.length > 8 ? 56 / ps.length : 7.5;
  ps.forEach((sym, i) => parts.push(`<text x="6.5" y="${8 + i * step}" class="cnt${sym === "●" ? " ball" : ""}" text-anchor="middle" style="font-size:${Math.min(7, step)}px">${sym}</text>`));
  if (c.unrecorded && !ps.length) parts.push(`<text x="6.5" y="10" class="cnt" text-anchor="middle">－</text>`);
  // 打席結果
  parts.push(wsResult(c));
  // 進塁の線と理由
  const hit = RESULT_META_HIT.has(c.result);
  for (const sg of c.segments) {
    const isBatterReach = sg.from === 0 && !sg.out;
    if (!sg.out) {
      const red = hit && (isBatterReach || false);
      // 安打以外での出塁（四球・失策など）は、打者自身の出塁には線を引かない
      if (!(isBatterReach && !hit)) {
        for (let b = sg.from; b < sg.to; b++) {
          const [x1, y1] = WS_CORNER[b], [x2, y2] = WS_CORNER[b + 1];
          parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="run${red ? " hit" : ""}"/>`);
        }
      }
      if (sg.from > 0) {
        const lb = WS_HOW[sg.how] || (sg.by ? `(${sg.by})` : "");
        if (lb) { const [x, y] = WS_REGION[sg.to]; parts.push(wsText(x, y, lb, `t sm${sg.how === "error" ? " err" : ""}`)); }
      }
    } else if (sg.from > 0) {
      // 走者のアウト：アウトになった塁の区画に守備の流れ（盗塁死はT）
      const [x, y] = WS_REGION[sg.to];
      const fl = (sg.fielders || []).join("-") + (["cs", "po", "tag"].includes(sg.how) ? "T" : "");
      parts.push(wsText(x, y, fl || "×", "t sm out"));
    }
  }
  // 中央：最終結果
  const cx = X + m, cy = m;
  const liveHalf = v.status === "live" && c.inning === v.inning && c.half === v.half;
  if (c.scored) parts.push(`<circle cx="${cx}" cy="${cy}" r="9" class="runc"/>`);
  else if (c.out_no) parts.push(wsText(cx, cy + 4.5, ROMAN[c.out_no] || c.out_no, "t on"));
  else if (c.reached && !liveHalf) parts.push(wsText(cx, cy + 4, "l", "t lob"));
  if (c.outs_on_play >= 2 && c.out_no) parts.push(wsText(cx, cy + 15, c.outs_on_play === 2 ? "DP" : "TP", "t xs"));
  if (c.rbi) parts.push(`<text x="6.5" y="${S - 2}" class="rbi" text-anchor="middle">${c.rbi}</text><circle cx="6.5" cy="${S - 5}" r="5" class="rbic"/>`);
  if (c.unconfirmed) parts.push(`<text x="${X + S - 2}" y="9" class="q" text-anchor="end">?</text>`);
  return `<svg viewBox="0 0 ${X + S + 1} ${S + 1}" class="sbcell" role="img" aria-label="${esc(c.label || c.code)}">${parts.join("")}</svg>`;
}
const RESULT_META_HIT = new Set(["single", "double", "triple", "home_run"]);
async function pageScorebook(token) {
  $app.innerHTML = `<p class="boot">読み込み中…</p>`;
  let v;
  try { v = await api(`/api/view/${token}`); } catch (e) { $app.innerHTML = topbar("スコアブック") + `<div class="wrap"><p>${esc(e.message)}</p></div>`; bindTopbar(); return; }
  const team = side => {
    const bk = v.scorebook[side];
    const cols = Array.from({ length: bk.innings }, (_, i) => i + 1);
    const half = side === "away" ? "表" : "裏";
    return `<section class="sb-page">
      <div class="sb-head"><h2>${esc(v.team_names[side])}（${side === "away" ? "先攻" : "後攻"}）</h2>
        <span>${esc(v.game.date)}${v.game.venue ? " " + esc(v.game.venue) : ""} ／ ${esc(v.team_names.away)} ${v.rhe.away.R} － ${v.rhe.home.R} ${esc(v.team_names.home)}</span></div>
      <table class="sb"><thead><tr><th class="o">順</th><th class="n">打者</th>${cols.map(i => `<th>${i}${half}</th>`).join("")}</tr></thead>
      <tbody>${bk.rows.map(r => `<tr><td class="o">${r.order}</td><td class="n">${r.names.map(esc).join("<br>")}</td>${cols.map(i => `<td>${(r.detail[i] || []).map(c => sbCellSvg(c, v)).join("")}</td>`).join("")}</tr>`).join("")}</tbody>
      <tfoot><tr><td></td><td class="n">安打</td>${cols.map(i => `<td>${bk.hits_by_inning[i] || ""}</td>`).join("")}</tr>
      <tr><td></td><td class="n">得点</td>${cols.map(i => `<td>${v.linescore[side][i - 1] ?? ""}</td>`).join("")}</tr></tfoot></table>
    </section>`;
  };
  $app.innerHTML = topbar("スコアブック", `<button id="print">印刷・PDF</button>`) + `
    <div class="sb-wrap">
      <p class="muted no-print">早稲田式で表示しています　右下＝一塁、右上＝二塁、左上＝三塁、左下＝本塁、中央＝最終結果（赤〇＝得点、Ⅰ〜Ⅲ＝アウト、l＝残塁）
      <br>左の欄：●ボール ○見逃し ×空振り ∨ファウル　∪ゴロ ⌒フライ －ライナー K三振（逆K＝振り逃げ）B四球 DB死球 E失策 S盗塁 WP暴投 PB捕逸 BKボーク (数字)＝進塁させた打者の打順 T＝タッチアウト 左下の赤丸数字＝打点 ？＝未確認
      <br>iPhoneは「印刷・PDF」→ 共有 → 「ファイルに保存」でPDFにできます</p>
      ${team("away")}${team("home")}
    </div>`;
  bindTopbar();
  document.getElementById("print").onclick = () => window.print();
}

route();
