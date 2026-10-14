# Configuration publique Supabase (#112)

L'[architecture #111](architecture-supabase-offline-first.md) reste la référence : Edge Function HTTPS puis RPC PostgreSQL transactionnelle, Supabase Auth utilisateur et registre serveur, WorkManager/transport/Auth natifs Android. Room reste la source de vérité de la caisse. Le Web sert de prévisualisation ; cette issue n'ajoute aucun stockage ni moteur Web. Aucun SDK Supabase n'est nécessaire pour configurer le futur transport HTTPS Kotlin.

## Variables et environnements

La configuration est **optionnelle**. Sans les trois variables publiques, les paramètres responsable indiquent « Synchronisation non configurée ». Une configuration partielle/invalide désactive seulement les échanges et expose une raison expurgée. Le démarrage, les repositories, les paiements et l'impression ne consultent pas cette configuration et n'attendent aucun réseau.

| Variable                          | Valeur                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`               | Origine HTTPS du projet, sans chemin, identifiants, query ni fragment ; slash final accepté                   |
| `VITE_SUPABASE_PUBLISHABLE_KEY`   | Clé publique moderne `sb_publishable_...` ; aucun JWT legacy, secret ou token de session                      |
| `VITE_SUPABASE_ENVIRONMENT`       | `test` pour development/android-test ; `production` pour production                                           |
| `SAMHAIN_SUPABASE_PRODUCTION_URL` | URL de production confirmée séparément, dans l'environnement du build et de Gradle release ; jamais un secret |

Copier [.env.example](../.env.example) dans `.env.development.local` ou `.env.android-test.local` pour un **projet de test**, et dans `.env.production.local` pour un **projet distinct de production**. Renseigner les vraies valeurs depuis le projet Supabase prévu ; aucun identifiant réel n'est fourni dans le dépôt. Les fichiers locaux sont ignorés par Git. Ne pas placer la configuration réseau dans `.env` commun : Vite charge aussi les fichiers communs et les variables de processus ont priorité.

Une build production exige `VITE_SUPABASE_ENVIRONMENT=production` et une URL égale à `SAMHAIN_SUPABASE_PRODUCTION_URL`. Sans confirmation, ou si le marqueur est `test`, la configuration devient `invalid` et **aucun endpoint ni clé ne sont embarqués**. Aucun fallback vers un projet de test. En test, une URL égale à l'URL de production connue est également refusée. Le marqueur seul ne prouve pas l'identité du projet : l'URL de confirmation doit provenir de la configuration de release contrôlée. Sans configuration Supabase, une release locale reste autorisée sous les garde-fous métier existants.

Dans PowerShell, pour une release avec échanges configurés :

```powershell
# URL réelle validée par le responsable du déploiement, pas un projet de test.
$env:SAMHAIN_SUPABASE_PRODUCTION_URL = Read-Host 'Origine HTTPS du projet Supabase de production'
pnpm android:sync:production
# Conserver la même variable pour Gradle assembleRelease/bundleRelease.
```

## Transmission native et sécurité

Vite valide les entrées dans `src/config/supabase.ts`, n'expose pas automatiquement les `VITE_*`, et injecte uniquement le résultat expurgé. Il produit `dist/samhain-build.json` (schéma 1, mode et configuration publique). Capacitor copie ce fichier dans `android/app/src/main/assets/public/samhain-build.json`. Aucune variable Supabase brute n'est exposée via `import.meta.env` ; seul le flag de développement existant est explicitement autorisé hors production.

`SupabaseConfiguration.load(context)` lit ce même asset directement, sans WebView, appel réseau ni credential privé. Un asset absent, corrompu ou incompatible donne un état `invalid` sans exception vers le checkout. Le futur worker #35 consommera cet état ; #114 ajoutera **séparément** les sessions Auth natives chiffrées par Keystore. Il n'y a aucun getter de token vers JavaScript, stockage de session ou bridge réseau dans #112. Une configuration prête n'indique ni appareil enrôlé ni synchronisation réussie.

L'installateur natif copie la classe Kotlin, ses tests et `supabase-config.gradle` de façon idempotente. Gradle refuse en release les assets absents ou construits en mode test, et recontrôle l'URL de production configurée avec la variable du processus. Les builds Vite recherchent les clés `sb_secret_...` et les JWT `service_role` dans leurs sorties ; Gradle fait de même dans les ressources textuelles de release. Les erreurs ne contiennent jamais les valeurs détectées. Ne pas ajouter de secrets à des assets copiés, sources natives, archives ou logs : ces contrôles ne sont pas un coffre-fort ni un audit de tous les secrets possibles.

URL et clé publiable sont publiques dans le bundle/APK, conformément aux [types de clés Supabase](https://supabase.com/docs/guides/getting-started/api-keys). Elles ne prouvent pas l'identité de l'appareil. Le PIN responsable local n'authentifie pas le serveur ; aucune connexion Android → PostgreSQL n'est prévue.

## Serveur et issues suivantes

#113 créera les migrations versionnées et les droits du registre/journal. #36 fournira les Edge Functions `ledger-ingest-v1`, `legacy-import-v1` et `ledger-prefix-v1` suivant le contrat `samhain-sync/1` de #111, avec RPC atomique et contrôle d'habilitation. Aucun schéma, fonction ou déploiement n'est créé ici. Leurs paramètres et secrets sont à configurer exclusivement côté serveur, séparément pour chaque projet : clés privilégiées dans les secrets serveur, jamais dans `VITE_*`, l'APK ou une archive. Ne pas désactiver la validation Auth pour contourner une erreur de configuration.

#114 conserve la responsabilité de l'enrôlement, des refresh/access tokens et de la révocation ; #35 celle de l'outbox atomique pour les cinq kinds, des claims, retries et ACK vérifiés. La configuration n'ajoute ni périmètre organisation/festival inventé, ni identité de chaîne, ni statut financier. Elle ne modifie aucun snapshot, hash, numéro ou archive, et n'efface aucune donnée après ACK.

## Vérification

`pnpm test:run` couvre absence/partiel/HTTPS/clé/modes, la confirmation du projet de production, les sorties Vite expurgées et la détection des credentials privilégiés. Les tests applicatifs existants couvrent le checkout et l'impression locale. `SupabaseConfigurationTest` couvre le lecteur natif avec Robolectric ; exécuter `testDebugUnitTest` depuis `android/` avec JDK 21 et SDK Android. Avant distribution, vérifier les ressources réellement copiées, exécuter les garde-fous Gradle puis tester démarrage, vente et impression sur tablette sans réseau. Aucune connexion Supabase réelle ni impression USB n'est prouvée par les tests de configuration.
