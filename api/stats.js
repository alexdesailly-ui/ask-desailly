// STATS — agregats pour le tableau de bord /admin.
// Protege par ADMIN_TOKEN (en-tete Authorization: Bearer <token>).
// GET /api/stats?days=30

import { timingSafeEqual } from "node:crypto";
import { getStats, analyticsEnabled } from "../lib/analytics.js";

function tokenOk(req) {
  const expected = process.env.ADMIN_TOKEN || "";
  if (!expected) return false;
  const auth = req.headers.authorization || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Methode non autorisee." });
  }
  if (!process.env.ADMIN_TOKEN) {
    return res.status(503).json({ error: "ADMIN_TOKEN non configure sur le serveur." });
  }
  if (!tokenOk(req)) {
    return res.status(401).json({ error: "Token invalide." });
  }
  if (!analyticsEnabled()) {
    return res.status(200).json({ enabled: false, error: "DATABASE_URL non configuree." });
  }

  const days = Number(new URL(req.url, "http://x").searchParams.get("days") || 30);
  try {
    const stats = await getStats(days);
    return res.status(200).json(stats);
  } catch (err) {
    console.error("stats:", err?.message || err);
    return res.status(500).json({ error: "Impossible de calculer les statistiques." });
  }
}
