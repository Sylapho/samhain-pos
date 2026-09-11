# Persistance Android Room / SQLite

## Choix du stockage

La couche métier dépend de `OrderRepository`, pas d'un moteur de base de données. La fabrique dans `src/services/orderRepositoryFactory.ts` choisit le repository avec les API Capacitor :

- application Android native : `RoomOrderRepository` puis le plugin Capacitor Kotlin `OrderStorage` ;
- navigateur, développement web et tests web : `IndexedDbOrderRepository`.

L'existence de `indexedDB` n'est pas utilisée pour conclure que l'application est web : un WebView Android expose aussi IndexedDB. Android natif est identifié par `Capacitor.isNativePlatform()` et `Capacitor.getPlatform() === 'android'`.

Room s'appuie sur le moteur SQLite local d'Android. La lecture et l'écriture des ventes ne nécessitent aucune connexion Internet. La base de production est un fichier privé de l'application nommé `samhain-pos-room.db`, normalement situé sous `/data/data/fr.samhain.pos/databases/`. Il disparaît uniquement si les données de l'application sont explicitement effacées ou si l'application est désinstallée sans restauration de sauvegarde.

IndexedDB reste volontairement présent pour le navigateur et comme source de la migration des anciennes installations Android.

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

`OrderService` calcule les articles, quantités, montants, paiement, terminal, dates et préfixes de numérotation. Il envoie un brouillon complet au repository. Il ne demande jamais une séquence séparément.

`RoomOrderStore.createOrder()` ouvre une seule transaction Room et effectue :

1. lecture des trois prochaines séquences et de la tête du journal ;
2. construction des numéros de commande et de reçu ;
3. construction et empreinte SHA-256 de l'entrée de vente ;
4. insertion du snapshot financier immuable ;
5. insertion de l'état technique d'impression ;
6. insertion de l'entrée du journal ;
7. avancement des séquences et de la tête du journal ;
8. commit.

Une contrainte ou exception annule toute la transaction. Il n'existe donc pas de fenêtre où une séquence serait consommée sans sa commande. Les appels Room synchrones sont exécutés sur l'exécuteur dédié du plugin et jamais sur le thread principal Android.

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
