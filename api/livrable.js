// Telechargement d'un livrable du Drive public. Seuls les fichiers presents dans
// le dossier public (DRIVE_FOLDER_ID) sont servis : un id inconnu renvoie 404.

import { openPublicFile } from "../lib/drive.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Methode non autorisee." });
  }
  const id = String(req.query?.id || "");
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) {
    return res.status(400).json({ error: "Identifiant invalide." });
  }

  try {
    const file = await openPublicFile(id);
    if (!file) return res.status(404).json({ error: "Document introuvable." });
    res.setHeader("Content-Type", file.type);
    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).send(file.buffer);
  } catch (err) {
    console.error("Erreur livrable:", err?.message || err);
    return res.status(502).json({ error: "Document momentanement indisponible." });
  }
}
