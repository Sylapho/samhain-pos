# Persistance Android Room / SQLite

## Choix du stockage

La couche métier dépend de `OrderRepository`, pas d'un moteur de base de données. La fabrique dans `src/services/orderRepositoryFactory.ts` choisit le repository avec les API Capacitor :

- application Android native : `RoomOrderRepository` puis le plugin Capacitor Kotlin `OrderStorage` ;
- navigateur, développement web et tests web : `IndexedDbOrderRepository`.

L'existence de `indexedDB` n'est pas utilisée pour conclure que l'application est web : un WebView Android expose aussi IndexedDB. Android natif est identifié par `Capacitor.isNativePlatform()` et `Capacitor.getPlatform() === 'android'`.

Room s'appuie sur le moteur SQLite local d'Android. La lecture et l'écriture des ventes ne nécessitent aucune connexion Internet. La base de production est un fichier privé de l'application nommé `samhain-pos-room.db`, normalement situé sous `/data/data/fr.samhain.pos/databases/`. Effacer les données de l'application ou la désinstaller supprime cet état local ; aucune restauration Android automatique ne doit le recréer.

IndexedDB reste volontairement présent pour le navigateur et comme source de la migration des anciennes installations Android.

## Politique Android Backup

Android Backup n'est pas un mécanisme de sauvegarde supporté pour Samhain POS. Le manifeste impose `android:allowBackup="false"` et référence deux politiques complémentaires :

- `@xml/data_extraction_rules` pour Android 12 et versions ultérieures, avec des sections explicites `cloud-backup` et `device-transfer` ;
- `@xml/backup_rules` au format `full-backup-content` pour Android 11 et versions antérieures supportées (`minSdk 24`).

Chaque politique exclut globalement les domaines `root`, `file`, `database`, `sharedpref`, `external`, `device_root`, `device_file`, `device_database` et `device_sharedpref`. Cette exclusion couvre Room/SQLite, les métadonnées de séquence, le journal, les états d'impression, l'ancien IndexedDB, le `localStorage` WebView, `terminalId`, `terminalCode`, le marqueur de remplacement et le credential responsable. Elle protège également les futurs stockages privés, sans déplacer artificiellement Room dans `noBackupFilesDir`.

Cette défense en profondeur est nécessaire car, selon le fabricant et la version Android, `allowBackup=false` peut ne pas suffire à désactiver un transfert direct entre appareils. L'archive Samhain vérifiée reste la seule sauvegarde métier supportée. Copier `samhain-pos-room.db` ou `/data/data/fr.samhain.pos/` n'est pas une procédure de restauration.

## Chemin d'une commande

```text
OrderService
→ OrderRepository
→ RoomOrderRepository
→ plugin Capacitor OrderStorage
→ RoomOrderStore
→ DAO Room
→ SQLite
```

`OrderService` valide d’abord le snapshot métier complet (identités des lignes, quantités, prix, TVA, variantes, options, ingrédients retirés, paiement, terminal et dates). Les totaux sont recalculés avec détection des dépassements d’entiers sûrs par une fonction pure indépendante de React/Zustand. Le service envoie ensuite un brouillon complet au repository et ne demande jamais une séquence séparément. Les repositories réappliquent ce validateur à leur frontière pour protéger aussi les appels directs.

Les identifiants de commande sont traités comme des identifiants opaques non vides. La génération de production reste `crypto.randomUUID()`, tandis que cette convention conserve la compatibilité avec les identifiants historiques et permet l’injection d’identifiants déterministes dans les tests.

`RoomOrderStore.createOrder()` contrôle le payload reçu avant d’ouvrir la transaction : lignes non vides, identifiants uniques, terminal et paiement autorisés, dates ISO, quantités/prix/TVA, puis égalité entre les totaux transportés et ceux recalculés avec `Math.multiplyExact` / `Math.addExact`. Il ouvre ensuite une seule transaction Room et effectue :

1. lecture des trois prochaines séquences et de la tête du journal ;
2. construction des numéros de commande et de reçu ;
3. construction et empreinte SHA-256 de l'entrée de vente ;
4. insertion du snapshot financier immuable ;
5. insertion de l'état technique d'impression ;
6. insertion de l'entrée du journal ;
7. avancement des séquences et de la tête du journal ;
8. commit.

Une validation échouée intervient avant toute lecture/allocation de séquence. Une contrainte ou exception ultérieure annule toute la transaction. Il n'existe donc pas de fenêtre où une séquence serait consommée sans sa commande, son état d’impression et son entrée de journal. Les appels Room synchrones sont exécutés sur l'exécuteur dédié du plugin et jamais sur le thread principal Android.

## Schéma

Le modèle est hybride :

- `orders` expose en colonnes les UUID, numéros uniques, terminal source, dates, paiement, statut, totaux, intégrité et métadonnées préparant la synchronisation ;
- `items_json` conserve la structure imbriquée des lignes, variantes, options et ingrédients sans multiplier les tables qui ne sont pas encore interrogées séparément ;
- `immutable_payload_json` conserve le snapshot canonique complet scellé par le journal, tandis que ses champs critiques restent contrôlables et indexables en SQL ;
- `order_printing` sépare les métadonnées techniques modifiables des données financières ;
- `sales_ledger` indexe identifiant, séquence, type, date, commande, terminal source et empreinte, et conserve le payload canonique de chaque entrée ;
- `pos_metadata` contient les prochaines séquences, la tête du journal, la dernière clôture et l'état de migration legacy.

Les colonnes `sync_status`, `sync_attempts`, `sync_last_error` et `synced_at` préparent une future outbox, sans implémenter de réseau ni la synchronisation des issues #35/#36.

## Migration IndexedDB vers Room

Au premier accès Android :

1. Room indique si la migration legacy a déjà été validée ;
2. TypeScript ouvre la base IndexedDB historique `samhain-pos` et lit atomiquement commandes, états d'impression, journal et métadonnées ;
3. l'intégrité du snapshot est contrôlée côté TypeScript ;
4. le snapshot complet est envoyé au plugin ;
5. Room importe et vérifie dans une seule transaction ;
6. le marqueur `legacy_migration_completed` est écrit dans cette même transaction.

Les UUID existants sont conservés. Une ligne déjà présente et identique est acceptée ; un même UUID, identifiant de journal ou numéro de séquence avec un contenu incompatible fait échouer explicitement toute la transaction. Les prochaines séquences ne peuvent pas reculer. Un arrêt pendant l'import laisse le marqueur non validé et l'import est repris au prochain démarrage.

IndexedDB n'est ni vidé ni supprimé après succès. Une installation sans commande legacy importe simplement un snapshot vide puis utilise Room.

## Versioning et migrations Room

La version courante est `2`. Le schéma exporté par KSP est versionné dans `android/app/schemas/fr.samhain.pos.SamhainPosDatabase/`.

Pour une évolution future :

1. modifier les entités ;
2. incrémenter `version` dans `SamhainPosDatabase` ;
3. ajouter une `Migration(ancienneVersion, nouvelleVersion)` avec les transformations non destructives ;
4. enregistrer la migration dans `Room.databaseBuilder(...).addMigrations(...)` ;
5. régénérer le projet Android et le schéma ;
6. ajouter un test qui part de l'ancien schéma et vérifie les données après migration ;
7. compiler et exécuter les tests Android.

`fallbackToDestructiveMigration()` et `allowMainThreadQueries()` sont interdits dans le code de production.

## Génération et tests Android

Les sources de référence vivent dans `native/android/`. `scripts/install-android-usb-printer.mjs` est désormais l'installateur natif commun : il copie l'imprimante, Room et leurs tests, configure Kotlin/KSP/Room et enregistre chaque plugin une seule fois avant `super.onCreate(savedInstanceState)`. L'alias recommandé est :

```bash
pnpm android:install-native
```

Après une modification native :

```bash
pnpm android:sync:test
cd android
./gradlew testDebugUnitTest assembleDebug
```

Sous Windows, utiliser `gradlew.bat`. Pour la production :

```bash
pnpm android:sync:production
```

Cette commande conserve le garde-fou existant : elle échoue tant que les informations administratives de démonstration n'ont pas été remplacées par des données confirmées.

Les tests Room couvrent création, contraintes UUID, rollback transactionnel des séquences, états d'impression, fermeture/réouverture, migration IndexedDB idempotente et conflictuelle, et migration de schéma. Une validation finale sur la tablette reste nécessaire pour le cycle de vie réel du processus Android et l'impression USB.

Les tests couvrent aussi le rollback complet d'une restauration Room interrompue et la conservation exacte des métadonnées d'archive. Le test Robolectric de politique Android vérifie que l'application construite n'expose pas `ApplicationInfo.FLAG_ALLOW_BACKUP`. Les règles XML sont validées par AAPT pendant l'assemblage. Les protocoles matériels et les opérations de mise à jour/désinstallation sont détaillés dans [`tablet-replacement-and-backup.md`](tablet-replacement-and-backup.md).
