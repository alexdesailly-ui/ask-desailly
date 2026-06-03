// CERVEAU — fonction serverless Vercel.
// A chaque question : assemble [system prompt de style] + [corpus filtre] +
// [garde-fous] + [historique], appelle l'API Claude, renvoie la reponse.
// La cle API vit UNIQUEMENT cote serveur (process.env.ANTHROPIC_API_KEY).

import Anthropic from "@anthropic-ai/sdk";
import { buildContext } from "../lib/corpus.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
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

  const ip = getClientIp(req);
  if (rateLimited(ip)) {
    return res.status(429).json({
      error:
        "Trop de questions en peu de temps. Patiente une minute avant de reessayer.",
    });
  }

  // Corps : { messages: [{role, content}] } OU { question: "..." }
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Corps de requete invalide." });
    }
  }
  body = body || {};

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

  const { systemPrompt, corpus } = buildContext(getBaseUrl(req));

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        // Bloc 1 : instructions de style (stable) — mis en cache.
        { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
        // Bloc 2 : corpus (stable entre deux deploiements) — mis en cache.
        { type: "text", text: corpus, cache_control: { type: "ephemeral" } },
      ],
      messages,
    });

    const reply = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return res.status(200).json({
      reply: reply || "Je n'ai pas de reponse a fournir sur ce point.",
    });
  } catch (err) {
    console.error("Erreur API Claude:", err?.message || err);
    return res
      .status(502)
      .json({ error: "Le service est momentanement indisponible. Reessaie." });
  }
}
