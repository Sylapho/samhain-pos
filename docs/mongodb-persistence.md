# Persistance MongoDB — #131

Évolution #133 : les routes d’ingestion, legacy et préfixe sont implémentées dans
`server/src/ledger/`, sans nouveau schéma/index. Le [runbook d’ingestion](mongodb-ingestion.md)
décrit leur contrat, validation financière et recette locale. Aucun raccordement financier
Android ni déploiement réel n’est effectué.

Évolution #132 : le manifeste v1 est figé dans `server/src/persistence/schema-v1.ts`.
La migration v2 ajoute les champs Auth et l’index de reprise des rotations, sans modifier
les documents financiers. `samhain_runtime_v2` ajoute uniquement la mise à jour des plages
de terminaux nécessaire au remplacement ; v1 reste inchangé. Suivre le
[runbook Auth/OIDC](tablet-enrollment.md) avant activation. Aucune migration réelle n’a été exécutée par cette livraison.

Cette livraison implémente la fondation de données du backend existant `server/`, selon
[l'architecture #129](architecture-mongodb-offline-first.md), §5–10. Aucun transport tablette,
checkout, calcul financier, Room, IndexedDB ou fichier SQL historique n'est modifié.
Aucune migration, sauvegarde ou restauration de la base réelle n'est exécutée.

## Modèle documentaire

`server/src/persistence/model.ts` définit les types ; `schema.ts` est le manifeste exécutable
des validateurs MongoDB et des index. Toutes les collections métier ont
`documentSchemaVersion: 1`, validation `strict/error`, champs inconnus refusés et collation
binaire `simple`. Les compteurs sont des entiers sûrs JS, bornés à 9 007 199 254 740 991.
Les dates financières restent des chaînes originales ; les dates serveur sont des BSON Date.

`S = (organizationId, festivalId)` ; `C = (organizationId, festivalId, chainId)`.

| Collection            | Responsabilité                                                                         | Index uniques nommés                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`       | Organisation active et fence                                                           | `organization_id` : organizationId                                                                                                                                                                         |
| `festivals`           | Festival actif et fence                                                                | `festival_scope` : S                                                                                                                                                                                       |
| `scopeGrants`         | Capacité explicite par issuer/subject, S, active/fence                                 | `grant_subject_scope_capability` : issuer,subject,S,capability                                                                                                                                             |
| `authorizationGuards` | Registre extensible de guards nommés/fences                                            | `authorization_guard` : guardId                                                                                                                                                                            |
| `installations`       | Identité courante, sujet, C, génération, active/authorization/fence                    | `installation_id`, `installation_subject` : issuer,subject ; `installation_active_chain` : C **partiel active=true**                                                                                       |
| `installationKeys`    | SPKI publique, empreinte, génération et date ; anciennes clés conservées               | `installation_key_generation` : installationId,enrollmentGeneration                                                                                                                                        |
| `enrollmentRequests`  | Demande courante, dossier exact, décision, invitation hachée, expiration et essais     | `enrollment_request`, `enrollment_installation`, `enrollment_invitation` **partiel invitationHash de type string**                                                                                         |
| `terminalRanges`      | Bornes inclusives, terminal historique et référence de preuve                          | `terminal_range_start` : C,firstSequence                                                                                                                                                                   |
| `chains`              | Génération autorisée, tête sequence/hash et fence                                      | `chain_id` global ; `chain_scope` : C                                                                                                                                                                      |
| `ledgerEvents`        | Les cinq kinds, preuve financière originale, références dérivées et première réception | `ledger_event` : C,eventId ; `ledger_sequence` : C,sequence ; `ledger_operation` : C,kind,operationId **partiel operationId string** ; `ledger_session` : C,sessionId **partiel kind=cash_session_opened** |
| `sales`               | Réservation orderId ; référence scellée ou snapshot legacy exact                       | `sale_order_scope` : S,orderId                                                                                                                                                                             |
| `syncReceipts`        | Preuve stable, tuple, première installation/génération/sujet/requestId et date         | `receipt_event` : C,eventType,eventId ; `receipt_id` global                                                                                                                                                |
| `catalogVersions`     | Publication exacte et SHA-256, métadonnées serveur/auteur                              | `catalog_revision` : S,revision ; `catalog_version` : versionId global                                                                                                                                     |
| `catalogHeads`        | Révision et référence de publication sous CAS                                          | `catalog_scope` : S                                                                                                                                                                                        |
| `apiSessions`         | Installation/génération/sujet/C, refresh haché, famille, expiration logique et fence   | `session_id`, `session_refresh`                                                                                                                                                                            |
| `refreshRotations`    | Rotation, ancien hash, preuve hachée et réponse **chiffrée** pour reprise bornée       | `refresh_rotation` : sessionId,rotationId                                                                                                                                                                  |
| `authChallenges`      | Nonce haché, action, clé et liaison session/C ou demande pending                       | `challenge_nonce`                                                                                                                                                                                          |
| `administrationAudit` | Sujet/action/S, idempotency key, cible et résultat expurgé                             | `audit_id`, `audit_idempotency` : issuer,subject,S,action,idempotencyKey                                                                                                                                   |
| `schemaMigrations`    | Version DB, checksum du manifeste et date d'application                                | `migration_version`                                                                                                                                                                                        |

Seuls deux index TTL existent : `authChallenges.challenge_expiry` et
`refreshRotations.refresh_expiry`, chacun sur `expiresAt`, `expireAfterSeconds: 0`.
Ni événements, reçus, sessions conservées, mappings historiques, audits ni catalogue historique
ne sont purgés. Le service Auth doit contrôler l'expiration logique des rotations ; les opérations
de stockage vérifient celle des sessions/challenges avec l'horloge MongoDB `$$NOW`.

Une installation possède un registre courant. #132 doit conserver les anciennes générations
dans les clés, sessions, reçus et décisions d'audit ; aucune procédure de remplacement silencieux
n'est fournie. Une demande pending utilise un challenge `purpose: enrollment` lié à requestId,
installation, sujet et clé, sans session financière ni C ; il ne peut jamais servir à ingérer.
Les capacités restent distinctes : `manage_enrollment`, `read_ledger`, `publish_catalog`.
Aucun droit, organisation, installation ou catalogue initial n'est créé par la migration.
Le bootstrap `request` peut précéder l'attribution d'un requestId ; `activate` exige la demande
liée. Les challenges `refresh/status` peuvent être liés à la session existante. Les demandes
disposent de createdAt et d'un approvedScope/approvedBy/approvedAt explicite ; #132 réalise les
transitions et impose la cohérence des décisions. L'audit administratif conserve aussi
requestFingerprint pour distinguer reprise identique et réutilisation conflictuelle de clé.

## Preuve historique et frontières de validation

`proofs.ts` vérifie les octets UTF-8, la canonicalisation TS/Android (y compris `\/` Android),
le hash financier et le fingerprint de transport existants. Le parseur strict de #130 est
réutilisé. Les références indexées sont extraites du payload original et ne sont pas acceptées
comme projections choisies par le client. Aucune projection BSON du snapshot financier n'est
nécessaire. `payloadCanonical` n'est jamais remplacé par un résultat de recalcul.

Les corrections historiques sans `refundLines` et les clôtures sans session restent inchangées.
Une vente scellée réserve son orderId au niveau S ; une commande legacy conserve son snapshot,
sans faux hash/séquence financière ni avancement de tête. Les corrections exigent une vente
antérieure de C avec le hash original exact, ou une référence legacy avec originalSaleHash null.
Les références de sessions doivent être présentes dans le préfixe déjà acquis.

La fondation #131 ne portait pas le validateur monétaire ; #133 le fournit dans
`ledger/business.ts`, avec cumul de remboursements, session active et totaux de clôture.
`persistLedger` impose un callback
`BusinessValidation(event,{db,session})`, exécuté avant insertion, pour brancher ces contrôles
dans la même transaction. Les routes utilisent la session et la chaîne déjà gardées par
`AuthService.protectedTablet`, sans seconde transaction ni seconde consommation de nonce.
`persistLegacyBatch` rend l’import de 1–100 commandes atomique ; `persistLegacy` conserve
son interface unitaire pour les tests de fondation. Les petits
snapshots des fixtures sont explicitement des données de test de stockage, pas des ventes valides.
La publication impose `validateContent(payload)` : #135 doit y réutiliser la validation profonde
du catalogue existant, notamment `dataConfidence: confirmed` et les références produits/catégories.
Le caller serveur fournit ID/date/auteur/révision de publication ; le corps HTTP ne les impose pas.
L'enveloppe `{payload, sha256}` et le contrat `catalog-v1` sont conservés.
Les nouvelles publications ont l'origine `api:<sujet vérifié>` prévue par #129 ; l'audit
historique ne réécrit aucune origine antérieure.

## Transactions et révocations

`transactions.ts` utilise une ClientSession par tentative : `primary`, `snapshot`,
`{w: majority, j: true, wtimeoutMS: 2000}`, commit borné à 2 s, quatre tentatives de transaction
et trois de commit maximum, budget total de retry 15 s. Chaque opération MongoDB utilise
la même session, séquentiellement. Aucun appel réseau externe ne doit être ajouté au callback.
Le client conserve les timeouts réseau/opération configurés dans #130.

`persistLedger` recontrôle et écrit réellement les registres dans cet ordre : organisation,
festival, installation/session, chaîne, nonce. Les incréments de fence sérialisent les écritures
avec les révocations qui modifient les mêmes registres. Les clés sont liées à la génération.
Le challenge est consommé conditionnellement dans cette transaction. Les requêtes utilisent
toutes le périmètre explicite fourni par un contexte **déjà authentifié côté serveur**.

L'événement, sa réservation de vente, son reçu et le CAS de tête réussissent ou échouent
ensemble. Une tête ne progresse qu'avec séquence/hash/génération/fence attendus ; jamais à
partir du nombre de documents. Un lot entièrement présent accepte son ancienne expectedHead.
Un lot mixte exige la tête actuelle avant le premier événement neuf. Les replays doivent
précéder les nouveautés ; IDs et séquences du lot sont bornés et sans doublons.

Un replay compare payload exact, profil, tuple et fingerprint aux preuves réellement stockées,
puis retourne le **même reçu**, ID/date/métadonnées d'origine compris. Une collision E11000
annule la tentative et provoque une relecture dans une nouvelle transaction autorisée ; elle
ne vaut jamais preuve de replay. Les conflits deviennent des codes explicites (contenu,
séquence, réservation de vente, tête, catalogue ou plage terminal). Les retries restent bornés.

Un `UnknownTransactionCommitResult` ne relance que le commit de **la même transaction**.
Si l'incertitude persiste, `COMMIT_UNCERTAIN`, aucun résultat assimilable à un ACK ; les preuves
peuvent néanmoins être durables. #133 traduit cette situation en HTTP 503
`TRANSACTION_RETRY`, jamais affirmer un rollback certain. Une nouvelle requête signée avec
un nouveau challenge résout le cas grâce aux reçus persistants.

`addTerminalRange` nécessite une transaction fournie par l'appelant, écrit la fence de chaîne,
vérifie les chevauchements inclusifs puis insère. L'index firstSequence ne suffit pas.
`publishCatalog` écrit scopes/grant puis version et tête sous révision attendue : une seule
publication concurrente gagne. `revokeInstallation` fournit l'écriture transactionnelle des
mêmes registres ; #132 doit l'entourer de la vérification de preuve et de son audit administratif.
Les changements de grant/organisation/festival doivent écrire leurs propres registres/fences.
`authorizationGuards` reste disponible pour les guards supplémentaires de #132 ; les guards
de la présente implémentation sont directement portés par les registres vivants.

## Comptes, rôles et activation

`roles.ts` définit trois rôles DB **sans utilisateur ni secret par défaut** :

- `samhain_runtime_v1` : find/insert des collections nécessaires, update seulement sur les
  registres et têtes mutables. Aucune mutation de ledgerEvents/sales/syncReceipts/catalogVersions
  ou administrationAudit ; aucun remove, DDL ou bypassDocumentValidation.
- `samhain_reader_v1` : consultation opérationnelle sélectionnée, sans sessions ni secrets Auth.
- `samhain_migrator_v1` : lecture, createCollection/createIndex/collMod et insertion de la
  preuve de migration ; ni suppression, ni update des documents financiers.

La création des rôles exige un compte de provisionnement distinct ; elle ne les attribue
à aucun utilisateur. Un rôle existant différent est refusé, jamais élargi automatiquement.
En Atlas, reproduire les privilèges avec l'administration de rôles offerte par l'hébergement
si `createRole` n'est pas disponible. Un compte backup/restore doit être géré séparément.

MongoDB n'offre pas ici de RLS par document ni d'UPDATE par champ. Le runtime est du code de
confiance : il peut écrire les registres, il doit donc contrôler les capacités avant de le faire.
Les routes ne doivent exposer aucun CRUD générique ; le rôle reader n'est jamais donné à
une tablette. Les validateurs ne calculent pas SHA-256, n'imposent pas les références entre
collections et ne protègent pas d'un administrateur DB. Le rôle applicatif fournit la barrière
DB contre UPDATE/DELETE ; l'exploitation doit protéger aussi les comptes administrateurs.

`Database.mongo` expose le **client/pool déjà partagé** et son Db pour #132/#133 ; ne pas
créer un autre client à chaque requête. L’activation doit vérifier schéma/index/topologie
et privilèges effectifs : l’entrée HTTP le fait via `Database.check` avant écoute,
`openPersistence(client,db)` fournit la même frontière pour un runtime autonome.
La factory bas niveau `createPersistence` sert aux composants de confiance et aux tests.
Le démarrage/readiness exécutent déjà `verifySchema` sans écrire ; en production ils refusent
aussi les privilèges runtime trop larges. Pas de migration automatique au démarrage.
Une base vide non initialisée n'est donc plus prête. Auth par défaut et routes métiers restent
fermées sans configuration Auth ; même un schéma valide ne prouve pas une réception de ventes.

## Initialisation et vérification

Utiliser un namespace POS dédié, inventorier les collections/versions/FCV/WiredTiger,
journalisation et certificats avec l'exploitant. Support initial : replica set non shardé,
MongoDB 6.0+ au niveau wire, tests sur **8.0.16** ; cela ne remplace pas une revue du support
de la version réellement exploitée. Standalone et mongos sont refusés : l'unicité globale
sur un cluster shardé nécessite une autre revue. Une majorité journalisée doit être disponible.
Un nœud de test prouve l'atomicité, pas la haute disponibilité. Pour la production, suivre
les trois membres et domaines de panne distincts prévus par l'architecture.

Depuis la racine, avec les variables **serveur** fournies par le compte approprié :

```powershell
# Compte migrateur / provisionnement, base explicitement approuvée :
$env:MONGODB_ADMIN_TARGET = '<nom-du-namespace-pos-valide>'
pnpm --dir server db:migrate
pnpm --dir server db:roles
Remove-Item Env:MONGODB_ADMIN_TARGET

# Puis compte runtime (autres credentials injectés côté serveur) :
pnpm --dir server db:verify
pnpm --dir server db:verify-runtime
# Contrôle opérateur en lecture seule, sur une base au repos :
pnpm --dir server db:audit
```

`MONGODB_ADMIN_TARGET` doit correspondre exactement à `MONGODB_DATABASE`. Le CLI réutilise
`loadConfig` et la factory client de #130, charge server/.env en local et ne journalise jamais
l'exception MongoDB brute, un document, un ID métier ou un secret. Les diagnostics indiquent
code/collection/index. Les comptes et credentials ne sont pas écrits dans le dépôt.

La migration v1 contient un checksum SHA-256 du manifeste. Elle vérifie le namespace avant DDL,
ajoute les collections manquantes, installe les validateurs compatibles et les index manquants,
puis inscrit sa preuve uniquement après installation réussie. Rejouer ne change ni documents,
ni date de migration. Un index incompatible, un TTL durable, un document historique invalide,
un checksum ou une version inconnue bloque l'activation. Les index uniques supplémentaires
inconnus sont également refusés pour éviter des contraintes métier cachées.

Le DDL MongoDB n'est pas transactionnel : un échec peut laisser des **ajouts** partiels ;
inspecter le diagnostic, corriger explicitement la cause puis relancer. Ne jamais supprimer
des doublons pour faire passer un index. Les changements incompatibles exigent une nouvelle
migration versionnée et une procédure approuvée ; ne pas changer le manifeste v1 après sa
mise en service. Exécuter un seul migrateur à la fois, ingestion arrêtée pendant l'initialisation.
Aucun script ne comporte de purge, dropDatabase ou import automatique Supabase.

## Tests isolés

```powershell
$env:MONGODB_TEST_RBAC_PASSWORD = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
docker compose -f server/compose.test.yaml up -d --wait
$env:MONGODB_TEST_URI = 'mongodb://127.0.0.1:27019/?directConnection=true'
$env:MONGODB_TEST_DATABASE = 'samhain_test_local'
$env:MONGODB_TEST_DISPOSABLE = 'true'
$env:MONGODB_TEST_RBAC_URI = 'mongodb://127.0.0.1:27020/'
pnpm --dir server build
pnpm --dir server typecheck
pnpm --dir server test
pnpm --dir server test:integration
# Arrêter uniquement les fixtures Compose ; leurs tmpfs sont jetables.
docker compose -f server/compose.test.yaml down
```

Le replica set sur 27019 n'a ni Auth ni TLS et reste lié à localhost. Le standalone Auth sur
27020 prouve séparément l'interdiction DB des mutations ; son entrypoint initialise un compte
de test avec le mot de passe jetable généré pour cette campagne, jamais un credential réel.
Une fixture native neuve peut utiliser l'exception localhost si cette variable est absente.
Redémarrer la
fixture RBAC dans un tmpfs neuf avant de réexécuter toute la suite. La base réelle et les
variables MONGODB_URI/MONGODB_DATABASE ordinaires ne sont jamais utilisées par les tests.
Chaque test de persistance reçoit un namespace samhain_test_ unique, sans commande de
nettoyage DB. Les preuves demeurent dans la fixture jusqu'à son arrêt. Les gardes refusent
les autres hôtes/ports, noms de production et absence de consentement jetable explicite.

La CI renseigne les deux URI et exécute les tests MongoDB. L'absence d'une URI locale produit
un **skip explicite**, jamais une prétendue validation. Les tests de signaux SIGTERM/SIGINT
du processus compilé existants s'exécutent sous Linux, pas sous Windows.

## Sauvegarde, restauration et cohérence

1. Faire valider rétention, RPO/RTO et accès avec l'exploitation ; aucune durée légale n'est
   déduite ici. Sauvegarder de façon cohérente **tout le namespace POS** : ledgerEvents,
   sales, syncReceipts, chains, installations/générations/clés, terminalRanges, scopes/grants,
   sessions et audit, catalogVersions/catalogHeads et schemaMigrations, ainsi que les index,
   validateurs et définitions des rôles. Chiffrer et tester la restauration en environnement isolé.
2. Utiliser un snapshot/PITR cohérent du replica set ou un outil MongoDB assurant une vue
   cohérente avec son oplog ; copier collection par collection pendant l'ingestion n'assure
   pas événement+reçu+tête. Un replica set n'est pas une sauvegarde.
3. Restaurer dans un namespace isolé, API en maintenance, sans réactiver les anciennes sessions
   ou droits révoqués entre la sauvegarde et la panne. Restaurer aussi l'état de révocation
   ou les invalider explicitement selon la procédure #132. Reconstituer les rôles sous contrôle.
4. Exécuter db:verify et db:audit au repos. L'audit en lecture seule vérifie les chaînes ordonnées
   depuis le préfixe, hashes/profils/fingerprints, tête exacte, réservations scellées/legacy,
   reçus réciproques, anciennes clés par génération, plages terminal et historique catalogue.
   Il ne répare rien, ne remplace pas les contrôles métier de #133 et n'accorde aucun ACK.
5. Une restauration cohérente **ancienne** peut réussir cet audit tout en ayant perdu un suffixe
   déjà acquitté : comparer les checkpoints externes et les tablettes, faire évoluer l'epoch de
   destination et réconcilier les confirmations par destination selon #134. Aucun ancien ACK
   local ne prouve que les données existent encore dans la base restaurée. Rejouer les mêmes
   identités/preuves seulement après contrôle de préfixe ; jamais resceller/revendre/réimprimer.

La sauvegarde doit préserver les octets exacts des payloads et toutes les versions de catalogue.
Ne jamais reconstruire des ventes historiques à partir du catalogue actuel. Aucune commande
de sauvegarde/restauration effective n'est déclenchée par cette livraison.

## Intégrations restantes

- #132 et #133 sont implémentées côté serveur : voir les runbooks Auth et ingestion pour
  configuration et garanties testées. OIDC/TLS/rôles et recette de la base cible restent
  des prérequis d’exploitation ; aucun secret Keystore n’est transmis.
- #134 : destination/epoch, bascule unique du transport et rattrapage des anciens synced.
- #135 : réutilisation du validateur catalogue complet, authentification des lectures/publications,
  construction des métadonnées serveur et gestion de réponse de publication perdue.
- #137 : vraie topologie de recette, disponibilité réseau, restauration, charge/fences et deux
  tablettes physiques. Aucun résultat local n'atteste le déploiement ou l'impression USB.

Références primaires : [transactions du driver officiel](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/),
[validateurs MongoDB](https://www.mongodb.com/docs/manual/core/schema-validation/),
[privilèges MongoDB](https://www.mongodb.com/docs/manual/reference/privilege-actions/).

## Fichiers de la livraison

Créés :

- `server/src/persistence/model.ts`, `schema.ts` : documents et manifeste des 19 collections,
  33 index (31 uniques, dont 4 partiels ; 2 TTL éphémères).
- `server/src/persistence/proofs.ts`, `errors.ts` : liaison aux preuves historiques et diagnostics expurgés.
- `server/src/persistence/transactions.ts`, `store.ts` : transactions, idempotence, guards et CAS.
- `server/src/persistence/migrations.ts`, `roles.ts`, `audit.ts`, `cli.ts` : initialisation,
  compatibilité, comptes restreints, audit et commandes opérateur.
- `server/integration/fixture.ts`, `persistence.test.ts`, `server/tests/transactions.test.ts` :
  fixtures isolées et scénarios de preuve.
- `docs/mongodb-persistence.md` : ce runbook et les limites d'intégration.

Modifiés : `server/src/database.ts`, `server/src/app.ts`, `server/package.json`,
`server/integration/mongodb.test.ts`, `server/compose.test.yaml`, `.github/workflows/server.yml`,
`server/README.md`, `README.md`. Aucune dépendance ni lockfile modifié.

## Validation locale du 24 octobre 2026

| Contrôle exécuté                                                         | Résultat                                                                                                 |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Backend : tests Node                                                     | 38 réussis                                                                                               |
| MongoDB 8.0.16 réelle : replica set et fixture Auth distincte            | 24 réussis, 1 ignoré (signaux POSIX sous Windows)                                                        |
| Vitest frontend et contrats existants                                    | 525 tests / 57 fichiers réussis                                                                          |
| Build frontend, build backend, TypeScript serveur et ESLint              | Réussis                                                                                                  |
| Format des fichiers concernés, contrôle du diff                          | Réussis                                                                                                  |
| CLI migrate deux fois, verify et audit, sur namespace neuf samhain_test_ | Réussis                                                                                                  |
| Configuration Compose                                                    | Valide ; exécution Docker indisponible sur ce poste                                                      |
| Scan des fichiers concernés et des artefacts frontend                    | Aucun secret réel ni URI MongoDB dans le bundle ; l'URI fictive du test d'expurgation est intentionnelle |

Les tests démontrent notamment les collisions concurrentes, le rollback complet, les références
legacy/scellées, l'expiration logique, le retry après vrai conflit d'écriture, les refus de mutation
par MongoDB et la conservation des versions. Le test de commit incertain injecte une perte de
confirmation **après un vrai commit DB** ; il ne simule pas un déploiement ni une panne réseau
de production. Les sondes restent en lecture seule après initialisation de la fixture.

Docker Desktop ne répondant pas, les tests ont utilisé le binaire officiel MongoDB dans des
dossiers temporaires neufs, ports loopback 27019/27020. La fixture Auth a été vérifiée avec
bootstrap localhost et avec compte jetable préinitialisé, comme prévu pour Compose.
Les premières tentatives en sandbox ont échoué sur EACCES localhost / EPERM du cache Vite ;
les suites réussies ont été relancées avec ces accès locaux autorisés. Le pnpm 10.33.0 déjà
installé a été invoqué directement après l'échec DNS du lanceur Corepack.

Ni image Docker/CI hébergée, ni restauration réelle, ni déploiement, ni tablette/imprimante
physique ne sont déclarés validés. Aucun commit, push, modification d'issue GitHub ou donnée
de production n'est réalisé.
