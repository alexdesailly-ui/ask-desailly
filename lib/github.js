// Recupere l'activite GitHub publique pour que le clone puisse parler de ce sur
// quoi je travaille EN CE MOMENT. Lecture seule, API publique, aucun secret requis.
// - Depots tries par activite recente + extrait de README des projets actifs.
// - Cache en memoire (TTL) pour rester frais sans spammer l'API ni ralentir le chat.
// - Optionnel : GITHUB_TOKEN (env) pour une limite de taux plus haute.

const USERNAME = process.env.GITHUB_USERNAME || "alexdesailly-ui";
const TTL_MS = Number(process.env.GITHUB_CACHE_MS || 30 * 60 * 1000); // 30 min
const MAX_REPOS = 8; // depots listes
const MAX_READMES = 4; // depots dont on lit le README
const README_MAX = 1200; // caracteres par README

let cache = { ts: 0, text: "" };

function ghHeaders() {
  const h = {
    "User-Agent": "ask-desailly-clone",
    Accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function fetchReadme(repo) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${USERNAME}/${repo}/readme`,
      { headers: { ...ghHeaders(), Accept: "application/vnd.github.raw" } },
    );
    if (!res.ok) return "";
    let txt = await res.text();
    txt = txt.replace(/\r/g, "").trim();
    if (txt.length > README_MAX) txt = txt.slice(0, README_MAX) + " […]";
    return txt;
  } catch {
    return "";
  }
}

// Renvoie un bloc Markdown (ou "" si indisponible). Jamais d'exception propagee.
export async function fetchGithubContext() {
  const now = Date.now();
  if (cache.text && now - cache.ts < TTL_MS) return cache.text;

  try {
    const res = await fetch(
      `https://api.github.com/users/${USERNAME}/repos?per_page=100&sort=updated&type=owner`,
      { headers: ghHeaders() },
    );
    if (!res.ok) {
      // En cas d'echec (rate limit, etc.), on garde l'ancien cache s'il existe.
      return cache.text || "";
    }
    let repos = await res.json();
    if (!Array.isArray(repos)) return cache.text || "";

    repos = repos
      .filter((r) => !r.fork && !r.archived)
      .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
      .slice(0, MAX_REPOS);

    if (!repos.length) {
      cache = { ts: now, text: "" };
      return "";
    }

    const lignes = repos.map((r) => {
      const maj = (r.pushed_at || "").slice(0, 10);
      const lang = r.language ? ` · ${r.language}` : "";
      const topics =
        Array.isArray(r.topics) && r.topics.length
          ? ` · themes : ${r.topics.join(", ")}`
          : "";
      const desc = r.description ? ` — ${r.description}` : "";
      const home = r.homepage ? ` · ${r.homepage}` : "";
      return `- **${r.name}**${lang} (maj ${maj})${desc}${topics}${home}`;
    });

    // README des projets les plus actifs pour expliquer concretement le contenu.
    const readmes = [];
    for (const r of repos.slice(0, MAX_READMES)) {
      const rm = await fetchReadme(r.name);
      if (rm) readmes.push(`#### ${r.name}\n${rm}`);
    }

    const text = [
      `## Activite GitHub publique (github.com/${USERNAME})`,
      `_Recupere automatiquement le ${new Date(now).toISOString().slice(0, 10)} — reflet de mes projets en cours._`,
      "",
      "### Depots publics recents (tries par activite)",
      ...lignes,
      readmes.length ? "\n### Apercu des projets actifs (extraits de README)" : "",
      ...readmes,
    ]
      .filter((l) => l !== "")
      .join("\n");

    cache = { ts: now, text };
    return text;
  } catch {
    return cache.text || "";
  }
}
