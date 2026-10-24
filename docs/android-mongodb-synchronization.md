# Synchronisation financière Android vers l’API MongoDB — #134

La même outbox Room, le même `SyncEngine` et les mêmes workers transmettent désormais
les événements à l’API HTTPS. Vente, paiement, correction, clôture, catalogue local et
impression restent locaux. Le navigateur conserve IndexedDB et ne simule ni upload
Android, ni exécution après fermeture. Aucun déploiement n’est réalisé par cette issue.

## Configuration publique et compatibilité

Dans `.env.android-test.local`, définir ensemble :

```dotenv
# Exemples fictifs : remplacer par la destination de test réellement provisionnée.
VITE_SAMHAIN_API_URL=https://api-test.example.invalid
VITE_SAMHAIN_API_ENVIRONMENT=test
VITE_SAMHAIN_API_DESTINATION_ID=11111111-1111-4111-8111-111111111111
```

L’URL est une origine HTTPS, sans chemin, query, fragment ni identifiants. HTTP est
refusé aussi en développement ; utiliser un endpoint de test avec certificat reconnu.
Le UUID doit être celui de `API_DESTINATION_ID` côté serveur, permanent pour cette
destination, distinct entre test et production. La réponse doit porter le même
`X-Samhain-Destination`. Ne jamais réutiliser cet identifiant pour une base vidée ou
une autre destination : ses reçus locaux deviendraient trompeurs.

Pour `.env.production.local`, utiliser l’origine réelle de production,
`VITE_SAMHAIN_API_ENVIRONMENT=production` et son UUID. L’environnement de compilation
et de release doit confirmer indépendamment `SAMHAIN_API_PRODUCTION_URL` et
`SAMHAIN_API_PRODUCTION_DESTINATION_ID`, exactement identiques. Une configuration
partielle, une URL invalide ou une destination non confirmée bloque la compilation.
Configuration entièrement absente : les échanges financiers sont désactivés. Aucune
bascule vers Supabase ou vers une API de test.

`scripts/supabase-build.ts` conserve son nom historique et génère `samhain-build.json`
dans `dist/`, puis `assets/public/` après Capacitor sync. Le bloc public `apiAuth`
alimente aussi l’authentification et le worker ; aucun second fichier de configuration.
`envPrefix: []` interdit l’injection brute de variables Vite. Gradle revérifie le mode,
l’origine HTTPS, la destination confirmée et les secrets dans les assets de release.
Ne jamais ajouter URI MongoDB, clé privée, compte serveur ou token dans ces variables,
assets, archives ou logs. Les variables MongoDB appartiennent exclusivement au serveur.

```powershell
pnpm android:sync:test
# Puis seulement après la fin de Capacitor/native sync :
.\android\gradlew.bat -p android testDebugUnitTest assembleDebug

# Production : préparer ses confirmations indépendantes avant ces commandes.
pnpm android:sync:production
.\android\gradlew.bat -p android validateSamhainReleaseResources
.\android\gradlew.bat -p android assembleRelease
```

La signature release existante reste obligatoire. Les ressources test sont interdites
en release. L’APK doit comprendre Room v10 et les routes/Auth #132/#133 ci-dessous ;
une incompatibilité de protocole suspend les échanges, sans modifier le journal.

## Transport et authentification

`ApiTabletAuthService.sendSync` utilise exclusivement les sessions du coffre chiffré
de cette destination et la clé d’installation Android Keystore existante. Le bridge
React ne reçoit ni access token, ni refresh token, ni clé. Le réenrôlement suit
[tablet-enrollment.md](tablet-enrollment.md) avec approbation responsable serveur ;
le PIN local ne confère aucun droit distant. Aucun JWT Supabase n’est transféré.

| POST                    | Action signée `samhain-auth/1` |
| ----------------------- | ------------------------------ |
| `/api/v1/ledger/ingest` | `ledger-ingest-v1`             |
| `/api/v1/ledger/legacy` | `legacy-import-v1`             |
| `/api/v1/ledger/prefix` | `ledger-prefix-v1`             |

Chaque appel obtient un nouveau challenge `/api/v1/auth/challenges` et signe le hash
SHA-256 des octets UTF-8 effectivement envoyés, l’action, le nonce et l’installation.
Le contexte installation/génération/organisation/festival/chaîne est vérifié avant
envoi. Une session expirant bientôt est renouvelée nativement ; un 401 permet au plus
une nouvelle tentative après rotation. Un refus ou une révocation est persisté et
bloque l’accès distant, jamais la caisse.

Le client HTTPS conserve les certificats TLS normaux, refuse les redirections,
borne connexion/lecture à 15 secondes et l’appel à 30 secondes, requête/réponse à
1 Mio et payload financier à 256 Kio. Le JSON reçu doit être strict : UTF-8 valide,
objet unique, pas de clés dupliquées, de syntaxe permissive ou de contenu final,
profondeur bornée et nombres sûrs. Les 408/429/5xx gardent les événements avec backoff
persisté ; `Retry-After` est borné à six heures. Les conflits de contenu sont mis en
quarantaine. Les codes de déplacement de tête/prédécesseur/dépendance réutilisent le
contrôle de préfixe existant, sans transformer ce diagnostic en reçu financier.

`SyncProtocol.validateAck` vérifie contexte/protocole, commit, cardinalité et unicité,
ID, séquence exacte, hash, empreinte de transport, reçu UUID, date serveur, statut
`accepted`/`already_present` et cohérence de tête. Une réponse HTTP 200 seule ne suffit
jamais. Un ACK invalide n’avance aucune ligne ; la nouvelle tentative réutilise les
mêmes tuples et l’idempotence serveur résout un ACK perdu après commit.

## Mise à jour d’une tablette contenant déjà des ventes

1. Inventorier les données et conserver une archive Samhain vérifiée. Préparer le
   backend avec migrations/indexes/rôles et les autorisations #132/#133. Ne pas copier
   ni migrer une base Supabase réelle sans opération distincte explicitement validée.
2. Installer l’APK en mise à jour, avec la même signature et un versionCode compatible.
   Ne pas désinstaller, effacer les données, réinitialiser l’outbox ou recréer l’identité.
3. Room applique **9 → 10**, additif : `outbox_destinations` conserve les états/reçus
   par `(destinationId,eventId)` ; `outbox_backfill.destinationId` vaut initialement
   `supabase`, et `captureError` permet un diagnostic durable d’historique incomplet.
   Le schéma exporté est versionné. Les chemins de migration antérieurs restent présents.
4. Avec l’API configurée, une transaction sélectionne sa destination. Elle conserve
   intégralement les états précédents, sélectionne les confirmations déjà connues de
   cette destination ou crée une projection en attente sans reçu. Les ACK Supabase
   restent consultables dans `outbox_destinations`, jamais considérés comme ACK MongoDB.
   Les conflits/reprises nécessaires ne sont pas effacés. Une lease encore active
   empêche le changement ; un ancien worker ne peut ensuite acquitter la nouvelle destination.
5. Le curseur de capture repart de l’origine pour revérifier les sources durables,
   par transactions de 100 sources. L’outbox et le journal ne sont ni supprimés ni
   recréés. IDs, séquences, hashes, previousHash, chainId, payloads et profils restent
   identiques. Seuls les champs de livraison changent ; l’empreinte est liée au nouveau
   périmètre explicitement approuvé. L’interruption de la sélection annule sa transaction ;
   l’interruption d’un lot reprend depuis son dernier commit.
6. Réenrôler explicitement auprès de l’API, en conservant installation et clé. Le worker
   transmet d’abord les commandes legacy autorisées, puis les événements scellés dans
   l’ordre. Les anciennes ventes acquittées par Supabase participent aussi au rattrapage.
   Chaque ACK validé écrit la projection active et le reçu de destination dans une transaction.
7. Contrôler les diagnostics de la destination active : rattrapage complet, aucun
   événement en attente/erreur et continuité vérifiée. Pendant ce temps, vendre reste
   possible ; les nouvelles opérations prolongent la même chaîne. Aucun paiement,
   clôture ou ticket n’est réexécuté.

Un hash non reproductible, une source durable incompatible ou un journal incomplet
suspend l’envoi avec `LOCAL_HISTORY_INCOMPLETE`, catégorie conflit et continuité inconnue.
Ne pas reconstruire depuis le catalogue courant. Faire vérifier les archives/sources
durables par la procédure de récupération ; redémarrer après résolution permet une
nouvelle vérification locale. Une divergence de préfixe ne se fusionne jamais automatiquement.
La conservation locale ne remplace pas une sauvegarde vérifiée et ne protège pas contre
la perte physique de la tablette ou l’effacement des données Android.

La migration Room v10 ne permet pas de revenir à une APK limitée au schéma v9.
Un rollback applicatif doit comprendre v10 et conserver toutes les confirmations.
Retirer la configuration API suspend les uploads ; cela ne réactive pas l’ancien worker.
Le catalogue MongoDB reste hors #134 (#135) ; le catalogue local reste disponible.
Le retrait des composants historiques Supabase appartient à #138.

## Tests reproductibles et limites de preuve

Les tests Kotlin réutilisent Room/Robolectric et la campagne existante
`LiveSupabaseIntegrationTest`. Les anciennes tables ne sont supprimées/reconstruites
que dans ces fixtures de simulation d’APK antérieure, jamais dans la migration réelle.

```powershell
pnpm test:run
pnpm lint
pnpm build
pnpm build:android:test
pnpm android:install-native
.\android\gradlew.bat -p android testDebugUnitTest

# Après démarrage d’un replica set local jetable décrit dans server/README.md :
$env:MONGODB_TEST_URI = 'mongodb://127.0.0.1:27019/?directConnection=true'
$env:MONGODB_TEST_DATABASE = 'samhain_test_room'
$env:MONGODB_TEST_DISPOSABLE = 'true'
pnpm test:mongodb:room
```

La campagne exige la cible loopback:27019, le namespace `samhain_test_*`, l’opt-in
jetable et le replica set compatible. Elle crée des namespaces de fixtures uniques,
sans purge d’une base existante. Deux périmètres/tablettes produisent les cinq kinds,
reçoivent partiellement des ACK Supabase simulés, passent réellement par Room 9→10,
s’enrôlent avec l’Auth réelle et rattrapent MongoDB. Un ACK est perdu après commit,
la base Room est fermée/réouverte et les reçus/tuples/absence de doublon sont comparés
à MongoDB. La révocation bloque l’upload tandis que les ventes locales continuent.
Le rapport non sensible est `reports/mongodb-room.json`.

Ce test utilise un bridge HTTP **de test loopback seulement** et un signataire simulé :
il ne certifie ni Android Keystore réel, ni TLS matériel, ni WorkManager après arrêt
du système, ni USB. Les tests unitaires du vrai client HTTPS couvrent indépendamment
authentification, timeout, redirection, erreurs, JSON strict et limites.

## Validation manuelle avant déploiement

Sur une tablette de test avec données sauvegardées et signature d’origine :

1. Avant mise à jour, créer ventes, correction/remboursement, ouverture/fond et clôture ;
   garder des événements Supabase acquittés et en attente, relever l’archive et les tickets.
2. Installer la nouvelle APK sans désinstallation, vérifier historique, numéros,
   identités, états de paiement/impression et migrations. Réenrôler explicitement l’API de test.
3. Laisser le rattrapage démarrer, couper le réseau, fermer le processus puis redémarrer
   l’appareil. Vendre et imprimer hors ligne pendant la panne, y compris un échec partiel USB.
4. Rétablir le réseau. Confirmer côté API les mêmes IDs/hashes et un seul événement/reçu
   logique par opération. Vérifier qu’aucun ancien ticket/paiement/clôture n’a été rejoué.
5. Tester session expirée, révocation, 429/5xx, réseau prolongé et un conflit contrôlé sur
   une fixture distincte. Vérifier diagnostics/reprise et maintien de l’encaissement local.
6. Confirmer les ressources de production, sa destination et la signature originale
   avant tout déploiement. Les tests locaux ne valent pas validation matérielle ou hébergée.
