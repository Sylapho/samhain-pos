# Distribution du catalogue Supabase (#115)

Le catalogue utilisé par la caisse reste dans Room/SQLite sur Android et IndexedDB sur
le Web. Aucune vente, ouverture de panier, intention de paiement ou impression n'attend
le réseau. Les primitives de catégories de #90 sont conservées.

## Version publiée et transport

`catalog-v1` distribue une enveloppe `{ payload, sha256 }`. `payload` est le texte JSON
UTF-8 exact produit par PostgreSQL. Son hash SHA-256 couvre **tout** le document :
UUID serveur, révision entière croissante par organisation/festival, `schemaVersion: 1`,
date de publication serveur, organisation, festival, origine `supabase:<sujet vérifié>`,
produits et catégories. Ne pas re-sérialiser le payload pour vérifier son hash.

Le contenu reprend les types existants : activité, ordre, description, prix entiers en
centimes, TVA existante, variantes, options, ingrédients et `dataConfidence`. Aucun prix,
taux ou ingrédient n'est complété depuis le seed. Une publication exige une confirmation
explicite de chaque produit et variante (`dataConfidence: confirmed`). La case
« Prix, TVA et composition vérifiés pour publication » permet au responsable de fournir
cette confirmation dans l'éditeur existant ; aucune confirmation automatique n'est ajoutée.

La validation profonde TypeScript est partagée entre Edge et application et réutilise le
validateur produit extrait de CatalogService, ainsi que les règles de catégories de #90.
Le schéma v1 refuse les champs inconnus, les doublons d'identifiants/noms de catégories,
les références absentes, prix/TVA invalides et types incorrects. Une catégorie inactive
peut contenir des produits ; elle est masquée par les onglets existants.

Limites : 450 000 octets UTF-8 par document/requête de publication, 2 000 produits,
200 catégories, 100 variantes/groupes/ingrédients par produit et 100 options par groupe.
Le transport natif impose aussi ses limites existantes : 1 Mio, redirections refusées,
timeouts de connexion/lecture et échéance totale de 30 secondes. Aucune pagination
partielle n'est activable. Un téléchargement interrompu ne laisse pas de fragments actifs.

Sur Android, une vérification démarre après le chargement **local**, lors du retour réseau,
puis toutes les 15 minutes pendant que l'application tourne. Elle télécharge/stage seulement.
Le responsable peut aussi la lancer dans Administration → Catalogue partagé. Le résultat
`version: null` signifie qu'aucune version n'est publiée ; aucun faux catalogue n'est créé.
Les téléchargements passent par un exécuteur réseau séparé de celui du catalogue Room.
La fermeture/relance de l'application ne perd ni version en attente ni catalogue actif.

## Autorité locale et conflits

Une seule collection produits/catégories sert aux écritures locales et à la vente.
Les métadonnées de distribution conservent la version active, la version en attente,
la base centrale, les conflits, les décisions et les erreurs. La base est une référence
de fusion ; ce n'est pas un deuxième catalogue utilisé par la caisse.

La proposition locale est la différence entre les lignes actuelles et cette base,
identifiée par la version active et le compteur durable de révision locale. Avant la
première publication, la base est le seed courant après migration historique ; les éditions
d'une installation existante sont donc également conservées. Les créations locales ne
disparaissent pas lors de la première réception.

La fusion compare base / local / distant **champ par champ** :

- local égal à la base : prendre le distant ;
- distant égal à la base : conserver l'édition locale comme proposition ;
- valeurs locales et distantes identiques : accepter cette valeur ;
- les deux ont changé différemment : conserver le local et enregistrer base/local/distant.

Variantes, groupes d'options et compositions sont des champs indivisibles : aucune
composition partielle n'est inventée. L'absence d'un identifiant dans une publication
n'est jamais interprétée comme une suppression. Une publication désactive explicitement
les éléments qui doivent quitter la vente ; les historiques ne sont jamais supprimés.

Après activation, l'interface montre tous les champs en conflit et permet de conserver
toutes les valeurs locales ou d'accepter toutes les valeurs publiées. Ce choix explicite
est enregistré avec version, date, révision locale et valeurs comparées. Il fonctionne hors
connexion sous le mode responsable existant et ne prétend pas identifier un compte humain
Supabase. Une édition postérieure à l'affichage d'un conflit empêche un choix distant
obsolète. Une prochaine activation attend la résolution des conflits actifs. Une collision
structurelle, par exemple deux catégories aboutissant au même nom, annule toute activation :
le responsable doit corriger le nom local puis réessayer.

`Product.availability` **persisté** reste la disponibilité locale. La disponibilité centrale
vient de la version publiée ; la disponibilité de vente est leur intersection. Les champs
`localAvailability` et `centralAvailability` renvoyés à l'interface sont dérivés et ne sont
jamais persistés ni publiés. Enregistrer un changement de nom ne transforme donc pas une
indisponibilité centrale en rupture locale. Une rupture locale ne disparaît jamais lors
d'une mise à jour centrale. L'éditeur ne lève que la rupture de cette tablette.

La proposition de publication exclut les ruptures locales et conserve les disponibilités
centrales déjà connues. Une modification de disponibilité centrale peut être envoyée
explicitement par un outil responsable authentifié au même endpoint ; elle ne découle
jamais d'une remise en stock locale.

## Transactions et protection de la caisse

Room v9 ajoute seulement `catalog_distribution`, avec une migration 8→9 non destructive.
IndexedDB utilise son store `catalogMetadata` existant ; aucun changement de version ni
réinitialisation n'est nécessaire. Chaque mutation locale incrémente le compteur de
révision dans la même transaction que la mutation.

`readSnapshot()` lit produits, catégories, compteur et distribution ensemble.
`commitSnapshot()` compare le compteur puis écrit produits, catégories et marqueur
de version en une transaction. Une édition concurrente provoque `CATALOG_CHANGED` ;
la fusion est recalculée sur le nouvel état (au plus cinq tentatives), jamais écrasée.
Les contraintes de noms Room et toutes les écritures sont annulées ensemble en cas d'erreur.

L'activation est une action distincte du téléchargement. App exige un panier vide,
aucune feuille d'options, aucun écran de paiement/reprise et aucune intention à vérifier.
La vérification de reprise doit avoir abouti pour la caisse courante. Un verrou synchrone
d'interaction est conservé pendant le commit **et** le rafraîchissement des produits et
catégories React ; l'interface est `inert` pendant cette courte opération locale.
La transaction Room/IndexedDB recontrôle les intentions persistées : seules les intentions
`finalized` ou `abandoned` sont compatibles avec l'activation. Un échec après commit mais
avant relecture rend le catalogue UI indisponible jusqu'à une relecture/redémarrage, sans
permettre de nouvelles sélections sur une vue périmée.

Les commandes, lignes du panier, intentions, journal et états d'impression ne sont jamais
réécrits par la distribution. Les nouveaux choix utilisent la version activée ; les snapshots
de prix/TVA/composition déjà enregistrés restent identiques. Le seed reste conditionné à
une base vide/non initialisée. Les migrations historiques de tarifs et d'ingrédients du
burger sont désormais appliquées **une fois**, avec leur marqueur et les produits dans
la même transaction. Aucun prix distant accepté ne repasse par ces anciennes migrations.

## Publication et sécurité

La migration `20261021100000_catalog_distribution.sql` ajoute :

- `pos_private.catalog_heads`, tête verrouillée par organisation/festival ;
- `pos_private.catalog_versions`, versions immuables avec empreinte et attribution ;
- la capacité distincte `publish_catalog` dans les habilitations existantes ;
- la RPC `catalog_v1` réservée au rôle serveur et son propriétaire borné
  `pos_catalog_executor`, sans droits d'écriture sur les événements financiers.

Tables privées non exposées, RLS forcée, aucun accès direct anon/authenticated/service_role.
Les policies de l'exécuteur ne sont pas des policies clientes. La RPC vérifie la session
Auth vivante et les droits actifs en transaction. Un téléchargement exige la preuve RSA
de l'installation enrôlée, sa génération, sa continuité et son périmètre via les helpers #114.
Le sujet et la session proviennent du JWT vérifié par Auth, jamais des champs client ni du
seul terminalId. La signature couvre le corps brut, l'endpoint `catalog-v1` et un challenge
à usage unique consommé dans la transaction. HTTP non sécurisé est refusé ; le loopback
est réservé aux tests de la pile locale. Android utilise uniquement HTTPS.

Une publication utilise un compte Supabase non anonyme ayant `publish_catalog` pour le
périmètre. `manage_enrollment`, un compte tablette et le PIN local ne suffisent pas.
Elle fournit `expectedRevision` (0 pour la première publication) ; une tête différente
retourne HTTP 409 `CATALOG_HEAD_MOVED`. Deux publications concurrentes ne peuvent donc
pas écraser silencieusement leurs révisions. La révision, l'UUID, la date et l'origine
sont attribués côté serveur. Une publication perdue au retour réseau se récupère par un
nouveau téléchargement, sans publier de nouveau aveuglément.

Le formulaire Android réutilise l'authentification native temporaire du responsable,
sans enregistrer son mot de passe/session ; le token tablette reste dans le vault existant.
La configuration Capacitor conserve la désactivation des logs de paramètres. Le serveur
utilise son credential privilégié uniquement dans l'environnement Edge, jamais dans Vite,
les assets Android, l'APK ou les archives. MFA est vérifié par les règles existantes ;
le formulaire actuel n'ajoute pas de parcours interactif de challenge MFA.

## Déploiement et exploitation

1. Sur un projet Supabase **de test autorisé**, appliquer les migrations #113/#114/#36
   puis celle de #115 avec `supabase db push --linked`. Vérifier le projet lié avant la commande.
2. Déployer `supabase functions deploy catalog-v1 --project-ref <projet-test>` avec vérification
   JWT activée. Les imports TypeScript partagés doivent être inclus par le CLI.
3. Un administrateur serveur attribue explicitement `publish_catalog` au compte responsable
   dans `pos_private.scope_grants` pour l'organisation/festival existant. Aucun droit n'est
   attribué automatiquement aux anciens responsables. Ne jamais exposer ce schéma dans l'API.
4. Construire/synchroniser l'application avec sa configuration publique #112, mettre à jour
   les tablettes en conservant leurs données et les enrôler via #114.
5. Confirmer les données commerciales dans l'administration, rechercher une publication,
   publier explicitement si nécessaire puis activer sur chaque tablette au repos.
6. Vérifier sur deux tablettes : panier/options/paiement pendant publication, rupture locale,
   conflit, reprise après arrêt, expiration/révocation et plusieurs jours en mode avion.

Aucun déploiement hébergé ni attribution réelle de droits n'a été effectué dans cette tâche.
La pile locale est un environnement de test ; ses fixtures ne sont pas des données métier.

## Validation et limites

Les tests couvrent : base vide/cache valide, administration hors ligne, horloge avancée,
staging et reprise, interruption réseau, version invalide, catégorie désactivée/référence
absente, conflits et décisions, stock central/local, panier/options/paiement dans App,
intentions durables, rollback/CAS, migration relancée et snapshots historiques inchangés.
Room est testé avec Robolectric/SQLite et réouverture de fichier, pas par arrêt réel d'une
tablette. Les tests HTTP locaux utilisent Auth, Edge, PostgREST et PostgreSQL réels, y compris
publication concurrente et révocation.

Les six critères d'acceptation de #115 sont couverts par l'implémentation et ces tests locaux.
L'exploitation sur deux appareils, le projet hébergé, le matériel USB et la durée réelle
hors connexion restent à valider. L'impression n'est pas modifiée par cette issue.

Le navigateur conserve et teste la même persistance transactionnelle et le même service,
mais aucun parcours d'authentification Web n'existait dans #114 : le transport sécurisé
livré est Android. Il reste injectable dans les tests Web. L'application Web n'ajoute
pas de gestion coordonnée des paniers volatils entre plusieurs onglets ; utiliser un seul
onglet de caisse. Les éditions/conflits/décisions catalogue restent exclus des archives
financières v1 selon #111 ; ne pas annoncer leur restauration via ces archives.

### Résultats exécutés le 21 octobre 2026

| Contrôle                                                                       | Résultat                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `pnpm test:run`                                                                | 490 tests, 54 fichiers, tous réussis                                                                   |
| TypeScript (`tsc -b`), `pnpm lint`, Prettier sur les fichiers concernés        | Réussis                                                                                                |
| `pnpm build`, `pnpm build:android:test`, Capacitor sync et installation native | Réussis                                                                                                |
| Gradle `testDebugUnitTest assembleDebug`                                       | 87 tests, aucune erreur ; APK debug construit                                                          |
| `supabase test db`                                                             | 402 assertions réussies                                                                                |
| `scripts/test-supabase-ingest.mjs`                                             | 92 contrôles réels Auth/Edge/PostgreSQL réussis, catalogue inclus                                      |
| `scripts/test-supabase-migrations.mjs`                                         | Données financières/registre conservées à l'identique ; reconstruction réussie                         |
| `deno check supabase/functions/catalog-v1/index.ts`                            | Réussi                                                                                                 |
| `supabase db lint --local --level warning`                                     | Aucun problème catalogue ; avertissement préexistant dans `ledger_prefix_v1` sur un retour de fonction |
| Schémas Room v8/v9 et sources générées                                         | Anciennes entités identiques ; templates Kotlin et copies Android identiques                           |
| Recherche de credentials dans les assets et l'APK                              | Aucune valeur de clé privilégiée/JWT trouvée ; logs du bridge désactivés                               |
| `git diff --check`                                                             | Réussi                                                                                                 |

Les commandes pnpm ont utilisé la copie locale du CLI pnpm 10.33.0 : le lanceur Corepack
essayait un téléchargement indisponible dans le bac à sable. Vitest et Gradle ont été
exécutés avec l'accès nécessaire à leurs caches. La pile Supabase locale démarrée pour ces
contrôles a été arrêtée ensuite, sans suppression de ses volumes.

### Fichiers principaux

| Zone                         | Fichiers                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modèle, validation et fusion | `src/types/catalogDistribution.ts`, `src/services/catalogDistribution.ts`, `src/services/productValidation.ts`                                                                                    |
| Distribution et stockage Web | `src/services/catalogDistributionService.ts`, `catalogService.ts`, `catalogRepository.ts`, `src/native/catalogStorage.ts`                                                                         |
| Protection et administration | `src/app/App.tsx`, `src/features/catalog/CatalogSynchronization.tsx`, `ProductManagementDialog.tsx`, champs dérivés dans `src/types/catalog.ts`                                                   |
| Android canonique            | `native/android/{SamhainPosDatabase,RoomCatalogStore,CatalogStoragePlugin,TabletAuthService}.kt` et leurs copies générées dans `android/app/src/main/java/fr/samhain/pos/` ; schéma Room `9.json` |
| Supabase                     | `supabase/migrations/20261021100000_catalog_distribution.sql`, `functions/catalog-v1/index.ts`, `functions/_shared/catalogHttp.ts`, configuration de la fonction                                  |
| Validation                   | Tests catalogue/App/HTTP, tests Kotlin et chemins de migration actualisés, `supabase/tests/catalog.test.sql`, assertions de privilèges existantes, script d'intégration et filtres CI Supabase    |
| Documentation                | Ce document, `README.md`, `docs/android-persistence.md`                                                                                                                                           |
