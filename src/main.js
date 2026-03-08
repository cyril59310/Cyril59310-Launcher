const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
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
const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
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
    return {
      javaPath: existingJava,
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
    sendLog('[update] Verification des mises a jour...');
  });

  autoUpdater.on('update-available', (info) => {
    sendUpdateEvent('available', { version: info && info.version ? String(info.version) : null });
    sendLog(`[update] Mise a jour disponible${info && info.version ? `: ${info.version}` : ''}. Telechargement...`);
  });

  autoUpdater.on('update-not-available', () => {
    sendUpdateEvent('none');
    sendLog('[update] Aucune mise a jour disponible.');
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateEvent('download-progress', {
      percent: Number(progress && progress.percent ? progress.percent : 0)
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateEvent('downloaded', { version: info && info.version ? String(info.version) : null });
    sendLog('[update] Mise a jour telechargee. Clique sur "Installer la mise a jour" pour redemarrer.');
  });

  autoUpdater.on('error', (error) => {
    const message = error && error.message ? error.message : String(error);
    sendUpdateEvent('error', { message });
    sendLog(`[update] Erreur mise a jour: ${message}`);
  });
}

async function checkForLauncherUpdates(isManual = false) {
  if (!app.isPackaged) {
    return { ok: false, message: 'Mise a jour indisponible en mode developpement.' };
  }

  if (isPortablePackage()) {
    return { ok: false, message: 'Mise a jour automatique indisponible pour la version portable.' };
  }

  try {
    await autoUpdater.checkForUpdates();
    return { ok: true, message: isManual ? 'Verification des mises a jour lancee.' : 'OK' };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { ok: false, message: `Verification impossible: ${message}` };
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
    throw new Error('Token Microsoft introuvable dans le coffre systeme. Reconnecte ton compte.');
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
        ? 'Mise a jour auto indisponible pour la version portable.'
        : 'Mise a jour auto indisponible en developpement.'
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
    gameDirectory
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

  const launchOptions = {
    authorization,
    root: minecraftDirectory,
    javaPath: javaRuntime.javaPath,
    overrides: {
      detached: hideConsole
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
  return profilesResponse(store, true, 'Profils charges.');
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
    gameDirectory
  };

  store.profiles.push(profile);
  store.activeProfileId = profile.id;
  ensureProfileDirectory(gameDirectory);
  writeProfilesStore(store);
  return profilesResponse(store, true, 'Profil cree.');
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
  return profilesResponse(store, true, 'Profil mis a jour.');
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
      return profilesResponse(store, false, 'Suppression du dossier refusee (chemin protege).');
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
  return profilesResponse(store, true, deleteGameDirectory ? 'Profil et dossier supprimes.' : 'Profil supprime.');
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
    return { ok: false, message: 'Installation de mise a jour indisponible en developpement.' };
  }

  if (isPortablePackage()) {
    return { ok: false, message: 'Installation auto indisponible pour la version portable.' };
  }

  setImmediate(() => {
    autoUpdater.quitAndInstall(true, true);
  });

  return { ok: true, message: 'Redemarrage pour appliquer la mise a jour...' };
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
