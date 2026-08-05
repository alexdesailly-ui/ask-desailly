// SYNC DRIVE -> CORPUS (a la demande)
// Aspire un dossier Google Drive dedie et ecrit chaque document en fiche
// markdown dans content/livrables/, pret a etre relu par lib/corpus.js.
//
// C'est la pompe "self-serve" : tu la lances seul, elle est scriptable/cron-able.
// La logique d'ecriture (garde-fou exposable, preservation des reglages,
// nommage) vit dans scripts/lib/fiche.mjs et est partagee avec l'import ad hoc
// que Claude peut faire via le connecteur Google Drive en session.
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

import { readFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { google } from "googleapis";
import {
  writeFiche,
  MIME_EXT,
  LIVRABLES_DIR,
  PUBLIC_LIVRABLES_DIR,
  ROOT,
} from "./lib/fiche.mjs";
import { extname } from "node:path";

const require = createRequire(import.meta.url);

const CREDENTIALS_PATH =
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON || join(ROOT, "drive-credentials.json");
const FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");
const PRUNE = args.has("--prune");

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
  const res = await drive.files.export({ fileId, mimeType }, { responseType: "text" });
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
        body =
          (parsed.text || "").trim() ||
          "_(PDF sans texte extractible — voir le telechargement.)_";
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

  console.log(`Lecture du dossier Drive ${FOLDER_ID}...`);
  if (!pdfParse) {
    console.log(
      "Note : pdf-parse absent — les PDF seront telechargeables mais sans texte extrait (npm install).",
    );
  }
  const files = await listFiles(drive, FOLDER_ID);
  console.log(`${files.length} fichier(s) trouve(s).`);

  const seenFiches = new Set();
  const seenAssets = new Set();
  let written = 0;

  for (const file of files) {
    let result;
    try {
      result = await fetchContent(drive, file);
    } catch (err) {
      console.log(`  ! erreur sur « ${file.name} » : ${err.message}`);
      continue;
    }

    // Ecriture via la logique partagee (garde-fou + preservation).
    const { fiche, asset, exposable } = writeFiche({
      id: file.id,
      title: file.name,
      body: result.body,
      attachment: result.attachment,
      dry: DRY,
    });
    seenFiches.add(fiche);
    if (asset) seenAssets.add(asset);

    console.log(
      `  - ${file.name} -> ${fiche}` +
        (asset ? ` (+ ${asset})` : "") +
        ` (exposable: ${exposable})`,
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
