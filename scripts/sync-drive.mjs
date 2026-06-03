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
// Types pris en charge :
//   - Google Docs   -> export markdown natif
//   - Google Slides -> export texte
//   - Google Sheets -> export CSV
//   - .md / .txt    -> repris tels quels
//   - PDF           -> texte extrait dans le corps + PDF copie en telechargement
//   - autres (docx, pptx, images...) -> copies en piece telechargeable
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
//   npm run sync:drive -- --prune # + supprime les fiches/pieces drive-* disparues du Drive
//   npm run sync:drive -- --dry   # simulation, n'ecrit rien

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { google } from "googleapis";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LIVRABLES_DIR = join(ROOT, "content", "livrables");
const PUBLIC_LIVRABLES_DIR = join(ROOT, "public", "livrables");

const CREDENTIALS_PATH =
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON || join(ROOT, "drive-credentials.json");
const FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");
const PRUNE = args.has("--prune");

// Champs de frontmatter qu'on PRESERVE entre deux syncs (tes reglages manuels).
// Le corps, lui, est toujours rafraichi depuis le Drive.
const CURATED_KEYS = ["exposable", "client", "role", "periode", "type", "tags"];

// Extension de fichier par defaut selon le type MIME (pieces telechargeables).
const MIME_EXT = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
};

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

function buildFiche({ meta, body }) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value === "" || value === undefined || value === null) continue;
    lines.push(`${key}: ${serializeValue(value)}`);
  }
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

// Extraction de texte PDF (optionnelle : si pdf-parse est installe).
let pdfParse = null;
try {
  pdfParse = require("pdf-parse");
} catch {
  // pdf-parse absent : on copiera quand meme le PDF en piece telechargeable.
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

// Liste (recursive) les fichiers du dossier, en descendant dans les sous-dossiers.
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

async function exportText(drive, fileId, mimeType) {
  const res = await drive.files.export(
    { fileId, mimeType },
    { responseType: "text" },
  );
  return res.data;
}

async function downloadBinary(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(res.data);
}

// Recupere le contenu d'un fichier Drive sous forme { body, attachment }.
// attachment = { buffer, ext } si le document doit aussi etre telechargeable.
async function fetchContent(drive, file) {
  const mt = file.mimeType;

  if (mt === "application/vnd.google-apps.document") {
    return { body: await exportText(drive, file.id, "text/markdown"), attachment: null };
  }
  if (mt === "application/vnd.google-apps.presentation") {
    return { body: await exportText(drive, file.id, "text/plain"), attachment: null };
  }
  if (mt === "application/vnd.google-apps.spreadsheet") {
    const csv = await exportText(drive, file.id, "text/csv");
    return { body: "```csv\n" + csv.trim() + "\n```", attachment: null };
  }
  if (mt === "text/markdown" || mt === "text/plain" || mt === "text/csv") {
    const res = await drive.files.get(
      { fileId: file.id, alt: "media", supportsAllDrives: true },
      { responseType: "text" },
    );
    return { body: res.data, attachment: null };
  }
  if (mt === "application/pdf") {
    const buffer = await downloadBinary(drive, file.id);
    let body = "_(PDF — installe `pdf-parse` pour extraire le texte automatiquement.)_";
    if (pdfParse) {
      try {
        const parsed = await pdfParse(buffer);
        body = (parsed.text || "").trim() || "_(PDF sans texte extractible — voir le telechargement.)_";
      } catch {
        body = "_(Echec d'extraction du texte PDF — voir le telechargement.)_";
      }
    }
    return { body, attachment: { buffer, ext: ".pdf" } };
  }

  // Autres binaires (docx, pptx, images...) : copies en piece telechargeable.
  const ext = MIME_EXT[mt] || extname(file.name) || ".bin";
  const buffer = await downloadBinary(drive, file.id);
  return {
    body: `_(Document « ${file.name} » — disponible en telechargement.)_`,
    attachment: { buffer, ext },
  };
}

async function main() {
  const drive = await getDrive();
  if (!existsSync(LIVRABLES_DIR)) mkdirSync(LIVRABLES_DIR, { recursive: true });
  if (!existsSync(PUBLIC_LIVRABLES_DIR)) mkdirSync(PUBLIC_LIVRABLES_DIR, { recursive: true });

  console.log(`Lecture du dossier Drive ${FOLDER_ID}...`);
  if (!pdfParse) {
    console.log("Note : pdf-parse absent — les PDF seront telechargeables mais sans texte extrait (npm install).");
  }
  const files = await listFiles(drive, FOLDER_ID);
  console.log(`${files.length} fichier(s) trouve(s).`);

  const seenFiches = new Set();
  const seenAssets = new Set();
  let written = 0;

  for (const file of files) {
    const filename = `drive-${file.id}.md`;
    const dest = join(LIVRABLES_DIR, filename);
    seenFiches.add(filename);

    let result;
    try {
      result = await fetchContent(drive, file);
    } catch (err) {
      console.log(`  ! erreur sur « ${file.name} » : ${err.message}`);
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
      if (prev.titre) meta.titre = prev.titre;
    }

    // Piece telechargeable (PDF / binaire) -> public/livrables + meta.fichier.
    if (result.attachment) {
      const assetName = `drive-${file.id}${result.attachment.ext}`;
      meta.fichier = assetName;
      seenAssets.add(assetName);
      if (!DRY) {
        writeFileSync(join(PUBLIC_LIVRABLES_DIR, assetName), result.attachment.buffer);
      }
    }

    meta.source = "google-drive";
    meta.drive_id = file.id;
    meta.synced = new Date().toISOString().slice(0, 10);

    const content = buildFiche({ meta, body: result.body });
    if (!DRY) writeFileSync(dest, content, "utf8");
    console.log(
      `  - ${file.name} -> ${filename}` +
        (result.attachment ? ` (+ ${meta.fichier})` : "") +
        ` (exposable: ${meta.exposable})`,
    );
    written++;
  }

  // Orphelins : fiches/pieces drive-* qui ne sont plus dans le Drive.
  const orphanFiches = readdirSync(LIVRABLES_DIR).filter(
    (f) => f.startsWith("drive-") && f.endsWith(".md") && !seenFiches.has(f),
  );
  const orphanAssets = existsSync(PUBLIC_LIVRABLES_DIR)
    ? readdirSync(PUBLIC_LIVRABLES_DIR).filter(
        (f) => f.startsWith("drive-") && !seenAssets.has(f),
      )
    : [];
  for (const orphan of [...orphanFiches, ...orphanAssets]) {
    const base = orphanFiches.includes(orphan) ? LIVRABLES_DIR : PUBLIC_LIVRABLES_DIR;
    if (PRUNE && !DRY) {
      unlinkSync(join(base, orphan));
      console.log(`  - supprime (orphelin) : ${orphan}`);
    } else {
      console.log(
        `  - orphelin (plus dans le Drive) : ${orphan}${PRUNE ? "" : "  [--prune pour supprimer]"}`,
      );
    }
  }

  console.log(
    `\nTermine. ${written} synchronise(s), ${orphanFiches.length + orphanAssets.length} orphelin(s).` +
      (DRY ? " (simulation, rien ecrit)" : ""),
  );
  console.log(
    "Pense a marquer `exposable: true` dans les fiches que tu veux rendre publiques, puis commit.",
  );
}

main().catch((err) => {
  console.error("Echec du sync :", err.message || err);
  process.exit(1);
});
