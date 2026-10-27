# Dashboard public sur le VPS

Destination demandée : **https://dashboard.samhain.arthurdubos.fr**.
Le propriétaire a explicitement choisi un accès **sans authentification**.
Toute personne pouvant joindre ce domaine pourra consulter les totaux, commandes,
articles, notes, corrections et exports exposés par le dashboard. Il n’utilise pas
Keycloak. `noindex` demande aux moteurs de ne pas indexer le site ; ce n’est pas
une restriction d’accès. Le compte MongoDB reste strictement lecteur.

Cette livraison prépare les sources et la configuration. Elle ne confirme pas
un déploiement réel, la création du compte lecteur, le DNS ou le certificat HTTPS.

## Topologie vérifiée avec les informations du VPS

- MongoDB : `samhain-mongo:27017`, base `samhain_pos`, replica set `samhain-rs`.
- Réseau MongoDB : `samhain_database` ; réseau de Caddy : `lcdd_proxy`.
- CA publique : `/opt/samhain-deploy/certificates/mongo-ca.crt`, montée en lecture seule.
- Caddyfile hôte : `/opt/les-cocottes-de-diane/proxy/Caddyfile`.
- Proxy existant : `lcdd-caddy`, ports 80/443 déjà publiés.

Le nouveau service rejoint ces deux réseaux. Aucun port supplémentaire n’est
publié sur le VPS. Le navigateur ne reçoit jamais d’URI ou de mot de passe MongoDB.
Le dashboard n’écrit pas dans les données métier et ne modifie ni l’API existante,
ni ses identités, ni les tablettes. Son déploiement est un projet Compose séparé.

## 1. Préparer les sources depuis Windows

Depuis le dépôt, sur la branche `feat/mongodb-dashboard` :

```powershell
pnpm dashboard:package
$vpsSamhain = "ADRESSE_HABITUELLE_DE_TON_VPS"
scp .tmp/samhain-dashboard-source.tar.gz "ubuntu@${vpsSamhain}:/home/ubuntu/"
```

L’archive utilise une liste explicite de sources et de lockfiles : aucun `.env`,
certificat, secret, `node_modules` ou dossier `.git`. Aucun commit/push requis.
Un port SSH personnalisé utilise `scp -P PORT ...`.

## 2. Installer les sources sur le VPS

```bash
sudo install -d -o ubuntu -g ubuntu -m 750 /opt/samhain-dashboard
tar -xzf /home/ubuntu/samhain-dashboard-source.tar.gz -C /opt/samhain-dashboard
```

Une mise à jour réextrait l’archive dans ce dossier dédié. Ne pas extraire dans
les dossiers de l’API ou des sites Cocottes.

## 3. Disposer d’un compte lecteur

Utiliser un compte dédié disposant uniquement du rôle `samhain_reader_v1` sur
`samhain_pos`. Le compte d’écriture de l’API et le compte administrateur seront
refusés par le dashboard. Le rôle lecteur est défini par la persistance existante.

Si le compte dédié n’existe pas, un administrateur MongoDB peut le créer une fois.
Ces commandes ne doivent être exécutées qu’avec les identifiants administrateurs
connus de l’exploitant. Remplacer `NOM_ADMIN` par ce nom, pas par le compte API :

```bash
docker cp /opt/samhain-dashboard/dashboard/create-reader.mongosh.js samhain-mongo:/tmp/samhain-dashboard-reader.js
docker exec -it samhain-mongo mongosh --host samhain-mongo --tls --tlsCAFile /run/certificates/mongo-ca.crt --authenticationDatabase admin --username NOM_ADMIN --password
```

Dans cette session mongosh :

```javascript
load('/tmp/samhain-dashboard-reader.js')
```

Le script demande un nouveau mot de passe sans l’afficher et crée
`samhain_dashboard` dans `samhain_pos`. Il refuse de modifier un compte existant
et refuse de continuer si le rôle lecteur n’existe pas. Il n’accorde aucun droit
à Keycloak et ne modifie aucune vente. Quitter mongosh avec `exit`.

## 4. Configurer le service

```bash
cp -n /opt/samhain-dashboard/dashboard/dashboard.env.example /opt/samhain-deploy/dashboard.env
chmod 600 /opt/samhain-deploy/dashboard.env
nano /opt/samhain-deploy/dashboard.env
```

Remplacer uniquement le mot de passe du lecteur dans `MONGODB_URI`, et le nom
d’utilisateur si un autre compte lecteur a été choisi. Encoder les caractères
spéciaux du mot de passe dans l’URI (`@` devient `%40`, `#` devient `%23`, etc.).
Ne pas réutiliser le mot de passe d’administration ou celui de l’API.
`MONGODB_DATABASE=samhain_pos` reste inchangé.

La configuration de publication est explicite dans `dashboard/compose.yaml` :
`DASHBOARD_PUBLIC=true` et
`DASHBOARD_PUBLIC_ORIGIN=https://dashboard.samhain.arthurdubos.fr`.
Le mode local reste le défaut hors de ce Compose.

## 5. Construire et démarrer le dashboard

```bash
cd /opt/samhain-dashboard
export DASHBOARD_ENV_FILE=/opt/samhain-deploy/dashboard.env
docker compose -f dashboard/compose.yaml config --quiet
docker compose -f dashboard/compose.yaml up -d --build dashboard
docker compose -f dashboard/compose.yaml logs --tail=30 dashboard
```

Attendre le message de démarrage. En cas d’échec, les logs ne révèlent pas les
identifiants ; contrôler le compte lecteur, son rôle et la lisibilité du certificat
par l’utilisateur `node` du conteneur. Docker Compose 2.24+ est requis pour
`env_file.required`. L’API et MongoDB existants ne sont pas redémarrés.

## 6. Configurer DNS et Caddy

Dans la zone DNS `arthurdubos.fr`, faire pointer l’enregistrement A de
`dashboard.samhain` vers l’IPv4 publique du VPS. S’il existe un AAAA pour ce nom,
il doit aussi pointer vers une IPv6 réellement desservie par ce VPS.

Ajouter le bloc de `dashboard/Caddyfile` avec le script fourni :

```bash
sudo sh /opt/samhain-dashboard/dashboard/install-caddy.sh
```

Le script refuse un domaine déjà présent, conserve une sauvegarde datée, ajoute
le bloc en place (sans changer l’inode monté), valide puis recharge Caddy. En cas
de validation ou rechargement refusé, il restaure le fichier d’origine. Il conserve
les autres sites. Le bloc ajouté est :

```caddyfile
dashboard.samhain.arthurdubos.fr {
    encode zstd gzip
    reverse_proxy samhain-dashboard:4310 {
        header_up Host dashboard.samhain.arthurdubos.fr
        header_up X-Forwarded-Proto https
    }
}
```

Si la validation échoue, corriger la cause avant de relancer le script. Caddy gère
le certificat et le renouvellement HTTPS lorsque le DNS et les ports 80/443
sont accessibles. Aucun port MongoDB ne doit être publié pour ce dashboard.

## 7. Vérifier depuis un navigateur extérieur

Ouvrir https://dashboard.samhain.arthurdubos.fr sans session Keycloak.
Vérifier le chargement, le festival, les filtres tablette/paiement/date et l’export.
Comparer une vente réelle reçue et son montant avec la source habituelle.
Les ventes encore hors ligne ne figurent pas dans MongoDB.

```bash
curl -sS -D - -o /dev/null https://dashboard.samhain.arthurdubos.fr/
```

Le dashboard accepte uniquement GET. Attendre HTTP 200 et un
certificat valide avec le navigateur avant de déclarer le site opérationnel.

## Charge et limites

Le mode public partage un budget global de 240 requêtes/minute (HTTP 429 au-delà).
Un seul chargement MongoDB est admis à la fois. Le dernier festival lu est conservé
en cache 15 secondes ; la date affichée correspond à la lecture de ce cache.
Changer les filtres utilise le même jeu de données pendant ces 15 secondes.
Une lecture dépassant 50 000 événements ou imports, ou 64 Mo de payloads cumulés,
échoue explicitement sans présenter de résultat partiel. Les deux collections
sont lues successivement, pas dans un snapshot transactionnel.
Le conteneur est limité à 512 Mo/1 CPU, sans privilège ni système de fichiers inscriptible
hors `/tmp`. Aucun objectif de performance réelle ou test de charge n’est revendiqué.

## Arrêter uniquement le dashboard

```bash
cd /opt/samhain-dashboard
export DASHBOARD_ENV_FILE=/opt/samhain-deploy/dashboard.env
docker compose -f dashboard/compose.yaml stop dashboard
```

Les sources, identifiants et données MongoDB sont conservés. Pour retirer le site,
retirer son bloc Caddy puis valider/recharger le proxy. Ne pas utiliser de commandes
`down -v`, de suppression MongoDB ou de migration pour installer/retirer ce lecteur.
