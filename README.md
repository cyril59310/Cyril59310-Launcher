<div align="center" width="100%">
<img width="256" height="256" alt="logo" src="https://github.com/user-attachments/assets/2b819c66-81f2-43be-9364-d2b544318c98" />
</div>

# Cyril59310 Launcher

Launcher Minecraft Java Edition base sur Electron, avec connexion Microsoft et gestion de plusieurs comptes.

<img width="1266" height="713" alt="image" src="https://github.com/user-attachments/assets/6b028927-6a54-4d0e-8bb6-71893eb4159a" />


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
- Mise a jour automatique du launcher depuis GitHub Releases (hors mode dev et hors build portable)
- Prend en charge les profils pour isoler les instances

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

Les mises a jour automatiques fonctionnent sur les builds installables publies sur GitHub Releases.
La version portable ne supporte pas l'installation automatique d'update.

## Mise a jour automatique

- Le launcher verifie automatiquement les mises a jour au demarrage (build package uniquement).
- Une verification manuelle est disponible depuis l'interface.
- Quand une mise a jour est telechargee, un bouton permet de redemarrer pour l'installer.

Configuration utilisee:

- provider: `github`
- owner: `Cyril59310`
- repo: `Cyril59310-Launcher`

Pense a publier les artefacts de build (`.exe`, `latest.yml`, etc.) sur GitHub Releases pour que l'update fonctionne.

Release automatique:

- Un workflow GitHub Actions est fourni: `.github/workflows/release.yml`
- Il se lance sur les tags `v*` (exemple: `v1.3.1`)
- Il build Windows NSIS et publie automatiquement les artefacts sur GitHub Releases
- Le fichier `latest.yml` est publie avec l'installateur, ce qui alimente `electron-updater`
- Pour publier une release `git tag vX.X.X` et `git push origin vX.X.X`

Les builds sont produits dans le dossier `build/`.

## Authentification Microsoft

Le launcher permet:

- d'ajouter un compte Microsoft
- de restaurer une session en relancant l'application
- de basculer entre les comptes sauvegardes
- de supprimer le compte actif

Les informations de session sont stockees localement dans:

- Windows: `%APPDATA%/.Cyril59310-Launcher/auth.json` (metadonnees de compte uniquement)

Les refresh tokens Microsoft sont stockes de facon securisee via `keytar` dans le coffre systeme
(Credential Manager Windows / Keychain macOS / Secret Service Linux).

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
