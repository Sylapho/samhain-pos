# Samhain POS

Samhain POS est une caisse tactile conçue pour l'encaissement sur tablette Android pendant le festival Samhain. L'application fonctionne localement, y compris sans connexion réseau, et intègre l'impression USB ESC/POS pour une Epson TM-T88V compatible.

Le catalogue actuellement embarqué dans `src/mocks/products.ts` reste constitué de données de développement. Les informations administratives du ticket dans `src/config/organization.ts` sont également des placeholders et empêchent volontairement toute build web de production tant qu'elles ne sont pas remplacées.

## Fonctionnalités présentes

- saisie tactile d'une commande, catégories, variantes, options et retrait d'ingrédients ;
- encaissement CB ou espèces ;
- création durable de la commande et de son paiement dans IndexedDB avant l'impression ;
- numéros de commande et de reçu alloués dans la même transaction que la commande ;
- historique local des commandes et réimpression avec les numéros d'origine ;
- suivi indépendant du ticket client et du ticket de préparation, y compris en cas d'échec partiel ;
- reprise prudente des impressions incomplètes après redémarrage ;
- transport USB Android natif, permission USB et contrôle de l'état ESC/POS de l'imprimante.

Une commande confirmée n'est pas annulée par une erreur d'impression. Avant chaque envoi, les documents concernés sont marqués `unknown` : après une interruption, le caissier doit vérifier le papier éventuellement sorti avant de réimprimer. Le transport USB confirme l'envoi des octets, pas la sortie physique de chaque ticket.

Les commandes sont conservées sur l'appareil tant que les données de l'application ne sont pas effacées. Il n'existe pas encore de synchronisation entre appareils ni de backend.

## Prérequis

- Node.js 22 recommandé ;
- pnpm (via Corepack) ;
- Android Studio et Android SDK pour les workflows Android ;
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

Cette commande correspond au mode Vite `production`. Elle échoue actuellement par conception tant que les données de démonstration de `src/config/organization.ts` n'ont pas été remplacées par les informations administratives confirmées et que `usesDemoPlaceholders` n'est pas passé à `false`. En production, le panneau de développement est toujours exclu, même si `VITE_ENABLE_DEV_PANEL=true` est défini localement.

## Workflow Android de test

Le mode `android-test` est destiné aux essais sur tablette. Il conserve le panneau de développement et autorise les données administratives de démonstration ; il ne doit pas être utilisé pour une exploitation réelle.

### Première génération du projet Android

```bash
pnpm android:add:test
```

La commande construit les ressources web en mode `android-test`, crée le projet Capacitor Android puis installe le plugin USB Epson local. Le dossier `android/` est versionné ; cette commande est nécessaire lorsqu'il n'existe pas encore.

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

## Workflow Android de production

La production utilise des commandes distinctes, sûres par défaut : les alias non qualifiés `android:add` et `android:sync` pointent vers ce mode.

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
5. installent ou réappliquent le plugin USB Epson local.

Pour vérifier uniquement les ressources web qui seront embarquées :

```bash
pnpm build:android:production
```

Le projet Android ainsi synchronisé s'ouvre avec `pnpm android:open`. La génération d'un APK/AAB signé relève ensuite de la configuration de signature et des variantes Gradle dans Android Studio ; aucune clé de production n'est stockée dans ce dépôt.

Avant toute exploitation, remplacer les données de démonstration dans `src/config/organization.ts`, vérifier manuellement le parcours d'encaissement, la permission USB, le statut matériel, les deux tickets et la reprise après un échec d'impression. Une build réussie ne remplace pas ces vérifications sur la tablette et l'imprimante ciblées.

## Plugin d'impression Android

Le plugin Capacitor local est fourni dans `native/android/EpsonUsbPrinterPlugin.kt` et est copié dans le projet Android par le script d'installation. Il est enregistré dans `MainActivity` avant `super.onCreate(savedInstanceState)`, condition nécessaire pour que Capacitor le rende disponible.

Si `MainActivity.kt` ou le manifeste ont été régénérés, réinstaller uniquement l'intégration native :

```bash
pnpm android:install-usb-printer
```

Cette intégration utilise la communication USB ESC/POS directe, pas le SDK Epson ePOS.

## Architecture utile

```text
src/mocks/products.ts                  catalogue de développement
src/store/cartStore.ts                 état temporaire du panier
src/services/orderRepository.ts        stockage IndexedDB
src/services/orderService.ts           commandes, séquences et cycle d'impression
src/features/orders/OrderHistory.tsx   historique et réimpression
src/printing/*                         rendu des tickets et orchestration des jobs
src/native/epsonUsbPrinter.ts          pont Capacitor TypeScript
native/android/EpsonUsbPrinterPlugin.kt plugin Android USB natif
scripts/install-android-usb-printer.mjs installation idempotente du plugin
```

## Scripts disponibles

| Commande | Usage |
| --- | --- |
| `pnpm dev` | Serveur Vite de développement |
| `pnpm test:run` | Suite Vitest sans mode interactif |
| `pnpm lint` | Analyse ESLint |
| `pnpm build` | Build web de production, bloquée avec les placeholders |
| `pnpm build:android:test` | Build web `android-test` |
| `pnpm build:android:production` | Build web `production` destinée à Android |
| `pnpm android:add:test` | Création initiale Android pour les essais |
| `pnpm android:sync:test` | Synchronisation Android pour les essais |
| `pnpm android:add[:production]` | Création initiale Android de production |
| `pnpm android:sync[:production]` | Synchronisation Android de production |
| `pnpm android:open` | Ouverture du projet dans Android Studio |
| `pnpm android:install-usb-printer` | Réinstallation du plugin USB local |
