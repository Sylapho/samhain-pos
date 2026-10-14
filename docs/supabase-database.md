# Base Supabase : schéma privé et sécurité POS

Fondation de [#113](https://github.com/Sylapho/samhain-pos/issues/113), conforme au
[contrat d’architecture #111](architecture-supabase-offline-first.md), `samhain-sync/1`.
Room/SQLite et IndexedDB restent les sources de vérité locales. Cette livraison ne
branche aucun appel réseau sur l’encaissement, le paiement ou l’impression, et
n’efface aucune donnée après un ACK.

## Schéma réellement créé

Les neuf tables de la fondation #113 sont dans `pos_private`. #114 ajoute quatre
tables de sécurité décrites dans [le runbook d'enrôlement](tablet-enrollment.md).
Ce schéma est **absent** de la liste `api.schemas` de `supabase/config.toml`.
La seule RPC POS publique est désormais `tablet_auth_v1`, réservée au serveur ;
aucune vue ou RPC d’ingestion financière n’est créée. Les UUID organisation/festival sont des périmètres
techniques, sans information commerciale ou fiscale inventée.

| Table             | Responsabilité et raison de la séparation                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`   | Périmètre supérieur et activation réseau.                                                                                                                                                                                              |
| `festivals`       | Périmètre d’exploitation appartenant à une organisation, activation indépendante.                                                                                                                                                      |
| `chains`          | Identité UUID durable, périmètre immuable, génération monotone et tête `(sequence, hash)`. La tête est dans cette même ligne : un verrou `FOR UPDATE` suffit pour sérialiser ses append et changements d’enrôlement.                   |
| `installations`   | Installation UUID, sujet Auth propre, chaîne et génération attribuées. Une seule installation active par chaîne. Retrait irréversible de cet enrôlement ; un remplacement reçoit une nouvelle installation et un nouveau sujet Auth.   |
| `scope_grants`    | Capacités explicites d’un sujet humain dans une organisation/festival : `read_ledger` ou `manage_enrollment`. Aucune attribution par défaut. Gérer l’enrôlement n’autorise pas implicitement la lecture financière.                    |
| `terminal_ranges` | Identité terminal historique opaque et plages inclusives de séquences, avec référence au dossier justificatif. Plages disjointes ; une identité peut réapparaître. Une plage ouverte peut être fermée sans exclure d’événements reçus. |
| `ledger_events`   | Les cinq kinds du ledger v1, contenu financier d’origine et tuple de transport immuables.                                                                                                                                              |
| `sales`           | Projection d’identité minimale pour l’unicité d’`orderId` et les FK des corrections. Une vente scellée référence le ledger, sans dupliquer son snapshot. Une vente legacy conserve ici son snapshot non scellé.                        |
| `sync_receipts`   | Reçu UUID stable et première réception serveur, sujet Auth, installation/génération et premier `requestId`. Un reçu par type/identifiant reçu.                                                                                         |

Il n’y a pas de tables séparées de lignes, paiements ou clôtures : ces données sont
déjà dans les snapshots et aucune requête indépendante ne justifie leur duplication.
Le catalogue et ses révisions relèvent de #115. Les états d’impression et intentions
de paiement restent locaux.

## Conservation des événements

`event_id`, `order_id`, `operation_id`, `session_id` et `terminal_id` sont des chaînes
opaques, non vides, bornées à 512 octets UTF-8. `sale:<UUID>` n’est pas converti en UUID.
Les séquences sont des entiers positifs sûrs JavaScript, jusqu’à `9007199254740991`.
Les empreintes ont le format SHA-256 hexadécimal minuscule.

Le journal conserve `event_id`, `sequence`, `schema_version`, `kind`, `recorded_at`,
`previous_hash`, `hash`, `source_terminal_id`, `payload_canonical`, le profil original
`ts-ledger-v1`/`android-ledger-v1`, `protocol_version` et `transport_fingerprint`.
`payload` est une colonne JSONB **générée** depuis le texte original. `source` et le
snapshot complet du kind restent à l’intérieur de ce payload. Les colonnes
d’identité métier sont également générées, sans saisir une seconde valeur divergente.
Les contraintes lient les en-têtes SQL aux valeurs JSON, avec leurs types JSON.

`payload_canonical` est la preuve de représentation originale ; JSONB ne doit jamais
servir à recalculer une empreinte historique. Le texte est conservé sans normalisation
des clés, échappements, Unicode ou champs absents. `recorded_at` reste du texte pour
préserver la date originale et sa précision ; `server_received_at` est un timestamp
PostgreSQL distinct dans le reçu. Aucun champ serveur n’est ajouté à l’événement.

Les corrections anciennes sans `refundLines` et clôtures sans `cashSessionId` restent
stockables. Une correction doit référencer une vente de **sa chaîne** et conserver
son `originalSaleHash`, y compris `null` pour une vente legacy. Fonds/clôtures qui
référencent une session doivent trouver son ouverture dans la même chaîne.

Pour `legacy_order`, `sales` contient le texte du snapshot immutable, le fingerprint
et la version de protocole, mais aucun `ledger_event_id` ni `sale_hash`. Il n’existe
aucune séquence, tête, profil ledger ou date de scellement fabriqués. Le reçu porte
`event_type = legacy_order`, `event_id = order.id`. L’import doit précéder les
corrections qui le référencent et ne modifie pas la tête. Le calcul des clôtures
reste celui du journal local, sans ajout automatique des ventes legacy.

## Contraintes, immutabilité et transactions

- Clé d’événement : organisation/festival/chaîne/ID ; séquence unique dans cette chaîne.
- `orderId` unique **dans le périmètre organisation/festival**, y compris entre chaînes
  et entre ventes scellées/legacy. Un doublon restauré n’est pas une nouvelle vente.
- `operationId` unique par périmètre/chaîne/kind ; ouverture unique par `sessionId`
  dans la chaîne. Les numéros imprimés n’ont aucune unicité inter-chaînes.
- Les FK composites interdisent de mélanger organisation, festival, chaîne, vente,
  session, installation, génération ou sujet du reçu.
- L’append verrouille la ligne de chaîne ; la nouvelle séquence doit être tête+1,
  `previousHash` doit être la tête et le terminal doit être mappé à cette séquence.
  Une collision d’ID/séquence est refusée, même avec un contenu différent.
- Après insertion, la projection de vente éventuelle et la tête sont avancées dans
  cette même transaction. Le FK de tête est différé ; sa valeur doit désigner un
  événement existant et elle ne peut ni reculer ni changer de hash à séquence égale.
- Des triggers de contrainte différés exigent un reçu pour tout nouvel événement
  ou toute vente legacy avant commit. Une erreur annule aussi la projection et la tête.
- Des triggers refusent UPDATE, DELETE et TRUNCATE sur ledger, ventes et reçus, y
  compris pour le propriétaire qui utilise des commandes DML normales. Les chaînes
  ne peuvent pas être déplacées/supprimées. Aucun FK financier n’utilise `CASCADE`.
- Remplacement : verrouiller la chaîne, retirer l’installation active, incrémenter
  la génération d’une unité, puis insérer la nouvelle installation. Un ancien
  enrôlement ne peut pas être réactivé et son sujet Auth ne peut pas être réutilisé.

Ces protections sont des invariants de stockage, **pas une API de validation métier**.
Le propriétaire de migration reste une identité de maintenance de confiance et peut,
comme tout administrateur, changer le schéma ou désactiver des triggers. Il ne doit
pas être utilisé pour recevoir directement des requêtes de caisses.

## Index et usages

Tous les index proviennent d’une clé/contrainte, sauf l’index partiel d’exclusion des
installations actives. Aucun index de statistiques spéculatif n’est ajouté.

| Index/clé                                                  | Usage                                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| PK organisations/festivals/chaînes/installations           | Identités et recherche du périmètre ou de la ligne à verrouiller.                             |
| UNIQUE portée+chaîne sur `chains`                          | Cible des FK composites qui empêchent un mauvais périmètre.                                   |
| UNIQUE `installations.auth_subject`                        | Association permanente d’un sujet technique à une installation ; consultation d’autorisation. |
| `installations_one_active_chain`                           | Empêcher deux prolongements autorisés simultanés ; recherche de l’installation active.        |
| UNIQUE tuple installation/périmètre/génération/sujet       | FK du reçu d’ingestion, traçabilité historique sans changement de sujet.                      |
| PK `scope_grants` sujet/périmètre/capacité                 | Vérification de la capacité explicite à chaque lecture.                                       |
| PK `terminal_ranges` portée/chaîne/début                   | Recherche des plages historiques d’une chaîne, vérification de non-chevauchement sous verrou. |
| PK ledger et UNIQUE portée/chaîne/séquence                 | Replays, collision et diagnostic du préfixe ; parcours ordonné d’une chaîne.                  |
| UNIQUE portée/chaîne/séquence/hash                         | FK de tête : une tête ne peut désigner le mauvais hash.                                       |
| UNIQUE portée/chaîne/kind/opération, portée/chaîne/session | Idempotence métier des opérations et FK des sessions.                                         |
| UNIQUE ledger portée/chaîne/événement/commande/hash        | FK de projection : une vente scellée désigne exactement le bon événement/ordre/hash.          |
| PK ventes portée/commande et UNIQUE portée/chaîne/commande | Détection de doublon inter-chaînes et FK des corrections/legacy.                              |
| PK reçus portée/chaîne/type/événement et UNIQUE UUID reçu  | Retrouver le reçu initial au replay et identifier l’ACK.                                      |

## Grants et RLS

RLS est activée et forcée sur les neuf tables dès la première migration. La première
migration ne donne aucun accès API ; la suivante ajoute uniquement les lectures
autorisées et les garde-fous. Il n’existe **aucune politique d’écriture**.

| Rôle                        | Droits POS effectifs                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC`, `anon`            | Aucun accès au schéma, aux tables ou fonctions POS.                                                                                                                                                     |
| `authenticated`             | USAGE du schéma ; SELECT sur chaînes, mappings, ledger, ventes et reçus, sous RLS. EXECUTE du seul prédicat privé `can_read_chain`. Aucun accès direct au registre d’habilitations et aucune mutation.  |
| `service_role`              | Aucun grant POS, aucune fonction exécutable. BYPASSRLS seul ne donne pas les privilèges SQL manquants. L’ingestion reste fermée jusqu’à #36.                                                            |
| `pos_policy_reader`         | NOLOGIN, NOINHERIT, sans BYPASSRLS ; SELECT sur les cinq tables de registre nécessaires au prédicat, sous politiques dédiées de lecture. Aucun droit sur les payloads/reçus, aucune écriture ni CREATE. |
| Propriétaire des migrations | Maintenance et fixtures locales uniquement. Pas un credential applicatif.                                                                                                                               |

Le prédicat privé `can_read_chain(organization, festival, chain)` est le seul
`SECURITY DEFINER`. Son propriétaire est `pos_policy_reader`, ses objets sont
qualifiés et son `search_path` est vide. Il dérive **toujours** le sujet des claims
PostgreSQL vérifiés par PostgREST, avec la même expression que `auth.uid()` ;
aucun paramètre sujet, terminal ou `user_metadata` ne peut donner des droits.
Les autres fonctions sont des triggers invoker privés, EXECUTE révoqué aux rôles API.

L’extraction lit `request.jwt.claim.sub`, puis `request.jwt.claims.sub`. Ces paramètres
sont ceux du gateway authentifié, pas des champs du corps HTTP. Aucun RPC ne permet
de les modifier. Le prédicat ne requiert ainsi aucun grant sur le schéma `auth`,
géré par Supabase : le rôle `postgres` de migration n’en possède pas le grant option.
Il ne s’agit pas d’une vérification de signature JWT en SQL ; #36 doit vérifier le
JWT/session à la frontière HTTPS et revalider l’autorisation dans sa transaction.

Une installation lit uniquement sa chaîne, avec une habilitation active et une
génération courante dans des périmètres actifs. Un humain explicitement doté de
`read_ledger` lit uniquement les chaînes du périmètre attribué. Un sujet ayant servi
à une installation n’utilise jamais le chemin de capacité humaine pour retrouver
des droits après révocation. `manage_enrollment` seul ne donne pas de lecture financière.
La révocation du registre s’applique à la prochaine requête même si le JWT n’a pas
expiré. Cela ne prétend pas annuler une lecture déjà en cours ni bloquer les ventes
d’une tablette hors ligne. Le PIN responsable local n’intervient jamais ici.

## Contrat à compléter dans #36 et #114

**#36** doit créer l’Edge HTTPS authentifiée puis une unique RPC transactionnelle
validée. Ne pas ajouter de grants directs `service_role` sur ces tables pour contourner
la validation. N’ouvrir EXECUTE que sur le chemin serveur complet, avec propriétaire
limité si un definer est nécessaire, objets qualifiés et `search_path = ''`.

La RPC devra recevoir le sujet **issu du JWT vérifié par l’Edge**, recontrôler les
capacités et périmètres actifs, installation/génération, mappings historiques et
verrouiller chaîne **et registre d’habilitation** pour sérialiser une révocation
concurrente. Elle devra vérifier Auth/session/utilisateur actif, tailles de lots,
protocoles, canonicalisation TS/Kotlin, clés JSON dupliquées, SHA-256 financier et
fingerprint de transport ; puis les règles complètes de ventes, corrections,
quantités/TVA historiques, sessions/fonds et clôtures, sans catalogue actuel.

Sous ces verrous, comparer les replays au tuple original complet, vérifier
`expectedHead`, traiter lacunes/forks/dépendances, insérer nouveaux événements et
reçus dans la même transaction, et retourner les ACK après commit. Le trigger fait
déjà l’avancement de tête et la projection des ventes scellées : ne pas les avancer
une seconde fois. Pour legacy, insérer `sales` puis son reçu sans append du ledger.
Le reçu conserve sa première date et son UUID ; un replay ne fait pas d’UPDATE ni
d’`ON CONFLICT DO UPDATE`. Les contraintes seules n’émettent pas d’ACK et ne classent
pas encore les conflits selon les codes HTTP du contrat.

**#114** doit fournir l’enrôlement approuvé, les credentials propres à l’installation,
leur stockage natif et la gestion des sessions/révocations. Le registre présent
permet les droits, générations et preuves historiques ; il ne constitue pas une
interface d’administration ou un flux d’enrôlement utilisable. Les attributions de
comptes/capacités restent des décisions d’exploitation. #35 capturera l’outbox locale ;
#115 ajoutera les données catalogue lorsque leur besoin sera défini.

## Exécuter migrations et tests

La migration additive #114 `20261014200000_tablet_enrollment.sql` ajoute les demandes, clés publiques d'installation, challenges et traces d'approbation/révocation. La RPC `tablet_auth_v1` est uniquement exécutable par le serveur Edge, sous un propriétaire NOLOGIN limité au registre. Elle ne fournit aucune ingestion financière. Les lectures directes des installations sont fermées, car elles contourneraient la preuve de possession ; les capacités humaines explicites restent soumises à RLS. Voir [la configuration et l'exploitation](tablet-enrollment.md). `enrollment.test.sql` complète la non-régression `pos.test.sql` et le script de concurrence vérifie une seule activation d'invitation sous deux connexions SQL réelles.

Prérequis : Docker actif, Supabase CLI sur PATH et Node.js. Aucun SDK Supabase n’est
ajouté au frontend. Aucune connexion à un projet hébergé ni clé serveur n’est requise.
Sur Windows, placer l’exécutable `supabase.exe` sur PATH pour le script Node qui lance
ses commandes sans shell. La CI dédiée `.github/workflows/supabase.yml` exécute la
pile locale avec Supabase CLI 2.121.0.

Depuis la racine du dépôt :

```bash
supabase start
supabase migration up --local
supabase test db
```

Pour reconstruire **la base de développement locale jetable** et vérifier l’évolution :

```bash
node scripts/test-supabase-migrations.mjs
supabase test db
supabase stop
```

Le script refuse un `project_id` inattendu et n’accepte aucun paramètre distant.
Il réinitialise la base **locale** jusqu’à la première migration, insère des fixtures
transactionnelles, applique les suivantes et compare le contenu complet des neuf
tables. Il reconstruit ensuite une base vide avec toutes les migrations pour pgTAP.
Il efface donc les données de cette base de développement ; conserver ailleurs toute
donnée locale à garder avant de l’exécuter. Ne jamais transposer ce reset à la production.

`supabase/tests/pos.test.sql` utilise pgTAP, `SET ROLE` et les claims locaux de test
pour contrôler permissions effectives et isolation. Chaque suite est rollbackée.
Les helpers de `supabase/tests/fixtures/pos.psql` sont temporaires, invoker et exclusivement
destinés aux tests ; aucun helper ni fixture n’est dans les migrations déployables.
Les hashes synthétiques des fixtures testent conservation et contraintes SQL,
**pas** la conformité cryptographique ou métier d’une ingestion #36.

Couverture : droits de chaque table/fonction, absence de vue/RPC publique, rôles
anonyme/A/B/humain/manager/hors périmètre, scopes actifs et retirés, falsification de
métadonnées, installation remplacée, collisions d’ID/séquence/opération/session/vente,
FK, écritures directes, UPDATE/DELETE/TRUNCATE, snapshots historiques et legacy,
octets UTF-8/échappements/précision de date, têtes, mappings, reçu obligatoire et rollback.

Restent à tester avec #36/#114 : vrais JWT/gateway/HTTP, expiration/refresh Auth,
révocation concurrente avec ingestion, concurrence de lots, ACK perdu/replay,
`expectedHead`, canonicalisation TS/Kotlin/serveur, calculs financiers et parcours
d’enrôlement natif. La caisse et l’USB n’ont pas besoin d’essai matériel pour cette
modification SQL seule ; les essais d’intégration restent nécessaires avant exploitation.

Vérifications de livraison du 14 octobre 2026 : Supabase CLI **2.121.0**, PostgreSQL
Supabase **17.11**, installation vierge et évolution des neuf tables par le script
livré réussies ; **191 assertions pgTAP réussies** ; `supabase db lint --schema
pos_private --fail-on error` sans erreur ; **376 tests Vitest réussis** dans 44
fichiers ; `pnpm lint` réussi. Les fixtures/migrations ont aussi été vérifiées sur
PostgreSQL embarqué avant la pile Supabase réelle. Aucun test HTTP/JWT/Android/USB
ni déploiement hébergé n’est revendiqué ; aucun code applicatif ou natif ne change.

## Évolution et critères d’acceptation #113

Les migrations horodatées sont appliquées dans l’ordre. Après déploiement, ne jamais
réécrire une migration passée. Ajouter de nouvelles migrations, avec un test depuis
la version précédente et conservation des événements/reçus. Ajouter un kind ou un
profil par extension explicite des contraintes, sans redéfinir les anciens profils
ni recalculer les anciennes empreintes. Protocole réseau et schéma ledger sont deux
colonnes distinctes. Les anciens champs optionnels absents restent absents.
Chaque nouvel objet doit retirer explicitement les grants/EXECUTE hérités, définir
sa RLS et passer les tests de droits ; les default privileges privés ne suffisent
pas à neutraliser d’éventuels grants globaux d’un autre propriétaire.

| Critère #113                                          | Mise en œuvre et vérification                                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base vierge et évolution sans perte                   | Deux migrations ordonnées ; script de reconstruction et comparaison complète des neuf tables.                                                             |
| Isolation A/B/périmètres et refus anonyme             | Grants minimaux et prédicat Auth/registre actif ; assertions pgTAP par rôle et capacité.                                                                  |
| Conservation IDs/séquences/hashes/snapshots           | Texte original, projections générées, dates locales textuelles, immutabilité et tests d’octets/historiques.                                               |
| Refus des mutations et insertions hors chemin validé  | Aucun grant d’écriture API/service-role, aucun RPC d’ingestion ; triggers d’immutabilité et contraintes techniques. L’ouverture du chemin validé est #36. |
| Tests des objets exposés, index/projections justifiés | Inventaire SQL des grants/RLS/search_path/definer, absence de vues/RPC publiques, tables et index documentés ci-dessus.                                   |

Références officielles : [RLS et grants](https://supabase.com/docs/guides/database/postgres/row-level-security),
[CLI migrations et tests](https://supabase.com/docs/reference/cli/introduction),
[pgTAP Supabase](https://supabase.com/docs/guides/local-development/testing/pgtap-extended).
