// SYNC DRIVE -> CORPUS (a la demande)
// Aspire un dossier Google Drive dedie et ecrit chaque document en markdown
// dans content/livrables/, pret a etre relu par lib/corpus.js.
//
// Philosophie (alignee sur le reste du projet) :
//   - Le corpus committe reste la SEULE source de verite pour le site public.
//   - GARDE-FOU : tout nouveau document arrive avec `exposable: false`.
//     Rien n'est public tant qu'Alexandre n'a pas bascule le flag a la main.
//   - Re-lançable sans danger : on conserve les reglages de frontmatter deja
//     poses (exposable, client, role, tags...) ; seul le corps est rafraichi.
//
// Pre-requis :
//   1. Un compte de service Google (JSON) avec l'API Drive activee.
//   2. Le dossier Drive "Corpus clone" PARTAGE avec l'email du compte de service.
//   3. Variables d'env (voir .env.example) :
//        GOOGLE_SERVICE_ACCOUNT_JSON  chemin du JSON (defaut ./drive-credentials.json)
//        DRIVE_FOLDER_ID              id du dossier Drive a synchroniser
//
// Usage :
//   npm run sync:drive            # synchronise
//   npm run sync:drive -- --prune # + supprime les fiches drive-* disparues du Drive
//   npm run sync:drive -- --dry   # simulation, n'ecrit rien

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LIVRABLES_DIR = join(ROOT, "content", "livrables");

const CREDENTIALS_PATH =
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON || join(ROOT, "drive-credentials.json");
const FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");
const PRUNE = args.has("--prune");

// Champs de frontmatter qu'on PRESERVE entre deux syncs (tes reglages manuels).
// Le corps, lui, est toujours rafraichi depuis le Drive.
const CURATED_KEYS = ["exposable", "client", "role", "periode", "type", "fichier", "tags"];

// --- Mini parseur / serialiseur de frontmatter (meme convention que lib/corpus.js) ---
function parseFrontmatter(raw) {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    // On retire un eventuel commentaire de fin de ligne (# ...) hors guillemets.
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
  // On met des guillemets si la valeur contient des caracteres sensibles.
  if (/[:#"']/.test(String(value))) return JSON.stringify(String(value));
  return String(value);
}

function buildFiche({ meta, body }) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value === "" || value === undefined || value === null) continue;
    lines.push(`${key}: ${serializeValue(value)}`);
  }
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

// --- Drive ---
async function getDrive() {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Credentials introuvables : ${CREDENTIALS_PATH}\n` +
        `Renseigne GOOGLE_SERVICE_ACCOUNT_JSON ou place le JSON du compte de service ici.`,
    );
  }
  if (!FOLDER_ID) {
    throw new Error("DRIVE_FOLDER_ID manquant (id du dossier Drive a synchroniser).");
  }
  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version: "v3", auth });
}

// Liste (recursive) les fichiers du dossier, en ignorant les sous-dossiers vides.
async function listFiles(drive, folderId) {
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime)",
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files || []) {
      if (f.mimeType === "application/vnd.google-apps.folder") {
        out.push(...(await listFiles(drive, f.id)));
      } else {
        out.push(f);
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

// Recupere le contenu markdown d'un fichier Drive (ou null si type non gere).
async function fetchMarkdown(drive, file) {
  // Google Docs -> export markdown natif.
  if (file.mimeType === "application/vnd.google-apps.document") {
    const res = await drive.files.export(
      { fileId: file.id, mimeType: "text/markdown" },
      { responseType: "text" },
    );
    return res.data;
  }
  // Fichiers texte / markdown deja prets.
  if (file.mimeType === "text/markdown" || file.mimeType === "text/plain") {
    const res = await drive.files.get(
      { fileId: file.id, alt: "media", supportsAllDrives: true },
      { responseType: "text" },
    );
    return res.data;
  }
  // Autres (PDF, slides, sheets...) : non geres pour l'instant.
  return null;
}

function main() {
  return getDrive()
    .then(async (drive) => {
      if (!existsSync(LIVRABLES_DIR)) mkdirSync(LIVRABLES_DIR, { recursive: true });

      console.log(`Lecture du dossier Drive ${FOLDER_ID}...`);
      const files = await listFiles(drive, FOLDER_ID);
      console.log(`${files.length} fichier(s) trouve(s).`);

      const seen = new Set();
      let written = 0;
      let skipped = 0;

      for (const file of files) {
        const filename = `drive-${file.id}.md`;
        const dest = join(LIVRABLES_DIR, filename);
        seen.add(filename);

        const body = await fetchMarkdown(drive, file);
        if (body == null) {
          console.log(`  - ignore (type non gere) : ${file.name} [${file.mimeType}]`);
          skipped++;
          continue;
        }

        // Reglages preserves si la fiche existe deja, sinon valeurs par defaut.
        const meta = {
          titre: file.name,
          exposable: false, // GARDE-FOU : jamais public automatiquement.
        };
        if (existsSync(dest)) {
          const { meta: prev } = parseFrontmatter(readFileSync(dest, "utf8"));
          for (const key of CURATED_KEYS) {
            if (prev[key] !== undefined) meta[key] = prev[key];
          }
          if (prev.titre) meta.titre = prev.titre; // on respecte un titre retravaille
        }
        meta.source = "google-drive";
        meta.drive_id = file.id;
        meta.synced = new Date().toISOString().slice(0, 10);

        const content = buildFiche({ meta, body });
        if (DRY) {
          console.log(`  - [dry] ${file.name} -> ${filename} (exposable: ${meta.exposable})`);
        } else {
          writeFileSync(dest, content, "utf8");
          console.log(`  - ${file.name} -> ${filename} (exposable: ${meta.exposable})`);
        }
        written++;
      }

      // Orphelins : fiches drive-* qui ne sont plus dans le Drive.
      const orphans = readdirSync(LIVRABLES_DIR).filter(
        (f) => f.startsWith("drive-") && f.endsWith(".md") && !seen.has(f),
      );
      for (const orphan of orphans) {
        if (PRUNE && !DRY) {
          unlinkSync(join(LIVRABLES_DIR, orphan));
          console.log(`  - supprime (orphelin) : ${orphan}`);
        } else {
          console.log(`  - orphelin (plus dans le Drive) : ${orphan}${PRUNE ? "" : "  [--prune pour supprimer]"}`);
        }
      }

      console.log(
        `\nTermine. ${written} synchronise(s), ${skipped} ignore(s), ${orphans.length} orphelin(s).` +
          (DRY ? " (simulation, rien ecrit)" : ""),
      );
      console.log(
        "Pense a marquer `exposable: true` dans les fiches que tu veux rendre publiques, puis commit.",
      );
    })
    .catch((err) => {
      console.error("Echec du sync :", err.message || err);
      process.exit(1);
    });
}

main();
