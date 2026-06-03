// Construit le contexte injecte dans l'API a chaque requete.
// - Charge le system-prompt de style.
// - Charge le profil (public).
// - Charge les fiches de livrables et NE GARDE QUE celles marquees exposable: true.
// Pas de base vectorielle : corpus petit, on injecte tout (PoC).

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONTENT_DIR = join(ROOT, "content");
const LIVRABLES_DIR = join(CONTENT_DIR, "livrables");

// Mini parseur de frontmatter YAML (clefs simples : string, bool, liste inline).
// Suffisant pour les fiches ; pas de dependance externe.
function parseFrontmatter(raw) {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };

  const meta = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();

    // Liste inline : [a, b, c]
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, ""); // retire guillemets
      if (value === "true") value = true;
      else if (value === "false") value = false;
    }
    meta[key] = value;
  }
  return { meta, body: match[2].trim() };
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// Charge les fiches exposables. baseUrl sert a construire les liens de telechargement.
function loadFiches(baseUrl) {
  let files = [];
  try {
    files = readdirSync(LIVRABLES_DIR).filter(
      (f) => f.endsWith(".md") && !f.startsWith("_"),
    );
  } catch {
    return [];
  }

  const fiches = [];
  for (const file of files) {
    const { meta, body } = parseFrontmatter(safeRead(join(LIVRABLES_DIR, file)));
    if (meta.exposable !== true) continue; // GARDE-FOU : on ignore tout sauf exposable: true

    let lien = "";
    if (meta.fichier) {
      const url = `${baseUrl}/livrables/${meta.fichier}`;
      lien = `\nLien de telechargement (a proposer si pertinent) : [${meta.titre || meta.fichier}](${url})`;
    }

    fiches.push(
      [
        `### Livrable : ${meta.titre || file}`,
        `- Client : ${meta.client || "non precise"}`,
        meta.role ? `- Role : ${meta.role}` : "",
        meta.periode ? `- Periode : ${meta.periode}` : "",
        meta.type ? `- Type : ${meta.type}` : "",
        Array.isArray(meta.tags) && meta.tags.length
          ? `- Tags : ${meta.tags.join(", ")}`
          : "",
        "",
        body,
        lien,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return fiches;
}

// Renvoie { systemPrompt, corpus } ou corpus est le gros bloc cacheable.
export function buildContext(baseUrl = "") {
  const systemPrompt =
    safeRead(join(CONTENT_DIR, "system-prompt.md")) ||
    "Tu reponds a la place d'Alexandre Desailly a partir du corpus fourni.";

  const profil = safeRead(join(CONTENT_DIR, "profil.md"));
  const fiches = loadFiches(baseUrl);

  const corpus = [
    "# CORPUS (seule source de verite — ne rien inventer hors de ce contenu)",
    "",
    "## Profil",
    profil || "(profil non renseigne)",
    "",
    "## Livrables exposables publiquement",
    fiches.length
      ? fiches.join("\n\n---\n\n")
      : "(aucun livrable exposable pour le moment)",
  ].join("\n");

  return { systemPrompt, corpus };
}
