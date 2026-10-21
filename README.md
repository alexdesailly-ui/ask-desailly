# Ask Desailly — clone numerique conversationnel

Vitrine professionnelle : un agent conversationnel qui repond **a la place
d'Alexandre Desailly** (consultant management & SI, Product Owner / chef de
projet IT / architecte fonctionnel), dans son style, **uniquement** a partir
d'un corpus qu'il fournit — et qui propose ses livrables quand c'est pertinent.

- Hebergement : **Vercel** (statique + fonction serverless), gratuit, HTTPS, 24/7.
- Modele : **Claude Sonnet 5** (`claude-sonnet-5`), appele cote serveur. Runtime Node 20+.
- La cle API n'est **jamais** exposee au navigateur (variable d'environnement).
- Reponses bornees au corpus : pas d'invention, garde-fous de confidentialite.

---

## Architecture (5 couches)

| Couche | Ou | Role |
|---|---|---|
| **Contenu** | `content/` + `public/livrables/` | Parcours + fiches de livrables (a la main ou via le sync Drive) + fichiers telechargeables. |
| **Connaissance** | `lib/corpus.js` | Charge le contenu, ne garde que `exposable: true`, construit le contexte injecte. Pas de base vectorielle (corpus petit). |
| **Cerveau** | `api/chat.js` | Fonction serverless : assemble style + corpus + garde-fous + question, appelle Claude, renvoie la reponse. Rate limiting inclus. |
| **Presentation** | `public/` | Page chat responsive, chaleureuse (fond creme, corail doux, monogramme a la place de la photo). |
| **Statistiques** | `lib/analytics.js` + `api/track.js` + `api/stats.js` + `public/admin/` | Qui vient, d'ou, ce qu'on demande : visites, themes, intentions, leads. Tableau de bord `/admin` protege par token. Optionnel (actif si `DATABASE_URL`). |

```
ask-desailly/
├── public/                 # servi au navigateur
│   ├── index.html          # page chat
│   ├── styles.css
│   ├── app.js              # appelle /api/chat + ping de visite (aucune cle ici)
│   ├── admin/              # tableau de bord /admin (token requis)
│   ├── assets/photo.png    # ta photo (utilisee dans /admin uniquement)
│   └── livrables/          # fichiers telechargeables -> URL /livrables/<fichier>
├── api/
│   ├── chat.js             # fonction serverless (cle API ici, cote serveur)
│   ├── track.js            # enregistre une visite (provenance, UTM)
│   └── stats.js            # agregats pour /admin (ADMIN_TOKEN)
├── lib/
│   ├── corpus.js           # chargement + filtre exposable + contexte
│   ├── github.js           # activite GitHub publique (projets en cours)
│   └── analytics.js        # stockage Postgres, classification, statistiques
├── scripts/
│   ├── sync-drive.mjs      # Google Drive -> content/livrables (a la demande)
│   ├── analytics-purge.mjs # retention des statistiques
│   └── lib/fiche.mjs       # ecriture des fiches (garde-fou exposable)
├── content/                # CE QUE TU REMPLIS (a la main ou via le Drive)
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
`RATE_LIMIT_WINDOW_MS`, `GITHUB_USERNAME`, `GITHUB_CACHE_MS`, `GITHUB_TOKEN`,
et pour les statistiques `DATABASE_URL`, `ADMIN_TOKEN`, `IP_HASH_SALT`,
`CLASSIFIER_MODEL` (voir `.env.example`).

### Statistiques : qui vient, ce qu'on me demande (tableau de bord `/admin`)

Pour piloter la prospection, le site enregistre chaque visite et chaque
question, puis les classe. Tout est **desactive tant que `DATABASE_URL` n'est
pas renseignee** : sans base, le site fonctionne exactement comme avant.

**Mise en place (une fois, ~5 min) :**

1. **Base Postgres** : sur Vercel, *Project → Storage → Create Database → Neon*
   (gratuit). Vercel ajoute `DATABASE_URL` tout seul. La table est creee
   automatiquement au premier evenement.
2. **Token d'acces** : ajoute `ADMIN_TOKEN` (un long secret aleatoire, ex.
   `openssl rand -hex 24`) dans les variables d'environnement.
3. Optionnel : `IP_HASH_SALT` (sel du hash d'IP), `CLASSIFIER_MODEL` (defaut
   Haiku 4.5, qui classe chaque question).
4. Redeploie, puis ouvre **`https://ton-domaine/admin`** et saisis le token.

**Ce que tu vois :**

- **Trafic** : visites, visiteurs uniques, visiteurs revenus, appareils, pays et
  villes (geolocalisation fournie par Vercel, sans stocker l'IP).
- **Provenance** : sites referents (LinkedIn, Google…) et campagnes **UTM** — tague
  tes liens `?utm_source=linkedin&utm_campaign=post-sept` pour savoir quel post
  amene qui.
- **Ce qu'on demande** : chaque question est classee par **theme** (parcours,
  competences, missions, livrables, methode, IA & data, dispo/tarif, contact…)
  et par **intention** : *chaud* (veut recruter, missionner, un tarif, une dispo),
  *tiede* (evalue le profil), *froid* (curiosite).
- **Leads a rappeler** : intention chaude **ou** contact laisse dans la question
  (email / telephone extraits automatiquement).
- **Conversations** : le fil complet question → reponse, regroupe par visiteur,
  avec recherche et filtres. **Export CSV** pour ton CRM.
- **Sante / cout** : latence moyenne, erreurs, tokens consommes et part servie
  depuis le cache.

**Comment ca marche :** `api/chat.js` repond d'abord, puis journalise en tache
de fond (`waitUntil`) — zero latence ajoutee. `api/track.js` recoit le ping de
visite (`sendBeacon`). `api/stats.js` calcule les agregats (token obligatoire).
Les robots (LinkedInBot, Googlebot…) sont exclus des visites.

**RGPD (site public, visiteurs anonymes) :**

- L'IP n'est **jamais** stockee : uniquement un hash sale et tronque. Le
  user-agent est reduit a un type d'appareil. Les identifiants visiteur /
  conversation sont des aleas generes par le navigateur, sans donnee personnelle.
- Les questions sont conservees telles quelles (elles peuvent contenir un contact
  laisse volontairement par le visiteur). Une mention figure en pied de page.
- **Retention** : purge les evenements anciens avec
  `DATABASE_URL=... npm run analytics:purge -- --days 365`.
- Si tu veux aller plus loin (bandeau de consentement, registre de traitement),
  c'est a evaluer selon ton usage commercial des donnees.

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

### Source dynamique : le Drive lu en direct (recommande)

Le clone lit directement un dossier Drive a chaque conversation (cache 10 min) :
tu deposes ou modifies un document, le clone le sait sans commit ni redeploiement.
Le lien de telechargement passe par `/api/livrable?id=...`, qui ne sert que les
fichiers de ce dossier.

**Regle de confidentialite : tout ce qui est dans ce dossier est public.** Cree un
dossier dedie (ex. `Clone - public`) et n'y mets que des documents anonymises.

Mise en place : memes etapes 2 a 4 que ci-dessous (compte de service, partage du
dossier en Lecteur, id du dossier), puis dans Vercel > Settings > Environment
Variables : `DRIVE_FOLDER_ID` et `GOOGLE_SERVICE_ACCOUNT_JSON` (colle le contenu du
JSON, ou son base64). Types lus : Docs, Slides, Sheets, PDF (texte extrait), .md,
.txt. Les autres fichiers (docx, pptx...) sont telechargeables mais sans texte.
Le champ « description » du fichier Drive est repris comme contexte. Sans ces
variables, ou si le dossier est vide, le site retombe sur `content/livrables/`.

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

> Ce sync est un outil **local** (fiches committees). Pour une lecture en direct, voir la section precedente.
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
