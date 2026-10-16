// Spotlight · Trae los datos de Meta (Facebook, Instagram y Meta Ads) de cada cliente
// y los guarda en /data para que el dashboard los lea.
// Corre en GitHub Actions con el token guardado como secret META_TOKEN.
//
// Variables de entorno:
//   META_TOKEN     (obligatorio) token del usuario del sistema
//   MONTHS         cuántos meses actualizar, contando el actual (por defecto 2)
//   GRAPH_VERSION  versión de la API de Meta (por defecto v23.0)

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = path.join(ROOT, "data");
const TOKEN = process.env.META_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v23.0";
const BASE = process.env.GRAPH_BASE || `https://graph.facebook.com/${GRAPH_VERSION}`;
const MONTHS = Math.max(1, Math.min(24, parseInt(process.env.MONTHS || "2", 10) || 2));
const TZ_OFFSET_H = -5; // Lima (UTC-5, sin horario de verano)

if (!TOKEN) {
  console.error("Falta META_TOKEN. Agrégalo en Settings → Secrets and variables → Actions.");
  process.exit(1);
}

// ---------- Utilidades ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v == null || v === "" ? 0 : Number(v) || 0);

async function graph(pathOrUrl, params = {}, token = TOKEN, tries = 4) {
  let url;
  if (/^https?:/.test(pathOrUrl)) url = new URL(pathOrUrl);
  else {
    url = new URL(BASE + "/" + pathOrUrl.replace(/^\//, ""));
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    url.searchParams.set("access_token", token);
  }
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url);
    let json;
    try { json = await res.json(); } catch { json = { error: { message: `HTTP ${res.status}` } }; }
    if (!json.error) return json;
    const code = json.error.code;
    const transient = res.status >= 500 || [1, 2, 4, 17, 32, 613, 80000, 80004].includes(code);
    if (transient && i < tries - 1) { await sleep(2000 * 2 ** i); continue; }
    const where = pathOrUrl.split("?")[0].replace(/access_token=[^&]+/, "");
    throw new Error(`${where}: ${json.error.message} (código ${code ?? "?"})`);
  }
}

async function graphAll(p, params, token = TOKEN, { max = 500, stop } = {}) {
  const out = [];
  let page = await graph(p, params, token);
  while (page) {
    for (const row of page.data || []) {
      if (stop && stop(row)) return out;
      out.push(row);
      if (out.length >= max) return out;
    }
    const next = page.paging?.next;
    page = next ? await graph(next, {}, token) : null;
  }
  return out;
}

function monthInfo(key) {
  const [y, m] = key.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const today = todayLima();
  const until = ymd(last) < today ? ymd(last) : today;
  // Límites en hora de Lima, como segundos unix
  const startTs = Math.floor((Date.UTC(y, m - 1, 1) - TZ_OFFSET_H * 3600e3) / 1000);
  const endTs = Math.floor((Date.UTC(y, m, 1) - TZ_OFFSET_H * 3600e3) / 1000) - 1;
  const names = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  return { key, since: ymd(first), until, lastDay: ymd(last), startTs, endTs, label: `${names[m - 1]} ${y}` };
}
function todayLima() {
  const d = new Date(Date.now() + TZ_OFFSET_H * 3600e3);
  return d.toISOString().slice(0, 10);
}
function recentMonths(n) {
  const t = todayLima();
  let y = +t.slice(0, 4), m = +t.slice(5, 7);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m--; if (m === 0) { m = 12; y--; }
  }
  return out;
}
async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}
async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + "\n");
}

// ---------- Resultados de Ads ----------
const LEAD = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];
const MSG = ["onsite_conversion.messaging_conversation_started_7d"];
const PURCHASE = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"];
const actionVal = (row, types) => {
  for (const t of types) {
    const a = (row.actions || []).find((x) => x.action_type === t);
    if (a) return num(a.value);
  }
  return 0;
};
function resultOf(row) {
  const obj = String(row.objective || "").toUpperCase();
  const leads = actionVal(row, LEAD), msgs = actionVal(row, MSG), buys = actionVal(row, PURCHASE);
  if (leads > 0) return { n: leads, label: "leads", kind: "contacto" };
  if (msgs > 0) return { n: msgs, label: "conversaciones", kind: "contacto" };
  if (buys > 0) return { n: buys, label: "compras", kind: "venta" };
  if (/AWARENESS|REACH|BRAND/.test(obj)) return { n: num(row.reach), label: "alcance", kind: "alcance" };
  if (/ENGAGEMENT|POST_ENGAGEMENT|VIDEO/.test(obj)) return { n: actionVal(row, ["post_engagement"]), label: "interacciones", kind: "interaccion" };
  return { n: actionVal(row, ["link_click"]) || num(row.clicks), label: "clics", kind: "trafico" };
}
function costPer(spend, r) {
  if (!r.n) return null;
  return r.kind === "alcance" ? (spend / r.n) * 1000 : spend / r.n; // alcance → costo por mil
}

// ---------- Secciones ----------
async function resolveIds(c, errors) {
  const ids = { pageId: c.pageId || null, igUserId: c.igUserId || null, adAccountId: c.adAccountId || null, pageToken: null };
  if (ids.adAccountId && !String(ids.adAccountId).startsWith("act_")) ids.adAccountId = "act_" + ids.adAccountId;
  if (ids.pageId) {
    try {
      const p = await graph(ids.pageId, { fields: "access_token,instagram_business_account" });
      ids.pageToken = p.access_token || null;
      if (!ids.igUserId && p.instagram_business_account) ids.igUserId = p.instagram_business_account.id;
    } catch (e) { errors.push(`Página de Facebook: ${e.message}`); }
  }
  return ids;
}

async function followersNow(ids, errors) {
  const now = {};
  if (ids.pageId) {
    try {
      const p = await graph(ids.pageId, { fields: "followers_count,fan_count" }, ids.pageToken || TOKEN);
      now.fb = num(p.followers_count ?? p.fan_count);
    } catch (e) { errors.push(`Seguidores de Facebook: ${e.message}`); }
  }
  if (ids.igUserId) {
    try {
      const u = await graph(ids.igUserId, { fields: "followers_count,username" });
      now.ig = num(u.followers_count);
      now.igUsername = u.username;
    } catch (e) { errors.push(`Seguidores de Instagram: ${e.message}`); }
  }
  return now;
}

async function igPosts(ids, mi, errors) {
  if (!ids.igUserId) return [];
  try {
    const media = await graphAll(`${ids.igUserId}/media`, {
      fields: "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count",
      limit: 50,
    }, TOKEN, { max: 400, stop: (m) => Date.parse(m.timestamp) / 1000 < mi.startTs });
    const inMonth = media.filter((m) => { const t = Date.parse(m.timestamp) / 1000; return t >= mi.startTs && t <= mi.endTs; });
    inMonth.sort((a, b) => num(b.like_count) + num(b.comments_count) - (num(a.like_count) + num(a.comments_count)));
    const top = inMonth.slice(0, 10);
    for (const m of top) {
      m._shares = 0; m._saved = 0; m._reach = null; m._total = null;
      for (const metrics of ["reach,saved,shares,total_interactions", "reach,saved"]) {
        try {
          const ins = await graph(`${m.id}/insights`, { metric: metrics });
          for (const r of ins.data || []) {
            const v = num(r.values?.[0]?.value ?? r.total_value?.value);
            if (r.name === "shares") m._shares = v;
            if (r.name === "saved") m._saved = v;
            if (r.name === "reach") m._reach = v;
            if (r.name === "total_interactions") m._total = v;
          }
          break;
        } catch { /* algunos tipos de post no aceptan todas las métricas */ }
      }
    }
    return top.map((m) => {
      const likes = num(m.like_count), comments = num(m.comments_count);
      return {
        net: "ig",
        type: m.media_product_type === "REELS" ? "Reel" : m.media_type === "CAROUSEL_ALBUM" ? "Carrusel" : m.media_type === "VIDEO" ? "Video" : "Foto",
        caption: (m.caption || "").slice(0, 220),
        date: m.timestamp,
        url: m.permalink,
        image: m.thumbnail_url || m.media_url || null,
        likes, comments, shares: m._shares, saved: m._saved, reach: m._reach,
        engagement: m._total ?? likes + comments + m._shares + m._saved,
      };
    });
  } catch (e) { errors.push(`Posts de Instagram: ${e.message}`); return []; }
}

async function fbPosts(ids, mi, errors) {
  if (!ids.pageId) return [];
  try {
    const posts = await graphAll(`${ids.pageId}/posts`, {
      fields: "id,message,created_time,permalink_url,full_picture,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)",
      since: mi.startTs, until: mi.endTs, limit: 50,
    }, ids.pageToken || TOKEN, { max: 300 });
    return posts.map((p) => {
      const likes = num(p.reactions?.summary?.total_count), comments = num(p.comments?.summary?.total_count), shares = num(p.shares?.count);
      return {
        net: "fb", type: p.full_picture ? "Publicación" : "Texto",
        caption: (p.message || "").slice(0, 220), date: p.created_time, url: p.permalink_url, image: p.full_picture || null,
        likes, comments, shares, saved: 0, reach: null, engagement: likes + comments + shares,
      };
    });
  } catch (e) { errors.push(`Posts de Facebook: ${e.message}`); return []; }
}

async function organicReach(ids, mi, errors) {
  const out = { ig: null, fb: null };
  if (ids.igUserId) {
    try {
      const r = await graph(`${ids.igUserId}/insights`, { metric: "reach", period: "day", metric_type: "total_value", since: mi.startTs, until: Math.min(mi.endTs, Math.floor(Date.now() / 1000)) });
      out.ig = num(r.data?.[0]?.total_value?.value) || null;
    } catch (e) { console.log(`   (sin alcance orgánico de Instagram: ${e.message})`); }
  }
  if (ids.pageId) {
    try {
      const r = await graph(`${ids.pageId}/insights`, { metric: "page_impressions_unique", period: "days_28", since: mi.startTs, until: Math.min(mi.endTs, Math.floor(Date.now() / 1000)) }, ids.pageToken || TOKEN);
      const vals = r.data?.[0]?.values || [];
      out.fb = vals.length ? num(vals[vals.length - 1].value) : null;
    } catch (e) { console.log(`   (sin alcance orgánico de Facebook: ${e.message})`); }
  }
  return out;
}

async function ads(ids, mi, errors) {
  const empty = { currency: null, campaigns: [], ads: [], paidReach: { ig: null, fb: null }, spend: 0 };
  if (!ids.adAccountId) return empty;
  const time_range = { since: mi.since, until: mi.until };
  const out = { ...empty };
  try {
    const acc = await graph(ids.adAccountId, { fields: "currency,name,timezone_name" });
    out.currency = acc.currency;
  } catch (e) { errors.push(`Cuenta publicitaria: ${e.message}`); return empty; }

  try {
    const rows = await graphAll(`${ids.adAccountId}/insights`, {
      level: "campaign", time_range, limit: 200,
      fields: "campaign_id,campaign_name,objective,spend,impressions,reach,frequency,clicks,ctr,cpm,actions",
    });
    out.campaigns = rows.map((r) => {
      const spend = num(r.spend), res = resultOf(r);
      return { id: r.campaign_id, name: r.campaign_name, objective: r.objective, spend, reach: num(r.reach), impressions: num(r.impressions),
        frequency: num(r.frequency), ctr: num(r.ctr), cpm: num(r.cpm), result: res, costPerResult: costPer(spend, res) };
    }).filter((c) => c.spend > 0).sort((a, b) => b.spend - a.spend);
    out.spend = out.campaigns.reduce((s, c) => s + c.spend, 0);
  } catch (e) { errors.push(`Campañas: ${e.message}`); }

  try {
    const rows = await graphAll(`${ids.adAccountId}/insights`, {
      level: "ad", time_range, limit: 300,
      fields: "ad_id,ad_name,campaign_name,objective,spend,impressions,reach,clicks,ctr,actions",
    });
    const rank = { contacto: 0, venta: 0, trafico: 1, interaccion: 2, alcance: 3 };
    const list = rows.map((r) => {
      const spend = num(r.spend), res = resultOf(r);
      return { id: r.ad_id, name: r.ad_name, campaign: r.campaign_name, spend, ctr: num(r.ctr), reach: num(r.reach), result: res, costPerResult: costPer(spend, res) };
    }).filter((a) => a.spend > 0 && a.result.n > 0);
    list.sort((a, b) => (rank[a.result.kind] - rank[b.result.kind]) || (a.costPerResult - b.costPerResult) || (b.ctr - a.ctr));
    out.ads = list.slice(0, 6);
    for (const a of out.ads.slice(0, 3)) {
      try {
        const ad = await graph(a.id, { fields: "creative{thumbnail_url,image_url}" });
        a.image = ad.creative?.image_url || ad.creative?.thumbnail_url || null;
      } catch { a.image = null; }
    }
  } catch (e) { errors.push(`Anuncios: ${e.message}`); }

  try {
    const rows = await graphAll(`${ids.adAccountId}/insights`, { time_range, breakdowns: "publisher_platform", fields: "reach,spend", limit: 50 });
    for (const r of rows) {
      if (r.publisher_platform === "instagram") out.paidReach.ig = num(r.reach);
      if (r.publisher_platform === "facebook") out.paidReach.fb = num(r.reach);
    }
  } catch (e) { errors.push(`Alcance pagado: ${e.message}`); }
  return out;
}

function followerSeries(history, mi, net) {
  const days = Object.keys(history).sort();
  const before = days.filter((d) => d < mi.since && history[d][net] != null);
  const inside = days.filter((d) => d >= mi.since && d <= mi.lastDay && history[d][net] != null);
  if (!inside.length) return null;
  const start = before.length ? history[before.at(-1)][net] : history[inside[0]][net];
  const startDate = before.length ? before.at(-1) : inside[0];
  return { start, startDate, end: history[inside.at(-1)][net], endDate: inside.at(-1), series: inside.map((d) => ({ d, v: history[d][net] })) };
}

// ---------- Principal ----------
async function main() {
  const clients = await readJson(path.join(ROOT, "config", "clients.json"), null);
  if (!Array.isArray(clients) || !clients.length) {
    console.error("config/clients.json está vacío o no es una lista de clientes.");
    process.exit(1);
  }
  const months = recentMonths(MONTHS).map(monthInfo);
  const today = todayLima();
  let ok = 0;

  for (const c of clients) {
    if (!c.id || !/^[a-z0-9-]+$/.test(c.id)) { console.error(`Cliente sin id válido (usa minúsculas y guiones): ${c.name}`); continue; }
    console.log(`\n▶ ${c.name}`);
    const dir = path.join(DATA, c.id);
    const baseErrors = [];
    const ids = await resolveIds(c, baseErrors);

    // Foto diaria de seguidores (Meta no da historial, así que lo guardamos nosotros)
    const histFile = path.join(dir, "followers.json");
    const history = await readJson(histFile, {});
    const now = await followersNow(ids, baseErrors);
    if (now.ig != null || now.fb != null) {
      history[today] = { ig: now.ig ?? null, fb: now.fb ?? null };
      await writeJson(histFile, history);
    }

    for (const mi of months) {
      const errors = [...baseErrors];
      const [ig, fb, reachOrg, paid] = await Promise.all([igPosts(ids, mi, errors), fbPosts(ids, mi, errors), organicReach(ids, mi, errors), ads(ids, mi, errors)]);
      const posts = [...ig, ...fb].sort((a, b) => b.engagement - a.engagement).slice(0, 6);
      const contacts = paid.campaigns.filter((x) => x.result.kind === "contacto").reduce((s, x) => s + x.result.n, 0);
      const report = {
        client: c.id, month: mi.key, label: mi.label, generatedAt: new Date().toISOString(), partial: mi.until < mi.lastDay,
        currency: paid.currency || c.currency || "PEN", igUsername: now.igUsername || null,
        followers: { ig: followerSeries(history, mi, "ig"), fb: followerSeries(history, mi, "fb") },
        posts, campaigns: paid.campaigns, ads: paid.ads,
        totals: { spend: paid.spend, contacts },
        reach: { organic: reachOrg, paid: paid.paidReach },
        errors: [...new Set(errors)],
      };
      await writeJson(path.join(dir, `${mi.key}.json`), report);
      console.log(`  ${mi.key}: ${posts.length} posts, ${paid.campaigns.length} campañas, inversión ${paid.spend.toFixed(2)}${report.errors.length ? ` · ${report.errors.length} avisos` : ""}`);
      report.errors.forEach((e) => console.log("   ⚠ " + e));
      if (!report.errors.length || posts.length || paid.campaigns.length) ok++;
    }
  }

  // Índice que lee el dashboard
  const index = { updatedAt: new Date().toISOString(), clients: [] };
  for (const c of clients) {
    const dir = path.join(DATA, c.id);
    const files = existsSync(dir) ? (await readdir(dir)).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 7)).sort().reverse() : [];
    index.clients.push({ id: c.id, name: c.name, subtitle: c.subtitle || "", months: files });
  }
  await writeJson(path.join(DATA, "index.json"), index);
  console.log(`\nListo. ${ok} reportes con datos.`);
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
