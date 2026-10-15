# Outbox transactionnelle et synchronisation différée (#35)

## Capture et migrations

Room **v7** ajoute `outbox` et `outbox_backfill` par migration additive **6 → 7**.
IndexedDB **v5** ajoute `outbox`, `syncMetadata` et un index unique de séquence du
journal. Les schémas Room exportés sont versionnés. Aucune migration destructive,
purge, nouvelle numérotation ou modification d'un snapshot financier.

`RoomOrderStore.insertLedger` capture les cinq kinds dans la transaction qui écrit
le journal, la vente/intention et les séquences. IndexedDB fait de même dans chaque
chemin métier, y compris la finalisation d'intention et la restauration. Une erreur
d'insertion outbox annule toute la transaction. Une finalisation rejouée rend la vente
existante. L'impression conserve son chemin et ses états ; elle ne consulte jamais
le réseau de synchronisation.

La capture fonctionne sans configuration Supabase, sans enrôlement et lorsque les
échanges sont désactivés. Les états techniques sont `pending`, `sending`, `synced`,
`paused_auth`, `needs_recovery`, `quarantined`. Ils ne sont jamais intégrés au hash
financier ni aux archives. Les anciennes colonnes `orders.sync_*` ne constituent pas
une preuve d'acquittement ; l'outbox est la référence des échanges.

## Rattrapage et restauration

Le curseur durable est committé avec chaque lot de capture, au plus 100 sources.
Room parcourt d'abord les ventes non scellées par ID, puis le journal par séquence.
IndexedDB borne aussi le parcours des commandes à 100 lignes par transaction pour
laisser passer de nouvelles ventes. Les insertions identiques sont idempotentes ; un
contenu incompatible arrête le rattrapage. Aucun paiement ni impression n'est créé.

Une archive ne fournit aucun ancien ACK de confiance. Le marqueur Room `restored`
et les contrôles d'enrôlement #114 restent nécessaires. Le rattrapage est réinitialisé
lors de l'import/restauration, sans réécriture des séquences ou empreintes.

Le profil retenu doit reproduire le hash original : `android-ledger-v1` ou
`ts-ledger-v1`. Lorsque leurs octets sont identiques, Android utilise son profil
natif de façon déterministe. La canonicalisation de transport est distincte et
n'échappe pas les slashs. Les ventes legacy utilisent leur `order.id`, le snapshot
immuable et `legacy-import-v1` avec séquence/hash/profil nuls. Aucun scellement
rétroactif. Elles passent avant les événements scellés de cette chaîne.

## Exécution Android et ACK

`OutboxStartupProvider` démarre le scan local à l'ouverture du processus, indépendamment
de React. Les opérations du plugin planifient après commit. WorkManager conserve
un travail unique par chaîne, contraint à une connexion, et un rescan de sécurité
toutes les 15 minutes couvre la fenêtre commit → planification. Une continuation
est attachée au travail courant pour reprendre au prochain instant utile.
Les tâches sans configuration ou sans données à traiter ne font aucun échange.

Un claim Room dure 120 secondes et est renouvelé avant transport ; un bail expiré
est récupérable. Le claim empêche deux drains utiles simultanés. Le timeout de chaque
requête HTTPS est de 30 secondes, avec interruption bornée et lecture limitée.
Le lot contient au plus 100 événements, 1 MiB de corps UTF-8 et 256 KiB par payload.
Le périmètre et le fingerprint sont figés avant le premier envoi. L'installation,
la génération et le requestId peuvent changer sans modifier l'événement financier.

`TabletAuthService.get(context).sendSync` conserve les credentials dans le coffre
natif. Il signe et transmet la même chaîne de corps, renouvelle la session sous le
verrou Auth commun et retente au plus une fois une expiration inattendue. Aucune
clé privilégiée ou session n'est exposée à JavaScript.

Un HTTP 200 doit satisfaire l'intégralité du contrat : contexte/version/requestId,
commit, bijection des ACK, identités, séquences, hashes, fingerprints, reçus UUID,
dates UTC et tête serveur. Une transaction Room marque ensuite tout le lot, sous
contrôle du claim et du contenu. Une réponse invalide ou perdue laisse le lot
réessayable ; un replay conserve l'événement et valide les reçus `already_present`.
Un diagnostic de préfixe n'est jamais un ACK. Les événements, archives et états
d'impression restent conservés après succès.

## Erreurs et récupération

- Réseau, timeout, 408, 429, 5xx : prochain instant persisté, jitter complet entre
  zéro et `min(6 h, 5 s × 2^n)`, avec respect de `Retry-After` valide. Les horloges
  techniques sont rebornées en cas de recul ; aucune date financière ne change.
- Auth refusée/retirée : `paused_auth`, conservation de la file ; l'état natif
  interdit de nouvelles tentatives jusqu'à réauthentification/habilitation.
- `HEAD_MOVED`, `MISSING_PREDECESSOR`, `DEPENDENCY_MISSING` : `needs_recovery`,
  rattrapage puis comparaison paginée de tous les tuples via `ledger-prefix-v1`.
  Une preuve compatible permet un replay, jamais un marquage implicite. Une reprise
  automatique est bornée ; un échec récurrent attend l'intervention explicite.
- Lot trop grand : réduction persistante jusqu'à un événement. Une entrée
  indivisible trop grande reste en quarantaine.
- Fork, conflit, hash ou métier invalide : quarantaine de la chaîne d'envoi.
  Les successeurs restent locaux ; les ventes suivantes restent possibles.
- Protocole/schéma incompatible ou tête distante plus avancée que les données
  locales : reprise responsable/mise à jour, sans saut d'événement ni fusion.

Les codes diagnostics sont expurgés. Ne pas vider Room, réécrire un hash ou déplacer
un suffixe vers une autre chaîne pour réparer les échanges. Conserver et vérifier
une archive, examiner le préfixe et les habilitations, puis utiliser la reprise
autorisée. Une divergence ne peut pas être ignorée par le bouton de relance.

## Interface de service et navigateur

`synchronizationService.diagnostics()` expose compteurs, Auth, dernière réussite,
dernière erreur, complétude et continuité. `retry()` utilise le même travail unique.
`setEnabled()` conserve le choix natif sans désactiver la capture. Ces méthodes
préparent #116 ; aucun nouveau dashboard n'est ajouté.

Le reprovisionnement normal relit la preuve Room au niveau du service avant de
changer l'identité. Pending, claim, erreur, rattrapage incomplet ou continuité
inconnue bloquent cette action. Le renommage garde son comportement.

Le Web capture et rattrape uniquement localement. L'enrôlement #114 étant natif,
aucun moteur réseau Web ni stockage de tokens Web n'est ajouté. Les transactions
IndexedDB sérialisent les onglets pour la capture/rattrapage. Fermer le navigateur
arrête la maintenance ; il n'y a aucune promesse de synchronisation navigateur fermé.

## Validation et limites d'exploitation

Commandes exécutables depuis la racine (PowerShell) :

```powershell
pnpm test:run
pnpm lint
pnpm build
pnpm android:sync:test
$env:JAVA_HOME = 'C:\Users\arthu\.jdks\jbr-21.0.11'
$env:ANDROID_HOME = 'C:\Users\arthu\AppData\Local\Android\Sdk'
.\android\gradlew.bat -p android testDebugUnitTest assembleDebug --console=plain
```

Les suites couvrent rollback, idempotence, cinq kinds, absence de configuration,
plusieurs jours hors ligne, claim/crash/reprise disque, ACK perdus/invalides,
concurrence, backoff/Auth/conflits, backfill interrompu, données legacy/restaurées,
ordre, conservation du journal/impression, migration v6 et travaux uniques.
Les tests simulent le transport ; ils ne prouvent pas une connexion de production.

WorkManager ne garantit aucun délai d'exécution : Doze, restrictions OEM et
force-stop peuvent reporter la reprise jusqu'à la réouverture. Voir la
[documentation Android](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started).
Sur tablette réelle, vérifier mode avion pendant plusieurs jours, arrêt du processus
avant planification et pendant HTTP, reboot, retour réseau, révocation/refresh réel,
Keystore OEM et impression USB. Aucun déploiement Supabase ni modification de
données réelles n'est nécessaire aux tests livrés.
