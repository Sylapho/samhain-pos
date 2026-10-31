# Samhain Witches — préparation de la caisse W

Cette copie du projet utilise l'identifiant Android `fr.samhain.witches`. Elle peut donc
cohabiter avec `fr.samhain.pos` sur la même tablette sans partager Room, le stockage WebView,
les ventes, la numérotation ou les credentials. Le code W ne provisionne que **Caisse W**.
Le catalogue initial vient de la grille « Witches Potion Bar » fournie le 30 octobre 2026 ;
tous les taux de TVA y sont provisoirement fixés à **20 % à la demande du responsable**.
Les informations administratives du reçu restent celles de Samhain POS ; son titre devient
« Samhain Witches ». Aucune donnée ou vente de Samhain POS n'est importée.

Le ticket de préparation n’est pas utilisé. Le ticket de caisse est facultatif : une vente
peut être enregistrée sans imprimante lorsque ce ticket n’est pas demandé.
La vente est enregistrée localement avant l'impression et reste valide si
l'imprimante échoue. L'API MongoDB reste hors du chemin critique de l'encaissement.

## Identités réservées pour W

| Élément                            | Valeur                                                       |
| ---------------------------------- | ------------------------------------------------------------ |
| Base MongoDB                       | `samhain_witches`                                            |
| Identifiant de destination API     | `c01664f7-85df-46c2-9a4b-45b1f9e653dc`                       |
| Identifiant d'organisation W       | `70381b38-b90b-4181-9d80-e76c4d98a67c`                       |
| Identifiant de festival W          | `9c5bafa9-4953-43dd-ab8c-47274576eb1c`                       |
| Identifiant Android et retour OIDC | `fr.samhain.witches` et `fr.samhain.witches:/oauth2redirect` |

Ces UUID sont des identifiants techniques neufs, **pas** des droits serveur. Ne pas
réutiliser la destination de Samhain POS. Ne pas changer l'UUID de destination après
enrôlement, publication ou premier acquittement ; un autre serveur ou une autre base
nécessitera sa propre identité.

## Vérifier le code en local

Depuis `C:\Users\arthu\Documents\code\samhain-witches` dans PowerShell :

```powershell
pnpm install --offline --frozen-lockfile
pnpm --dir server install --offline --frozen-lockfile
pnpm exec tsc -b --pretty false
pnpm test:run
pnpm lint
pnpm --dir server typecheck
pnpm --dir server test
pnpm --dir server build
pnpm dashboard:build
```

La validation Android et l'impression physique exigent ensuite JDK 21, Android SDK,
la tablette et l'imprimante. Aucun résultat matériel n'est implicite dans les tests Web.

## Préparer le VPS ensemble, sans toucher à Samhain POS

Les fichiers `server/compose.witches.yaml` et `dashboard/compose.yaml` ont des noms de
projet, images et alias réseau distincts. Ils visent le MongoDB existant sur le VPS,
**dans une nouvelle base**, et ne publient aucun port directement. Avant de les utiliser,
vérifier sur le VPS les réseaux `samhain_database` et `lcdd_proxy`, le nom du conteneur
MongoDB, le replica set, la CA et le chemin du Caddyfile : ce sont des paramètres
d'exploitation issus de la configuration Samhain POS, pas une découverte de ce déploiement.

1. Choisir et configurer deux domaines HTTPS distincts, un pour l'API W et un pour le
   tableau de bord W. Remplacer les hôtes dans `server/Caddyfile.witches.example` et
   `dashboard/Caddyfile`. Ne pas modifier les blocs Samhain POS du Caddyfile.
2. Dans le Keycloak existant, créer un **client public Android W distinct** avec Code +
   PKCE S256 et retour exact `fr.samhain.witches:/oauth2redirect`. Choisir l'audience et
   les scopes correspondants ; aucun secret client ne va dans l'APK.
3. Préparer les comptes MongoDB **migrateur**, **runtime** et **lecteur dashboard** propres
   à `samhain_witches`, et les clés API W, hors Git. Le runtime doit recevoir seulement
   `samhain_runtime_v2` sur la nouvelle base ; le lecteur seulement
   `samhain_reader_v1`. `dashboard/create-reader.mongosh.js` prépare le lecteur, après
   installation du rôle et revue du compte cible.
4. Préparer une configuration de migration avec `MONGODB_DATABASE=samhain_witches`,
   `MONGODB_ADMIN_TARGET=samhain_witches`, les credentials migrateur et la CA TLS.
   Exécuter dans cet ordre `db:migrate`, `db:roles`, puis `db:verify`,
   `db:verify-runtime` avec les credentials runtime. Les scripts de migration sont
   dans `server/src/persistence/cli.ts` et n'effacent pas la base Samhain POS.

   ```bash
   # Dans les sources W sur le VPS, avec les variables de migration protégées chargées :
   pnpm --dir server db:migrate
   pnpm --dir server db:roles
   pnpm --dir server db:verify
   # Charger ensuite les variables du compte runtime W, puis :
   pnpm --dir server db:verify-runtime
   ```

5. Créer dans **la nouvelle base** les documents `organizations`, `festivals` et
   `scopeGrants` en utilisant les deux UUID ci-dessus et le couple Keycloak réel
   **issuer + sub** du responsable. Le modèle et les gardes sont détaillés dans
   `docs/tablet-enrollment.md`. Attribuer séparément `manage_enrollment`,
   `publish_catalog` et `read_ledger` selon les usages voulus. Le PIN local ne donne
   aucun de ces droits. Aucun compte ou grant n'est créé automatiquement.
6. Copier `server/api.witches.env.example` vers un fichier protégé hors dépôt, remplacer
   **tous** les `REPLACE_*`, et renseigner le nouvel URI MongoDB, la nouvelle origine
   HTTPS, le client Keycloak W, la CA et les chemins de clés. Garder `API_DESTINATION_ID`
   égal à l'UUID ci-dessus. Utiliser des comptes et clés différents de Samhain POS.
7. Copier `dashboard/dashboard.env.example` hors dépôt avec le lecteur W. Le tableau
   de bord actuel fonctionne en lecture seule **sans authentification publique** ;
   décider ensemble si cette même exposition convient avant de publier son domaine.

Archives de sources sans `.env`, clés ni certificats, à créer depuis Windows :

```powershell
node scripts/package-witches-server.mjs
pnpm dashboard:package
```

Après transfert contrôlé vers le VPS, extraire chaque archive dans son dossier
séparé. Les commandes de lancement prévues, depuis ces dossiers, sont :

```bash
cd /opt/samhain-witches-api
export WITCHES_API_ENV_FILE=/opt/samhain-witches-deploy/api.env
export WITCHES_MONGO_CA_FILE=/opt/samhain-deploy/certificates/mongo-ca.crt
export WITCHES_SIGNING_KEY_FILE=/opt/samhain-witches-deploy/api-signing.pem
export WITCHES_ENCRYPTION_KEY_FILE=/opt/samhain-witches-deploy/api-encryption.key
docker compose -f server/compose.witches.yaml config --quiet
docker compose -f server/compose.witches.yaml up -d --build api

cd /opt/samhain-witches-dashboard
export DASHBOARD_ENV_FILE=/opt/samhain-witches-deploy/dashboard.env
export WITCHES_DASHBOARD_ORIGIN=https://DOMAINE_DASHBOARD_W
docker compose -f dashboard/compose.yaml config --quiet
docker compose -f dashboard/compose.yaml up -d --build dashboard
```

Ces commandes sont **préparées, non exécutées**. Les chemins, domaines, DNS, droits
de fichiers, certificats et résultats de `verify-runtime` doivent être confirmés
sur le VPS avant le démarrage. Le dashboard et l'API se déploient dans des dossiers
sources séparés sous `/opt`, avec les variables protégées dans
`/opt/samhain-witches-deploy`.

## Préparer l'APK W puis l'installer ensemble

Créer `.env.production.local` dans la copie W, hors Git, avec l'origine HTTPS W et
le même `API_DESTINATION_ID` que le serveur. Confirmer séparément les valeurs via
`SAMHAIN_API_PRODUCTION_URL` et `SAMHAIN_API_PRODUCTION_DESTINATION_ID`. Le fichier
`witches-android-production.env.example` montre les champs publics, sans secret.
La signature release utilise le keystore choisi et les variables `SAMHAIN_RELEASE_*`
hors dépôt. La version 1 de W utilise un `applicationId` différent de Samhain POS ;
ne jamais désinstaller cette dernière pour installer W.

```powershell
$env:JAVA_HOME = 'C:\Users\arthu\.jdks\jbr-21.0.11'
$env:ANDROID_HOME = 'C:\Users\arthu\AppData\Local\Android\Sdk'
pnpm android:sync:production
.\android\gradlew.bat -p android testReleaseUnitTest assembleRelease
adb devices
adb -s <SERIAL_TABLETTE> install -r .\android\app\build\outputs\apk\release\app-release.apk
adb -s <SERIAL_TABLETTE> shell monkey -p fr.samhain.witches -c android.intent.category.LAUNCHER 1
```

Utiliser **le numéro de série ADB exact**. Après installation, vérifier Caisse W,
les produits/prix, la TVA 20 %, les deux tickets, une vente hors ligne, les données
locales, l'enrôlement W, la publication de catalogue et les acquittements dans
`samhain_witches`. La présence de l'APK seule ne prouve aucune synchronisation.
