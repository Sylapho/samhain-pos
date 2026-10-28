# Campagne matérielle Epson TM-T88V — transport USB

Cette procédure valide sur le matériel de production les comportements qui ne peuvent pas être
prouvés par les tests unitaires. Utiliser une tablette Android identique à celle du festival, une
Epson TM-T88V, le câble et l’alimentation prévus en production. Ne pas utiliser de ventes réelles.

## Préparation

1. Installer une build Android de test explicitement identifiée.
2. Vérifier que la build utilise bien la version native synchronisée par
   `pnpm android:install-native`.
3. Charger un panier de test dont les deux tickets sont assez longs pour laisser le temps de retirer
   le câble pendant le transfert. N’ajouter aucun mode « ticket long » à une build de production.
4. Pour chaque scénario, noter le numéro de commande, l’état des deux documents avant et après le
   test, les tickets réellement sortis et le message affiché.

## Scénarios

### Impression normale

1. Brancher l’imprimante, fermer le capot et charger le papier.
2. Imprimer le ticket client et le ticket de préparation.
3. Vérifier que les deux tickets et leurs coupes sont complets.
4. Vérifier que les deux documents sont `printed` et que la commande n’est plus récupérable.

### Débranchement avant transfert

1. Débrancher l’USB avant de lancer l’impression.
2. Lancer l’impression.
3. Vérifier qu’aucun papier ne sort, que le document concerné est `failed` et qu’une reprise
   contrôlée est proposée.

### Débranchement pendant un document long

1. Lancer l’impression du document long.
2. Retirer le câble dès que le papier commence à sortir.
3. Vérifier que le document est `unknown` / « à vérifier avant réimpression ».
4. Vérifier qu’aucune action automatique ne réimprime ce document.

### Papier absent et capot ouvert

1. Retirer le papier, puis lancer une impression. Vérifier le message « plus de papier » et
   l’absence de transfert du document.
2. Remettre le papier, ouvrir le capot, puis relancer. Vérifier le message « capot ouvert » et
   l’absence de transfert du document.
3. Fermer le capot et vérifier qu’une reprise manuelle imprime seulement les documents `failed`.

### Ticket client réussi, panne sur préparation

1. Imprimer les deux documents et provoquer la panne après la fin du ticket client, avant le premier
   octet de la préparation.
2. Vérifier `customerReceipt = printed` et `preparationTicket = failed`.
3. Reprendre l’impression et vérifier que seule la préparation est imprimée.
4. Recommencer en retirant le câble pendant la préparation.
5. Vérifier `customerReceipt = printed` et `preparationTicket = unknown`, sans réimpression
   automatique d’aucun des deux documents.

### Reconnexion et redémarrage

1. Après avoir obtenu un document `unknown`, fermer complètement l’application ou redémarrer la
   tablette.
2. Rebrancher l’imprimante et rouvrir la commande.
3. Vérifier que l’état `unknown` est toujours affiché et que le bouton normal de reprise ne lance
   rien automatiquement.
4. Comparer le papier déjà sorti, puis utiliser explicitement le bouton du seul ticket à réimprimer
   si l’opérateur décide qu’il est nécessaire.

### Coupe

1. Provoquer si possible une panne du cutter après le transfert complet d’un document.
2. Vérifier que le document reste `printed` et que le message demande une séparation manuelle ou
   signale la séparation visuelle de secours.

## Critères de validation

- Aucun document partiellement transmis n’est reclassé `failed`.
- Aucun document `unknown` n’est réimprimé automatiquement, y compris après redémarrage.
- Un document terminé avant une panne ultérieure reste `printed`.
- Une panne avant le premier octet reste récupérable comme `failed`.
- Après chaque scénario, une nouvelle impression normale fonctionne, ce qui confirme la libération
  de l’interface et la fermeture de la connexion USB.

## Campagne Supabase/USB #117 (complément #19)

**Statut : non exécutée.** Ce protocole complète la campagne quatre caisses #19 ;
les tests automatiques Room/transport simulé ne prouvent pas la sortie du papier.
Utiliser un projet Supabase hébergé de test isolé, une tablette réelle et une Epson
TM-T88V USB alimentée, avec papier et configuration légale de test identifiée.
Préparer les identifiants de chaîne/installation, les diagnostics responsable et
une archive vérifiée hors appareil. Ne pas collecter les JWT, codes ou clés.

1. Noter les états et compteurs initiaux, les têtes locale/serveur et le nombre de
   documents demandés. Garder les paramètres habituels reçu/retrait/préparation.
2. Couper Internet **avant** l'ouverture de l'app ; vendre et imprimer trois ventes
   identifiées, avec leurs numéros d'origine. Vérifier Room/historique, état payé,
   outbox pending et compter chaque document réellement sorti.
3. Rétablir Internet, demander une relance et observer le drain. Vérifier chaque
   tuple ID/séquence/hash/fingerprint et le reçu ; aucun papier supplémentaire.
4. Accumuler un nouveau lot hors ligne. Rétablir puis couper le réseau pendant
   l'envoi ; si la fenêtre n'est pas atteinte, noter « injection non obtenue » et
   recommencer avec un lot plus long, sans déclarer le cas exécuté.
5. Pendant que le drain échoue/attend, effectuer une nouvelle vente et imprimer.
   La vente, le paiement et l'USB doivent réussir localement sans attendre un ACK.
6. Rétablir le réseau ; attendre les ACK conformes, relancer deux fois, fermer et
   rouvrir l'app. Vérifier file persistante, mêmes reçus, aucun nouveau paiement,
   aucune renumérotation et aucun document supplémentaire.
7. Répéter avec session expirée/révocation depuis le projet test. Vérifier la pause
   Auth et une nouvelle vente/impression locale. Ne pas réenrôler pour masquer une
   erreur : suivre le runbook et conserver l'ancienne identité dans les preuves.
8. Pendant un autre essai, provoquer une impression partielle (`unknown`) puis une
   reprise réseau. Le document reste à vérifier manuellement, sans réimpression
   automatique. Compter le papier incomplet séparément des tickets terminés.
9. Tester reboot, force-stop, réouverture et, sur chaque modèle déployé, délai
   WorkManager/Doze et Keystore. Ne pas supposer un délai maximum de reprise.
10. Exporter/vérifier l'archive finale. Rapprocher ventes/ledger/serveur par ID/hash,
    et documents demandés/sorties papier par commande et type. Tout écart bloque
    le GO de cette fonction jusqu'au diagnostic.

### Rapport matériel à compléter

| Champ                                                                   | Valeur réelle à renseigner |
| ----------------------------------------------------------------------- | -------------------------- |
| Date, début/fin, fuseau, opérateur                                      | Non exécuté                |
| Modèle/identifiant tablette, Android/API, restrictions batterie         | À renseigner               |
| Epson, firmware, USB/câble/alimentation, papier                         | À renseigner               |
| APK versionName/versionCode, signature, commit et modifications locales | À renseigner               |
| Projet test, chaîne/installation/génération (sans secrets)              | À renseigner               |
| État initial, archiveId/archiveHash et support hors tablette            | À renseigner               |

| Étape / panne réellement obtenue   | Commande / documents demandés | Paiement/Room/ledger | Outbox et tête avant→après | ACK ID/hash/fingerprint/reçu | Papier client/retrait/préparation, dont incomplets | Reprise manuelle / écart / verdict |
| ---------------------------------- | ----------------------------- | -------------------- | -------------------------- | ---------------------------- | -------------------------------------------------- | ---------------------------------- |
| À compléter pour chaque étape 1–10 | —                             | —                    | —                          | —                            | —                                                  | Non exécuté                        |

Conclusion à signer : incidents et divergences, critères non obtenus, archive
finale vérifiée, décision GO/NO-GO et version concernée. Une case vide n'est pas
une réussite. Voir [runbook](supabase-deployment-runbook.md) et
[matrice de preuves](supabase-integration-validation.md).

## Surveillance du statut — issue #103

Scénarios à exécuter pour #19, sur la tablette et sa WebView réelles. Cette liste est une procédure,
pas un compte rendu de tests exécutés. Noter version APK/WebView, horaires et observations.
Voir [le mécanisme de surveillance et de coordination](printer-status.md).

1. Au lancement visible : vérifier le premier contrôle, puis une actualisation à 60 secondes,
   sans sondes à trois secondes. Sur navigateur web : aucun polling USB répété.
2. Débrancher/rebrancher l’imprimante ; vérifier « Non détectée », puis « Connectée » au contrôle
   suivant ou après Actualiser, sans bloquer la saisie ni le paiement d’une vente de test.
3. Ouvrir/fermer le capot et retirer/remettre le papier. Vérifier les libellés correspondants, puis
   leur disparition uniquement après une nouvelle observation matérielle.
4. Laisser l’application en arrière-plan au moins trois minutes, écran éteint puis dans une autre
   application. Contrôler avec instrumentation/debugger que le timeout est supprimé et qu’aucun
   appel natif `getStatus` supplémentaire n’est demandé. Au retour, vérifier le contrôle immédiat
   et l’absence de statut « Connectée » issu seulement de l’ancienne observation. Répéter ces cycles.
5. Imprimer plusieurs commandes successives. Faire coïncider un transfert long avec l’échéance
   du contrôle, puis avec Actualiser et le retour au premier plan. Observer « Impression en cours »
   et vérifier qu’aucune sonde ne revendique l’interface entre les documents ou leurs coupes.
6. Provoquer une déconnexion, un manque de papier ou un capot ouvert pendant ces essais. Vérifier
   l’absence d’interruption causée par une sonde, les résultats partiels/ambigus conservés et
   l’absence de réimpression automatique. Reprendre uniquement par les actions manuelles existantes.
7. Après erreur, vérifier qu’une nouvelle observation et une impression normale sont possibles,
   confirmant la libération des ressources. Laisser une observation vieillir au-delà de 60 secondes
   avec une sonde impossible : aucune certitude « prête » ne doit subsister, y compris en configuration.

Pour chaque étape, relever les documents demandés/sortis, les états persistés, l’absence de double
revendication USB et les messages affichés. Tout écart nécessite un diagnostic avant validation #19.
