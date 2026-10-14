# Livraison locale de l’issue #114

Branche : `feat/tablet-enrollment`. Aucun commit, push, merge ou déploiement distant effectué.

## Résultat

Auth et HTTPS natifs Android ; principal propre à l’installation ; invitation approuvée par un responsable serveur, unique, dix minutes et cinq essais ; preuve RSA Keystore par challenge ; révocation et générations sérialisées par chaîne ; coffre AES-GCM atomique hors backups ; refresh commun écran/worker ; récupération des restaurations anciennes/divergentes ; préconditions de reprovisionnement bloquées par défaut tant que #35 ne fournit pas de preuve durable.

Room 6 ajoute seulement `sync_identity`. Aucun snapshot, hash, numéro, commande ou archive v1 n’est réécrit. Les ventes, paiements et impressions n’attendent pas Supabase. Les logs automatiques Capacitor sont désactivés pour éviter l’exposition des paramètres d’enrôlement.

## Vérifications exécutées

| Vérification                                                                                | Résultat                                                                                          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm test:run`                                                                             | 403 tests, 48 fichiers, tous réussis                                                              |
| `pnpm lint`, `pnpm build`, TypeScript                                                       | Réussis                                                                                           |
| `deno check supabase/functions/tablet-auth-v1/index.ts`                                     | Réussi                                                                                            |
| PostgreSQL Supabase 17.11 local, migrations et pgTAP                                        | 63 assertions d’enrôlement + 223 assertions de non-régression, réussies                           |
| Deux connexions SQL concurrentes                                                            | Une seule activation et une seule installation active                                             |
| Migration additive sur fixtures #113                                                        | Contenu exact des neuf tables préservé                                                            |
| `pnpm android:sync:test`, installateur natif, `testDebugUnitTest assembleDebug` avec JDK 21 | Build réussi, 54 tests Android, aucun échec ni test ignoré                                        |
| Room 5→6                                                                                    | Snapshot financier conservé après réouverture ; schémas de toutes les anciennes entités inchangés |
| Copies Android générées                                                                     | Identiques aux templates natifs après remplacement du package                                     |
| Prettier sur nouveaux fichiers principaux, `git diff --check`                               | Réussis                                                                                           |

Les tests Android utilisent Robolectric et des clés JCE injectées pour le coffre ; aucun test matériel Keystore/OEM/USB n’a été effectué. Aucun vrai compte/projet Supabase distant n’a été fourni ou utilisé : les assertions Auth côté Edge utilisent un transport injecté, tandis que les permissions, RLS et transactions SQL ont été exécutées réellement sur PostgreSQL local. La gateway avec les vrais JWT du projet, signup/refresh, comptes responsables et déploiement Edge restent à valider avant exploitation. L’APK construit est une build de test, sans configuration distante réelle ; la signature release n’a pas été testée.

## Configuration et intégrations

Suivre [la procédure complète](tablet-enrollment.md#préparer-supabase) : variables publiques, migrations, inscriptions anonymes/Auth, comptes nominatifs, périmètres confirmés et droits `manage_enrollment`, déploiement `tablet-auth-v1` avec vérification JWT conservée, validation sur le projet de test puis sur la tablette. Aucun secret n’est fourni ou inventé.

Les contrats #35/#36/#61, l’absence d’ingestion/outbox complète, la limite du dossier, le rapprochement administratif d’une archive v1 sans registre, le traitement des conflits et les limites MFA/CAPTCHA/multi-processus sont détaillés dans [le runbook](tablet-enrollment.md#contrats-restant-à-intégrer). Un état inconnu ne vaut jamais « tout synchronisé ». Aucun contournement ni purge d’incident n’est livré.

Message de commit suggéré : `feat(auth): enroll and revoke Supabase tablets securely`.

## Fichiers créés ou modifiés

Les sources `native/android/` sont la référence ; leurs copies sous `android/` et le schéma Room sont générés par les commandes du projet.

- Modifié : `.github/workflows/supabase.yml`
- Modifié : `README.md`
- Modifié : `android/app/src/main/java/fr/samhain/pos/MainActivity.kt`
- Modifié : `android/app/src/main/java/fr/samhain/pos/RoomOrderStore.kt`
- Modifié : `android/app/src/main/java/fr/samhain/pos/SamhainPosDatabase.kt`
- Modifié : `android/app/src/test/java/fr/samhain/pos/RoomOrderStoreTest.kt`
- Modifié : `capacitor.config.ts`
- Modifié : `docs/android-persistence.md`
- Modifié : `docs/architecture-supabase-offline-first.md`
- Modifié : `docs/sales-ledger.md`
- Modifié : `docs/supabase-configuration.md`
- Modifié : `docs/supabase-database.md`
- Modifié : `docs/tablet-replacement-and-backup.md`
- Modifié : `native/android/RoomOrderStore.kt`
- Modifié : `native/android/SamhainPosDatabase.kt`
- Modifié : `native/android/tests/RoomOrderStoreTest.kt`
- Modifié : `scripts/install-android-usb-printer.mjs`
- Modifié : `src/app/App.tsx`
- Modifié : `src/features/terminal/TerminalConfigurationDialog.tsx`
- Modifié : `src/services/tabletReplacementService.test.ts`
- Modifié : `src/services/tabletReplacementService.ts`
- Modifié : `src/services/terminalConfigurationService.test.ts`
- Modifié : `src/services/terminalConfigurationService.ts`
- Modifié : `supabase/config.toml`
- Modifié : `supabase/tests/fixtures/pos.psql`
- Modifié : `supabase/tests/pos.test.sql`
- Créé : `android/app/schemas/fr.samhain.pos.SamhainPosDatabase/6.json`
- Créé : `android/app/src/main/java/fr/samhain/pos/TabletAuthPlugin.kt`
- Créé : `android/app/src/main/java/fr/samhain/pos/TabletAuthService.kt`
- Créé : `android/app/src/main/java/fr/samhain/pos/TabletCredentialVault.kt`
- Créé : `android/app/src/test/java/fr/samhain/pos/TabletAuthServiceTest.kt`
- Créé : `docs/tablet-enrollment.md`
- Créé : `native/android/TabletAuthPlugin.kt`
- Créé : `native/android/TabletAuthService.kt`
- Créé : `native/android/TabletCredentialVault.kt`
- Créé : `native/android/tests/TabletAuthServiceTest.kt`
- Créé : `scripts/test-supabase-enrollment-concurrency.mjs`
- Créé : `src/features/terminal/TabletSynchronizationSettings.test.tsx`
- Créé : `src/features/terminal/TabletSynchronizationSettings.tsx`
- Créé : `src/native/tabletAuth.ts`
- Créé : `src/services/reprovisioningPreconditions.test.ts`
- Créé : `src/services/reprovisioningPreconditions.ts`
- Créé : `src/services/tabletEnrollmentService.test.ts`
- Créé : `src/services/tabletEnrollmentService.ts`
- Créé : `supabase/functions/_shared/tabletAuth.test.ts`
- Créé : `supabase/functions/_shared/tabletAuth.ts`
- Créé : `supabase/functions/tablet-auth-v1/index.ts`
- Créé : `supabase/migrations/20261014200000_tablet_enrollment.sql`
- Créé : `supabase/tests/enrollment.test.sql`
- Créé : `docs/issue-114-implementation.md`
