# Cyril59310 Launcher

Launcher Minecraft Java Edition base sur Electron, avec connexion Microsoft et gestion de plusieurs comptes.

## Fonctionnalites

- Connexion Microsoft (OAuth) via `msmc`
- Gestion de plusieurs comptes Microsoft
- Selection du compte actif depuis l'interface
- Recuperation automatique des versions `release` et `snapshot` Minecraft officielles
- Lancement du jeu via `minecraft-launcher-core`
- Choix de la RAM max (4 Go, 8 Go, 16 Go)
- Option pour desactiver la console Java (`javaw`)
- Option pour fermer le launcher au demarrage du jeu
- Bouton pour ouvrir le dossier du jeu
- Téléchargement automatique de la bonne version de Java

## Stack technique

- Electron
- minecraft-launcher-core
- msmc
- electron-builder

## Prerequis

- Node.js 18+ (recommande: LTS recente)
- npm
- Java installe et accessible dans le `PATH`
  - Le launcher utilise `java` ou `javaw` selon l'option choisie

## Installation

```bash
npm install
```

## Lancer en developpement

```bash
npm start
```

## Scripts disponibles

- `npm start` : demarre l'application Electron
- `npm run build` : genere un installateur Windows (NSIS)
- `npm run build:portable` : genere une version portable Windows

Les builds sont produits dans le dossier `build/`.

## Authentification Microsoft

Le launcher permet:

- d'ajouter un compte Microsoft
- de restaurer une session en relancant l'application
- de basculer entre les comptes sauvegardes
- de supprimer le compte actif

Les informations de session sont stockees localement dans:

- Windows: `%APPDATA%/.Cyril59310-Launcher/auth.json`

## Donnees Minecraft

Le repertoire de travail Minecraft est:

- Windows: `%APPDATA%/.Cyril59310-Launcher`

C'est dans ce dossier que seront telecharges les fichiers du jeu.

## Structure du projet

```text
src/
  main.js                 # Process principal Electron
  preload.js              # Bridge securise IPC
  renderer/
    index.html            # Interface
    renderer.js           # Logique UI
    styles.css            # Styles
```

## Packaging Windows

La configuration `electron-builder` est definie dans `package.json`:

- `appId`: `fr.cyril.cyril59310-launcher`
- `productName`: `Cyril59310 Launcher`
- cible: `nsis` et `portable`
- icone: `src/renderer/assets/logo.png`

## Depannage rapide

- Si le launcher n'ouvre pas Minecraft, verifier Java dans le `PATH`
- Si la liste des versions ne charge pas, verifier la connexion reseau
- Si la session Microsoft expire, reconnecter le compte depuis l'interface

## Licence

MIT
