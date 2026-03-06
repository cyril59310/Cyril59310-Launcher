const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const keytar = require('keytar');

let mainWindow;
let isLaunching = false;
let microsoftAuth = null;
let microsoftProfile = null;
let microsoftAccountId = null;

const launcherRoot = () => path.join(app.getPath('appData'), '.Cyril59310-Launcher');
const authStorePath = () => path.join(launcherRoot(), 'auth.json');
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
    width: 920,
    height: 920,
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
    accountId
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
  const minecraftDirectory = launcherRoot();
  const authorization = normalizeAuthorizationForLaunch(microsoftAuth);
  const trimmedVersion = version.trim();

  const launchOptions = {
    authorization,
    root: minecraftDirectory,
    javaPath: javaRuntime.javaPath,
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

ipcMain.handle('launcher:open-game-folder', async () => {
  try {
    ensureLauncherRoot();
    const targetPath = launcherRoot();
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
