# Samhain POS

Samhain POS est une caisse tactile conçue pour l'encaissement sur tablette Android pendant le festival Samhain. L'application fonctionne localement, y compris sans connexion réseau, et intègre l'impression USB ESC/POS pour une Epson TM-T88V compatible.

Le catalogue est une donnée locale administrable. Il est conservé dans Room/SQLite sur Android et dans IndexedDB sur le web ; `src/data/initialCatalog.ts` sert uniquement de seed lors de la première utilisation. La build de production contrôle ce seed et les informations administratives avant de générer le moindre artefact.

La [distribution versionnée du catalogue Supabase (#115)](docs/catalog-distribution.md) télécharge et valide des publications complètes sans attendre le réseau pour vendre. Administration → Catalogue partagé permet leur activation sur une caisse au repos et la résolution explicite des conflits. Les éditions et ruptures locales sont conservées ; les anciennes migrations de prix ne sont appliquées qu'une fois. Le transport authentifié est Android ; le cache transactionnel IndexedDB reste disponible sur le Web.

## Fonctionnalités présentes

- saisie tactile d'une commande, catégories, variantes, options et retrait d'ingrédients ;
- administration locale des produits, prix, TVA, disponibilité et préparation ;
- encaissement CB ou espèces ;
- création durable de la commande et de son paiement dans Room/SQLite sur Android, ou IndexedDB sur le web, avant l'impression ;
- journal d’encaissement append-only avec ventes scellées, corrections liées et chaîne SHA-256 ;
- numéros de commande et de reçu alloués dans la même transaction que la commande ;
- historique local des commandes et réimpression avec les numéros d'origine ;
- mode responsable local pour les opérations administratives et les duplications de ticket client ;
- clôture et sauvegarde JSON vérifiée hors du stockage privé via le sélecteur Android ;
- suivi indépendant du ticket client et du ticket de préparation, y compris en cas d'échec partiel ;
- reprise prudente des impressions incomplètes après redémarrage ;
- transport USB Android natif, permission USB et contrôle de l'état ESC/POS de l'imprimante.

Une commande confirmée n'est pas annulée par une erreur d'impression. Avant chaque envoi, les documents concernés sont marqués `unknown` : après une interruption, le caissier doit vérifier le papier éventuellement sorti avant de réimprimer. Le transport USB confirme l'envoi des octets, pas la sortie physique de chaque ticket.

Les commandes sont conservées sur l'appareil tant que les données de l'application ne sont pas effacées. Room/SQLite fonctionne entièrement hors ligne ; IndexedDB reste le stockage web et la source de migration des anciennes installations Android. La migration et le versioning natifs sont détaillés dans [`docs/android-persistence.md`](docs/android-persistence.md). La synchronisation financière différée Android copie les événements vers Supabase via l'outbox persistante, sans participer à l'encaissement ou à l'impression et sans supprimer les données locales. Son activation exige configuration, enrôlement et continuité vérifiée.

La sauvegarde et la restauration automatiques Android, y compris le transfert appareil-à-appareil, sont désactivées : elles ne doivent jamais cloner l'identité ni le journal d'une caisse. Le mécanisme de sauvegarde métier supporté est l'archive Samhain vérifiée. Toute désinstallation ou suppression des données locales est destructive sans archive préalable. Le runbook de remplacement, mise à jour et reprise se trouve dans [`docs/tablet-replacement-and-backup.md`](docs/tablet-replacement-and-backup.md).

Le journal, les clôtures et les archives vérifiables sont décrits dans [`docs/sales-ledger.md`](docs/sales-ledger.md). Cette protection technique ne vaut pas, à elle seule, attestation ou certification de conformité pour une exploitation réelle.

Le PIN responsable est créé sur chaque tablette et fonctionne entièrement hors ligne. Il n’est jamais stocké en clair : seul un dérivé PBKDF2-SHA-256 versionné, avec sel aléatoire propre à l’installation, est conservé dans le stockage local. La session déverrouillée reste exclusivement en mémoire, expire après cinq minutes d’inactivité administrative et est verrouillée lorsque l’application passe en arrière-plan. Cette barrière vise les manipulations accidentelles ; elle ne protège pas contre un accès physique privilégié à la tablette.

## Prérequis

La configuration Supabase optionnelle est décrite dans [`docs/supabase-configuration.md`](docs/supabase-configuration.md). L'enrôlement, les sessions Android chiffrées par Keystore, la révocation et le remplacement sont décrits dans [`docs/tablet-enrollment.md`](docs/tablet-enrollment.md). Sans configuration ou autorisation, les ventes et impressions restent locales. L'architecture de référence est [`docs/architecture-supabase-offline-first.md`](docs/architecture-supabase-offline-first.md). L'[ingestion transactionnelle #36](docs/supabase-ingestion.md) reçoit les cinq kinds, les imports legacy et les diagnostics de préfixe ; l'[outbox/worker #35](docs/outbox-synchronization.md) fournit la capture et la reprise natives.

La [campagne d'intégration #117](docs/supabase-integration-validation.md) se lance avec `pnpm test:supabase` après `pnpm android:sync:test`. Elle réinitialise uniquement la pile Supabase Docker locale jetable `samhain-pos` et teste Auth, enrôlement signé, RLS/RPC, ingestion et Room. Le job CI dédié n'utilise aucun secret de production. Le [runbook de déploiement et récupération](docs/supabase-deployment-runbook.md) décrit le rollback compatible et la reprise sans purge. La [campagne matérielle réseau/USB](docs/tm-t88v-usb-test-plan.md) reste une validation physique distincte.

Les migrations PostgreSQL privées, les règles RLS et leurs tests sont décrits dans [`docs/supabase-database.md`](docs/supabase-database.md). Leur développement local utilise Docker et Supabase CLI ; ces outils ne sont pas nécessaires pour démarrer la caisse. L'ingestion financière passe exclusivement par les Edge Functions authentifiées et leurs RPC réservées au serveur.

- Node.js 22 recommandé ;
- pnpm (via Corepack) ;
- JDK 21 (le JDK 25 n'est pas compatible avec le wrapper Gradle actuel) ;
- Android Studio et Android SDK, avec Build Tools et Platform Tools, pour les workflows Android ;
- une tablette Android compatible USB Host pour l'impression réelle ;
- une Epson TM-T88V alimentée et un câble de données USB-C vers USB-B pour les essais matériel.

## Installation

```bash
corepack enable
pnpm install
```

## Workflow web

### Développement

```bash
pnpm dev
```

Ouvrir l'URL indiquée par Vite. Le panneau de développement est visible dans ce mode ; il permet notamment de prévisualiser les tickets sans imprimante et de tester les diagnostics USB.

### Vérifications automatisées

```bash
pnpm test:run
pnpm lint
pnpm build:android:test
```

`pnpm build:android:test` effectue la vérification TypeScript et une build Vite en mode `android-test`, où les placeholders administratifs sont autorisés pour les essais.

### Build web de production

```bash
pnpm build
```

Cette commande correspond au mode Vite `production`. Elle échoue immédiatement si les informations administratives sont vides, fictives ou marquées comme démonstration, ou si une donnée commerciale reste `temporary`. En production, le panneau de développement est toujours exclu, même si `VITE_ENABLE_DEV_PANEL=true` est défini localement.

## Workflow Android de test

Le mode `android-test` est destiné aux essais sur tablette. Il conserve le panneau de développement et autorise les données administratives de démonstration ; il ne doit pas être utilisé pour une exploitation réelle.

### Première génération du projet Android

```bash
pnpm android:add:test
```

La commande construit les ressources web en mode `android-test`, crée le projet Capacitor Android puis installe les plugins locaux Epson, Room et export de documents. Le dossier `android/` est versionné ; cette commande est nécessaire lorsqu'il n'existe pas encore.

### Synchronisation après une modification web

```bash
pnpm android:sync:test
```

Elle reconstruit les ressources `android-test`, exécute la synchronisation Capacitor et réapplique le plugin USB de manière idempotente.

### Ouvrir et lancer dans Android Studio

```bash
pnpm android:open
```

Dans Android Studio, connecter la tablette avec le débogage USB activé, puis lancer l'application avec **Run**. Pour tester l'imprimante, débrancher ensuite la tablette du PC si elle partage le même port USB-C, connecter l'Epson, ouvrir **Outils de démonstration**, détecter le périphérique, demander l'autorisation USB Android, puis lancer l'impression de test ou le flux de caisse.

Le plugin cherche une interface ayant une sortie BULK et une entrée BULK sur la même interface, puis lit les statuts temps réel `DLE EOT 2`, `DLE EOT 3` et `DLE EOT 4`. Il bloque un job si le matériel ne peut pas être vérifié, si le capot est ouvert, si le papier est absent ou si une erreur est signalée.

## Release Android de production

La procédure reproductible complète — création et sauvegarde du keystore, variables de signature, versioning, build, vérification de l'APK, installation, mise à jour, persistance Room et conduite à tenir en cas d'échec — est décrite dans [`docs/android-production-release.md`](docs/android-production-release.md).

La production utilise des commandes distinctes, sûres par défaut : les alias non qualifiés `android:add` et `android:sync` pointent vers ce mode. La release `1.0.0` utilise `versionCode 1` et conserve l'identifiant Android `fr.samhain.pos`.

### Première génération

```bash
pnpm android:add:production
# équivalent : pnpm android:add
```

### Synchronisations suivantes

```bash
pnpm android:sync:production
# équivalent : pnpm android:sync
```

Ces commandes :

1. construisent Vite en mode `production` ;
2. refusent la build si les informations administratives confirmées ne sont pas renseignées ;
3. excluent le panneau de développement ;
4. synchronisent Capacitor ;
5. installent ou réappliquent les plugins locaux USB Epson, stockage Room et export SAF.

Pour vérifier uniquement les ressources web qui seront embarquées :

```bash
pnpm build:android:production
```

Après configuration locale des quatre variables `SAMHAIN_RELEASE_*`, la commande Windows suivante génère l'APK signé :

```powershell
Set-Location android
.\gradlew.bat assembleRelease
```

L'artefact est `android/app/build/outputs/apk/release/app-release.apk`. En l'absence d'un keystore ou d'un credential, la tâche échoue explicitement ; elle ne se replie jamais sur la clé debug. Aucune clé ni aucun mot de passe de production n'est stocké dans ce dépôt.

Avant toute exploitation, suivre la checklist matériel du guide de release : parcours d'encaissement, persistance après mise à jour, permission USB, statut matériel, deux tickets et reprise après un échec d'impression. Une build réussie ne remplace pas ces vérifications sur la tablette et l'imprimante ciblées.

## Intégration native Android

Les plugins Capacitor locaux sont fournis dans `native/android/` et copiés dans le projet Android par l'installateur commun. `EpsonUsbPrinterPlugin`, `OrderStoragePlugin`, `CatalogStoragePlugin` et `DocumentExporterPlugin` sont enregistrés dans `MainActivity` avant `super.onCreate(savedInstanceState)`, condition nécessaire pour que Capacitor les rende disponibles. `DocumentExporterPlugin` utilise `ACTION_CREATE_DOCUMENT` et ne demande aucune permission globale de stockage.

Si `MainActivity.kt` ou le manifeste ont été régénérés, réinstaller uniquement l'intégration native :

```bash
pnpm android:install-native
```

Cette intégration utilise la communication USB ESC/POS directe, pas le SDK Epson ePOS.

## Architecture utile

```text
src/data/initialCatalog.ts             seed initial, jamais relu comme catalogue runtime
src/store/cartStore.ts                 état temporaire du panier
src/services/catalogRepository.ts      contrat catalogue et implémentations IndexedDB/Room
src/services/catalogService.ts         validation et opérations métier du catalogue
src/features/catalog/ProductManagementDialog.tsx administration des produits
src/services/orderRepository.ts        contrat repository et implémentation IndexedDB
src/services/roomOrderRepository.ts    repository Android et migration legacy
src/services/orderRepositoryFactory.ts sélection Capacitor Room/IndexedDB
src/services/orderService.ts           commandes, séquences et cycle d'impression
src/services/salesLedgerService.ts      corrections, clôtures, contrôle et archives
src/services/salesBackupService.ts      écriture, relecture et validation des sauvegardes
src/features/ledger/*                   interface responsable de clôture et sauvegarde
src/services/responsibleModeService.ts  credential local et session responsable en mémoire
src/features/responsible/*              saisie et création du PIN responsable
src/features/orders/OrderHistory.tsx   historique et réimpression
src/printing/*                         rendu des tickets et orchestration des jobs
src/native/epsonUsbPrinter.ts          pont Capacitor TypeScript
native/android/EpsonUsbPrinterPlugin.kt plugin Android USB natif
native/android/OrderStoragePlugin.kt    bridge Room/SQLite natif
native/android/CatalogStoragePlugin.kt  bridge du catalogue Room/SQLite
native/android/SamhainPosDatabase.kt    schéma, DAO et migrations Room
scripts/install-android-usb-printer.mjs installateur natif commun idempotent
```

## Scripts disponibles

| Commande                           | Usage                                               |
| ---------------------------------- | --------------------------------------------------- |
| `pnpm dev`                         | Serveur Vite de développement                       |
| `pnpm test:run`                    | Suite Vitest sans mode interactif                   |
| `pnpm lint`                        | Analyse ESLint                                      |
| `pnpm build`                       | Build web de production avec garde-fous             |
| `pnpm build:android:test`          | Build web `android-test`                            |
| `pnpm build:android:production`    | Build web `production` destinée à Android           |
| `pnpm android:add:test`            | Création initiale Android pour les essais           |
| `pnpm android:sync:test`           | Synchronisation Android pour les essais             |
| `pnpm android:add[:production]`    | Création initiale Android de production             |
| `pnpm android:sync[:production]`   | Synchronisation Android de production               |
| `pnpm android:open`                | Ouverture du projet dans Android Studio             |
| `pnpm android:install-native`      | Réinstallation de Room et des plugins natifs locaux |
| `pnpm android:install-usb-printer` | Réinstallation du plugin USB local                  |
