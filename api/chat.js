// CERVEAU — fonction serverless Vercel.
// A chaque question : assemble [system prompt de style] + [corpus filtre] +
// [garde-fous] + [historique], appelle l'API Claude, renvoie la reponse.
// La cle API vit UNIQUEMENT cote serveur (process.env.ANTHROPIC_API_KEY).
// L'echange est ensuite journalise en tache de fond (lib/analytics.js) :
// jamais avant l'envoi de la reponse, jamais bloquant.

import Anthropic from "@anthropic-ai/sdk";
import { waitUntil } from "@vercel/functions";
import { buildContext } from "../lib/corpus.js";
import { fetchGithubContext } from "../lib/github.js";
import { logChat, safeId } from "../lib/analytics.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const MAX_TOKENS = 1024;
const MAX_HISTORY = 12; // nombre de messages d'historique conserves
const MAX_QUESTION_LEN = 2000;

// --- Rate limiting simple en memoire (par instance serverless) ---
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX || 12);
const RATE_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const hits = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  // Nettoyage opportuniste pour eviter de garder trop d'IP en memoire.
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(k);
    }
  }
  return recent.length > RATE_MAX;
}

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  return host ? `${proto}://${host}` : "";
}

// Journalisation en arriere-plan : la reponse part d'abord, le log suit.
function background(promise) {
  try {
    waitUntil(promise);
  } catch {
    promise.catch(() => {});
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Methode non autorisee." });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res
      .status(500)
      .json({ error: "Configuration serveur incomplete (cle API manquante)." });
  }

  // Corps : { messages: [{role, content}], visitorId?, conversationId? } OU { question: "..." }
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Corps de requete invalide." });
    }
  }
  body = body || {};
  const ids = {
    visitorId: safeId(body.visitorId),
    conversationId: safeId(body.conversationId),
  };

  let messages = [];
  if (Array.isArray(body.messages)) {
    messages = body.messages
      .filter(
        (m) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim(),
      )
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION_LEN) }));
  } else if (typeof body.question === "string" && body.question.trim()) {
    messages = [{ role: "user", content: body.question.slice(0, MAX_QUESTION_LEN) }];
  }

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "Aucune question fournie." });
  }
  const question = messages[messages.length - 1].content;

  const ip = getClientIp(req);
  if (rateLimited(ip)) {
    background(logChat(req, { ...ids, question, status: "rate_limited" }));
    return res.status(429).json({
      error:
        "Trop de questions en peu de temps. Patiente une minute avant de reessayer.",
    });
  }

  const { systemPrompt, corpus } = await buildContext(getBaseUrl(req));
  // Activite GitHub publique (projets en cours). Ne bloque jamais le chat.
  const github = await fetchGithubContext();

  const system = [
    // Bloc 1 : instructions de style (stable) — mis en cache.
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    // Bloc 2 : corpus profil + livrables (stable) — mis en cache.
    { type: "text", text: corpus, cache_control: { type: "ephemeral" } },
  ];
  // Bloc 3 : activite GitHub (evolue) — non cache, place apres pour preserver
  // le cache des blocs precedents.
  if (github) system.push({ type: "text", text: github });

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const started = Date.now();

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
    });

    const reply = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const finalReply = reply || "Je n'ai pas de reponse a fournir sur ce point.";
    res.status(200).json({ reply: finalReply });

    const u = response.usage || {};
    background(
      logChat(req, {
        ...ids,
        question,
        reply: finalReply,
        status: "ok",
        model: response.model || MODEL,
        tokensIn: u.input_tokens,
        tokensOut: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        latencyMs: Date.now() - started,
      }),
    );
    return;
  } catch (err) {
    console.error("Erreur API Claude:", err?.message || err);
    res
      .status(502)
      .json({ error: "Le service est momentanement indisponible. Reessaie." });
    background(
      logChat(req, {
        ...ids,
        question,
        status: "error",
        model: MODEL,
        latencyMs: Date.now() - started,
      }),
    );
    return;
  }
}
