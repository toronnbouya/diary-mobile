"use strict";
// スマホ用の日記入力ページ。
// メモは GitHub の非公開リポジトリに「mobile_inbox/日付_時刻_乱数.md」として新規作成するだけ（既存ファイルは書き換えない）。
// PC の日記アプリがそれを取り込み、その日の日記の末尾に「📱 時刻 メモ」として追記する。
// 送れなかったメモはこの端末に保存しておき、電波が戻ったら自動で送る。
const $ = (s) => document.querySelector(s);
const WD = "日月火水木金土";
const LS = {
  get(k, d = "") { try { const v = localStorage.getItem("diary." + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("diary." + k, v); } catch {} },
  del(k) { try { localStorage.removeItem("diary." + k); } catch {} },
  json(k, d) { try { return JSON.parse(LS.get(k, "")) ?? d; } catch { return d; } },
};
const cfg = () => ({
  repo: LS.get("repo").trim(),
  token: LS.get("token").trim(),
  branch: LS.get("branch").trim() || "main",
  dayStart: Number(LS.get("dayStart", "4")) || 0,
  api: LS.get("apiBase") || "https://api.github.com",  // テスト用に差し替え可能（通常は触らない）
});
const S = { date: null, sending: false };

// ---------- 小物 ----------
const pad = (n, w = 2) => String(n).padStart(w, "0");
const ymd = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
function logicalToday() { return ymd(new Date(Date.now() - cfg().dayStart * 3600e3)); }
function shiftDate(d, n) { const x = new Date(d + "T00:00:00"); x.setDate(x.getDate() + n); return ymd(x); }
function fmtDate(d) { const x = new Date(d + "T00:00:00"); return `${x.getMonth() + 1}月${x.getDate()}日（${WD[x.getDay()]}）`; }
function isoLocal(x) {
  const off = -x.getTimezoneOffset(), sign = off >= 0 ? "+" : "-", a = Math.abs(off);
  return `${ymd(x)}T${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
function b64enc(s) {
  const b = new TextEncoder().encode(s); let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64dec(s) { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0))); }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = "toast"), err ? 5000 : 2200);
}
function setStatus(msg, kind = "") { const s = $("#status"); s.textContent = msg; s.className = "status " + kind; }

// ---------- GitHub API ----------
class GHError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
async function gh(method, path, body) {
  const c = cfg();
  if (!c.repo || !c.token) throw new GHError("最初に「設定」でリポジトリとトークンを入れてください", 0);
  let r;
  try {
    r = await fetch(c.api + path, {
      method, cache: "no-store", referrerPolicy: "no-referrer",
      headers: Object.assign({ Authorization: "Bearer " + c.token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new GHError("通信できません（電波が戻ったら自動で送ります）", -1); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = { 401: "トークンが無効か期限切れです。「設定」で貼り直してください", 403: "権限がありません（トークンの Contents を Read and write に）", 404: "リポジトリが見つかりません（名前とトークンの対象リポジトリを確認）" }[r.status];
    throw new GHError(m || data.message || "HTTP " + r.status, r.status);
  }
  return data;
}
const contentsPath = (p) => `/repos/${cfg().repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}`;

// ---------- 書く ----------
function outbox() { return LS.json("outbox", []); }
function saveOutbox(a) { LS.set("outbox", JSON.stringify(a)); }
function sentLog() { return LS.json("sent", []); }

function send() {
  const text = $("#text").value.trim();
  if (!text) return toast("何か書いてから送ってください");
  const now = new Date();
  const rand = Math.random().toString(36).slice(2, 6);
  const note = { id: `${S.date}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${rand}`,
                 date: S.date, captured: isoLocal(now), text };
  saveOutbox([...outbox(), note]);
  $("#text").value = ""; LS.del("draft");
  renderWrite();
  flush();
}

async function flush() {
  if (S.sending) return;
  S.sending = true;
  try {
    let q = outbox(), sent = 0;
    while (q.length) {
      const n = q[0];
      setStatus(`送信中…（残り${q.length}件）`, "busy");
      const content = `---\ndate: ${JSON.stringify(n.date)}\ncaptured: ${JSON.stringify(n.captured)}\nsource: "mobile"\n---\n\n${n.text}\n`;
      try {
        await gh("PUT", contentsPath(`mobile_inbox/${n.id}.md`), { message: `スマホ: ${n.date} メモ`, content: b64enc(content), branch: cfg().branch });
      } catch (e) {
        // 同じ名前が既にある＝前回送れていたのに応答だけ届かなかった → 送信済みとして扱う
        if (!(e.status === 422 && /sha/i.test(e.message))) {
          setStatus(e.status === -1 ? "📶 オフライン：電波が戻ったら自動で送ります" : "⚠ " + e.message, e.status === -1 ? "wait" : "error");
          if (e.status !== -1) toast(e.message, true);
          return;
        }
      }
      q = outbox().filter((x) => x.id !== n.id);
      saveOutbox(q);
      const log = [n, ...sentLog()].slice(0, 60);
      LS.set("sent", JSON.stringify(log));
      sent++;
      renderWrite();
    }
    if (sent) setStatus(`✓ 送りました ${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`, "ok");
  } finally { S.sending = false; renderWrite(false); }
}

function noteCard(n, badge) {
  const d = el("div", "note");
  d.append(el("span", "time", "📱 " + n.captured.slice(11, 16)));
  if (badge) d.append(el("span", "badge", badge));
  d.append(el("div", "txt", n.text));
  return d;
}
function renderWrite(updateStatus = true) {
  const q = outbox();
  const ob = $("#outbox"); ob.replaceChildren();
  if (q.length) {
    const h = el("div", "obhead");
    h.append(el("span", "", `送信待ち ${q.length}件`));
    const b = el("button", "ghost", "今すぐ送る"); b.onclick = flush; h.append(b);
    ob.append(h);
    q.forEach((n) => ob.append(noteCard(n, n.date !== S.date ? fmtDate(n.date) : "未送信")));
  }
  const mine = sentLog().filter((n) => n.date === S.date).reverse();
  const box = $("#sent"); box.replaceChildren();
  if (mine.length) mine.forEach((n) => box.append(noteCard(n)));
  else box.append(el("p", "muted", "まだありません"));
  if (updateStatus && !q.length && !S.sending && !$("#status").textContent) setStatus("");
}

// ---------- 読む ----------
function parseEntry(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n"); const meta = {};
  let body = text;
  if (lines[0] && lines[0].trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      for (const ln of lines.slice(1, end)) {
        const i = ln.indexOf(":"); if (i < 0) continue;
        const k = ln.slice(0, i).trim(), v = ln.slice(i + 1).trim();
        try { meta[k] = JSON.parse(v); } catch { meta[k] = v.replace(/^"|"$/g, ""); }
      }
      body = lines.slice(end + 1).join("\n").replace(/^\n/, "");
    }
  }
  return { meta, body };
}

async function loadRead() {
  const d = S.date, info = $("#read-info"), body = $("#body"), ai = $("#ai"), waiting = $("#waiting");
  info.textContent = "読み込み中…"; body.replaceChildren(); ai.replaceChildren(); waiting.replaceChildren();
  let entry = null;
  try {
    const f = await gh("GET", contentsPath(`entries/${d.slice(0, 4)}/${d}.md`) + `?ref=${encodeURIComponent(cfg().branch)}`);
    entry = parseEntry(b64dec(f.content || ""));
  } catch (e) {
    if (e.status !== 404) { info.textContent = "⚠ " + e.message; return; }
  }
  if (d !== S.date) return;  // 読み込み中に日付が変わった
  if (entry && entry.body.trim()) {
    const m = entry.meta;
    info.textContent = m.updated ? `PCで最後に保存: ${m.updated.slice(5, 16).replace("T", " ")}` : "";
    if (m.ai_summary) {
      ai.append(el("div", "sum", m.ai_summary));
      const tags = el("div", "tags");
      (m.ai_categories || []).forEach((c) => tags.append(el("span", "tag", c)));
      (m.ai_tags || []).forEach((t) => tags.append(el("span", "tag", "#" + t)));
      ai.append(tags);
    }
    body.textContent = entry.body;
  } else {
    info.textContent = "";
    body.append(el("p", "muted", "この日の日記はまだありません。"));
  }
  // GitHub には届いたが、PC がまだ取り込んでいないメモ
  try {
    const list = await gh("GET", contentsPath("mobile_inbox") + `?ref=${encodeURIComponent(cfg().branch)}`);
    const mine = (Array.isArray(list) ? list : []).filter((x) => x.type === "file" && x.name.startsWith(d + "_"));
    if (mine.length && d === S.date) {
      waiting.append(el("h3", "sub", `PCへの取り込み待ち（${mine.length}件）`));
      for (const x of mine) {
        const f = await gh("GET", contentsPath(x.path) + `?ref=${encodeURIComponent(cfg().branch)}`);
        const n = parseEntry(b64dec(f.content || ""));
        waiting.append(noteCard({ captured: String(n.meta.captured || ""), text: n.body.trim() }, "取り込み待ち"));
      }
      waiting.append(el("p", "muted small", "PCの日記アプリが動いていれば、数分以内に日記へ入ります。"));
    }
  } catch (e) { if (e.status !== 404) waiting.append(el("p", "muted small", "取り込み待ちの確認に失敗: " + e.message)); }
}

// ---------- 設定 ----------
function loadSettings() {
  $("#repo").value = LS.get("repo"); $("#token").value = LS.get("token");
  $("#branch").value = LS.get("branch"); $("#daystart").value = LS.get("dayStart", "");
}
async function saveSettings() {
  const repo = $("#repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return toast("リポジトリは「ユーザー名/リポジトリ名」の形で入れてください", true);
  LS.set("repo", repo); LS.set("token", $("#token").value.trim());
  LS.set("branch", $("#branch").value.trim());
  const ds = $("#daystart").value.trim(); ds === "" ? LS.del("dayStart") : LS.set("dayStart", String(Math.min(12, Math.max(0, Number(ds) || 0))));
  $("#repo").value = repo;
  const st = $("#settings-status"); st.textContent = "接続を確かめています…"; st.className = "status busy";
  try {
    const r = await gh("GET", `/repos/${repo}`);
    st.textContent = `✓ つながりました（${r.private ? "非公開" : "⚠ 公開"}リポジトリ ${r.full_name}）。「書く」から送れます。`;
    st.className = "status " + (r.private ? "ok" : "error");
    flush();
  } catch (e) { st.textContent = "⚠ " + e.message; st.className = "status error"; }
}
function forget() {
  const n = outbox().length;
  if (!confirm(`この端末からトークン・設定・下書き${n ? `・未送信メモ${n}件` : ""}を消します。よろしいですか？`)) return;
  ["repo", "token", "branch", "dayStart", "draft", "outbox", "sent", "apiBase"].forEach(LS.del);
  loadSettings(); renderWrite(); toast("この端末から消しました");
}

// ---------- 画面 ----------
function setDate(d) {
  S.date = d;
  $("#date-input").value = d;
  $("#date-label").textContent = fmtDate(d) + (d === logicalToday() ? " 今日" : "");
  renderWrite();
  if ($("#view-read").classList.contains("active")) loadRead();
}
function switchView(v) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === "view-" + v));
  if (v === "read") loadRead();
  if (v === "settings") loadSettings();
  if (v === "write") $("#text").focus();
}

function init() {
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchView(t.dataset.view)));
  $("#prev").onclick = () => setDate(shiftDate(S.date, -1));
  $("#next").onclick = () => setDate(shiftDate(S.date, 1));
  $("#date-input").onchange = (e) => e.target.value && setDate(e.target.value);
  $("#send").onclick = send;
  $("#text").addEventListener("input", () => LS.set("draft", $("#text").value));
  $("#text").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") send(); });
  $("#reload").onclick = loadRead;
  $("#save-settings").onclick = saveSettings;
  $("#forget").onclick = forget;
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (S.date !== logicalToday() && !$("#text").value.trim()) setDate(logicalToday());  // 翌日に開き直したら今日へ
    flush();
  });
  $("#text").value = LS.get("draft");
  setDate(logicalToday());
  if (!cfg().repo || !cfg().token) switchView("settings");
  else flush();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
init();
