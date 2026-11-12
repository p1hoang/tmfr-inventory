/* TMFR Parts Inventory — standalone web app (Supabase backend). */
(() => {
"use strict";

const CFG = window.TMFR_CONFIG || {};
const DEFAULT_CATS = ["Wire & Cable","Crimps & Terminals","Connectors","Heatshrink & Sleeving","Fasteners","Fuses & Relays","Electronic Components","Cells & Batteries","PCBs & Modules","Enclosures & Mounting","Adhesives & Tape","Tools & Consumables","Raw Material","Misc"];
const FIELDS = ["name","category","spec","qty","unit","min_qty","location","pn","supplier","barcode","notes"];

const $ = s => document.querySelector(s);
const S = {
  sb:null, name:null, code:"", parts:new Map(), loaded:false,
  pending:{}, timers:{}, filter:"all", q:"",
  editing:null, confirmDel:false, importRows:[],
  aiEnabled:false, foundId:null, scanMode:"find", reader:null, lastFrame:null
};

/* ---------- utils ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const fmt = n => Number.isInteger(n) ? String(n) : String(+(+n).toFixed(2));
const effQty = p => num(p.qty) + (S.pending[p.id] || 0);
function level(p){ const q = effQty(p), m = num(p.min_qty); if (q <= 0) return "out"; if (m > 0 && q <= m) return "low"; return "ok"; }
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2800); }
function status(msg, err){ const s = $("#status"); s.hidden = !msg; s.textContent = msg || ""; s.className = "note" + (err ? " err" : ""); }
function ago(iso){
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "just now"; if (s < 3600) return Math.floor(s/60) + " min ago";
  if (s < 86400) return Math.floor(s/3600) + " h ago"; if (s < 604800) return Math.floor(s/86400) + " d ago";
  return new Date(iso).toLocaleDateString();
}
const who = n => n || "someone";
function errText(e){
  const m = (e && (e.message || e.error_description)) || "";
  if (/Wrong team code/i.test(m)) return "The team code changed. Tap your name to enter the new one.";
  if (/Enter your name/i.test(m)) return "Enter your name first.";
  if (/fetch|network/i.test(m)) return "No connection. Try again when you're back online.";
  return m || "Something went wrong. Try again.";
}
function setupHint(e){
  const m = (e && e.message) || "";
  if (/Invalid path|Invalid API key|No API key|Unregistered API key/i.test(m)) return "Can't connect to the database: check SUPABASE_URL and the publishable key in config.js.";
  if (/team_code_required|team_ok|schema cache|does not exist/i.test(m)) return "The database isn't set up yet: run supabase/schema.sql in the Supabase SQL Editor.";
  return errText(e);
}
function view(id){ ["#vSetup","#vSignin","#vApp"].forEach(v => $(v).hidden = v !== id); }

/* ---------- boot & who's using it ---------- */
const LS = {
  get(k){ try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v){ try { localStorage.setItem(k, v); } catch {} },
  del(k){ try { localStorage.removeItem(k); } catch {} }
};
// Accepts the project URL in any form people tend to paste:
// https://ref.supabase.co, .../rest/v1/, or the dashboard link .../dashboard/project/ref
function projectUrl(raw){
  const s = String(raw || "").trim();
  const dash = s.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (dash) return `https://${dash[1]}.supabase.co`;
  if (/^[a-z0-9]{15,}$/i.test(s)) return `https://${s}.supabase.co`;
  try { return new URL(/^https?:\/\//.test(s) ? s : "https://" + s).origin; } catch { return s; }
}
function client(code){
  return window.supabase.createClient(projectUrl(CFG.SUPABASE_URL), String(CFG.SUPABASE_ANON_KEY || "").trim(), {
    auth: { persistSession:false, autoRefreshToken:false },
    global: { headers: code ? { "x-team-code": code } : {} }
  });
}
async function boot(){
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY || !window.supabase) { view("#vSetup"); return; }
  fetch("api/read-label", { method:"GET" }).then(r => r.ok ? r.json() : null).then(j => { S.aiEnabled = !!(j && j.enabled); }).catch(() => {});
  const name = LS.get("tmfr.name"), code = LS.get("tmfr.code") || "";
  if (name) {
    S.sb = client(code);
    const { data:ok, error } = await S.sb.rpc("team_ok");
    if (!error && ok) { S.code = code; enter(name); return; }
    if (error && /fetch|network/i.test(error.message || "")) { S.code = code; enter(name); status("Offline. Changes won't save until you're back online.", true); return; }
  }
  showSignin();
}

async function showSignin(){
  view("#vSignin"); siErr("");
  $("#siName").value = LS.get("tmfr.name") || "";
  const recent = JSON.parse(LS.get("tmfr.recentNames") || "[]");
  $("#siRecent").hidden = !recent.length;
  $("#siRecent").innerHTML = recent.map(n => `<button type="button" data-name="${esc(n)}">${esc(n)}</button>`).join("");
  S.sb = S.sb || client("");
  const { data:req, error:reqErr } = await client("").rpc("team_code_required");
  if (reqErr) siErr(setupHint(reqErr));
  $("#siCodeWrap").hidden = !req;
  $("#siCode").value = req ? (LS.get("tmfr.code") || "") : "";
  setTimeout(() => $("#siName").focus(), 50);
}
function siErr(msg){ const e = $("#siErr"); e.hidden = !msg; e.textContent = msg || ""; }
$("#siRecent").addEventListener("click", e => { const b = e.target.closest("[data-name]"); if (b) { $("#siName").value = b.dataset.name; ($("#siCodeWrap").hidden ? $("#siGo") : $("#siCode")).focus(); } });

$("#signinForm").addEventListener("submit", async e => {
  e.preventDefault(); siErr("");
  const name = $("#siName").value.trim().replace(/\s+/g, " ");
  if (!name) { siErr("Enter your name."); $("#siName").focus(); return; }
  if (name.length > 40) { siErr("Keep your name under 40 characters."); return; }
  const code = $("#siCodeWrap").hidden ? "" : $("#siCode").value.trim();
  const b = $("#siGo"); b.disabled = true; b.textContent = "Checking…";
  const sb = client(code);
  const { data:ok, error } = await sb.rpc("team_ok");
  b.disabled = false; b.textContent = "Continue";
  if (error) { siErr(setupHint(error)); return; }
  if (!ok) { siErr(code ? "That team code isn't right." : "Enter the team code."); $("#siCode").focus(); return; }
  S.sb = sb; S.code = code;
  LS.set("tmfr.name", name); if (code) LS.set("tmfr.code", code); else LS.del("tmfr.code");
  const recent = [name, ...JSON.parse(LS.get("tmfr.recentNames") || "[]").filter(n => n.toLowerCase() !== name.toLowerCase())].slice(0, 8);
  LS.set("tmfr.recentNames", JSON.stringify(recent));
  enter(name);
});
function switchName(){ closeMenu(); teardown(); LS.del("tmfr.name"); showSignin(); }
$("#btnSignOut").addEventListener("click", switchName);
$("#btnWho").addEventListener("click", switchName);

async function enter(name){
  S.name = name;
  $("#btnWho").textContent = name;
  $("#whoami").textContent = "Using the app as " + name;
  view("#vApp");
  const f = LS.get("tmfr.filter"); if (f) S.filter = f;
  render();
  await loadParts();
  subscribe();
}
function teardown(){
  S.name = null; S.parts.clear(); S.loaded = false;
  if (S.channel) { S.sb.removeChannel(S.channel); S.channel = null; }
  clearInterval(S.poll);
}

/* ---------- data ---------- */
async function loadParts(){
  const all = []; let from = 0;
  for (;;) {
    const { data, error } = await S.sb.from("parts").select("*").order("name").range(from, from + 999);
    if (error) { status("Couldn't load the inventory: " + errText(error), true); S.loaded = true; render(); return; }
    all.push(...data); if (data.length < 1000) break; from += 1000;
  }
  S.parts = new Map(all.map(p => [p.id, p])); S.loaded = true; status(""); render();
}
/* Live sync: whoever changes something pings everyone else, who re-fetch that part. */
function subscribe(){
  S.channel = S.sb.channel("tmfr-inventory", { config:{ broadcast:{ self:false } } })
    .on("broadcast", { event:"changed" }, ({ payload }) => {
      if (payload && payload.id) refreshPart(payload.id); else loadParts();
    })
    .subscribe(st => { if (st === "CHANNEL_ERROR" || st === "TIMED_OUT") status("Live updates paused. Counts refresh when you reopen the app.", false); else if (st === "SUBSCRIBED") status(""); });
  clearInterval(S.poll);
  S.poll = setInterval(() => { if (document.visibilityState === "visible" && S.name) loadParts(); }, 60000);
}
function ping(id){ S.channel && S.channel.send({ type:"broadcast", event:"changed", payload: id ? { id } : {} }).catch?.(() => {}); }
async function refreshPart(id){
  const { data, error } = await S.sb.from("parts").select("*").eq("id", id).maybeSingle();
  if (error) return;
  if (data) S.parts.set(id, data); else S.parts.delete(id);
  render(); if (!$("#sFound").hidden) paintFound();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.name && S.loaded) loadParts(); });

/* ---------- list ---------- */
function categories(){ const s = new Set(DEFAULT_CATS); S.parts.forEach(p => p.category && s.add(p.category)); return [...s]; }
function usedCats(){
  const s = new Set(); S.parts.forEach(p => s.add(p.category || "Misc"));
  return [...s].sort((a,b) => { const ia = DEFAULT_CATS.indexOf(a), ib = DEFAULT_CATS.indexOf(b); return (ia<0?99:ia) - (ib<0?99:ib) || a.localeCompare(b); });
}
function matches(p){
  const f = S.filter;
  if (f === "low" && level(p) !== "low") return false;
  if (f === "out" && level(p) !== "out") return false;
  if (f.startsWith("cat:") && (p.category || "Misc") !== f.slice(4)) return false;
  if (S.q) { const hay = [p.name,p.category,p.spec,p.pn,p.location,p.supplier,p.barcode,p.notes].join(" ").toLowerCase(); return S.q.split(/\s+/).every(w => hay.includes(w)); }
  return true;
}
function render(){
  const parts = [...S.parts.values()];
  const nLow = parts.filter(p => level(p) === "low").length, nOut = parts.filter(p => level(p) === "out").length;
  const cats = usedCats();
  if (S.filter.startsWith("cat:") && !cats.includes(S.filter.slice(4))) S.filter = "all";
  const chips = [["all","All"],["low",`Low (${nLow})`,"low"],["out",`Out (${nOut})`,"out"],...cats.map(c => ["cat:"+c, c])];
  $("#chips").innerHTML = chips.map(([k,l,c]) => `<button type="button" class="chip ${c||""}" data-f="${esc(k)}" aria-pressed="${S.filter===k}">${esc(l)}</button>`).join("");
  $("#catList").innerHTML = categories().map(c => `<option value="${esc(c)}">`).join("");
  $("#summary").innerHTML = S.loaded
    ? `<b>${parts.length}</b> part${parts.length===1?"":"s"} · <b>${cats.length}</b> categories · <span class="w">${nLow} low</span> · <span class="r">${nOut} out</span>`
    : "Loading inventory…";
  const out = $("#out");
  if (!S.loaded) { out.innerHTML = ""; return; }
  if (!parts.length) {
    out.innerHTML = `<div class="empty"><h2>No parts logged yet</h2><p>Add anything the team stocks: wire by gauge, crimps, connectors, fasteners, fuses, heatshrink, cells, tools. Tap <b>Scan part</b> and point your camera at a barcode to add one in seconds.</p><button class="primary" type="button" data-act="add">+ Add first part</button> <button type="button" data-act="import">Import a CSV</button></div>`;
    return;
  }
  const shown = parts.filter(matches);
  if (!shown.length) { out.innerHTML = `<p class="note">Nothing matches that search or filter.</p>`; return; }
  const groups = {}; shown.forEach(p => (groups[p.category || "Misc"] ??= []).push(p));
  out.innerHTML = cats.filter(c => groups[c]).map(c => {
    const rows = groups[c].sort((a,b) => (a.name||"").localeCompare(b.name||"",undefined,{numeric:true}) || (a.spec||"").localeCompare(b.spec||"",undefined,{numeric:true}));
    return `<section class="group"><h2><span>${esc(c)}</span><span>${rows.length}</span></h2><div class="list">${rows.map(rowHtml).join("")}</div></section>`;
  }).join("");
}
function rowHtml(p){
  const lv = level(p);
  const meta = [
    p.location ? `<span class="bin">${esc(p.location)}</span>` : "",
    p.pn ? `<span class="pn">${esc(p.pn)}</span>` : "",
    p.supplier ? `<span>${esc(p.supplier)}</span>` : "",
    lv === "low" ? `<span class="flag low">Low · min ${fmt(num(p.min_qty))}</span>` : "",
    lv === "out" ? `<span class="flag out">Out</span>` : ""
  ].join("");
  return `<div class="row ${lv}" data-id="${esc(p.id)}"><div class="stripe"></div>
    <button type="button" class="info" data-act="edit" aria-label="Edit ${esc(p.name)}">
      <div class="name">${esc(p.name || "Unnamed part")}${p.spec ? ` <span class="spec">· ${esc(p.spec)}</span>` : ""}</div>
      ${meta ? `<div class="meta">${meta}</div>` : ""}
    </button>
    <div class="qty">
      <button type="button" data-act="dec" aria-label="Remove one">−</button>
      <div class="count"><b>${fmt(effQty(p))}</b><span>${esc(p.unit || "pcs")}</span></div>
      <button type="button" data-act="inc" aria-label="Add one">+</button>
    </div></div>`;
}

$("#out").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act;
  if (act === "add") return openForm();
  if (act === "import") return openImport();
  const p = S.parts.get(b.closest(".row")?.dataset.id); if (!p) return;
  if (act === "edit") openForm(p); else if (act === "inc") bump(p.id, 1); else if (act === "dec") bump(p.id, -1);
});
$("#chips").addEventListener("click", e => {
  const b = e.target.closest("[data-f]"); if (!b) return;
  const f = b.dataset.f; S.filter = (S.filter === f && f !== "all") ? "all" : f;
  try { localStorage.setItem("tmfr.filter", S.filter); } catch {}
  render();
});
let qT; $("#q").addEventListener("input", e => { clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value.trim().toLowerCase(); render(); }, 120); });

/* +/- taps are batched, then applied atomically on the server */
function bump(id, d){
  const p = S.parts.get(id); if (!p || effQty(p) + d < 0) return;
  S.pending[id] = (S.pending[id] || 0) + d; render();
  clearTimeout(S.timers[id]); S.timers[id] = setTimeout(() => flush(id), 700);
}
async function flush(id){
  const d = S.pending[id]; if (!d) return;
  const { data, error } = await S.sb.rpc("adjust_qty", { p_id:id, p_delta:d, p_by:S.name });
  delete S.pending[id];
  if (error) { toast(errText(error)); render(); return; }
  const p = S.parts.get(id); if (p) { S.parts.set(id, { ...p, qty:data, updated_by:S.name, updated_at:new Date().toISOString() }); render(); }
  ping(id);
}

/* ---------- menu ---------- */
function closeMenu(){ $("#moreMenu").hidden = true; $("#btnMore").setAttribute("aria-expanded","false"); }
$("#btnMore").addEventListener("click", e => { e.stopPropagation(); const m = $("#moreMenu"); m.hidden = !m.hidden; $("#btnMore").setAttribute("aria-expanded", String(!m.hidden)); });
document.addEventListener("click", e => { if (!e.target.closest("#moreMenu")) closeMenu(); });

/* ---------- edit form ---------- */
function openForm(p, pre, note){
  S.editing = p || null; S.confirmDel = false;
  $("#formTitle").textContent = p ? "Edit part" : "Add part";
  $("#formBanner").hidden = !note; $("#formBanner").textContent = note || "";
  FIELDS.forEach(k => {
    let v = p ? (p[k] ?? "") : "";
    if (k === "qty") v = p ? fmt(effQty(p)) : "0";
    if (k === "min_qty") v = p ? (num(p.min_qty) ? fmt(num(p.min_qty)) : "") : "";
    if (!p && k === "unit") v = "pcs";
    if (!p && k === "category" && S.filter.startsWith("cat:")) v = S.filter.slice(4);
    $("#f_" + k).value = v;
  });
  if (pre) Object.entries(pre).forEach(([k,v]) => { const el = $("#f_" + k); if (el && v !== undefined && v !== null && v !== "") el.value = v; });
  $("#btnDelete").hidden = !p; $("#btnDelete").textContent = "Delete";
  $("#btnHistory").hidden = !p;
  $("#stamp").textContent = p && p.updated_at ? `Last changed ${ago(p.updated_at)}${p.updated_by ? " by " + who(p.updated_by) : ""}` : "";
  $("#sForm").hidden = false;
  if (!p && !pre) setTimeout(() => $("#f_name").focus(), 50);
}
function closeForm(){ $("#sForm").hidden = true; S.editing = null; }
$("#btnAdd").addEventListener("click", () => openForm());
$("#btnCancel").addEventListener("click", closeForm);
$("#sForm").addEventListener("click", e => { if (e.target.id === "sForm") closeForm(); });

$("#form").addEventListener("submit", async e => {
  e.preventDefault();
  const v = {}; FIELDS.forEach(k => v[k] = $("#f_" + k).value.trim());
  if (!v.name) { $("#f_name").focus(); toast("Give the part a name."); return; }
  const body = { name:v.name, category:v.category || "Misc", spec:v.spec, qty:Math.max(0, num(v.qty)), unit:v.unit || "pcs",
    min_qty:Math.max(0, num(v.min_qty)), location:v.location, pn:v.pn, supplier:v.supplier, barcode:v.barcode, notes:v.notes, updated_by:S.name };
  const b = $("#btnSave"); b.disabled = true;
  let res;
  if (S.editing) {
    const id = S.editing.id; clearTimeout(S.timers[id]); delete S.pending[id];
    res = await S.sb.from("parts").update(body).eq("id", id).select().single();
  } else {
    res = await S.sb.from("parts").insert(body).select().single();
  }
  b.disabled = false;
  if (res.error) { toast(errText(res.error)); return; }
  S.parts.set(res.data.id, res.data); render(); ping(res.data.id);
  toast(S.editing ? "Saved" : "Added " + body.name); closeForm();
});
$("#btnDelete").addEventListener("click", async () => {
  if (!S.editing) return;
  if (!S.confirmDel) { S.confirmDel = true; $("#btnDelete").textContent = "Tap again to delete"; return; }
  const { id, name } = S.editing;
  const { error } = await S.sb.rpc("delete_part", { p_id:id, p_by:S.name });
  if (error) { toast(errText(error)); return; }
  S.parts.delete(id); render(); ping(id); closeForm(); toast("Deleted " + name);
});
$("#btnHistory").addEventListener("click", () => { const p = S.editing; if (p) openLog(p); });

/* ---------- activity log ---------- */
const ACT = { added:"added", took:"took out", put:"put in", corrected:"set count", edited:"edited", deleted:"deleted" };
let logPart = null, logPerson = "", logRows = [];
async function openLog(part){
  logPart = part || null; logPerson = "";
  $("#logTitle").textContent = part ? "History · " + part.name : "Activity";
  $("#logList").innerHTML = `<p class="note">Loading…</p>`; $("#logPeople").innerHTML = ""; $("#sLog").hidden = false;
  let q = S.sb.from("activity").select("*").order("at", { ascending:false }).limit(part ? 200 : 300);
  if (part) q = q.eq("part_id", part.id);
  const { data, error } = await q;
  if (error) { $("#logList").innerHTML = `<p class="note err">${esc(errText(error))}</p>`; return; }
  logRows = data; paintLog();
}
function paintLog(){
  const people = [...new Set(logRows.map(r => r.by_name).filter(Boolean))].sort((a,b) => a.localeCompare(b));
  $("#logPeople").innerHTML = people.length > 1
    ? [["", "Everyone"], ...people.map(n => [n, n])].map(([k,l]) => `<button type="button" class="chip" data-person="${esc(k)}" aria-pressed="${logPerson===k}">${esc(l)}</button>`).join("")
    : "";
  const rows = logPerson ? logRows.filter(r => r.by_name === logPerson) : logRows;
  if (!rows.length) { $("#logList").innerHTML = `<p class="note">Nothing yet.</p>`; return; }
  $("#logList").innerHTML = rows.map(r => {
    const d = r.delta == null ? null : num(r.delta);
    let badge, cls;
    if (r.action === "edited") { badge = "edit"; cls = "neu"; }
    else if (r.action === "deleted") { badge = "del"; cls = "neg"; }
    else { badge = (d > 0 ? "+" : d < 0 ? "−" : "") + fmt(Math.abs(d || 0)); cls = d < 0 ? "neg" : "pos"; }
    const what = r.action === "edited" ? ` (${esc(r.detail)})` : "";
    const left = r.qty_after != null && r.action !== "edited" && r.action !== "deleted" ? ` · ${fmt(num(r.qty_after))} left` : "";
    return `<div class="logrow"><div class="delta ${cls}">${badge}</div>
      <div><span class="act">${esc(r.by_name || "Someone")}</span> ${esc(ACT[r.action] || r.action)} ${logPart ? "" : `<b>${esc(r.part_name)}</b>`}${what}</div>
      <div class="sub">${esc(ago(r.at))}${left}</div></div>`;
  }).join("");
}
$("#logPeople").addEventListener("click", e => { const b = e.target.closest("[data-person]"); if (!b) return; logPerson = b.dataset.person; paintLog(); });
$("#btnActivity").addEventListener("click", () => openLog(null));
$("#logClose").addEventListener("click", () => $("#sLog").hidden = true);
$("#sLog").addEventListener("click", e => { if (e.target.id === "sLog") $("#sLog").hidden = true; });

/* ---------- supplier label barcodes (ECIA / ISO 15434: Digi-Key, Mouser, Arrow) ---------- */
function parseEcia(t){
  if (!t || !/^\[\)>/.test(t)) return null;
  const out = {};
  t.replace(/^\[\)>\x1e?06\x1d?/, "").split(/[\x1d\x1e\x04]/).forEach(f => {
    let m;
    if ((m = f.match(/^1P(.+)/))) out.mpn = m[1].trim();
    else if ((m = f.match(/^30P(.+)/))) out.spn = out.spn || m[1].trim();
    else if ((m = f.match(/^P(.+)/))) out.spn = m[1].trim();
    else if ((m = f.match(/^Q(\d+(?:\.\d+)?)$/))) out.qty = +m[1];
  });
  return out.mpn || out.spn ? out : null;
}
const keyFor = text => { const e = parseEcia(text); return e ? (e.mpn || e.spn) : text.trim(); };
function findPart(text){
  const key = keyFor(text).toLowerCase(), e = parseEcia(text);
  const parts = [...S.parts.values()];
  return parts.find(p => (p.barcode || "").toLowerCase() === key)
    || parts.find(p => p.pn && p.pn.toLowerCase() === key)
    || (e && parts.find(p => p.pn && [e.mpn, e.spn].filter(Boolean).some(x => x.toLowerCase() === p.pn.toLowerCase())));
}
function supplierFrom(e){ if (!e || !e.spn) return ""; if (/-ND$/i.test(e.spn)) return "Digi-Key"; if (/^\d{2,3}-/.test(e.spn)) return "Mouser"; return ""; }

/* ---------- live scanner ---------- */
function makeReader(){
  const Z = window.ZXing, hints = new Map();
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
    Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39,
    Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
    Z.BarcodeFormat.ITF, Z.BarcodeFormat.PDF_417, Z.BarcodeFormat.CODABAR
  ]);
  return new Z.BrowserMultiFormatReader(hints, 200);
}
async function openScanner(mode){
  S.scanMode = mode || "find";
  $("#sScan").hidden = false; $("#typeForm").hidden = true; $("#scTorch").hidden = true; $("#scTorch").setAttribute("aria-pressed","false");
  $("#scanHint").textContent = S.scanMode === "link" ? "Scan the barcode to link to this part" : "Point at a barcode or QR / Data Matrix code";
  $("#scLabel").hidden = !S.aiEnabled || S.scanMode === "link";
  if (!window.ZXing || !navigator.mediaDevices?.getUserMedia) { $("#scanHint").textContent = "Live camera isn't available here. Use a photo or type the code."; return; }
  try {
    S.reader = makeReader(); let handled = false;
    await S.reader.decodeFromConstraints({ audio:false, video:{ facingMode:{ ideal:"environment" }, width:{ ideal:1920 }, height:{ ideal:1080 } } }, $("#video"), (res) => {
      if (!res || handled) return; handled = true;
      grabFrame(); navigator.vibrate?.(60);
      const text = res.getText(); stopScanner(); onCode(text);
    });
    setupTorch();
  } catch (e) {
    $("#scanHint").textContent = /NotAllowed|Permission/i.test(e && e.name || e)
      ? "Camera access is blocked. Allow it in your browser settings, or use a photo."
      : "Couldn't start the camera. Use a photo or type the code.";
  }
}
function grabFrame(){
  const v = $("#video"); if (!v.videoWidth) { S.lastFrame = null; return; }
  const k = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement("canvas"); c.width = Math.round(v.videoWidth*k); c.height = Math.round(v.videoHeight*k);
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height); S.lastFrame = c;
}
function stopScanner(){
  try { S.reader && S.reader.reset(); } catch {}
  const v = $("#video"); if (v.srcObject) { v.srcObject.getTracks().forEach(t => t.stop()); v.srcObject = null; }
  S.reader = null; $("#sScan").hidden = true;
}
function setupTorch(){
  const v = $("#video");
  const check = () => {
    const track = v.srcObject && v.srcObject.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    if (caps.torch) { $("#scTorch").hidden = false; S.track = track; }
  };
  if (v.readyState >= 2) check(); else v.addEventListener("playing", check, { once:true });
}
$("#scTorch").addEventListener("click", async () => {
  const on = $("#scTorch").getAttribute("aria-pressed") !== "true";
  try { await S.track.applyConstraints({ advanced:[{ torch:on }] }); $("#scTorch").setAttribute("aria-pressed", String(on)); } catch {}
});
$("#scClose").addEventListener("click", () => { stopScanner(); if (S.scanMode === "link") $("#sForm").hidden = false; });
$("#scType").addEventListener("click", () => { $("#typeForm").hidden = false; $("#typeIn").value = ""; $("#typeIn").focus(); });
$("#typeForm").addEventListener("submit", e => { e.preventDefault(); const t = $("#typeIn").value.trim(); if (!t) return; S.lastFrame = null; stopScanner(); onCode(t); });
$("#scLabel").addEventListener("click", () => { grabFrame(); stopScanner(); if (!S.lastFrame) { toast("Camera isn't ready yet."); return; } newFromLabel(null); });
$("#scPhoto").addEventListener("click", () => { const i = $("#photoIn"); i.value = ""; i.click(); });
$("#photoIn").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  stopScanner();
  try {
    const c = await fileToCanvas(f, 2000); S.lastFrame = c;
    const code = await decodeCanvas(c);
    if (code) onCode(code);
    else if (S.scanMode === "link") { toast("No barcode found in that photo."); $("#sForm").hidden = false; }
    else if (S.aiEnabled) newFromLabel(null);
    else openForm(null, {}, "No barcode found in that photo. Fill the part in by hand.");
  } catch { toast("Couldn't open that photo."); }
});
async function fileToCanvas(file, max){
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth*k); c.height = Math.round(img.naturalHeight*k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); return c;
  } finally { URL.revokeObjectURL(url); }
}
async function decodeCanvas(c){
  try { const r = await makeReader().decodeFromImageUrl(c.toDataURL("image/jpeg", .92)); return r && r.getText(); } catch { return null; }
}

function onCode(text){
  if (S.scanMode === "link") {
    $("#f_barcode").value = keyFor(text);
    const e = parseEcia(text); if (e?.mpn && !$("#f_pn").value) $("#f_pn").value = e.mpn;
    $("#sForm").hidden = false; toast("Barcode linked. Save to keep it."); return;
  }
  const hit = findPart(text);
  if (hit) { openFound(hit, parseEcia(text)); return; }
  newFromLabel(text);
}
async function newFromLabel(code){
  const e = code ? parseEcia(code) : null;
  const pre = { barcode: code ? keyFor(code) : "", pn: e?.mpn || e?.spn || "", qty: e?.qty ?? "", supplier: supplierFrom(e) };
  let ai = null;
  if (S.aiEnabled && S.lastFrame) {
    $("#busyThumb").src = S.lastFrame.toDataURL("image/jpeg", .7); $("#busyThumb").hidden = false;
    $("#busyMsg").textContent = "This takes a few seconds."; $("#sBusy").hidden = false;
    try { ai = await readLabel(S.lastFrame, code); } catch (err) { ai = null; }
    $("#sBusy").hidden = true;
    if (ai?.pn) { const hit = findPart(ai.pn); if (hit) { openFound(hit, e); return; } }
  }
  const clean = Object.fromEntries(Object.entries(pre).filter(([,v]) => v !== "" && v !== undefined && v !== null));
  const merged = { ...(ai || {}), ...clean };
  const note = ai ? "Filled in from the label. Check the details, add a bin location, then save."
    : code ? "New barcode. Fill in the details and save to link it."
    : "Couldn't read the label. Fill the part in by hand.";
  openForm(null, merged, note);
}
async function readLabel(canvas, code){
  let c = canvas;
  if (Math.max(c.width, c.height) > 1400) {
    const k = 1400 / Math.max(c.width, c.height), d = document.createElement("canvas");
    d.width = Math.round(c.width*k); d.height = Math.round(c.height*k); d.getContext("2d").drawImage(c, 0, 0, d.width, d.height); c = d;
  }
  const image = c.toDataURL("image/jpeg", .85).split(",")[1];
  const r = await fetch("api/read-label", {
    method:"POST", headers:{ "Content-Type":"application/json", "x-team-code": S.code || "" },
    body: JSON.stringify({ image, code: code || "", categories: categories() })
  });
  if (!r.ok) return null;
  const j = await r.json(); return j && j.fields && Object.keys(j.fields).length ? j.fields : null;
}
$("#btnScan").addEventListener("click", () => openScanner("find"));
$("#fab").addEventListener("click", () => openScanner("find"));
$("#btnLinkScan").addEventListener("click", () => { $("#sForm").hidden = true; openScanner("link"); });

/* ---------- found: quick take / put ---------- */
function openFound(p, e){
  S.foundId = p.id; $("#fdAmt").value = e?.qty ? fmt(e.qty) : "1";
  paintFound(); $("#sFound").hidden = false;
}
function paintFound(){
  const p = S.parts.get(S.foundId); if (!p) { $("#sFound").hidden = true; return; }
  $("#fdName").innerHTML = esc(p.name) + (p.spec ? ` <span class="spec">· ${esc(p.spec)}</span>` : "");
  $("#fdMeta").innerHTML = [p.location ? `<span class="bin">${esc(p.location)}</span>` : "", p.pn ? `<span class="pn">${esc(p.pn)}</span>` : ""].join("");
  $("#fdCount").innerHTML = fmt(effQty(p)) + `<span>${esc(p.unit || "pcs")} in stock</span>`;
}
async function adjustFound(sign){
  const p = S.parts.get(S.foundId); if (!p) return;
  const amt = Math.abs(num($("#fdAmt").value)); if (!amt) { $("#fdAmt").focus(); return; }
  if (sign < 0 && amt > effQty(p)) { toast(`Only ${fmt(effQty(p))} in stock.`); return; }
  clearTimeout(S.timers[p.id]); const pend = S.pending[p.id] || 0; delete S.pending[p.id];
  const { data, error } = await S.sb.rpc("adjust_qty", { p_id:p.id, p_delta: pend + sign*amt, p_by:S.name });
  if (error) { toast(errText(error)); return; }
  S.parts.set(p.id, { ...p, qty:data, updated_by:S.name, updated_at:new Date().toISOString() }); render(); ping(p.id);
  toast(`${sign < 0 ? "Took out" : "Put in"} ${fmt(amt)} · ${fmt(data)} left`); $("#sFound").hidden = true;
}
$("#fdTake").addEventListener("click", () => adjustFound(-1));
$("#fdAdd").addEventListener("click", () => adjustFound(1));
$("#fdClose").addEventListener("click", () => $("#sFound").hidden = true);
$("#fdAgain").addEventListener("click", () => { $("#sFound").hidden = true; openScanner("find"); });
$("#fdEdit").addEventListener("click", () => { const p = S.parts.get(S.foundId); $("#sFound").hidden = true; if (p) openForm(p); });

/* ---------- CSV ---------- */
function parseCSV(text){
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i+1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ""));
}
const ALIAS = { name:"name", part:"name", description:"name", item:"name", category:"category", type:"category",
  spec:"spec", size:"spec", gauge:"spec", awg:"spec", qty:"qty", quantity:"qty", count:"qty", stock:"qty",
  unit:"unit", units:"unit", min:"min_qty", minimum:"min_qty", min_qty:"min_qty", "low stock":"min_qty", reorder:"min_qty", "reorder at":"min_qty",
  location:"location", bin:"location", shelf:"location", "part number":"pn", "part #":"pn", "part no":"pn", pn:"pn", mpn:"pn",
  supplier:"supplier", vendor:"supplier", barcode:"barcode", upc:"barcode", sku:"barcode", notes:"notes", note:"notes", comments:"notes" };
function openImport(){ closeMenu(); $("#fileCsv").value = ""; $("#importMsg").textContent = ""; $("#btnImportGo").disabled = true; S.importRows = []; $("#sImport").hidden = false; }
$("#btnImport").addEventListener("click", openImport);
$("#btnImportCancel").addEventListener("click", () => $("#sImport").hidden = true);
$("#fileCsv").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  const rows = parseCSV(await file.text());
  if (rows.length < 2) { $("#importMsg").textContent = "That file has no data rows under the header."; return; }
  const map = rows[0].map(h => ALIAS[h.trim().toLowerCase()] || null);
  if (!map.includes("name")) { $("#importMsg").textContent = "Couldn't find a “name” column. Add a header row with at least a name column."; return; }
  S.importRows = rows.slice(1).map(r => { const o = {}; map.forEach((k,i) => { if (k) o[k] = (r[i] || "").trim(); }); return o; }).filter(o => o.name)
    .map(o => ({ name:o.name, category:o.category || "Misc", spec:o.spec || "", qty:Math.max(0, num(o.qty)), unit:o.unit || "pcs",
      min_qty:Math.max(0, num(o.min_qty)), location:o.location || "", pn:o.pn || "", supplier:o.supplier || "", barcode:o.barcode || "", notes:o.notes || "", updated_by:S.name }));
  $("#importMsg").textContent = `Found ${S.importRows.length} parts. They'll be added alongside what's already here.`;
  $("#btnImportGo").disabled = !S.importRows.length;
});
$("#btnImportGo").addEventListener("click", async () => {
  const b = $("#btnImportGo"); b.disabled = true; let n = 0;
  for (let i = 0; i < S.importRows.length; i += 200) {
    const chunk = S.importRows.slice(i, i + 200);
    const { data, error } = await S.sb.from("parts").insert(chunk).select();
    if (error) { $("#importMsg").textContent = `Added ${n}, then stopped: ${errText(error)}`; return; }
    data.forEach(p => S.parts.set(p.id, p)); n += data.length; $("#importMsg").textContent = `Adding… ${n}/${S.importRows.length}`;
  }
  render(); ping(null); $("#importMsg").textContent = `Added ${n} parts.`; setTimeout(() => $("#sImport").hidden = true, 900);
});
const csvCell = v => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function download(name, text){
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type:"text/csv" })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function exportCsv(onlyReorder){
  closeMenu();
  let parts = [...S.parts.values()];
  if (onlyReorder) parts = parts.filter(p => level(p) !== "ok");
  if (!parts.length) { toast(onlyReorder ? "Nothing is low or out right now." : "No parts to export yet."); return; }
  const head = ["name","category","spec","qty","unit","min","location","part number","supplier","barcode","notes","status"];
  const lines = [head.join(",")].concat(parts.map(p => [p.name,p.category,p.spec,fmt(effQty(p)),p.unit,fmt(num(p.min_qty)),p.location,p.pn,p.supplier,p.barcode,p.notes,level(p)].map(csvCell).join(",")));
  download(`tmfr-${onlyReorder ? "reorder" : "inventory"}-${new Date().toISOString().slice(0,10)}.csv`, lines.join("\n"));
}
$("#btnExport").addEventListener("click", () => exportCsv(false));
$("#btnReorder").addEventListener("click", () => exportCsv(true));

document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (!$("#sScan").hidden) { stopScanner(); return; }
  closeForm(); ["#sFound","#sLog","#sImport"].forEach(s => $(s).hidden = true); closeMenu();
});

window.__tmfr = { parseEcia, keyFor, parseCSV };
boot();
})();
