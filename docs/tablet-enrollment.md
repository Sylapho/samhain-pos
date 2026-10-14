# Enrôlement et révocation des tablettes (#114)

## Ce qui fonctionne

La configuration locale de caisse, les ventes, les paiements et l’impression USB restent indépendants de Supabase. Room est la source de vérité Android. L’ouverture des paramètres lit d’abord l’état enregistré ; seule une action explicite contacte le serveur. « Tablette autorisée » décrit une habilitation, jamais un acquittement de ventes. Hors connexion, cet état peut être ancien : utiliser **Vérifier / rafraîchir la session** pour interroger le serveur.

Le navigateur reste une prévisualisation locale. Il ne simule pas d’enrôlement sécurisé et ne conserve aucun token. Les fonctionnalités Auth livrées ici ciblent Android. Le moteur d’outbox #35, les endpoints financiers #36 et l’écran d’import #61 ne sont pas livrés par cette issue.

## Préparer Supabase

Effectuer séparément ces étapes sur les projets de test et de production ; utiliser les identifiants réels confirmés, jamais ceux des fixtures SQL.

1. Configurer les variables publiques selon [supabase-configuration.md](supabase-configuration.md). Aucune clé serveur dans `.env` Vite ou dans l’APK.
2. Appliquer les migrations versionnées dans l’ordre avec `supabase db push` après revue du projet lié et du plan de migration. La nouvelle migration est `20261014200000_tablet_enrollment.sql` ; elle ne réécrit aucune donnée financière existante.
3. Activer **Allow new users to sign up** et **Anonymous Sign-Ins** dans Auth. La tablette utilise `POST /auth/v1/signup` sans email/mot de passe pour obtenir son propre principal. Les inscriptions seules ne donnent aucun droit POS. Conserver les limitations Auth par IP et surveiller les créations anonymes ; les challenges sont limités à 60 par minute et par principal et les invitations à cinq essais. Cette implémentation n’intègre pas de CAPTCHA : si votre projet l’exige, l’enrôlement nécessite une intégration adaptée et doit rester refusé jusque-là.
4. Créer nominativement les comptes responsables dans Supabase Auth. Le parcours livré utilise email/mot de passe et une session temporaire native, supprimée côté Auth après l’action. Un compte exigeant un challenge MFA supplémentaire n’est pas pris en charge par cet écran : utiliser la procédure d’administration externe authentifiée, sans désactiver son MFA.
5. En tant qu’administrateur du déploiement, enregistrer les UUID confirmés dans `pos_private.organizations` et `pos_private.festivals`, puis un droit `manage_enrollment` dans `pos_private.scope_grants` pour l’UUID Auth du responsable. Aucun responsable ni périmètre n’est créé automatiquement. `manage_enrollment` ne donne pas `read_ledger`.
6. Déployer `supabase functions deploy tablet-auth-v1`. Conserver `verify_jwt = true`. Les secrets d’exécution `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` restent exclusivement côté Edge. Valider l’acceptation des vrais JWT du projet par sa gateway ; un 401 ne se résout pas en désactivant cette vérification.
7. Construire l’APK avec `pnpm android:sync:test` pour le projet de test, puis les commandes production existantes après validation de sa configuration. Tester le parcours réel avant distribution.

Exemple de préparation à exécuter avec des paramètres SQL fournis par votre procédure d’administration (aucune valeur réelle dans le dépôt) :

```sql
insert into pos_private.organizations(organization_id) values (:organization_id);
insert into pos_private.festivals(organization_id, festival_id) values (:organization_id, :festival_id);
insert into pos_private.scope_grants(organization_id, festival_id, auth_subject, capability)
values (:organization_id, :festival_id, :manager_auth_subject, 'manage_enrollment');
```

Les `:paramètres` sont des paramètres de votre outil SQL, pas des chaînes à copier littéralement dans l’éditeur du Dashboard. Le projet de production, les comptes et la politique d’attribution des droits doivent être confirmés par l’organisation.

## Enrôler une tablette

1. Installer l’APK et configurer le terminal A/B/C/D localement, même sans Internet.
2. Ouvrir **Paramètres de la caisse** et déverrouiller le mode responsable local.
3. Avec une connexion, toucher **Demander l’enrôlement / reconnecter**. Le natif crée l’installation physique, sa clé privée et sa session ; il transmet un dossier issu d’une lecture transactionnelle Room (chaîne, préfixe, terminaux historiques et inventaire legacy). La demande reste en attente.
4. Faire examiner ce dossier par le responsable habilité. Pour une nouvelle base, conserver le `chainId` proposé. Pour un remplacement ou une archive v1 sans chaîne, utiliser le `chainId` existant confirmé dans le registre ; ne jamais en créer un pour contourner un conflit.
5. Toucher **Approbation par un responsable serveur**. Saisir le compte nominatif habilité, les UUID confirmés organisation/festival/chaîne et, pour un remplacement, l’UUID de l’installation à retirer. Ces identifiants sont des informations d’administration, à préparer avant le festival. Le serveur recontrôle les droits ; le PIN ne sert qu’à ouvrir l’écran local.
6. Après approbation, le natif active l’invitation sur cette tablette. Une approbation extérieure peut remettre le code temporaire au responsable : le saisir dans **Code d’invitation temporaire**, puis **Activer cette tablette**.
7. Attendre **Tablette autorisée pour la synchronisation**. En cas de **Vérification ou reprise nécessaire**, conserver les données et résoudre l’incident ; l’habilitation ne suffit pas à autoriser la continuation d’un journal divergent.

Une demande expire après 24 heures. Une invitation contient 256 bits aléatoires, expire après dix minutes et n’est utilisable qu’une fois, pour le principal et l’installation exacts approuvés. Le serveur conserve seulement son SHA-256, y compris après consommation pour interdire sa réutilisation. Après cinq codes incorrects, lancer explicitement une nouvelle demande/reconnexion ; aucune tentative ne vide les ventes.

L’administration extérieure appelle le même endpoint HTTPS avec le JWT du responsable : `action: "approve"`, puis `body: {requestId, organizationId, festivalId, chainId, replacesInstallationId?}`. Le code renvoyé est à transmettre par un moyen contrôlé, sans logs. Une tablette ne peut pas l’utiliser au nom d’un autre principal. Pour examiner un dossier complet ou retrouver la chaîne d’une archive v1, utiliser l’accès administrateur contrôlé au registre privé ; aucune interface générale d’administration serveur n’est ajoutée au POS.

## Session expirée, perte de clé ou fichier corrompu

**Vérifier / rafraîchir la session** renouvelle automatiquement une session proche de son expiration. Le refresh est sérialisé entre l’écran natif et les workers dans le processus Android unique de l’application. Un worker #35 doit utiliser `TabletAuthService.get(context)` ; aucun getter de token JavaScript n’existe.

Si le refresh est refusé ou le stockage ne peut plus être déchiffré, **Demander l’enrôlement / reconnecter** recrée explicitement un principal et un identifiant d’installation, sans toucher Room. Le responsable approuve ce remplacement avec l’ancienne installation relevée dans le registre. Les credentials de responsable ne sont jamais écrits sur disque ; les credentials de tablette sont sauvegardés avant toute utilisation après rotation.

Ne pas effacer les données Android pour réparer Auth. Une erreur réseau suspend les échanges et conserve la session ainsi que toutes les données métier. Les erreurs affichées sont expurgées ; aucun JWT, refresh token, mot de passe ni code d’invitation n’est journalisé.

`capacitor.config.ts` impose `loggingBehavior: 'none'` dans toutes les builds, y compris debug : les logs automatiques du bridge Capacitor incluraient sinon les paramètres d’authentification et les codes temporaires. Les erreurs utiles restent affichées par l’interface sous une forme expurgée.

## Révoquer un appareil perdu ou volé

Sur une tablette disponible, **Révoquer cette installation** exige une connexion et le compte serveur habilité. L’action distingue révocation réseau et données locales. Pour un appareil perdu, un responsable authentifié appelle `tablet-auth-v1` avec `action: "revoke"`, `body: {chainId, installationId}` et son JWT. Il faut identifier l’installation dans le registre privé avant l’action ; un nom « Caisse B » seul ne suffit pas.

Le serveur retire l’installation sous verrou de chaîne. Ses nouvelles opérations protégées sont refusées même avec un JWT encore valable. Un appareil complètement isolé continue à encaisser et imprimer localement : la révocation distante ne peut pas lui parvenir instantanément. Aucun événement financier ni élément de file n’est supprimé.

## Remplacer une tablette et traiter un conflit

La [restauration locale vérifiée](tablet-replacement-and-backup.md) reste possible sans serveur. `TabletReplacementService` suspend Auth avant adoption ; Room inscrit aussi le marqueur `restored` dans la transaction de restauration. Les archives v1 restent intactes et ne reçoivent ni token ni `chainId` sous un ancien `archiveHash`.

En ligne, réenrôler la nouvelle installation et choisir explicitement la chaîne existante après examen des preuves d’archive/préfixe. L’activation retire l’ancienne installation et augmente la génération dans la même transaction. Elle compare tous les événements déjà stockés au préfixe déclaré : séquence, identifiant opaque, hash et terminal historique. Une archive plus ancienne que la tête distante ou un premier écart place l’installation en `needs_recovery`. La tête serveur ne recule jamais. Une archive v1 déclarée restaurée ne peut pas être automatiquement assignée à une chaîne neuve ; si le registre serveur n’existe pas, le rapprochement administratif reste une étape à fournir, sans faux succès.

Si deux tablettes ont encaissé hors ligne sur des copies : retirer l’installation obsolète, isoler les échanges, exporter et vérifier les deux archives, consigner le premier écart et les têtes communes. Ne pas fusionner, renuméroter, recalculer les hashes ou déplacer le suffixe vers une nouvelle chaîne. Les ventes des deux appareils restent conservées pour décision métier et traitement d’incident. La reprise d’un suffixe manquant relève de #36/#61, pas d’un bouton permettant d’ignorer la continuité.

Lorsque le serveur confirme que l’archive restaurée manque un suffixe, ne pas prolonger intentionnellement cette identité devenue obsolète : rétablir une sauvegarde complète vérifiée ou préparer une caisse vierge distincte explicitement autorisée. Cette consigne ne suppose aucun effacement des ventes déjà produites hors ligne.

## Changer la caisse d’une tablette

Le changement normal conserve la chaîne financière. Il est protégé dans `TerminalConfigurationService`, en plus du contrôle UI. Il refuse pending, transfert, erreur non résolue, continuité échouée **ou inconnue**. Sans l’outbox #35, aucune preuve « tout acquitté » n’existe : ce changement est donc suspendu par défaut, y compris sans réseau. Le renommage reste disponible.

Procédure exceptionnelle : arrêter l’opération de changement, vérifier et exporter une archive, consigner motif, terminal courant, chaîne, installations/générations, têtes, erreurs et états pending ; traiter l’incident avec le responsable. Jusqu’à #35, continuer sous l’identité actuelle ou préparer une autre caisse vierge autorisée. Il n’existe pas de bouton de contournement, de purge de file ou de reprovisionnement d’exception silencieux. Une future procédure approuvée devra conserver ces traces et valider les mappings historiques côté serveur.

## Protection native et frontière serveur

Access/refresh tokens et dossier Auth sont chiffrés en AES-256-GCM, avec IV distinct et écriture atomique, dans `Context.noBackupFilesDir/tablet-auth-v1.enc`. La clé AES et la clé RSA 2048 de signature sont non exportables dans Android Keystore. Le stockage Auth n’est pas lu par les exports Room/Samhain. `allowBackup=false` et les exclusions cloud/D2D couvrent aussi les fichiers privés et WebView. La clé RSA signe le hash SHA-256 du corps exact, l’action, l’installation et un challenge serveur de 60 secondes ; le nonce est consommé dans la transaction SQL de l’opération. Un token copié sans clé ne permet pas les opérations protégées ni les lectures directes de tables par une installation.

Keystore ne résout pas root, compromission du processus ni accès physique à une tablette déverrouillée. L’application et WorkManager doivent rester dans un seul processus ; une future configuration multi-processus devra ajouter un verrou interprocessus au refresh. Le comportement des clés matérielles, OEM et transferts nécessite des tests sur les appareils déployés.

Les RPC privilégiées sont fermées à PUBLIC/anon/authenticated. `tablet_auth_v1` appartient à un rôle NOLOGIN/NOBYPASSRLS limité au registre ; même cet owner n’a aucun droit d’écriture sur les événements financiers. L’Edge obtient le sujet avec Auth `/user`, refuse les comptes anonymes pour les actions responsable, puis SQL recontrôle les capacités et périmètres. Les installations ne peuvent lire directement le journal ; les auditeurs humains conservent leurs lectures RLS explicitement accordées. Aucun `user_metadata` n’autorise une opération.

## Contrats restant à intégrer

- **#35** : créer l’outbox transactionnelle de tous les kinds et son snapshot durable pour `ReprovisioningPreconditions`. Consommer l’identité Room v6 sans générer une nouvelle chaîne lors d’un changement de terminal ; ne pas utiliser les anciennes colonnes sync des ventes comme preuve d’ACK. Utiliser le service natif commun pour refresh et `sendSync`, jamais des tokens dans WebView.
- **#36** : `sendSync` garde le corps `samhain-sync/1` inchangé et ajoute `X-Samhain-Nonce` / `X-Samhain-Signature`. Chaque Edge fixe l’action au nom de son endpoint, valide Auth et appelle `verifyDeviceProof` sur le corps brut et ces headers. La RPC financière doit appeler `pos_private.consume_installation_proof(subject,context,nonce)` **dans sa transaction**, puis recontrôler chaque terminal/plage et continuer sous le même verrou de chaîne. Lui attribuer seulement les grants nécessaires, pas un accès client. `authorize` est un diagnostic, pas un permis réutilisable entre transactions. Prévoir une procédure de reprise qui revalide tout le préfixe et n’abaisse jamais la tête ; aucun endpoint ne lève actuellement `needs_recovery`.
- **#61** : utiliser `TabletReplacementService` et la restauration Room, préserver les archives v1, afficher séparément reprise locale et habilitation distante. Le parcours de sélection/import d’archive n’est pas simulé ici.

Le dossier d’enrôlement est borné à moins de 10 000 entrées et 1 MiB HTTP. Au-delà, la demande échoue en récupération ; le dossier paginé/protocole de préfixe de #36 doit prendre le relais. Les inventaires legacy sans préfixe requièrent un examen administratif ; aucune identification de chaîne ne se fait par terminal seul.

## Validation

Exécuter `pnpm test:run`, `pnpm lint`, `pnpm build`, `deno check supabase/functions/tablet-auth-v1/index.ts`, puis `pnpm android:sync:test` et `android/gradlew.bat -p android testDebugUnitTest assembleDebug` avec JDK 21/SDK Android. Les suites `supabase test db` vérifient les migrations, droits et révocations ; `node scripts/test-supabase-enrollment-concurrency.mjs` vérifie deux activations réelles concurrentes sur la pile **locale jetable**.

Avant exploitation, tester sur le projet de test : vrai signup/refresh/JWT/gateway, approbation d’un responsable habilité et refus d’un autre, révocation avec JWT encore valide, perte de clé, arrêt/redémarrage Android et mode avion avec vente et impression USB. Les tests JCE/Robolectric utilisent une clé injectée pour vérifier les octets chiffrés et le redémarrage disque ; ils ne prouvent pas le Keystore matériel de votre tablette. Tester cloud/D2D sur les modèles OEM. Ne pas annoncer un test matériel ou une connexion distante qui n’a pas été exécuté.
