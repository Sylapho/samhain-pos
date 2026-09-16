# Release Android de production

Ce runbook produit l'APK destiné aux caisses du festival. Les commandes sont prévues pour PowerShell sous Windows et doivent être exécutées depuis la racine du dépôt, sauf indication contraire.

## 1. Prérequis

- Node.js 22 et pnpm 10 via Corepack ;
- JDK 21 ;
- Android SDK avec Platform Tools (`adb`) et Build Tools (`apksigner`) ;
- le keystore de production Samhain et ses credentials ;
- un accès physique à la tablette pour la validation finale.

Vérifier les outils sans afficher de secret :

```powershell
node --version
pnpm --version
& "$env:JAVA_HOME\bin\java.exe" -version
adb version
```

Le wrapper Gradle 8.14.3 du projet doit être lancé avec JDK 21. Si Android Studio utilise un autre JDK, définir `JAVA_HOME` pour le terminal courant avant les commandes Gradle.

## 2. Version de la release

La première release festival est définie ainsi dans `android/app/build.gradle` :

```text
versionCode 1
versionName 1.0.0
applicationId fr.samhain.pos
```

`package.json` porte également la version `1.0.0`.

Pour toute APK distribuée ultérieurement :

1. augmenter `versionCode` d'au moins 1 ;
2. mettre à jour `versionName` selon SemVer (`1.0.1`, `1.1.0`, etc.) ;
3. reporter le même `versionName` dans `package.json` ;
4. conserver `applicationId` et la même clé de signature.

Android refuse normalement une mise à jour dont le `versionCode` n'est pas strictement supérieur à celui déjà installé.

## 3. Créer le keystore une seule fois

Choisir un répertoire sécurisé hors du dépôt, par exemple un volume chiffré et sauvegardé. Ne pas créer le keystore sous `android/` ni dans un dossier synchronisé publiquement.

La commande suivante demande les mots de passe de façon interactive :

```powershell
$keystore = 'D:\Samhain-secrets\samhain-pos-release.jks'
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v `
  -keystore $keystore `
  -alias 'samhain-pos' `
  -keyalg RSA `
  -keysize 3072 `
  -validity 10000
```

Conserver dans le gestionnaire de secrets de l'association :

- le fichier `.jks` ;
- son mot de passe ;
- l'alias de clé ;
- le mot de passe de clé ;
- l'empreinte du certificat donnée par `keytool -list -v`.

Créer au moins une sauvegarde chiffrée séparée et tester sa restauration. **Une APK mise à jour doit normalement être signée avec la même clé que la version déjà installée.** La perte de cette clé empêche les mises à jour normales de l'application.

Les extensions de keystore et `keystore.properties` sont ignorées à la racine et dans le projet Android. Cette protection ne remplace pas le stockage hors dépôt.

## 4. Configurer la signature dans PowerShell

Gradle lit les quatre valeurs suivantes, d'abord dans les propriétés Gradle de l'utilisateur puis dans les variables d'environnement :

```text
SAMHAIN_RELEASE_STORE_FILE
SAMHAIN_RELEASE_STORE_PASSWORD
SAMHAIN_RELEASE_KEY_ALIAS
SAMHAIN_RELEASE_KEY_PASSWORD
```

Configuration recommandée pour la session PowerShell courante :

```powershell
$env:SAMHAIN_RELEASE_STORE_FILE = 'D:\Samhain-secrets\samhain-pos-release.jks'
$env:SAMHAIN_RELEASE_KEY_ALIAS = 'samhain-pos'

$storePassword = Read-Host 'Mot de passe du keystore' -AsSecureString
$keyPassword = Read-Host 'Mot de passe de la clé' -AsSecureString
$env:SAMHAIN_RELEASE_STORE_PASSWORD = [Net.NetworkCredential]::new('', $storePassword).Password
$env:SAMHAIN_RELEASE_KEY_PASSWORD = [Net.NetworkCredential]::new('', $keyPassword).Password
```

Ne pas écrire ces valeurs dans `android/gradle.properties`, dans un script versionné, dans `.env`, dans la ligne de commande ou dans un ticket GitHub. Pour une configuration persistante locale, le fichier utilisateur `$env:USERPROFILE\.gradle\gradle.properties` est accepté, mais il contient alors les mots de passe en clair et doit être protégé par les permissions du compte et le chiffrement du disque.

La tâche `validateReleaseSigning` bloque `assembleRelease` et `bundleRelease` si une valeur manque ou si le keystore est introuvable. Le build `release` utilise exclusivement `signingConfigs.release` : aucun fallback vers la signature debug n'existe.

## 5. Vérifications et build reproductible

Depuis la racine du dépôt :

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm test:run
pnpm lint
pnpm build:android:production
pnpm android:sync:production
```

`android:sync:production` reconstruit aussi le web avant la synchronisation. La commande `build:android:production` séparée est conservée dans la checklist pour détecter au plus tôt une configuration commerciale ou administrative invalide.

Les garde-fous de production bloquent notamment :

- `usesDemoPlaceholders: true` ;
- une information administrative vide, un placeholder connu ou un identifiant invalide ;
- un produit ou une variante marqué `dataConfidence: 'temporary'` ;
- l'activation du panneau de développement en mode `production`.

Générer ensuite l'APK :

```powershell
Push-Location android
.\gradlew.bat testReleaseUnitTest assembleRelease
Pop-Location
```

Chemin de sortie exact :

```text
android\app\build\outputs\apk\release\app-release.apk
```

Ne distribuer ni un fichier sous `debug/`, ni un APK issu du mode Vite `android-test`.

## 6. Vérifier la signature et l'identité de l'APK

Trouver `apksigner` sans supposer la version des Build Tools :

```powershell
$androidSdk = if ($env:ANDROID_SDK_ROOT) {
  $env:ANDROID_SDK_ROOT
} elseif ($env:ANDROID_HOME) {
  $env:ANDROID_HOME
} else {
  throw 'Définissez ANDROID_SDK_ROOT ou ANDROID_HOME.'
}

$apksigner = Get-ChildItem -Path (Join-Path $androidSdk 'build-tools\*\apksigner.bat') |
  Sort-Object FullName -Descending |
  Select-Object -First 1

if (-not $apksigner) { throw 'apksigner.bat est introuvable dans les Android Build Tools.' }

$apk = Resolve-Path 'android\app\build\outputs\apk\release\app-release.apk'
& $apksigner.FullName verify --verbose --print-certs $apk
if ($LASTEXITCODE -ne 0) { throw 'La vérification de signature a échoué.' }
```

Le résultat doit annoncer une vérification réussie et afficher l'empreinte du certificat de production sauvegardée lors de la création du keystore. Une empreinte différente signifie que ce n'est pas la bonne clé et que l'APK ne doit pas être distribuée.

Après installation, vérifier la version déclarée :

```powershell
adb shell dumpsys package fr.samhain.pos | Select-String 'versionCode|versionName'
```

## 7. Installation sur une tablette neuve

Activer les options développeur et le débogage USB, connecter la tablette au PC, accepter son empreinte RSA, puis :

```powershell
$apk = Resolve-Path 'android\app\build\outputs\apk\release\app-release.apk'
adb devices
adb install $apk
adb shell monkey -p fr.samhain.pos -c android.intent.category.LAUNCHER 1
```

`adb devices` doit afficher exactement la tablette ciblée avec l'état `device`. Si plusieurs appareils sont listés, ajouter `-s <serial>` à chaque commande ADB.

## 8. Mise à jour sans perte de données Room

Avant la mise à jour, créer et vérifier une archive métier Samhain selon `docs/tablet-replacement-and-backup.md`. Ne jamais désinstaller l'application et ne jamais utiliser « Effacer les données ».

Avec la même clé de signature, le même `applicationId` et un `versionCode` supérieur :

```powershell
$apk = Resolve-Path 'android\app\build\outputs\apk\release\app-release.apk'
adb devices
adb install -r $apk
adb shell monkey -p fr.samhain.pos -c android.intent.category.LAUNCHER 1
```

L'option `-r` remplace l'APK en conservant les données de l'application. La base reste `samhain-pos-room.db`. Le projet enregistre explicitement ses migrations Room et n'utilise pas `fallbackToDestructiveMigration()`.

Test physique minimal :

1. sur l'ancienne version, créer une commande de test autorisée et noter son numéro, son reçu et son état d'impression ;
2. vérifier qu'elle apparaît dans l'historique, puis créer une archive métier vérifiée ;
3. exécuter `adb install -r` sans désinstaller l'application ;
4. relancer Samhain POS et vérifier la même caisse, la commande, le reçu et l'état d'impression ;
5. créer une nouvelle commande et vérifier que les séquences continuent sans doublon ;
6. redémarrer complètement la tablette et refaire la vérification.

Les tests JVM couvrent la fermeture/réouverture de la base et la migration Room 1 vers 2, mais ils ne remplacent pas ce test sur la tablette cible.

## 9. Validation fonctionnelle avant distribution

Sur chaque modèle de tablette réellement utilisé :

- confirmer que le panneau « Outils de démonstration » n'est pas présent ;
- provisionner la caisse correcte et vérifier son code terminal ;
- encaisser une commande CB et une commande espèces ;
- vérifier l'historique et la reprise après redémarrage ;
- accorder la permission USB à l'Epson ;
- imprimer le ticket client et le ticket de préparation ;
- tester une imprimante débranchée, sans papier et après un échec partiel ;
- vérifier qu'une vente enregistrée reste conservée malgré l'échec d'impression.

## 10. Échec et rollback

Si le build ou la signature échoue, ne distribuer aucun APK et conserver la version déjà installée.

Si une mise à jour installée présente un problème :

1. ne pas désinstaller l'application et ne pas effacer ses données ;
2. arrêter l'encaissement sur la tablette concernée ;
3. créer une archive métier vérifiée si l'application reste utilisable ;
4. corriger le problème et produire une nouvelle APK avec un `versionCode` supérieur, le même `applicationId` et la même clé ;
5. l'installer avec `adb install -r` puis refaire le test de persistance.

Un downgrade avec `adb install -r -d` n'est pas la procédure normale : une ancienne application peut ne pas comprendre un schéma Room plus récent. Ne l'utiliser qu'après validation explicite de la compatibilité de la base et avec une archive vérifiée disponible.

## 11. Secrets et artefacts interdits dans Git

Avant toute release :

```powershell
git status --short
git ls-files '*.jks' '*.keystore' 'keystore.properties'
git grep -n -I -E 'SAMHAIN_RELEASE_(STORE_PASSWORD|KEY_PASSWORD)\s*[=:]\s*.+$'
```

La deuxième commande ne doit lister aucun fichier. La troisième ne doit trouver aucune valeur réelle. Les noms de variables et la documentation sont normaux ; un mot de passe ou un chemin privé versionné ne le serait pas.
