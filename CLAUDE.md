# Ask Desailly — consignes pour les agents

Lu à chaque exécution par les agents (revue de PR, correctifs `@claude`). Rester court.

## Le produit

Clone conversationnel public d'Alexandre Desailly : il répond à sa place, uniquement à partir du corpus de `content/`, et propose ses livrables. Page statique `public/`, fonctions Vercel `api/`, Claude appelé côté serveur, statistiques Postgres optionnelles et tableau de bord `/admin`.

## Commandes

| But | Commande |
|---|---|
| Installer | `npm ci` |
| Lancer en local | `npx vercel dev` (`.env.local` requis) |
| Vérifier avant de pousser | `node --check <fichier>` sur chaque `.js` / `.mjs` modifié, puis relire son diff (aucun lint ni test) |
| Synchroniser le Drive | `npm run sync:drive -- --dry` (compte de service requis, jamais en CI) |
| Purger les statistiques | `npm run analytics:purge -- --days 365` |

## Règles non négociables

1. **Clé API côté serveur uniquement.** Aucun secret (`ANTHROPIC_API_KEY`, `ADMIN_TOKEN`, `DATABASE_URL`, `GITHUB_TOKEN`, identifiants Google) dans le dépôt ni dans `public/`. Variables documentées dans `.env.example` sans valeur réelle.
2. **Corpus borné.** Seules les fiches `exposable: true` entrent dans le corpus ; une fiche nouvelle arrive toujours en `exposable: false`. Un agent ne bascule jamais ce champ : c'est la décision d'Alex.
3. **Confidentialité client.** Champ `client:` toujours anonymisé ; aucune donnée sous NDA dans `content/profil.md` ni dans une fiche exposable.
4. **Garde-fous du prompt.** Les règles de vérité et de confidentialité de `content/system-prompt.md` ne s'affaiblissent pas.
5. **RGPD.** L'IP n'est jamais stockée en clair (hash salé tronqué) ; toute nouvelle collecte met à jour la mention de pied de page.
6. **Budget.** Rate limiting, `MAX_TOKENS`, `MAX_HISTORY` et `MAX_QUESTION_LEN` restent bornés.
7. **Échappement.** Tout texte de visiteur ou du modèle injecté dans le DOM passe par `esc()` ou `renderMarkdown()`.

## Conventions

- Interface, messages de commit et documentation en français.
- Modules ES (`"type": "module"`), Node 20 ou plus.
- Ne jamais fusionner sur la branche par défaut, ne jamais déployer, ne jamais toucher à .github/workflows/ sans demande explicite d'Alex.
