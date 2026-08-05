// FICHE — logique partagee d'ecriture d'une fiche de corpus issue du Drive.
//
// Utilise a deux endroits, pour garantir une sortie STRICTEMENT identique :
//   - scripts/sync-drive.mjs        (sync self-serve via compte de service)
//   - un import ad hoc en session    (quand Claude lit le Drive via le connecteur)
//
// Regles invariantes, quelle que soit la pompe :
//   - GARDE-FOU : toute nouvelle fiche arrive en `exposable: false`.
//   - Re-ecriture non destructive : les reglages deja poses (exposable, client,
//     role, periode, type, tags, titre retravaille) sont PRESERVES ; seul le
//     corps est rafraichi depuis le Drive.
//   - Nommage stable par id Drive : drive-<id>.md (+ piece drive-<id>.<ext>).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..", "..");
export const LIVRABLES_DIR = join(ROOT, "content", "livrables");
export const PUBLIC_LIVRABLES_DIR = join(ROOT, "public", "livrables");

// Champs de frontmatter preserves entre deux ecritures (reglages manuels).
export const CURATED_KEYS = ["exposable", "client", "role", "periode", "type", "tags"];

// Extension de fichier par defaut selon le type MIME (pieces telechargeables).
export const MIME_EXT = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
};

// --- Frontmatter (meme convention que lib/corpus.js) ---
export function parseFrontmatter(raw) {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (!value.startsWith('"') && !value.startsWith("'") && !value.startsWith("[")) {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, "");
      if (value === "true") value = true;
      else if (value === "false") value = false;
    }
    meta[key] = value;
  }
  return { meta, body: match[2].trim() };
}

function serializeValue(value) {
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (/[:#"']/.test(String(value))) return JSON.stringify(String(value));
  return String(value);
}

export function buildFiche({ meta, body }) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value === "" || value === undefined || value === null) continue;
    lines.push(`${key}: ${serializeValue(value)}`);
  }
  lines.push("---", "", (body || "").trim(), "");
  return lines.join("\n");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Ecrit (ou rafraichit) une fiche de corpus a partir d'un document Drive.
//   id         : id Drive (clef de nommage stable)
//   title      : nom du document (devient `titre` si pas deja retravaille)
//   body       : contenu markdown/texte
//   attachment : { buffer, ext } si le doc doit aussi etre telechargeable
//   dry        : true = ne rien ecrire, juste calculer
// Retourne { fiche, asset, exposable, created }.
export function writeFiche({ id, title, body, attachment = null, dry = false }) {
  if (!existsSync(LIVRABLES_DIR)) mkdirSync(LIVRABLES_DIR, { recursive: true });
  if (attachment && !existsSync(PUBLIC_LIVRABLES_DIR)) {
    mkdirSync(PUBLIC_LIVRABLES_DIR, { recursive: true });
  }

  const filename = `drive-${id}.md`;
  const dest = join(LIVRABLES_DIR, filename);
  const created = !existsSync(dest);

  // GARDE-FOU + preservation des reglages existants.
  const meta = { titre: title, exposable: false };
  if (!created) {
    const { meta: prev } = parseFrontmatter(readFileSync(dest, "utf8"));
    for (const key of CURATED_KEYS) {
      if (prev[key] !== undefined) meta[key] = prev[key];
    }
    if (prev.titre) meta.titre = prev.titre;
  }

  let assetName = null;
  if (attachment) {
    assetName = `drive-${id}${attachment.ext}`;
    meta.fichier = assetName;
    if (!dry) writeFileSync(join(PUBLIC_LIVRABLES_DIR, assetName), attachment.buffer);
  }

  meta.source = "google-drive";
  meta.drive_id = id;
  meta.synced = today();

  if (!dry) writeFileSync(dest, buildFiche({ meta, body }), "utf8");
  return { fiche: filename, asset: assetName, exposable: meta.exposable, created };
}
