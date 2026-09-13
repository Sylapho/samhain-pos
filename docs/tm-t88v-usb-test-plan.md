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
