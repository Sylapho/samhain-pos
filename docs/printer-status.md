# Surveillance du statut imprimante — issue #103

Le statut est une observation, jamais une autorisation d’encaisser ou une preuve d’impression.
Les ventes, paiements, données locales et reprises manuelles restent indépendants de cette surveillance.

## Fréquence et visibilité

`usePrinterStatus` vérifie au premier affichage visible, puis 60 secondes après la fin de chaque
vérification. Un unique timeout est supprimé sur `visibilitychange` lorsque le document est caché,
puis recréé après une vérification immédiate au retour. La Page Visibility API de la WebView est
le seul signal de visibilité utilisé ; aucun plugin Capacitor App supplémentaire n’est ajouté.
Le comportement de ce signal sur la tablette et sa WebView fait partie de la campagne #19.
Une sonde déjà lancée n’est pas interrompue au milieu d’une transaction USB : sa réponse est
ignorée après changement de visibilité, remplacement de sonde ou démontage.

Les contrôles manuels simultanés sont regroupés en une nouvelle vérification après la sonde active.
Une promesse partagée par fonction de sonde évite de dupliquer une requête lors des remontages
React, notamment StrictMode. Un résultat `unavailable` arrête le polling sur le web ; le bouton
Actualiser et le retour au premier plan restent utilisables.

Le résultat devient ancien à l’échéance, dès la mise en arrière-plan, au lancement d’une impression
ou lors d’une actualisation manuelle. Une observation `ready` ancienne devient « État non vérifié ».
Les défauts matériels précédents restent lisibles avec « dernier contrôle ancien ». Une sonde
ignorée pendant une impression ne remplace ni ne rajeunit l’observation matérielle. Pendant le
transfert demandé au pont, le statut visible est « Impression en cours ». Le dialogue de configuration
retire également sa certitude « connectée » après 60 secondes ou un passage en arrière-plan.

## Exclusion USB réellement utilisée

L’audit porte sur le code de `main` à `1df6f14`, Capacitor Android 8.5.0 et les sources locales :

- `Bridge.callPluginMethod` poste l’invocation sur le HandlerThread `CapacitorPlugins`.
  `PluginHandle.invoke` appelle la même instance de `EpsonUsbPrinterPlugin`.
- `getStatus`, `printJob` et `printTest` sont `@Synchronized` sur cette instance. Ces méthodes
  exécutent directement ouverture, revendication, lecture/écriture et libération. Elles ne
  détachent aucun transfert sur un autre thread et ne gardent aucune connexion après retour.
- Les appels `resolve`/`reject` Capacitor ne libèrent pas le moniteur Kotlin. Le bloc `finally`
  libère l’interface revendiquée puis ferme la connexion avant la sortie de la méthode.
- La boucle de documents, les écritures segmentées de `writeUsbBuffer` et la séparation de secours
  après échec de coupe restent dans ce même moniteur. Aucun document ambigu n’est rejoué par
  la surveillance. Les erreurs de transport arrêtent la boucle d’écriture.
- `getDevices` énumère les descripteurs, permissions et interfaces ; cette méthode n’ouvre aucune
  connexion et ne revendique aucune interface. La demande de permission Android ne détient pas
  de connexion USB pendant l’attente de sa réponse.

Ces protections natives suffisent à l’exclusion des transferts : aucun mutex natif supplémentaire
ni changement de Kotlin ou de fichiers Android générés n’est nécessaire.

Le pont `src/native/epsonUsbPrinter.ts` ajoute uniquement la priorité et la déduplication :

1. `printJob` et `printTest` annoncent synchroniquement une impression en attente.
2. Les nouvelles sondes sont ignorées avec `USB_PRINTER_BUSY`, traduit en état temporaire
   `printing`, sans appel natif. Cela vaut aussi pour le dialogue de configuration et les diagnostics.
3. Une lecture déjà engagée se termine avant l’appel natif d’impression. Elle est bornée dans le
   pilote par le timeout d’écriture de 4 s et la fenêtre de lecture de 1,5 s. Elle n’est jamais annulée
   brutalement. Il n’y a pas de boucle de relance des sondes.
4. Des lectures simultanées du même appareil partagent leur promesse. Une demande pour un autre
   appareil pendant cette lecture est ignorée, sans nouvelle revendication.
5. Le compteur d’impressions et la lecture partagée sont libérés en `finally`, même après erreur.
   Les impressions restent sérialisées par le pilote existant, sans nouvelle file TypeScript.

Les tests du pont simulent les promesses Capacitor pour vérifier cet ordre et la libération de
la coordination. Ils ne prouvent ni le transfert USB réel ni la sortie papier. Les scénarios
matériels sont dans [la campagne Epson](tm-t88v-usb-test-plan.md#surveillance-du-statut--issue-103).
