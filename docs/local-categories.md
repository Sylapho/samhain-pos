# Catégories locales — #90

Dans Administration, l’onglet Catégories permet de créer, renommer, désactiver,
réactiver et déplacer les catégories avec Monter / Descendre. Il utilise le même
accès responsable que les produits. Les boutons attendent la confirmation du
stockage ; aucune écriture ne dépend d’Internet.

`CategoryId` est une chaîne opaque. Les nouvelles catégories reçoivent un UUID ;
les identifiants historiques `menus`, `assiettes`, `desserts`, `boissons-chaudes`,
`bieres` et `sans-alcool` sont conservés. Le nom est unique après suppression des
accents, normalisation des espaces et de la casse, y compris parmi les catégories
inactives. L’ordre est déterminé par `displayOrder`, puis par l’identifiant.

Room **7 → 8** crée la table `categories` et l’index unique `normalized_label`.
IndexedDB **5 → 6** ajoute le magasin `categories` dans la même base que les
produits. L’initialisation complète les catégories manquantes indépendamment du
marqueur produit. Elle ne remplace jamais une catégorie existante. Une référence
historique inconnue est conservée comme catégorie inactive, avec son identifiant
comme libellé provisoire à renommer par le responsable. En cas de collision avec
un nom personnalisé, seul le nom de la catégorie manquante est suffixé par son ID.

L’initialisation et la réorganisation sont transactionnelles. Les mutations de
produits contrôlent dans la transaction l’existence de la catégorie et son statut :
création ou nouvelle affectation exige une catégorie active ; la modification d’un
produit déjà associé à une catégorie inactive conserve cette association. Aucune
API de suppression de catégorie n’est exposée. Ni panier, ni snapshots de ventes,
ni journal, ni états d’impression ne sont réécrits par ces opérations.

La caisse utilise les noms, statuts et positions enregistrés. Quand la sélection
devient inactive, elle affiche la première catégorie active selon l’ordre courant.
Sans catégorie active, elle explique la marche à suivre et conserve le panier,
l’encaissement du panier existant et l’historique accessibles. Le formulaire produit
propose les catégories actives ainsi que l’association inactive du produit existant.

## Frontière avec #111 / #115

Catégories, produits et métadonnées partagent la même base et une portée de
transaction commune (`catalogTransaction` sur le web, `runInTransaction` dans
`RoomCatalogStore`). Une future activation pourra ainsi valider toutes les
références et écrire catégories et produits avant un seul commit local. Ne pas
appliquer une publication par une suite d’appels CRUD du bridge.

Ce ticket n’ajoute ni publication, ni téléchargement, ni révision distante fictive.
#115 devra définir la révision attendue, les propositions locales séparées et les
ruptures locales selon le [contrat #111](architecture-supabase-offline-first.md),
préserver les éditions locales et refuser toute publication incomplète. Les paniers
et intentions en cours gardent leurs snapshots. Les catégories restent hors des
archives financières v1 ; cette évolution ne constitue pas une restauration de
catalogue sur une tablette de remplacement.

## Vérifications

- `pnpm test:run` : règles métier, concurrence IndexedDB, rollback, migration v5,
  redémarrage, administration, sélection et protection responsable.
- `pnpm android:install-native`, puis depuis `android` :
  `./gradlew :app:testDebugUnitTest` (JDK 21, SDK Android installé).
  Les tests Room couvrent migration v7, conservation d’une vente scellée,
  initialisation, doublons, références, rollback et redémarrage du fichier SQLite.
- Sur tablette : installer une mise à jour sans effacer les données, créer une
  catégorie, lui associer un produit, arrêter et relancer l’application, renommer,
  déplacer puis désactiver ; vérifier le panier et l’historique conservés hors ligne.
