# Ingestion financière MongoDB — #133

Implémentation serveur dans `server/src/ledger/`, branchée par `buildApp` sur
l’authentification #132 et la persistance #131. Aucun changement au transport Android,
à Room, IndexedDB, la numérotation, l’encaissement ou l’impression. Aucun déploiement
ni migration de la base réelle. Aucune nouvelle dépendance ni migration de schéma.

## Activation et routes

Les routes ne sont enregistrées que si le véritable service Auth et le client MongoDB
partagé sont disponibles. `API_AUTH_ENABLED=false` reste la valeur par défaut : les
appels financiers sont refusés. En production, le démarrage vérifie le manifeste v2,
les index, le replica set et les privilèges effectifs `samhain_runtime_v2`. Le serveur
ne crée ni compte, ni droit, ni schéma au démarrage. Suivre
[la persistance](mongodb-persistence.md) et [l’enrôlement](tablet-enrollment.md) avant activation.

| POST                    | Action signée      | Autorisation et résultat                                                                                                                                  |
| ----------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/v1/ledger/ingest` | `ledger-ingest-v1` | Installation `authorized` ; cinq kinds, lot atomique, `IngestReply` après commit.                                                                         |
| `/api/v1/ledger/legacy` | `legacy-import-v1` | Installation `authorized` ; commandes présentes dans `legacyOrderIds` du dossier activé et terminal autorisé par les plages historiques ; tête inchangée. |
| `/api/v1/ledger/prefix` | `ledger-prefix-v1` | Installation active `authorized` ou `needs_recovery` ; comparaison de tuples, tête et `PrefixReply`, aucun ACK financier.                                 |

Le statut d’autorisation reste celui de la route #132
`POST /api/v1/tablets/status` (action `status`). Le préfixe
vide lit la tête ; les pages de 100 tuples permettent la récupération existante.
Aucune route anonyme de lecture, téléchargement ou fusion du journal n’est ajoutée.
`needs_recovery` ne devient jamais `authorized` à la suite d’un simple diagnostic.

## Contrat exact

Les types normatifs restent [ADR §8.3–8.4](architecture-mongodb-offline-first.md#83-sync-catalogue-et-santé),
sans propriété wire supplémentaire. Le contexte comporte `protocolVersion:1`,
`requestId`, `organizationId`, `festivalId`, `chainId`, `installationId`,
`enrollmentGeneration`. Les identifiants de contexte sont des UUID ; les identifiants
financiers restent opaques, y compris `sale:<orderId>`, Unicode et slashs.

Ingestion : `{...Context, expectedHead:{sequence,hash}, events:WireEvent[]}`.
Legacy : `{...Context, events:WireEvent[]}` sans `expectedHead`. Les champs
`sequence`, `hash`, `previousHash`, `ledgerSchemaVersion`, `ledgerCanonicalization`
doivent être explicitement `null` sur les imports `eventType:legacy_order`.
Un événement scellé a `eventType:ledger`, schéma 1 et un des deux profils historiques.

Réponse financière :

```typescript
{
  protocolVersion: 1, requestId, organizationId, festivalId, chainId,
  committed: true, serverHead: { sequence, hash },
  acknowledgements: [{ eventId, sequence, hash, transportFingerprint,
    receiptId, serverReceivedAt, status: 'accepted' | 'already_present' }]
}
```

Le reçu est un UUID, la date de première réception est UTC suffixée `Z`. Ni
l’installation, ni la génération, ni le requestId courant ne remplacent les
métadonnées du reçu historique. Aucun ACK partiel ou ACK dans une erreur.

Préfixe : tuples locaux `{sequence,eventId,hash,transportFingerprint}` croissants,
réémis dans `results` avec `status:match|absent|conflict`. Seul `conflict` ajoute
`server:{sequence,eventId,hash,transportFingerprint}`. La réponse contient le même
contexte de réponse et `serverHead`, sans `committed` ni `acknowledgements`.

## Authentification et transaction

Chaque appel porte le Bearer API, `X-Samhain-Nonce` et `X-Samhain-Signature`.
Les réponses portent `X-Samhain-Destination` avec l’identité de destination #132,
comme les routes Auth ; le client peut ainsi refuser une mauvaise destination.
`protectedTablet` vérifie le JWT, la clé enregistrée et la signature RSA-SHA256 sur
le digest des **octets HTTP originaux**, puis ouvre une seule transaction. Les
fences organisation/festival, installation, session et chaîne sont les mêmes que
pour la révocation. Le nonce lié à l’action/session/clé est consommé conditionnellement,
avec contrôle d’expiration logique `$$NOW`. Le contexte JSON doit correspondre
exactement à l’installation authentifiée ; il ne donne aucun droit.

Dans cette même session, les écritures vérifient les identités durables et les
plages terminal, le préfixe, les dépendances et les règles financières. Elles
insèrent événements, réservations `sales` et reçus, puis progressent la tête par
CAS de séquence/hash/génération/fence. Legacy traite **tout le lot dans une seule
transaction**, sans progresser la tête. Aucun `Promise.all` dans une transaction.
Un échec annule aussi le nonce et les fences de cette tentative.

Garanties : `readPreference:primary`, `readConcern:snapshot`, commit
`{w:majority,j:true,wtimeoutMS:2000}`, `maxCommitTimeMS:2000`. Quatre tentatives
transactionnelles, trois de commit au plus, budget de retry de 15 s ; timeouts du
driver conservés. L’annulation HTTP est propagée aux parcours métier et vérifiée
avant commit. Un commit déjà envoyé peut aboutir après une interruption HTTP :
le retry reste indispensable, sans supposer un rollback.

`UnknownTransactionCommitResult` fait résoudre le commit de la **même transaction**.
Si l’incertitude persiste, HTTP 503 `TRANSACTION_RETRY`, sans ACK ; les preuves peuvent
déjà être durables. Une collision d’index n’est jamais un ACK : la transaction est
rejouée dans la limite du budget pour comparer le contenu et les reçus du gagnant.

## Validation financière et conservation

Le parseur strict existant rejette doublons de clés, JSON ambigu, UTF-8 invalide,
nombres non entiers/non exacts, profondeur supérieure à 64 et Unicode invalide.
Bornes : 100 événements, corps brut ≤1 MiB (ou limite serveur configurée plus basse),
payload décodé ≤256 KiB, ID opaque ≤512 octets. Les clés inconnues sont refusées.

`proofs.ts` et `ledger/protocol.ts` recalculent SHA-256, le contenu canonique, le
fingerprint et les correspondances enveloppe/payload. `ts-ledger-v1` conserve le tri
UTF-16 et l’échappement TS ; `android-ledger-v1` échappe tous les slashs comme
`JSONObject`. Le transport garde son profil sans cet échappement. Un profil inconnu
est refusé ; jamais de rescèlement ou de réécriture du payload reçu.

`business.ts` porte les contrôles historiques SQL : prix/quantités/paiements de la
vente, options et ingrédients, unicité des lignes, TVA présente dans les snapshots,
vente originale et corrections déjà reçues, cumuls de remboursements, quantités et
arrondi TVA cumulatif des remboursements structurés. Il vérifie aussi session active,
fonds antérieur, terminal, périodes, totaux et cumul historique des clôtures. Les
sommes et produits de centimes sont vérifiés exactement avec `BigInt` avant conversion
en entier sûr. Aucun catalogue actuel n’intervient.

Les corrections sans `refundLines`, anciennes clôtures sans session et commandes
avec `registerName` sans terminal intégré restent valides selon leurs contrats.
Une ancienne absence reste absente ; aucun tableau, hash ou champ fiscal n’est inventé.
Les agrégats de clôture sont lus en curseur sur le préfixe scellé ; les commandes
legacy restent distinctes. Les snapshots originaux sont des chaînes canoniques
exactes, séparées des projections/index BSON. Le rôle applicatif ne peut ni modifier
ni supprimer événements, ventes et reçus ; aucune purge financière n’est ajoutée.

## Comportements de reprise

| Situation                               | Résultat                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Première réception valide               | `accepted`, événement et reçu durables, tête avancée pour le ledger.                                          |
| Lot entièrement présent                 | Ancienne `expectedHead` autorisée ; reçus d’origine et `already_present`, aucune seconde écriture financière. |
| Préfixe déjà présent, suffixe nouveau   | `expectedHead` doit être la tête durable avant le premier nouveau ; statuts mixtes et commit atomique.        |
| Même ID, autre contenu                  | 409 `EVENT_CONTENT_CONFLICT`, preuve initiale conservée.                                                      |
| Séquence occupée autrement              | 409 `SEQUENCE_FORK`, aucun remplacement.                                                                      |
| Commande déjà réservée dans le festival | 409 `DUPLICATE_ORDER_OTHER_CHAIN`, aucun double comptage ; numéro imprimé non unique globalement.             |
| Tête devenue différente                 | 409 `HEAD_MOVED` ; comparaison/replay du préfixe puis suffixe, sans retry aveugle.                            |
| Prédécesseur ou référence manquante     | 409 `MISSING_PREDECESSOR` / `DEPENDENCY_MISSING`, aucun nouvel événement/reçu/tête ; rattrapage contrôlé.     |
| Un élément incohérent                   | Tout le lot annulé, y compris legacy ; pas de réussite partielle.                                             |
| Réponse interrompue / ACK perdu         | Nouveau nonce, même preuve financière ; relire les reçus durables par replay.                                 |
| MongoDB indisponible / délai dépassé    | 503 `SERVER_UNAVAILABLE` ou `TRANSACTION_RETRY` ; préserver l’outbox et appliquer le backoff.                 |
| Corps/lot trop grand                    | 413 `BATCH_TOO_LARGE` ; réduire le lot ; payload indivisible trop grand : 422 `EVENT_TOO_LARGE`.              |

Erreur sync : `{protocolVersion:1,requestId:string|null,error:{code,category,retryable}}`.
Catégories `temporary`, `auth`, `recovery`, `permanent`, HTTP et codes de l’ADR §8.4.
Les refus de preuve/nonce de #132 sont traduits en `ACCESS_REVOKED` pour l’allowlist
financière existante. Toutes les réponses protégées sont `Cache-Control:no-store`.
Logs et erreurs n’incluent ni payload, credential, clé privée, URI ni exception driver.

## Tests et limites

```powershell
pnpm server:typecheck
pnpm server:build
pnpm server:test
# Démarrer uniquement la fixture jetable selon server/README.md, puis :
$env:MONGODB_TEST_URI = 'mongodb://127.0.0.1:27019/?directConnection=true'
$env:MONGODB_TEST_DATABASE = 'samhain_test_local'
$env:MONGODB_TEST_DISPOSABLE = 'true'
$env:MONGODB_TEST_RBAC_URI = 'mongodb://127.0.0.1:27020/'
pnpm server:test:integration
pnpm test:run
pnpm lint
pnpm build
```

`server/tests/ledger.test.ts` reprend aussi le vecteur publié et les hashes figés
TS/Kotlin. `server/integration/ledger.test.ts` utilise de vrais enrôlements/signatures,
MongoDB transactionnelle et deux tablettes simulées : cinq kinds, legacy, préfixe,
replays, concurrence, isolation, erreurs et rollback vérifié en base. Les pannes
avant/après commit sont injectées à la frontière driver d’une transaction réelle ;
elles ne constituent pas une preuve de failover d’un replica set de production.
Les tests JVM existants de `SyncProtocol`, `OutboxStore` et canonicalisation couvrent
le consommateur et son rejet d’ACK partiel, étranger, dupliqué ou falsifié.

Vérifications exécutées le 24 octobre 2026 :

- `pnpm server:typecheck` et `pnpm server:build` : réussis.
- Runner Node 24.22.1 sous WSL, `node --test --test-concurrency=1 tests/*.test.ts integration/*.test.ts` :
  **103 réussis, 0 ignoré**, soit 50 tests unitaires et 53 tests d’intégration.
  MongoDB 8.0.16 locale jetable : replica set et instance RBAC séparée ; dépendances
  installées dans un dossier Linux temporaire avec le lockfile inchangé. Les tests
  SIGTERM/SIGINT passent également. Le montage Windows dépassait le budget de démarrage
  du processus de test ; ce budget n’a pas été augmenté.
- `pnpm test:run` : **530 réussis / 58 fichiers** ; `pnpm lint` et `pnpm build` : réussis.
- Gradle `testDebugUnitTest` ciblant `CanonicalJsonConformanceTest`, `SyncProtocolTest`
  et `OutboxStoreTest` : **23 réussis** sous JVM/Robolectric, aucun essai matériel.
- Formatage des fichiers modifiés et `git diff --check` : réussis. Scan ciblé des ajouts
  et du bundle frontend : aucun nouveau secret ni configuration MongoDB côté client.

Les premiers essais Windows ont rencontré le téléchargement Corepack et les sockets
localhost refusées par le bac à sable. Les validations finales utilisent pnpm 10.33.0
déjà installé et l’accès local autorisé. Docker/Compose et les tests Android complets
n’ont pas été exécutés pour #133 ; les trois classes JVM ci-dessus ont été exécutées.

Le basculement financier Android, les confirmations par destination et la reprise de
tout l’historique relèvent de **#134**. Le catalogue relève de #135. Avant exploitation :
configuration OIDC/TLS/secrets/rôles, inventaire de la base cible, sauvegarde/restauration,
validation de charge sur les historiques réels et recette tablette/réseau/Keystore.
Un historique trop long pour être vérifié dans le budget est refusé sans ACK ; aucun
échantillonnage des clôtures ni assouplissement financier pour contourner le délai.
