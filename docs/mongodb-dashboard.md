# Dashboard de pilotage MongoDB

Application web en ligne, distincte des tablettes, dédiée à **un seul festival de
quatre jours**. Trois vues : **Vue d’ensemble**, **Analyse des ventes** et **Suivi
des caisses**. Aucune écriture métier, connexion Supabase, persistance navigateur,
fonction de clôture ou gestion de fond de caisse. Le checkout, les paiements,
l’impression et le fonctionnement hors ligne Android ne sont pas modifiés.

## Configuration et démarrage

Prérequis : Node.js 24, pnpm, dépendances de la racine et de `server/`.

```powershell
pnpm install
pnpm --dir server install
Copy-Item server/dashboard.env.example server/.env.dashboard
notepad server/.env.dashboard
```

Configurer les valeurs réelles ; aucune identité, date ou cible financière de
production n’est inventée :

| Variable                        | Contrat                                                              |
| ------------------------------- | -------------------------------------------------------------------- |
| `MONGODB_URI`                   | Connexion d’un compte strictement lecteur, TLS validé                |
| `MONGODB_DATABASE`              | Base contenant les ventes                                            |
| `DASHBOARD_ORGANIZATION_ID`     | UUID d’organisation utilisé par l’API, obligatoire                   |
| `DASHBOARD_FESTIVAL_ID`         | UUID du festival utilisé par l’API, obligatoire                      |
| `DASHBOARD_FESTIVAL_START_DATE` | Jeudi réel au format `YYYY-MM-DD`, obligatoire                       |
| `DASHBOARD_REFRESH_SECONDS`     | 60 par défaut ; entier entre 15 et 3600                              |
| `DASHBOARD_STALE_MINUTES`       | 10 par défaut ; seuil d’avertissement de réception/ancienneté        |
| `DASHBOARD_DAILY_GOAL_CENTS`    | Objectif journalier brut, entier positif en centimes ; vide = absent |
| `DASHBOARD_FESTIVAL_GOAL_CENTS` | Objectif global brut, entier positif en centimes ; vide = absent     |
| `DASHBOARD_PORT`                | 4310 par défaut                                                      |

La configuration est validée au démarrage, y compris l’existence du périmètre
dans `festivals`. Le navigateur ne reçoit pas les UUID d’organisation/festival
et ne peut pas les remplacer : les paramètres correspondants sont rejetés.
L’ancienne route de découverte `/api/scopes` est supprimée.

```powershell
pnpm dashboard
```

Ouvrir http://127.0.0.1:4310. Ce démarrage est un serveur de consultation web sur
l’ordinateur, pas un mode offline du dashboard. Aucune donnée n’est écrite dans
IndexedDB, localStorage ou un service worker. Le mode public utilise le
[guide Docker/Caddy](mongodb-dashboard-hosting.md). Après compilation,
`pnpm dashboard:start` suffit.

Le compte `samhain_reader_v1` existant permet les lectures nécessaires. Aucun rôle,
utilisateur, index, migration ou document financier n’est créé par le serveur.
Les comptes d’administration/d’écriture sont refusés. Les connexions distantes
exigent TLS et ses vérifications ; seule une base de test locale `samhain_test_*`
peut utiliser l’exception de développement existante.

## Périodes et navigation

Les raccourcis Jeudi, Vendredi, Samedi et Dimanche correspondent au jeudi configuré
et aux trois jours suivants. « Toute la période » couvre ces quatre dates.
Aujourd’hui et Hier utilisent les jours civils de **Europe/Paris**, indépendamment
du fuseau du navigateur ou du VPS. L’intervalle personnalisé est inclusif.
Par défaut : aujourd’hui s’il appartient au festival, sinon les quatre jours.

Le serveur compare les jours locaux dérivés des dates UTC immuables. Les dates
source ne sont pas réécrites. Les passages été/hiver sont traités par `Intl` :
les deux occurrences d’une heure répétée sont cumulées dans son bucket horaire.
Une heure inexistante au printemps a zéro événement, pas un événement fabriqué.
Les 24 créneaux affichés constituent une grille de lecture, pas 24 heures UTC.

Les filtres actifs sont communs aux trois vues. Tout changement réinitialise les
pages commandes/corrections et annule la requête navigateur précédente. Les
résultats d’un autre filtre ne s’affichent pas sous le nouveau filtre. Les dates
personnalisées en cours de saisie ne deviennent actives qu’après validation.
Les intervalles sont limités techniquement à 366 jours pour borner les graphiques.

## Indicateurs et comparaisons

- Commandes : ventes payées dans la sélection, avant corrections.
- Brut : somme des totaux des snapshots, en centimes entiers sûrs.
- Corrections : somme **signée**, à leur date d’enregistrement.
- Net : brut + corrections de cette période ; ce n’est pas le solde final des
  seules commandes affichées. Un retour d’une vente antérieure peut rendre un net négatif.
- Panier moyen : brut / commandes, arrondi au centime pour l’affichage.
- Articles et articles moyens : quantités brutes avant retours.
- Paiements : espèces et carte uniquement ; parts en nombre de commandes.

La comparaison par défaut est la période civile précédente de même durée. Une
journée de référence peut être choisie parmi les quatre dates. Les écarts absolus
et pourcentages concernent brut, commandes, panier moyen et articles. Sans donnée
de référence, ou avec un dénominateur nul, le pourcentage est **Indisponible**.
Les deux périodes gardent les mêmes filtres commerciaux.

Les objectifs sont des valeurs de configuration, sans écriture MongoDB. Ils
mesurent le **brut de toutes les caisses**, sans filtres produit/paiement/recherche.
L’objectif journalier s’affiche pour une sélection d’un jour ; l’objectif festival
couvre toujours les quatre journées. Le pourcentage peut dépasser 100 % ; le
montant restant est alors zéro.

## Produits, choix et catégories

Les produits sont regroupés par `productId` historique. Deux IDs de même nom ne
sont pas fusionnés. Les noms rencontrés restent consultables et le dernier nom
de la sélection sert de libellé ; aucun catalogue actuel ne remplace l’historique.
Tri quantité/brut/nom, recherche, pages 25/50/tous, sélection de plusieurs IDs.
Les IDs opaques contenant des virgules sont transmis en tableau JSON, pas en CSV.

Le filtre de produits sélectionne les **commandes complètes** contenant au moins
un produit choisi : les KPI conservent le total du panier. Le tableau produit et
les choix sont limités aux IDs choisis. La recherche « statistiques produits » ne
change que ces tableaux/exports de statistiques, pas les KPI de commandes.

Les refunds structurés utilisent `refundLines`. Une annulation complète utilise
les lignes originales. Les montants/quantités ne sont jamais répartis arbitrairement.
Une correction non attribuable rend le net des produits concernés indisponible ;
si la vente d’origine manque, tous les produits sélectionnés sont potentiellement
concernés. Les montants globaux restent calculables depuis les corrections signées.
Les corrections d’une vente antérieure peuvent créer une quantité nette négative
dans la période de retour : c’est un flux, pas un stock.

Variantes, options et ingrédients retirés sont regroupés par produit et identifiants
historiques (option inclut son groupe). Les choix sont pondérés par la quantité de
la ligne. Les suppléments sont identifiés par leur delta positif, sans ajouter leur
prix une seconde fois au total final déjà enregistré dans les lignes.

**Catégories indisponibles :** le snapshot scellé actuel n’enregistre pas l’appartenance
historique. Aucun rattachement au catalogue actuel n’est effectué. L’interface et
l’export catégories expliquent cette absence plutôt que produire une fausse analyse.

## TVA

Taux et prix viennent exclusivement des lignes immuables. La règle d’arrondi est
celle de `src/utils/vat.ts` : TVA incluse arrondie par ligne (`TTC × taux / (100+taux)`),
reproduite côté serveur avec arithmétique entière pour éviter les débordements.
Les refunds structurés utilisent leur ventilation conservée après vérification
avec la ligne originale ; les annulations complètes inversent les lignes d’origine.

Les corrections anciennes sans détail rendent la ventilation nette par taux et
son total indisponibles. Le brut TTC/HT/TVA reste visible. Les centimes sont cumulés
exactement, sans utiliser les prix ni taux du catalogue actuel. Cette consultation
ne constitue aucune certification comptable et n’implémente aucune clôture.

## Tablettes, commandes et synchronisation

Les tablettes sont regroupées par `sourceTerminalId` observé dans les ventes et
corrections. Ce n’est pas un inventaire des installations. Chaque fiche affiche
commandes, articles, brut/net, panier et paiements de la sélection.

La dernière vente reçue et la dernière réception de `syncReceipts` sont distinctes.
`chains` apporte seulement la séquence de tête ; un écart de lecture avec les reçus
est un **avertissement à recontrôler**, pas la preuve d’une perte (lectures successives).
Aucune collection d’authentification ni `installations` n’est lue. Aucune clé, sujet
OIDC, session, signature ou jeton n’est envoyé à l’interface.

Un délai sans vente déclenche un avertissement de réception, jamais un statut
« hors ligne ». Le nombre d’événements locaux en attente est **Indisponible**.
Une tablette peut fonctionner et vendre hors réseau sans que ce dashboard le sache.

L’historique recherche numéro/reçu/nom de produit, tablette, paiement, date et
présence de corrections. Les détails comprennent lignes/options/variantes/retraits/
notes, réception et corrections associées. Le montant corrigé d’une commande
inclut toutes les corrections connues, même hors de la sélection. Commandes et
corrections ont chacune une pagination serveur indépendante de 50 résultats.

## Actualisation et exports

Actualisation par défaut à 60 s, modifiable dans la page ou suspendue manuellement.
Les onglets cachés ne font pas de lectures périodiques ; la reprise réactualise.
Une seule requête navigateur active ; les réponses obsolètes sont ignorées.
Une erreur de rafraîchissement conserve les dernières valeurs du **même** filtre,
avec message explicite et date de lecture. Elle n’est jamais remplacée par zéro.
Un nouveau filtre n’affiche pas les chiffres de l’ancien.

Huit exports : commandes, lignes vendues, produits, catégories, tablettes,
corrections, journées et TVA. Ils portent sur tous les résultats filtrés, pas la
page courante. UTF-8 BOM, point-virgule, montants en euros à deux décimales, dates
UTC et/ou Europe/Paris explicites, cellules neutralisées contre les formules.
Les commandes exportent aussi le montant après toutes corrections connues.
Les lignes respectent la sélection produit ; les exports produits respectent la
recherche statistique. Une synthèse TVA incomplète exporte « Indisponible » pour
les champs nets inconnus. Les lignes CSV sont produites en flux, sans construire
un second fichier complet en mémoire.

## Performance, périmètre et preuves

Un cache serveur unique du jeu normalisé dure 15 s et est partagé par tous les
filtres. Les requêtes concurrentes partagent le même chargement MongoDB. La date
de lecture affichée est celle de ce cache. Les dates/horaires locaux sont calculés
une fois par événement ; buckets jour/heure et agrégats utilisent des passes en mémoire.

Les lectures MongoDB imposent systématiquement le périmètre et projettent les
seuls champs utiles. Une agrégation MongoDB par kind vérifie les volumes ; une
agrégation de reçus extrait la dernière réception/séquence par chaîne. Les calculs
financiers restent en TypeScript : le payload financier est une chaîne canonique,
non une projection BSON. Le parser strict, les cents sûrs et la logique historique
de remboursement ne sont pas remplacés par des conversions monétaires MongoDB.

Les longues listes sont filtrées/triées/paginées côté serveur sur ce cache borné,
pas via `skip/limit` d’une projection financière qui n’existe pas dans la base.
Aucun index n’est créé. Les index existants préfixés organisation/festival sont
réutilisables ; un nouveau modèle de projection devra être étudié explicitement
pour dépasser la limite actuelle : 50 000 ventes/corrections, 50 000 imports,
64 Mo de payloads cumulés, 1 000 chaînes. Au-delà : erreur, aucun total partiel.
Les lectures `majority` successives ne forment pas un snapshot transactionnel.

Les tests utilisent uniquement des données fictives/substituts de lecture. Les
résultats de test locaux ne prouvent ni accès à la production, ni charge réelle,
ni déploiement Docker/Caddy, ni synchronisation d’une tablette physique.
