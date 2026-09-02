# Samhain POS — prototype tablette

Prototype React/TypeScript/Capacitor de caisse tactile pour le festival Samhain.

Cette version reste volontairement simple : pas de backend, pas de SQLite, pas de synchronisation réelle et pas de gestion de stock avancée.

## Personnalisation des produits

Les produits possédant une composition configurable affichent **Modifier la composition** dans le panier. La ligne ouvre une sheet tactile où les ingrédients présents sont cochés par défaut. Décocher puis valider ajoute une mention `Sans …` à la ligne et `*** SANS … ***` au ticket de préparation, sans modifier le prix ni le ticket client.

Si une ligne contient plusieurs unités, la modification s’applique à une seule unité et crée une ligne distincte. Deux configurations strictement identiques sont automatiquement regroupées.

Les variantes et groupes d’options utilisent la même fiche tactile. Chaque groupe configuré dans `src/mocks/products.ts` précise son type (`single` ou `multiple`), son caractère obligatoire et ses options par défaut. Un choix peut appliquer un supplément en centimes via `priceDeltaCents`. Le Menu Enfant et le Coca-Cola illustrent ce modèle entièrement piloté par les données.

## Prérequis

- Node.js 22 recommandé
- pnpm
- Android Studio + Android SDK pour la version tablette
- tablette Android compatible USB Host
- Epson TM-T88V alimentée normalement
- câble de données USB-C ↔ USB-B

## Tester dans le navigateur

```bash
corepack enable
pnpm install
pnpm dev
```

Puis ouvrir l'adresse Vite affichée dans le terminal.

## Tests automatisés

```bash
pnpm test:run
pnpm lint
pnpm build
```

## Tickets client et préparation

L’encaissement propose CB ou espèces et déclenche un seul job USB :

```text
ticket client → avance → coupe → ticket préparation → avance → coupe
```

Le ticket client peut être désactivé indépendamment ; le ticket de préparation reste imprimé. Après succès, les boutons de réimpression réutilisent la commande et le reçu existants.

Les données administratives de démonstration sont centralisées dans `src/config/organization.ts`. Remplacer dans ce fichier l’adresse, le SIRET, la TVA intracommunautaire et le téléphone avant production. Une build de production bloque l’impression de ces placeholders, sauf autorisation explicite réservée au mode `android-test`.

Le rendu est séparé du transport :

- `src/printing/customerReceiptRenderer.ts` et `preparationTicketRenderer.ts` produisent les aperçus et les octets ESC/POS ;
- `src/printing/orderPrintService.ts` orchestre les documents et coupes ;
- `src/printing/capacitorReceiptPrinter.ts` sélectionne l’imprimante et gère la permission ;
- le plugin Android conserve une seule connexion USB pendant tout le job.

## Test Android avec impression USB réelle

Cette branche du prototype contient une intégration Android native :

- énumération des périphériques USB ;
- sélection automatique préférentielle d'un périphérique Epson ;
- demande de permission USB Android ;
- détection d'une sortie USB BULK ;
- envoi de tickets ESC/POS structurés ;
- deux coupes successives via la commande ESC/POS `GS V 0` ;
- fallback avec séparation visuelle et log explicite si la coupe échoue.

Ce test **n'utilise pas encore Epson ePOS SDK**. Il sert uniquement à valider rapidement le câble, la tablette, les permissions Android et la communication avec la TM-T88V. Le code est isolé pour pouvoir remplacer cette implémentation par ePOS SDK plus tard.

### 1. Installer les dépendances

```bash
corepack enable
pnpm install
```

### 2. Générer le projet Android + installer le plugin USB

```bash
pnpm android:add
```

Le script :

1. crée un build Android de test où le panneau développeur reste visible ;
2. exécute `cap add android` ;
3. copie `EpsonUsbPrinterPlugin.java` dans l'application Android ;
4. enregistre le plugin dans `MainActivity` ;
5. déclare la fonctionnalité `android.hardware.usb.host` dans le manifeste.

### Important : enregistrement du plugin Capacitor

Le plugin local est enregistré **avant** `super.onCreate(savedInstanceState)` dans `MainActivity.java`. Capacitor construit le Bridge pendant `super.onCreate`, donc un enregistrement effectué après serait trop tard et provoquerait `EpsonUsbPrinter plugin is not implemented on android`.

La forme attendue est :

```java
@Override
public void onCreate(Bundle savedInstanceState) {
    registerPlugin(EpsonUsbPrinterPlugin.class);
    super.onCreate(savedInstanceState);
}
```

Si une ancienne version du projet Android est déjà générée, relancer :

```bash
pnpm android:install-usb-printer
```

puis **Build > Clean Project**, **Build > Rebuild Project** et réinstaller l'application.

### 3. Ouvrir Android Studio

```bash
pnpm android:open
```

Branche ensuite la tablette Samsung au PC avec le débogage USB activé et lance l'application avec **Run ▶**.

### 4. Brancher l'imprimante à la tablette

Une fois l'application installée sur la Samsung :

1. débranche la tablette du PC si son port USB-C est utilisé pour le débogage ;
2. branche `Samsung USB-C → Epson USB-B` ;
3. vérifie que la TM-T88V est allumée et contient du papier ;
4. ouvre **Outils de démonstration** dans l'application ;
5. dans **Imprimante USB — test réel**, appuie sur **Détecter USB** ;
6. sélectionne le périphérique Epson s'il y en a plusieurs ;
7. appuie sur **Autoriser USB** ;
8. accepte la fenêtre Android ;
9. appuie sur **Imprimer les 2 tickets** pour tester la commande réaliste complète.

Le bouton **Imprimer ticket test** conserve le test matériel historique. Le bouton **Prévisualiser sans imprimante** affiche les deux rendus et fonctionne aussi dans le navigateur en développement.

Le ticket attendu commence par :

```text
SAMHAIN
TEST IMPRESSION USB

Burger Samhain            16,00 EUR
Cafe                       1,50 EUR
------------------------------------------
TOTAL                     17,50 EUR
```

et doit finir par une coupe automatique.

Pour tester le flux réel de caisse, ajoute des articles, appuie sur **Valider la commande**, choisis CB ou espèces, garde **Imprimer le ticket client** coché, puis appuie sur **Encaisser et imprimer**.

### Synchroniser après une modification frontend

```bash
pnpm android:sync
```

`android:sync` reconstruit avec le mode `android-test`, synchronise Capacitor puis réapplique le plugin USB de façon idempotente.

### Réinstaller uniquement le plugin natif

Si `MainActivity.java` ou le manifeste Android ont été régénérés :

```bash
pnpm android:install-usb-printer
```

## Diagnostic USB

### Aucun périphérique après « Détecter USB »

Vérifier :

- câble réellement compatible données ;
- TM-T88V allumée ;
- bon port USB-B de l'imprimante ;
- USB Host/OTG supporté et actif sur la tablette ;
- absence d'un hub/adaptateur problématique.

### Epson détectée mais « Autoriser USB » échoue

Débrancher/rebrancher l'imprimante puis relancer l'application. Android accorde l'autorisation jusqu'au débranchement du périphérique.

### « Aucune sortie BULK détectée »

Le périphérique USB exposé à Android ne présente pas l'interface attendue pour ce test direct. Dans ce cas, on passera à l'intégration ePOS SDK Epson plutôt que d'ajouter des contournements au prototype.

### Ticket envoyé mais rien ne sort

Le transfert USB a été accepté par Android mais l'interface sélectionnée n'interprète peut-être pas les données ESC/POS brutes. Vérifier la configuration/interface USB de la TM-T88V ; si nécessaire, l'étape suivante est l'intégration ePOS SDK.

## Fichiers liés au test imprimante

```text
src/native/epsonUsbPrinter.ts
src/printing/orderPrintService.ts
src/printing/customerReceiptRenderer.ts
src/printing/preparationTicketRenderer.ts
src/printing/capacitorReceiptPrinter.ts
src/features/dev/UsbPrinterPanel.tsx
native/android/EpsonUsbPrinterPlugin.java
scripts/install-android-usb-printer.mjs
.env.android-test
```

Le dossier `android/` n'est pas versionné dans cette archive : il est généré localement avec `pnpm android:add` afin de rester aligné avec la version de Capacitor installée.
