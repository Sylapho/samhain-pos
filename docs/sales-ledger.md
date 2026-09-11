# Journal d’encaissement, clôture et archivage

## Objet et statut

Cette architecture répond au besoin technique du ticket #34 : empêcher les API métier normales de réécrire une vente validée, conserver les corrections sous forme de nouvelles opérations et détecter une altération des données journalisées. Elle fonctionne entièrement dans IndexedDB et n’ajoute aucune dépendance réseau au parcours d’encaissement.

Ce document ne constitue ni une attestation de conformité ni une certification. La qualification fiscale de l’association, la procédure d’exploitation, les contrôles d’accès Android, la gestion des horloges et la version effectivement déployée doivent être audités avant une utilisation réelle. Le [BOFiP publié le 25 mars 2026](https://bofip.impots.gouv.fr/bofip/10691-PGP.html/identifiant%3DBOI-TVA-DECLA-30-10-30-20260325) et [l’article 286 du CGI](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000053546765/2026-05-18) sont les références réglementaires utilisées lors de cette conception.

## Modèle local

La base IndexedDB `samhain-pos`, version 2, sépare quatre responsabilités :

- `orders` conserve l’instantané financier d’origine : lignes, options, prix, TVA, règlement, date, terminal, numéros de commande et de reçu ;
- `orderTechnicalState` conserve uniquement l’état d’impression, qui doit pouvoir évoluer après la vente sans modifier les données financières ;
- `salesLedger` est le journal append-only des ventes, corrections et clôtures ;
- `metadata` alloue dans la même transaction les séquences de commande, de reçu et de journal, ainsi que l’empreinte de tête et la fin de la dernière période clôturée.

La création d’une vente, l’allocation de ses numéros, son instantané financier, son premier état technique et son entrée de journal sont écrits dans une seule transaction IndexedDB. Un échec annule l’ensemble. Le repository n’expose plus de méthode générique `updateOrder()` : seule `updateOrderPrinting()` peut faire évoluer les métadonnées techniques.

Les objets journalisés contiennent aussi un instantané de la version applicative, du mode de build, de l’identité du terminal et de la configuration administrative. Les identifiants de vente et d’opération sont stables et peuvent être utilisés ultérieurement par une synchronisation serveur sans changer le journal local de chaque tablette.

## Intégrité et contrôle

Chaque entrée reçoit une séquence locale monotone, l’empreinte de l’entrée précédente et une empreinte SHA-256 calculée sur une représentation JSON canonique. La vente stockée référence l’identifiant, la séquence et l’empreinte de son entrée. La vérification contrôle :

1. la continuité des séquences ;
2. le chaînage `previousHash` ;
3. l’empreinte de chaque entrée ;
4. la correspondance entre chaque vente scellée et son instantané journalisé ;
5. l’empreinte de tête et la prochaine séquence conservées dans les métadonnées.

`SalesLedgerService.verifyIntegrity()` retourne les erreurs et distingue un journal valide d’un journal complet. Une commande créée avant la version 2 reste accessible mais apparaît dans `legacyOrderIds` : elle n’est jamais présentée comme ayant été protégée rétroactivement.

Une empreinte locale permet de détecter une modification accidentelle ou une altération partielle. Elle ne protège pas, à elle seule, contre un attaquant disposant d’un accès complet à l’application et capable de réécrire toutes les données et toutes les empreintes. La tête du journal et les archives doivent donc être copiées régulièrement sur un support contrôlé hors de la tablette.

## Corrections

Une correction ne modifie jamais la vente : elle ajoute une entrée liée par `originalOrderId`, les numéros d’origine et `originalSaleHash`. Le montant est un delta comptable en centimes.

- une annulation compense exactement le total d’origine ;
- un remboursement est négatif et le cumul des remboursements ne peut pas dépasser la vente ;
- un ajustement explicite peut être positif ou négatif, mais doit être non nul ;
- un motif non vide et une clé d’opération sont obligatoires ;
- rejouer la même clé avec la même opération retourne l’entrée existante, ce qui rend la reprise idempotente ;
- réutiliser la clé pour une opération différente est refusé.

Les API existent dans `SalesLedgerService`. Aucun bouton d’annulation ou de remboursement n’est ajouté au flux caisse par ce ticket : les règles d’autorisation des opérateurs et l’UX correspondante doivent être définies avant de les exposer.

## Clôtures

`closePeriod()` ajoute une entrée de clôture contenant les bornes ISO, le nombre et le total brut des ventes, les corrections, le total net, le total net cumulatif et les totaux par moyen de paiement. Les intervalles sont demi-ouverts (`début <= date < fin`). Après une clôture, une vente ou une correction antidatée avant sa fin est refusée. La clôture suivante doit commencer exactement à la fin de la précédente.

L’horloge de la tablette reste une source de confiance. Avant exploitation, Android doit empêcher une modification non autorisée de la date et la procédure de caisse doit prévoir le traitement d’une horloge incorrecte.

## Archive, conservation et restauration

`exportArchive()` produit un objet JSON ouvert et autonome contenant : notice française, version de schéma, identifiant et date d’export, source logicielle/configuration, séquences, ventes ligne par ligne, états techniques, journal complet et empreinte globale `archiveHash`. L’export est refusé si le journal local est déjà incohérent. `verifyArchive()` fonctionne après un aller-retour JSON.

`restoreArchive()` vérifie d’abord l’empreinte globale, toute la chaîne et les ventes, puis restaure atomiquement uniquement dans une base vide. Cette restriction évite une fusion silencieuse de deux journaux. Une restauration opérationnelle doit utiliser la même identité de terminal ; la fusion de plusieurs tablettes relève de la future synchronisation.

Procédure d’exploitation proposée :

1. vérifier le journal puis clôturer à chaque fin de journée ou de service ;
2. exporter après la clôture, sans supprimer les données locales ;
3. enregistrer le JSON sous un nom contenant le terminal, la fin de période et l’identifiant d’archive ;
4. conserver au moins deux copies contrôlées, dont une hors de la tablette, et consigner l’empreinte de l’archive ;
5. vérifier immédiatement chaque copie avec `verifyArchive()` ;
6. tester périodiquement la restauration sur une base vide et consigner le résultat ;
7. conserver le présent document avec les archives afin d’expliquer le format.

Le BOFiP précise notamment que les données élémentaires, les cumuls et les preuves de traçabilité doivent être conservés, que l’archivage doit intervenir selon la périodicité choisie au maximum annuelle ou par exercice, et que le format doit rester aisément lisible avec une notice en français. Il indique également un délai de conservation de six ans pour les données et preuves concernées. La politique définitive doit être validée avec le conseil comptable/juridique de l’association. Aucune purge automatique n’est implémentée : une archive est une copie vérifiée, pas une autorisation de supprimer le journal source.

## Limites restant à lever avant production

- obtenir la certification ou l’attestation applicable à la version réellement livrée ;
- remplacer les données administratives et le catalogue de démonstration ;
- définir les rôles autorisés à corriger, clôturer, exporter et restaurer, puis journaliser leur identité ;
- fournir un écran ou outil d’exploitation pour la clôture, l’export sur support externe et la vérification ;
- durcir le terminal Android, protéger les sauvegardes et formaliser la gestion des clés/supports ;
- décider comment ancrer périodiquement l’empreinte de tête sur un support indépendant ;
- concevoir la synchronisation multi-tablettes en conservant une chaîne par terminal et sans réécrire les événements locaux ;
- faire auditer les scénarios de changement d’heure, mise à jour logicielle, perte de tablette et reprise après incident.
