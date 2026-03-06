const launchForm = document.getElementById('launchForm');
const launchBtn = document.getElementById('launchBtn');
const openGameFolderBtn = document.getElementById('openGameFolderBtn');
const logsEl = document.getElementById('logs');
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');
const progressFillEl = document.getElementById('progressFill');
const memoryEl = document.getElementById('memoryMb');
const disableGameConsoleEl = document.getElementById('disableGameConsole');
const closeLauncherOnStartEl = document.getElementById('closeLauncherOnStart');
const includeSnapshotsEl = document.getElementById('includeSnapshots');
const msLoginBtn = document.getElementById('msLoginBtn');
const msLogoutBtn = document.getElementById('msLogoutBtn');
const msStatusEl = document.getElementById('msStatus');
const msAccountSelectEl = document.getElementById('msAccountSelect');
const versionEl = document.getElementById('version');

let microsoftConnected = false;
const RAM_STORAGE_KEY = 'launcher.memoryMb';
const CONSOLE_STORAGE_KEY = 'launcher.disableGameConsole';
const CLOSE_LAUNCHER_STORAGE_KEY = 'launcher.closeOnStart';
const VERSION_STORAGE_KEY = 'launcher.gameVersion';
const SNAPSHOTS_STORAGE_KEY = 'launcher.includeSnapshots';

let availableVersions = [];

const setProgress = (percent, label) => {
  const clamped = Math.max(0, Math.min(100, percent));
  progressFillEl.style.width = `${clamped}%`;
  progressEl.textContent = label || `Progression: ${Math.round(clamped)}%`;
};

const appendLog = (line) => {
  logsEl.textContent += `${line}\n`;
  logsEl.scrollTop = logsEl.scrollHeight;
};

const setMicrosoftConnected = (connected, profileName) => {
  microsoftConnected = connected;
  msStatusEl.textContent = connected ? `Connecté (${profileName || 'Microsoft'})` : 'Non connecté';
};

const renderAccounts = (accounts, activeAccountId) => {
  msAccountSelectEl.innerHTML = '';

  if (!Array.isArray(accounts) || !accounts.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Aucun compte';
    msAccountSelectEl.appendChild(option);
    msAccountSelectEl.value = '';
    msAccountSelectEl.disabled = true;
    msLogoutBtn.disabled = true;
    return;
  }

  accounts.forEach((account) => {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = account.name || 'Compte Microsoft';
    msAccountSelectEl.appendChild(option);
  });

  const hasActive = accounts.some((account) => account.id === activeAccountId);
  msAccountSelectEl.value = hasActive ? activeAccountId : accounts[0].id;
  msAccountSelectEl.disabled = false;
  msLogoutBtn.disabled = false;
};

const applyAccountResponse = (result) => {
  renderAccounts(result.accounts || [], result.activeAccountId || null);

  if (result.profile && result.activeAccountId) {
    setMicrosoftConnected(true, result.profile.name);
    return;
  }

  if ((result.accounts || []).length > 0) {
    microsoftConnected = false;
    msStatusEl.textContent = 'Comptes sauvegardés (sélectionne un compte).';
    return;
  }

  setMicrosoftConnected(false);
};

window.mcLauncher.onLog((line) => {
  appendLog(line);
});

window.mcLauncher.onProgress((progress) => {
  if (typeof progress === 'number') {
    setProgress(progress * 100, `Progression: ${Math.round(progress * 100)}%`);
    return;
  }

  const task = Number(progress?.task || 0);
  const total = Number(progress?.total || 0);
  const type = progress?.type ? String(progress.type) : 'download';

  if (total > 0) {
    const percent = (task / total) * 100;
    setProgress(percent, `Téléchargement ${type}: ${task}/${total} (${Math.round(percent)}%)`);
    return;
  }

  setProgress(0, 'Téléchargement...');
});

msLoginBtn.addEventListener('click', async () => {
  msLoginBtn.disabled = true;
  statusEl.textContent = 'Ajout du compte Microsoft en cours...';

  try {
    const result = await window.mcLauncher.microsoftLogin();
    if (result.ok) {
      applyAccountResponse(result);
      statusEl.textContent = `Compte actif: ${result.profile?.name || 'Microsoft'}`;
      appendLog(`[auth] Compte Microsoft prêt (${result.profile?.name || 'utilisateur inconnu'})`);
    } else {
      applyAccountResponse(result);
      statusEl.textContent = result.message;
      appendLog(`[auth] ${result.message}`);
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setMicrosoftConnected(false);
    statusEl.textContent = `Erreur auth: ${message}`;
    appendLog(`[auth:error] ${message}`);
  } finally {
    msLoginBtn.disabled = false;
  }
});

msLogoutBtn.addEventListener('click', async () => {
  msLogoutBtn.disabled = true;

  try {
    const targetAccountId = msAccountSelectEl.value || null;
    const result = await window.mcLauncher.microsoftRemove(targetAccountId);
    applyAccountResponse(result);
    statusEl.textContent = result.ok ? 'Compte supprimé.' : result.message;
    if (result.message) {
      appendLog(`[auth] ${result.message}`);
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    statusEl.textContent = `Erreur: ${message}`;
    appendLog(`[auth:error] ${message}`);
  } finally {
    msLogoutBtn.disabled = false;
  }
});

msAccountSelectEl.addEventListener('change', async () => {
  const targetAccountId = msAccountSelectEl.value;
  if (!targetAccountId) {
    return;
  }

  msAccountSelectEl.disabled = true;
  statusEl.textContent = 'Changement de compte...';

  try {
    const result = await window.mcLauncher.microsoftSelect(targetAccountId);
    applyAccountResponse(result);
    statusEl.textContent = result.ok
      ? `Compte actif: ${result.profile?.name || 'Microsoft'}`
      : result.message;
    if (!result.ok && result.message) {
      appendLog(`[auth] ${result.message}`);
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    statusEl.textContent = `Erreur auth: ${message}`;
    appendLog(`[auth:error] ${message}`);
  } finally {
    msAccountSelectEl.disabled = false;
  }
});

versionEl.addEventListener('change', () => {
  if (versionEl.value) {
    localStorage.setItem(VERSION_STORAGE_KEY, versionEl.value);
  }
});

includeSnapshotsEl.addEventListener('change', () => {
  localStorage.setItem(SNAPSHOTS_STORAGE_KEY, includeSnapshotsEl.checked ? '1' : '0');
  void loadVersions(versionEl.value || localStorage.getItem(VERSION_STORAGE_KEY));
});

launchForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(launchForm);
  const payload = {
    version: String(formData.get('version') || ''),
    versionType: availableVersions.find((entry) => entry.id === String(formData.get('version') || ''))?.type || 'release',
    memoryMb: Number(formData.get('memoryMb') || 2048),
    disableGameConsole: Boolean(formData.get('disableGameConsole')),
    closeLauncherOnStart: Boolean(formData.get('closeLauncherOnStart')),
    accountId: msAccountSelectEl.value || null
  };

  localStorage.setItem(RAM_STORAGE_KEY, String(payload.memoryMb));
  localStorage.setItem(CONSOLE_STORAGE_KEY, payload.disableGameConsole ? '1' : '0');
  localStorage.setItem(CLOSE_LAUNCHER_STORAGE_KEY, payload.closeLauncherOnStart ? '1' : '0');
  localStorage.setItem(VERSION_STORAGE_KEY, payload.version);

  if (!microsoftConnected || !payload.accountId) {
    statusEl.textContent = 'Connecte un compte Microsoft avant de lancer.';
    appendLog('[auth] Lance la connexion Microsoft puis réessaie.');
    return;
  }

  launchBtn.disabled = true;
  statusEl.textContent = 'Initialisation du lancement...';
  logsEl.textContent = '';
  setProgress(0, 'Progression: 0%');

  try {
    const result = await window.mcLauncher.start(payload);
    statusEl.textContent = result.ok ? 'Minecraft démarré.' : result.message;
    appendLog(result.message);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    statusEl.textContent = `Erreur: ${message}`;
    appendLog(`[error] ${message}`);
  } finally {
    launchBtn.disabled = false;
  }
});

openGameFolderBtn.addEventListener('click', async () => {
  openGameFolderBtn.disabled = true;

  try {
    const result = await window.mcLauncher.openGameFolder();
    if (result.ok) {
      statusEl.textContent = 'Dossier du jeu ouvert.';
      appendLog(`[launcher] Dossier ouvert: ${result.path}`);
    } else {
      statusEl.textContent = result.message || 'Impossible d\'ouvrir le dossier du jeu.';
      appendLog(`[launcher] ${result.message || 'Ouverture du dossier impossible.'}`);
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    statusEl.textContent = `Erreur: ${message}`;
    appendLog(`[error] ${message}`);
  } finally {
    openGameFolderBtn.disabled = false;
  }
});

const tryRestoreMicrosoftSession = async () => {
  try {
    const result = await window.mcLauncher.microsoftRestore();
    applyAccountResponse(result);

    if (result.ok && result.profile) {
      statusEl.textContent = `Session restaurée: ${result.profile.name || 'Microsoft'}`;
      return;
    }

    const listed = await window.mcLauncher.microsoftList();
    applyAccountResponse(listed);
    if ((listed.accounts || []).length > 0) {
      statusEl.textContent = 'Sélectionne un compte Microsoft pour continuer.';
    }
  } catch {
  }
};

const restoreRamPreference = () => {
  const saved = localStorage.getItem(RAM_STORAGE_KEY);
  if (!saved) {
    return;
  }

  const optionExists = Array.from(memoryEl.options).some((opt) => opt.value === saved);
  if (optionExists) {
    memoryEl.value = saved;
  }
};

const restoreConsolePreference = () => {
  const saved = localStorage.getItem(CONSOLE_STORAGE_KEY);
  disableGameConsoleEl.checked = saved === '1';
};

const restoreCloseLauncherPreference = () => {
  const saved = localStorage.getItem(CLOSE_LAUNCHER_STORAGE_KEY);
  closeLauncherOnStartEl.checked = saved === '1';
};

const restoreSnapshotPreference = () => {
  const saved = localStorage.getItem(SNAPSHOTS_STORAGE_KEY);
  includeSnapshotsEl.checked = saved === '1';
};

const renderVersionOptions = (versions, selectedVersion) => {
  versionEl.innerHTML = '';
  availableVersions = Array.isArray(versions) ? versions : [];

  availableVersions.forEach((versionEntry) => {
    const version = typeof versionEntry === 'string' ? versionEntry : versionEntry.id;
    if (!version) {
      return;
    }

    const option = document.createElement('option');
    option.value = version;
    option.textContent = version;
    versionEl.appendChild(option);
  });

  if (!availableVersions.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Aucune version disponible';
    versionEl.appendChild(option);
    versionEl.value = '';
    versionEl.disabled = true;
    return;
  }

  versionEl.disabled = false;

  const ids = availableVersions.map((entry) => (typeof entry === 'string' ? entry : entry.id));
  if (selectedVersion && ids.includes(selectedVersion)) {
    versionEl.value = selectedVersion;
    return;
  }

  versionEl.value = ids[0];
};

const loadVersions = async (preferredVersionOverride) => {
  const savedVersion = preferredVersionOverride || localStorage.getItem(VERSION_STORAGE_KEY);
  const includeSnapshots = includeSnapshotsEl.checked;

  try {
    const result = await window.mcLauncher.getVersions({ includeSnapshots });
    if (result.ok && Array.isArray(result.versions) && result.versions.length > 0) {
      const firstVersion = typeof result.versions[0] === 'string'
        ? result.versions[0]
        : result.versions[0].id;
      const preferredVersion = savedVersion || result.latest || firstVersion;
      renderVersionOptions(result.versions, preferredVersion);
      if (versionEl.value) {
        localStorage.setItem(VERSION_STORAGE_KEY, versionEl.value);
      }
      return;
    }
  } catch {
  }

  const fallbackVersion = savedVersion || '1.21.11';
  renderVersionOptions([{ id: fallbackVersion, type: 'release' }], fallbackVersion);
  statusEl.textContent = 'Liste des versions indisponible, version locale utilisée.';
};

restoreRamPreference();
restoreConsolePreference();
restoreCloseLauncherPreference();
restoreSnapshotPreference();
setProgress(0, 'Progression: 0%');
void loadVersions();
void tryRestoreMicrosoftSession();
