# Encaissements durables

`CheckoutIntent` est l’état local durable situé entre le panier et une vente. Une intention ne
consomme aucune séquence, n’écrit aucune entrée `sale` et ne déclenche aucune impression.

## États et transitions

| État                | Signification                                                    | Transitions autorisées                    |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| `pending_payment`   | Snapshot persisté, paiement externe non commencé                 | `payment_to_verify`, `abandoned`          |
| `payment_to_verify` | Le paiement a pu être effectué; une décision humaine est requise | `payment_confirmed`, `abandoned`          |
| `payment_confirmed` | Le caissier a confirmé le paiement                               | `finalized`                               |
| `finalized`         | Une vente unique est associée à l’intention                      | aucune; `finalize` retourne la même vente |
| `abandoned`         | Paiement déclaré non effectué                                    | aucune                                    |

Le passage à `payment_to_verify` est persisté avant que l’interface demande d’utiliser le TPE ou
d’accepter définitivement les espèces. Après un redémarrage, les trois états non terminaux sont
présentés au caissier; aucune décision n’est prise automatiquement.

## Finalisation

La finalisation lit l’intention, vérifie `payment_confirmed`, alloue les séquences, puis écrit dans
une seule transaction la commande, l’état d’impression, l’entrée `sale`, les métadonnées et le lien
de finalisation de l’intention. L’identifiant stable de l’intention devient l’identifiant de la vente,
ce qui rend les répétitions et appels concurrents idempotents.

Cette transaction couvre cinq object stores dans IndexedDB et cinq tables dans Room. L’impression
ne commence qu’après son succès. Une erreur conserve donc l’intention confirmée et récupérable,
sans vente financière partielle.
