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
alimentent **Administration → Synchronisation des données** (#116), après le PIN local.
Le suivi et les paramètres de reconnexion se ferment à expiration du mode responsable
ou lorsque l'application passe en arrière-plan. Les lectures automatiques ne prolongent
pas la session responsable. Quitter le suivi n'annule aucun travail natif.

`pendingEvents` compte toutes les entrées non acquittées, tous types confondus ;
`sending` compte les claims en cours ; `errors` compte les événements bloqués ou
en attente après une erreur temporaire (ce dernier compteur peut donc recouper `pending`).
`errorCategory` distingue indisponibilité du service, incident temporaire, authentification
et conflit/reprise nécessaire. Les messages techniques ne sont pas affichés dans ce suivi.

Les lectures périodiques Room utilisent une projection sans payload financier.
La lecture locale d'autorisation ne prend pas le verrou des échanges réseau : le
coffre chiffré sérialise seulement ses lectures/écritures de fichier. Consulter le suivi
pendant une requête lente ne bloque donc pas l'exécuteur de stockage sur le réseau.
Les opérations d'authentification et de renouvellement restent sérialisées entre elles.

`lastServerReceivedAt` est le maximum chronologique des `serverReceivedAt` des reçus
validés et persistés. `lastSuccessAt` reste l'heure locale d'acquittement, distincte de
l'heure serveur ; les deux sont affichées séparément. Un ancien reçu reste historique
en présence de nouvelles opérations. « Synchronisation à jour » exige une autorisation,
les échanges activés, une capture complète, la continuité vérifiée, aucun événement
non acquitté ni erreur, et un reçu validé. Internet et une file vide seuls ne suffisent pas.
Une information absente/incomplète donne « Non disponible » ou un suivi incomplet.

`lastExchangeAt` vaut actuellement `null` : les tentatives et réponses de tous les
endpoints ne disposent pas d'un horodatage durable commun. Le suivi affiche donc
« Non disponible », sans présenter `lastAttemptAt` ni un échec réseau comme un échange
réussi. Aucune nouvelle table ou migration n'est nécessaire pour ce suivi.

La relance regroupe les appels JavaScript simultanés, puis utilise WorkManager `KEEP`
et les claims Room existants. Elle est refusée si désactivée, non autorisée, déjà en envoi
ou en conflit. Elle ne remet à zéro ni backoff ni compteur de récupération, et ne demande
pas automatiquement une récupération de préfixe. Une reprise d'intégrité exige une
intervention distincte ; le bouton ne contourne pas la quarantaine. Une demande acceptée
indique seulement une planification possible, jamais une réception serveur.

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
