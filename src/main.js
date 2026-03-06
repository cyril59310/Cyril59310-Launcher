const path = require('path');
const fs = require('fs');
const https = require('https');
const { app, BrowserWindow, ipcMain } = require('electron');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

let mainWindow;
let isLaunching = false;
let microsoftAuth = null;
let microsoftProfile = null;
let microsoftAccountId = null;

const launcherRoot = () => path.join(app.getPath('appData'), '.Cyril59310-Launcher');
const authStorePath = () => path.join(launcherRoot(), 'auth.json');
const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

function createDefaultAuthStore() {
  return {
    activeAccountId: null,
    accounts: []
  };
}

function ensureLauncherRoot() {
  fs.mkdirSync(launcherRoot(), { recursive: true });
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
        .filter((account) => account && typeof account.refreshToken === 'string')
        .map((account) => ({
          id: String(account.id || account.uuid || `account-${Date.now()}`),
          name: String(account.name || 'Compte Microsoft'),
          uuid: String(account.uuid || ''),
          refreshToken: String(account.refreshToken)
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
          refreshToken: parsed.refreshToken
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
  fs.writeFileSync(authStorePath(), JSON.stringify(store, null, 2), 'utf-8');
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
  const store = readAuthStore();
  const account = store.accounts.find((entry) => entry.id === accountId);

  if (!account) {
    throw new Error('Compte introuvable.');
  }

  const refreshed = await refreshAccountFromToken(account.refreshToken);
  applyMicrosoftToken(account.id, refreshed.token);

  account.refreshToken = refreshed.refreshToken;
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

  const launcher = new Client();
  const minecraftDirectory = launcherRoot();

  const launchOptions = {
    authorization: microsoftAuth,
    root: minecraftDirectory,
    javaPath: process.platform === 'win32' && hideConsole ? 'javaw' : 'java',
    version: {
      number: version.trim(),
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

ipcMain.handle('auth:microsoft-login', async () => {
  try {
    sendLog('[auth] Ouverture de la connexion Microsoft...');
    const authManager = new Auth('select_account');
    const xboxManager = await authManager.launch('electron', { width: 520, height: 700, resizable: false });
    const token = await xboxManager.getMinecraft();

    const profileId = token.profile?.id || token.mclc().uuid;
    const profileName = token.profile?.name || token.mclc().name || 'Compte Microsoft';
    const refreshToken = xboxManager.save();

    const store = readAuthStore();
    const existingIndex = store.accounts.findIndex((account) => account.id === profileId || account.uuid === profileId);
    const account = {
      id: profileId,
      uuid: profileId,
      name: profileName,
      refreshToken
    };

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
  const store = readAuthStore();

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
  const store = readAuthStore();
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
  const store = readAuthStore();
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
  const store = readAuthStore();
  if (!store.activeAccountId) {
    return accountResponse(store, false, 'Aucun compte actif à supprimer.');
  }

  const targetId = store.activeAccountId;
  const filtered = store.accounts.filter((account) => account.id !== targetId);
  store.accounts = filtered;
  store.activeAccountId = filtered[0] ? filtered[0].id : null;
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
