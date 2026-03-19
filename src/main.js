const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const keytar = require('keytar');

let mainWindow;
let isLaunching = false;
let microsoftAuth = null;
let microsoftProfile = null;
let microsoftAccountId = null;
let updaterConfigured = false;

const launcherRoot = () => path.join(app.getPath('appData'), '.Cyril59310-Launcher');
const authStorePath = () => path.join(launcherRoot(), 'auth.json');
const profilesStorePath = () => path.join(launcherRoot(), 'profiles.json');
const runtimesRoot = () => path.join(launcherRoot(), 'runtime');
const modloadersRoot = () => path.join(launcherRoot(), 'modloaders');
const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META_BASE_URL = 'https://meta.fabricmc.net/v2';
const FORGE_MAVEN_METADATA_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const NEOFORGE_MAVEN_METADATA_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const JAVA_API_BASE = 'https://api.adoptium.net/v3/binary/latest';
const KEYTAR_SERVICE = 'Cyril59310-Launcher';

app.setName('Cyril59310-launcher');
app.setAppUserModelId('fr.cyril.cyril59310-launcher');
process.title = 'Cyril59310-launcher';

function createDefaultAuthStore() {
  return {
    activeAccountId: null,
    accounts: []
  };
}

function ensureLauncherRoot() {
  fs.mkdirSync(launcherRoot(), { recursive: true });
}

function defaultInstancesRoot() {
  return path.join(launcherRoot(), 'instances');
}

function defaultGameDirectory() {
  return path.join(defaultInstancesRoot(), 'default');
}

function createProfileId() {
  return `profile-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function sanitizeProfileName(name) {
  const raw = typeof name === 'string' ? name.trim() : '';
  if (!raw) {
    return 'Nouveau profil';
  }

  return raw.slice(0, 48);
}

function normalizeGameDirectoryPath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return '';
  }

  return path.normalize(path.resolve(raw));
}

function createDefaultProfilesStore() {
  return {
    activeProfileId: 'default',
    profiles: [{
      id: 'default',
      name: 'Profil par défaut',
      version: '',
      modloader: 'vanilla',
      modloaderVersion: '',
      gameDirectory: defaultGameDirectory()
    }]
  };
}

function normalizeProfilesStore(store) {
  const fallback = createDefaultProfilesStore();

  const profiles = Array.isArray(store && store.profiles)
    ? store.profiles
      .filter((entry) => entry && typeof entry.id === 'string' && entry.id.trim())
      .map((entry) => ({
        id: String(entry.id).trim(),
        name: sanitizeProfileName(entry.name),
        version: typeof entry.version === 'string' ? entry.version.trim() : '',
        modloader: normalizeModloader(entry.modloader),
        modloaderVersion: typeof entry.modloaderVersion === 'string' ? entry.modloaderVersion.trim() : '',
        gameDirectory: normalizeGameDirectoryPath(entry.gameDirectory) || defaultGameDirectory()
      }))
    : [];

  const safeProfiles = profiles.length ? profiles : fallback.profiles;
  const hasActive = safeProfiles.some((entry) => entry.id === store?.activeProfileId);

  return {
    activeProfileId: hasActive ? store.activeProfileId : safeProfiles[0].id,
    profiles: safeProfiles
  };
}

function readProfilesStore() {
  try {
    if (!fs.existsSync(profilesStorePath())) {
      return createDefaultProfilesStore();
    }

    const raw = fs.readFileSync(profilesStorePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return normalizeProfilesStore(parsed);
  } catch {
    return createDefaultProfilesStore();
  }
}

function writeProfilesStore(store) {
  ensureLauncherRoot();
  const normalized = normalizeProfilesStore(store);
  fs.writeFileSync(profilesStorePath(), JSON.stringify(normalized, null, 2), 'utf-8');
}

function ensureProfileDirectory(gameDirectory) {
  if (!gameDirectory) {
    return;
  }

  fs.mkdirSync(gameDirectory, { recursive: true });
}

function isDangerousDeletePath(directoryPath) {
  const normalized = normalizeGameDirectoryPath(directoryPath);
  if (!normalized) {
    return true;
  }

  const parsed = path.parse(normalized);
  if (normalized === parsed.root) {
    return true;
  }

  const protectedRoots = [
    normalizeGameDirectoryPath(launcherRoot()),
    normalizeGameDirectoryPath(app.getPath('appData'))
  ].filter(Boolean);

  return protectedRoots.includes(normalized);
}

function publicProfiles(store) {
  return store.profiles.map((entry) => ({
    id: entry.id,
    name: entry.name,
    version: entry.version,
    modloader: entry.modloader,
    modloaderVersion: entry.modloaderVersion,
    gameDirectory: entry.gameDirectory
  }));
}

function profilesResponse(store, ok = true, message = 'OK') {
  return {
    ok,
    message,
    activeProfileId: store.activeProfileId,
    profiles: publicProfiles(store)
  };
}

function ensureRuntimesRoot() {
  ensureLauncherRoot();
  fs.mkdirSync(runtimesRoot(), { recursive: true });
}

function ensureModloadersRoot() {
  ensureLauncherRoot();
  fs.mkdirSync(modloadersRoot(), { recursive: true });
}

function getJavaMajorForVersion(version, versionType) {
  if (typeof version !== 'string' || !version.trim()) {
    return 17;
  }

  if (versionType === 'snapshot') {
    const snapshotYearMatch = version.trim().match(/^(\d{2})w\d{2}[a-z]$/i);
    if (snapshotYearMatch) {
      const yy = Number(snapshotYearMatch[1]);
      if (Number.isFinite(yy) && yy >= 24) {
        return 21;
      }
      return 17;
    }

    return 17;
  }

  const releaseMatch = version.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!releaseMatch) {
    return 17;
  }

  const major = Number(releaseMatch[1]);
  const minor = Number(releaseMatch[2]);
  const patch = releaseMatch[3] ? Number(releaseMatch[3]) : 0;

  if (major < 1) {
    return 8;
  }

  if (major === 1) {
    if (minor <= 16) {
      return 8;
    }
    if (minor <= 20) {
      if (minor === 20 && patch >= 5) {
        return 21;
      }
      return 17;
    }
    return 21;
  }

  return 21;
}

function getJavaBinaryRelativePath(useWindowlessBinary) {
  if (process.platform === 'win32') {
    return useWindowlessBinary ? path.join('bin', 'javaw.exe') : path.join('bin', 'java.exe');
  }

  return path.join('bin', 'java');
}

function getPortableJavaApiUrls(javaMajor) {
  if (process.platform !== 'win32') {
    return [];
  }

  return [
    `${JAVA_API_BASE}/${javaMajor}/ga/windows/x64/jre/hotspot/normal/eclipse?project=jdk`,
    `${JAVA_API_BASE}/${javaMajor}/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk`
  ];
}

function downloadFile(url, destination, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);

    const request = https.get(url, (response) => {
      const statusCode = Number(response.statusCode || 0);

      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        file.close(() => {
          try {
            fs.unlinkSync(destination);
          } catch {
          }

          if (redirectCount >= 5) {
            reject(new Error('Trop de redirections pendant le téléchargement Java.'));
            return;
          }

          downloadFile(response.headers.location, destination, redirectCount + 1)
            .then(resolve)
            .catch(reject);
        });
        response.resume();
        return;
      }

      if (statusCode !== 200) {
        file.close(() => {
          try {
            fs.unlinkSync(destination);
          } catch {
          }
          reject(new Error(`Téléchargement Java échoué (HTTP ${statusCode}).`));
        });
        response.resume();
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    });

    request.on('error', (error) => {
      file.close(() => {
        try {
          fs.unlinkSync(destination);
        } catch {
        }
        reject(error);
      });
    });

    file.on('error', (error) => {
      file.close(() => {
        try {
          fs.unlinkSync(destination);
        } catch {
        }
        reject(error);
      });
    });
  });
}

function escapePowerShellString(value) {
  return String(value).replace(/'/g, "''");
}

function extractZipWithPowerShell(zipPath, outputDir) {
  return new Promise((resolve, reject) => {
    const script = `Expand-Archive -Path '${escapePowerShellString(zipPath)}' -DestinationPath '${escapePowerShellString(outputDir)}' -Force`;
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `Extraction ZIP impossible (code ${code}).`));
    });
  });
}

function findJavaBinary(baseDir, useWindowlessBinary) {
  const preferred = getJavaBinaryRelativePath(useWindowlessBinary);
  const fallback = getJavaBinaryRelativePath(false);
  const maxDepth = 5;

  function walk(currentDir, depth) {
    const preferredCandidate = path.join(currentDir, preferred);
    if (fs.existsSync(preferredCandidate)) {
      return preferredCandidate;
    }

    const fallbackCandidate = path.join(currentDir, fallback);
    if (fs.existsSync(fallbackCandidate)) {
      return fallbackCandidate;
    }

    if (depth >= maxDepth) {
      return null;
    }

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const found = walk(path.join(currentDir, entry.name), depth + 1);
      if (found) {
        return found;
      }
    }

    return null;
  }

  return walk(baseDir, 0);
}

function readJavaMajorFromBinary(javaPath) {
  if (typeof javaPath !== 'string' || !javaPath.trim()) {
    return null;
  }

  try {
    const result = spawnSync(javaPath, ['-version'], {
      windowsHide: true,
      encoding: 'utf-8'
    });

    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const match = output.match(/version\s+"(\d+)(?:\.(\d+))?/i);
    if (!match) {
      return null;
    }

    const first = Number(match[1]);
    const second = match[2] ? Number(match[2]) : null;
    if (!Number.isFinite(first)) {
      return null;
    }

    if (first === 1 && Number.isFinite(second)) {
      return second;
    }

    return first;
  } catch {
    return null;
  }
}

async function ensurePortableJavaForVersion(version, versionType, hideConsole) {
  const javaMajor = await resolveRequiredJavaMajor(version, versionType);

  if (process.platform !== 'win32') {
    return {
      javaPath: hideConsole ? 'javaw' : 'java',
      javaMajor,
      source: 'system'
    };
  }

  ensureRuntimesRoot();

  const runtimeDir = path.join(runtimesRoot(), `java-${javaMajor}`);
  fs.mkdirSync(runtimeDir, { recursive: true });

  const existingJava = findJavaBinary(runtimeDir, hideConsole);
  if (existingJava) {
    const existingJavaMajor = readJavaMajorFromBinary(existingJava);
    if (Number.isFinite(existingJavaMajor) && existingJavaMajor < javaMajor) {
      try {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
      } catch {
      }
      fs.mkdirSync(runtimeDir, { recursive: true });
    } else {
      return {
        javaPath: existingJava,
        javaMajor,
        source: 'portable-cache'
      };
    }
  }

  const refreshedJava = findJavaBinary(runtimeDir, hideConsole);
  if (refreshedJava) {
    return {
      javaPath: refreshedJava,
      javaMajor,
      source: 'portable-cache'
    };
  }

  const downloadUrls = getPortableJavaApiUrls(javaMajor);
  if (!downloadUrls.length) {
    return {
      javaPath: hideConsole ? 'javaw' : 'java',
      javaMajor,
      source: 'system-fallback'
    };
  }

  const tempZip = path.join(runtimeDir, `java-${javaMajor}.zip`);
  const tempExtract = path.join(runtimeDir, 'tmp-extract');
  let downloaded = false;
  let lastDownloadError = null;

  for (const downloadUrl of downloadUrls) {
    try {
      if (fs.existsSync(tempExtract)) {
        fs.rmSync(tempExtract, { recursive: true, force: true });
      }
      fs.mkdirSync(tempExtract, { recursive: true });

      await downloadFile(downloadUrl, tempZip);
      await extractZipWithPowerShell(tempZip, tempExtract);

      const extractedEntries = fs.readdirSync(tempExtract, { withFileTypes: true });
      for (const entry of extractedEntries) {
        const sourcePath = path.join(tempExtract, entry.name);
        const destinationPath = path.join(runtimeDir, entry.name);
        if (fs.existsSync(destinationPath)) {
          fs.rmSync(destinationPath, { recursive: true, force: true });
        }
        fs.renameSync(sourcePath, destinationPath);
      }

      downloaded = true;
      break;
    } catch (error) {
      lastDownloadError = error;
    } finally {
      try {
        if (fs.existsSync(tempZip)) {
          fs.unlinkSync(tempZip);
        }
      } catch {
      }

      try {
        if (fs.existsSync(tempExtract)) {
          fs.rmSync(tempExtract, { recursive: true, force: true });
        }
      } catch {
      }
    }
  }

  if (!downloaded) {
    throw new Error(lastDownloadError && lastDownloadError.message
      ? lastDownloadError.message
      : `Impossible de télécharger Java ${javaMajor}.`);
  }

  const javaPath = findJavaBinary(runtimeDir, hideConsole);
  if (!javaPath) {
    throw new Error(`Java portable introuvable après extraction (Java ${javaMajor}).`);
  }

  const detectedMajor = readJavaMajorFromBinary(javaPath);
  if (Number.isFinite(detectedMajor) && detectedMajor < javaMajor) {
    throw new Error(`Runtime Java portable invalide: version ${detectedMajor} détectée, Java ${javaMajor} requis.`);
  }

  return {
    javaPath,
    javaMajor,
    source: 'portable-download'
  };
}

function normalizeUserProperties(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    try {
      return JSON.stringify(raw);
    } catch {
      return '{}';
    }
  }

  if (typeof raw === 'string') {
    let value = raw.trim();

    if (!value) {
      return '{}';
    }

    for (let i = 0; i < 2; i += 1) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return JSON.stringify(parsed);
        }
        if (typeof parsed === 'string') {
          value = parsed.trim();
          continue;
        }
      } catch {
      }
      break;
    }

    if (value.startsWith('{') && value.endsWith('}')) {
      return value;
    }
  }

  return '{}';
}

function normalizeAuthorizationForLaunch(auth) {
  if (!auth || typeof auth !== 'object') {
    return auth;
  }

  return {
    ...auth,
    user_properties: normalizeUserProperties(auth.user_properties)
  };
}

async function resolveRequiredJavaMajor(version, versionType) {
  const fallback = getJavaMajorForVersion(version, versionType);

  try {
    const manifest = await fetchJson(VERSION_MANIFEST_URL);
    const versions = Array.isArray(manifest.versions) ? manifest.versions : [];
    const selected = versions.find((entry) => (
      entry
      && typeof entry.id === 'string'
      && entry.id === version
      && typeof entry.url === 'string'
    ));

    if (!selected) {
      return fallback;
    }

    const versionDetails = await fetchJson(selected.url);
    const majorVersion = Number(versionDetails && versionDetails.javaVersion && versionDetails.javaVersion.majorVersion);
    if (Number.isFinite(majorVersion) && majorVersion >= 8) {
      return majorVersion;
    }

    return fallback;
  } catch {
    return fallback;
  }
}

function sendLog(line) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('launcher:log', line);
  }
}

function sendUpdateEvent(type, payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('launcher:update', { type, ...payload });
  }
}

function isPortablePackage() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}

function setupAutoUpdater() {
  if (updaterConfigured) {
    return;
  }

  updaterConfigured = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    sendUpdateEvent('checking');
    sendLog('[update] Vérification des mises à jour...');
  });

  autoUpdater.on('update-available', (info) => {
    sendUpdateEvent('available', { version: info && info.version ? String(info.version) : null });
    sendLog(`[update] Mise à jour disponible${info && info.version ? `: ${info.version}` : ''}. Téléchargement...`);
  });

  autoUpdater.on('update-not-available', () => {
    sendUpdateEvent('none');
    sendLog('[update] Aucune mise à jour disponible.');
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateEvent('download-progress', {
      percent: Number(progress && progress.percent ? progress.percent : 0)
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateEvent('downloaded', { version: info && info.version ? String(info.version) : null });
    sendLog('[update] Mise à jour téléchargée. Clique sur "Installer la mise à jour" pour redémarrer.');
  });

  autoUpdater.on('error', (error) => {
    const message = error && error.message ? error.message : String(error);
    sendUpdateEvent('error', { message });
    sendLog(`[update] Erreur mise à jour: ${message}`);
  });
}

async function checkForLauncherUpdates(isManual = false) {
  if (!app.isPackaged) {
    return { ok: false, message: 'Mise à jour indisponible en mode développement.' };
  }

  if (isPortablePackage()) {
    return { ok: false, message: 'Mise à jour automatique indisponible pour la version portable.' };
  }

  try {
    await autoUpdater.checkForUpdates();
    return { ok: true, message: isManual ? 'Vérification des mises à jour lancée.' : 'OK' };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { ok: false, message: `Vérification impossible: ${message}` };
  }
}

function readAuthStore() {
  try {
    if (!fs.existsSync(authStorePath())) {
      return createDefaultAuthStore();
    }

    const raw = fs.readFileSync(authStorePath(), 'utf-8');
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed.accounts)) {
      const accounts = parsed.accounts
        .filter((account) => account && (account.id || account.uuid || account.name))
        .map((account) => ({
          id: String(account.id || account.uuid || `account-${Date.now()}-${Math.random().toString(16).slice(2)}`),
          name: String(account.name || 'Compte Microsoft'),
          uuid: String(account.uuid || ''),
          legacyRefreshToken: typeof account.refreshToken === 'string' ? String(account.refreshToken) : null
        }));

      const activeAccountId = typeof parsed.activeAccountId === 'string'
        ? parsed.activeAccountId
        : (accounts[0] ? accounts[0].id : null);

      return { activeAccountId, accounts };
    }

    if (typeof parsed.refreshToken === 'string') {
      return {
        activeAccountId: 'legacy',
        accounts: [{
          id: 'legacy',
          name: 'Compte Microsoft',
          uuid: '',
          legacyRefreshToken: String(parsed.refreshToken)
        }]
      };
    }

    return createDefaultAuthStore();
  } catch {
    return createDefaultAuthStore();
  }
}

function writeAuthStore(store) {
  ensureLauncherRoot();
  const normalizedStore = {
    activeAccountId: typeof store.activeAccountId === 'string' ? store.activeAccountId : null,
    accounts: Array.isArray(store.accounts)
      ? store.accounts.map((account) => ({
        id: String(account.id || ''),
        name: String(account.name || 'Compte Microsoft'),
        uuid: String(account.uuid || '')
      })).filter((account) => account.id)
      : []
  };

  fs.writeFileSync(authStorePath(), JSON.stringify(normalizedStore, null, 2), 'utf-8');
}

function keytarAccountKey(accountId) {
  return `microsoft:${accountId}`;
}

async function readRefreshTokenSecure(accountId) {
  if (!accountId) {
    return null;
  }

  return keytar.getPassword(KEYTAR_SERVICE, keytarAccountKey(accountId));
}

async function writeRefreshTokenSecure(accountId, refreshToken) {
  if (!accountId || typeof refreshToken !== 'string' || !refreshToken) {
    return;
  }

  await keytar.setPassword(KEYTAR_SERVICE, keytarAccountKey(accountId), refreshToken);
}

async function deleteRefreshTokenSecure(accountId) {
  if (!accountId) {
    return;
  }

  await keytar.deletePassword(KEYTAR_SERVICE, keytarAccountKey(accountId));
}

async function migrateLegacyRefreshTokens(store) {
  if (!store || !Array.isArray(store.accounts) || !store.accounts.length) {
    return store;
  }

  let changed = false;

  for (const account of store.accounts) {
    if (!account || typeof account.id !== 'string') {
      continue;
    }

    if (typeof account.legacyRefreshToken === 'string' && account.legacyRefreshToken) {
      const existing = await readRefreshTokenSecure(account.id);
      if (!existing) {
        await writeRefreshTokenSecure(account.id, account.legacyRefreshToken);
      }

      delete account.legacyRefreshToken;
      changed = true;
    }
  }

  if (changed) {
    writeAuthStore(store);
  }

  return store;
}

function publicAccounts(store) {
  return store.accounts.map((account) => ({
    id: account.id,
    name: account.name,
    uuid: account.uuid
  }));
}

function accountResponse(store, ok, message) {
  return {
    ok,
    message,
    profile: microsoftProfile,
    activeAccountId: store.activeAccountId,
    accounts: publicAccounts(store)
  };
}

async function refreshAccountFromToken(refreshToken) {
  const authManager = new Auth('select_account');
  const xboxManager = await authManager.refresh(refreshToken);
  const token = await xboxManager.getMinecraft();
  return {
    token,
    refreshToken: xboxManager.save()
  };
}

function applyMicrosoftToken(accountId, token) {
  microsoftAuth = token.mclc();
  microsoftProfile = {
    name: token.profile?.name || microsoftAuth.name,
    id: token.profile?.id || microsoftAuth.uuid
  };
  microsoftAccountId = accountId;
}

function resetMicrosoftSession() {
  microsoftAuth = null;
  microsoftProfile = null;
  microsoftAccountId = null;
}

async function activateAccount(accountId) {
  const store = await migrateLegacyRefreshTokens(readAuthStore());
  const account = store.accounts.find((entry) => entry.id === accountId);

  if (!account) {
    throw new Error('Compte introuvable.');
  }

  const currentRefreshToken = await readRefreshTokenSecure(account.id);
  if (!currentRefreshToken) {
    throw new Error('Token Microsoft introuvable dans le coffre système. Reconnecte ton compte.');
  }

  const refreshed = await refreshAccountFromToken(currentRefreshToken);
  applyMicrosoftToken(account.id, refreshed.token);

  await writeRefreshTokenSecure(account.id, refreshed.refreshToken);
  account.name = microsoftProfile.name;
  account.uuid = microsoftProfile.id;
  store.activeAccountId = account.id;
  writeAuthStore(store);

  return store;
}

function clearSavedSession() {
  try {
    if (fs.existsSync(authStorePath())) {
      fs.unlinkSync(authStorePath());
    }
  } catch {
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        response.resume();
        return;
      }

      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('Réponse JSON invalide.'));
        }
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        response.resume();
        return;
      }

      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        resolve(raw);
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

function parseMavenMetadataVersions(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText) {
    return [];
  }

  const matches = [...xmlText.matchAll(/<version>([^<]+)<\/version>/g)];
  return matches
    .map((entry) => (entry && entry[1] ? String(entry[1]).trim() : ''))
    .filter(Boolean);
}

function normalizeModloader(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['fabric', 'forge', 'neoforge'].includes(raw)) {
    return raw;
  }
  return 'vanilla';
}

function getInstallerJavaPath(javaPath) {
  if (typeof javaPath !== 'string') {
    return 'java';
  }

  if (process.platform === 'win32' && javaPath.toLowerCase().endsWith('javaw.exe')) {
    const cliCandidate = javaPath.slice(0, -9) + 'java.exe';
    if (fs.existsSync(cliCandidate)) {
      return cliCandidate;
    }
  }

  return javaPath;
}

function runJavaProcess(javaPath, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, {
      cwd,
      windowsHide: true
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
      reject(new Error(details || `Processus Java terminé avec le code ${code}.`));
    });
  });
}

function sortVersionsDescending(values) {
  return [...values].sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
}

async function getFabricLoaderVersions(minecraftVersion) {
  if (!minecraftVersion) {
    return [];
  }

  const endpoint = `${FABRIC_META_BASE_URL}/versions/loader/${encodeURIComponent(minecraftVersion)}`;
  const raw = await fetchJson(endpoint);
  const versions = Array.isArray(raw)
    ? raw.map((entry) => (entry && entry.loader && typeof entry.loader.version === 'string' ? entry.loader.version : null)).filter(Boolean)
    : [];
  return sortVersionsDescending([...new Set(versions)]);
}

async function getForgeVersionsForMinecraft(minecraftVersion) {
  if (!minecraftVersion) {
    return [];
  }

  const xml = await fetchText(FORGE_MAVEN_METADATA_URL);
  const all = parseMavenMetadataVersions(xml);
  const prefix = `${minecraftVersion}-`;
  const filtered = all
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length))
    .filter(Boolean);
  return sortVersionsDescending([...new Set(filtered)]);
}

async function getNeoForgeVersionsForMinecraft(minecraftVersion) {
  const xml = await fetchText(NEOFORGE_MAVEN_METADATA_URL);
  const all = parseMavenMetadataVersions(xml);

  const match = typeof minecraftVersion === 'string'
    ? minecraftVersion.match(/^1\.(\d+)(?:\.(\d+))?$/)
    : null;

  if (!match) {
    return sortVersionsDescending([...new Set(all)]).slice(0, 120);
  }

  const minor = Number(match[1]);
  const patch = Number(match[2] || 0);
  const strictPrefix = `${minor}.${patch}.`;

  // When patch is explicitly known (example: 1.20.1), only accept matching NeoForge branch (20.1.x).
  const selected = all.filter((entry) => entry.startsWith(strictPrefix));
  return sortVersionsDescending([...new Set(selected)]).slice(0, 120);
}

function findInstalledCustomVersionId(rootDir, matcher, options = {}) {
  const requireJar = Boolean(options && options.requireJar);
  const validateJson = Boolean(options && options.validateJson);
  const versionsDir = path.join(rootDir, 'versions');
  if (!fs.existsSync(versionsDir)) {
    return null;
  }

  const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const id = entry.name;
    if (!matcher(id)) {
      continue;
    }

    const jsonPath = path.join(versionsDir, id, `${id}.json`);
    const jarPath = path.join(versionsDir, id, `${id}.jar`);
    const hasJson = fs.existsSync(jsonPath);
    const hasJar = fs.existsSync(jarPath);

    if (hasJson && validateJson) {
      try {
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
          continue;
        }
        const metadataLooksValid = typeof parsed.id === 'string' && parsed.id.trim();
        if (!metadataLooksValid) {
          continue;
        }
      } catch {
        continue;
      }
    }

    if (hasJson && (!requireJar || hasJar)) {
      return id;
    }
  }

  return null;
}

function removeInstalledCustomVersions(rootDir, matcher) {
  const versionsDir = path.join(rootDir, 'versions');
  if (!fs.existsSync(versionsDir)) {
    return;
  }

  const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const id = entry.name;
    if (!matcher(id)) {
      continue;
    }

    const targetDir = path.join(versionsDir, id);
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
    } catch {
    }
  }
}

function ensureLauncherProfilesFile(rootDir) {
  const launcherProfilesPath = path.join(rootDir, 'launcher_profiles.json');
  if (fs.existsSync(launcherProfilesPath)) {
    return;
  }

  const placeholder = {
    profiles: {},
    settings: {},
    version: 2
  };

  fs.writeFileSync(launcherProfilesPath, JSON.stringify(placeholder, null, 2), 'utf-8');
}

async function ensureFabricInstalled(rootDir, minecraftVersion, requestedLoaderVersion) {
  const versions = await getFabricLoaderVersions(minecraftVersion);
  if (!versions.length) {
    throw new Error('Aucune version Fabric disponible pour cette version Minecraft.');
  }

  const resolvedLoaderVersion = requestedLoaderVersion && versions.includes(requestedLoaderVersion)
    ? requestedLoaderVersion
    : versions[0];
  const profileJson = await fetchJson(`${FABRIC_META_BASE_URL}/versions/loader/${encodeURIComponent(minecraftVersion)}/${encodeURIComponent(resolvedLoaderVersion)}/profile/json`);
  const customVersion = typeof profileJson.id === 'string' && profileJson.id
    ? profileJson.id
    : `fabric-loader-${resolvedLoaderVersion}-${minecraftVersion}`;

  const targetDir = path.join(rootDir, 'versions', customVersion);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, `${customVersion}.json`), JSON.stringify(profileJson, null, 2), 'utf-8');

  return { customVersion, loaderVersion: resolvedLoaderVersion };
}

async function ensureForgeInstalled(javaPath, rootDir, minecraftVersion, requestedLoaderVersion) {
  const versions = await getForgeVersionsForMinecraft(minecraftVersion);
  if (!versions.length) {
    throw new Error('Aucune version Forge disponible pour cette version Minecraft.');
  }

  const resolvedLoaderVersion = requestedLoaderVersion && versions.includes(requestedLoaderVersion)
    ? requestedLoaderVersion
    : versions[0];

  const versionMatcher = (id) => id.includes(`forge-${resolvedLoaderVersion}`);
  const alreadyInstalled = findInstalledCustomVersionId(rootDir, versionMatcher, { validateJson: true });
  if (alreadyInstalled) {
    return { customVersion: alreadyInstalled, loaderVersion: resolvedLoaderVersion };
  }

  removeInstalledCustomVersions(rootDir, versionMatcher);

  const fullForgeVersion = `${minecraftVersion}-${resolvedLoaderVersion}`;
  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullForgeVersion}/forge-${fullForgeVersion}-installer.jar`;

  ensureProfileDirectory(rootDir);
  ensureLauncherProfilesFile(rootDir);

  ensureModloadersRoot();
  const installerPath = path.join(modloadersRoot(), `forge-${fullForgeVersion}-installer.jar`);
  if (!fs.existsSync(installerPath)) {
    await downloadFile(installerUrl, installerPath);
  }

  const cliJava = getInstallerJavaPath(javaPath);
  const runAttempts = [
    ['-jar', installerPath, '--installClient', rootDir],
    ['-jar', installerPath, '--installClient']
  ];

  let installed = false;
  let lastError = null;
  for (const args of runAttempts) {
    try {
      await runJavaProcess(cliJava, args, rootDir);
      installed = true;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!installed) {
    const installedAfterFailure = findInstalledCustomVersionId(rootDir, versionMatcher, { validateJson: true });
    if (installedAfterFailure) {
      return { customVersion: installedAfterFailure, loaderVersion: resolvedLoaderVersion };
    }

    throw new Error(lastError && lastError.message ? lastError.message : 'Installation Forge échouée.');
  }

  const customVersion = findInstalledCustomVersionId(rootDir, versionMatcher, { validateJson: true });
  if (!customVersion) {
    throw new Error('Version Forge installée introuvable dans le dossier versions.');
  }

  return { customVersion, loaderVersion: resolvedLoaderVersion };
}

async function ensureNeoForgeInstalled(javaPath, rootDir, minecraftVersion, requestedLoaderVersion) {
  const versions = await getNeoForgeVersionsForMinecraft(minecraftVersion);
  if (!versions.length) {
    throw new Error('Aucune version NeoForge disponible pour cette version Minecraft.');
  }

  const resolvedLoaderVersion = requestedLoaderVersion && versions.includes(requestedLoaderVersion)
    ? requestedLoaderVersion
    : versions[0];

  const versionMatcher = (id) => id.toLowerCase().includes('neoforge') && id.includes(resolvedLoaderVersion);
  const alreadyInstalled = findInstalledCustomVersionId(rootDir, versionMatcher, { validateJson: true });
  const neoforgeLibDir = path.join(rootDir, 'libraries', 'net', 'neoforged', 'neoforge', resolvedLoaderVersion);
  const neoforgeLibPresent = fs.existsSync(neoforgeLibDir) && fs.readdirSync(neoforgeLibDir).some(f => f.endsWith('.jar'));
  if (alreadyInstalled && neoforgeLibPresent) {
    return { customVersion: alreadyInstalled, loaderVersion: resolvedLoaderVersion };
  }

  removeInstalledCustomVersions(rootDir, versionMatcher);

  const installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${resolvedLoaderVersion}/neoforge-${resolvedLoaderVersion}-installer.jar`;

  ensureProfileDirectory(rootDir);
  ensureLauncherProfilesFile(rootDir);

  ensureModloadersRoot();
  const installerPath = path.join(modloadersRoot(), `neoforge-${resolvedLoaderVersion}-installer.jar`);
  if (!fs.existsSync(installerPath)) {
    await downloadFile(installerUrl, installerPath);
  }

  const cliJava = getInstallerJavaPath(javaPath);
  const runAttempts = [
    ['-jar', installerPath, '--installClient', rootDir],
    ['-jar', installerPath, '--install-client', rootDir],
    ['-jar', installerPath, '--installClient']
  ];

  let installed = false;
  let lastError = null;
  for (const args of runAttempts) {
    try {
      await runJavaProcess(cliJava, args, rootDir);
      installed = true;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!installed) {
    const installedAfterFailure = findInstalledCustomVersionId(rootDir, versionMatcher, { validateJson: true });
    if (installedAfterFailure) {
      return { customVersion: installedAfterFailure, loaderVersion: resolvedLoaderVersion };
    }

    throw new Error(lastError && lastError.message ? lastError.message : 'Installation NeoForge échouée.');
  }

  const customVersion = findInstalledCustomVersionId(rootDir, versionMatcher, { validateJson: true });
  if (!customVersion) {
    throw new Error('Version NeoForge installée introuvable dans le dossier versions.');
  }

  return { customVersion, loaderVersion: resolvedLoaderVersion };
}

async function ensureMicrosoftSession(preferredAccountId) {
  if (microsoftAuth && (!preferredAccountId || preferredAccountId === microsoftAccountId)) {
    return true;
  }

  const store = readAuthStore();
  if (!store.accounts.length) {
    return false;
  }

  const accountIds = [];
  if (preferredAccountId) {
    accountIds.push(preferredAccountId);
  }
  if (store.activeAccountId && !accountIds.includes(store.activeAccountId)) {
    accountIds.push(store.activeAccountId);
  }
  store.accounts.forEach((account) => {
    if (!accountIds.includes(account.id)) {
      accountIds.push(account.id);
    }
  });

  let lastError = null;

  for (const accountId of accountIds) {
    try {
      await activateAccount(accountId);
      return true;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    sendLog(`[auth] Impossible de restaurer une session: ${lastError.message}`);
  }
  resetMicrosoftSession();
  
  try {
    const current = readAuthStore();
    if (!current.accounts.length) {
      clearSavedSession();
    }
  } catch {
  }

  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    resizable: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'renderer', 'assets', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();

  if (app.isPackaged && !isPortablePackage()) {
    setTimeout(() => {
      void checkForLauncherUpdates(false);
    }, 4000);
  } else {
    sendUpdateEvent('disabled', {
      message: app.isPackaged
        ? 'Mise à jour auto indisponible pour la version portable.'
        : 'Mise à jour auto indisponible en développement.'
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('launcher:start', async (_, payload) => {
  if (isLaunching) {
    return { ok: false, message: 'Un lancement est déjà en cours.' };
  }

  const {
    version,
    versionType,
    memoryMb,
    disableGameConsole,
    closeLauncherOnStart,
    accountId,
    gameDirectory,
    modloader,
    modloaderVersion
  } = payload;

  if (!version) {
    return { ok: false, message: 'La version est requise.' };
  }

  const hasMicrosoftSession = await ensureMicrosoftSession(typeof accountId === 'string' ? accountId : null);
  if (!hasMicrosoftSession) {
    return { ok: false, message: 'Connecte ton compte Microsoft avant de lancer.' };
  }

  const safeMemoryMb = Number(memoryMb);
  const maxMemoryMb = Number.isFinite(safeMemoryMb) && safeMemoryMb >= 1024 ? safeMemoryMb : 2048;
  const hideConsole = Boolean(disableGameConsole);
  const shouldCloseLauncher = Boolean(closeLauncherOnStart);
  const allowedVersionTypes = new Set(['release', 'snapshot', 'old_alpha', 'old_beta']);
  const resolvedVersionType = typeof versionType === 'string' && allowedVersionTypes.has(versionType)
    ? versionType
    : 'release';

  let javaRuntime;
  try {
    sendLog('[java] Vérification du runtime Java portable...');
    javaRuntime = await ensurePortableJavaForVersion(version.trim(), resolvedVersionType, hideConsole);
    sendLog(`[java] Java ${javaRuntime.javaMajor} prêt (${javaRuntime.source}).`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { ok: false, message: `Impossible de préparer Java: ${message}` };
  }

  const launcher = new Client();
  const requestedGameDirectory = normalizeGameDirectoryPath(gameDirectory);
  const minecraftDirectory = requestedGameDirectory || launcherRoot();
  ensureProfileDirectory(minecraftDirectory);
  const authorization = normalizeAuthorizationForLaunch(microsoftAuth);
  const trimmedVersion = version.trim();
  const selectedModloader = normalizeModloader(modloader);
  const requestedLoaderVersion = typeof modloaderVersion === 'string' ? modloaderVersion.trim() : '';
  const effectiveRoot = minecraftDirectory;

  const launchOptions = {
    authorization,
    root: effectiveRoot,
    javaPath: javaRuntime.javaPath,
    overrides: {
      detached: true,
      cwd: minecraftDirectory,
      gameDirectory: minecraftDirectory
    },
    version: {
      number: trimmedVersion,
      type: resolvedVersionType
    },
    memory: {
      max: `${maxMemoryMb}M`,
      min: '1024M'
    },
    forge: null
  };

  if (selectedModloader !== 'vanilla') {
    try {
      sendLog(`[modloader] Préparation ${selectedModloader}...`);

      let result;
      if (selectedModloader === 'fabric') {
        result = await ensureFabricInstalled(effectiveRoot, trimmedVersion, requestedLoaderVersion || null);
      } else if (selectedModloader === 'forge') {
        result = await ensureForgeInstalled(javaRuntime.javaPath, effectiveRoot, trimmedVersion, requestedLoaderVersion || null);
      } else {
        result = await ensureNeoForgeInstalled(javaRuntime.javaPath, effectiveRoot, trimmedVersion, requestedLoaderVersion || null);
      }

      launchOptions.version.custom = result.customVersion;

      if (selectedModloader === 'forge' || selectedModloader === 'neoforge') {
        try {
          const customVersionJsonPath = path.join(effectiveRoot, 'versions', result.customVersion, `${result.customVersion}.json`);
          const customVersionJson = JSON.parse(fs.readFileSync(customVersionJsonPath, 'utf-8'));
          const inheritedVersion = typeof customVersionJson.inheritsFrom === 'string'
            ? customVersionJson.inheritsFrom.trim()
            : '';

          if (inheritedVersion) {
            const runtimeForInherited = await ensurePortableJavaForVersion(inheritedVersion, resolvedVersionType, hideConsole);
            launchOptions.javaPath = runtimeForInherited.javaPath;
            launchOptions.version.number = inheritedVersion;
            javaRuntime = runtimeForInherited;
            sendLog(`[java] Runtime ajusté pour ${selectedModloader}: Java ${runtimeForInherited.javaMajor} (${inheritedVersion}).`);
          }
        } catch {
        }
      }

      if (selectedModloader === 'neoforge' || selectedModloader === 'forge') {
        const libraryDir = path.join(effectiveRoot, 'libraries').replace(/\\/g, '/');
        const classpathSeparator = process.platform === 'win32' ? ';' : ':';
        const versionName = result.customVersion || trimmedVersion;
        const customVersionJsonPath = path.join(effectiveRoot, 'versions', result.customVersion, `${result.customVersion}.json`);
        const extraJvmArgs = [];
        try {
          const versionJson = JSON.parse(fs.readFileSync(customVersionJsonPath, 'utf-8'));
          const rawJvmArgs = Array.isArray(versionJson.arguments && versionJson.arguments.jvm)
            ? versionJson.arguments.jvm
            : [];

          const flattenedJvmArgs = [];
          for (const entry of rawJvmArgs) {
            if (typeof entry === 'string') {
              flattenedJvmArgs.push(entry);
              continue;
            }

            if (!entry || typeof entry !== 'object') {
              continue;
            }

            const value = entry.value;
            if (typeof value === 'string') {
              flattenedJvmArgs.push(value);
              continue;
            }

            if (Array.isArray(value)) {
              for (const valueEntry of value) {
                if (typeof valueEntry === 'string') {
                  flattenedJvmArgs.push(valueEntry);
                }
              }
            }
          }

          const normalizedJvmArgs = [];
          for (const arg of flattenedJvmArgs) {
            const normalizedArg = arg
              .replace(/\$\{library_directory\}/g, libraryDir)
              .replace(/\$\{classpath_separator\}/g, classpathSeparator)
              .replace(/\$\{version_name\}/g, versionName);
            // Keep only fully resolved args to avoid invalid path errors at JVM startup.
            if (normalizedArg.includes('${')) continue;
            normalizedJvmArgs.push(normalizedArg);
          }

          const optionsExpectingValue = new Set([
            '--add-opens',
            '--add-exports',
            '--add-reads',
            '--add-modules',
            '--module-path',
            '-p',
            '-classpath',
            '-cp'
          ]);

          for (let index = 0; index < normalizedJvmArgs.length; index += 1) {
            const currentArg = normalizedJvmArgs[index];

            if (optionsExpectingValue.has(currentArg)) {
              const valueArg = normalizedJvmArgs[index + 1];
              if (typeof valueArg === 'string' && valueArg.trim()) {
                extraJvmArgs.push(currentArg, valueArg);
                index += 1;
              }
              continue;
            }

            // Drop standalone "module/package=target" entries when the option is missing.
            if (/^[a-zA-Z0-9_.]+\/[a-zA-Z0-9_.]+=[^\s]+$/.test(currentArg)) {
              continue;
            }

            extraJvmArgs.push(currentArg);
          }
        } catch {
          extraJvmArgs.push('-Djava.net.preferIPv6Addresses=system');
          extraJvmArgs.push(`-DlibraryDirectory=${libraryDir}`);
          extraJvmArgs.push('--add-opens');
          extraJvmArgs.push('java.base/java.lang.invoke=ALL-UNNAMED');
          extraJvmArgs.push('--add-exports');
          extraJvmArgs.push('jdk.naming.dns/com.sun.jndi.dns=java.naming');
        }
        if (!extraJvmArgs.some(arg => arg.startsWith('-DlibraryDirectory='))) {
          extraJvmArgs.push(`-DlibraryDirectory=${libraryDir}`);
        }

        // Deduplicate only JVM system properties; repeated flags like --add-opens are valid.
        const seenProperties = new Set();
        launchOptions.customArgs = extraJvmArgs.filter((arg) => {
          if (!arg.startsWith('-D')) {
            return true;
          }

          const propertyKey = arg.split('=')[0];
          if (seenProperties.has(propertyKey)) {
            return false;
          }

          seenProperties.add(propertyKey);
          return true;
        });
      }

      sendLog(`[modloader] ${selectedModloader} prêt (${result.loaderVersion}).`);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      return { ok: false, message: `Impossible de préparer ${selectedModloader}: ${message}` };
    }
  }

  sendLog(hideConsole
    ? '[launcher] Console Java désactivée (javaw).'
    : '[launcher] Console Java activée (java).');
  if (shouldCloseLauncher) {
    sendLog('[launcher] Le launcher se fermera après le démarrage du jeu.');
  }

  isLaunching = true;

  return new Promise((resolve) => {
    let resolved = false;

    const finalize = (result) => {
      if (resolved) {
        return;
      }
      resolved = true;
      isLaunching = false;
      resolve(result);
    };

    launcher.on('debug', (line) => {
      sendLog(`[debug] ${line}`);
    });

    launcher.on('data', (line) => {
      sendLog(`[mc] ${line}`);
    });

    launcher.on('progress', (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('launcher:progress', progress);
      }
    });

    launcher.on('arguments', (args) => {
      sendLog(`[args] ${args.join(' ')}`);
    });

    launcher.launch(launchOptions)
      .then(() => {
        finalize({ ok: true, message: 'Minecraft lancé.' });
        if (shouldCloseLauncher) {
          setTimeout(() => {
            app.quit();
          }, 200);
        }
      })
      .catch((error) => {
        const message = error && error.message ? error.message : String(error);
        finalize({ ok: false, message: `Échec du lancement: ${message}` });
      });
  });
});

ipcMain.handle('launcher:app-version', async () => {
  return {
    ok: true,
    version: app.getVersion()
  };
});

ipcMain.handle('launcher:versions', async (_, options) => {
  const includeSnapshots = Boolean(options && options.includeSnapshots);

  try {
    const manifest = await fetchJson(VERSION_MANIFEST_URL);
    const allowedTypes = includeSnapshots
      ? new Set(['release', 'snapshot'])
      : new Set(['release']);
    const versions = Array.isArray(manifest.versions)
      ? manifest.versions
        .filter((entry) => (
          entry
          && typeof entry.id === 'string'
          && typeof entry.type === 'string'
          && allowedTypes.has(entry.type)
        ))
        .map((entry) => ({
          id: entry.id,
          type: entry.type
        }))
      : [];

    const latestVersion = includeSnapshots
      ? (manifest.latest && typeof manifest.latest.snapshot === 'string' ? manifest.latest.snapshot : null)
      : (manifest.latest && typeof manifest.latest.release === 'string' ? manifest.latest.release : null);

    return {
      ok: true,
      latest: latestVersion,
      versions
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { ok: false, message: `Impossible de récupérer les versions: ${message}`, latest: null, versions: [] };
  }
});

ipcMain.handle('launcher:modloader-versions', async (_, options) => {
  const selectedModloader = normalizeModloader(options && options.modloader);
  const minecraftVersion = options && typeof options.minecraftVersion === 'string'
    ? options.minecraftVersion.trim()
    : '';

  if (!minecraftVersion || selectedModloader === 'vanilla') {
    return { ok: true, versions: [] };
  }

  try {
    let versions = [];
    if (selectedModloader === 'fabric') {
      versions = await getFabricLoaderVersions(minecraftVersion);
    } else if (selectedModloader === 'forge') {
      versions = await getForgeVersionsForMinecraft(minecraftVersion);
    } else if (selectedModloader === 'neoforge') {
      versions = await getNeoForgeVersionsForMinecraft(minecraftVersion);
    }

    return {
      ok: true,
      versions
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return {
      ok: false,
      message: `Impossible de récupérer les versions ${selectedModloader}: ${message}`,
      versions: []
    };
  }
});

ipcMain.handle('launcher:open-game-folder', async (_, targetPathArg) => {
  try {
    const store = readProfilesStore();
    const activeProfile = store.profiles.find((entry) => entry.id === store.activeProfileId) || null;
    const fallbackPath = activeProfile && activeProfile.gameDirectory
      ? activeProfile.gameDirectory
      : launcherRoot();
    const argTargetPath = normalizeGameDirectoryPath(targetPathArg);
    const targetPath = argTargetPath || fallbackPath;
    ensureProfileDirectory(targetPath);
    const errorMessage = await shell.openPath(targetPath);

    if (errorMessage) {
      return {
        ok: false,
        message: `Impossible d'ouvrir le dossier: ${errorMessage}`,
        path: targetPath
      };
    }

    return {
      ok: true,
      message: 'Dossier ouvert.',
      path: targetPath
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { ok: false, message: `Erreur ouverture dossier: ${message}`, path: launcherRoot() };
  }
});

ipcMain.handle('launcher:open-external-link', async (_, rawUrl) => {
  try {
    const value = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!value) {
      return { ok: false, message: 'Lien invalide.' };
    }

    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return { ok: false, message: 'Lien invalide.' };
    }

    if (!['https:', 'http:'].includes(parsed.protocol)) {
      return { ok: false, message: 'Protocole non autorise.' };
    }

    await shell.openExternal(parsed.toString());
    return { ok: true };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { ok: false, message: `Impossible d'ouvrir le lien: ${message}` };
  }
});

ipcMain.handle('profiles:list', async () => {
  const store = readProfilesStore();
  writeProfilesStore(store);
  return profilesResponse(store, true, 'Profils chargés.');
});

ipcMain.handle('profiles:create', async (_, requestedName) => {
  const store = readProfilesStore();
  const id = createProfileId();
  const profilesCount = store.profiles.length + 1;
  const profileName = sanitizeProfileName(requestedName || `Profil ${profilesCount}`);
  const gameDirectory = path.join(defaultInstancesRoot(), id);

  const profile = {
    id,
    name: profileName,
    version: '',
    modloader: 'vanilla',
    modloaderVersion: '',
    gameDirectory
  };

  store.profiles.push(profile);
  store.activeProfileId = profile.id;
  ensureProfileDirectory(gameDirectory);
  writeProfilesStore(store);
  return profilesResponse(store, true, 'Profil créé.');
});

ipcMain.handle('profiles:update', async (_, payload) => {
  const store = readProfilesStore();
  const profileId = typeof payload?.id === 'string' ? payload.id : null;
  if (!profileId) {
    return profilesResponse(store, false, 'Profil invalide.');
  }

  const profile = store.profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    return profilesResponse(store, false, 'Profil introuvable.');
  }

  if (typeof payload?.name === 'string') {
    profile.name = sanitizeProfileName(payload.name);
  }

  if (typeof payload?.version === 'string') {
    profile.version = payload.version.trim();
  }

  if (typeof payload?.modloader === 'string') {
    profile.modloader = normalizeModloader(payload.modloader);
    if (profile.modloader === 'vanilla') {
      profile.modloaderVersion = '';
    }
  }

  if (typeof payload?.modloaderVersion === 'string') {
    profile.modloaderVersion = payload.modloaderVersion.trim();
  }

  if (typeof payload?.gameDirectory === 'string') {
    const normalizedDirectory = normalizeGameDirectoryPath(payload.gameDirectory);
    if (!normalizedDirectory) {
      return profilesResponse(store, false, 'Dossier de jeu invalide.');
    }

    profile.gameDirectory = normalizedDirectory;
    ensureProfileDirectory(normalizedDirectory);
  }

  if (typeof payload?.setActive === 'boolean' && payload.setActive) {
    store.activeProfileId = profile.id;
  }

  writeProfilesStore(store);
  return profilesResponse(store, true, 'Profil mis à jour.');
});

ipcMain.handle('profiles:delete', async (_, payload) => {
  const store = readProfilesStore();
  if (store.profiles.length <= 1) {
    return profilesResponse(store, false, 'Impossible de supprimer le dernier profil.');
  }

  const targetId = typeof payload === 'string'
    ? payload
    : (typeof payload?.id === 'string' ? payload.id : '');
  const deleteGameDirectory = typeof payload === 'object' && payload !== null
    ? Boolean(payload.deleteGameDirectory)
    : false;

  const targetProfile = store.profiles.find((entry) => entry.id === targetId) || null;
  if (!targetProfile) {
    return profilesResponse(store, false, 'Profil introuvable.');
  }

  if (deleteGameDirectory) {
    const targetDirectory = normalizeGameDirectoryPath(targetProfile.gameDirectory);
    if (!targetDirectory || isDangerousDeletePath(targetDirectory)) {
      return profilesResponse(store, false, 'Suppression du dossier refusée (chemin protégé).');
    }

    try {
      if (fs.existsSync(targetDirectory)) {
        fs.rmSync(targetDirectory, { recursive: true, force: true });
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      return profilesResponse(store, false, `Impossible de supprimer le dossier du profil: ${message}`);
    }
  }

  const filtered = store.profiles.filter((entry) => entry.id !== targetId);

  store.profiles = filtered;
  if (!store.profiles.some((entry) => entry.id === store.activeProfileId)) {
    store.activeProfileId = store.profiles[0].id;
  }

  writeProfilesStore(store);
  return profilesResponse(store, true, deleteGameDirectory ? 'Profil et dossier supprimés.' : 'Profil supprimé.');
});

ipcMain.handle('profiles:choose-folder', async (_, initialPath) => {
  const defaultPath = normalizeGameDirectoryPath(initialPath) || launcherRoot();

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir le dossier du profil',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    defaultPath
  });

  if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) {
    return { ok: false, canceled: true, path: defaultPath };
  }

  const selectedPath = normalizeGameDirectoryPath(result.filePaths[0]);
  if (!selectedPath) {
    return { ok: false, canceled: false, message: 'Dossier invalide.', path: defaultPath };
  }

  return { ok: true, canceled: false, path: selectedPath };
});

ipcMain.handle('updater:check', async () => {
  return checkForLauncherUpdates(true);
});

ipcMain.handle('updater:install', async () => {
  if (!app.isPackaged) {
    return { ok: false, message: 'Installation de mise à jour indisponible en développement.' };
  }

  if (isPortablePackage()) {
    return { ok: false, message: 'Installation auto indisponible pour la version portable.' };
  }

  setImmediate(() => {
    autoUpdater.quitAndInstall(true, true);
  });

  return { ok: true, message: 'Redémarrage pour appliquer la mise à jour...' };
});

ipcMain.handle('auth:microsoft-login', async () => {
  try {
    sendLog('[auth] Ouverture de la connexion Microsoft...');
    const authManager = new Auth('select_account');
    const xboxManager = await authManager.launch('electron', { width: 520, height: 700, resizable: false });
    const token = await xboxManager.getMinecraft();

    const profileId = token.profile?.id || token.mclc().uuid;
    const profileName = token.profile?.name || token.mclc().name || 'Compte Microsoft';
    const refreshToken = xboxManager.save();

    const store = await migrateLegacyRefreshTokens(readAuthStore());
    const existingIndex = store.accounts.findIndex((account) => account.id === profileId || account.uuid === profileId);
    const account = {
      id: profileId,
      uuid: profileId,
      name: profileName
    };

    await writeRefreshTokenSecure(account.id, refreshToken);

    if (existingIndex >= 0) {
      store.accounts[existingIndex] = account;
    } else {
      store.accounts.push(account);
    }

    store.activeAccountId = account.id;
    writeAuthStore(store);
    applyMicrosoftToken(account.id, token);

    sendLog(`[auth] Connecté en tant que ${microsoftProfile.name}`);
    return accountResponse(store, true, 'Compte ajouté.');
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return accountResponse(readAuthStore(), false, `Connexion Microsoft échouée: ${message}`);
  }
});

ipcMain.handle('auth:microsoft-restore', async () => {
  const store = await migrateLegacyRefreshTokens(readAuthStore());

  if (!store.accounts.length) {
    resetMicrosoftSession();
    return accountResponse(store, false, 'Aucun compte Microsoft sauvegardé.');
  }

  try {
    const preferredAccountId = store.activeAccountId || store.accounts[0].id;
    const updatedStore = await activateAccount(preferredAccountId);
    sendLog(`[auth] Session restaurée pour ${microsoftProfile.name}`);
    return accountResponse(updatedStore, true, 'Session restaurée.');
  } catch (error) {
    resetMicrosoftSession();
    const message = error && error.message ? error.message : String(error);
    return accountResponse(store, false, `Restauration impossible: ${message}`);
  }
});

ipcMain.handle('auth:microsoft-list', async () => {
  const store = await migrateLegacyRefreshTokens(readAuthStore());
  return accountResponse(store, true, 'Liste des comptes.');
});

ipcMain.handle('auth:microsoft-select', async (_, accountId) => {
  if (typeof accountId !== 'string' || !accountId) {
    return accountResponse(readAuthStore(), false, 'Compte invalide.');
  }

  try {
    const store = await activateAccount(accountId);
    sendLog(`[auth] Compte actif: ${microsoftProfile.name}`);
    return accountResponse(store, true, 'Compte sélectionné.');
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return accountResponse(readAuthStore(), false, `Impossible de sélectionner le compte: ${message}`);
  }
});

ipcMain.handle('auth:microsoft-remove', async (_, accountId) => {
  const store = await migrateLegacyRefreshTokens(readAuthStore());
  const targetId = typeof accountId === 'string' && accountId ? accountId : store.activeAccountId;

  if (!targetId) {
    return accountResponse(store, false, 'Aucun compte à supprimer.');
  }

  const filtered = store.accounts.filter((account) => account.id !== targetId);
  const removed = filtered.length !== store.accounts.length;

  if (!removed) {
    return accountResponse(store, false, 'Compte introuvable.');
  }

  store.accounts = filtered;
  store.activeAccountId = filtered[0] ? filtered[0].id : null;
  await deleteRefreshTokenSecure(targetId);
  writeAuthStore(store);

  if (microsoftAccountId === targetId) {
    resetMicrosoftSession();
  }

  if (store.activeAccountId) {
    try {
      await activateAccount(store.activeAccountId);
    } catch {
      resetMicrosoftSession();
    }
  }

  if (!store.accounts.length) {
    clearSavedSession();
  }

  return accountResponse(readAuthStore(), true, 'Compte supprimé.');
});

ipcMain.handle('auth:microsoft-logout', async () => {
  const store = await migrateLegacyRefreshTokens(readAuthStore());
  if (!store.activeAccountId) {
    return accountResponse(store, false, 'Aucun compte actif à supprimer.');
  }

  const targetId = store.activeAccountId;
  const filtered = store.accounts.filter((account) => account.id !== targetId);
  store.accounts = filtered;
  store.activeAccountId = filtered[0] ? filtered[0].id : null;
  await deleteRefreshTokenSecure(targetId);
  writeAuthStore(store);

  if (microsoftAccountId === targetId) {
    resetMicrosoftSession();
  }

  if (store.activeAccountId) {
    try {
      await activateAccount(store.activeAccountId);
    } catch {
      resetMicrosoftSession();
    }
  }

  if (!store.accounts.length) {
    clearSavedSession();
  }

  return accountResponse(readAuthStore(), true, 'Compte supprimé.');
});
