// ANALYTICS — qui vient, d'ou, et ce qu'on demande au clone.
// Objectif : donner a Alexandre une lecture commerciale du trafic (sources,
// themes des questions, intentions, leads) sans jamais ralentir le chat.
//
// Principes :
//   - Stockage Postgres (Neon via Vercel Marketplace) : DATABASE_URL.
//     Sans DATABASE_URL, tout est desactive silencieusement : le site marche
//     exactement comme avant.
//   - Aucune exception ne remonte vers le chat : chaque fonction attrape tout.
//   - Donnees minimisees (RGPD) : l'IP n'est JAMAIS stockee, seulement un hash
//     sale et tronque. Le user-agent est reduit a un type d'appareil.
//   - Classification des questions (theme / intention / lead) par un petit
//     modele, en tache de fond apres l'envoi de la reponse (waitUntil).

import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL || "claude-haiku-4-5-20251001";
const IP_SALT = process.env.IP_HASH_SALT || "ask-desailly";
const MAX_TEXT = 4000; // longueur max stockee (question / reponse)

export const THEMES = [
  "parcours",
  "competences",
  "mission",
  "livrable",
  "methode",
  "ia-data",
  "disponibilite-tarif",
  "contact",
  "projets-github",
  "hors-sujet",
  "autre",
];
export const INTENTS = ["chaud", "tiede", "froid"];

export function analyticsEnabled() {
  return Boolean(DATABASE_URL);
}

// --- Connexion + schema (cree a la volee, idempotent) ---
let sql = null;
let schemaPromise = null;

function db() {
  if (!sql) sql = neon(DATABASE_URL);
  return sql;
}

export async function ensureSchema() {
  if (!analyticsEnabled()) return false;
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const q = db();
      await q`
        CREATE TABLE IF NOT EXISTS events (
          id              BIGSERIAL PRIMARY KEY,
          ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
          type            TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'ok',
          visitor_id      TEXT,
          conversation_id TEXT,
          ip_hash         TEXT,
          country         TEXT,
          region          TEXT,
          city            TEXT,
          device          TEXT,
          referrer        TEXT,
          utm_source      TEXT,
          utm_medium      TEXT,
          utm_campaign    TEXT,
          path            TEXT,
          question        TEXT,
          reply           TEXT,
          theme           TEXT,
          intent          TEXT,
          lead            BOOLEAN NOT NULL DEFAULT false,
          contact         TEXT,
          model           TEXT,
          tokens_in       INTEGER,
          tokens_out      INTEGER,
          cache_read      INTEGER,
          latency_ms      INTEGER
        )`;
      await q`CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts DESC)`;
      await q`CREATE INDEX IF NOT EXISTS events_type_ts_idx ON events (type, ts DESC)`;
      await q`CREATE INDEX IF NOT EXISTS events_visitor_idx ON events (visitor_id)`;
      await q`CREATE INDEX IF NOT EXISTS events_conv_idx ON events (conversation_id)`;
      return true;
    })().catch((err) => {
      console.error("analytics: schema", err?.message || err);
      schemaPromise = null; // on retentera au prochain appel
      return false;
    });
  }
  return schemaPromise;
}

// --- Helpers d'enrichissement (a partir de la requete) ---
function header(req, name) {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v || "";
}

export function clientIp(req) {
  const fwd = header(req, "x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return header(req, "x-real-ip") || req.socket?.remoteAddress || "";
}

export function hashIp(ip) {
  if (!ip) return null;
  return createHash("sha256").update(`${IP_SALT}:${ip}`).digest("hex").slice(0, 16);
}

function decode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export function geoFromRequest(req) {
  // En-tetes fournis gratuitement par Vercel sur chaque requete.
  return {
    country: header(req, "x-vercel-ip-country") || null,
    region: decode(header(req, "x-vercel-ip-country-region")) || null,
    city: decode(header(req, "x-vercel-ip-city")) || null,
  };
}

const BOT_RE =
  /bot|crawl|spider|slurp|facebookexternalhit|linkedinbot|whatsapp|telegram|preview|headless|python-requests|curl\/|wget\//i;

export function deviceFromUa(ua = "") {
  if (!ua) return "inconnu";
  if (BOT_RE.test(ua)) return "bot";
  if (/ipad|tablet/i.test(ua)) return "tablette";
  if (/mobi|android|iphone/i.test(ua)) return "mobile";
  return "ordinateur";
}

export function refHost(referrer = "") {
  try {
    const u = new URL(referrer);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return referrer ? String(referrer).slice(0, 100) : null;
  }
}

// Identifiants venant du navigateur : on ne garde que des valeurs saines.
export function safeId(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^[A-Za-z0-9_-]{6,64}$/.test(s) ? s : null;
}

function clip(s, n = MAX_TEXT) {
  if (typeof s !== "string") return null;
  return s.length > n ? s.slice(0, n) + " […]" : s;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,3}\)?[\s.-]?){3,5}\d{2}/;

export function extractContact(text = "") {
  const email = text.match(EMAIL_RE)?.[0];
  if (email) return email;
  const phone = text.match(PHONE_RE)?.[0];
  if (phone && phone.replace(/\D/g, "").length >= 9) return phone.trim();
  return null;
}

// --- Classification (theme / intention / lead) par un petit modele ---
export async function classifyQuestion(question, reply = "") {
  const fallback = { theme: null, intent: null, lead: false };
  if (!process.env.ANTHROPIC_API_KEY || !question) return fallback;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 120,
      system:
        "Tu classes des questions posees a la vitrine conversationnelle d'un consultant freelance " +
        "(Product Owner IA & Data / Business Analyst). Le visiteur est un recruteur, un prospect ou un curieux. " +
        "Reponds UNIQUEMENT par un JSON compact, sans texte autour.\n" +
        `theme (un seul) parmi : ${THEMES.join(", ")}.\n` +
        "intent : 'chaud' = veut recruter, missionner, obtenir un tarif, une disponibilite ou un contact ; " +
        "'tiede' = evalue le profil (competences, missions, methodes, references) ; 'froid' = curiosite, test, hors-sujet.\n" +
        "lead : true si intention chaude OU si le visiteur laisse un moyen de contact ou se presente comme une entreprise/un recruteur.\n" +
        'Format : {"theme":"...","intent":"...","lead":false}',
      messages: [
        {
          role: "user",
          content: `Question du visiteur :\n"""${question.slice(0, 1500)}"""\n\nExtrait de la reponse donnee :\n"""${(reply || "").slice(0, 400)}"""`,
        },
      ],
    });
    const txt = res.content.find((b) => b.type === "text")?.text || "";
    const json = txt.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return fallback;
    const parsed = JSON.parse(json);
    return {
      theme: THEMES.includes(parsed.theme) ? parsed.theme : "autre",
      intent: INTENTS.includes(parsed.intent) ? parsed.intent : null,
      lead: Boolean(parsed.lead),
    };
  } catch (err) {
    console.error("analytics: classification", err?.message || err);
    return fallback;
  }
}

// --- Ecritures ---
export async function logVisit(req, body = {}) {
  if (!analyticsEnabled()) return;
  try {
    if (!(await ensureSchema())) return;
    const ua = header(req, "user-agent");
    const geo = geoFromRequest(req);
    const utm = body.utm || {};
    await db()`
      INSERT INTO events (type, visitor_id, conversation_id, ip_hash, country, region, city,
                          device, referrer, utm_source, utm_medium, utm_campaign, path)
      VALUES ('visit', ${safeId(body.visitorId)}, ${safeId(body.conversationId)},
              ${hashIp(clientIp(req))}, ${geo.country}, ${geo.region}, ${geo.city},
              ${deviceFromUa(ua)}, ${refHost(body.referrer)},
              ${clip(utm.source, 100)}, ${clip(utm.medium, 100)}, ${clip(utm.campaign, 100)},
              ${clip(body.path, 200)})`;
  } catch (err) {
    console.error("analytics: visit", err?.message || err);
  }
}

// Enregistre un echange (question + reponse + mesures), puis le classe.
export async function logChat(req, data) {
  if (!analyticsEnabled()) return;
  try {
    if (!(await ensureSchema())) return;
    const ua = header(req, "user-agent");
    const geo = geoFromRequest(req);
    const question = clip(data.question);
    const reply = clip(data.reply);

    const cls =
      data.status === "ok" ? await classifyQuestion(question, reply) : { theme: null, intent: null, lead: false };
    const contact = extractContact(question || "");
    const lead = cls.lead || Boolean(contact);

    await db()`
      INSERT INTO events (type, status, visitor_id, conversation_id, ip_hash, country, region, city,
                          device, question, reply, theme, intent, lead, contact,
                          model, tokens_in, tokens_out, cache_read, latency_ms)
      VALUES ('chat', ${data.status || "ok"}, ${safeId(data.visitorId)}, ${safeId(data.conversationId)},
              ${hashIp(clientIp(req))}, ${geo.country}, ${geo.region}, ${geo.city},
              ${deviceFromUa(ua)}, ${question}, ${reply}, ${cls.theme}, ${cls.intent}, ${lead}, ${contact},
              ${data.model || null}, ${data.tokensIn ?? null}, ${data.tokensOut ?? null},
              ${data.cacheRead ?? null}, ${data.latencyMs ?? null})`;
  } catch (err) {
    console.error("analytics: chat", err?.message || err);
  }
}

// --- Lecture (tableau de bord) ---
function fillSeries(rows, days) {
  const map = new Map(rows.map((r) => [String(r.day).slice(0, 10), r]));
  const out = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(d.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const r = map.get(day) || {};
    out.push({
      day,
      visits: Number(r.visits || 0),
      visitors: Number(r.visitors || 0),
      questions: Number(r.questions || 0),
      leads: Number(r.leads || 0),
    });
  }
  return out;
}

export async function getStats(days = 30) {
  if (!analyticsEnabled()) return { enabled: false };
  if (!(await ensureSchema())) return { enabled: false };
  const q = db();
  days = Math.max(1, Math.min(365, Number(days) || 30));

  const [totals, series, sources, utm, countries, cities, devices, themes, intents, recent, leads, returning] =
    await Promise.all([
      q`
        SELECT
          count(*) FILTER (WHERE type = 'visit' AND device <> 'bot')                       AS visits,
          count(DISTINCT visitor_id) FILTER (WHERE type = 'visit' AND device <> 'bot')     AS visitors,
          count(DISTINCT conversation_id) FILTER (WHERE type = 'chat' AND status = 'ok')   AS conversations,
          count(DISTINCT visitor_id) FILTER (WHERE type = 'chat' AND status = 'ok')        AS askers,
          count(*) FILTER (WHERE type = 'chat' AND status = 'ok')                          AS questions,
          count(*) FILTER (WHERE type = 'chat' AND lead)                                   AS leads,
          count(*) FILTER (WHERE type = 'chat' AND intent = 'chaud')                       AS hot,
          count(*) FILTER (WHERE type = 'chat' AND status = 'error')                       AS errors,
          count(*) FILTER (WHERE type = 'chat' AND status = 'rate_limited')                AS rate_limited,
          coalesce(sum(tokens_in), 0)                                                      AS tokens_in,
          coalesce(sum(tokens_out), 0)                                                     AS tokens_out,
          coalesce(sum(cache_read), 0)                                                     AS cache_read,
          round(avg(latency_ms) FILTER (WHERE type = 'chat' AND status = 'ok'))            AS avg_latency_ms
        FROM events WHERE ts > now() - make_interval(days => ${days})`,
      q`
        SELECT date_trunc('day', ts)::date AS day,
          count(*) FILTER (WHERE type = 'visit' AND device <> 'bot')                     AS visits,
          count(DISTINCT visitor_id) FILTER (WHERE type = 'visit' AND device <> 'bot')   AS visitors,
          count(*) FILTER (WHERE type = 'chat' AND status = 'ok')                        AS questions,
          count(*) FILTER (WHERE type = 'chat' AND lead)                                 AS leads
        FROM events WHERE ts > now() - make_interval(days => ${days})
        GROUP BY 1 ORDER BY 1`,
      q`
        SELECT coalesce(referrer, 'acces direct') AS label, count(*) AS n
        FROM events WHERE type = 'visit' AND device <> 'bot' AND ts > now() - make_interval(days => ${days})
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
      q`
        SELECT utm_source AS source, utm_medium AS medium, utm_campaign AS campaign, count(*) AS n
        FROM events WHERE type = 'visit' AND utm_source IS NOT NULL AND ts > now() - make_interval(days => ${days})
        GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 12`,
      q`
        SELECT coalesce(country, '??') AS label, count(DISTINCT visitor_id) AS n
        FROM events WHERE type = 'visit' AND device <> 'bot' AND ts > now() - make_interval(days => ${days})
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
      q`
        SELECT concat_ws(', ', city, country) AS label, count(DISTINCT visitor_id) AS n
        FROM events WHERE type = 'visit' AND device <> 'bot' AND city IS NOT NULL AND ts > now() - make_interval(days => ${days})
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
      q`
        SELECT coalesce(device, 'inconnu') AS label, count(*) AS n
        FROM events WHERE type = 'visit' AND ts > now() - make_interval(days => ${days})
        GROUP BY 1 ORDER BY 2 DESC`,
      q`
        SELECT coalesce(theme, 'non classe') AS label, count(*) AS n
        FROM events WHERE type = 'chat' AND status = 'ok' AND ts > now() - make_interval(days => ${days})
        GROUP BY 1 ORDER BY 2 DESC`,
      q`
        SELECT coalesce(intent, 'non classe') AS label, count(*) AS n
        FROM events WHERE type = 'chat' AND status = 'ok' AND ts > now() - make_interval(days => ${days})
        GROUP BY 1 ORDER BY 2 DESC`,
      q`
        SELECT id, ts, visitor_id, conversation_id, country, city, device, question,
               left(reply, 600) AS reply, theme, intent, lead, contact, latency_ms, status
        FROM events WHERE type = 'chat' AND ts > now() - make_interval(days => ${days})
        ORDER BY ts DESC LIMIT 300`,
      q`
        SELECT id, ts, visitor_id, conversation_id, country, city, question, theme, intent, contact
        FROM events WHERE type = 'chat' AND lead AND ts > now() - make_interval(days => ${days})
        ORDER BY ts DESC LIMIT 100`,
      q`
        SELECT count(*) AS n FROM (
          SELECT visitor_id FROM events
          WHERE type = 'visit' AND device <> 'bot' AND visitor_id IS NOT NULL
            AND ts > now() - make_interval(days => ${days})
          GROUP BY visitor_id HAVING count(DISTINCT ts::date) > 1
        ) r`,
    ]);

  const t = totals[0] || {};
  const num = (v) => Number(v || 0);
  return {
    enabled: true,
    days,
    generatedAt: new Date().toISOString(),
    totals: {
      visits: num(t.visits),
      visitors: num(t.visitors),
      returning: num(returning[0]?.n),
      conversations: num(t.conversations),
      askers: num(t.askers),
      questions: num(t.questions),
      leads: num(t.leads),
      hot: num(t.hot),
      errors: num(t.errors),
      rateLimited: num(t.rate_limited),
      tokensIn: num(t.tokens_in),
      tokensOut: num(t.tokens_out),
      cacheRead: num(t.cache_read),
      avgLatencyMs: num(t.avg_latency_ms),
    },
    series: fillSeries(series, days),
    sources: sources.map((r) => ({ label: r.label, n: num(r.n) })),
    utm: utm.map((r) => ({ source: r.source, medium: r.medium, campaign: r.campaign, n: num(r.n) })),
    countries: countries.map((r) => ({ label: r.label, n: num(r.n) })),
    cities: cities.map((r) => ({ label: r.label, n: num(r.n) })),
    devices: devices.map((r) => ({ label: r.label, n: num(r.n) })),
    themes: themes.map((r) => ({ label: r.label, n: num(r.n) })),
    intents: intents.map((r) => ({ label: r.label, n: num(r.n) })),
    recent,
    leads,
  };
}

// Suppression des evenements plus vieux que N jours (retention RGPD).
export async function purgeOlderThan(days) {
  if (!analyticsEnabled()) return 0;
  if (!(await ensureSchema())) return 0;
  const rows = await db()`
    DELETE FROM events WHERE ts < now() - make_interval(days => ${Number(days)}) RETURNING id`;
  return rows.length;
}
