# Ask Desailly — clone numerique conversationnel

Vitrine professionnelle : un agent conversationnel qui repond **a la place
d'Alexandre Desailly** (consultant management & SI, Product Owner / chef de
projet IT / architecte fonctionnel), dans son style, **uniquement** a partir
d'un corpus qu'il fournit — et qui propose ses livrables quand c'est pertinent.

- Hebergement : **Vercel** (statique + fonction serverless), gratuit, HTTPS, 24/7.
- Modele : **Claude Sonnet 4.6** (`claude-sonnet-4-6`), appele cote serveur.
- La cle API n'est **jamais** exposee au navigateur (variable d'environnement).
- Reponses bornees au corpus : pas d'invention, garde-fous de confidentialite.

---

## Architecture (4 couches)

| Couche | Ou | Role |
|---|---|---|
| **Contenu** | `content/` + `public/livrables/` | Parcours + fiches de livrables (que tu remplis a la main) + fichiers telechargeables. |
| **Connaissance** | `lib/corpus.js` | Charge le contenu, ne garde que `exposable: true`, construit le contexte injecte. Pas de base vectorielle (corpus petit). |
| **Cerveau** | `api/chat.js` | Fonction serverless : assemble style + corpus + garde-fous + question, appelle Claude, renvoie la reponse. Rate limiting inclus. |
| **Presentation** | `public/` | Page chat responsive, sobre et pro. |

```
ask-desailly/
├── public/                 # servi au navigateur
│   ├── index.html          # page chat
│   ├── styles.css
│   ├── app.js              # appelle /api/chat (aucune cle ici)
│   ├── assets/photo.svg    # avatar placeholder (remplace par ta photo)
│   └── livrables/          # fichiers telechargeables -> URL /livrables/<fichier>
├── api/
│   └── chat.js             # fonction serverless (cle API ici, cote serveur)
├── lib/
│   └── corpus.js           # chargement + filtre exposable + contexte
├── content/                # CE QUE TU REMPLIS A LA MAIN
│   ├── profil.md           # ta bio (public)
│   ├── system-prompt.md    # ton style + garde-fous
│   └── livrables/          # une fiche .md par livrable
│       ├── _TEMPLATE.md
│       └── livrable-0X.md  # exemples a remplacer
├── .env.example
├── vercel.json
├── package.json
└── README.md
```

---

## 1. Lancer en local

Prerequis : Node.js >= 18.

```bash
npm install

# Configure la cle API en local (NE PAS commiter .env.local)
cp .env.example .env.local
# puis edite .env.local et colle ta cle ANTHROPIC_API_KEY

# Lance le serveur de dev Vercel (sert le statique + la fonction /api/chat)
npx vercel dev
```

Ouvre l'URL affichee (par defaut http://localhost:3000).

> `vercel dev` charge automatiquement `.env.local`. Si tu n'utilises pas la CLI
> Vercel, exporte la variable a la main : `export ANTHROPIC_API_KEY=sk-ant-...`

---

## 2. Configurer la cle API (production)

La cle vit **uniquement** cote serveur, jamais dans le code public.

Sur Vercel : **Project → Settings → Environment Variables**
- Name : `ANTHROPIC_API_KEY`
- Value : ta cle (https://console.anthropic.com/ → API Keys)
- Environments : Production (+ Preview si tu veux)

Variables optionnelles : `CLAUDE_MODEL`, `RATE_LIMIT_MAX`,
`RATE_LIMIT_WINDOW_MS`, `GITHUB_USERNAME`, `GITHUB_CACHE_MS`, `GITHUB_TOKEN`
(voir `.env.example`).

### Activite GitHub publique (projets en cours)

La fonction recupere automatiquement les depots **publics** de `GITHUB_USERNAME`
(defaut `alexdesailly-ui`), tries par activite recente, avec un extrait de README
des projets les plus actifs, et les injecte dans le corpus. Le clone peut ainsi
repondre a « sur quoi tu travailles en ce moment ? ».

- Aucune cle requise : l'API publique GitHub suffit. `GITHUB_TOKEN` est **facultatif**
  (uniquement pour relever la limite de taux si besoin).
- Resultat mis en cache en memoire ~30 min (`GITHUB_CACHE_MS`).
- Si la recuperation echoue, le chat continue normalement (le bloc est simplement omis).

---

## 3. Deployer

### Option A — via le dashboard (recommande)
1. Push ce repo sur GitHub.
2. Sur https://vercel.com → **New Project** → importe le repo.
3. Framework Preset : **Other** (rien a configurer, `vercel.json` suffit).
4. Ajoute la variable `ANTHROPIC_API_KEY` (etape 2).
5. **Deploy**. Chaque `git push` redeploie automatiquement.

### Option B — via la CLI
```bash
npx vercel            # premier deploiement (preview)
npx vercel --prod     # mise en production
```

### Domaine perso
Vercel → **Project → Settings → Domains** → ajoute ton domaine et suis les
instructions DNS. HTTPS est gere automatiquement.

---

## 4. Ajouter un livrable

1. **Cree la fiche** : copie `content/livrables/_TEMPLATE.md` en
   `content/livrables/mon-livrable.md`.
2. **Renseigne le frontmatter** :
   - `exposable: true` pour qu'il entre dans le corpus public (sinon ignore).
   - `client:` toujours **anonymise** si NDA (`"un grand groupe d'assurance"`).
   - `fichier:` nom du document telechargeable (optionnel).
3. **Depose le fichier** (si `fichier:` renseigne) dans `public/livrables/`.
   Il sera accessible a `/livrables/<nom-du-fichier>`.
4. **Push** → Vercel redeploie. La prochaine reponse du clone en tient compte.

> Mise a jour 100 % manuelle et assumee : fiche + fichier + push = a jour.

### Alimenter depuis Google Drive (sync a la demande)

Plutot que de creer les fiches a la main, tu peux deposer tes documents dans un
dossier Drive dedie et lancer une synchro qui les convertit en fiches markdown.

**Mise en place (une fois) :**

1. Cree un dossier Drive dedie, ex. `Corpus clone`. C'est ton back-office :
   tout ce que tu y mets devient candidat au corpus (mais reste prive par defaut).
2. Cree un **compte de service Google** (console.cloud.google.com → API & Services
   → Credentials → Service Account), active l'**API Google Drive**, telecharge la
   cle JSON et place-la dans `drive-credentials.json` (deja gitignore, jamais commite).
3. **Partage** le dossier Drive avec l'email du compte de service (droit Lecteur).
4. Recopie l'id du dossier (dans son URL `drive.google.com/drive/folders/<ID>`)
   dans `DRIVE_FOLDER_ID` (voir `.env.example`).

**A chaque mise a jour :**

```bash
npm install            # une fois, pour installer googleapis
npm run sync:drive     # aspire le Drive -> content/livrables/drive-*.md
# Options :
npm run sync:drive -- --dry     # simulation, n'ecrit rien
npm run sync:drive -- --prune   # supprime aussi les fiches dont le Doc a disparu du Drive
```

Le script gere **tous les types** : Google Docs → markdown, Google Slides →
texte, Google Sheets → CSV, fichiers `.md`/`.txt` repris tels quels, **PDF**
(texte extrait dans la fiche + PDF rendu telechargeable), et les autres binaires
(docx, pptx, images...) copies en piece telechargeable. **Garde-fou** : chaque
nouvelle fiche arrive en `exposable: false` —
elle n'entre PAS dans le corpus public tant que tu n'as pas bascule le flag a la
main. Re-lancer la synchro **ne touche pas** a tes reglages (`exposable`,
`client`, `role`, `tags`, titre retravaille...) : seul le corps est rafraichi.

> Le sync est un outil **local** : le site en production ne lit jamais ton Drive.
> Workflow type : `sync:drive` → relis et marque `exposable: true` → `push`.

#### Deux pompes, une seule sortie

Le connecteur Google Drive de Claude **ne peut pas** alimenter le site en direct
(c'est une capacite cote session, pas un runtime dispo pour une app Vercel
publique). Peu importe la voie choisie, le corpus reste des **fichiers
committes**. On a donc deux facons de remplir `content/livrables/`, qui
produisent une sortie **strictement identique** (meme garde-fou, meme nommage,
via `scripts/lib/fiche.mjs`) :

- **Script `sync:drive`** (self-serve) — tu le lances seul, scriptable, cron-able.
  Necessite un compte de service Google.
- **Import ad hoc via le connecteur** — en session, demande a Claude d'importer
  tel(s) document(s) : il lit le Drive via le connecteur et ecrit les fiches avec
  la meme logique. Zero compte de service, mais ponctuel (pas automatisable).

Les deux cohabitent : script pour le recurrent, connecteur pour le coup par coup.

---

## 5. Ajuster le style / les garde-fous

Tout est dans `content/system-prompt.md` (identite, registres, regle de verite,
confidentialite). Edite, push, redeploie.

---

## Garde-fous (rappel)

- Seules les fiches `exposable: true` entrent dans le corpus.
- Le system prompt interdit toute invention et impose les formulations
  anonymisees ; si l'info n'est pas dans le corpus, le clone dit qu'il ne sait pas.
- Ne mets **jamais** de donnee confidentielle dans `content/profil.md` (toujours
  considere public) ni dans une fiche `exposable: true`.

## Securite / budget

- Cle API cote serveur uniquement.
- Rate limiting par IP dans `api/chat.js` (defaut : 12 req/min) pour proteger le
  budget API. Ajustable via variables d'environnement.
- `max_tokens` et taille d'historique bornes ; prompt caching active sur le
  corpus pour reduire le cout.
