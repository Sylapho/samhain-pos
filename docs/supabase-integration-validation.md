# Validation intégrée Supabase — #117

Campagne préparée le **21 octobre 2026**, depuis `a5418a6` avec les modifications
locales de la branche `test/117-supabase-integration`. Le rapport d'exécution
`reports/supabase-integration.json` donne le commit de base, la date UTC, les étapes
et leur résultat ; il ne prétend pas que les modifications non committées figurent
déjà dans ce commit. Aucun déploiement hébergé ni essai physique n'est impliqué.

## Audit avant modification

Les issues #117, #111–116, #35, #36, #19, #20 et #61 ont été lues, ainsi que les
sources et documents associés. Le dépôt contient Room **v9**, IndexedDB **v6**,
les cinq migrations Supabase, les cinq Edge Functions, l'outbox native et Web,
WorkManager, l'interface responsable #116 et la distribution catalogue #115.
Le parcours opérateur de restauration #61 et la campagne physique #19 restent ouverts.

Déjà présents : capture atomique des cinq kinds, rollback vente/séquences/outbox,
claim de 120 s, backoff persistant, ACK strict, backfill par lots, migration de bases
historiques, restauration transactionnelle, tests de canonicalisation TS/Android/SQL,
RLS et ingestion HTTP. Les tests d'outbox injectaient le transport. Le test HTTP
créait les installations positives en SQL et n'était pas exécuté par `ci.yml`.
La documentation annonçant cette CI ou un worker encore absent était obsolète.

Ajouts #117 : enrôlement réellement demandé/approuvé/activé par Auth et RSA dans
le test HTTP existant ; second périmètre ; sessions expirées, générations et
restaurations contrôlées ; campagne Room→Edge→PostgreSQL ; orchestration locale
et job CI séparé. Aucun second moteur de synchronisation ni worker Web ajouté.
Les requêtes, profils, ACK et états sont ceux de production ; seuls les points
de transport et la signature d'installation sont injectés dans les tests natifs.

## Reproduire sans production

Prérequis utilisés : Node **24.8.0** (CI : **22.22.0**, support du TypeScript natif
requis par les scripts), pnpm **10.33.0**, Supabase CLI **2.121.0**, Docker Linux,
Deno **2.9.7**, JDK **21**, SDK Android et dépendances du dépôt.

```powershell
pnpm install --frozen-lockfile
$env:JAVA_HOME = 'C:\Users\arthu\.jdks\jbr-21.0.11'
$env:ANDROID_HOME = 'C:\Users\arthu\AppData\Local\Android\Sdk'
# Si supabase.exe n'est pas sur PATH, fournir son chemin absolu :
# $env:SAMHAIN_SUPABASE_CLI = 'C:\outils\supabase.exe'
pnpm android:sync:test
pnpm test:supabase
```

Cette dernière commande **réinitialise la base locale jetable `samhain-pos`**,
jamais un projet lié/distant : ports 54320–54322, API `127.0.0.1:54321`, conteneur
`supabase_db_samhain-pos`, `--local` pour les migrations. Ne pas y conserver de
données utiles. Elle démarre la pile, teste une montée depuis la première migration
avec données historiques, reconstruit les migrations réelles, exécute pgTAP/lint,
Deno check, tests Edge Vitest, concurrence SQL, HTTP Auth/Edge et Room, puis arrête **ce projet seulement**.
Les volumes restent inspectables et sont réinitialisés au prochain lancement.
Pour les supprimer volontairement après inspection :

```powershell
supabase stop --project-id samhain-pos --no-backup
```

Sur un poste sans SDK/JDK, `node scripts/test-supabase-integration.mjs --server-only`
exécute seulement la partie serveur et l'annonce explicitement dans le rapport.
`pnpm test:supabase:room` permet de rejouer Room sur une pile déjà démarrée et migrée.
`node scripts/test-supabase-room.mjs --all-android` ajoute toute la suite Android et
`assembleDebug` au parcours réel ; le test live est ignoré explicitement par la suite
ordinaire sans bridge, puis exigé exécuté (zéro skip) par le runner d'intégration.
Ne pas exécuter ces deux campagnes simultanément : le reset appartient au runner.

Les montants/produits sont des fixtures synthétiques, jamais des données métier.
Les valeurs financières et dates sont fixes ; les UUID, clés RSA, invitations et
sessions sont neufs par exécution. La préparation privilégiée crée périmètres,
comptes responsables et grants ; elle sert également aux assertions SQL et aux
injections de panne/session. **Aucune installation positive n'est insérée en SQL
dans les campagnes HTTP/Room**. Le test ancien de concurrence SQL reste une preuve
transactionnelle distincte, avec identité simulée, et ne prouve pas Auth.

Le bridge Room écoute une adresse loopback/port éphémère et exige un nonce aléatoire
hérité par Gradle. Il ne transmet aucun JWT au test Kotlin. Il reçoit les octets
exacts du vrai `SyncEngine`, obtient le challenge, signe avec une clé RSA Node puis
appelle les vrais endpoints. Il ne remplace ni la canonicalisation, ni l'outbox,
ni la validation des ACK. Il ne prouve **pas** Android Keystore, le réseau HTTPS OEM
ou l'ordonnancement physique WorkManager. Il est présent uniquement dans les tests.

## Matrice de preuves

Statuts : **A** automatique avec composants réels ; **S** simulation/injection ;
**M** manuel non exécuté. La colonne résultat désigne le résultat effectivement
observé dans le bilan daté ci-dessous ; « attendu » ne vaut jamais réussite.
Les suites existantes sont réutilisées lorsqu'elles couvrent déjà le scénario.

| ID / fonctionnalité | Préconditions et fixtures                                          | Procédure / source exécutable                                                                                                       | Avant → après attendu                                                                                                                                | Preuve / environnement                              | Résultat obtenu                                                    |
| ------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| MIG-SQL historique  | Première migration ; `supabase/tests/fixtures/pos.psql`            | `test-supabase-migrations.mjs` : snapshot des neuf tables, migrations suivantes                                                     | Payloads, séquences, hashes, ventes, reçus, tête et registre identiques                                                                              | A, PostgreSQL 17 local                              | Voir bilan                                                         |
| SEC-RLS             | Quatre chaînes, deux organisations, plusieurs festivals, rôles SQL | `supabase test db` : `pos.test.sql`, `enrollment.test.sql`, `ingest.test.sql`, `catalog.test.sql`                                   | Anonyme/non habilité/autre périmètre : zéro lecture ou refus ; habilité : données de son périmètre                                                   | A, vraies policies/grants ; claims SQL simulés      | Voir bilan                                                         |
| SEC-RPC             | Vrais JWT anon/responsable/tablette                                | HTTP direct vers chacune des cinq RPC publiques dans `test-supabase-ingest.mjs`                                                     | HTTP 401/403, aucun append                                                                                                                           | A, gateway/PostgREST                                | Voir bilan                                                         |
| AUTH-ENROLL         | Deux responsables et périmètres ; nouvelles clés RSA               | API request→approve→challenge→activate ; responsable étranger refuse revoke                                                         | Installation habilitée seulement dans son périmètre                                                                                                  | A, Auth/Edge/SQL                                    | Voir bilan                                                         |
| AUTH-PROOF          | Installation activée, JWT valide                                   | Signature fausse, nonce rejoué, chain/installation/terminal/périmètre falsifiés                                                     | Refus sans ACK ni événement supplémentaire                                                                                                           | A, HTTP signé                                       | Voir bilan                                                         |
| AUTH-EXP            | Vraie session, preuve déjà préparée                                | `auth.sessions.not_after` dans le passé ; session supprimée ; ancien JWT                                                            | AUTH_REQUIRED ; tête inchangée                                                                                                                       | A + expiration forcée en SQL                        | Voir bilan                                                         |
| AUTH-REV            | Installation avec JWT encore valide                                | Révocation, concurrence révocation/append ; générations obsolètes                                                                   | Ancienne installation refusée ; historique préservé                                                                                                  | A, HTTP/SQL                                         | Voir bilan                                                         |
| FIN-REPLAY          | Session caisse puis vente                                          | Envoyer trois fois le même événement ; comparer chaque ACK                                                                          | 1 événement, 1 reçu stable, date initiale, accepted→already_present                                                                                  | A, HTTP/SQL                                         | Voir bilan                                                         |
| FIN-CONFLICT        | Événement accepté                                                  | Même ID/autre contenu, hash mensonger, fork séquence                                                                                | Aucun écrasement, aucun reçu positif, tête inchangée                                                                                                 | A, HTTP/SQL                                         | Voir bilan                                                         |
| FIN-ATOMIC          | Tête 1 ; vente valide suivie d'un fond invalide                    | Envoyer lot ; relire tête, événements, projections et reçus                                                                         | Échec complet ; ni vente ni reçu partiel                                                                                                             | A, transaction réelle                               | Voir bilan                                                         |
| FIN-ORDER           | Deux chaînes, mêmes numéros imprimés                               | Envois simultanés, order.id copié, trous, prédécesseur absent                                                                       | Chaînes indépendantes acceptées ; doublon de portée/gap refusé ; pas de renumérotation                                                               | A, HTTP/SQL                                         | Voir bilan                                                         |
| FIN-LOCK            | Verrou de chaîne détenu sur connexion indépendante                 | Attendre expiration SQL puis retenter                                                                                               | TRANSACTION_RETRY 503 ; aucun ACK ; un seul événement après retry                                                                                    | A, vrai lock PostgreSQL                             | Voir bilan                                                         |
| FIN-KINDS           | Cinq kinds et trois variantes de correction                        | Vente, refund structuré, cancellation totale, correction ancienne amount-only, clôtures avec/sans session ; legacy avant correction | Exactes dépendances, hashes, centimes ; aucune vente artificielle si référence absente                                                               | A, HTTP/SQL ; Room natif pour cinq kinds            | Voir bilan                                                         |
| FIN-LEGACY          | Vente sans intégrité/terminal facultatif                           | Import et replay `legacy-import-v1`, correction liée                                                                                | Reçu stable ; sequence/hash nuls ; tête non avancée par import                                                                                       | A, HTTP/SQL                                         | Voir bilan                                                         |
| CANON               | Vecteurs figés TS, Android, SQL ; Unicode, slash, null, entier max | `CanonicalJsonConformanceTest`, `SyncProtocolTest`, `_shared/syncProtocol.test.ts`, `ingest.test.sql`                               | Hashes attendus et fingerprints exacts ; payload original conservé                                                                                   | A/S, TS/Vitest/PostgreSQL/Robolectric               | Voir bilan                                                         |
| COMPAT              | Requête scellée connue                                             | Protocole/schéma inconnu, champ d'enveloppe inconnu, payload malformé/entier non sûr                                                | Refus explicite ; aucun recalcul historique                                                                                                          | A/S, HTTP et parseurs                               | Voir bilan                                                         |
| ROOM-LIVE           | Deux fichiers Room v9, trois jours synthétiques, cinq kinds        | `LiveSupabaseIntegrationTest` via bridge                                                                                            | 7 événements/chaîne : pending→synced ; chaque ID/séquence/hash/previousHash/payload/fingerprint/reçu/date conforme au SQL ; snapshot local identique | A, SQLite/Robolectric + vrai Supabase               | Voir bilan                                                         |
| ACK-LOST            | Lot Room pending                                                   | Réponse masquée seulement après committed=true ; fermer/rouvrir DB ; retry avec nouvelle preuve                                     | Pas de marquage avant ACK ; mêmes événements/reçus, aucun paiement ni état d'impression changé                                                       | A + perte de réponse injectée                       | Voir bilan                                                         |
| OFFLINE             | Aucune configuration au démarrage                                  | Trois jours natifs sans appel réseau ; ventes/correction/fond/clôture, puis reconnexion                                             | Écritures durables et numéros inchangés                                                                                                              | A/S, Room ; durée accélérée                         | Voir bilan                                                         |
| HTTP-ERRORS         | Vente pending                                                      | `OutboxStoreTest`, `SupabaseSyncHttpTest` : réseau, timeout, 408/429/500/502/503/504, Retry-After                                   | Backoff durable ; nouvelle vente après chaque code ; 401/403 paused_auth ; conflit permanent sans boucle                                             | S, transport injecté                                | Voir bilan                                                         |
| CRASH               | États persistants variés                                           | Rollback avant commit, reopen après commit/claim expiré, backfill repris ; `OutboxStoreTest`, `RoomOrderStoreTest`                  | Pas de demi-vente ; bail récupérable ; pas d'ACK fabriqué                                                                                            | A/S, SQLite/Robolectric ; aucun kill OS réel        | Voir bilan                                                         |
| MIG-ROOM            | Bases historiques, schémas exportés                                | `RoomOrderStoreTest`, `OutboxStoreTest`, `RoomCategoryStoreTest`                                                                    | Migrations vers v9 ; données et états préservés ; backfill non destructif                                                                            | A, SQLite/Robolectric                               | Voir bilan ; couverture détaillée des transitions dans les sources |
| MIG-WEB             | Ancienne DB, vente legacy                                          | `outboxRepository.test.ts`, `catalogRepository.test.ts`                                                                             | IndexedDB v4→v6, capture/rattrapage, fermeture/réouverture sans worker réseau                                                                        | S, fake-indexeddb                                   | Voir bilan ; pas un navigateur physique                            |
| RESTORE             | Archive valide/corrompue/ancienne, cible vierge ou occupée         | `salesLedgerService.test.ts`, `tabletReplacementService.test.ts`, `RoomOrderStoreTest`                                              | Vérification avant mutation, rollback atomique, reprise identité après commit ; ID/hash/séquences préservés                                          | A/S, primitives locales                             | Voir bilan ; UI #61 et deux tablettes différées                    |
| RESTORE-REMOTE      | Chaîne déjà reçue                                                  | Enrôler copie ancienne, copie forkée, puis préfixe exact approuvé                                                                   | needs_recovery, needs_recovery, authorized génération 4 ; replay already_present, ancien appareil refusé                                             | A, vraie API d'enrôlement et PostgreSQL             | Voir bilan                                                         |
| USB-INDEP           | État printed/unknown persistant                                    | Snapshot Room comparé avant/après panne/réponse/ACK/restart ; tests orchestration impression existants                              | Aucun nouveau job/document ; unknown garde reprise manuelle                                                                                          | A/S, Room et transport imprimante simulé            | Voir bilan ; aucun papier réel                                     |
| CATALOG             | Publication et snapshot local                                      | HTTP `catalog-v1` ; `catalogDistribution.test.ts`, `catalogRepository.test.ts`                                                      | Révision/hash, conflits, cache hors ligne, refus incompatibilité ; anciennes ventes inchangées                                                       | A/S, serveur réel + stockage local testé séparément | Voir bilan                                                         |
| MANAGER             | Outbox persistante + diagnostics natifs                            | `TabletSynchronizationSettings.test.tsx`, `OutboxStoreTest`                                                                         | Compteurs/dernier ACK/erreur, relance répétée, pending après restart                                                                                 | S, UI React/Robolectric                             | Voir bilan ; pas de preuve écran physique                          |
| HARDWARE            | APK/commit identifié, vraie tablette + Epson                       | [Protocole réseau/USB](tm-t88v-usb-test-plan.md#campagne-supabaseusb-117-complément-19)                                             | Vendre et imprimer pendant panne ; aucun papier supplémentaire au retry/ACK                                                                          | M, Android/USB réel                                 | **Non exécuté**                                                    |

## Limites de preuve et gates

Une coupure réseau physique, une extinction brutale, Doze/force-stop, reboot,
Keystore OEM et mise à jour APK réelle nécessitent le protocole matériel. Le test
Room ferme/réouvre SQLite après un commit ; il ne prétend pas tuer le processus OS.
Les tests WorkManager vérifient unicité/contraintes/continuation avec son exécuteur
de test, sans garantie de délai en exploitation. Une archive perdue avec la tablette
ne se reconstitue pas depuis des événements jamais transmis.

Le bridge n'appelle pas de transport USB : la conservation du snapshot prouve
l'absence de mutation/recréation technique par le moteur ; la suite d'impression
prouve séparément son orchestration locale. Seul un comptage papier physique
valide la coexistence réseau/USB. Le serveur local HTTP n'est pas une validation
de TLS, des clés publiables modernes ou du gateway du projet hébergé. Aucun patch
de sécurité ne doit être appliqué au client pour accepter le HTTP local de test.

L'évolution additive SQL est testée sur données historiques ; le protocole v1
reste strict : ajouter un champ inconnu ne constitue pas une compatibilité promise.
Déployer d'abord un serveur supportant explicitement une évolution puis son client,
en conservant les profils historiques ; ne pas modifier des hashes pour migrer.

Les données des tests pgTAP sont synthétiques ; le fixture de première migration
teste conservation et contraintes avec des hashes de forme, tandis que la campagne
HTTP/Room vérifie les vrais SHA-256. Ces niveaux de preuve restent séparés.

`reports/supabase-room.json` conserve les tuples synthétiques ID/séquence/hash,
previousHash, fingerprint, reçu et date, les nombres avant/après et les hashes du
snapshot local avant/après. Il ne contient ni payload complet ni credential.
Ce rapport et celui du runner sont ignorés par Git et publiés comme artifacts du
job CI ; conserver les preuves de l'exécution correspondant au commit livré.

## Bilan exécuté le 21 octobre 2026

Résultats réellement exécutés sous Windows, Docker Linux, Node 24.8.0, JDK 21 :

| Commande / contrôle                                        | Résultat final                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test:run`                                            | **490 tests / 54 fichiers réussis**, dont les suites Edge sous Vitest                                                                                                    |
| `pnpm lint`                                                | Réussi                                                                                                                                                                   |
| `pnpm android:sync:test`                                   | Réussi : build Android-test, Capacitor puis installation des sources natives                                                                                             |
| `pnpm build:android:production`                            | Réussi : ressources web production ; ce n'est pas une release APK signée                                                                                                 |
| `pnpm test:supabase`                                       | **Réussi intégralement**, arrêt de la pile locale compris                                                                                                                |
| Migrations PostgreSQL historiques + reconstruction         | Réussies ; contenu des neuf tables conservé                                                                                                                              |
| `supabase test db` (dans le runner)                        | **402 assertions / 4 fichiers réussis**                                                                                                                                  |
| Lint SQL `pos_private`                                     | Aucune erreur de schéma                                                                                                                                                  |
| `deno check` des cinq Edge Functions                       | Réussi                                                                                                                                                                   |
| Tests Edge ciblés du runner via Vitest                     | **47 tests / 3 fichiers réussis** ; inclus aussi dans les 490, ne pas les additionner                                                                                    |
| Campagne HTTP réelle                                       | **127 contrôles réussis**, y compris refresh, deux périmètres et réenrôlement                                                                                            |
| Concurrence SQL d'activation                               | Exactement un commit autorisé et une installation active                                                                                                                 |
| `node scripts/test-supabase-room.mjs --all-android`        | **89 tests Android, zéro échec, zéro skip**, et `assembleDebug` réussi                                                                                                   |
| Migrations Room exportées v2…v8→v9                         | Réussies avec vraies lignes de vente, ledger, séquences et impression ; backfill et hash inchangés. v1→v2 conserve son test SQL ciblé existant, pas de schéma v1 exporté |
| Campagne Room finale du runner                             | Deux chaînes/périmètres, 7 événements chacune ; deux ACK perdus après commit, deux rapprochements exacts, six appels signés ; snapshots locaux identiques                |
| Cohérence des sources Kotlin                               | Les quatre templates modifiés concordent avec leurs copies Android générées                                                                                              |
| Inspection des assets texte de l'APK debug                 | 9 assets publics scannés : aucun motif de clé privilégiée ou JWT                                                                                                         |
| Rapports JSON expurgés / `git diff --check`                | Réussis ; aucun motif de credential dans les rapports                                                                                                                    |
| GitHub Actions hébergé, APK release signée, tablette/Epson | **Non exécutés** ; workflow ajouté et commande correspondante exécutée localement                                                                                        |

Les lignes A/S de la matrice ont réussi dans les environnements indiqués ; leur
portée reste celle du test décrit, notamment fake-indexeddb et transports injectés.
Les essais initiaux ont détecté des erreurs de fixtures du nouveau harnais
(préfixe reçu, champs obligatoires, précision microseconde des reçus et identité
réutilisée entre exécutions) ainsi qu'un mauvais runner de tests Edge ; ces erreurs
ont été corrigées et les commandes finales ci-dessus ont été rejouées sans réduire
les assertions. Aucun invariant financier de production n'a été modifié.
Les notices pgTAP de TRUNCATE proviennent de tests qui vérifient son refus : aucune
purge métier n'a été effectuée. Avertissements Gradle existants : `flatDir`, API
dépréciées et une assertion Kotlin `!!` superflue ; aucun échec de compilation.

## État des critères du prompt #117

| Critère                                 | État réel                                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Instance isolée reproductible           | Validé localement ; reset et arrêt bornés au projet Docker                                                        |
| Migrations et policies réelles          | Validé, 402 assertions SQL et migration historique                                                                |
| Deux tablettes / deux périmètres        | Validé avec Auth et RSA simulant les tablettes, deux bases Room réelles                                           |
| Retries sans doublon                    | Validé HTTP et Room                                                                                               |
| Collision divergente refusée            | Validé, pas de reçu positif ni écrasement                                                                         |
| ACK perdu récupéré                      | Validé après véritable commit serveur et réouverture Room                                                         |
| Pannes réseau/serveur et ventes locales | Validé par injections 408/429/500/502/503/504, erreurs réseau/Auth et révocation réelle ; réseau physique différé |
| Cinq kinds et legacy                    | Validé, corrections complètes/partielles structurées et anciennes                                                 |
| Canonicalisations et empreintes         | Validé avec vecteurs connus et tuples natifs reçus par SQL                                                        |
| Refus RLS/RPC/Auth                      | Validé sur politiques réelles et HTTP signé ; claims SQL de pgTAP explicitement simulés                           |
| Migrations Room/IndexedDB               | Validé dans SQLite/Robolectric et fake-indexeddb ; navigateur et mise à jour physique distincts                   |
| Restauration et forks                   | Primitives locales + vrai réenrôlement/préfixe validés ; parcours matériel/UI #61 différé                         |
| Pas de nouveau job au retry réseau      | Snapshots d'impression inchangés et orchestration testée ; papier réel non validé                                 |
| Protocole et modèle matériel            | Livrés ; rapport physique encore non exécuté                                                                      |
| CI d'intégration                        | Job ajouté ; commande complète verte localement, aucune exécution GitHub distante revendiquée                     |
| Runbook reproductible                   | Livré : `supabase-deployment-runbook.md`                                                                          |
| Rollback compatible                     | Procédure documentée ; aucun rollback production exécuté                                                          |
| Récupération sans purge                 | Procédure documentée et invariants testés ; incident physique différé                                             |
| Limites/tests non exécutés              | Identifiés dans ce bilan et le protocole matériel                                                                 |

Pour les six critères originaux de l'issue GitHub : pipeline préparé et démonstration
locale acquise pour idempotence/isolation ; reprise/ACK et cinq kinds/migrations
validés aux niveaux ci-dessus ; 401/révocation/5xx couverts ; **rapport daté sur
tablette + TM-T88V encore manquant** ; runbook déploiement/rollback/récupération livré.
L'issue ne doit donc pas être déclarée entièrement validée pour le festival.

La validation matérielle #19, le parcours opérateur #61, la configuration de release
et le test du projet hébergé restent des gates distincts. Le bridge utilise une clé
RSA en mémoire et HTTP loopback : confirmer Keystore, TLS/gateway, Doze et sorties
papier sur les appareils réels avant un GO d'exploitation.

Références : [tests locaux Supabase](https://supabase.com/docs/guides/local-development/cli/testing-and-linting),
[migrations](https://supabase.com/docs/guides/deployment/database-migrations),
[WorkManager](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started).
