# Enrôlement et révocation via l’API MongoDB (#132)

La caisse, les paiements, les impressions, Room et l’outbox fonctionnent sans authentification distante. L’autorisation API n’est jamais un acquittement financier. L’écran lit le dernier état local ; **Vérifier / rafraîchir la session** demande explicitement l’état actuel. Un état ancien ne prouve ni la connectivité ni l’accord du serveur.

## Périmètre livré

Les neuf routes d’authentification `/api/v1` de l’ADR sont implémentées dans `server/src/tablet-auth/`. Android utilise `ApiTabletAuthService`, le coffre existant et la clé RSA Android Keystore. Le bridge expose des états publics, jamais les access/refresh tokens. Le Web reste une prévisualisation locale sans enrôlement simulé.

Les routes financières HTTP #133 sont implémentées. Depuis #134, le worker financier utilise la configuration API et ses credentials natifs, avec confirmations séparées par destination et rattrapage des anciens événements. Voir [le runbook de migration Android](android-mongodb-synchronization.md). Le [catalogue MongoDB #135](catalog-distribution.md) réutilise cette configuration et les preuves natives. Sa publication requiert une session responsable OIDC temporaire et le droit distinct `publish_catalog`. Aucun formulaire Supabase ne reçoit une identité API. Ne pas interpréter les acquittements Supabase comme des confirmations MongoDB. Leur retrait appartient à #138. Le catalogue local reste utilisable hors ligne.

## Préparer le serveur et OIDC

1. Sur un environnement de test isolé, appliquer les migrations selon [mongodb-persistence.md](mongodb-persistence.md), après revue de la cible et sauvegarde. La version 3 ajoute le périmètre demandé aux validateurs d’enrôlement ; les schémas et checksums des versions 1 et 2 restent figés. Les anciens documents restent valides. Aucune ligne financière n’est réécrite. Le serveur exige le manifeste courant.
2. Installer les rôles avec `pnpm --dir server db:roles` et une cible `MONGODB_ADMIN_TARGET` explicitement égale au nom confirmé. Affecter **samhain_runtime_v2** au compte runtime : il peut clore les plages de terminaux lors d’un remplacement. Le rôle v1 reste inchangé. Jamais `readWrite`, administrateur ou migrateur pour le processus API. `db:verify-runtime` et readiness contrôlent les privilèges ; la production Auth exige la permission précise de mise à jour des plages.
3. Créer hors dépôt une clé privée RSA PKCS#8 d’au moins 2048 bits et une clé aléatoire AES de 32 octets encodée en base64. Monter leurs fichiers en lecture seule, accessibles uniquement au compte API. Configurer les chemins absolus `API_SIGNING_PRIVATE_KEY_FILE` et `API_AUTH_ENCRYPTION_KEY_FILE`. Ne rien placer sous `VITE_*`, les assets ou l’APK. La clé AES protège exclusivement les réponses temporaires de reprise de session. La perte d’une clé nécessite une procédure d’exploitation explicite ; aucune clé n’est créée automatiquement.
4. Configurer `API_AUTH_ENABLED=true`, un `API_DESTINATION_ID` UUID permanent distinct entre test/production, `API_JWT_ISSUER` HTTPS, `API_JWT_AUDIENCE`, `API_SIGNING_KEY_ID`. Pour changer la clé de signature, prévoir une reconnexion explicite des sessions ; le processus n’accepte que sa clé et son `kid` configurés.
5. Enregistrer un **client public Android** chez le fournisseur OIDC confirmé : Authorization Code, PKCE **S256**, URI de retour exacte `fr.samhain.pos:/oauth2redirect`. Désactiver implicit/password grants pour ce client. Aucun client secret natif. Configurer des comptes nominatifs et la politique MFA chez le fournisseur. L’access token du fournisseur doit être un JWT destiné à l’audience API responsable ; un token opaque ou un ID token destiné au seul client Android ne convient pas.
6. Renseigner tous les `OIDC_*` de `server/.env.example` : issuer exact, audience, JWKS HTTPS, algorithme RS256 ou ES256, client public, endpoints HTTPS, redirect URI et scopes incluant `openid` et le scope donnant l’audience requise. Le fournisseur réel et la politique MFA restent des choix d’exploitation. Configuration absente : administration refusée (503) ; configuration partielle : démarrage refusé. Aucun fournisseur fictif n’autorise une vraie tablette.
7. Préparer les organisations, festivals et capacités depuis un compte d’exploitation contrôlé. Associer le couple **issuer + sub** réel, pas une adresse email, un rôle du JWT ou le terminal déclaré. Le PIN local n’accorde aucun droit serveur. Séparer `manage_enrollment`, `read_ledger` et `publish_catalog` ; aucun droit n’en implique un autre.

Exemple de forme des documents, à exécuter uniquement après injection des valeurs confirmées par votre procédure d’administration (les variables ne sont pas des identifiants métier fournis par ce dépôt) :

```javascript
// db = base confirmée ; organizationId/festivalId = UUID minuscules confirmés
// issuer/sub = identité réellement vérifiée auprès du fournisseur
// Administrateur de déploiement uniquement, jamais depuis la tablette.
db.organizations.insertOne({ documentSchemaVersion: 1, organizationId, active: true, fence: 0 })
db.festivals.insertOne({
  documentSchemaVersion: 1,
  organizationId,
  festivalId,
  active: true,
  fence: 0,
})
db.scopeGrants.insertOne({
  documentSchemaVersion: 1,
  organizationId,
  festivalId,
  issuer,
  subject: sub,
  capability: 'manage_enrollment',
  active: true,
  fence: 0,
})
```

Une attribution ou un retrait de capacité doit modifier le même document `scopeGrants` et incrémenter `fence`. Préparer chaque capacité séparément après autorisation explicite. Ne pas ajouter de compte, de festival ni de droit automatiquement au démarrage.

## Configurer l’APK

Dans la configuration publique de build :

- `VITE_SAMHAIN_API_URL` : origine HTTPS, sans chemin, credentials, query ou fragment ;
- `VITE_SAMHAIN_API_ENVIRONMENT` : `test` ou `production`, cohérent avec la build ;
- `VITE_SAMHAIN_API_DESTINATION_ID` : UUID permanent du serveur cible.

Une production exige en plus `SAMHAIN_API_PRODUCTION_URL` et `SAMHAIN_API_PRODUCTION_DESTINATION_ID` dans l’environnement de build/release, confirmés séparément. Le manifeste public `samhain-build.json` contient uniquement l’origine, l’environnement et l’identité de destination. L’API renvoie également cette identité dans `X-Samhain-Destination` ; le natif refuse une réponse qui ne correspond pas. Ne jamais réutiliser l’UUID d’une autre base restaurée/indépendante pour contourner un contrôle de destination.

Exécuter `pnpm android:install-native`, puis `pnpm android:sync:test` ou la commande production existante. L’installation native configure AppAuth Android 0.11.1 et son redirect receiver. Capacitor ne journalise pas ses paramètres ; les logs AppAuth sont également désactivés pour éviter les états OAuth et détails de réponses. Cette politique utilise une API interne de cette version épinglée : la réexaminer lors d’une mise à jour d’AppAuth.

## Enrôler deux tablettes

1. Configurer chaque caisse localement. Les installations indépendantes gardent des chaînes distinctes.
2. Déverrouiller le mode responsable local. Saisir **Organisation — Identifiant UUID** et **Festival — Identifiant UUID**, puis toucher **Demander l’enrôlement / reconnecter**. Les deux valeurs sont obligatoires : les espaces en début/fin sont retirés, les lettres normalisées en minuscules et le format UUID vérifié avant l’envoi. Les identifiants ne donnent aucun droit serveur.
3. Le natif conserve l’identité et la clé existantes exploitables. Une installation neuve crée explicitement son identité à cette première demande. Il transmet un dossier complet issu de Room : chaîne, terminal, restauration, tuples du préfixe, commandes legacy. Le payload complet, incluant `organizationId`, `festivalId` et l’UUID d’opération, est persisté dans le coffre natif avant tout appel réseau. Les réessais réutilisent les mêmes octets avec un nouveau challenge ; aucune session n’est exposée au Web. Le périmètre demandé reste visible après fermeture/redémarrage, même si la réponse initiale est perdue. La demande reste `pending`, sans droit financier, pendant au plus 24 h.
4. Examiner le dossier complet par `GET /api/v1/tablet-enrollments/:requestId?organizationId=…&festivalId=…` avec un access token responsable. Cette consultation vérifie `manage_enrollment` dans le périmètre ; un identifiant étranger connu ne contourne pas l’isolation. Le dossier et la liste paginée incluent `requestedScope` pour les nouvelles demandes. La liste retourne les demandes du périmètre demandé, ou du périmètre déjà approuvé pour les anciens dossiers sans périmètre initial. Les anciens dossiers non attribués restent accessibles uniquement par leur UUID communiqué par la tablette. Aucune organisation ou festival n’est listé aux tablettes non authentifiées.
5. Sur la tablette, choisir l’approbation ou le refus et **Se connecter au compte responsable**. Android ouvre le navigateur système ; AppAuth gère code, state, nonce et PKCE. Le token reste uniquement dans la mémoire native, expire et est revalidé par l’API à chaque action. Le bouton de déconnexion efface cette session locale, sans prétendre fermer le compte chez le fournisseur.
6. Les UUID organisation/festival demandés sont automatiquement affichés et non modifiables dans l’approbation. Examiner le dossier serveur puis approuver ou refuser explicitement. Les anciens dossiers sans périmètre initial conservent la saisie manuelle des UUID confirmés. Confirmer la chaîne ; pour un remplacement, fournir l’installation retirée après examen des preuves. Le serveur vérifie la concordance du périmètre demandé, l’organisation et le festival actifs, leur appartenance et les droits vivants `manage_enrollment` en transaction. Il n’ajoute ni `read_ledger` ni `publish_catalog`. Android refuse une activation dont le périmètre confirmé diverge de la demande.
7. L’approbation produit une invitation à 256 bits, valable dix minutes, hashée uniquement côté serveur. L’interface la consomme nativement sans la renvoyer au bridge. Une approbation externe peut transmettre le code par un canal contrôlé et l’activer dans le champ temporaire.
8. Attendre l’état retourné par activation : `authorized`, `rejected` ou `needs_recovery`. Une approbation seule ne donne pas de session métier. Répéter avec la deuxième installation et vérifier que les chaînes et générations restent distinctes.

L’ouverture du navigateur verrouille le mode responsable local et ferme l’écran de configuration.
Après retour, rouvrir la configuration de caisse et saisir le PIN si demandé. L’écran relit alors
le statut de la session responsable conservée uniquement en mémoire native : une connexion encore
valide affiche « Déconnecter le responsable » sans recommencer OIDC. Cette lecture ne transmet
aucun jeton au JavaScript, ne prolonge ni la session OIDC ni le déverrouillage local et ne remplace
pas les contrôles serveur lors de l’examen et de l’approbation.

Si la réponse d’approbation est perdue, le serveur ne peut restituer une invitation dont il ne conserve que le hash. Un retry administratif exact renvoie `INVITATION_UNAVAILABLE` ; une **nouvelle approbation explicite** renouvelle l’invitation et invalide l’ancienne. Après cinq codes incorrects, lancer une nouvelle demande puis faire approuver. Une activation perdue peut en revanche récupérer sa réponse de session chiffrée pendant 60 s avec le même UUID et les mêmes octets signés, tant que cette session reste vivante.

Une demande en cours garde son périmètre et son dossier : une tentative de changer le payload ou de remplacer une demande encore vivante est refusée. Après refus, expiration, révocation ou expiration de session, **Créer une nouvelle demande / reconnecter** indique explicitement le remplacement du dossier et permet une nouvelle saisie, sans changer l’installation, sa clé, Room ou l’outbox. Une demande approuvée dont l’invitation est expirée ou les cinq essais consommés peut être remplacée. Une erreur réseau seule reprend la demande existante. Un incident de récupération ne déclenche jamais automatiquement un nouvel enrôlement.

Identifiants fournis pour la recette de ce parcours (à saisir dans les champs ; aucune valeur par défaut ni création serveur automatique) : organisation `a1b6b2ab-e2e9-4a81-b5c1-56c54d7d22f3`, festival `18bdec64-385a-4f86-958f-184a81635c96`. Leur existence et les permissions doivent être confirmées par le serveur lors de l’approbation.

## Protocole et sessions

La signature RSA PKCS#1 SHA-256 couvre exactement :

```text
samhain-auth/1\n<installationId>\n<action>\n<nonce>\n<SHA256(octets du corps HTTP)>
```

Le challenge aléatoire dure 60 s, est lié à la clé, l’action, l’installation et au contexte demande/session. Seul son hash est stocké. Chaque nouvelle tentative HTTP prend un nouveau challenge ; sa consommation fait partie de la transaction de l’action. Une signature invalide ou un challenge expiré/rejoué est refusé. Les TTL nettoient, ils ne définissent jamais la validité. Les quotas IP et installation s’ajoutent aux limites du proxy ; en multi-répliques, imposer un quota global à la frontière réseau.

JWT API RS256, `typ=at+jwt`, issuer/audience/kid fixés, `sub/sid/jti/iat/exp` contrôlés, durée par défaut 600 s. Les installations, sessions, générations, organisations, festivals et guards sont relus/touchés **dans la transaction protégée**. `protectedTablet` et `protectedManager` constituent les points d’intégration des futurs handlers : conserver les guards et l’opération dans la même transaction. Le seam de test générique d’authentification Fastify n’est pas un permis métier réutilisable.

Refresh : 256 bits aléatoires précédés du UUID public de session, hash seulement dans `apiSessions`. Le client persiste rotationId + corps exact avant envoi, prend un nouveau challenge et garde le verrou natif commun. Même ancien refresh, même rotation et même corps : même réponse pendant 60 s via un coffre serveur AES-GCM avec AAD. Une autre rotation ou un corps différent invalide la famille. Après TTL, un vieux refresh reste détecté par son sessionId et provoque aussi l’invalidation. Passé 60 s, aucune boucle infinie : reconnexion explicite. Les nouveaux credentials sont chiffrés et persistés avant utilisation.

Durées configurables : `API_ACCESS_SECONDS` 60–600 (défaut 600), `API_REFRESH_IDLE_DAYS` 1–30 (30), `API_REFRESH_ABSOLUTE_DAYS` 1–90 (90), inactivité ≤ durée absolue. Les réponses temporaires d’activation/rotation sont illisibles sans la clé AES serveur et refusées après leur fenêtre logique. Aucun secret ne figure dans l’audit administratif.

## Migrer une installation Supabase

1. Vérifier/exporter une sauvegarde financière avec la procédure existante, sans changer les données.
2. Installer la nouvelle build **en mise à jour**, sans désinstallation ni effacement des données et avec la signature Android existante.
3. Configurer la destination API confirmée puis lancer explicitement la demande. Le service lit le coffre historique, prouve la possession de la clé existante et réutilise l’installation. Il conserve la chaîne Room, tous les identifiants, hashes, commandes et événements non acquittés.
4. Les sessions API vont dans `noBackupFilesDir/tablet-auth-api-<SHA256(destinationId)>.enc`, avec un alias AES séparé. Un petit coffre d’identité commun permet aussi de conserver cette identité lors d’un changement de destination API. Aucun token Supabase n’est converti ou copié ; le coffre historique reste disponible uniquement pour les anciens transports.
5. Faire approuver le nouvel enrôlement par un responsable OIDC autorisé. Vérifier l’état serveur. Cela ne modifie ni la destination active financière ni les anciennes confirmations : attendre #133/#134 pour le basculement transactionnel de l’outbox.

Ne jamais appeler `prepareReplacement()` pour une migration de backend. Une clé absente, une incohérence de clé publique ou un coffre indéchiffrable mène à `needs_recovery`, sans régénération silencieuse. Une restauration explicitement approuvée peut utiliser le parcours de [remplacement et sauvegarde](tablet-replacement-and-backup.md), lequel marque la restauration et isole les sessions avant adoption. Ne pas effacer Android pour « réparer » Auth.

## Révoquer ou remplacer un appareil perdu

Le responsable habilité appelle `POST /api/v1/tablets/:installationId/revoke` avec son JWT OIDC et `{operationRequestId, organizationId, festivalId, chainId}`. Sur une tablette disponible, utiliser **Révoquer cette installation** après connexion responsable. Identifier l’installation exacte dans le registre ; un terminal ou un libellé ne suffit pas.

La révocation est idempotente, conserve sa date, retire toutes les sessions et touche les mêmes fences que les opérations protégées. Une opération dont la révocation a déjà commité est refusée même avec un JWT non expiré et une preuve préparée auparavant. Un appareil déconnecté continue à vendre et imprimer localement ; la révocation API ne purge rien.

Une révocation API ne modifie pas le registre Supabase historique. Tant que son transport
reste actif, traiter aussi son accès dans la procédure Supabase existante pour un appareil
perdu ; le basculement/retrait global reste soumis à #134/#138. Rejouer une ancienne
opération de révocation ne révoque pas une génération réenrôlée ultérieurement : une nouvelle
révocation exige un nouvel UUID d’opération et les droits vivants.

Pour un remplacement, restaurer l’archive vérifiée, conserver la chaîne et faire approuver l’installation remplacée. L’activation épingle la génération et l’installation actives vues lors de l’approbation, vérifie le préfixe/hash/terminal et les legacy existants, ferme les plages historiques puis incrémente la génération sous transaction. Deux candidats concurrents ne peuvent gagner tous deux. Les anciennes clés/générations restent des preuves ; leurs credentials ne permettent plus d’opération protégée.

Une divergence ou un préfixe incomplet produit `needs_recovery`, sans recul de tête, recalcul de hashes, renumérotation, fusion ni déplacement artificiel d’un suffixe. Conserver/exporter les deux archives, relever le premier écart et faire traiter l’incident par le responsable. Une archive déclarée restaurée ne crée pas une nouvelle chaîne pour contourner l’absence de registre.

## Dossiers trop grands et recette

La demande complète doit rester sous 1 MiB et strictement moins de 10 000 tuples et identifiants legacy. Aucun préfixe n’est tronqué. Au-delà, suspendre l’enrôlement : conserver l’archive complète et les exports, relever la chaîne/génération/têtes, faire auditer en environnement administratif isolé contre les preuves distantes, puis préparer une procédure de transfert paginé approuvée sous tests. Aucun bouton/commande d’autorisation forcée n’est livré. La consultation d’un grand dossier peut aussi rencontrer la limite HTTP : ne pas augmenter une limite de production sans revue du protocole complet.

Vérifications automatisées : `pnpm test:run`, `pnpm lint`, `pnpm build`, `pnpm server:build`, `pnpm server:typecheck`, `pnpm server:test`, puis `pnpm server:test:integration` sur la fixture MongoDB explicitement jetable. Android avec JDK 21/SDK : `pnpm android:install-native` et `android/gradlew.bat -p android testDebugUnitTest assembleDebug`. Les tests JCE/Robolectric injectent les clés ; ils ne prouvent pas le Keystore matériel.

Avant exploitation : configurer le vrai fournisseur OIDC, tester le navigateur/redirect/PKCE/MFA, la destination TLS/proxy, deux vraies tablettes, un redémarrage pendant refresh, révocation avec token valide, remplacement et perte de clé, puis mode avion avec vente/paiement/impression USB. Tester la mise à jour APK en conservant les données et les exclusions OEM cloud/D2D. Ne pas confondre tests locaux, déploiement et recette matérielle.
