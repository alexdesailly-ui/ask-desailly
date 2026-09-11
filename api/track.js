// TRACK — enregistre une visite (page vue) avec sa provenance.
// Appele par le front au chargement (sendBeacon). Repond toujours 204 :
// l'analytics ne doit jamais degrader l'experience visiteur.
// Sans DATABASE_URL, ne fait rien.

import { waitUntil } from "@vercel/functions";
import { logVisit, analyticsEnabled } from "../lib/analytics.js";

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
    return res.status(405).end();
  }
  res.setHeader("Cache-Control", "no-store");
  if (!analyticsEnabled()) return res.status(204).end();

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body && typeof body === "object" ? body : {};
  if (body.type && body.type !== "visit") return res.status(204).end();

  background(logVisit(req, body));
  return res.status(204).end();
}
