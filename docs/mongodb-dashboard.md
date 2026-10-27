# Tableau de bord MongoDB

Outil local de consultation des ventes reçues : nombre de ventes, brut, corrections,
net, panier moyen, paiements, activité quotidienne, tablettes, produits, détail des
commandes et export CSV. Il est indépendant de la caisse Android et de l’ingestion.

Pour le domaine public `dashboard.samhain.arthurdubos.fr`, suivre le
[guide Docker/Caddy](mongodb-dashboard-hosting.md). Ce mode sans authentification
est explicitement demandé par le propriétaire ; le mode local reste le défaut.

## Démarrer sous Windows

Prérequis : Node.js 24 et pnpm. Depuis la racine du dépôt :

```powershell
pnpm install
pnpm --dir server install
Copy-Item server/dashboard.env.example server/.env.dashboard
notepad server/.env.dashboard
```

Renseigner `MONGODB_URI` avec la chaîne de connexion du compte **en lecture seule**,
et `MONGODB_DATABASE` avec le nom de la base. Le rôle existant `samhain_reader_v1`
convient. Les comptes administrateurs et d’écriture de l’API sont refusés.
Le dashboard ne crée ni utilisateur, ni rôle, ni collection et ne migre rien.
Les secrets restent dans le processus Node, jamais dans le navigateur.

```powershell
pnpm dashboard
```

Ouvrir [le tableau de bord local](http://127.0.0.1:4310).
Laisser le terminal ouvert ; `Ctrl+C` arrête le service.
Après une première compilation, `pnpm dashboard:start` suffit ; reconstruire avec
`pnpm dashboard:build` après modification de l’interface. Si le port est occupé,
changer `DASHBOARD_PORT` et ouvrir le port correspondant.

Les connexions distantes exigent TLS avec validation complète des certificats.
Le service écoute uniquement `127.0.0.1`, refuse les origines tierces et exige
un en-tête de même origine pour lire l’API. Il est destiné à un ordinateur de
confiance : ce mode local n’a pas de connexion utilisateur. Pour un hébergement
Internet, utiliser exclusivement la configuration publique dédiée. L’exception sans TLS et
sans compte concerne uniquement une base `samhain_test_*` locale.

## Utilisation

1. Choisir le festival. Le schéma ne comporte pas de nom métier de festival :
   les identifiants réels de festival et d’organisation sont affichés.
2. Choisir des dates inclusives à l’heure de Paris, une tablette, un paiement,
   ou rechercher un numéro de commande/reçu, puis cliquer sur **Afficher**.
3. **Voir les ventes** isole une tablette. **Tout voir** réinitialise les filtres.
4. Ouvrir une commande pour voir les articles, options, ingrédients retirés et notes.
5. **Exporter les ventes (CSV)** exporte toutes les ventes filtrées, au-delà de la
   page courante, avec séparateur point-virgule et BOM UTF-8 pour Excel.
6. **Actualiser les données** relit MongoDB. Aucun rafraîchissement automatique.

## Signification des chiffres

- Les ventes scellées viennent de `ledgerEvents.kind=sale` : leur réservation
  dans `sales` n’est jamais comptée deux fois. Les `sales.type=legacy` ajoutent
  les imports historiques réels.
- Les ventes sont filtrées par date de paiement et les corrections par leur
  date d’enregistrement. Une correction peut concerner une vente antérieure.
  Le net représente les flux de la période, pas le solde des seules commandes affichées.
- Brut = somme des ventes ; corrections = somme signée des remboursements,
  annulations et ajustements ; net = brut + corrections. Panier moyen = brut / ventes,
  arrondi au centime pour l’affichage.
- Tablettes regroupées par `sourceTerminalId` avec leur nom historique. Ce n’est
  pas un inventaire des installations ni un contrôle de présence. La dernière
  réception concerne les ventes scellées connues, tous filtres confondus.
  Elle est indisponible pour les imports historiques.
- Produits regroupés par nom historique, quantités brutes avant retours.
- Le CSV exporte les ventes brutes ; les corrections restent dans leur section.
  Les champs susceptibles d’être des formules sont neutralisés ; les dates CSV
  sont explicitement en UTC.
- Les données temporaires restent temporaires. Ce dashboard n’est pas une
  validation comptable ni un contrôle cryptographique du journal.

**Des ventes locales peuvent être encore absentes de MongoDB.** Un total à zéro
ne prouve pas l’absence de ventes sur les appareils. Cette vue ne connaît pas
le nombre réel de ventes encore en attente sur les tablettes.

## Limites

Au plus 50 000 événements vente/correction et 50 000 imports par festival, dans un
budget commun de 64 Mo de payloads, sont lus par requête. Au-delà, un message explicite remplace les chiffres : aucun total
partiel. Une volumétrie supérieure nécessite une agrégation dédiée. Les lectures
sont bornées et utilisent `majority`. Les deux collections sont lues successivement :
ce n’est pas un snapshot transactionnel et un import concurrent peut n’apparaître
qu’au prochain rafraîchissement. Une donnée illisible fait échouer la lecture entière.

Les tests utilisent des données fictives et un substitut de lecture MongoDB.
La connexion réelle avec le compte lecteur reste à vérifier sur l’ordinateur
d’exploitation. Aucun déploiement ni accès réel n’est nécessaire pour compiler.
