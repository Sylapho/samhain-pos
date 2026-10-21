# Déployer et récupérer la synchronisation Supabase

Version du runbook : 21 octobre 2026. Contrat `samhain-sync/1` : enveloppe et ledger
schéma 1, profils `ts-ledger-v1`, `android-ledger-v1`, transport canonique distinct.
Le serveur est une copie distante ; **Room reste la vérité opérationnelle Android**.
Encaissement, paiement et impression fonctionnent localement pendant un incident.

## Préparer la release

1. Identifier le commit exact, la version APK/versionCode, les cinq migrations et
   les cinq fonctions. Exécuter la [campagne isolée](supabase-integration-validation.md).
   Un échec de conservation, idempotence ou isolation bloque l'activation réseau.
2. Préparer deux projets **distincts** test et production, les UUID réels des
   organisations/festivals, les comptes responsables nominatifs et leurs capacités.
   Ne pas importer les fixtures du dépôt dans un projet d'exploitation.
3. Préparer Node 22.22+ ou 24, pnpm 10.33.0, Supabase CLI 2.121.0, Deno 2.9.7,
   Docker pour la campagne locale, JDK 21 et SDK Android pour l'APK. Les versions
   sont celles de la campagne, pas une promesse pour toutes versions ultérieures.
4. Confirmer données métier/administratives et signature APK selon
   [la release Android](android-production-release.md). Les placeholders ne doivent
   pas être transformés en données confirmées pour faire passer une build.
5. Exporter/vérifier une `SalesArchive` de chaque tablette et la conserver hors
   appareil. Relever nombres d'événements, dernier `(sequence,id,hash)`, numéros,
   erreurs/outbox, installation/génération et état d'impression. Suspendre seulement
   les échanges si nécessaire, jamais la capture locale.
6. Vérifier sur le projet de test les vrais JWT, la gateway, la preuve RSA,
   expiration/refresh, refus de lecture et révocation. Le bridge local n'est pas
   une validation TLS ni Android Keystore sur matériel.

Les variables publiques sont `VITE_SUPABASE_URL` (origine **HTTPS**),
`VITE_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_...`),
`VITE_SUPABASE_ENVIRONMENT=test|production`, et la confirmation indépendante
`SAMHAIN_SUPABASE_PRODUCTION_URL` pour une release configurée. Voir
[configuration](supabase-configuration.md) pour leurs validations effectives.
Les clés `service_role`/secrètes, passwords, access/refresh tokens, invitations et
clés de signature restent hors Vite, APK, archives, logs et rapports CI.
Utiliser le coffre de déploiement pour le token CLI et le password PostgreSQL ;
aucune commande de ce runbook ne demande de les écrire dans le dépôt.

La tablette a besoin d'HTTPS vers Auth et `/functions/v1/`, sans accès PostgreSQL.
Une panne DNS/TLS ne justifie ni HTTP, ni désactivation de validation de certificat,
ni désactivation de `verify_jwt`. Le HTTP loopback est réservé au laboratoire Docker.
Le PIN local responsable ouvre les outils locaux et ne donne aucun droit serveur.

## Déployer explicitement sur le projet confirmé

Les commandes suivantes sont des opérations **distantes**, à lancer par le
mainteneur autorisé après revue du projet ciblé. La campagne `pnpm test:supabase`
ne les appelle jamais. Ne pas utiliser `db reset` sur ce projet.

```powershell
supabase login
$samhainProjectRef = Read-Host 'Reference exacte du projet autorise (test puis production separement)'
supabase link --project-ref $samhainProjectRef
supabase migration list --linked
supabase db push --linked --dry-run
# Examiner le plan et la reference du projet avant cette commande.
supabase db push --linked
supabase functions deploy tablet-auth-v1 --project-ref $samhainProjectRef
supabase functions deploy ledger-ingest-v1 --project-ref $samhainProjectRef
supabase functions deploy legacy-import-v1 --project-ref $samhainProjectRef
supabase functions deploy ledger-prefix-v1 --project-ref $samhainProjectRef
supabase functions deploy catalog-v1 --project-ref $samhainProjectRef
```

Ordre SQL imposé par les fichiers versionnés :

1. `20261014180000_pos_schema.sql` : stockage privé.
2. `20261014180100_pos_guards_and_rls.sql` : invariants et lectures RLS.
3. `20261014200000_tablet_enrollment.sql` : registre Auth/preuve/générations.
4. `20261014210000_ledger_ingestion.sql` : RPC transactionnelles.
5. `20261021100000_catalog_distribution.sql` : catalogue versionné.

Ne pas rejouer manuellement une migration déjà appliquée, ni altérer son historique.
La configuration locale TOML ne prouve pas la configuration hébergée : vérifier
dans le projet que `pos_private` n'est **pas exposé** par Data API, que seules les
RPC publiques prévues existent et qu'elles sont réservées au rôle serveur.
Conserver `verify_jwt=true` pour les cinq fonctions. `SUPABASE_URL` et
`SUPABASE_SERVICE_ROLE_KEY` sont fournis côté Edge ; vérifier leur projet sans les
afficher. La clé privilégiée n'est pas une habilitation de tablette : les RPC doivent
toutes recontrôler sujet/session, installation, génération, portée et nonce.

En session SQL administrative contrôlée, vérifier le résultat suivant :

```sql
select n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='pos_private' and c.relkind='r'
order by c.relname;
-- Les deux booleens doivent etre vrais pour chaque table privee.
select p.proname,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as user_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as edge_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in
 ('tablet_auth_v1','ledger_ingest_v1','legacy_import_v1','ledger_prefix_v1','catalog_v1');
-- false,false,true pour chacune des cinq RPC.
```

Ces requêtes d'inventaire ne remplacent pas les opérations RLS du laboratoire,
ni les essais de refus sur le projet test. Ne pas y exécuter les scripts Docker
avec une URL modifiée pour viser le cloud : ils sont volontairement fermés.

## Habiliter deux tablettes et contrôler le premier envoi

Créer les registres et droits avec les UUID confirmés suivant
[l'enrôlement](tablet-enrollment.md#préparer-supabase) : `manage_enrollment` pour
enrôler/révoquer, `read_ledger` séparé pour lire, `publish_catalog` seulement si
la publication catalogue appartient à la release. Aucun grant global implicite.
Activer les inscriptions anonymes Auth pour les tablettes ; un principal inscrit
ne possède aucun droit financier avant l'approbation. Les restrictions Auth/MFA
du projet doivent être compatibles avec le parcours effectivement utilisé.

1. Construire et synchroniser l'APK de test vers le **projet hébergé de test**.
   Installer en conservant les données ; valider vente et impression sans réseau.
2. Sur la tablette A, demander l'enrôlement depuis les paramètres responsable,
   examiner son dossier Room et approuver avec le compte serveur habilité.
   Garder le `chainId` existant ; confirmer explicitement une installation remplacée.
3. Activer le code signé, vérifier `authorized` et la continuité. Un statut
   `needs_recovery` interdit de considérer l'enrôlement comme un succès d'upload.
4. Sur B, répéter avec sa propre base, son installation, sa clé et sa chaîne.
   Tester un responsable d'un autre périmètre : refus attendu.
5. Autoriser les échanges dans le suivi responsable. Les retries utilisent le
   travail unique existant. Attendre les ACK ; une simple connexion ne les prouve pas.
6. Pour chaque chaîne, comparer local/serveur : ID, séquence, previousHash, hash,
   payload canonique original, fingerprint, reçu UUID et date initiale de réception.
   Vérifier la bijection ACK↔événement et la tête. Les événements legacy ont un
   reçu, mais pas de séquence/hash scellé ni d'avancement de tête.
7. Vérifier qu'un replay retourne le même reçu et `already_present`, qu'aucun
   paiement/numéro/état d'impression n'a changé et que l'archive locale reste valide.
8. Exécuter le [protocole réseau/USB](tm-t88v-usb-test-plan.md). Conserver le rapport
   daté avant d'activer la release production. Refaire la configuration production
   et les builds/signatures validés, sans réutiliser la configuration de test.

Pour les rapprochements administratifs, utiliser une requête paramétrée dans votre
outil SQL (les `:parametres` ne sont pas littéralement utilisables dans le Dashboard) :

```sql
select e.event_id,e.sequence,e.previous_hash,e.hash,e.ledger_canonicalization,
 e.transport_fingerprint,r.receipt_id,r.server_received_at
from pos_private.ledger_events e join pos_private.sync_receipts r
 using(organization_id,festival_id,chain_id,event_id)
where e.organization_id=:organization_id and e.festival_id=:festival_id
 and e.chain_id=:chain_id order by e.sequence;
```

Ne pas exporter les payloads dans un rapport public. Les preuves financières,
archives et traces d'identité restent sur un support d'incident à accès contrôlé.

## Exploiter et diagnostiquer

Le panneau responsable lit les compteurs persistants : pending/sending/synced,
paused_auth/needs_recovery/quarantined. Le dernier ACK correspond au marquage
durable validé ; une date de connexion ou une approbation n'est pas un ACK.
Un délai hors ligne ou un backoff prévu est normal. Un bail `sending` expiré est
récupérable après 120 secondes ; ne pas lancer un autre moteur concurrent.
WorkManager est différé, contraint au réseau, avec rescan de 15 minutes ; Doze,
restrictions OEM et force-stop peuvent différer son exécution jusqu'à réouverture.

Pour tout incident : relever date/commit/APK, chaîne et installation/génération,
têtes locales/distantes et premier tuple divergent, compteurs et code expurgé,
nombre de tickets réellement sortis ; exporter et vérifier une archive hors appareil.
Les ventes peuvent continuer localement sous l'identité courante. Lorsqu'une copie
restaurée est reconnue obsolète, ne pas prolonger volontairement cette branche :
isoler ses échanges et préparer une caisse distincte autorisée si la récupération
complète est impossible. Préserver toutes ventes déjà produites.

| Incident                                        | Opérations autorisées / reprise                                                                                                           | Preuves supplémentaires                                            | Opérations interdites                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Réseau absent / Supabase indisponible / DNS/TLS | Vendre/imprimer localement ; vérifier réseau puis laisser reprendre le worker                                                             | Début/fin panne, nombre pending, archive                           | Attendre le réseau pour payer, HTTP de secours, effacer Room                            |
| Timeout, HTTP 408/429/500/502/503/504           | Respecter nextAttemptAt/backoff et Retry-After ; réessayer le même lot                                                                    | Code HTTP expurgé, tentative, tête serveur                         | Boucle de relance agressive, nouvel ID de vente                                         |
| Session expirée                                 | Vérifier/rafraîchir via le service natif commun ; si refus, réauthentifier explicitement                                                  | Statut Auth, installation, périmètre                               | Copier un JWT dans JavaScript/rapport, changer l'identité pour contourner               |
| Tablette révoquée / clé perdue                  | Suspendre upload ; responsable confirme identité et remplacement, nouveau principal/clé, contrôle complet de préfixe                      | Ancienne/nouvelle installation, générations, dossier d'approbation | Réactiver l'ancienne installation, transférer tokens/clés dans une archive              |
| Outbox bloquée / backfill incomplet             | Inspecter premier événement, curseur, bail, Auth et code ; relance du travail unique après résolution                                     | Curseur, premier ID/hash, état avant/après                         | Purger file, sauter événement, modifier status pour fabriquer synced                    |
| ACK perdu                                       | Garder pending ; replay identique avec nouveau challenge ; valider le véritable already_present                                           | Reçu initial, ID/hash/fingerprint, requestId de chaque tentative   | Marquer synced depuis la seule tête, refaire paiement/impression                        |
| Hash divergent / SEQUENCE_FORK                  | Isoler échanges de la chaîne ; comparer les deux archives/préfixes, intervention administrative                                           | Premier écart exact et préfixe commun                              | Last-write-wins, recalcul de hash, renumérotation, fusion ou déplacement du suffixe     |
| Tête serveur plus avancée / MISSING_PREDECESSOR | Diagnostic ledger-prefix-v1 ; chercher sauvegarde complète/ancienne tablette ; réenrôler seulement après preuve                           | Tuples manquants et têtes ; résultat match/absent/conflict         | Reculer le serveur, considérer prefix comme ACK, prolonger archive ancienne à l'aveugle |
| Schéma/protocole serveur incompatible           | Suspendre seulement les échanges ; vérifier matrice client/serveur, déployer version compatible                                           | Versions exactes, code, migration appliquée                        | Réécrire les événements, désactiver assertions/contrôles                                |
| Déploiement interrompu                          | Lire migration list et fonctions réellement déployées ; reprendre migrations manquantes après revue, redéployer mêmes sources compatibles | Commit, liste/heure des étapes déjà appliquées, têtes avant/après  | db reset distant, migration repair sans preuve, rollback destructif                     |

Révocation : utiliser l'action `revoke` authentifiée du responsable pour
`{chainId,installationId}` ; une tablette isolée reste capable de vendre jusqu'au
retour réseau. Une rotation de credentials passe par le refresh sérialisé ou le
réenrôlement contrôlé, jamais par le transfert de fichiers Keystore. Pour tourner
une clé privilégiée serveur, utiliser la procédure du fournisseur/coffre, vérifier
les fonctions et le projet test, puis révoquer l'ancienne clé après validation.
Les credentials d'installation et l'historique financier restent indépendants.

## Rollback compatible et récupération sans purge

Avant tout retour : arrêter seulement les échanges, vérifier/exporter les archives,
inventorier ACK et têtes, choisir le commit précédent **compatible** avec schéma,
protocole, profils et Room actuels. Garder le code et les migrations de la release
incidente disponibles pour le rapprochement.

| Élément                       | Procédure reproductible                                                                                                                                                                               | Condition d'arrêt                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Edge Function                 | Dans un checkout du commit connu compatible, rejouer `supabase functions deploy NOM --project-ref $samhainProjectRef` pour les fonctions concernées ; vérifier Auth/ACK sur test puis projet autorisé | Ancienne fonction incompatible avec nouveau schéma/protocole ou nouveau kind                          |
| Configuration                 | Restaurer URL/clé **publique** confirmées du bon environnement, rebuild et sync ; release selon runbook Android                                                                                       | Projet/portée non confirmés, credentials privés dans asset, mauvais environnement                     |
| APK                           | Préparer un rebuild compatible avec versionCode supérieur, même applicationId et signature ; installer en mise à jour sans effacer ; vérifier Room/historique/unknown/outbox                          | Ancien code incapable de lire Room v9 ; signature différente ; downgrade imposant une désinstallation |
| Migration PostgreSQL additive | Garder colonnes/tables déjà déployées ; corriger en avant par nouvelle migration versionnée testée avec données historiques                                                                           | Suppression ou altération d'un événement/reçu acquitté nécessaire                                     |
| Migration non réversible      | Suspendre upload, préserver snapshots et preuves, définir correctif administratif et nouvelle migration après revue                                                                                   | Toute perte d'ACK ou de preuve financière potentielle                                                 |
| Incident de données / fork    | Exporter les copies, comparer tous les tuples, retirer installation obsolète ; récupération d'un préfixe exact ou caisse distincte autorisée                                                          | Premier écart non résolu ; aucun bouton « forcer »                                                    |

Une restauration PostgreSQL antérieure peut faire disparaître des événements déjà
acquittés que les tablettes ne renverront pas automatiquement. **Ce n'est jamais
un rollback sûr par défaut.** Conserver toutes les copies, isoler l'ingestion,
rapprocher chaque reçu et événement acquitté, puis élaborer une intervention
administrative auditée. Aucun script de ce dépôt n'automatise cette réconciliation.

Récupération de file : corriger réseau/Auth/version sans toucher aux données ;
laisser le backfill reprendre et comparer les préfixes ; rejouer les mêmes événements
et leurs fingerprints, avec nouveau requestId/preuve ; n'accepter que les ACK
strictement conformes ; vérifier ensuite snapshots, séquences, tête et archive.
Un diagnostic de préfixe n'acquitte rien. Un conflit permanent exige une décision
administrative avant reprise, sans purge, reconstruction approximative, changement
d'ID, hash ou fusion silencieuse. Les primitives de remplacement sont testées ;
le parcours opérateur complet #61 doit être validé séparément.

Supabase **ne remplace pas les SalesArchive**. Définir avec l'organisation les
supports et la politique réelle de sauvegarde du projet ; vérifier la disponibilité
et les limites du plan souscrit. Ce runbook n'invente ni rétention, SLA ni garantie
de restauration. Une opération jamais envoyée ne peut pas être récupérée depuis
Supabase si la tablette et ses sauvegardes locales sont perdues.

Références officielles consultées : [migrations Supabase](https://supabase.com/docs/guides/deployment/database-migrations),
[déploiement Edge](https://supabase.com/docs/guides/functions/deploy),
[tests locaux](https://supabase.com/docs/guides/local-development/cli/testing-and-linting).
