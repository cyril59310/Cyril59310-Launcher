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
const profileSelectEl = document.getElementById('profileSelect');
const profileNameEl = document.getElementById('profileName');
const profileGameDirectoryEl = document.getElementById('profileGameDirectory');
const profileNoticeEl = document.getElementById('profileNotice');
const activeProfileLabelEl = document.getElementById('activeProfileLabel');
const openProfileSettingsBtn = document.getElementById('openProfileSettingsBtn');
const profileSettingsModal = document.getElementById('profileSettingsModal');
const closeProfileSettingsBtn = document.getElementById('closeProfileSettingsBtn');
const confirmProfileSettingsBtn = document.getElementById('confirmProfileSettingsBtn');
const profileSettingsWindow = profileSettingsModal ? profileSettingsModal.querySelector('.profile-settings-window') : null;
const browseProfileFolderBtn = document.getElementById('browseProfileFolderBtn');
const newProfileBtn = document.getElementById('newProfileBtn');
const saveProfileBtn = document.getElementById('saveProfileBtn');
const deleteProfileBtn = document.getElementById('deleteProfileBtn');
const msLoginBtn = document.getElementById('msLoginBtn');
const msLogoutBtn = document.getElementById('msLogoutBtn');
const msStatusEl = document.getElementById('msStatus');
const msAccountSelectEl = document.getElementById('msAccountSelect');
const accountIdentityEl = document.getElementById('accountIdentity');
const playerHeadEl = document.getElementById('playerHead');
const playerNameEl = document.getElementById('playerName');
const versionEl = document.getElementById('version');
const updateStatusEl = document.getElementById('updateStatus');
const checkUpdateBtn = document.getElementById('checkUpdateBtn');
const installUpdateBtn = document.getElementById('installUpdateBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const settingsWindow = settingsModal ? settingsModal.querySelector('.settings-window') : null;
const launcherVersionEl = document.getElementById('launcherVersion');
const authorGithubLinkEl = document.getElementById('authorGithubLink');

let microsoftConnected = false;
const RAM_STORAGE_KEY = 'launcher.memoryMb';
const CONSOLE_STORAGE_KEY = 'launcher.disableGameConsole';
const CLOSE_LAUNCHER_STORAGE_KEY = 'launcher.closeOnStart';
const VERSION_STORAGE_KEY = 'launcher.gameVersion';
const SNAPSHOTS_STORAGE_KEY = 'launcher.includeSnapshots';

let availableVersions = [];
let updateReady = false;
let knownAccounts = [];
let knownActiveAccountId = null;
let knownProfile = null;
let knownProfiles = [];
let activeProfileId = null;
let profileNoticeTimeout = null;
const DEFAULT_PLAYER_HEAD_URL = 'https://mc-heads.net/avatar/1/36';

const normalizeUuid = (value) => {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/-/g, '').trim();
};

const buildPlayerHeadUrl = (uuid, name) => {
  const normalizedUuid = normalizeUuid(uuid);
  if (normalizedUuid) {
    return `https://mc-heads.net/avatar/${encodeURIComponent(normalizedUuid)}/36`;
  }

  const safeName = typeof name === 'string' ? name.trim() : '';
  if (safeName) {
    return `https://mc-heads.net/avatar/${encodeURIComponent(safeName)}/36`;
  }

  return DEFAULT_PLAYER_HEAD_URL;
};

const hideAccountIdentity = () => {
  if (!accountIdentityEl || !playerNameEl || !playerHeadEl) {
    return;
  }

  accountIdentityEl.classList.add('is-offline');
  playerNameEl.textContent = 'Aucun compte';
  playerHeadEl.dataset.fallback = '0';
  playerHeadEl.src = DEFAULT_PLAYER_HEAD_URL;
  playerHeadEl.alt = 'Tête de Steve';
};

const renderAccountIdentity = () => {
  if (!accountIdentityEl || !playerNameEl || !playerHeadEl) {
    return;
  }

  const selectedAccountId = msAccountSelectEl.value || knownActiveAccountId;
  const account = knownAccounts.find((entry) => entry && entry.id === selectedAccountId) || null;
  const displayName = (account && account.name) || (knownProfile && knownProfile.name) || '';
  const playerUuid = (account && account.uuid) || (knownProfile && knownProfile.id) || '';

  if (!displayName) {
    hideAccountIdentity();
    return;
  }

  accountIdentityEl.classList.remove('is-offline');
  playerNameEl.textContent = displayName;
  playerHeadEl.alt = `Tête de ${displayName}`;
  playerHeadEl.dataset.fallback = '0';
  playerHeadEl.src = buildPlayerHeadUrl(playerUuid, displayName);
};

if (playerHeadEl) {
  playerHeadEl.addEventListener('error', () => {
    if (playerHeadEl.dataset.fallback === '2') {
      return;
    }

    if (playerHeadEl.dataset.fallback === '1') {
      playerHeadEl.dataset.fallback = '2';
      playerHeadEl.src = 'assets/logo.png';
      return;
    }

    playerHeadEl.dataset.fallback = '1';
    playerHeadEl.src = DEFAULT_PLAYER_HEAD_URL;
  });
}

const setProgress = (percent, label) => {
  const clamped = Math.max(0, Math.min(100, percent));
  progressFillEl.style.width = `${clamped}%`;
  progressEl.textContent = label || `Progression: ${Math.round(clamped)}%`;
};

const appendLog = (line) => {
  logsEl.textContent += `${line}\n`;
  logsEl.scrollTop = logsEl.scrollHeight;
};

const setProfileNotice = (message, type = 'info', persist = false) => {
  if (!profileNoticeEl) {
    return;
  }

  if (profileNoticeTimeout) {
    clearTimeout(profileNoticeTimeout);
    profileNoticeTimeout = null;
  }

  const safeType = ['success', 'error', 'info'].includes(type) ? type : 'info';
  profileNoticeEl.textContent = message;
  profileNoticeEl.classList.remove('notice-success', 'notice-error', 'notice-info');
  profileNoticeEl.classList.add(`notice-${safeType}`);
  profileNoticeEl.classList.add('is-visible');

  if (!persist) {
    profileNoticeTimeout = setTimeout(() => {
      profileNoticeEl.classList.remove('is-visible');
      profileNoticeEl.textContent = '';
    }, 2800);
  }
};

const applyStoredProfileVersion = async (profile) => {
  const targetVersion = profile && typeof profile.version === 'string'
    ? profile.version.trim()
    : '';

  if (!targetVersion) {
    return;
  }

  const hasVersionOption = () => Array.from(versionEl.options).some((opt) => opt.value === targetVersion);

  if (!hasVersionOption()) {
    await loadVersions(targetVersion);
  }

  if (!hasVersionOption() && !includeSnapshotsEl.checked) {
    includeSnapshotsEl.checked = true;
    localStorage.setItem(SNAPSHOTS_STORAGE_KEY, '1');
    await loadVersions(targetVersion);
  }

  if (!hasVersionOption()) {
    setProfileNotice(`Version du profil introuvable: ${targetVersion}`, 'error', true);
    return;
  }

  versionEl.value = targetVersion;
  localStorage.setItem(VERSION_STORAGE_KEY, targetVersion);
};

const getActiveProfile = () => {
  const selectedId = profileSelectEl && profileSelectEl.value
    ? profileSelectEl.value
    : activeProfileId;
  return knownProfiles.find((entry) => entry && entry.id === selectedId) || null;
};

const renderProfiles = (profiles, activeId) => {
  knownProfiles = Array.isArray(profiles) ? profiles : [];
  activeProfileId = activeId || null;

  if (!profileSelectEl) {
    return;
  }

  profileSelectEl.innerHTML = '';

  if (!knownProfiles.length) {
    const fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = 'Aucun profil';
    profileSelectEl.appendChild(fallback);
    profileSelectEl.disabled = true;
    if (deleteProfileBtn) {
      deleteProfileBtn.disabled = true;
    }
    return;
  }

  knownProfiles.forEach((profile) => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.name || 'Profil';
    profileSelectEl.appendChild(option);
  });

  const hasActive = knownProfiles.some((entry) => entry.id === activeProfileId);
  profileSelectEl.value = hasActive ? activeProfileId : knownProfiles[0].id;
  activeProfileId = profileSelectEl.value;
  profileSelectEl.disabled = false;

  if (deleteProfileBtn) {
    deleteProfileBtn.disabled = knownProfiles.length <= 1;
  }
};

const applyActiveProfileToForm = () => {
  const profile = getActiveProfile();

  if (!profile) {
    if (profileNameEl) {
      profileNameEl.value = '';
    }
    if (profileGameDirectoryEl) {
      profileGameDirectoryEl.value = '';
    }
    if (activeProfileLabelEl) {
      activeProfileLabelEl.textContent = 'Aucun profil';
    }
    return null;
  }

  if (profileNameEl) {
    profileNameEl.value = profile.name || '';
  }

  if (profileGameDirectoryEl) {
    profileGameDirectoryEl.value = profile.gameDirectory || '';
  }

  if (activeProfileLabelEl) {
    activeProfileLabelEl.textContent = profile.name || 'Profil';
  }

  return profile;
};

const persistActiveProfile = async ({ showStatus = false } = {}) => {
  const profile = getActiveProfile();
  if (!profile) {
    return false;
  }

  const payload = {
    id: profile.id,
    setActive: true,
    name: profileNameEl ? profileNameEl.value : profile.name,
    gameDirectory: profileGameDirectoryEl ? profileGameDirectoryEl.value : profile.gameDirectory
  };

  const result = await window.mcLauncher.updateProfile(payload);
  if (!result || !result.ok) {
    if (showStatus) {
      statusEl.textContent = result && result.message ? result.message : 'Impossible d\'enregistrer le profil.';
    }
    setProfileNotice(result && result.message ? result.message : 'Impossible d\'enregistrer le profil.', 'error');
    return false;
  }

  renderProfiles(result.profiles || [], result.activeProfileId || null);
  applyActiveProfileToForm();
  if (showStatus) {
    statusEl.textContent = 'Profil mis à jour.';
  }
  setProfileNotice('Profil enregistré avec succès.', 'success');
  return true;
};

const setMicrosoftConnected = (connected, profileName) => {
  microsoftConnected = connected;
  if (msStatusEl) {
    msStatusEl.textContent = connected ? `Connecté (${profileName || 'Microsoft'})` : 'Non connecté';
  }

  if (accountIdentityEl) {
    if (connected) {
      accountIdentityEl.classList.remove('is-offline');
    } else {
      accountIdentityEl.classList.add('is-offline');
    }
  }
};

const renderAccounts = (accounts, activeAccountId) => {
  knownAccounts = Array.isArray(accounts) ? accounts : [];
  knownActiveAccountId = activeAccountId || null;
  msAccountSelectEl.innerHTML = '';

  if (!Array.isArray(accounts) || !accounts.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Aucun compte';
    msAccountSelectEl.appendChild(option);
    msAccountSelectEl.value = '';
    msAccountSelectEl.disabled = true;
    msLogoutBtn.disabled = true;
    hideAccountIdentity();
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
  knownActiveAccountId = msAccountSelectEl.value;
  msAccountSelectEl.disabled = false;
  msLogoutBtn.disabled = false;
  renderAccountIdentity();
};

const applyAccountResponse = (result) => {
  knownProfile = result && result.profile ? result.profile : null;
  renderAccounts(result.accounts || [], result.activeAccountId || null);

  if (result.profile && result.activeAccountId) {
    setMicrosoftConnected(true, result.profile.name);
    return;
  }

  if ((result.accounts || []).length > 0) {
    microsoftConnected = false;
    if (msStatusEl) {
      msStatusEl.textContent = 'Comptes sauvegardés (sélectionne un compte).';
    }
    renderAccountIdentity();
    return;
  }

  setMicrosoftConnected(false);
  hideAccountIdentity();
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

window.mcLauncher.onUpdate((event) => {
  const type = event && event.type ? event.type : 'unknown';

  if (type === 'checking') {
    updateStatusEl.textContent = 'Vérification en cours...';
    return;
  }

  if (type === 'available') {
    const version = event && event.version ? event.version : 'nouvelle version';
    updateStatusEl.textContent = `Mise à jour disponible (${version}), téléchargement...`;
    appendLog(`[update] Mise à jour détectée: ${version}`);
    return;
  }

  if (type === 'download-progress') {
    const percent = Math.max(0, Math.min(100, Number(event && event.percent ? event.percent : 0)));
    updateStatusEl.textContent = `Téléchargement mise à jour: ${Math.round(percent)}%`;
    return;
  }

  if (type === 'downloaded') {
    updateReady = true;
    const version = event && event.version ? event.version : 'nouvelle version';
    updateStatusEl.textContent = `Prêt à installer (${version})`;
    installUpdateBtn.hidden = false;
    appendLog('[update] Mise à jour téléchargée et prête à être installée.');
    return;
  }

  if (type === 'none') {
    updateStatusEl.textContent = 'Launcher à jour';
    appendLog('[update] Aucune mise à jour disponible.');
    return;
  }

  if (type === 'disabled') {
    updateStatusEl.textContent = event && event.message ? event.message : 'Mise à jour auto indisponible.';
    appendLog(`[update] ${updateStatusEl.textContent}`);
    return;
  }

  if (type === 'error') {
    const message = event && event.message ? event.message : 'Erreur inconnue.';
    updateStatusEl.textContent = `Erreur update: ${message}`;
    appendLog(`[update:error] ${message}`);
  }
});

checkUpdateBtn.addEventListener('click', async () => {
  checkUpdateBtn.disabled = true;

  try {
    const result = await window.mcLauncher.checkForUpdates();
    if (!result.ok) {
      updateStatusEl.textContent = result.message || 'Vérification impossible.';
      appendLog(`[update] ${result.message || 'Vérification impossible.'}`);
    } else {
      updateStatusEl.textContent = 'Vérification lancée...';
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    updateStatusEl.textContent = `Erreur update: ${message}`;
    appendLog(`[update:error] ${message}`);
  } finally {
    checkUpdateBtn.disabled = false;
  }
});

installUpdateBtn.addEventListener('click', async () => {
  if (!updateReady) {
    return;
  }

  installUpdateBtn.disabled = true;

  try {
    const result = await window.mcLauncher.installUpdateNow();
    updateStatusEl.textContent = result.message || 'Installation de la mise à jour...';
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    updateStatusEl.textContent = `Erreur update: ${message}`;
    appendLog(`[update:error] ${message}`);
    installUpdateBtn.disabled = false;
  }
});

const setSettingsModalOpen = (open) => {
  if (!settingsModal || !settingsBtn) {
    return;
  }

  if (open) {
    settingsModal.classList.add('is-open');
    settingsModal.setAttribute('aria-hidden', 'false');
    settingsBtn.setAttribute('aria-expanded', 'true');
    settingsBtn.classList.add('is-open');
    settingsBtn.textContent = 'Paramètres';
    return;
  }

  settingsModal.classList.remove('is-open');
  settingsModal.setAttribute('aria-hidden', 'true');
  settingsBtn.setAttribute('aria-expanded', 'false');
  settingsBtn.classList.remove('is-open');
  settingsBtn.textContent = 'Paramètres';
};

const setProfileSettingsModalOpen = (open) => {
  if (!profileSettingsModal || !openProfileSettingsBtn) {
    return;
  }

  if (open) {
    profileSettingsModal.classList.add('is-open');
    profileSettingsModal.setAttribute('aria-hidden', 'false');
    openProfileSettingsBtn.setAttribute('aria-expanded', 'true');
    return;
  }

  profileSettingsModal.classList.remove('is-open');
  profileSettingsModal.setAttribute('aria-hidden', 'true');
  openProfileSettingsBtn.setAttribute('aria-expanded', 'false');
};

setSettingsModalOpen(false);
setProfileSettingsModalOpen(false);

settingsBtn.addEventListener('click', () => {
  const isOpen = settingsModal.classList.contains('is-open');
  setSettingsModalOpen(!isOpen);
});

if (openProfileSettingsBtn) {
  openProfileSettingsBtn.addEventListener('click', () => {
    const isOpen = profileSettingsModal && profileSettingsModal.classList.contains('is-open');
    setProfileSettingsModalOpen(!isOpen);
    if (!isOpen) {
      setProfileNotice('Configure ton profil puis clique sur Confirmer.', 'info', true);
    }
  });
}

if (closeSettingsBtn) {
  closeSettingsBtn.addEventListener('click', () => {
    setSettingsModalOpen(false);
  });
}

if (authorGithubLinkEl) {
  authorGithubLinkEl.addEventListener('click', async (event) => {
    event.preventDefault();

    const result = await window.mcLauncher.openExternalLink(authorGithubLinkEl.href);
    if (!result || !result.ok) {
      statusEl.textContent = result && result.message ? result.message : 'Impossible d\'ouvrir le lien GitHub.';
    }
  });
}

if (closeProfileSettingsBtn) {
  closeProfileSettingsBtn.addEventListener('click', () => {
    setProfileSettingsModalOpen(false);
  });
}

settingsModal.addEventListener('click', (event) => {
  if (event.target === settingsModal) {
    setSettingsModalOpen(false);
  }
});

if (profileSettingsModal) {
  profileSettingsModal.addEventListener('click', (event) => {
    if (event.target === profileSettingsModal) {
      setProfileSettingsModalOpen(false);
    }
  });
}

if (settingsWindow) {
  settingsWindow.addEventListener('click', (event) => {
    event.stopPropagation();
  });
}

if (profileSettingsWindow) {
  profileSettingsWindow.addEventListener('click', (event) => {
    event.stopPropagation();
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && settingsModal.classList.contains('is-open')) {
    setSettingsModalOpen(false);
    return;
  }

  if (event.key === 'Escape' && profileSettingsModal && profileSettingsModal.classList.contains('is-open')) {
    setProfileSettingsModalOpen(false);
  }
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
    hideAccountIdentity();
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

if (profileSelectEl) {
  profileSelectEl.addEventListener('change', async () => {
    const profileId = profileSelectEl.value;
    if (!profileId) {
      return;
    }

    const result = await window.mcLauncher.updateProfile({ id: profileId, setActive: true });
    if (!result || !result.ok) {
      statusEl.textContent = result && result.message ? result.message : 'Impossible de sélectionner le profil.';
      setProfileNotice(result && result.message ? result.message : 'Impossible de sélectionner le profil.', 'error');
      return;
    }

    renderProfiles(result.profiles || [], result.activeProfileId || null);
    const profile = applyActiveProfileToForm();
    statusEl.textContent = `Profil actif: ${profile?.name || 'Profil'}`;
    setProfileNotice(`Profil actif: ${profile?.name || 'Profil'}`, 'success');
    await applyStoredProfileVersion(profile);
  });
}

if (newProfileBtn) {
  newProfileBtn.addEventListener('click', async () => {
    const suggestedName = `Profil ${knownProfiles.length + 1}`;
    const result = await window.mcLauncher.createProfile(suggestedName);
    if (!result || !result.ok) {
      statusEl.textContent = result && result.message ? result.message : 'Création du profil impossible.';
      setProfileNotice(result && result.message ? result.message : 'Création du profil impossible.', 'error');
      return;
    }

    renderProfiles(result.profiles || [], result.activeProfileId || null);
    const profile = applyActiveProfileToForm();
    statusEl.textContent = `Profil créé: ${profile?.name || 'Nouveau profil'}`;
    setProfileNotice(`Profil créé: ${profile?.name || 'Nouveau profil'}`, 'success');
    await applyStoredProfileVersion(profile);
  });
}

if (saveProfileBtn) {
  saveProfileBtn.addEventListener('click', async () => {
    await persistActiveProfile({ showStatus: true });
  });
}

if (deleteProfileBtn) {
  deleteProfileBtn.addEventListener('click', async () => {
    const profile = getActiveProfile();
    if (!profile) {
      return;
    }

    const shouldDelete = window.confirm(`Supprimer le profil "${profile.name}" ?`);
    if (!shouldDelete) {
      return;
    }

    const shouldDeleteDirectory = window.confirm(
      `Supprimer aussi le dossier du profil ?\n\n${profile.gameDirectory || ''}`
    );

    const result = await window.mcLauncher.deleteProfile({
      id: profile.id,
      deleteGameDirectory: shouldDeleteDirectory
    });
    if (!result || !result.ok) {
      statusEl.textContent = result && result.message ? result.message : 'Suppression impossible.';
      setProfileNotice(result && result.message ? result.message : 'Suppression impossible.', 'error');
      return;
    }

    renderProfiles(result.profiles || [], result.activeProfileId || null);
    const updatedProfile = applyActiveProfileToForm();
    statusEl.textContent = 'Profil supprimé.';
    setProfileNotice(
      shouldDeleteDirectory ? 'Profil et dossier supprimés.' : 'Profil supprimé (dossier conservé).',
      'success'
    );
    if (updatedProfile) {
      await applyStoredProfileVersion(updatedProfile);
    } else {
      await loadVersions(versionEl.value || localStorage.getItem(VERSION_STORAGE_KEY));
    }
  });
}

if (browseProfileFolderBtn) {
  browseProfileFolderBtn.addEventListener('click', async () => {
    const initialPath = profileGameDirectoryEl ? profileGameDirectoryEl.value : '';
    const result = await window.mcLauncher.chooseProfileFolder(initialPath);
    if (!result || result.canceled) {
      return;
    }

    if (!result.ok || !result.path) {
      statusEl.textContent = result && result.message ? result.message : 'Dossier invalide.';
      setProfileNotice(result && result.message ? result.message : 'Dossier invalide.', 'error');
      return;
    }

    if (profileGameDirectoryEl) {
      profileGameDirectoryEl.value = result.path;
    }
    setProfileNotice('Dossier du profil modifié.', 'info', true);
    await persistActiveProfile({ showStatus: true });
  });
}

if (confirmProfileSettingsBtn) {
  confirmProfileSettingsBtn.addEventListener('click', async () => {
    confirmProfileSettingsBtn.disabled = true;
    const ok = await persistActiveProfile({ showStatus: true });
    if (ok) {
      setProfileNotice('Profil confirmé.', 'success');
      setProfileSettingsModalOpen(false);
    }
    confirmProfileSettingsBtn.disabled = false;
  });
}

versionEl.addEventListener('change', () => {
  if (versionEl.value) {
    localStorage.setItem(VERSION_STORAGE_KEY, versionEl.value);
  }

  void persistActiveProfile();
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
    disableGameConsole: disableGameConsoleEl.checked,
    closeLauncherOnStart: closeLauncherOnStartEl.checked,
    accountId: msAccountSelectEl.value || null,
    gameDirectory: profileGameDirectoryEl ? profileGameDirectoryEl.value : null
  };

  localStorage.setItem(RAM_STORAGE_KEY, String(payload.memoryMb));
  localStorage.setItem(CONSOLE_STORAGE_KEY, payload.disableGameConsole ? '1' : '0');
  localStorage.setItem(CLOSE_LAUNCHER_STORAGE_KEY, payload.closeLauncherOnStart ? '1' : '0');
  localStorage.setItem(VERSION_STORAGE_KEY, payload.version);

  const activeProfile = getActiveProfile();
  if (activeProfile && activeProfile.id && payload.version) {
    try {
      const profileUpdate = await window.mcLauncher.updateProfile({
        id: activeProfile.id,
        setActive: true,
        version: payload.version
      });

      if (profileUpdate && profileUpdate.ok) {
        renderProfiles(profileUpdate.profiles || [], profileUpdate.activeProfileId || null);
        applyActiveProfileToForm();
      }
    } catch {
    }
  }

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
    const targetPath = profileGameDirectoryEl ? profileGameDirectoryEl.value : null;
    const result = await window.mcLauncher.openGameFolder(targetPath);
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

const loadProfiles = async () => {
  try {
    const result = await window.mcLauncher.listProfiles();
    if (!result || !result.ok) {
      statusEl.textContent = result && result.message ? result.message : 'Chargement des profils impossible.';
      return null;
    }

    renderProfiles(result.profiles || [], result.activeProfileId || null);
    return applyActiveProfileToForm();
  } catch {
    statusEl.textContent = 'Chargement des profils impossible.';
    return null;
  }
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

const loadLauncherVersion = async () => {
  if (!launcherVersionEl) {
    return;
  }

  try {
    const result = await window.mcLauncher.getAppVersion();
    if (result && result.ok && result.version) {
      launcherVersionEl.textContent = `v${result.version}`;
      return;
    }
  } catch {
  }

  launcherVersionEl.textContent = 'v?';
};

restoreRamPreference();
restoreConsolePreference();
restoreCloseLauncherPreference();
restoreSnapshotPreference();
setProgress(0, 'Progression: 0%');

const initializeRenderer = async () => {
  await loadLauncherVersion();
  await loadProfiles();
  await loadVersions();
  await applyStoredProfileVersion(getActiveProfile());
  await tryRestoreMicrosoftSession();
};

void initializeRenderer();
