# Règles de revue d'Ask Desailly

Référentiel lu par l'agent de revue à chaque PR. Alex l'enrichit à chaque faux positif ou oubli constaté : c'est ce fichier qui fait progresser la revue, pas le prompt.

Contexte : clone conversationnel public d'Alexandre Desailly. Page statique (`public/`), fonctions Vercel (`api/chat.js`, `api/track.js`, `api/stats.js`), appel Claude côté serveur, corpus de fichiers Markdown (`content/`), statistiques Postgres optionnelles, tableau de bord `/admin` protégé par `ADMIN_TOKEN`. Ni lint, ni tests, ni CI : la revue est la seule vérification.

## Ce que l'agent cherche, par ordre de gravité

| Gravité | Exemples propres à Ask Desailly |
|---|---|
| **Bloquant** | Clé `ANTHROPIC_API_KEY`, `ADMIN_TOKEN`, `DATABASE_URL`, `GITHUB_TOKEN` ou fichier `drive-credentials.json` dans le dépôt ou dans `public/` ; appel à l'API Anthropic depuis le navigateur ; fiche de `content/livrables/` passée à `exposable: true` alors qu'elle cite un client réel, une donnée sous NDA ou un tarif non public ; garde-fou `meta.exposable !== true` de `lib/corpus.js` affaibli ; `writeFiche` de `scripts/lib/fiche.mjs` qui crée une fiche autrement qu'en `exposable: false` ; `api/stats.js` accessible sans comparaison `timingSafeEqual` du jeton ; IP stockée en clair au lieu du hash salé de `lib/analytics.js` |
| **Important** | Rate limiting de `api/chat.js` contourné ou relevé sans justification (budget API) ; `MAX_TOKENS`, `MAX_HISTORY` ou `MAX_QUESTION_LEN` augmentés sans plafond ; rôle de l'historique client non filtré (injection d'un message `assistant` ou `system`) ; `innerHTML` alimenté sans passer par `esc()` ou `renderMarkdown()` (XSS, y compris dans `/admin` qui affiche les questions des visiteurs) ; garde-fous de `content/system-prompt.md` (vérité, confidentialité) supprimés ou affaiblis ; nouveau contenu injecté dans le prompt système depuis une source extérieure (README GitHub, Drive) sans borne de taille ; fichier déposé dans `public/livrables/` sans fiche `exposable: true` correspondante (servi publiquement quand même) |
| **Mineur** | Mention RGPD du pied de page non mise à jour alors que la collecte change ; variable d'environnement ajoutée sans entrée dans `.env.example` ; README non mis à jour ; ton du clone incohérent avec `content/profil.md` |

## Ce que l'agent ne commente pas

- Les préférences de style sans conséquence.
- Le code non modifié par la PR, sauf si le changement le casse.
- Il n'y a pas de CI : l'agent cite seulement ce qu'il a vérifié lui-même.

## Filtre anti faux positifs

Un constat n'est publié que si l'agent a :
1. relu le code autour du diff (appelants, `lib/corpus.js`, `lib/analytics.js`, fiche concernée) ;
2. décrit un scénario concret de défaillance (« un visiteur qui envoie un historique forgé obtient… », « la fiche X part dans le corpus public avec le nom du client… ») ;
3. vérifié qu'aucun garde-fou existant ne le couvre déjà.

Sinon, le constat est écarté ou reformulé en question.

## Faux positifs connus (à ne plus signaler)

- `sk-ant-xxxxxxxxxxxxxxx` dans `.env.example` et `sk-ant-...` dans le README : modèles, pas des clés.
- Questions des visiteurs conservées telles quelles : voulu (leads), documenté dans le README et en pied de page.
- Photo `public/assets/photo.png` servie publiquement : utilisée par `/admin`, choix assumé.
