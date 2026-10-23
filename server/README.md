# Backend HTTPS Samhain POS — #130 / #131

Fondation **Node.js 24 LTS / TypeScript strict / Fastify / driver officiel MongoDB**,
conforme à [l'architecture #129](../docs/architecture-mongodb-offline-first.md).
Application autonome : aucun import React, Vite, Capacitor ou dépendance Supabase.
Les ventes, paiements, remboursements, impressions, Room et le transport actuel restent inchangés.
La connexion à la base réelle n'a pas été configurée ou testée.

## Installation et lancement

Prérequis : Node.js **24** (image figée sur 24.22.1), pnpm **10.33.0** ; MongoDB accessible
uniquement au serveur. Le driver 7.7.0 est testé ici avec MongoDB 8.0.16. Inventorier la
version/FCV, les certificats et la topologie de la base existante avant déploiement.

Depuis la racine du dépôt :

```sh
pnpm --dir server install --frozen-lockfile
cp server/.env.example server/.env
# Adapter uniquement server/.env, puis lancer la base locale ci-dessous si nécessaire.
pnpm server:dev
pnpm server:build
pnpm server:start
```

Sous PowerShell : `Copy-Item server/.env.example server/.env`.
Les scripts `dev` et `start` chargent **server/.env**, jamais le fichier d'environnement racine.
En production, injecter les secrets par le gestionnaire de secrets de l'hôte et les variables
du conteneur ; aucune valeur secrète par défaut. Ne jamais mettre de secret sous `VITE_*`.
Le `.gitignore` racine exclut `.env` et `.env.*` à tous les niveaux, sauf `.env.example/template`.

Le backend peut également être utilisé hors du dépôt : copier `server/`, installer, puis
exécuter `pnpm build` et `pnpm start` dans ce dossier. Son lockfile est indépendant.
`pnpm build` à la racine conserve sa fonction frontend. Vitest exclut `server/` ; les tests
serveur utilisent le runner Node et leur propre configuration TypeScript.

Avant le premier démarrage, initialiser explicitement le namespace avec le compte migrateur
et les rôles avec un compte de provisionnement : voir le [runbook de persistance #131](../docs/mongodb-persistence.md).
Une base vide/non compatible est refusée par le démarrage et la readiness ; aucune migration
n'est exécutée automatiquement. `Database.mongo` expose le pool partagé aux futurs services.

## Organisation et extensions

| Fichier                                          | Responsabilité                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `src/index.ts`                                   | Configuration, signaux SIGINT/SIGTERM et échéance absolue d'arrêt             |
| `src/lifecycle.ts`                               | Connexion et ping avant écoute, nettoyage des échecs, arrêt idempotent        |
| `src/config.ts`                                  | Validation typée et erreurs expurgées avant toute connexion réseau            |
| `src/database.ts`                                | Un client/pool partagé, budgets réseau/opération, ping et fermeture           |
| `src/app.ts`                                     | Application injectable, protections HTTP, sondes et préfixe `/api/v1`         |
| `src/auth.ts`                                    | Principaux vérifiés, politiques tablette/capacité/périmètre, refus par défaut |
| `src/json.ts`, `src/errors.ts`, `src/network.ts` | Parseur v1, erreurs stables, allowlists IP/CIDR                               |
| `tests/`, `integration/`                         | Tests isolés, driver réel, panne réseau et arrêt de processus                 |

`buildApp` accepte une dépendance `Database` injectable, des `readinessChecks(signal)` et
un plugin `apiRoutes` enregistré sous `/api/v1`. Les routes de ce plugin doivent déclarer
`config.access` et un schéma de corps strict (`additionalProperties:false`, champs requis,
bornes explicites). Toute route sans politique est refusée, même avec un authentificateur
injecté. Le `Authenticator` par défaut renvoie toujours `null` : un Bearer arbitraire,
un rôle JSON ou un header de permissions n'est jamais une identité.

#132 devra fournir le vérificateur réel de session, registre, génération, clé et preuve,
et dériver le périmètre depuis des données vérifiées. Le point d'extension est du code serveur
de confiance, pas une option HTTP ni une option permettant une fausse authentification.
`authorize` sépare tablette liée à une chaîne et responsable avec `manage_enrollment`,
`read_ledger` ou `publish_catalog`, avec contrôle du périmètre. Aucune route métier de
démonstration ni écriture MongoDB anonyme n'est enregistrée.

## Configuration

Les seules variables obligatoires dans tous les environnements sont `NODE_ENV`,
`MONGODB_URI` et `MONGODB_DATABASE`. Les paramètres optionnels ont des valeurs bornées.
Une valeur invalide arrête le processus avec un diagnostic indiquant le nom du paramètre,
sans sa valeur. Les erreurs du driver ne sont jamais journalisées telles quelles.

| Variable                                   | Valeur par défaut / règle                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `NODE_ENV`                                 | Obligatoire : `test`, `development`, `production`                            |
| `MONGODB_URI`                              | Obligatoire ; `mongodb://` ou `mongodb+srv://`, aucun URI réel dans le dépôt |
| `MONGODB_DATABASE`                         | Obligatoire ; 1–63 caractères alphanumériques, `_` ou `-`                    |
| `MONGODB_TLS`                              | `true` ; `false` uniquement sur MongoDB localhost en test/développement      |
| `HOST`, `PORT`                             | `127.0.0.1`, `3000` ; IP littérale, port 1–65535                             |
| `MONGODB_POOL_MIN`, `MONGODB_POOL_MAX`     | `0`, `10` ; min 0–50, max 1–100 et min ≤ max                                 |
| `MONGODB_CONNECT_TIMEOUT_MS`               | `3000` ; 100–10000                                                           |
| `MONGODB_SELECTION_TIMEOUT_MS`             | `3000` ; 100–10000                                                           |
| `MONGODB_SOCKET_TIMEOUT_MS`                | `5000` ; 100–15000                                                           |
| `MONGODB_OPERATION_TIMEOUT_MS`             | `5000` ; 100–15000, également attente du pool                                |
| `READINESS_TIMEOUT_MS`                     | `2000` ; 100–5000, budget total partagé par les contrôles                    |
| `REQUEST_TIMEOUT_MS`                       | `25000` ; 100–25000, strictement supérieur aux budgets opération/readiness   |
| `SHUTDOWN_TIMEOUT_MS`                      | `10000` ; 100–30000 avant fermeture forcée des sockets HTTP                  |
| `BODY_LIMIT_BYTES`, `RESPONSE_LIMIT_BYTES` | `1048576` chacun ; 256–1048576                                               |
| `RATE_LIMIT_PER_MINUTE`                    | `120` ; 1–10000, par IP et processus, cache borné                            |
| `TRUSTED_PROXIES`                          | Vide ; liste d'IP/CIDR des proxies immédiats, obligatoire en production      |
| `READINESS_NETWORKS`                       | Localhost en test/dev ; liste explicite obligatoire en production            |
| `CORS_ORIGINS`                             | Vide ; origines exactes séparées par virgules, HTTPS en production           |
| `LOG_LEVEL`                                | `info` ; `silent`, `error`, `warn`, `info`, `debug`                          |

En test, le nom de base doit commencer par `samhain_test_`. En production, les noms contenant
les segments `test/dev/local` sont interdits, TLS et un compte authentifié sont obligatoires.
L'exploitant doit fournir des comptes/bases distincts et des droits minimaux. La validation
du nom n'est pas une preuve d'isolation : celle-ci repose aussi sur les credentials et le réseau.
Les options URI `tlsInsecure`, `tlsAllowInvalidCertificates`, `tlsAllowInvalidHostnames` et
la désactivation de TLS dans l'URI sont refusées. Pour une CA privée, monter sa chaîne de
confiance, par exemple via `NODE_EXTRA_CA_CERTS`, sans désactiver les contrôles de nom/certificat.

La connexion ne crée ni index, ni collection, ni données et ne modifie pas la configuration
de la base existante. Le pool est créé une seule fois, jamais à chaque requête. La récupération
réseau est celle du driver ; aucune boucle de recréation de clients n'est ajoutée.

## HTTP, JSON et signatures

- `/health/live` : `GET`, 200 `{"status":"ok"}`, sans dépendance MongoDB.
- `/health/ready` : `GET`, vrai `ping` MongoDB avec échéance et annulation ; 200
  `{"status":"ready"}` ou 503 `{"status":"unavailable"}`. Accès limité par IP effective
  après contrôle des proxies. Ni topologie, ni URI, ni stack dans la réponse.
- Autres méthodes sur ces sondes : 405 et `Allow: GET`. Route inconnue hors API : 404.
  Sous `/api/v1`, une route sans politique reste fermée (401).
- Erreurs communes : `{"error":{"code":"…"}}`, identifiant UUID généré serveur dans
  `X-Request-ID`. L'identifiant envoyé par le client n'est pas accepté comme identifiant de log.
- HTTPS requis en production, sans redirection ; pas de confiance dans `X-Forwarded-*`
  venant d'un pair qui n'est pas explicitement autorisé. En développement, utiliser uniquement localhost.
- Pas de CORS ouvert par défaut. Origine navigateur inconnue : 403 ; origines autorisées
  et preflight explicites. Les applications natives sans `Origin` ne reçoivent aucun droit
  supplémentaire. CORS ne remplace pas l'authentification.
- JSON UTF-8 uniquement, `Content-Encoding` refusé. Les octets sont conservés dans
  `request.rawBody` après lecture bornée, avant parsing. Les futures preuves #132 doivent
  vérifier ces octets exacts et leur action, jamais un `JSON.stringify(request.body)`.
- Parseur pur adapté du validateur existant Supabase : profondeur 64, clés dupliquées,
  UTF-8 invalide, surrogates isolés, U+0000 et nombres non entiers/exacts/sûrs refusés.
  Pas de coercition AJV, défaut implicite ou suppression de propriétés supplémentaires.
- Corps et réponses bornés ; réponses v1 tamponnées, streams refusés. Les schémas des futures
  routes imposeront aussi leurs limites métier. Délai de réception/headers/socket et délai
  du handler bornés. Les futurs accès DB doivent passer le signal de la requête et respecter
  le budget restant : un timeout HTTP n'annule pas un commit déjà acquis.
- Logs JSON : request ID, méthode, route enregistrée, statut, durée, code d'erreur et événements
  de cycle de vie. Pas d'URL brute/query, corps, token, cookie, header de signature ou exception
  du driver. Les serializers expurgent aussi les erreurs internes de Fastify.

Les futures routes financières #133 doivent reprendre **exactement** le contrat enrichi
§8.4 de l'architecture (contexte, catégorie/retryable, aucun ACK avant commit) et les deux
profils financiers existants. Cette fondation ne prétend pas valider un événement financier.

## Docker et MongoDB locale isolée

```sh
# Disposable fixture password only; never reuse a real credential.
export MONGODB_TEST_RBAC_PASSWORD="$(openssl rand -hex 32)"
docker compose -f server/compose.test.yaml up -d --wait
docker build -t samhain-pos-server:local server
```

La fixture Compose est un replica set **de test à un nœud**, sans authentification/TLS,
exposé exclusivement sur localhost:27019, avec stockage tmpfs jetable. Elle sert aux tests
du backend exécuté sur l'hôte et aux futures transactions ; ce n'est pas une architecture
de production. `directConnection=true` permet d'utiliser la fixture depuis l'hôte.
Une seconde fixture standalone Auth sur localhost:27020 teste les privilèges et le refus de
topologie. Elle doit être neuve à chaque campagne d'intégration (tmpfs recréé après `down`).
Sous PowerShell, générer auparavant le mot de passe de fixture avec
`$env:MONGODB_TEST_RBAC_PASSWORD = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')`.

Production, après création d'un fichier serveur secret distinct et d'un réseau privé
reliant le proxy au conteneur (remplacer les noms d'exemple) :

```sh
docker run --detach --name samhain-api --network samhain-private \
  --env-file /secure/samhain-server.env --read-only --cap-drop ALL \
  --security-opt no-new-privileges --stop-timeout 30 samhain-pos-server:local
docker stop --time 30 samhain-api
```

Le fichier secret doit définir `NODE_ENV=production`, l'URI avec compte autorisé, la base,
`MONGODB_TLS=true`, `TRUSTED_PROXIES` et `READINESS_NETWORKS`. `HOST=0.0.0.0` est défini par
l'image ; aucun port n'est publié directement. Le proxy rejoint le réseau privé et transmet
la vraie adresse/protocole selon les règles ci-dessous. L'image multi-stage exécute Node
comme utilisateur `node`, avec dépendances de production seulement et commande exec ;
`.dockerignore` exclut tous les fichiers sauf la liste source/manifeste/lockfile/tsconfig.
Les secrets ne passent ni en `ARG`, ni en `COPY`.

## Obligations du reverse proxy et de l'exploitation

1. Terminer TLS avec certificat valide, nom DNS vérifié et renouvellement supervisé ; HTTP
   public redirigé vers HTTPS ou fermé au proxy, jamais routé directement vers Fastify.
2. Autoriser l'accès au port interne uniquement depuis les proxies/sondes prévus. Restreindre
   MongoDB aux adresses de sortie de l'API, authentifier le compte et vérifier TLS vers tous
   les membres. Aucune exposition de MongoDB aux tablettes, aucun compte administrateur en service.
3. Supprimer puis reconstruire `X-Forwarded-For` et `X-Forwarded-Proto` à partir du client
   réellement connecté. Ne pas recopier une chaîne de headers fournie par Internet.
   `TRUSTED_PROXIES` contient les pairs immédiats, pas un compteur de hops ni toutes les IP privées.
4. Bloquer `/health/ready` à la frontière publique ; l'autoriser uniquement aux réseaux
   d'exploitation/sondes. Une sonde passant par le proxy doit envoyer HTTPS et une IP effective
   autorisée. Liveness accessible à faible quota. Désactiver les logs de query/headers/corps au proxy.
5. Limiter corps à ≤1 MiB, connexions simultanées et débit par IP, y compris les chemins inconnus,
   les refus CORS et preflight. Le limiteur applicatif par processus ne remplace pas un quota global
   multi-répliques ni la protection de bande passante du proxy.
6. Limiter réception des headers/corps (≤25 s), réponse amont autour de 27 s, inférieure aux 30 s
   natifs ; budget métier serveur ≤25 s. Ne pas rejouer automatiquement les POST et ne pas
   réécrire/compresser les corps signés. Appliquer aussi la limite de réponse de 1 MiB.
7. Accorder au processus au moins `SHUTDOWN_TIMEOUT_MS + MONGODB_OPERATION_TIMEOUT_MS + 1000`
   avant SIGKILL. L'arrêt refuse les nouveaux appels, draine HTTP puis ferme le pool une seule fois ;
   sockets HTTP forcées à l'échéance et code non nul si l'échéance absolue du processus est dépassée.

Startup DB impossible : arrêt sans écoute HTTP, log `SERVER_START_FAILED`. Après démarrage,
perte DB : readiness 503 avec `Retry-After`, liveness conservée. Pas de réponse métier fictive.
Ne pas activer d'ingestion avant inventaire de topologie, index, rôles et sauvegarde/restauration.

## Tests

```sh
pnpm server:build
pnpm server:typecheck
pnpm server:test
```

Suite MongoDB explicite, après démarrage de la fixture, sous PowerShell :

```powershell
$env:MONGODB_TEST_URI = 'mongodb://127.0.0.1:27019/?directConnection=true'
$env:MONGODB_TEST_DATABASE = 'samhain_test_local'
$env:MONGODB_TEST_DISPOSABLE = 'true'
$env:MONGODB_TEST_RBAC_URI = 'mongodb://127.0.0.1:27020/'
pnpm server:test:integration
docker compose -f server/compose.test.yaml down
```

Ou POSIX :

```sh
MONGODB_TEST_URI='mongodb://127.0.0.1:27019/?directConnection=true' \
MONGODB_TEST_DATABASE=samhain_test_local MONGODB_TEST_DISPOSABLE=true \
MONGODB_TEST_RBAC_URI='mongodb://127.0.0.1:27020/' pnpm server:test:integration
```

Les mêmes variables peuvent être stockées dans `server/.env.integration` (ignoré par Git).
La suite ignore les variables de connexion de production, exige localhost:27019 sans credentials,
un namespace `samhain_test_*`, l'opt-in jetable et le replica set `samhain-test`.
Depuis #131, elle initialise des namespaces de test uniques et écrit des fixtures explicitement
jetables pour les preuves d'atomicité, sans nettoyage ni dropDatabase. URI absente : tests MongoDB marqués
non exécutés ; URI fournie mais base inaccessible ou garde invalide : échec.
La panne est simulée par coupure d'un relais TCP local, sans arrêter/modifier la base partagée.
Les signaux POSIX du processus compilé sont testés sous Linux et explicitement ignorés sous Windows.
La CI dédiée utilise uniquement cette fixture, teste l'image et son arrêt, sans secret distant.

### Vérifications historiques exécutées pour #130

- Node local 24.8.0, pnpm 10.33.0 ; installation et compilation indépendantes du serveur.
- `pnpm server:build`, `pnpm server:typecheck` : réussis ; `pnpm server:test` : **32 tests réussis**.
- Intégration réelle MongoDB **8.0.16**, replica set local jetable : connexion, nom de base,
  aucune collection créée par les sondes, ping renouvelé et coupure réseau contrôlée validés.
  Test SIGTERM/SIGINT du processus ignoré sur Windows ; fermeture HTTP/pool testée localement.
  Bilan intégration : **3 réussis, 1 ignoré** ; workflow Linux ajouté mais non exécuté ici.
- `pnpm test:run` : **525 tests / 57 fichiers réussis**.
- `pnpm build`, `pnpm build:android:test`, `pnpm build:android:production` : réussis.
- `pnpm lint` et installation serveur `--frozen-lockfile` : réussis.
- Scan de 4 artefacts frontend et des 6 ressources publiques de l'APK debug : aucune URI
  MongoDB ni variable `MONGODB_URI`. Aucun fichier financier/Room/impression modifié.
- Gradle `testDebugUnitTest assembleDebug` : **94 tests, 1 échec et 1 ignoré**.
  `TabletAuthServiceTest.encryptedCredentialsSurviveDiskReopenAndNeverLeaveNoBackupStorage`
  attend `authorized` mais reçoit `pending` (ligne 64). Échec reproduit seul ; aucun fichier
  Android n'a été modifié par #130. Les tests natifs ne sont donc pas déclarés verts.
- Assemblage séparé : `:app:assembleDebug` réussi (à jour) ; `:app:assembleRelease` bloqué
  par l'absence des variables de signature release. Aucun secret de signature n'a été demandé.
- Docker Desktop installé mais moteur bloqué au démarrage : erreur interne `Inference manager`.
  **Build/exécution Docker et Compose non validés localement** ; commandes/CI à exécuter sur moteur sain.
- Aucun déploiement, secret réel, migration Supabase, essai de synchronisation tablette ou essai USB.

Sur ce poste, Corepack/pnpm et les sockets localhost échouent dans le bac à sable (DNS/EPERM/EACCES).
Les vérifications réussies utilisent le pnpm 10.33.0 déjà installé et, lorsque nécessaire, l'accès
local autorisé hors bac à sable. Ces limites d'outillage ne sont pas des résultats de tests applicatifs.

## Limites et prochaines issues

#131 fournit les schémas, index, rôles, transactions et contrôles intégrés à `Database.check`.
`ready` vérifie connexion, topologie, manifeste/index et, en production, privilèges effectifs ;
cela ne signifie **pas qu'une ingestion HTTP est implémentée**. Commandes `db:migrate`,
`db:roles`, `db:verify`, `db:verify-runtime`, `db:audit` et limites détaillées dans le
[runbook #131](../docs/mongodb-persistence.md).
#132 ajoute Auth/OIDC/enrôlement et preuves, #133 ingestion et contrats d'erreur enrichis,
#134 transport/configuration Android, #135 catalogue. Aucun de ces parcours n'est implémenté ici.
La caisse conserve son fonctionnement local et sa destination Supabase actuelle.

Références primaires : [options et délais Fastify](https://fastify.dev/docs/latest/Reference/Server/),
[validation sans transformations](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/),
[options du driver MongoDB](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/).
