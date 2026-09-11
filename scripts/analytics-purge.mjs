// PURGE ANALYTICS — retention des donnees (RGPD).
// Supprime les evenements plus vieux que N jours (defaut : 365).
//
// Usage :
//   DATABASE_URL=... npm run analytics:purge              # > 365 jours
//   DATABASE_URL=... npm run analytics:purge -- --days 180
//
// A lancer a la main de temps en temps, ou via une tache planifiee.

import { purgeOlderThan, analyticsEnabled } from "../lib/analytics.js";

const args = process.argv.slice(2);
const i = args.indexOf("--days");
const days = i >= 0 ? Number(args[i + 1]) : 365;

if (!analyticsEnabled()) {
  console.error("DATABASE_URL manquante : rien a purger.");
  process.exit(1);
}
if (!Number.isFinite(days) || days < 1) {
  console.error("--days doit etre un entier >= 1.");
  process.exit(1);
}

const n = await purgeOlderThan(days);
console.log(`${n} evenement(s) supprime(s) (plus vieux que ${days} jours).`);
