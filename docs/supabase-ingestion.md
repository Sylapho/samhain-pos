# Ingestion du journal Supabase (#36)

Les copies financières sont reçues par `ledger-ingest-v1`, `legacy-import-v1` et
`ledger-prefix-v1`. Le contrat reste [samhain-sync/1](architecture-supabase-offline-first.md).
Room/IndexedDB, l'encaissement et l'impression restent locaux. Le worker/outbox #35
n'est pas livré ici ; aucun appel serveur n'est ajouté au parcours de vente.

## Chemin de sécurité et transaction

Chaque endpoint exige un JWT utilisateur vérifié par Auth `/user`, puis les headers
`X-Samhain-Nonce` et `X-Samhain-Signature` de `TabletAuthService.sendSync`. La preuve
RSA signe `samhain-auth/1`, l'installation, le nom exact de l'endpoint, le challenge
et le SHA-256 du **corps HTTP brut**. Ne pas re-sérialiser le corps entre signature
et envoi. Obtenir un nouveau challenge pour chaque nouvelle tentative ; un nonce
consommé n'est pas réutilisable, même pour un replay financier.

L'Edge borne/lit le flux UTF-8 strict, refuse compression, clés dupliquées,
surrogates isolés et nombres non entiers sûrs, puis vérifie profils et empreintes.
Elle appelle une seule RPC PostgREST : `ledger_ingest_v1`, `legacy_import_v1` ou
`ledger_prefix_v1`, avec `subject`, `session_id`, `raw_body`, `proof_nonce`.
Sujet et session viennent exclusivement du JWT déjà vérifié, jamais du corps client.

La migration additive `20261014210000_ledger_ingestion.sql` ne change aucun payload,
reçu, prix, mapping ou numéro existant. Elle ajoute des fonctions et un rôle
`pos_ledger_executor` NOLOGIN/NOINHERIT/NOBYPASSRLS. Les RPC publiques sont réservées
à `service_role` ; ce rôle n'a toujours aucun accès direct aux tables privées.
Le propriétaire limité possède les droits d'append/projection/reçus et d'avancement
de tête, sous RLS. Aucun droit UPDATE/DELETE/TRUNCATE financier n'est ajouté.
Les privilèges UPDATE sur des colonnes du registre servent uniquement aux verrous
SQL ; aucun endpoint ne permet au client de modifier ce registre.

Un helper privé fermé, `require_sync_session`, vérifie et verrouille l'utilisateur
Auth actif et la session encore présente/non expirée. Il appartient au propriétaire
de migration, car les tables Auth restent gérées par Supabase ; aucune lecture de
credentials n'est accordée au rôle financier. Les habilitations d'installation,
générations et périmètres actifs sont recontrôlés sous verrous, ainsi que les plages
de terminaux historiques. Une révocation concurrente est sérialisée avec l'ingestion.

`consume_installation_proof` consomme le challenge dans la même transaction que
les écritures. La RPC recalcule indépendamment canonicalisation, hash financier
et fingerprint sur le contenu réel. Elle valide les totaux de ventes, snapshots,
références et cumuls de remboursements, quantités/TVA historiques, sessions/fonds
et clôtures depuis le préfixe durable, sans consulter le catalogue.

Les triggers existants font la projection des ventes et l'avancement de tête.
Les contraintes différées de reçu/tête sont vérifiées explicitement avant le retour
du contexte privilégié : leur trigger invoker ne dépend donc pas de droits directs
du rôle PostgREST au commit. Toute erreur annule le lot, y compris reçus, projections,
tête et consommation de nonce. PostgREST ne retourne un succès qu'après commit.

## Replays, legacy et récupération

- Même événement/contenu/profil/fingerprint : `already_present`, même `receiptId`
  et premier `serverReceivedAt`. `requestId` décrit la tentative courante.
- Une identité occupée avec un autre contenu est refusée. Un hash mensonger est
  refusé par recalcul (`INVALID_HASH`), même si l'identité existe déjà.
- Les replays constituent un préfixe contigu. Un lot avec nouveaux événements doit
  fournir la tête durable avant son premier nouvel événement. Un lot entièrement
  replayé peut garder sa tête ancienne ; il ne fait jamais reculer le serveur.
- Les numéros imprimés peuvent coïncider entre chaînes. `order.id` reste unique
  dans le périmètre organisation/festival ; un doublon inter-chaînes est explicite.
- Legacy utilise `sales.legacy_payload_canonical`, sans entrée ledger, séquence,
  hash financier ni changement de tête. Les anciennes corrections sans lignes et
  clôtures sans session restent acceptées avec leurs contrôles historiques.
- Prefix retourne `results` avec les tuples locaux et `status: match|absent|conflict`.
  Un conflit inclut `server`, le tuple durable correspondant. Il n'a ni `committed`
  ni `acknowledgements`. Il reste disponible sous preuve pour une installation en
  `needs_recovery` ; il ne l'autorise pas à uploader et ne lève pas cet état.
  Aucune fusion, renumérotation, archive serveur ou reprise automatique n'est ajoutée.

Les profils sont figés : TypeScript `JSON.stringify`, Android plateforme
`JSONObject.quote` via [JSONStringer AOSP](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/88c7ff1cd72d6305ec59f97aadc2198cc2dc3592/android-34/org/json/JSONStringer.java).
Android échappe **tous** les slashs ; transport-json-v1 ne les échappe pas. Les
nombres de schéma 1 sont des entiers sûrs en notation décimale. Les clés sont triées
en UTF-16, indépendamment de la collation PostgreSQL. Null explicite et champ absent
restent distincts. Les octets canoniques complets sont conservés, séparément de JSONB.
PostgreSQL ne peut représenter U+0000 dans ses valeurs texte/JSONB : ces encodages
sont refusés explicitement (`INVALID_PAYLOAD`), sans remplacement de caractères.
Les données locales restent intactes et demandent une intervention de compatibilité.

## Erreurs et limites

Les réponses d'erreur suivent `{protocolVersion:1, requestId, error:{code,category,
retryable,eventId?,expectedHead?}}`. Aucun payload ni secret n'est exposé dans les
diagnostics. Les erreurs du gateway avant l'Edge peuvent conserver son format HTTP.
Une erreur ne contient jamais d'ACK positif.

| Codes                                                                                 | Traitement #35                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `AUTH_REQUIRED` (401), `ACCESS_REVOKED`, `SCOPE_DENIED`, `INSTALLATION_RETIRED` (403) | Pause Auth/habilitation ; préserver l'outbox.                                        |
| `HEAD_MOVED`, `MISSING_PREDECESSOR`, `DEPENDENCY_MISSING` (409)                       | Récupération par préfixe/backfill, pas de retry aveugle.                             |
| `EVENT_CONTENT_CONFLICT`, `SEQUENCE_FORK`, `DUPLICATE_ORDER_OTHER_CHAIN` (409)        | Conflit permanent ; préserver les deux preuves.                                      |
| `TRANSACTION_RETRY` (503)                                                             | Verrou expiré, deadlock ou sérialisation ; transaction annulée, retry après backoff. |
| `SERVER_UNAVAILABLE` (503), `INTERNAL_ERROR` (500), `RATE_LIMITED` (429)              | Temporaire ; respecter Retry-After lorsqu'il est fourni.                             |
| `INVALID_*`, `BUSINESS_INCONSISTENCY`, `CANONICALIZATION_UNSUPPORTED`                 | Données/profil invalides ; intervention, pas de réécriture historique.               |
| `PROTOCOL_UNSUPPORTED` (426), `LEDGER_SCHEMA_UNSUPPORTED` (422)                       | Mise à jour compatible nécessaire.                                                   |
| `BATCH_TOO_LARGE` (413), `EVENT_TOO_LARGE` (422)                                      | Réduire le lot ; événement indivisible trop grand à traiter en intervention.         |

Bornes : 100 événements, 1 MiB UTF-8 du corps brut, 256 KiB par payload décodé,
512 octets par ID opaque. Profondeur JSON maximale 64 pour protéger les parseurs.
Verrous bornés à 5 secondes, requête SQL à 25 secondes. Pas de retry serveur en
boucle : `TRANSACTION_RETRY` rend la main au worker. Un nonce encore valide dont
la transaction a été annulée reste consommable ; une tentative normale obtient
néanmoins un nouveau challenge par le service natif.

## Déploiement sur le projet de test

1. Préparer Auth, organisation/festival et enrôlement selon [tablet-enrollment.md](tablet-enrollment.md).
2. Vérifier explicitement le projet **de test** lié et le plan `supabase db push --dry-run`.
3. Appliquer les migrations avec `supabase db push` sur ce projet autorisé.
4. Déployer `supabase functions deploy ledger-ingest-v1`, puis `legacy-import-v1`
   et `ledger-prefix-v1`, en conservant `verify_jwt = true` pour les trois.
5. Garder `SUPABASE_SERVICE_ROLE_KEY` exclusivement dans l'environnement Edge.
   Aucune variable Vite, APK, archive ni fichier public ne doit la recevoir.
6. Tester les vrais JWT/gateway du projet, notamment révocation et réponse perdue,
   avant de connecter le futur worker. Aucune commande distante n'est exécutée par
   les scripts de test livrés.

## Vérification locale reproductible

Prérequis : Node 22.18+ ou 24, pnpm, Docker, Supabase CLI 2.121.0, Deno pour le check.
Les scripts ciblent uniquement la pile locale `samhain-pos`, jamais une URL distante.
Sur Windows, mettre **supabase.exe** sur PATH ; pour le test HTTP, on peut fournir
son chemin dans `SAMHAIN_SUPABASE_CLI`. Les sorties CLI contenant les clés de test
restent en mémoire dans ce script.

```bash
supabase start
node scripts/test-supabase-migrations.mjs
supabase test db
supabase db lint --schema pos_private --fail-on error
node scripts/test-supabase-enrollment-concurrency.mjs
node scripts/test-supabase-ingest.mjs
pnpm test:run
pnpm lint
pnpm build
deno check supabase/functions/ledger-ingest-v1/index.ts supabase/functions/legacy-import-v1/index.ts supabase/functions/ledger-prefix-v1/index.ts
```

Le script de migrations réinitialise la **base locale jetable**, vérifie l'évolution
avec les fixtures historiques puis reconstruit une base vide. Le test HTTP utilise
vrais signup/session JWT locaux, signatures RSA, gateway, Edge et transactions SQL.
Il laisse ses fixtures immuables dans cette pile jetable jusqu'au prochain reset.
La CI Supabase exécute aussi cette intégration.

Pour les vecteurs de plateforme : `pnpm android:install-native`, puis
`android/gradlew -p android testDebugUnitTest --tests fr.samhain.pos.CanonicalJsonConformanceTest`
avec JDK 21 et SDK Android. Ces tests Robolectric ne prouvent pas le Keystore,
le transport HTTPS OEM ni l'impression USB sur tablette. Le worker #35 consommera
les enveloppes/ACK présents et `sendSync` natif ; il devra créer son outbox durable,
vérifier la bijection des ACK puis marquer le lot atomiquement, sans purger le journal.
