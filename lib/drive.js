// SOURCE DYNAMIQUE — lit le dossier Google Drive a chaque requete (avec cache).
// Tout ce qui est dans le dossier DRIVE_FOLDER_ID (sous-dossiers compris) est
// PUBLIC : c'est le garde-fou. Les documents prives vivent hors de ce dossier.
// Lecture seule via un compte de service. Sans configuration, ou en cas d'echec,
// les fonctions renvoient [] et le corpus retombe sur content/livrables/.
//
// Variables d'env :
//   DRIVE_FOLDER_ID              id du dossier Drive public (dans son URL)
//   GOOGLE_SERVICE_ACCOUNT_JSON  JSON du compte de service : contenu brut, base64,
//                                ou chemin de fichier (dev local)
//   DRIVE_CACHE_MS               duree du cache memoire (defaut 10 min)

import { readFileSync } from "node:fs";
import { JWT } from "google-auth-library";

const FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";
const TTL_MS = Number(process.env.DRIVE_CACHE_MS || 10 * 60 * 1000);
const API = "https://www.googleapis.com/drive/v3/files";
const BODY_MAX = 6000; // caracteres de contenu injectes par document
const MAX_FILES = 40;

const FOLDER = "application/vnd.google-apps.folder";
const NATIVE = {
  "application/vnd.google-apps.document": "text/markdown",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

export const driveEnabled = () => Boolean(FOLDER_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

function loadCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
  if (raw.startsWith("{")) return JSON.parse(raw);
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 200) {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  }
  return JSON.parse(readFileSync(raw, "utf8"));
}

let jwt = null;
async function authHeaders() {
  if (!jwt) {
    const c = loadCredentials();
    jwt = new JWT({
      email: c.client_email,
      key: c.private_key,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
  }
  const { token } = await jwt.getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

async function driveFetch(url) {
  const res = await fetch(url, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`Drive ${res.status}`);
  return res;
}

async function listFolder(folderId, depth = 0) {
  const out = [];
  let pageToken = "";
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const fields = encodeURIComponent(
      "nextPageToken,files(id,name,mimeType,modifiedTime,description)",
    );
    const url =
      `${API}?q=${q}&fields=${fields}&pageSize=100&supportsAllDrives=true` +
      `&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const data = await (await driveFetch(url)).json();
    for (const f of data.files || []) {
      if (f.mimeType === FOLDER) {
        if (depth < 3) out.push(...(await listFolder(f.id, depth + 1)));
      } else {
        out.push(f);
      }
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return out;
}

// --- Liste des fichiers publics (cache) ---
let listCache = { ts: 0, files: [] };

export async function listPublicFiles() {
  if (!driveEnabled()) return [];
  const now = Date.now();
  if (listCache.ts && now - listCache.ts < TTL_MS) return listCache.files;
  try {
    const files = (await listFolder(FOLDER_ID))
      .sort((a, b) => (b.modifiedTime || "").localeCompare(a.modifiedTime || ""))
      .slice(0, MAX_FILES);
    listCache = { ts: now, files };
    return files;
  } catch (err) {
    console.error("Drive (liste) :", err?.message || err);
    return listCache.files; // ancien cache si dispo
  }
}

// --- Contenu texte d'un fichier (cache par id + date de modif) ---
const bodyCache = new Map();

async function pdfText(buffer) {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      return ((await parser.getText()).text || "").trim();
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch {
    return "";
  }
}

async function fetchBody(file) {
  const key = `${file.id}:${file.modifiedTime}`;
  if (bodyCache.has(key)) return bodyCache.get(key);

  let text = "";
  try {
    const mt = file.mimeType;
    if (NATIVE[mt]) {
      const url = `${API}/${file.id}/export?mimeType=${encodeURIComponent(NATIVE[mt])}`;
      text = await (await driveFetch(url)).text();
    } else if (mt === "application/pdf") {
      const url = `${API}/${file.id}?alt=media&supportsAllDrives=true`;
      text = await pdfText(Buffer.from(await (await driveFetch(url)).arrayBuffer()));
    } else if (mt.startsWith("text/")) {
      const url = `${API}/${file.id}?alt=media&supportsAllDrives=true`;
      text = await (await driveFetch(url)).text();
    }
  } catch (err) {
    console.error(`Drive (contenu ${file.name}) :`, err?.message || err);
  }
  text = text.replace(/\r/g, "").trim();
  if (text.length > BODY_MAX) text = text.slice(0, BODY_MAX) + " […]";
  bodyCache.set(key, text);
  return text;
}

const stripExt = (name) => name.replace(/\.[A-Za-z0-9]{2,5}$/, "");

// Fiches Markdown prêtes pour le corpus. baseUrl sert aux liens de telechargement.
export async function loadDriveFiches(baseUrl) {
  const files = await listPublicFiles();
  const fiches = [];
  for (const f of files) {
    const body = await fetchBody(f);
    const titre = stripExt(f.name);
    const lien = baseUrl
      ? `\nLien de telechargement (a proposer si pertinent) : [${titre}](${baseUrl}/api/livrable?id=${f.id})`
      : "";
    fiches.push(
      [
        `### Livrable : ${titre}`,
        f.modifiedTime ? `- Mis a jour : ${f.modifiedTime.slice(0, 10)}` : "",
        f.description ? `- Contexte : ${f.description}` : "",
        "",
        body || "_(contenu non lisible en texte — voir le telechargement)_",
        lien,
      ]
        .filter((l) => l !== "")
        .join("\n"),
    );
  }
  return fiches;
}

// Flux d'un fichier public pour le telechargement. null si l'id n'est pas autorise.
export async function openPublicFile(id) {
  const file = (await listPublicFiles()).find((f) => f.id === id);
  if (!file) return null;
  const native = NATIVE[file.mimeType];
  const url = native
    ? `${API}/${id}/export?mimeType=application%2Fpdf`
    : `${API}/${id}?alt=media&supportsAllDrives=true`;
  const res = await driveFetch(url);
  const name = native && !/\.pdf$/i.test(file.name) ? `${file.name}.pdf` : file.name;
  return {
    name,
    type: native ? "application/pdf" : file.mimeType,
    buffer: Buffer.from(await res.arrayBuffer()),
  };
}
