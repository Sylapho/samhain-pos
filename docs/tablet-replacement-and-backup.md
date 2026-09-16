# Sauvegarde et remplacement des tablettes

## Objet

Ce runbook est la procédure opérationnelle de Samhain POS pendant le festival. Il distingue strictement :

- **Android Backup / restauration système / transfert D2D** : désactivés et non supportés ;
- **archive Samhain vérifiée** : sauvegarde métier supportée, créée et restaurée explicitement ;
- **mise à jour APK** : remplacement du programme sans effacement de ses données privées ;
- **remplacement exact** : nouvelle tablette physique qui continue le même terminal logique ;
- **nouveau terminal logique** : nouvelle identité et nouveau `terminalId`.

Ne jamais copier manuellement `samhain-pos-room.db`, `/data/data/fr.samhain.pos/`, IndexedDB ou `localStorage` d'une tablette à une autre.

## Politique de sauvegarde Android

Le manifeste final doit contenir :

```text
android:allowBackup="false"
android:fullBackupContent="@xml/backup_rules"
android:dataExtractionRules="@xml/data_extraction_rules"
```

Les règles excluent `root`, `file`, `database`, `sharedpref`, `external`, `device_root`, `device_file`, `device_database` et `device_sharedpref`. Les sections Android 12+ `cloud-backup` et `device-transfer` sont toutes deux présentes : omettre l'une d'elles pourrait laisser le mode correspondant actif.

Les données qui ne doivent jamais être clonées automatiquement comprennent Room/SQLite, ventes, journal, séquences, états d'impression, IndexedDB historique, `localStorage` WebView, `terminalId`, `terminalCode`, credential responsable et marqueur de remplacement. La politique est globale pour couvrir aussi un futur stockage privé.

L'archive Samhain contient volontairement le journal, les ventes, les états techniques, les séquences, la source terminal, les empreintes et les métadonnées. Elle ne contient ni PIN, ni sel, ni clé dérivée, ni credential responsable.

## Contrôles avant toute restauration

Dans cet ordre :

1. déverrouiller le mode responsable ;
2. vérifier l'archive (`archiveHash`, chaîne du ledger, ventes scellées et métadonnées) ;
3. comparer `terminalId` et `terminalCode` ; le `displayName` n'est pas une identité durable ;
4. vérifier que la cible est vide, sans commande ni entrée de ledger ;
5. exécuter le restore transactionnel ;
6. vérifier l'intégrité, les séquences et l'identité après commit.

Une archive invalide, une identité incompatible ou une base non vide doit être refusée sans mutation. Il n'existe aucun mode de fusion : `journal X + archive Y` est toujours refusé.

## Remplacement exact du même terminal logique

Conserver le même `terminalId` uniquement si les trois conditions sont réunies :

1. la nouvelle tablette remplace exactement l'ancienne caisse ;
2. l'ancienne tablette est définitivement arrêtée, isolée ou retirée ;
3. la reprise utilise une archive Samhain vérifiée de cette identité.

Procédure lorsque l'ancienne tablette fonctionne encore :

1. arrêter les nouveaux encaissements ;
2. résoudre ou consigner toutes les impressions à reprendre ou à vérifier ;
3. vérifier l'intégrité du journal ;
4. clôturer la période si la procédure d'exploitation le prévoit ;
5. exporter une archive Samhain ;
6. vérifier immédiatement cette archive et sa copie hors tablette ;
7. noter `terminalCode`, `terminalId`, nom visible, séquences et empreinte de tête ;
8. éteindre et retirer l'ancienne tablette ;
9. installer l'APK sur la tablette cible vierge sans accepter de restauration Android ;
10. créer un nouveau credential PIN responsable local ; ne jamais copier l'ancien dérivé ;
11. exécuter le remplacement contrôlé avec exactement l'archive vérifiée ;
12. vérifier l'identité, le journal, les séquences, les impressions, l'imprimante, l'heure et le fuseau ;
13. effectuer une vente de test uniquement si la procédure comptable l'autorise, puis reprendre l'exploitation.

`TabletReplacementService` restaure d'abord le repository puis adopte l'identité. Un marqueur local rend la reprise idempotente entre Room et `localStorage`. Si l'opération est interrompue, l'application bloque provisioning et encaissement ; reprendre avec **la même archive**. Ne jamais lancer un provisioning normal pour contourner ce blocage.

La version actuelle ne fournit pas encore d'écran générique d'import/export d'archive. Le service de domaine et ses contrôles sont prêts pour un outil d'exploitation dédié ; tant que cet outil n'est pas livré et validé, une reprise doit être exécutée par la procédure technique autorisée, jamais improvisée pendant l'encaissement.

## Tablette perdue ou totalement hors service

Utiliser la dernière archive Samhain vérifiée disponible. Les ventes ou corrections postérieures à cette archive ne peuvent pas être recréées automatiquement : ne pas inventer d'opérations ni reconstruire la chaîne à partir d'un nombre de tickets.

Avant reprise, consigner la période potentiellement manquante et appliquer la procédure décidée avec le responsable comptable. La nouvelle tablette peut conserver l'identité uniquement si l'ancienne est considérée définitivement retirée.

Si l'ancienne tablette est retrouvée après remplacement :

1. l'éteindre ou l'isoler immédiatement ;
2. ne pas la reconnecter ni encaisser comme la caisse remplacée ;
3. ne pas exporter puis fusionner son journal avec celui de la remplaçante ;
4. avant toute réutilisation, effacer/reprovisionner la tablette de manière contrôlée avec une nouvelle identité logique.

Sans backend ni synchronisation, l'application ne peut pas détecter une ancienne tablette rangée dans un placard. L'unicité physique d'un `terminalId` dépend aussi de cette procédure.

## Nouveau terminal logique et reprovisionnement

Créer un nouveau `terminalId` lorsque la tablette devient une autre caisse logique, par exemple A vers C, ou lorsqu'un responsable choisit explicitement de repartir avec une nouvelle identité. `reprovision()` continue d'utiliser `crypto.randomUUID()` et ne réinitialise ni les ventes ni les séquences locales. Les anciennes ventes conservent leur snapshot terminal d'origine.

Le reprovisionnement :

- exige le mode responsable dans le service, pas seulement dans l'interface ;
- affiche le nom, le code et le `terminalId` actuels ;
- demande une confirmation forte avant tout changement de code ;
- annonce qu'un nouvel identifiant est créé et que les anciennes ventes restent associées à l'ancienne caisse ;
- est bloqué si une impression payée est à reprendre, incertaine, ou si cette vérification a échoué ;
- ne doit pas, à l'avenir, être autorisé si une synchronisation est en attente. Ce futur état doit rejoindre le même contrôle de préconditions.

Un renommage ne change jamais `terminalId`, `terminalCode` ou `provisionedAt` et reste possible malgré une impression en attente.

## Vérifications avant remise en service

Vérifier au minimum :

- `terminalCode` attendu ;
- `terminalId` attendu ;
- nom visible ;
- intégrité et tête du journal ;
- prochaines séquences de commande, reçu et journal ;
- absence d'impression ambiguë oubliée ;
- imprimante et permission USB correctes ;
- date, heure et fuseau corrects.

Les métadonnées restaurées (`nextOrderSequence`, `nextReceiptSequence`, `nextJournalSequence`, `lastJournalHash`) sont la source de vérité. Ne jamais les recalculer avec « nombre de commandes + 1 ».

## Mise à jour APK

Une mise à jour du même package n'est pas une réinstallation propre. Utiliser notamment :

```bash
adb install -r chemin/vers/samhain-pos.apk
```

Protocole de test avant déploiement :

1. installer la version N sur une tablette de test ;
2. provisionner et créer des données de test ;
3. noter identité, commandes, ledger et séquences ;
4. installer N+1 avec `adb install -r`, sans désinstaller ;
5. vérifier que Room a migré sans destruction et que toutes les valeurs notées sont conservées.

`fallbackToDestructiveMigration()` est interdit. Android Backup ne remplace pas les migrations Room.

## Désinstallation, effacement et installation propre

**Désinstaller l'application ou effacer ses données est destructif.** Avant toute opération sur une tablette d'exploitation : exporter puis vérifier une archive Samhain et sa copie hors tablette. Android Backup n'est pas un filet de sécurité.

Test manuel, uniquement avec des données de test :

1. provisionner une tablette de test ;
2. créer une vente de test et noter l'identité ;
3. désinstaller l'application ;
4. réinstaller l'APK ;
5. vérifier que Room ne contient aucune vente et qu'aucune identité n'est revenue ;
6. vérifier que le provisioning initial est requis.

Test D2D : configurer un appareil source de test, effectuer le transfert Android vers une cible, puis installer/ouvrir Samhain POS. Aucune identité, vente, séquence, impression ou credential ne doit apparaître sur la cible. Répéter sur les modèles OEM réellement déployés ; un build ou un test Robolectric ne valide pas le comportement de tous les fabricants.

Test cloud : sur un compte et des appareils de test, déclencher un cycle de sauvegarde/restauration Android réaliste et vérifier la même absence de données. Ne jamais exécuter ces tests en détruisant les données d'une caisse réelle.

## Heure et fuseau

Sur chaque tablette d'exploitation :

- **Date et heure automatiques** : activées ;
- **Fuseau automatique** : activé, ou fuseau explicitement réglé sur `Europe/Paris`.

Si l'horloge est incorrecte : arrêter immédiatement les nouvelles ventes sur la tablette, corriger l'heure système, contrôler les opérations déjà enregistrées, puis reprendre uniquement lorsque l'horloge est fiable. Ne pas créer de ventes antidatées pour masquer le problème. Samhain POS ne demande aucune permission privilégiée pour modifier l'heure Android.

## Lock Task / kiosque

Le manifeste déclare `android:lockTaskMode="if_whitelisted"`. C'est une capacité conditionnelle, pas la preuve que le kiosque est actif. Un vrai déploiement Lock Task nécessite une configuration Android device-owner et une allowlist adaptées. La procédure de sauvegarde/remplacement ne met pas en place de MDM.

## Fiche de contrôle incident

Avant autorisation de reprise, consigner :

```text
Archive vérifiée : oui / non
archiveHash :
terminalCode :
terminalId :
Nom visible :
nextOrderSequence :
nextReceiptSequence :
nextJournalSequence :
lastJournalHash :
Intégrité du journal : valide / invalide
Impressions à reprendre : 0 / détail
Imprimante testée : oui / non
Heure et Europe/Paris vérifiés : oui / non
Ancienne tablette isolée : oui / non / sans objet
Responsable ayant autorisé la reprise :
Date et heure de reprise :
```
