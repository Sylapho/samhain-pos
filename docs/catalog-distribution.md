# Distribution du catalogue MongoDB (#135)

Le catalogue utilisé par la caisse reste dans Room/SQLite sur Android et IndexedDB
sur le Web. Aucune vente, panier, intention de paiement, clôture ou impression
n'attend le réseau. Les primitives de catégories #90, la fusion #115 et les
transactions locales sont conservées. Aucune migration Room ni IndexedDB n'est ajoutée.
Le schéma courant est Room v10 depuis #134 ; la transaction catalogue introduite en v9
reste inchangée et aucune donnée SQLite existante n'est réinitialisée.

## API HTTPS `/api/v1`

Toutes les réponses portent `X-Samhain-Destination` et `Cache-Control: no-store`.
Les erreurs suivent `{ error: { code } }`. Aucun accès direct tablette → MongoDB.

### `POST /catalog/active`

Authentification tablette et preuve RSA native `catalog-v1`, avec challenge à usage
unique via `/auth/challenges`. Le corps signé contient `organizationId`, `festivalId`,
`installationId`, `chainId`, `enrollmentGeneration` et, facultativement, `metadataOnly`.
Tous les identifiants doivent correspondre à l'installation vérifiée côté serveur.
La session et l'autorisation sont recontrôlées dans la transaction de lecture.

Réponse complète : `{ organizationId, festivalId, publication, version }`.
`version` vaut `{ payload, sha256 }`. `publication` contient `id`, `revision`,
`schemaVersion`, `publishedAt`, `organizationId`, `festivalId`, `sha256`.
Avec `metadataOnly: true`, seul le contenu de `version` est omis. Avant la première
publication, `publication` et `version` valent `null` ; aucun catalogue n'est créé.
La tablette demande le contenu complet ; aucune récupération partielle n'est activable.

### `POST /catalog/publications`

Authentification responsable OIDC #132 et droit vivant `publish_catalog` sur le
périmètre demandé. `manage_enrollment` et le PIN local ne confèrent pas ce droit.
Le corps contient `organizationId`, `festivalId`, `schemaVersion: 1`,
`expectedRevision`, `products`, `categories`. Les autres champs sont refusés.
Réponse après commit : `{ version: { payload, sha256 } }`.

Le serveur attribue UUID opaque, révision `expectedRevision + 1`, date UTC et
origine `api:<sujet vérifié>`. Les catégories, produits, variantes, ingrédients,
options, prix en centimes, TVA et disponibilités gardent le contrat `catalog-v1`.
La publication exige `dataConfidence: confirmed` pour chaque produit et variante.
Aucune confirmation, prix, TVA ou composition n'est déduite des seeds.

Les validateurs purs existants sont hébergés dans `server/src/catalog/shared/` afin
de compiler le backend isolément. Les chemins publics `src/services/`, `src/types/`
et `src/utils/integrity.ts` les réexportent ; application et API utilisent la même
implémentation. Les règles métier de prix/TVA n'ont pas changé.

Limites : 450 000 octets UTF-8 pour requête de publication et document final,
2 000 produits, 200 catégories, 100 variantes/groupes/ingrédients par produit,
100 options par groupe. Les doublons, catégories absentes, noms invalides, tarifs
incohérents et données temporaires/incomplètes sont refusés.

| HTTP      | Code / action                                                                         |
| --------- | ------------------------------------------------------------------------------------- |
| 400       | Enveloppe, schéma ou révision attendue invalides                                      |
| 401       | Session absente, expirée ou invalide : se reconnecter                                 |
| 403       | Périmètre, autorisation ou installation refusés : vérifier l'enrôlement et les droits |
| 409       | `CATALOG_HEAD_MOVED` : télécharger la version gagnante, fusionner puis reproposer     |
| 413       | Requête ou document trop volumineux                                                   |
| 422       | `INVALID_PAYLOAD` : corriger et confirmer les données commerciales                    |
| 429 / 5xx | Réessayer plus tard ; conserver le catalogue local                                    |

## Stockage et concurrence

Les collections, validateurs et index #131 sont réutilisés : `catalogHeads` contient
la tête par organisation/festival ; `catalogVersions` contient les versions historiques
avec payload exact, empreinte, attribution et date serveur. L'index unique scoped
sur la révision empêche les doublons. Le rôle runtime n'a aucun droit de modification
ou suppression des versions historiques.

`AuthService.protectedManager` et `publishCatalog` partagent la même transaction :
contrôle des droits vivants, insertion de version et CAS de tête sont atomiques.
Deux publications depuis la même révision donnent une réussite et un HTTP 409.
La politique transactionnelle existante borne les retries de conflits transitoires ;
un commit incertain reste une erreur transitoire sans annoncer une publication réussie.
Aucune version partielle ni progression de tête sans publication valide n'est visible.

## Octets et SHA-256

Le serveur sérialise une seule fois le document JSON en chaîne `payload`, puis calcule
SHA-256 sur ses octets UTF-8. Il conserve et renvoie exactement cette chaîne dans
l'enveloppe JSON, avec le hash hexadécimal minuscule. L'échappement de la chaîne par
l'enveloppe HTTP ne change pas le texte obtenu après décodage de cette enveloppe.
Ne jamais reconstruire le document pour vérifier son empreinte.
Android vérifie les octets avant retour du bridge ; TypeScript vérifie de nouveau
hash, taille, schéma et périmètre avant staging, puis la révision avant activation.
Un hash invalide, une révision obsolète ou un périmètre différent ne remplace jamais
le catalogue actif. Une publication perdue au retour se récupère par téléchargement,
sans nouvelle publication aveugle.

## Bootstrap et configuration Android

1. Provisionner la persistance #131 sur une infrastructure autorisée suivant
   [le runbook MongoDB](mongodb-persistence.md). Les tests n'utilisent qu'une base jetable.
2. Configurer l'API HTTPS et son identité de destination suivant
   [la configuration Android](android-mongodb-synchronization.md) et l'Auth/OIDC #132.
   Attribuer explicitement `publish_catalog` au responsable et à son périmètre côté serveur.
3. Construire/synchroniser l'APK avec la configuration publique existante #134.
   Aucun credential MongoDB, secret serveur ou token responsable ne passe dans Vite,
   les assets, les archives ou le bridge JavaScript. Les credentials tablette restent
   dans le vault ; la session responsable OIDC reste temporaire en mémoire native.
4. Enrôler chaque tablette vers cette API. Aucune session Supabase n'est copiée.
5. Sur la première tablette, saisir/importer et vérifier le catalogue réel. Dans
   Administration → Catalogue partagé, se connecter comme responsable puis choisir
   explicitement « Publier les modifications sur toutes les tablettes ».
   Avec `expectedRevision: 0`, cette action crée la première publication traçable.
   Un bootstrap concurrent reçoit 409 et ne remplace pas le gagnant.
6. Télécharger puis activer sur chaque tablette au repos.

Il n'existe aucun peuplement automatique MongoDB depuis les seeds. Le responsable
confirme les données dans l'éditeur existant. Le transport catalogue livré est Android ;
le Web conserve IndexedDB et le service injectable, sans parcours d'authentification Web.
Les anciens endpoints Supabase restent réservés aux anciennes APK jusqu'à #138 ;
le nouveau chemin catalogue n'appelle ni Edge Functions ni Supabase Auth.

## Fusion et autonomie locale

Le cycle reste téléchargement → vérification → staging durable → fusion → activation
atomique. La recherche automatique existante après chargement local, au retour réseau
et toutes les 15 minutes ne fait que télécharger/stager. Elle n'active jamais.
Une coupure réseau laisse le catalogue actif et les modifications locales utilisables ;
on peut relancer la recherche. Aucun fragment de téléchargement n'est activé.

La fusion compare base / local / distant champ par champ. Local inchangé : prendre
le distant ; distant inchangé : garder le local ; changements identiques : accepter ;
changements incompatibles : conserver le local et exposer explicitement le conflit.
Variantes/options/compositions restent indivisibles. Une omission n'est pas une
suppression : désactiver explicitement les éléments. Les décisions locales sont
conservées avec leur révision ; une édition plus récente interdit une résolution
obsolète. La prochaine activation attend la résolution des conflits précédents.

La disponibilité persistée reste locale. La disponibilité de vente est l'intersection
locale/centrale. Les ruptures locales ne sont jamais publiées ni écrasées. Les champs
dérivés de disponibilité ne sont pas persistés. Les propositions de publication
conservent les disponibilités centrales déjà connues.

Activation : panier vide, aucune option/paiement/reprise/intention à vérifier, verrou
UI conservé jusqu'à la relecture. La transaction Room v9 / IndexedDB compare la
révision locale et recontrôle les intentions durables. Toute erreur annule les écritures
ensemble ; une édition concurrente recalcule la fusion au lieu d'écraser le local.
Les commandes, montants, snapshots historiques, journal et tickets restent inchangés.

## Dépendances et validation

Le code #132, #133 et #134 est présent sur la branche de départ, même si #133/#134
étaient encore ouvertes lors de la consultation GitHub. Ce catalogue réutilise
l'Auth #132 et le transport/configuration #134 ; il ne dépend pas d'une ingestion
financière pour vendre, lire ou publier le catalogue. Aucun remplacement d'Auth,
de worker, de stockage local ou de technologie d'impression n'est introduit.

Tests : `pnpm test:run`, `pnpm server:test`, `pnpm server:typecheck`,
`pnpm server:build`, `pnpm lint`, `pnpm build`, Gradle `testDebugUnitTest assembleDebug`.
`server/integration/catalog.test.ts` utilise la fixture réelle #131/#132 :
`MONGODB_TEST_URI` loopback:27019, `MONGODB_TEST_DATABASE=samhain_test_*`,
`MONGODB_TEST_DISPOSABLE=true`, replica set `samhain-test`. Il n'accepte pas la production.
Lancer `pnpm server:test:integration` avec ces variables sur la fixture jetable.

Les tests couvrent publication initiale/révisions, lecture A/B, concurrence/409,
historique, rollback, validation, tailles, isolation, permissions, expiration/révocation,
connexion DB perdue et octets exacts. Les tests #90/#115 et le scénario A/B IndexedDB
couvrent staging, caisse occupée, conflits, ruptures locales et snapshots inchangés.
Les tests Kotlin vérifient transport signé API, intégrité, scope, coupure réseau et Room.

Restent des validations d'exploitation distinctes : déploiement HTTPS réel, configuration
OIDC du fournisseur, deux tablettes physiques, mise à jour conservant les données,
mode avion prolongé, arrêt du processus et matériel USB. Une simulation locale ou
Robolectric n'est pas une preuve de validation matérielle. Les archives financières v1
ne restaurent toujours pas les éditions/conflits catalogue ; utiliser un seul onglet
pour la caisse Web, comme avant cette issue.

### Contrôles exécutés le 25 octobre 2026

| Contrôle                                                              | Résultat local                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test:run`                                                       | 533 tests réussis, 59 fichiers                                                                                           |
| `pnpm server:test`                                                    | 50 tests réussis                                                                                                         |
| Intégration catalogue, Auth, persistance et ledger                    | 50 tests réussis sur MongoDB 8.0.16 replica set ; 1 test RBAC ignoré faute de fixture authentifiée distincte             |
| Gradle `testDebugUnitTest`                                            | 112 tests réussis ; 2 campagnes live Room/Supabase/MongoDB ignorées sans leur bridge d'intégration                       |
| TypeScript application/serveur, lint, builds web/serveur/Android test | Réussis                                                                                                                  |
| Capacitor sync, installation des templates, `assembleDebug`           | Réussis ; APK de test avec API non configurée dans cet environnement                                                     |
| Diff, formatage, inspection des assets                                | Réussis ; aucune URI MongoDB ni clé privée dans les assets ; aucune dépendance Supabase dans le nouveau chemin catalogue |

Le CLI pnpm 10.33.0 déjà installé a été utilisé directement après l'échec réseau
du lanceur Corepack. Vitest et les tests réseau locaux ont nécessité l'accès à leurs
caches/ports hors bac à sable. Le processus MongoDB jetable a été arrêté après les tests.
Ces résultats ne constituent ni un déploiement ni une validation sur tablette physique.
