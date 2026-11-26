// ERP Dashboard - Cloudflare Worker
// POST /api/login  { id, pass }  ->  ERP-te login -> Company 561 -> Home dashboard numbers (JSON)
// ID/Password kothao save ba log kora hoy na. Shudhu ERP-te login korar jonno use hoy.
// Baki shob request (HTML/CSS/JS) public/ folder theke static asset hishebe serve hoy.

const BASE = "https://e501.sihirbox.com:8071";
const LOGIN = BASE + "/ords/r/rpro/smartqr/login";
const ERP_LOGIN_PATH = "/ords/r/rpro/smartqr/login";
const COMPANY_VALUE = "561";
const COMPANY_NAME = "561-DPL-Local";

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const decode = (s) =>
  String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

const unesc = (t) =>
  t.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, "/");

const attr = (tag, name) => {
  const m = tag.match(new RegExp(name + '="([^"]*)"', "i"));
  return m ? decode(m[1]) : "";
};

const byId = (html, id) => {
  const m = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>', "i"));
  return m ? attr(m[0], "value") : "";
};

const textOf = (html) =>
  decode(
    String(html || "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  ).trim();

const titleOf = (page) => (page.match(/<title>(.*?)<\/title>/is) || [])[1] || null;
const mask = (u) => u.replace(/session=\d+/, "session=***");

function addCookies(jar, res) {
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1);
  }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");

// v13.3: ERP majhe majhe 60s+ jhule thake - 20s-e timeout + 1 bar retry, tarpor porishkar 502
const REQ_TIMEOUT_MS = 20000;
const isTimeout = (e) => e && (e.name === "ERP_TIMEOUT" || e.name === "TimeoutError" || e.name === "AbortError");
const slowJson = () => json({ error: "ERP ekhon khub slow — 1 minute pore abar chesta koro" }, 502);
async function req(url, jar, opts = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        redirect: "manual",
        ...opts,
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0", Cookie: cookieHeader(jar), ...(opts.headers || {}) },
      });
      clearTimeout(timer);
      addCookies(jar, res);
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt === 1) {
        if (isTimeout(e)) { const t = new Error("ERP_TIMEOUT"); t.name = "ERP_TIMEOUT"; throw t; }
        throw e;
      }
    }
  }
  throw lastErr;
}

// redirect (302 ba APEX JSON redirectURL) follow kore final page ene dey
async function follow(res, url, jar, steps) {
  let page = await res.text();
  let hops = 0;
  while (hops < 8) {
    if (res.status >= 300 && res.status < 400) {
      url = new URL(res.headers.get("location"), url).href;
      res = await req(url, jar);
      steps.push({ status: res.status, url: mask(url) });
      page = await res.text();
      hops++;
      continue;
    }
    let jr = null;
    try {
      jr = JSON.parse(page).redirectURL;
    } catch (e) {}
    const m = jr
      ? [null, jr]
      : !/<html/i.test(page)
      ? page.match(
          /(?:window\.location(?:\.href)?\s*=|location\.href\s*=|location\.replace\(|apex\.navigation\.redirect\()\s*["']([^"']+)["']/i
        )
      : null;
    if (!m) break;
    url = new URL(decode(unesc(m[1])), url).href;
    res = await req(url, jar);
    steps.push({ status: res.status, url: mask(url), via: "redirect" });
    page = await res.text();
    hops++;
  }
  return { res, url, page };
}

// page-er form-e data post kore
async function postForm(page, pageUrl, jar, request, items) {
  const body = new URLSearchParams();
  for (const m of page.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = attr(m[0], "name");
    if (name) body.set(name, attr(m[0], "value"));
  }
  body.set("p_request", request);
  for (const [k, v] of Object.entries(items)) body.set(k, v);
  body.set(
    "p_json",
    JSON.stringify({
      pageItems: {
        itemsToSubmit: Object.entries(items).map(([n, v]) => ({ n, v })),
        protected: byId(page, "pPageItemsProtected"),
        rowVersion: "",
        formRegionChecksums: [],
      },
      salt: byId(page, "pSalt"),
    })
  );
  const formTag = (page.match(/<form[^>]*wwvFlowForm[^>]*>/i) || [""])[0];
  const action = attr(formTag, "action") || "wwv_flow.accept";
  const postUrl = new URL(action, BASE + "/ords/").href;
  return req(postUrl, jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Referer: pageUrl },
    body: body.toString(),
  });
}

const toNum = (s) => {
  const n = parseFloat(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

// Home page (ed125) theke KPI + bar chart gulo ber kore.
// Bar-er majhkhane kono heading text thakle seta notun group-er title hishebe dhora hoy.
function parseHome(page) {
  const start = page.indexOf('id="ed125"');
  const html = start >= 0 ? page.slice(start) : page;

  const kpiRe = /<div class="ed-kpi-head"><span>([^<]*)<\/span>[\s\S]*?<strong>([^<]*)<\/strong>/g;
  const kpis = [];
  let kpiEnd = 0;
  for (const m of html.matchAll(kpiRe)) {
    const value = decode(m[2]).trim();
    kpis.push({ label: decode(m[1]).trim(), value, n: toNum(value) });
    kpiEnd = m.index + m[0].length;
  }

  const barRe = /<span title="([^"]*)">[^<]*<\/span><div class="ed-track">[\s\S]*?<b>([^<]*)<\/b>/g;
  const bars = [];
  const groups = [];
  let prevEnd = kpiEnd;
  for (const m of html.matchAll(barRe)) {
    const gap = textOf(html.slice(prevEnd, m.index));
    const onlyNumbers = gap.split(" ").every((w) => /^[\d.,%+\-]*$/.test(w));
    const title = gap && !onlyNumbers && gap.length <= 80 ? gap : "";
    const value = decode(m[2]).trim();
    const bar = { label: decode(m[1]).trim(), value, n: toNum(value) };
    bars.push(bar);
    if (title || !groups.length) groups.push({ title, bars: [] });
    groups[groups.length - 1].bars.push(bar);
    prevEnd = m.index + m[0].length;
  }

  const items = {};
  for (const m of page.matchAll(/<input[^>]*name="(P125_[A-Z_]+)"[^>]*>/gi)) items[attr(m[0], "name")] = attr(m[0], "value");

  return { kpis, bars, groups, items };
}

// ERP-te login + company select kore Home page ene dey
async function erpSignIn(id, pass) {
  const jar = {};
  const steps = [];
  const r1 = await req(LOGIN, jar);
  const loginHtml = await r1.text();
  let res = await postForm(loginHtml, LOGIN, jar, "LOGIN", {
    P9999_USERNAME: id,
    P9999_PASSWORD: pass,
    P9999_REMEMBER: "N",
  });
  steps.push({ step: "login", status: res.status });
  let f = await follow(res, LOGIN, jar, steps);
  let title = titleOf(f.page);
  if (title === "Company") {
    res = await postForm(f.page, f.url, jar, "Continue", { P212_SELECT_COMP: COMPANY_VALUE });
    steps.push({ step: "company", status: res.status });
    f = await follow(res, f.url, jar, steps);
    title = titleOf(f.page);
  }
  return { f, jar, steps, title };
}

// login fail hole error response banay (null = dashboard pawa gese)
function signInFailure({ f, title, steps }) {
  if (/<div id="ed125"/.test(f.page)) return null;
  const a = f.page.match(/<[^>]*id="t_Alert_Notification"[\s\S]{0,1500}/i);
  // v13.3: alert-er bhetore HTML-er tukro thakle muche felo, shudhu lekha rakho
  const alertText = a ? textOf(a[0]).replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 120) : "";
  if (/P9999_PASSWORD/.test(f.page)) {
    if (/invalid login/i.test(alertText)) return json({ error: "ID ba Password thik nai — 5 second opekkha kore abar chesta koro" }, 401);
    return json({ error: alertText || "ID ba Password thik nai" }, 401);
  }
  return json({ error: "Dashboard pawa jay nai" + (alertText ? ": " + alertText : ""), debug: { title, steps } }, 502);
}

async function readCreds(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return { err: json({ error: "Invalid request" }, 400) };
  }
  const id = String((body && body.id) || "").trim();
  const pass = String((body && body.pass) || "");
  if (!id || !pass) return { err: json({ error: "ID ar Password dao" }, 400) };
  if (id.length > 60 || pass.length > 200) return { err: json({ error: "ID/Password onek boro" }, 400) };
  return { id, pass, body };
}

// ---------- v14: login rate-limit (KV LAYOUT thakle; na thakle kichu kore na) ----------
const RL_WINDOW = 600, RL_MAX_ID = 6, RL_MAX_IP = 20;
async function rlGet(env, key) {
  try { if (!env || !env.LAYOUT) return 0; return parseInt(await env.LAYOUT.get(key), 10) || 0; } catch (e) { return 0; }
}
async function rlBump(env, key) {
  try { if (!env || !env.LAYOUT) return; const n = await rlGet(env, key); await env.LAYOUT.put(key, String(n + 1), { expirationTtl: RL_WINDOW }); } catch (e) {}
}

// browser-er cookie -> ERP cookie jar (admin cookie ERP-te jay na)
function jarFromRequest(request) {
  const jar = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) { const k = part.slice(0, i).trim(); if (k && k !== ADMIN_COOKIE) jar[k] = part.slice(i + 1).trim(); }
  }
  return jar;
}

// ---------- v17: KPI history on the server (KV) - same on all devices; no password needed ----------
// On every successful Login/Refresh, today's KPI numbers go into KV (by Dhaka date). Only label + number, nothing else from the ERP.
// Optional Cron: if the Cloudflare Secrets CRON_ERP_ID + CRON_ERP_PASS are set, it logs in once a day by itself and collects the numbers (does nothing if not set).
const KPI_KEY = "kpi-hist";
const KPI_DAYS = 45;
function dhakaDay(d) {
  const t = new Date((d ? d.getTime() : Date.now()) + 6 * 3600 * 1000);
  return t.getUTCFullYear() + String(t.getUTCMonth() + 1).padStart(2, "0") + String(t.getUTCDate()).padStart(2, "0");
}
async function readKpiHist(env) {
  try {
    if (!env || !env.LAYOUT) return {};
    const h = await env.LAYOUT.get(KPI_KEY, "json");
    return h && typeof h === "object" && !Array.isArray(h) ? h : {};
  } catch (e) {
    return {};
  }
}
// kpis = parseHome().kpis; returns the whole updated history ({YYYYMMDD:{label:n}}). On any error returns {} - the site never breaks.
async function recordKpi(env, kpis) {
  try {
    if (!env || !env.LAYOUT) return {};
    const hist = await readKpiHist(env);
    const day = dhakaDay();
    const rec = {};
    for (const k of kpis || []) {
      const label = String((k && k.label) || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (label && typeof k.n === "number" && isFinite(k.n)) rec[label] = k.n;
    }
    if (Object.keys(rec).length) {
      hist[day] = Object.assign(hist[day] || {}, rec);
      const keys = Object.keys(hist).sort();
      while (keys.length > KPI_DAYS) delete hist[keys.shift()];
      await env.LAYOUT.put(KPI_KEY, JSON.stringify(hist));
    }
    return hist;
  } catch (e) {
    return {};
  }
}
async function cronKpi(env) {
  if (!env || !env.CRON_ERP_ID || !env.CRON_ERP_PASS || !env.LAYOUT) return;
  try {
    const s = await erpSignIn(String(env.CRON_ERP_ID), String(env.CRON_ERP_PASS));
    if (signInFailure(s)) return;
    await recordKpi(env, parseHome(s.f.page).kpis);
  } catch (e) {}
}

// v14: Refresh - password chhara, browser-er ERP session cookie diye Home dashboard ene dey
async function handleHome(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid request" }, 400); }
  const u = String((body && body.url) || "").split("#")[0];
  if (!/^\/erp\/ords\/[^\s"'<>\\]{1,800}$/.test(u)) return json({ error: "Invalid url" }, 400);
  const target = BASE + u.slice(4);
  try { if (new URL(target).origin !== BASE) return json({ error: "Invalid url" }, 400); } catch (e) { return json({ error: "Invalid url" }, 400); }
  const jar = jarFromRequest(request);
  const relogin = () => json({ error: "Session sesh hoye geche — abar login koro", relogin: true }, 401);
  if (!Object.keys(jar).length) return relogin();
  try {
    const res = await req(target, jar);
    const f = await follow(res, target, jar, []);
    if (!/<div id="ed125"/.test(f.page)) return relogin();
    const home = parseHome(f.page);
    const hist = await recordKpi(env, home.kpis);
    await touchLiveSeen(env, request, u);
    return json({ ok: true, fetchedAt: new Date().toISOString(), kpis: home.kpis, bars: home.bars, groups: home.groups, hist, erpUrl: toProxyPath(f.url) });
  } catch (e) {
    if (isTimeout(e)) return slowJson();
    return json({ error: "ERP server-e connect kora jay nai, abar chesta koro" }, 502);
  }
}

async function handleLogin(request, env) {
  const c = await readCreds(request);
  if (c.err) return c.err;
  const ip = request.headers.get("cf-connecting-ip") || "";
  const kId = "rl:id:" + encodeURIComponent(c.id.toLowerCase());
  const kIp = "rl:ip:" + ip;
  const nId = await rlGet(env, kId);
  const nIp = ip ? await rlGet(env, kIp) : 0;
  if (nId >= RL_MAX_ID || nIp >= RL_MAX_IP) return json({ error: "Onek bar bhul hoyeche — 10 minute opekkha kore abar chesta koro" }, 429);
  try {
    const s = await erpSignIn(c.id, c.pass);
    const fail = signInFailure(s);
    if (fail) {
      if (fail.status === 401) { await rlBump(env, kId); if (ip) await rlBump(env, kIp); }
      return fail;
    }
    if (nId > 0) { try { await env.LAYOUT.delete(kId); } catch (e) {} }
    const home = parseHome(s.f.page);
    const hist = await recordKpi(env, home.kpis);
    // v10: dashboard-er sathe asol ERP-r session-er thikana + cookie-o browser-ke di - "Asol ERP khulo" bati chaple browser sorasori asol ERP-te dhukbe.
    const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    // purono (Path=/erp/...) cookie-gulo muche dao - noile duto cookie ek sathe jay ar ERP purono session pore
    const names = new Set(Object.keys(s.jar));
    for (const part of (request.headers.get("cookie") || "").split(";")) { const n = part.split("=")[0].trim(); if (n) names.add(n); }
    for (const n of names) for (const p of ["/erp", "/erp/", "/erp/ords", "/erp/ords/", "/erp/ords/r/", "/erp/ords/r/rpro/", "/erp/ords/r/rpro/smartqr/", "/ords", "/ords/", "/ords/r/", "/ords/r/rpro/", "/ords/r/rpro/smartqr/"]) {
      h.append("set-cookie", n + "=; Path=" + p + "; Max-Age=0; Secure; SameSite=Lax");
    }
    for (const [k, v] of Object.entries(s.jar)) {
      h.append("set-cookie", k + "=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax");
      // v21: 7 din - browser bondho kore fire asleo session thakbe
      h.append("set-cookie", k + "=" + String(v).replace(/;/g, "") + "; Path=/; HttpOnly; Max-Age=604800; " + CK_SET);
    }
    // v13: Admin cookie - shudhu ERP-te sotti login hole + ID ADMIN_IDS-e thakle. Onno jeikono ID-te admin cookie muche jay.
    let adminWarn = "";
    const admCookie = adminIds(env).includes(c.id) ? await makeAdminCookie(env, c.id) : null;
    if (admCookie) { h.append("set-cookie", ADMIN_COOKIE + "=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"); h.append("set-cookie", ADMIN_COOKIE + "=" + admCookie + "; Path=/; Max-Age=" + ADMIN_TTL + "; HttpOnly; " + CK_SET); }
    else {
      ckClear(h, ADMIN_COOKIE, true);
      if (adminIds(env).includes(c.id)) adminWarn = "Admin ID, kintu Cloudflare-e ADMIN_SECRET set kora nai - tai Edit layout bati asbe na.";
    }
    return new Response(
      JSON.stringify({
        ok: true,
        adminWarn,
        user: c.id.toUpperCase(),
        company: COMPANY_NAME,
        fetchedAt: new Date().toISOString(),
        kpis: home.kpis,
        bars: home.bars,
        groups: home.groups,
        hist,
        erpUrl: toProxyPath(s.f.url),
        erpLogin: "/erp" + ERP_LOGIN_PATH,
        pages: menuPages(extractNav(s.f.page, s.f.url), s.f.url).map((p) => ({ text: p.text, url: toProxyPath(p.abs) })),
      }),
      { status: 200, headers: h }
    );
  } catch (e) {
    if (isTimeout(e)) return slowJson();
    return json({ error: "ERP server-e connect kora jay nai, abar chesta koro" }, 502);
  }
}

// ---------- PROBE (ERP-r menu ar page-er structure dekhar tool; shudhu pora, kichu likhe na) ----------
const maskAll = (s) => s.replace(/session=\d+/g, "session=***").replace(/([?&]cs=)[^&"'\s\\]+/g, "$1***");

function extractNav(page, baseUrl) {
  const links = [];
  const seen = new Set();
  for (const m of page.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[1], "href");
    const text = textOf(m[2]).slice(0, 80);
    if (!href || !text || /^(#|javascript:)/i.test(href)) continue;
    let abs;
    try {
      abs = new URL(href, baseUrl).href;
    } catch (e) {
      continue;
    }
    if (!abs.startsWith(BASE)) continue;
    const k = text + "|" + abs;
    if (seen.has(k)) continue;
    seen.add(k);
    links.push({ text, abs });
  }
  // JS-te thaka menu JSON ({label, link/href/url})
  const jsonItems = [];
  for (const sm of page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const om of sm[1].matchAll(/\{[^{}]*"label"\s*:[^{}]*\}/g)) {
      try {
        const o = JSON.parse(om[0].replace(/\\u0026/g, "&"));
        const link = o.link || o.href || o.url;
        if (o.label && link && !/^(#|javascript:)/i.test(link)) jsonItems.push({ text: String(o.label).slice(0, 80), abs: new URL(link, baseUrl).href });
      } catch (e) {}
    }
  }
  for (const it of jsonItems) {
    const k = it.text + "|" + it.abs;
    if (!seen.has(k) && it.abs.startsWith(BASE)) { seen.add(k); links.push(it); }
  }
  return links.slice(0, 250);
}

// ---------- PAGE SCAN v2 (shudhu pora; page-er filter, button, table ar "Show" er JS compact kore dey) ----------
const flat = (s) => String(s).replace(/\s+/g, " ");
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "..." : s);
const attrx = (tag, n) => {
  const m = String(tag).match(new RegExp("(?:^|\\s)" + n + '="([^"]*)"', "i"));
  return m ? decode(m[1]) : "";
};

// page-er form-er shob field-er current value (browser jemon submit korto)
function collectForm(page) {
  const out = [];
  for (const m of page.matchAll(/<input\b[^>]*>/gi)) {
    const name = attrx(m[0], "name");
    if (!name) continue;
    const type = (attrx(m[0], "type") || "text").toLowerCase();
    if (/^(button|submit|image|file|reset)$/.test(type)) continue;
    if ((type === "checkbox" || type === "radio") && !/\schecked\b/i.test(m[0])) continue;
    out.push({ name, type, value: attrx(m[0], "value") });
  }
  for (const m of page.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attrx(m[1], "name");
    if (!name) continue;
    const opts = [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
    const sel = opts.find((o) => /\sselected\b/i.test(o[1])) || opts[0];
    out.push({ name, type: "select", value: sel ? attrx(sel[1], "value") : "" });
  }
  for (const m of page.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const name = attrx(m[1], "name");
    if (name) out.push({ name, type: "textarea", value: decode(m[2]) });
  }
  return out;
}

function listItems(page, fields) {
  const lovs = {};
  for (const m of page.matchAll(/apex\.widget\.popupLov\(\{"itemId":"([A-Z0-9_]+)","ajaxIdentifier":"([^"]+)"/g)) lovs[m[1]] = m[2];
  const names = [...new Set([...page.matchAll(/\bid="(P\d+_[A-Z0-9_]+)_CONTAINER"/g)].map((m) => m[1]))];
  return names.map((n) => {
    const ci = page.indexOf('id="' + n + '_CONTAINER"');
    const tag = page.slice(page.lastIndexOf("<", ci), page.indexOf(">", ci) + 1);
    const kind = [...attrx(tag, "class").matchAll(/apex-item-wrapper--([a-z-]+)/g)]
      .map((x) => x[1])
      .filter((x) => !/^(has-|required|stacked)/.test(x))
      .join(",");
    const lm = page.match(new RegExp('id="' + n + '_LABEL"[^>]*>([\\s\\S]*?)</(?:label|span)>', "i"));
    const f = fields.find((x) => x.name === n);
    const it = { name: n, label: lm ? textOf(lm[1]) : "", kind, value: f ? f.value : "" };
    const sm = page.match(new RegExp('<select\\b[^>]*\\bid="' + n + '"[^>]*>([\\s\\S]*?)</select>', "i"));
    if (sm) {
      const opts = [...sm[1].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
      it.optionCount = opts.length;
      it.options = opts.slice(0, 12).map((o) => attrx(o[1], "value") + "=" + clip(textOf(o[2]), 30));
    } else {
      const tm = page.match(new RegExp('<input\\b[^>]*\\bid="' + n + '"[^>]*>', "i"));
      if (tm) it.display = attrx(tm[0], "value");
    }
    if (lovs[n]) it.lovAjax = lovs[n];
    return it;
  });
}

function listButtons(page) {
  const out = [];
  for (const m of page.matchAll(/<(button|a)\b([^>]*\bclass="[^"]*t-Button[^"]*"[^>]*)>([\s\S]*?)<\/\1>/gi)) {
    if (/t-Button--(navBar|header)/.test(m[2])) continue;
    const b = { id: attrx(m[2], "id"), label: attrx(m[2], "data-otel-label"), name: attrx(m[2], "name"), text: textOf(m[3]).slice(0, 40) };
    if (b.id || b.label || b.text) out.push(b);
  }
  return out.slice(0, 20);
}

function listTables(page) {
  const out = [];
  for (const m of page.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
    const trs = [...m[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    const data = trs.filter((tr) => /<td\b/i.test(tr[1]));
    if (!data.length) continue;
    const cells = (tr) => [...tr[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => clip(textOf(c[1]), 28));
    const head = trs.find((tr) => /<th\b/i.test(tr[1]));
    out.push({ cls: clip(attrx(m[1], "class"), 50), headers: head ? cells(head) : [], rows: data.length, sample: data.slice(0, 2).map(cells) });
  }
  return out.slice(0, 8);
}

const paginationOf = (page) => {
  const m = page.match(/a-IRR-pagination-label[^>]*>([^<]*)</i) || page.match(/(\d[\d,]*\s*-\s*\d[\d,]*\s+of\s+[\d,]+\+?)/i);
  return m ? decode(m[1]).trim() : "";
};

// ---------- v9: IR full-row fetch (50 -> sob sari, jemon 1,511) ----------
// Keno 50 ashe: IR-er ek pata = 50 sari (p_widget_num_return = currentRowsPerPage).
// Tai 3 ta upay ek ek kore chesta kori, jetai kaj kore setai nibo:
//  1) IR AJAX-e boro num_return (2000) chaowa - ekbare sob sari.
//  2) Pata dhore dhore ana (pgR_min_row=51, 101, ...) - purono APEX niyom.
//  3) IR CSV download - download-e sob sari thake.
// Kono upay-i ERP-te kichu lekhe na, shudhu pore (view-only).
const IR_MAX_ROWS = 2000;
const IR_PAGE_SIZE = 50;

function parsePaginationTotal(page) {
  const label = paginationOf(page);
  const m = label.match(/(\d[\d,]*)\s*-\s*(\d[\d,]*)\s+of\s+([\d,]+)/i);
  if (!m) return null;
  return { from: +m[1].replace(/,/g, ""), to: +m[2].replace(/,/g, ""), total: +m[3].replace(/,/g, "") };
}

function parseIrConfig(page) {
  let ajax = null;
  const m1 = page.match(/interactiveReport\(\{[\s\S]{0,3000}?"ajaxIdentifier"\s*:\s*"([^"]+)"/i);
  if (m1) ajax = unesc(m1[1]);
  else { const m2 = page.match(/"ajaxIdentifier"\s*:\s*"([^"]+)"/); if (m2) ajax = unesc(m2[1]); }
  let ws = null;
  const w1 = page.match(/p_worksheet_id=(\d+)/);
  if (w1) ws = w1[1];
  else { const w2 = page.match(/worksheetId["']?\s*[:=]\s*"?(\d+)/i); if (w2) ws = w2[1]; }
  let rep = null;
  const r1 = page.match(/"reportId"\s*:\s*"?(\d+)/);
  if (r1) rep = r1[1];
  let region = null;
  const rg = page.match(/"regionId"\s*:\s*"([^"]+)"/);
  if (rg) region = rg[1];
  let maxR = null;
  const mx = page.match(/"maxRowCount"\s*:\s*"(\d+)"/);
  if (mx) maxR = +mx[1];
  return { ajaxIdentifier: ajax, worksheetId: ws, reportId: rep, regionId: region, maxRowCount: maxR };
}

const dedupeRows = (rows) => {
  const seen = new Set(), out = [];
  for (const r of rows) { const k = r.join(""); if (!seen.has(k)) { seen.add(k); out.push(r); } }
  return out;
};

function parseCsvRows(text) {
  const lines = String(text || "").split(/\r\n|\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return null;
  const parseLine = (line) => {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.trim());
  if (headers.length < 2) return null;
  const rows = lines.slice(1).map(parseLine).filter((r) => r.length >= 2 && r.some((c) => String(c).trim() !== ""));
  return rows.length ? { headers, rows } : null;
}

async function irAjaxFetch(jar, pageUrl, pageHtml, fields, numReturn, mod, action) {
  const cfg = parseIrConfig(pageHtml);
  if (!cfg.ajaxIdentifier || !cfg.worksheetId) return { ok: false, reason: "no-ir-config", cfg, raw: "" };
  const sys = (n) => (fields.find((f) => f.name === n) || {}).value || "";
  const items = [...new Set(fields.map((f) => f.name).filter((n) => /^P\d+_/.test(n)))];
  const body = new URLSearchParams();
  for (const n of ["p_flow_id", "p_flow_step_id", "p_instance"]) body.set(n, sys(n));
  body.set("p_debug", "");
  body.set("p_request", "PLUGIN=" + unesc(cfg.ajaxIdentifier));
  body.set("p_widget_name", "worksheet");
  body.set("p_widget_mod", mod);
  body.set("p_widget_action", action);
  body.set("p_widget_num_return", String(numReturn));
  body.set("x01", cfg.worksheetId);
  if (cfg.reportId) body.set("x02", cfg.reportId);
  body.set("x11", "1");
  body.set("pageItems", items.join(","));
  body.set("p_json", JSON.stringify({
    pageItems: { itemsToSubmit: items.map((n) => ({ n, v: sys(n) })), protected: byId(pageHtml, "pPageItemsProtected"), rowVersion: "", formRegionChecksums: [] },
    salt: byId(pageHtml, "pSalt"),
  }));
  let res, text = "";
  try {
    res = await req(new URL("wwv_flow.ajax", BASE + "/ords/").href, jar, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", Referer: pageUrl },
      body: body.toString(),
    });
    text = await res.text();
  } catch (e) { return { ok: false, reason: "fetch-failed", cfg, raw: "" }; }
  const table = readTable(text);
  const csv = table ? null : parseCsvRows(text);
  return { ok: true, status: res.status, cfg, table, csv, raw: text, rawLen: text.length, pag: paginationOf(text), total: parsePaginationTotal(text) };
}

// Show-er porer page theke IR-er sob sari ana. Prothom patar table + moat
// (pagination label, jemon "1 - 50 of 1,511") theke shuru kore.
async function fetchIrAll(jar, pageUrl, shownPage, fields) {
  const tries = [];
  let first = readTable(shownPage);
  let rows = first ? first.rows.slice() : [];
  let headers = first ? first.headers : [];
  const totalInfo = parsePaginationTotal(shownPage);
  let total = totalInfo ? totalInfo.total : (first ? first.total : 0);
  const cfg = parseIrConfig(shownPage);
  // Upay 1 + 3: IR AJAX - boro num_return, tarpor CSV download
  if (cfg.ajaxIdentifier && cfg.worksheetId) {
    const want = total && total > IR_PAGE_SIZE ? Math.min(total, IR_MAX_ROWS) : IR_MAX_ROWS;
    for (const [mod, action] of [["ACTION", "PULL"], ["PULL", "PULL"]]) {
      try {
        const r = await irAjaxFetch(jar, pageUrl, shownPage, fields, want, mod, action);
        const got = r.table ? r.table.rows.length : (r.csv ? r.csv.rows.length : 0);
        tries.push({ method: "ir-ajax-" + mod + "-" + action, want, status: r.status || 0, got, rawLen: r.rawLen || 0, reason: r.reason || "" });
        if (r.table && r.table.rows.length > rows.length) {
          rows = dedupeRows(r.table.rows);
          headers = r.table.headers.length ? r.table.headers : headers;
          if (r.total) total = r.total.total;
        } else if (r.csv && r.csv.rows.length > rows.length) {
          rows = dedupeRows(r.csv.rows);
          headers = r.csv.headers.length ? r.csv.headers : headers;
        }
        if (rows.length > IR_PAGE_SIZE) break;
        if (total && rows.length >= total) break;
      } catch (e) { tries.push({ method: "ir-ajax-" + mod + "-" + action, want, got: 0, reason: String((e && e.message) || e) }); }
    }
    if ((!total || rows.length < total) && rows.length <= IR_PAGE_SIZE) {
      try {
        const r = await irAjaxFetch(jar, pageUrl, shownPage, fields, want, "ACTION", "DOWNLOAD");
        const csv = r.csv || parseCsvRows(r.raw || "");
        const got = csv ? csv.rows.length : (r.table ? r.table.rows.length : 0);
        tries.push({ method: "ir-csv-download", want, status: r.status || 0, got, rawLen: r.rawLen || 0, reason: r.reason || "" });
        if (csv && csv.rows.length > rows.length) {
          rows = dedupeRows(csv.rows);
          headers = csv.headers.length ? csv.headers : headers;
        } else if (r.table && r.table.rows.length > rows.length) {
          rows = dedupeRows(r.table.rows);
          headers = r.table.headers.length ? r.table.headers : headers;
        }
      } catch (e) { tries.push({ method: "ir-csv-download", got: 0, reason: String((e && e.message) || e) }); }
    }
  } else {
    tries.push({ method: "ir-ajax", want: 0, got: 0, reason: "no-ir-config" });
  }
  // Upay 2: pata dhore dhore ana (pgR_min_row=51, 101, ...) - shudhu tokhon,
  // jokhon AJAX-e baki sari aseni ar prothom patay 50 sari chilo.
  if ((!total || rows.length < total) && rows.length >= IR_PAGE_SIZE) {
    let minRow = IR_PAGE_SIZE + 1, guard = 0;
    while (guard < 30 && (!total || rows.length < total)) {
      guard++;
      let pgText = "";
      try {
        const u = new URL(pageUrl);
        u.searchParams.set("pgR_min_row", String(minRow));
        u.searchParams.set("max_rows", String(IR_PAGE_SIZE));
        u.searchParams.set("rows_fetched", String(IR_PAGE_SIZE));
        const rr = await req(u.href, jar);
        pgText = await rr.text();
      } catch (e) { tries.push({ method: "page-link", minRow, got: 0, reason: String((e && e.message) || e) }); break; }
      const t = readTable(pgText);
      const got = t ? t.rows.length : 0;
      tries.push({ method: "page-link", minRow, got });
      if (!t || got === 0) break;
      const before = rows.length;
      rows = dedupeRows(rows.concat(t.rows));
      if (rows.length === before) break;
      headers = t.headers.length ? t.headers : headers;
      minRow += IR_PAGE_SIZE;
      if (got < IR_PAGE_SIZE) break;
    }
  }
  const method = rows.length > IR_PAGE_SIZE ? (tries.find((t) => t.got > IR_PAGE_SIZE) || {}).method || "ir-ajax" : (total && rows.length >= total ? "first-page" : "first-page-only");
  return { headers, rows, total: total || rows.length, totalRows: total || rows.length, pagination: first ? first.pagination : "", method, tries };
}

const alertOf = (page) => {
  const a = page.match(/<[^>]*id="t_Alert_Notification"[\s\S]{0,1500}/i) || page.match(/<[^>]*class="[^"]*t-Alert[^"]*"[\s\S]{0,1200}/i);
  return a ? textOf(a[0]).slice(0, 200) : "";
};

// page-er inline JS theke: button-er click ki kore, apex.submit / ajax / refresh kothay
function codeHints(page, buttons) {
  const scripts = [...page.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => flat(m[1])).filter((s) => s.length > 20);
  const pats = [];
  for (const b of buttons) if (b.id) pats.push([new RegExp(b.id, "g"), "button " + b.id, 500, 700]);
  pats.push([/apex\.submit\(/g, "apex.submit", 250, 350], [/apex\.server\.process\(/g, "server.process", 250, 450], [/\.refresh\(/g, "refresh", 250, 250], [/\bfetch\(/g, "fetch", 250, 450], [/\.ajax\(/g, "ajax", 250, 450]);
  const hits = [];
  const seen = new Set();
  let total = 0;
  for (const [re, why, before, after] of pats) {
    scripts.forEach((js, si) => {
      for (const m of js.matchAll(re)) {
        const key = si + ":" + Math.floor(m.index / 600);
        if (seen.has(key) || total > 9000) continue;
        seen.add(key);
        const code = js.slice(Math.max(0, m.index - before), m.index + after);
        total += code.length;
        hits.push({ why, code });
      }
    });
  }
  if (!hits.length && scripts.length) {
    const longest = scripts.reduce((a, b) => (b.length > a.length ? b : a));
    hits.push({ why: "tail of longest script", code: longest.slice(-3500) });
  }
  return hits.slice(0, 12);
}

function scanPage(page) {
  const fields = collectForm(page);
  const buttons = listButtons(page);
  return {
    title: titleOf(page),
    items: listItems(page, fields),
    buttons,
    tables: listTables(page),
    pagination: paginationOf(page),
    alert: alertOf(page),
    code: codeHints(page, buttons),
  };
}

// browser-er moto page submit kore (p_request = button-er request name) -> final page
async function submitPage(page, pageUrl, jar, request, overrides) {
  const fields = collectForm(page);
  const body = new URLSearchParams();
  for (const f of fields) body.append(f.name, f.value);
  body.set("p_request", request);
  for (const [k, v] of Object.entries(overrides || {})) body.set(k, v);
  const items = [...new Set(fields.map((f) => f.name).filter((n) => /^P\d+_/.test(n)))];
  body.set(
    "p_json",
    JSON.stringify({
      pageItems: {
        itemsToSubmit: items.map((n) => ({ n, v: body.get(n) || "" })),
        protected: byId(page, "pPageItemsProtected"),
        rowVersion: "",
        formRegionChecksums: [],
      },
      salt: byId(page, "pSalt"),
    })
  );
  const formTag = (page.match(/<form[^>]*wwvFlowForm[^>]*>/i) || [""])[0];
  const action = attrx(formTag, "action") || "wwv_flow.accept";
  return req(new URL(action, BASE + "/ords/").href, jar, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Referer: pageUrl },
    body: body.toString(),
  });
}

// "Show" chaple ki hoy tar dry-run: page fresh load kore, request-name ek ek kore chesta kore
async function tryShow(url, jar, scan, overrides, steps) {
  const b = scan.buttons.find((x) => /^(show|search|go|view|run|submit)$/i.test(x.text)) || scan.buttons.find((x) => /show|search/i.test(x.text)) || {};
  const cands = [...new Set([b.name, b.label, b.label && b.label.toUpperCase(), b.text && b.text.toUpperCase(), "SHOW"].filter(Boolean))].slice(0, 3);
  const results = [];
  for (const cand of cands) {
    const g = await follow(await req(url, jar), url, jar, steps);
    const res = await submitPage(g.page, g.url, jar, cand, overrides);
    const f = await follow(res, g.url, jar, []);
    results.push({ request: cand, status: res.status, final: mask(f.url), title: titleOf(f.page), alert: alertOf(f.page), pagination: paginationOf(f.page), tables: listTables(f.page).slice(0, 4) });
  }
  return { button: b, tried: results };
}

// popup LOV (jemon Org dropdown)-er option list ana-r dry-run: kichu variant chesta kore, raw response-er shuru dekhay
// v9.1: age protita variant-er body 700 okkhore kata hoto, tai 66 Org-er talikay MG7 (M-er dike) kokhono dekha jeto na.
// Ekhon E/F variant-er puro value list (display + songkhar ID) parse kore pathano hoy, jate probe-e khuje tap kora jay.
async function tryLov(page, pageUrl, jar, item, searchTerm) {
  const fields = collectForm(page);
  const sys = (n) => (fields.find((f) => f.name === n) || {}).value || "";
  const items = [...new Set(fields.map((f) => f.name).filter((n) => /^P\d+_/.test(n)))];
  const out = [];
  const variants = [
    ["A-x01empty", { x01: "" }],
    ["B-num100", { x01: "", p_widget_num_return: "100" }],
    ["C-search", { p_widget_action: "search", x01: "", p_widget_num_return: "100" }],
    ["D-FIRST_ROWSET", { x01: "FIRST_ROWSET", p_widget_num_return: "100" }],
    ["E-regions", { __regions: { version: 1, firstRow: 1, maxRows: 300 } }],
    ["F-regions-search", { __regions: { version: 1, firstRow: 1, maxRows: 300, search: searchTerm || "MG" } }],
  ];
  for (const [variant, extra] of variants) {
    const body = new URLSearchParams();
    for (const n of ["p_flow_id", "p_flow_step_id", "p_instance"]) body.set(n, sys(n));
    body.set("p_debug", "");
    body.set("p_request", "PLUGIN=" + unesc(item.lovAjax));
    body.set("p_widget_name", "popup_lov");
    const regions = extra.__regions;
    for (const [k, v] of Object.entries(extra)) if (k !== "__regions") body.set(k, v);
    body.set(
      "p_json",
      JSON.stringify({
        ...(regions ? { regions: [{ fetchData: regions }] } : {}),
        pageItems: { itemsToSubmit: items.map((n) => ({ n, v: (fields.find((f) => f.name === n) || {}).value || "" })), protected: byId(page, "pPageItemsProtected"), rowVersion: "", formRegionChecksums: [] },
        salt: byId(page, "pSalt"),
      })
    );
    const res = await req(new URL("wwv_flow.ajax", BASE + "/ords/").href, jar, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", Referer: pageUrl },
      body: body.toString(),
    });
    const txt = (await res.text()).replace(/\s+/g, " ");
    const vals = parseLovValues(txt);
    out.push({ item: item.name, variant, status: res.status, body: clip(txt, 700), count: vals.length, values: vals.slice(0, 300) });
  }
  return out;
}

// ERP-r nijer JS file theke popup-LOV (dropdown list) data kibhabe ane seta dekhay
async function readJs(page, pageUrl, jar) {
  const abs = (s) => { try { return new URL(decode(s), pageUrl).href; } catch (e) { return ""; } };
  const srcs = [...new Set([...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => abs(m[1])))].filter((u) => u.startsWith(BASE) && /\.js(\?|$)/.test(u));
  const ver = ((srcs.find((u) => /desktop_all/.test(u)) || "").match(/\?.*$/) || [""])[0];
  const get = async (u) => { try { const r = await req(u, jar); return r.status === 200 ? await r.text() : ""; } catch (e) { return ""; } };
  const ctx = (txt, tok, n, before, after) => {
    const out = [];
    let from = 0;
    while (out.length < n) {
      const i = txt.indexOf(tok, from);
      if (i < 0) break;
      out.push(txt.slice(Math.max(0, i - before), i + after));
      from = i + after;
    }
    return out;
  };
  const base = BASE + "/i/libraries/apex/minified/";
  const lov = await get(base + "widget.popupLov.min.js" + ver);
  const all = await get(base + "desktop_all.min.js" + ver);
  return {
    popupLovFile: lov,
    plugin: ctx(all, "PLUGIN=", 3, 700, 900),
    fetchData: ctx(all, "fetchData", 4, 300, 700).filter((s) => /plugin\(|ajaxIdentifier|regions/.test(s)),
  };
}

// IR (report table) pagination protocol: JS-er p_widget_action ar page-er IR config dekhay
async function readIr(url, jar, page, ov, steps) {
  const abs = (u) => { try { return new URL(decode(u), url).href; } catch (e) { return ""; } };
  const srcs = [...new Set([...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => abs(m[1])))];
  const ver = ((srcs.find((u) => /desktop_all/.test(u)) || "").match(/\?.*$/) || [""])[0];
  const b = BASE + "/i/libraries/apex/minified/";
  const get = async (u) => { try { const r = await req(u, jar); return r.status === 200 ? await r.text() : ""; } catch (e) { return ""; } };
  const js = await get(b + "widget.interactiveReport.min.js" + ver);
  const ctx = (txt, re, n, bef, aft) => { const o = []; let last = -1e9; for (const m of txt.matchAll(re)) { if (m.index - last < aft) continue; last = m.index; o.push(txt.slice(Math.max(0, m.index - bef), m.index + aft)); if (o.length >= n) break; } return o; };
  const g = await follow(await req(url, jar), url, jar, steps);
  const r = await submitPage(g.page, g.url, jar, "Show", ov);
  const f = await follow(r, g.url, jar, []);
  const shown = f.page;
  return {
    jsLen: js.length,
    actions: ctx(js, /p_widget_action/g, 6, 200, 350),
    pagin: ctx(js, /pgR_min_row|max_rows|rows_fetched/g, 4, 200, 350),
    rowsSel: ctx(js, /SET_ROWS|rows_per_page|ROWS|CONTROL/g, 4, 150, 300),
    csv: ctx(js, /CSV|download/gi, 3, 150, 300),
    irConfig: ctx(shown, /interactiveReport|a-IRR-pagination|ajaxIdentifier/g, 4, 300, 500).map((x) => flat(x)),
    pag: paginationOf(shown),
    pagTotal: parsePaginationTotal(shown),
    irCfg: parseIrConfig(shown),
  };
}

async function handleProbe(request) {
  const c = await readCreds(request);
  if (c.err) return c.err;
  try {
    const s = await erpSignIn(c.id, c.pass);
    const fail = signInFailure(s);
    if (fail) return fail;
    const send = (o) => new Response(maskAll(JSON.stringify(o)), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    const links = extractNav(s.f.page, s.f.url);
    const pick = c.body.pick;
    if (pick === undefined || pick === null || pick === "") {
      return send({ ok: true, at: "menu", menu: links.map((l, i) => ({ i, text: l.text, href: l.abs.replace(BASE, "") })) });
    }
    let it = { text: "home", abs: s.f.url };
    let page = s.f.page, url = s.f.url;
    if (pick !== "home" && pick !== "deep") {
      it = links[+pick];
      if (!it) return json({ error: "Oi number-er menu nei" }, 404);
      const g = await follow(await req(it.abs, s.jar), it.abs, s.jar, s.steps);
      page = g.page; url = g.url;
    }
    const scan = scanPage(page);
    const out = { ok: true, at: it.text };
    if (!c.body.show && !c.body.lov && !c.body.js && !c.body.ir) out.scan = scan;
    if (c.body.show) {
      const ov = {};
      for (const [k, v] of Object.entries(c.body.items || {})) if (/^P\d+_[A-Z0-9_]+$/.test(k)) ov[k] = String(v).slice(0, 200);
      out.show = await tryShow(url, s.jar, scan, ov, s.steps);
    }
    if (c.body.lov) {
      const search = typeof c.body.search === "string" ? c.body.search.slice(0, 30) : "";
      out.lov = [];
      for (const lv of scan.items.filter((x) => x.lovAjax).slice(0, 2)) out.lov.push(...(await tryLov(page, url, s.jar, lv, search)));
    }
    if (c.body.js) out.js = await readJs(page, url, s.jar);
    if (c.body.ir) {
      const ov = {};
      for (const [k, v] of Object.entries(c.body.items || {})) if (/^P\d+_[A-Z0-9_]+$/.test(k)) ov[k] = String(v).slice(0, 200);
      out.ir = await readIr(url, s.jar, page, ov, s.steps);
    }
    if (c.body.full) {
      const ov = {};
      for (const [k, v] of Object.entries(c.body.items || {})) if (/^P\d+_[A-Z0-9_]+$/.test(k)) ov[k] = String(v).slice(0, 200);
      const g2 = await follow(await req(url, s.jar), url, s.jar, []);
      const r2 = await submitPage(g2.page, g2.url, s.jar, "Show", ov);
      const f2 = await follow(r2, g2.url, s.jar, []);
      const full = await fetchIrAll(s.jar, g2.url, f2.page, collectForm(f2.page));
      out.full = { at: it.text, total: full.totalRows, fetched: full.rows.length, method: full.method, tries: full.tries, headers: full.headers, sample: full.rows.slice(0, 3), pagination: full.pagination };
    }
    return send(out);
  } catch (e) {
    if (isTimeout(e)) return slowJson();
    return json({ error: "ERP server-e connect kora jay nai, abar chesta koro" }, 502);
  }
}

// ---------- ERP PAGES (real feature: menu + generic page viewer; view-only) ----------
const SKIP_MENU = /^(---|expresserp|switch company|about|sign out|logout|install app|feedback|help|home|cart.*)$/i;
const pathOf = (abs) => { try { return new URL(abs).pathname; } catch (e) { return ""; } };

function menuPages(nav, homeUrl) {
  const home = pathOf(homeUrl);
  const seen = new Set();
  const out = [];
  for (const l of nav) {
    const p = pathOf(l.abs);
    if (!p || p === home || !/\/r\//.test(p) || SKIP_MENU.test(l.text.trim()) || /cart/i.test(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, text: l.text, abs: l.abs });
  }
  return out;
}

// "values":[ ... ] ke bracket match kore ber kore
function parseLovValues(body) {
  const i = body.indexOf('"values"');
  if (i < 0) return [];
  const s = body.indexOf("[", i);
  if (s < 0) return [];
  let depth = 0, inStr = false, esc = false, e = -1;
  for (let k = s; k < body.length; k++) {
    const ch = body[k];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) { e = k; break; } }
  }
  if (e < 0) return [];
  try {
    return JSON.parse(body.slice(s, e + 1)).map((r) => (Array.isArray(r) ? (r.length > 1 ? { d: String(r[0]), r: String(r[1]) } : { d: String(r[0]), r: String(r[0]) }) : { d: String(r), r: String(r) }));
  } catch (e2) { return []; }
}

async function fetchLov(page, pageUrl, jar, ajax, fields) {
  const sys = (n) => (fields.find((f) => f.name === n) || {}).value || "";
  const items = [...new Set(fields.map((f) => f.name).filter((n) => /^P\d+_/.test(n)))];
  const all = [];
  const MAX = 500;
  let first = 1;
  for (let it = 0; it < 4; it++) {
    const body = new URLSearchParams();
    for (const n of ["p_flow_id", "p_flow_step_id", "p_instance"]) body.set(n, sys(n));
    body.set("p_debug", "");
    body.set("p_request", "PLUGIN=" + unesc(ajax));
    body.set("p_json", JSON.stringify({
      regions: [{ fetchData: { version: 1, firstRow: first, maxRows: MAX } }],
      pageItems: { itemsToSubmit: items.map((n) => ({ n, v: sys(n) })), protected: byId(page, "pPageItemsProtected"), rowVersion: "", formRegionChecksums: [] },
      salt: byId(page, "pSalt"),
    }));
    const res = await req(new URL("wwv_flow.ajax", BASE + "/ords/").href, jar, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", Referer: pageUrl },
      body: body.toString(),
    });
    const rows = parseLovValues(await res.text());
    all.push(...rows);
    if (rows.length < MAX) break;
    first += rows.length;
  }
  return all;
}

function siteItems(page, fields) {
  const base = listItems(page, fields);
  const out = [];
  for (const it of base) {
    if (/hidden/.test(it.kind)) continue;
    const o = { name: it.name, label: it.label || it.name, value: it.value || "" };
    const sm = page.match(new RegExp('<select\\b[^>]*\\bid="' + it.name + '"[^>]*>([\\s\\S]*?)</select>', "i"));
    const dm = page.match(new RegExp('<a-date-picker\\b[^>]*\\bid="' + it.name + '"[^>]*>', "i"));
    if (it.lovAjax) {
      o.type = "lov";
      o.display = it.display || "";
      o._ajax = it.lovAjax;
    } else if (sm) {
      o.type = "select";
      o.options = [...sm[1].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].slice(0, 400).map((x) => [attrx(x[1], "value"), textOf(x[2])]);
    } else if (dm || /date/i.test(it.kind)) {
      o.type = "date";
      o.example = dm ? attrx(dm[0], "valid-example") : "";
    } else {
      o.type = "text";
    }
    out.push(o);
  }
  return out;
}

function readTable(page) {
  const tables = [...page.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)].map((m) => {
    const trs = [...m[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    const data = trs.filter((tr) => /<td\b/i.test(tr[1]));
    const head = trs.find((tr) => /<th\b/i.test(tr[1]));
    const cells = (tr, tag) => [...tr[1].matchAll(new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)</" + tag + ">", "gi"))].map((c) => clip(textOf(c[1]), 200));
    return { irr: /a-IRR-table/.test(m[1]), n: data.length, headers: head ? cells(head, "th") : [], rows: data.map((tr) => cells(tr, "td")) };
  }).filter((t) => t.n > 0);
  if (!tables.length) return null;
  const t = tables.find((x) => x.irr) || tables.reduce((a, b) => (b.n > a.n ? b : a));
  if (t.n === 1 && t.rows[0].length <= 1 && /no data found/i.test(t.rows[0][0] || "")) return { headers: t.headers, rows: [], total: 0, totalRows: 0, pagination: "" };
  const pagTotal = parsePaginationTotal(page);
  return { headers: t.headers, rows: t.rows.slice(0, IR_MAX_ROWS), total: t.n, totalRows: pagTotal ? pagTotal.total : t.n, pagination: paginationOf(page), isIr: !!t.irr };
}

// ---------- v10 FULL PROXY: asol APEX page-gulo sorasori browser-e chalano ----------
// Viewer (api/menu, api/page) shudhu sohoj form + report table banate pare - tab, editable grid,
// Save/Submit/Clear bati, file upload konotai pare na. Tai v10-e Worker asol ERP-r reverse proxy:
// browser /erp/ords/... chaile Worker seta asol ERP theke ene dey, URL/cookie/header bodle.
// Browser-e asol APEX code chole, tai prottek tab, bati, grid, upload main site-er motoi kaj kore.
// ID/Password ekhane kokhono log/save kora hoy na - login-er somoy browser theke ja ase tai ERP-te jay.
// SOTORKOTA: proxy diye Save/Submit chaple ASOL ERP-tei likhbe - eta copy na, asol jinish.

function toProxyPath(erpUrl) {
  try {
    const u = new URL(erpUrl);
    if (u.origin !== BASE) return "/erp" + ERP_LOGIN_PATH;
    return "/erp" + u.pathname + u.search + u.hash;
  } catch (e) {
    return "/erp" + ERP_LOGIN_PATH;
  }
}

// ---------- v18: LIVE API for Murad's Twin (same-origin JSON) ----------
// Twin-er sob list ekhan theke ase - asol ERP-r session cookie diye, kono
// password lage na, kichu save kora hoy na. Session na thakle 401 + relogin.
// Kono demo data ekhane banano hoy na: page menu-te na thakle 404, sari na
// thakle khali list - Twin setai dekhabe.
const LIVE_HOME_CANDIDATES = ["/ords/r/rpro/smartqr/login", "/ords/r/rpro/smartqr/125"];

function liveRelogin(jar) {
  return json({ error: "Session sesh hoye geche — abar login koro", relogin: true, cookiesSeen: jar ? Object.keys(jar).length : 0 }, 401);
}

// dashboard-er asol ERP home URL (/erp/ords/..., session-soho) - handleHome-er motoi check.
function validLiveHomeUrl(u) {
  if (!/^\/erp\/ords\/[^\s"'<>\\]{1,800}$/.test(u)) return false;
  try { return new URL(BASE + u.slice(4)).origin === BASE; } catch (e) { return false; }
}

function proxyToErp(u) {
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/erp/")) return BASE + u.slice(4);
  if (u.startsWith("/")) return BASE + u;
  return BASE + "/" + u;
}

// Home page (ed125) khuje menu ber kora - session thakle tobei hobe.
// homeUrl thakle (dashboard je URL-e Home khole, session-soho) setai age
// try kora hoy - khali /125 path-e cookie diye na-o milte pare.
async function liveMenuFromJar(jar, homeUrl) {
  const targets = [];
  if (homeUrl && validLiveHomeUrl(homeUrl)) targets.push(proxyToErp(homeUrl));
  for (const path of LIVE_HOME_CANDIDATES) targets.push(BASE + path);
  for (const target of targets) {
    try {
      const f = await follow(await req(target, jar), target, jar, []);
      if (!/<div id="ed125"/.test(f.page)) continue;
      const pages = menuPages(extractNav(f.page, f.url), f.url).map((p) => ({ text: p.text, url: toProxyPath(p.abs) }));
      return { ok: true, erpUrl: toProxyPath(f.url), pages };
    } catch (e) {
      if (isTimeout(e)) return { ok: false, status: 502 };
    }
  }
  return { ok: false, status: 401 };
}

async function findLivePage(jar, re, homeUrl) {
  const m = await liveMenuFromJar(jar, homeUrl);
  if (!m.ok) return { ok: false, status: m.status };
  const page = m.pages.find((p) => re.test(p.text));
  if (!page) return { ok: false, status: 404, menu: m.pages.map((p) => p.text) };
  return { ok: true, page };
}

function livePageError(found, label, jar) {
  if (found.status === 502) return slowJson();
  if (found.status === 401) return liveRelogin(jar);
  return json({ error: label + " page menu-te pawa jay nai", menu: found.menu || [] }, 404);
}

// ---------- v21: live cache + ping (Twin speed) ----------
// Session key: APEX session id from homeUrl/pageUrl, else a hash of the
// browser's ERP cookies. Password kokhono na, admin cookie kokhono na.
// Cache key-te session id thakay ek session-er data onno session-e jay na.
const LIVE_CACHE_MENU_TTL = 300;    // 5 min
const LIVE_CACHE_ORGS_TTL = 3600;   // 1 h
const LIVE_CACHE_ONHAND_TTL = 60;   // 60 s fresh, tarpor stale-while-revalidate
const LIVE_CACHE_ONHAND_MAX = 600;  // 10 min - er cheye purono hole live fetch
const LIVE_SEEN_TTL = 3600;         // last-seen 1 h rakha hoy
const LIVE_SEEN_ALIVE_MS = 15 * 60 * 1000; // ping: 15 min-er moddhe dekha gele alive
const NEWS_TTL = 600;               // Prothom Alo headlines: 10 min cache
const NEWS_URL = "https://www.prothomalo.com/feed";

// GET /api/news - Prothom Alo RSS theke top headlines (JSON); 10 min KV cache
function parseRssItems(xml) {
  const items = [];
  const clean = (s) =>
    String(s || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ").trim();
  for (const m of String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const body = m[1];
    const tag = (name) => {
      const mm = body.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">", "i"));
      return mm ? clean(mm[1]) : "";
    };
    const title = tag("title");
    const link = tag("link");
    if (!title || !link) continue;
    items.push({ title, link, pubDate: tag("pubDate") || "" });
    if (items.length >= 10) break;
  }
  return items;
}
async function handleLiveNews(request, env) {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  const ckey = "news:prothomalo";
  if (env && env.LAYOUT) {
    const hit = await liveCacheGet(env, ckey);
    if (hit && Date.now() - hit.fetchedAt < NEWS_TTL * 1000) {
      return json(Object.assign({}, hit.body, { cached: true, cachedAt: new Date(hit.fetchedAt).toISOString(), cacheAgeSec: Math.floor((Date.now() - hit.fetchedAt) / 1000) }));
    }
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(NEWS_URL, { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0", Accept: "application/rss+xml, application/xml, text/xml" } });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return json({ error: "Prothom Alo theke khobor ana jay nai (HTTP " + res.status + ")" }, 502);
    const xml = await res.text();
    const items = parseRssItems(xml);
    if (!items.length) return json({ error: "Prothom Alo feed-e kono khobor pawa jay nai" }, 502);
    const body = { ok: true, source: "Prothom Alo", items, fetchedAt: new Date().toISOString() };
    if (env && env.LAYOUT) await liveCachePut(env, ckey, body, NEWS_TTL);
    return json(body);
  } catch (e) {
    if (isTimeout(e)) return json({ error: "Prothom Alo slow — 1 minute pore abar chesta koro" }, 502);
    return json({ error: "Prothom Alo theke khobor ana jay nai" }, 502);
  }
}
// ---------- Murad Net: share Murad's home WiFi through the website ----------
// KV keys (env.LAYOUT): net:owner {hash, createdAt}, net:state {on, note, updatedAt},
// net:details {invite, wg, updatedAt}, net:joins {count, lastAt}, net:rl:<ip> {n}
const NET_OWNER_KEY = "net:owner";
const NET_STATE_KEY = "net:state";
const NET_DETAILS_KEY = "net:details";
const NET_JOINS_KEY = "net:joins";
const NET_JOIN_LIMIT = 10;      // max join attempts per IP per minute
const NET_JOIN_WINDOW_S = 60;

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function netKvGet(env, key) {
  if (!env || !env.LAYOUT) return null;
  try { return await env.LAYOUT.get(key, "json"); } catch (e) { return null; }
}
async function netKvPut(env, key, value, ttlSec) {
  if (!env || !env.LAYOUT) return false;
  try {
    await env.LAYOUT.put(key, JSON.stringify(value), ttlSec ? { expirationTtl: ttlSec } : undefined);
    return true;
  } catch (e) { return false; }
}
async function netOwnerHash(env) {
  const rec = await netKvGet(env, NET_OWNER_KEY);
  return rec && typeof rec.hash === "string" ? rec.hash : "";
}
async function netCheckKey(request, env) {
  const key = String(request.headers.get("x-net-key") || "");
  if (!key) return false;
  const stored = await netOwnerHash(env);
  if (!stored) return false;
  return sameStr(await sha256Hex(key), stored);
}
function netClientIp(request) {
  const h = String(request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown");
  return (h.split(",")[0] || "unknown").trim() || "unknown";
}
function netKvDown() {
  return json({ error: "Sharing setup needs Cloudflare KV — ask the site owner to finish the setup" }, 503);
}

// POST /api/net/setup {password} — first time only; 409 once set
async function handleNetSetup(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env || !env.LAYOUT) return netKvDown();
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid request" }, 400); }
  const pw = String(body.password || "");
  if (pw.length < 4 || pw.length > 64) return json({ error: "Password must be 4 to 64 characters" }, 400);
  if (await netOwnerHash(env)) return json({ error: "Share password is already set" }, 409);
  const ok = await netKvPut(env, NET_OWNER_KEY, { hash: await sha256Hex(pw), createdAt: Date.now() });
  if (!ok) return netKvDown();
  return json({ ok: true });
}

// GET /api/net/state (public) | POST /api/net/state {on, note} (owner key)
async function handleNetState(request, env) {
  if (request.method === "GET") {
    const st = (await netKvGet(env, NET_STATE_KEY)) || {};
    return json({ on: st.on === true, note: typeof st.note === "string" ? st.note : "", updatedAt: st.updatedAt || 0, hasOwner: !!(await netOwnerHash(env)) });
  }
  if (request.method !== "POST") return json({ error: "GET or POST only" }, 405);
  if (!env || !env.LAYOUT) return netKvDown();
  if (!(await netCheckKey(request, env))) return json({ error: "Wrong owner password" }, 401);
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid request" }, 400); }
  const st = { on: body.on === true, note: String(body.note || "").slice(0, 200), updatedAt: Date.now() };
  await netKvPut(env, NET_STATE_KEY, st);
  return json({ ok: true, on: st.on });
}

// GET /api/net/details (owner key) | POST /api/net/details {invite, wg} (owner key)
async function handleNetDetails(request, env) {
  if (!env || !env.LAYOUT) return netKvDown();
  if (!(await netCheckKey(request, env))) return json({ error: "Wrong owner password" }, 401);
  if (request.method === "GET") {
    const d = (await netKvGet(env, NET_DETAILS_KEY)) || {};
    return json({ ok: true, invite: typeof d.invite === "string" ? d.invite : "", wg: typeof d.wg === "string" ? d.wg : "", updatedAt: d.updatedAt || 0 });
  }
  if (request.method !== "POST") return json({ error: "GET or POST only" }, 405);
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid request" }, 400); }
  const d = { invite: String(body.invite || "").slice(0, 500), wg: String(body.wg || "").slice(0, 8000), updatedAt: Date.now() };
  await netKvPut(env, NET_DETAILS_KEY, d);
  return json({ ok: true });
}

// GET /api/net/stats (owner key) — join count + last join time + sharing state
async function handleNetStats(request, env) {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  if (!env || !env.LAYOUT) return netKvDown();
  if (!(await netCheckKey(request, env))) return json({ error: "Wrong owner password" }, 401);
  const j = (await netKvGet(env, NET_JOINS_KEY)) || {};
  const st = (await netKvGet(env, NET_STATE_KEY)) || {};
  return json({ ok: true, joins: j.count || 0, lastJoinAt: j.lastAt || 0, on: st.on === true });
}

// POST /api/net/join {password} — friend connects; details only when sharing is ON
async function handleNetJoin(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env || !env.LAYOUT) return netKvDown();
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid request" }, 400); }
  const ip = netClientIp(request);
  const rlKey = "net:rl:" + ip;
  const rl = (await netKvGet(env, rlKey)) || {};
  const n = (rl.n || 0) + 1;
  await netKvPut(env, rlKey, { n }, NET_JOIN_WINDOW_S);
  if (n > NET_JOIN_LIMIT) return json({ error: "Too many tries — wait a minute and try again" }, 429);
  const stored = await netOwnerHash(env);
  if (!stored) return json({ error: "Sharing is not set up yet" }, 503);
  if (!sameStr(await sha256Hex(String(body.password || "")), stored)) return json({ error: "Wrong password" }, 401);
  const st = (await netKvGet(env, NET_STATE_KEY)) || {};
  if (st.on !== true) return json({ ok: false, off: true });
  const d = (await netKvGet(env, NET_DETAILS_KEY)) || {};
  const j = (await netKvGet(env, NET_JOINS_KEY)) || {};
  await netKvPut(env, NET_JOINS_KEY, { count: (j.count || 0) + 1, lastAt: Date.now() });
  return json({ ok: true, invite: typeof d.invite === "string" ? d.invite : "", wg: typeof d.wg === "string" ? d.wg : "", detailsReady: !!(d.invite || d.wg) });
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function liveSessionKey(request, urlHint) {
  const m = String(urlHint || "").match(/session=(\d+)/);
  if (m) return "s" + m[1];
  try {
    const q = new URL(request.url).searchParams.get("homeUrl") || "";
    const mq = q.match(/session=(\d+)/);
    if (mq) return "s" + mq[1];
  } catch (e) {}
  const jar = jarFromRequest(request);
  const keys = Object.keys(jar);
  if (!keys.length) return "";
  return "c" + hashStr(keys.sort().map((k) => k + "=" + jar[k]).join(";"));
}
function liveCacheKey(kind, sid, extra) {
  return "live:cache:" + kind + ":" + sid + (extra ? ":" + extra : "");
}
async function liveCacheGet(env, key) {
  try {
    if (!env || !env.LAYOUT) return null;
    const raw = await env.LAYOUT.get(key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o.fetchedAt !== "number" || !o.body) return null;
    return o;
  } catch (e) { return null; }
}
async function liveCachePut(env, key, body, ttl) {
  try {
    if (!env || !env.LAYOUT) return;
    await env.LAYOUT.put(key, JSON.stringify({ fetchedAt: Date.now(), body }), { expirationTtl: ttl });
  } catch (e) {}
}
// sofol live call-er pore session-ta beche ache bole KV-te chihno rakha
async function touchLiveSeen(env, request, urlHint) {
  try {
    if (!env || !env.LAYOUT) return;
    const sid = liveSessionKey(request, urlHint);
    if (!sid) return;
    await env.LAYOUT.put("live:seen:" + sid, String(Date.now()), { expirationTtl: LIVE_SEEN_TTL });
  } catch (e) {}
}
// GET /api/live/ping - ERP-te na giye KV theke tatkhonik uttor
async function handleLivePing(request, env) {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  const sid = liveSessionKey(request);
  if (!sid) return json({ ok: true, sessionAlive: false, lastSeen: null, ageSec: null });
  let lastSeen = null;
  try {
    if (env && env.LAYOUT) {
      const v = await env.LAYOUT.get("live:seen:" + sid);
      if (v) lastSeen = Number(v) || null;
    }
  } catch (e) {}
  const ageMs = lastSeen ? Date.now() - lastSeen : null;
  return json({ ok: true, sessionAlive: ageMs !== null && ageMs < LIVE_SEEN_ALIVE_MS, lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null, ageSec: ageMs === null ? null : Math.floor(ageMs / 1000) });
}

// Show bati-r request name: page-er bati theke, na pele "Show"
function showRequestName(scan) {
  const b = (scan.buttons || []).find((x) => /^(show|search|go|view|run|submit)$/i.test(x.text)) || (scan.buttons || []).find((x) => /show|search/i.test(x.text)) || {};
  return b.name || b.label || b.text || "Show";
}

async function handleLiveMenu(request, env) {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  const jar = jarFromRequest(request);
  const homeUrl = String(new URL(request.url).searchParams.get("homeUrl") || "").trim();
  // cookie na thakleo homeUrl-er session diye cholbe - ERP-i seshe bichar korbe
  if (!Object.keys(jar).length && !validLiveHomeUrl(homeUrl)) return liveRelogin(jar);
  const sid = liveSessionKey(request, homeUrl);
  const ckey = sid ? liveCacheKey("menu", sid) : "";
  if (ckey) {
    const hit = await liveCacheGet(env, ckey);
    if (hit && Date.now() - hit.fetchedAt < LIVE_CACHE_MENU_TTL * 1000) {
      await touchLiveSeen(env, request, homeUrl);
      return json(Object.assign({}, hit.body, { cached: true, cachedAt: new Date(hit.fetchedAt).toISOString(), cacheAgeSec: Math.floor((Date.now() - hit.fetchedAt) / 1000) }));
    }
  }
  try {
    const m = await liveMenuFromJar(jar, homeUrl);
    if (!m.ok) return m.status === 502 ? slowJson() : liveRelogin(jar);
    const body = { ok: true, erpUrl: m.erpUrl, pages: m.pages, fetchedAt: new Date().toISOString() };
    if (ckey) await liveCachePut(env, ckey, body, LIVE_CACHE_MENU_TTL);
    await touchLiveSeen(env, request, homeUrl);
    return json(body);
  } catch (e) {
    if (isTimeout(e)) return slowJson();
    return json({ error: "ERP server-e connect kora jay nai, abar chesta koro" }, 502);
  }
}

async function handleLiveOrgs(request, env) {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  const jar = jarFromRequest(request);
  const homeUrl = String(new URL(request.url).searchParams.get("homeUrl") || "").trim();
  // cookie na thakleo homeUrl-er session diye cholbe - ERP-i seshe bichar korbe
  if (!Object.keys(jar).length && !validLiveHomeUrl(homeUrl)) return liveRelogin(jar);
  const sid = liveSessionKey(request, homeUrl);
  const ckey = sid ? liveCacheKey("orgs", sid) : "";
  if (ckey) {
    const hit = await liveCacheGet(env, ckey);
    if (hit && Date.now() - hit.fetchedAt < LIVE_CACHE_ORGS_TTL * 1000) {
      await touchLiveSeen(env, request, homeUrl);
      return json(Object.assign({}, hit.body, { cached: true, cachedAt: new Date(hit.fetchedAt).toISOString(), cacheAgeSec: Math.floor((Date.now() - hit.fetchedAt) / 1000) }));
    }
  }
  try {
    const found = await findLivePage(jar, /on[\s-]?hand/i, homeUrl);
    if (!found.ok) return livePageError(found, "On-hand Stock", jar);
    const pageUrl = proxyToErp(found.page.url);
    const g = await follow(await req(pageUrl, jar), pageUrl, jar, []);
    if (/P9999_PASSWORD/.test(g.page)) return liveRelogin(jar);
    const fields = collectForm(g.page);
    const scan = scanPage(g.page);
    const orgItem = scan.items.find((x) => /org/i.test(x.label || "") && x.lovAjax) || scan.items.find((x) => x.name === "P34_NEW");
    if (!orgItem || !orgItem.lovAjax) return json({ error: "Org dropdown On-hand page-e pawa jay nai", items: scan.items.map((x) => x.label || x.name) }, 404);
    const vals = await fetchLov(g.page, g.url, jar, orgItem.lovAjax, fields);
    const orgs = vals.map((v) => ({ display: v.d, value: v.r })).filter((o) => o.value);
    const body = { ok: true, orgs, fetchedAt: new Date().toISOString() };
    if (ckey) await liveCachePut(env, ckey, body, LIVE_CACHE_ORGS_TTL);
    await touchLiveSeen(env, request, homeUrl);
    return json(body);
  } catch (e) {
    if (isTimeout(e)) return slowJson();
    return json({ error: "ERP server-e connect kora jay nai, abar chesta koro" }, 502);
  }
}

// On Hand live fetch (ERP theke) - cache-e rakhar age ar SWR refresh-eo ektai poth
async function fetchLiveOnhand(jar, homeUrl, org, orgDisplay) {
  const found = await findLivePage(jar, /on[\s-]?hand/i, homeUrl);
  if (!found.ok) return { err: found };
  const pageUrl = proxyToErp(found.page.url);
  const g = await follow(await req(pageUrl, jar), pageUrl, jar, []);
  const scan = scanPage(g.page);
  const orgItem = scan.items.find((x) => /org/i.test(x.label || "") && x.lovAjax) || scan.items.find((x) => x.name === "P34_NEW");
  const ov = {};
  if (orgItem) {
    ov[orgItem.name] = org;
    const dispName = orgItem.name + "_DISPLAY";
    if (collectForm(g.page).some((f) => f.name === dispName)) ov[dispName] = orgDisplay || org;
  }
  if (scan.items.some((x) => x.name === "P34_OPTION")) ov.P34_OPTION = "1";
  const r = await submitPage(g.page, g.url, jar, showRequestName(scan), ov);
  const f2 = await follow(r, g.url, jar, []);
  if (/P9999_PASSWORD/.test(f2.page)) return { err: { status: 401 } };
  const full = await fetchIrAll(jar, g.url, f2.page, collectForm(f2.page));
  return { ok: true, org, orgDisplay: orgDisplay || "", total: full.totalRows, fetched: full.rows.length, headers: full.headers, rows: full.rows, fetchedAt: new Date().toISOString(), method: full.method, pagination: full.pagination };
}
async function handleLiveOnhand(request, env, ctx) {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  const jar = jarFromRequest(request);
  const q = new URL(request.url).searchParams;
  const homeUrl = String(q.get("homeUrl") || "").trim();
  // cookie na thakleo homeUrl-er session diye cholbe - ERP-i seshe bichar korbe
  if (!Object.keys(jar).length && !validLiveHomeUrl(homeUrl)) return liveRelogin(jar);
  const org = String(q.get("org") || "").trim();
  if (!org) return json({ error: "Org dao (?org=<ORG_ID>)" }, 400);
  const orgDisplay = String(q.get("orgDisplay") || "").trim();
  const sid = liveSessionKey(request, homeUrl);
  const ckey = sid ? liveCacheKey("onhand", sid, org) : "";
  // stale-while-revalidate: 60s-er moddhe cache thakle tatkhonik dao,
  // 60s-10min hole cache dao + pichone notun kore ano, 10min+ hole live ano
  if (ckey) {
    const hit = await liveCacheGet(env, ckey);
    if (hit) {
      const ageMs = Date.now() - hit.fetchedAt;
      if (ageMs < LIVE_CACHE_ONHAND_MAX * 1000) {
        if (ageMs >= LIVE_CACHE_ONHAND_TTL * 1000 && ctx && ctx.waitUntil) {
          try {
            ctx.waitUntil((async () => {
              try {
                const b = await fetchLiveOnhand(jar, homeUrl, org, orgDisplay);
                if (b.ok) { await liveCachePut(env, ckey, b, LIVE_CACHE_ONHAND_TTL); await touchLiveSeen(env, request, homeUrl); }
              } catch (e) {}
            })());
          } catch (e) {}
        }
        await touchLiveSeen(env, request, homeUrl);
        return json(Object.assign({}, hit.body, { cached: true, cachedAt: new Date(hit.fetchedAt).toISOString(), cacheAgeSec: Math.floor(ageMs / 1000) }));
      }
    }
  }
  try {
    const body = await fetchLiveOnhand(jar, homeUrl, org, orgDisplay);
    if (body.err) return livePageError(body.err, "On-hand Stock", jar);
    if (ckey) await liveCachePut(env, ckey, body, LIVE_CACHE_ONHAND_TTL);
    await touchLiveSeen(env, request, homeUrl);
    return json(body);
  } catch (e) {
    if (isTimeout(e)) return slowJson();
    return json({ error: "ERP server-e connect kora jay nai, abar chesta koro" }, 502);
  }
}

async function handleLiveReport(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const jar = jarFromRequest(request);
  // cookie na thakleo pageUrl-er session diye cholbe - niche login page
  // dhora porle 401 dibo, khali list dibo na
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid request" }, 400); }
  const pageUrlRaw = String((body && body.pageUrl) || "");
  if (!/^\/erp\/ords\/[^\s"'<>\\]{1,800}$/.test(pageUrlRaw)) return json({ error: "Invalid page url" }, 400);
  const items = {};
  for (const [k, v] of Object.entries((body && body.items) || {})) if (/^P\d+_[A-Z0-9_]+$/.test(k)) items[k] = String(v).slice(0, 200);
  try {
    const pageUrl = BASE + pageUrlRaw.slice(4);
    const g = await follow(await req(pageUrl, jar), pageUrl, jar, []);
    if (/P9999_PASSWORD/.test(g.page)) return liveRelogin(jar);
    const scan = scanPage(g.page);
    const r = await submitPage(g.page, g.url, jar, showRequestName(scan), items);
    const f2 = await follow(r, g.url, jar, []);
    if (/P9999_PASSWORD/.test(f2.page)) return liveRelogin(jar);
    const full = await fetchIrAll(jar, g.url, f2.page, collectForm(f2.page));
    await touchLiveSeen(env, request, pageUrlRaw);
    return json({ ok: true, page: scan.title || "", total: full.totalRows, fetched: full.rows.length, headers: full.headers, rows: full.rows, fetchedAt: new Date().toISOString(), method: full.method, pagination: full.pagination });
  } catch (e) {
    if (isTimeout(e)) return slowJson();
    return json({ error: "ERP server-e connect kora jay nai, abar chesta koro" }, 502);
  }
}

// ERP-r absolute URL (/ords/..., /i/...) -> /erp/ords/..., /erp/i/...
function rewriteErpText(text) {
  let t = String(text || "").split(BASE).join("");
  t = t.split("//e501.sihirbox.com:8071").join("");
  t = t.replace(/\\\/(ords|i|f|p)(?=[\\\/\?#"'])/g, "\\/erp\\/$1");
  t = t.replace(/(["'`(=,\s>])\/(ords|i|f|p)(?=[\/?#"'\)\s>,;]|$)/g, "$1/erp/$2");
  return t;
}

// v20: Own Site (Portfolio)-er iframe-er vitore login cookie tikanor jonno SameSite=None + Partitioned.
const CK_SET = "Secure; SameSite=None; Partitioned";
function ckClear(h, name, httpOnly) {
  // purono (Lax, partition-chhara) cookie muche dao + notun partitioned cookie-o muche dao
  h.append("set-cookie", name + "=; Path=/; Max-Age=0; Secure; " + (httpOnly ? "HttpOnly; " : "") + "SameSite=Lax");
  h.append("set-cookie", name + "=; Path=/; Max-Age=0; " + (httpOnly ? "HttpOnly; " : "") + CK_SET);
}
function rewriteCookie(c) {
  const parts = String(c || "").split(";").map((s) => s.trim()).filter(Boolean);
  const name = parts.length ? parts[0].split("=")[0].trim().toLowerCase() : "";
  const out = [];
  for (const p of parts) {
    const eq = p.indexOf("=");
    const kl = (eq >= 0 ? p.slice(0, eq) : p).trim().toLowerCase();
    if (kl === "domain" || kl === "samesite" || kl === "secure" || kl === "partitioned") continue;
    if (kl === "max-age" || kl === "expires") continue;
    if (kl === "path") {
      const v = eq >= 0 ? p.slice(eq + 1).trim() : "";
      out.push("Path=/");
      continue;
    }
    out.push(p);
  }
  // v21: ERP session cookie 7 din tike thakbe - browser bondho kore abar
  // asleo session thakbe, abar login lagbe na. Admin cookie (erpl_adm)
  // kokhono ekhane ashe na, ar asleo tar nijer 12h life bodlay na.
  if (name && name !== ADMIN_COOKIE) out.push("Max-Age=604800");
  out.push(CK_SET);
  return out.join("; ");
}

function rewriteLocation(loc, targetUrl) {
  try {
    const u = new URL(loc, targetUrl);
    if (u.origin === BASE) return "/erp" + u.pathname + u.search + u.hash;
    return loc;
  } catch (e) {
    return loc;
  }
}

// browser-er Referer/Origin (worker domain) -> asol ERP domain
function rewriteClientUrl(v, origin) {
  if (!v) return v;
  if (v.startsWith(origin + "/erp/")) return BASE + v.slice(origin.length + 4);
  if (v === origin + "/erp" || v === origin) return BASE;
  if (v.startsWith(origin)) return BASE + v.slice(origin.length);
  return v;
}

const PROXY_TEXT_TYPES = ["text/html", "text/css", "text/javascript", "application/javascript", "application/json", "text/plain", "application/xml", "text/xml", "image/svg+xml"];
const BACK_LINK = '<a href="/express-erp/" onclick="this.style.display=\'none\'" title="Dashboard-e firot jao" style="position:fixed;right:10px;bottom:10px;z-index:99999;background:#0a2229;color:#e6cb80!important;padding:8px 12px;border:1.5px solid #e6cb80;border-radius:99px;font:700 13px sans-serif;text-decoration:none;opacity:.95;box-shadow:0 2px 10px rgba(0,0,0,.4)">← Dashboard</a>';

// v10.2 "shiter kapor" v2: asol ERP-r upor Murad-er site-er design (Midnight Gold).
// Manush-ta bodlay na (asol APEX code-i chole), shudhu kapor bodlay - rong, font, bati, table.
// Kebol dekhte bodlay; page-er kathamo (kothay menu, kothay grid) APEX-er motoi thake.
// v10.1 theke ja thik holo: menu popup-er sada bg + sonar lekha, grid-er sada sarite sada lekha,
// dashboard-er sada card, dim rong-er lekha, uporer Search ghore lukano.
// v15: btnfx.css/js = button style (Red / Venom / Silk) - comes after theme.css so that it wins
const THEME_HEAD = '<meta name="color-scheme" content="dark"><script>try{if(window.top!==window.self)document.documentElement.classList.add("erp-fr")}catch(e){}</script><style>html,body{background:#212121}</style><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" media="print" onload="this.media=\'all\'"><link rel="stylesheet" href="/tokens.css?v=1.0"><link rel="stylesheet" href="/theme.css?v=23.0"><link rel="stylesheet" href="/btnfx.css?v=15.2"><script src="/theme.js?v=23.0"></script><script src="/softshow.js?v=15.7"></script><script src="/btnfx.js?v=15.2"></script>';

// v15.3: Show/Submit-e page notun kore load hole "bhenge jawa" na dekhate - body prothome lukano thake (pichone dark rong),
// theme.js shob thik kore html-e .erp-ready dile fade-in. JS fail korleo 2.2s pore CSS nijei dekhabe. Shudhu puro HTML document-e (fragment-e na).
const CURTAIN = '<style id="erp-curtain">html:not(.erp-ready) body{opacity:0;animation:erpCurtain 0s linear 1.6s forwards}html:not(.erp-ready)::after{content:"";position:fixed;left:50%;top:38%;width:30px;height:30px;margin:-15px 0 0 -15px;border:3px solid rgba(71,202,188,.25);border-top-color:#e6cb80;border-radius:50%;z-index:2147483647;animation:erpSpin .7s linear infinite,erpCurtainOff 0s linear 1.6s forwards}@keyframes erpCurtain{to{opacity:1}}@keyframes erpCurtainOff{to{opacity:0}}@keyframes erpSpin{to{transform:rotate(360deg)}}</style>';

// ---------- v13: Admin Layout Editor (Admin = ADMIN_IDS; layout KV-te save hoy) ----------
// ADMIN_SECRET (Cloudflare Secret) na thakle admin bondho; LAYOUT (KV) na thakle save hobe na - kintu site kokhono bhangbe na.
const DEFAULT_ADMIN_IDS = ["111597"];
// v14: Cloudflare Variable ADMIN_IDS (comma-separated, e.g. 111597,222222) thakle seta, na thakle ager moto
const adminIds = (env) => {
  const l = String((env && env.ADMIN_IDS) || "").split(",").map((x) => x.trim()).filter(Boolean);
  return l.length ? l : DEFAULT_ADMIN_IDS;
};
const ADMIN_COOKIE = "erpl_adm";
const ADMIN_TTL = 12 * 3600;
const LAYOUT_ZONES = ["top", "bottom", "left", "right"];
const LAYOUT_KEY_RE = /^\/ords\/[a-z0-9_\-.\/@:~%]{1,200}$/;

const b64u = (buf) => {
  let s = "";
  const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function hmacSign(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

function sameStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function makeAdminCookie(env, id) {
  if (!env || !env.ADMIN_SECRET) return null;
  const payload = id + "." + (Math.floor(Date.now() / 1000) + ADMIN_TTL);
  return payload + "." + (await hmacSign(env.ADMIN_SECRET, payload));
}

function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

async function isAdmin(request, env) {
  try {
    if (!env || !env.ADMIN_SECRET) return false;
    const v = readCookie(request, ADMIN_COOKIE);
    const p = v.split(".");
    if (p.length !== 3 || !adminIds(env).includes(p[0])) return false;
    if (!(Number(p[1]) > Date.now() / 1000)) return false;
    return sameStr(await hmacSign(env.ADMIN_SECRET, p[0] + "." + p[1]), p[2]);
  } catch (e) {
    return false;
  }
}

// page-er key: /ords/r/rpro/smartqr/iso-shipment (session ba query chhara). Purono f?p=APP:PAGE:SESSION hole /ords/f@PAGE
function layoutKeyOf(u) {
  let p = String(u.pathname || "").replace(/^\/erp(?=\/)/, "").replace(/\/+$/, "").toLowerCase();
  const q = u.searchParams.get("p");
  if (q) {
    const pg = q.split(":")[1];
    if (pg && /^[a-z0-9_\-]{1,60}$/i.test(pg)) p += "@" + pg.toLowerCase();
  }
  return LAYOUT_KEY_RE.test(p) ? p : "";
}

const HEXC = /^#[0-9a-fA-F]{3,8}$/;
// v15: button style. "none" = no effect on this button (even if Global is set).
const FX_LIST = ["none", "red", "venom", "silk"];
const GLOBAL_KEY = "global:fx";
// Default style for all buttons: { fx, bg, fg } - null when fx is missing (meaning delete)
function sanitizeGlobalFx(g) {
  if (!g || typeof g !== "object" || !FX_LIST.includes(g.fx) || g.fx === "none") return null;
  const out = { v: 1, fx: g.fx };
  if (typeof g.bg === "string" && HEXC.test(g.bg)) out.bg = g.bg;
  if (typeof g.fg === "string" && HEXC.test(g.fg)) out.fg = g.fg;
  return out;
}
async function readGlobalFx(env) {
  try {
    if (!env || !env.LAYOUT) return null;
    return sanitizeGlobalFx(await env.LAYOUT.get(GLOBAL_KEY, "json"));
  } catch (e) {
    return null;
  }
}
// The main Dashboard (index.html) reads the Global style with this GET - nothing secret, only style name and colors
async function handleFxGet(request, env) {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  return json((await readGlobalFx(env)) || {});
}

function sanitizeLayout(l) {
  if (!l || typeof l !== "object" || !l.items || typeof l.items !== "object" || Array.isArray(l.items)) return null;
  const out = { v: 1, items: {} };
  let n = 0;
  for (const [k, e] of Object.entries(l.items)) {
    if (!k || k.length > 200 || !e || typeof e !== "object") continue;
    if (++n > 400) break;
    const c = {};
    if (LAYOUT_ZONES.includes(e.zone)) c.zone = e.zone;
    if (Number.isFinite(e.order)) c.order = Math.max(0, Math.min(9999, Math.round(e.order)));
    if (e.hide === true) c.hide = true;
    if (typeof e.label === "string") {
      const t = e.label.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
      if (t) c.label = t;
    }
    if (typeof e.bg === "string" && HEXC.test(e.bg)) c.bg = e.bg;
    if (typeof e.fg === "string" && HEXC.test(e.fg)) c.fg = e.fg;
    if (FX_LIST.includes(e.fx)) c.fx = e.fx;
    // v13.3: pos anchor (before:/after:) - ▲▼ diye onno sarite jawa item-er thikana
    if (typeof e.pos === "string" && /^(before|after):.+/.test(e.pos) && e.pos.length <= 220) c.pos = e.pos;
    // v13.3 (FIX): age order shudhu thakle entry muche jeto - ◀ ▶ nudge Save-e jome na
    if (c.zone || c.hide || c.label || c.bg || c.fg || c.fx || typeof c.order === "number" || c.pos) out.items[k] = c;
  }
  return out;
}

async function handleLayoutSave(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "Bad origin" }, 403);
  if (!(await isAdmin(request, env))) return json({ error: "Admin login lagbe (Admin ID diye abar login koro)" }, 403);
  if (!env.LAYOUT) return json({ error: "Cloudflare KV (LAYOUT) setup kora hoy nai" }, 503);
  let body;
  try {
    const txt = await request.text();
    if (txt.length > 300000) return json({ error: "Onek boro" }, 413);
    body = JSON.parse(txt);
  } catch (e) {
    return json({ error: "Invalid request" }, 400);
  }
  const key = String((body && body.key) || "");
  // v15: Global default style for the buttons of all pages + Dashboard (only Admin can save)
  if (key === "__global") {
    try {
      const g = body.layout === null ? null : sanitizeGlobalFx(body.layout);
      if (!g) await env.LAYOUT.delete(GLOBAL_KEY);
      else await env.LAYOUT.put(GLOBAL_KEY, JSON.stringify(g));
      return json({ ok: true, global: g || {} });
    } catch (e) {
      return json({ error: "KV-te save hoy nai, abar chesta koro" }, 502);
    }
  }
  if (!LAYOUT_KEY_RE.test(key)) return json({ error: "Page key thik nai" }, 400);
  try {
    if (body.layout === null) {
      await env.LAYOUT.delete("layout:" + key);
      return json({ ok: true, layout: { v: 1, items: {} } });
    }
    const clean = sanitizeLayout(body.layout);
    if (!clean) return json({ error: "Layout thik nai" }, 400);
    if (!Object.keys(clean.items).length) await env.LAYOUT.delete("layout:" + key);
    else await env.LAYOUT.put("layout:" + key, JSON.stringify(clean));
    return json({ ok: true, layout: clean });
  } catch (e) {
    return json({ error: "KV-te save hoy nai, abar chesta koro" }, 502);
  }
}

// ---------- v16: order / hidden / individual color of the Dashboard's top Tabs (toggle) (Admin saves, everyone sees) ----------
const TABS_KEY = "tabs:cfg";
function cleanTabKey(x) {
  return String(x).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}
function sanitizeTabs(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const out = { v: 1, order: [], hide: [], color: {} };
  for (const f of ["order", "hide"]) {
    if (!Array.isArray(c[f])) continue;
    for (const k of c[f]) {
      if (typeof k !== "string") continue;
      const t = cleanTabKey(k);
      if (t && !out[f].includes(t)) out[f].push(t);
      if (out[f].length >= 80) break;
    }
  }
  if (c.color && typeof c.color === "object" && !Array.isArray(c.color)) {
    let n = 0;
    for (const [k, e] of Object.entries(c.color)) {
      const t = cleanTabKey(k);
      if (!t || !e || typeof e !== "object") continue;
      if (++n > 80) break;
      const o = {};
      if (typeof e.bg === "string" && HEXC.test(e.bg)) o.bg = e.bg;
      if (typeof e.fg === "string" && HEXC.test(e.fg)) o.fg = e.fg;
      if (o.bg || o.fg) out.color[t] = o;
    }
  }
  if (!out.order.length && !out.hide.length && !Object.keys(out.color).length) return null;
  return out;
}
async function readTabs(env) {
  try {
    if (!env || !env.LAYOUT) return null;
    return sanitizeTabs(await env.LAYOUT.get(TABS_KEY, "json"));
  } catch (e) {
    return null;
  }
}
async function handleTabs(request, env) {
  if (request.method === "GET") {
    return json({ cfg: await readTabs(env), admin: await isAdmin(request, env), kv: !!(env && env.LAYOUT) });
  }
  if (request.method !== "POST") return json({ error: "GET/POST only" }, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "Bad origin" }, 403);
  if (!(await isAdmin(request, env))) return json({ error: "Admin login lagbe (Admin ID diye abar login koro)" }, 403);
  if (!env.LAYOUT) return json({ error: "Cloudflare KV (LAYOUT) setup kora hoy nai" }, 503);
  let body;
  try {
    const txt = await request.text();
    if (txt.length > 100000) return json({ error: "Onek boro" }, 413);
    body = JSON.parse(txt);
  } catch (e) {
    return json({ error: "Invalid request" }, 400);
  }
  try {
    const clean = body && body.cfg === null ? null : sanitizeTabs(body && body.cfg);
    if (!clean) await env.LAYOUT.delete(TABS_KEY);
    else await env.LAYOUT.put(TABS_KEY, JSON.stringify(clean));
    return json({ ok: true, cfg: clean });
  } catch (e) {
    return json({ error: "KV-te save hoy nai, abar chesta koro" }, 502);
  }
}

function handleLogout(request) {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  ckClear(h, ADMIN_COOKIE, true);
  // v14: ERP session cookie-gulo-o muche dao - logout mane sotti logout
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const n = part.split("=")[0].trim();
    if (n && n !== ADMIN_COOKIE) ckClear(h, n, true);
  }
  return new Response('{"ok":true}', { status: 200, headers: h });
}

// ERP page-er sheshe layout data + layout.js boshano. Kono error hole page jemon chilo temoni jabe.
async function layoutInjection(request, env, reqUrl) {
  try {
    const key = layoutKeyOf(reqUrl);
    if (!key) return "";
    let layout = null;
    if (env && env.LAYOUT) {
      try {
        layout = await env.LAYOUT.get("layout:" + key, "json");
      } catch (e) {
        layout = null;
      }
    }
    if (layout && (typeof layout !== "object" || !layout.items)) layout = null;
    const data = { key, layout, global: await readGlobalFx(env), admin: await isAdmin(request, env), kv: !!(env && env.LAYOUT) };
    const j = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    return "<script>window.__ERPL=" + j + ";</script><script src=\"/glass.js?v=1\" charset=\"utf-8\"></script><script src=\"/layout.js?v=15.4\" charset=\"utf-8\"></script><script src=\"/auto.js?v=6\" charset=\"utf-8\"></script>";
  } catch (e) {
    return "";
  }
}

// v15.4: shudhu static file (JS/CSS/chhobi/font) - /i/ ba /files/static/ er bhitore. Dynamic page/ajax kokhono na.
const STATIC_ASSET_RE = /^\/(i\/|ords\/r\/[^?]*\/files\/static\/).+\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|eot|ico)$/i;

async function proxyErp(request, upPath, env) {
  const reqUrl = new URL(request.url);
  if (reqUrl.pathname === "/erp" || reqUrl.pathname === "/erp/") {
    return Response.redirect(reqUrl.origin + "/express-erp/?login=1", 302);
  }
  // v14: ERP session cookie chhara /erp/* proxy hobe na (open relay bondho)
  const hasSession = String(request.headers.get("cookie") || "").split(";").some((x) => { const n = x.split("=")[0].trim(); return n && n !== ADMIN_COOKIE; });
  if (!hasSession) {
    if (request.method === "GET" || request.method === "HEAD") return Response.redirect(reqUrl.origin + "/express-erp/?login=1", 302);
    return new Response("Login lagbe", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const target = BASE + upPath + reqUrl.search;
  const isStaticAsset = request.method === "GET" && STATIC_ASSET_RE.test(upPath);
  const headers = new Headers();
  const skipReq = new Set(["host", "connection", "content-length", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-proto", "x-real-ip"]);
  for (const [k, v] of request.headers) {
    const kl = k.toLowerCase();
    if (skipReq.has(kl)) continue;
    if (kl === "referer" || kl === "origin") {
      headers.set(k, rewriteClientUrl(v, reqUrl.origin));
      continue;
    }
    if (kl === "cookie") {
      // v13: admin cookie ERP-te jabe na
      const kept = String(v).split(";").filter((x) => x.split("=")[0].trim() !== ADMIN_COOKIE).join(";").trim();
      if (kept) headers.set(k, kept);
      continue;
    }
    headers.set(k, v);
  }
  let body;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
    if (body.byteLength === 0) body = undefined;
  }
  let res;
  try {
    // v13.3: proxy fetch-eo 20s timeout - ERP jhule thakle 502 diye janano hobe
    // v15.4: APEX static file (/i/..., /files/static/...) edge-e cache hobe - Show-er page reload-e prottek bar ERP-te jete hoy na
    res = await fetch(target, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(REQ_TIMEOUT_MS), ...(isStaticAsset ? { cf: { cacheEverything: true, cacheTtl: 86400 } } : {}) });
  } catch (e) {
    if (isTimeout(e)) return new Response("ERP ekhon khub slow — 1 minute pore abar chesta koro", { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response("ERP server-e connect kora jay nai, abar chesta koro", { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const outHeaders = new Headers();
  const skipRes = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "content-security-policy", "content-security-policy-report-only", "x-frame-options", "cross-origin-embedder-policy", "cross-origin-opener-policy", "cross-origin-resource-policy", "set-cookie"]);
  for (const [k, v] of res.headers) {
    if (skipRes.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === "location") {
      outHeaders.set(k, rewriteLocation(v, target));
      continue;
    }
    outHeaders.append(k, v);
  }
  for (const c of res.headers.getSetCookie()) outHeaders.append("set-cookie", rewriteCookie(c));
  if (isStaticAsset && res.status === 200) {
    for (const k of ["cache-control", "pragma", "expires"]) outHeaders.delete(k);
    outHeaders.set("cache-control", "public, max-age=86400");
  }
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const isText = PROXY_TEXT_TYPES.some((t) => ct.includes(t));
  if (isText) {
    let text = await res.text();
    // ERP-r nijer login page kokhono dekhano hobe na - session na thakle / session sesh hole sorasori tomar login page
    if (ct.includes("text/html") && request.method === "GET" && /P9999_USERNAME/.test(text)) {
      return Response.redirect(reqUrl.origin + "/express-erp/?login=1", 302);
    }
    text = rewriteErpText(text);
    if (ct.includes("text/html")) {
      // v10.1: prottek asol ERP page-e Murad-er design (shiter kapor) poriye deya
      const headInj = THEME_HEAD + (/<html[\s>]/i.test(text) ? CURTAIN : "");
      if (/<\/head>/i.test(text)) text = text.replace(/<\/head>/i, () => headInj + "</head>");
      else if (/<\/body>/i.test(text)) text = text.replace(/<\/body>/i, () => headInj + "</body>");
      else text = headInj + text;
      text = text.replace(/<\/body>/i, () => BACK_LINK + "</body>");
      // v13: layout + warning script (shudhu GET-er puro HTML page-e, </body>-er thik age)
      if (request.method === "GET" && /<html[\s>]/i.test(text)) {
        const inj = await layoutInjection(request, env, reqUrl);
        if (inj) {
          let at = -1, m;
          const re = /<\/body>/gi;
          while ((m = re.exec(text))) at = m.index;
          text = at >= 0 ? text.slice(0, at) + inj + text.slice(at) : text + inj;
        }
      }
    }
    return new Response(text, { status: res.status, statusText: res.statusText, headers: outHeaders });
  }
  const buf = await res.arrayBuffer();
  return new Response(buf, { status: res.status, statusText: res.statusText, headers: outHeaders });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/login") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      return handleLogin(request, env);
    }
    if (url.pathname === "/api/home") return handleHome(request, env);
    if (url.pathname === "/api/probe") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      // v14: debug tool shudhu Admin-er jonno
      if (!(await isAdmin(request, env))) return json({ error: "Probe shudhu Admin-er jonno — Admin ID diye main page-e login kore abar asho" }, 403);
      return handleProbe(request);
    }
    if (url.pathname === "/api/layout") return handleLayoutSave(request, env);
    if (url.pathname === "/api/fx") return handleFxGet(request, env);
    if (url.pathname === "/api/tabs") return handleTabs(request, env);
    if (url.pathname === "/api/logout") return request.method === "POST" ? handleLogout(request) : json({ error: "POST only" }, 405);
    if (url.pathname === "/api/news") return handleLiveNews(request, env);
    if (url.pathname === "/api/live/ping") return handleLivePing(request, env);
    if (url.pathname === "/api/live/menu") return handleLiveMenu(request, env);
    if (url.pathname === "/api/live/orgs") return handleLiveOrgs(request, env);
    if (url.pathname === "/api/live/onhand") return handleLiveOnhand(request, env, ctx);
    if (url.pathname === "/api/live/report") return handleLiveReport(request, env);
    if (url.pathname === "/api/net/setup") return handleNetSetup(request, env);
    if (url.pathname === "/api/net/state") return handleNetState(request, env);
    if (url.pathname === "/api/net/details") return handleNetDetails(request, env);
    if (url.pathname === "/api/net/stats") return handleNetStats(request, env);
    if (url.pathname === "/api/net/join") return handleNetJoin(request, env);
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    // v10 proxy: /erp/ords/... -> asol ERP
    if (url.pathname === "/erp" || url.pathname.startsWith("/erp/")) {
      return proxyErp(request, url.pathname === "/erp" ? "/" : url.pathname.slice(4), env);
    }
    // safety net: APEX JS majhe majhe origin + "/ords/..." banay - setao proxy diye jabe
    if (/^\/(ords|i|f|p)(\/|$)/.test(url.pathname)) {
      return proxyErp(request, url.pathname, env);
    }
    return env.ASSETS.fetch(request);
  },
  // v17: optional Cron - does nothing if CRON_ERP_ID / CRON_ERP_PASS (Cloudflare Secrets) are not set
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cronKpi(env));
  },
};

