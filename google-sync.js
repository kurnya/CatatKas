/* ──────────────────────────────────────────────
   CatatKas – Google Sheets Sync Module
   Syncs transactions, sub-categories, and payment
   methods to the user's own Google Spreadsheet.
   ────────────────────────────────────────────── */

// ── CONFIG ────────────────────────────────────
// Replace this with your own OAuth 2.0 Client ID from Google Cloud Console
const GOOGLE_CLIENT_ID = "591977207769-epc99j316gtokb9g8bqatjvk3acepg5h.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const SPREADSHEET_NAME = "CatatKas – Data Keuangan";
const SYNC_META_KEY = "catatkas_sync_meta";
const SYNC_TOKEN_KEY = "catatkas_sync_token";
const TOKEN_REFRESH_ERROR_MESSAGE = "Sesi Google perlu diperbarui. Tekan Masuk dengan Google untuk menyambungkan ulang.";

// ── STATE ─────────────────────────────────────
let _tokenClient = null;
let _accessToken = null;
let _tokenExpiry = 0;
let _userEmail = null;
let _spreadsheetId = null;
let _syncInProgress = false;
let _autoSyncEnabled = false;
let _autoSyncTimer = null;
let _lastSyncTime = null;
let _lastPushTime = null;
let _lastSyncedTransactionIds = new Set(); // Track which transactions were last synced
let _discoveryPromise = null; // Lock to prevent concurrent discovery calls
let _lastKnownSheetModified = null; // Last known spreadsheet modifiedTime from Google server
let _lastSyncedSubCategoriesSignature = null;
let _lastSyncedPaymentMethodsSignature = null;

// ── CALLBACKS (set by app.js) ─────────────────
let _onSyncStateChange = null;   // (isSyncing: bool) => void
let _onSyncComplete = null;      // (direction: 'push'|'pull', success: bool, msg: string) => void
let _onAuthChange = null;        // (isSignedIn: bool) => void
let _onDataMerge = null;         // (data: {transactions, subCategories, paymentMethods}) => void

// ── PUBLIC API ────────────────────────────────

function initGoogleSync(callbacks) {
  _onSyncStateChange = callbacks.onSyncStateChange || null;
  _onSyncComplete = callbacks.onSyncComplete || null;
  _onAuthChange = callbacks.onAuthChange || null;
  _onDataMerge = callbacks.onDataMerge || null;

  // Restore saved state
  try {
    const meta = JSON.parse(localStorage.getItem(SYNC_META_KEY) || "{}");
    _spreadsheetId = meta.spreadsheetId || null;
    _lastSyncTime = meta.lastSyncTime || null;
    _lastPushTime = meta.lastPushTime || meta.lastSyncTime || null;
    _autoSyncEnabled = meta.autoSyncEnabled !== undefined ? meta.autoSyncEnabled : (meta.autoSyncInterval && meta.autoSyncInterval !== "off");
    _lastKnownSheetModified = meta.lastKnownSheetModified || null;
    _lastSyncedSubCategoriesSignature = meta.lastSyncedSubCategoriesSignature || null;
    _lastSyncedPaymentMethodsSignature = meta.lastSyncedPaymentMethodsSignature || null;
    
    // Restore synced transaction IDs for differential sync
    if (meta.lastSyncedTransactionIds && Array.isArray(meta.lastSyncedTransactionIds)) {
      _lastSyncedTransactionIds = new Set(meta.lastSyncedTransactionIds);
      console.log(`[Sync] Restored ${_lastSyncedTransactionIds.size} synced transaction IDs`);
    }

    // Restore token (survives hard refresh) — restore even if expired
    const saved = JSON.parse(localStorage.getItem(SYNC_TOKEN_KEY) || "{}");
    if (saved.token) {
      _accessToken = saved.token;
      _tokenExpiry = saved.expiry || 0;
      _userEmail = saved.email || null;
    }
  } catch { /* ignore */ }

  // If we have a saved token, consider user signed in (even if expired)
  // Token will be silently refreshed when needed
  if (_accessToken) {
    _onAuthChange?.(true);
    if (_autoSyncEnabled) setAutoSyncEnabled(true);
  }

  _initGoogleIdentityServices();
}

// Called after GIS script loads — handles token refresh and discovery
function _onGisReady() {
  if (!_accessToken) return;

  if (Date.now() >= _tokenExpiry) {
    console.log("[Sync] Restored token expired, attempting silent refresh...");
    _trySilentRefresh()
      .then(() => {
        console.log("[Sync] Silent refresh succeeded");
        if (!_spreadsheetId) {
          console.log("[Sync] No spreadsheet ID — triggering background discovery...");
          _discoverExistingSpreadsheet();
        }
      })
      .catch((err) => {
        console.warn("[Sync] Silent refresh failed:", err?.message || err);
        console.log("[Sync] Marking as disconnected — user must sign in again");
        _onAuthChange?.(false);
      });
  } else {
    console.log("[Sync] Restored token still valid");
    if (!_spreadsheetId) {
      console.log("[Sync] No spreadsheet ID — triggering background discovery...");
      _discoverExistingSpreadsheet();
    }
  }
}

function isSignedIn() {
  // Return true if we have any token (even expired) — it can likely be refreshed silently
  return !!_accessToken;
}

function _isTokenValid() {
  return _accessToken && Date.now() < _tokenExpiry;
}

function getUserEmail() {
  return _userEmail;
}

function getSpreadsheetUrl() {
  return _spreadsheetId ? `https://docs.google.com/spreadsheets/d/${_spreadsheetId}` : null;
}

function getLastSyncTime() {
  return _lastSyncTime;
}

function isAutoSyncEnabled() {
  return _autoSyncEnabled;
}

function setAutoSyncEnabled(enabled) {
  _autoSyncEnabled = !!enabled;
  _saveSyncMeta();
  if (_autoSyncEnabled) {
    _scheduleAutoSync();
  } else {
    _clearAutoSyncTimer();
  }
}

// Full pull from sheet — replaces local state entirely (sheet is source of truth).
// Call this BEFORE applying any local change (add/edit/delete) so that:
// - Remote deletions are reflected locally
// - Remote additions are pulled in
// - Unsynced local transactions (created offline) are preserved
// - Then the local action is applied on top of the fresh data
async function syncBeforeAction() {
  if (!isSignedIn() || !_spreadsheetId) return;
  if (_syncInProgress) return;
  // Skip if offline — preserve all local data
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    console.log("[Sync] Offline, skipping syncBeforeAction");
    return;
  }

  try {
    await _ensureValidToken();

    // Track unsynced local transactions BEFORE pulling
    // These are transactions created locally but not yet pushed to the sheet
    let unsyncedTransactions = [];
    try {
      const localState = JSON.parse(localStorage.getItem("catatan_keuangan_pwa_v1") || "{}");
      if (localState.transactions && Array.isArray(localState.transactions)) {
        unsyncedTransactions = localState.transactions.filter(
          tx => tx.id && !_lastSyncedTransactionIds.has(tx.id)
        );
      }
    } catch { /* ignore */ }

    const transactions = await _readTransactions();
    const subCategories = await _readSubCategories();
    const paymentMethods = await _readPaymentMethods();
    _lastSyncedSubCategoriesSignature = _getSubCategoriesSignature(subCategories);
    _lastSyncedPaymentMethodsSignature = _getPaymentMethodsSignature(paymentMethods);

    if (_onDataMerge && typeof _onDataMerge === "function") {
      // Sheet data + unsynced local transactions (preserves offline-created data)
      const sheetById = new Map((transactions || []).map(tx => [tx.id, tx]));
      for (const tx of unsyncedTransactions) {
        if (!sheetById.has(tx.id)) {
          sheetById.set(tx.id, tx);
          console.log(`[Sync] Preserved unsynced local transaction: ${tx.id}`);
        }
      }
      const mergedTransactions = Array.from(sheetById.values());

      _onDataMerge({ transactions: mergedTransactions, subCategories, paymentMethods });
      _lastSyncedTransactionIds = new Set((transactions || []).map(tx => tx.id));
    }

    // Update baseline
    try {
      const modTime = await _getSheetModifiedTime();
      if (modTime) _lastKnownSheetModified = modTime;
    } catch { /* ignore */ }
    _lastSyncTime = new Date().toISOString();
    _saveSyncMeta();
  } catch (err) {
    console.warn("[Sync] syncBeforeAction failed, proceeding with local state:", err);
  }
}

const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

function signIn() {
  if (!window.google?.accounts?.oauth2) {
    _onSyncComplete?.("auth", false, "Layanan Google belum tersedia.");
    return;
  }
  if (!_tokenClient) {
    _tokenClient = _createTokenClient(
      (response) => _handleTokenResponse(response),
      (err) => {
        console.error("[Sync] Auth error:", err);
        _onSyncComplete?.("auth", false, "Gagal masuk ke akun Google. Silakan coba lagi.");
      }
    );
  }
  _tokenClient.requestAccessToken({ prompt: "" });
}

function signOut() {
  if (_accessToken) {
    google.accounts.oauth2.revoke(_accessToken, () => {});
  }
  _accessToken = null;
  _tokenExpiry = 0;
  _userEmail = null;
  _spreadsheetId = null;
  _lastSyncTime = null;
  _lastPushTime = null;
  _autoSyncEnabled = false;
  _lastSyncedTransactionIds.clear(); // Clear synced IDs
  _lastSyncedSubCategoriesSignature = null;
  _lastSyncedPaymentMethodsSignature = null;
  localStorage.removeItem(SYNC_META_KEY);
  localStorage.removeItem(SYNC_TOKEN_KEY);
  setAutoSyncEnabled(false);
  _onAuthChange?.(false);
}

async function pushToSheets(appState, silent = false) {
  if (!isSignedIn()) {
    if (!silent) _onSyncComplete?.("push", false, "Anda belum masuk ke akun Google.");
    return false;
  }
  if (_syncInProgress) {
    console.log("[Sync] Push already in progress, skipping");
    return false;
  }
  _syncInProgress = true;
  if (!silent) _onSyncStateChange?.(true);
  
  const txCount = (appState.transactions || []).length;
  console.log(`[Sync] Starting push: ${txCount} transactions (silent: ${silent})`);

  try {
    // Pastikan token valid (akan auto-refresh jika expired)
    await _ensureValidToken();
    
    await _ensureSpreadsheet();

    console.log("[Sync] Writing transactions to spreadsheet...");
    await _writeTransactions(appState.transactions || []);
    const subCategories = appState.subCategories || {};
    const subCategoriesSignature = _getSubCategoriesSignature(subCategories);
    if (subCategoriesSignature !== _lastSyncedSubCategoriesSignature) {
      console.log("[Sync] Writing sub-categories...");
      await _writeSubCategories(subCategories);
      _lastSyncedSubCategoriesSignature = subCategoriesSignature;
    } else {
      console.log("[Sync] Sub-categories unchanged, skipping rewrite");
    }

    const paymentMethods = appState.paymentMethods || [];
    const paymentMethodsSignature = _getPaymentMethodsSignature(paymentMethods);
    if (paymentMethodsSignature !== _lastSyncedPaymentMethodsSignature) {
      console.log("[Sync] Writing payment methods...");
      await _writePaymentMethods(paymentMethods);
      _lastSyncedPaymentMethodsSignature = paymentMethodsSignature;
    } else {
      console.log("[Sync] Payment methods unchanged, skipping rewrite");
    }
    console.log("[Sync] Writing metadata...");
    await _writeMetadata(appState);

    // Apply formatting (borders, headers, column widths) — non-critical
    await _applySheetFormatting();

    const syncedAt = new Date().toISOString();
    _lastSyncTime = syncedAt;
    _lastPushTime = syncedAt;

    // Store authoritative sheet modifiedTime from server to avoid false positives
    try {
      const modTime = await _getSheetModifiedTime();
      if (modTime) _lastKnownSheetModified = modTime;
    } catch { /* ignore */ }

    _saveSyncMeta();
    _scheduleAutoSync();
    
    console.log("[Sync] Push completed successfully");
    if (!silent) _onSyncComplete?.("push", true, "Data berhasil disimpan ke Google Spreadsheet.");
    return true;
  } catch (err) {
    console.error("[Sync] Push error:", err);
    
    // If differential sync fails, try full rewrite as fallback
    if (err.message && (err.message.includes("batchUpdate") || err.message.includes("range"))) {
      console.warn("[Sync] Differential sync failed, attempting full rewrite fallback...");
      try {
        await _fullWriteTransactions(appState.transactions || []);
        _lastSyncedTransactionIds = new Set((appState.transactions || []).map(tx => tx.id));
        
        const syncedAt = new Date().toISOString();
        _lastSyncTime = syncedAt;
        _lastPushTime = syncedAt;
        _saveSyncMeta();
        
        console.log("[Sync] Full rewrite fallback succeeded");
        if (!silent) _onSyncComplete?.("push", true, "Data berhasil disimpan ke Google Spreadsheet.");
        return true;
      } catch (fallbackErr) {
        console.error("[Sync] Full rewrite fallback also failed:", fallbackErr);
        err = fallbackErr; // Use fallback error for handling below
      }
    }
    
    // Jika token refresh gagal dan ini silent mode, jangan langsung disconnect
    // Biarkan user tetap "terhubung" dan akan retry lagi di transaksi berikutnya
    if (_isAuthRefreshError(err)) {
      if (!silent) {
        _markTokenRefreshRequired();
        _onSyncComplete?.("push", false, TOKEN_REFRESH_ERROR_MESSAGE);
      } else {
        console.warn("[Sync] Token refresh failed in silent mode, will retry on next transaction");
      }
    } else if (!silent) {
      const msg = err?.message || "Gagal menyimpan data ke Google Spreadsheet.";
      _onSyncComplete?.("push", false, msg);
    }
    
    return false;
  } finally {
    _syncInProgress = false;
    if (silent) _scheduleAutoSyncRetry();
    if (!silent) _onSyncStateChange?.(false);
  }
}

// Ensure spreadsheet is discovered before operations that require it.
// Uses a promise lock to prevent concurrent discovery calls.
async function _ensureSpreadsheetDiscovered() {
  if (_spreadsheetId) return true;
  if (!isSignedIn()) return false;

  // Reuse in-flight discovery if already running
  if (_discoveryPromise) {
    await _discoveryPromise;
    return !!_spreadsheetId;
  }

  try {
    await _ensureValidToken();
  } catch {
    return false;
  }

  _discoveryPromise = (async () => {
    try {
      console.log("[Discover] Searching for CatatKas spreadsheet in Google Drive...");

      const query = encodeURIComponent(`mimeType='application/vnd.google-apps.spreadsheet' and name='${SPREADSHEET_NAME}' and trashed=false`);
      const url = `${DRIVE_API}?q=${query}&fields=files(id,name,createdTime,modifiedTime)&orderBy=modifiedTime desc&pageSize=5`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${_accessToken}` }
      });

      if (!res.ok) {
        console.warn("[Discover] Failed to search Drive:", res.status);
        return;
      }

      const data = await res.json();
      const files = data.files || [];

      if (files.length === 0) {
        console.log("[Discover] No existing CatatKas spreadsheet found.");
        return;
      }

      const spreadsheet = files[0];
      _spreadsheetId = spreadsheet.id;
      _saveSyncMeta();

      console.log(`[Discover] Found existing spreadsheet: ${spreadsheet.name} (${spreadsheet.id})`);
      _onAuthChange?.(true);
    } catch (err) {
      console.warn("[Discover] Error searching for spreadsheet:", err);
    }
  })();

  await _discoveryPromise;
  _discoveryPromise = null;
  return !!_spreadsheetId;
}

async function pullFromSheets() {
  if (!isSignedIn()) {
    _onSyncComplete?.("pull", false, "Anda belum masuk ke akun Google.");
    return null;
  }
  if (_syncInProgress) return null;

  // Auto-discover spreadsheet if not yet known (e.g. new device)
  if (!_spreadsheetId) {
    console.log("[Sync] No spreadsheet ID, attempting discovery before pull...");
    _syncInProgress = true;
    _onSyncStateChange?.(true);
    try {
      const found = await _ensureSpreadsheetDiscovered();
      if (!found) {
        _onSyncComplete?.("pull", false, "Belum ada Spreadsheet terhubung. Kirim data terlebih dahulu.");
        return null;
      }
      // Auto-pull data from the newly discovered spreadsheet
      await _autoPullFromDiscoveredSpreadsheet();
      _onSyncComplete?.("pull", true, "Spreadsheet ditemukan dan data berhasil dimuat.");
    } catch (err) {
      console.error("[Sync] Discovery/pull error:", err);
      _onSyncComplete?.("pull", false, "Gagal memuat data dari Spreadsheet.");
    } finally {
      _syncInProgress = false;
      _onSyncStateChange?.(false);
    }
    return null;
  }
  _syncInProgress = true;
  _onSyncStateChange?.(true);

  try {
    // Pastikan token valid (akan auto-refresh jika expired)
    await _ensureValidToken();
    
    const transactions = await _readTransactions();
    const subCategories = await _readSubCategories();
    const paymentMethods = await _readPaymentMethods();
    _lastSyncedSubCategoriesSignature = _getSubCategoriesSignature(subCategories);
    _lastSyncedPaymentMethodsSignature = _getPaymentMethodsSignature(paymentMethods);

    _lastSyncTime = new Date().toISOString();
    // Update sheet modified baseline after pull
    try {
      const modTime = await _getSheetModifiedTime();
      if (modTime) _lastKnownSheetModified = modTime;
    } catch { /* ignore */ }
    _saveSyncMeta();
    _onSyncComplete?.("pull", true, "Data berhasil dimuat dari Google Spreadsheet.");
    return { transactions, subCategories, paymentMethods };
  } catch (err) {
    console.error("[Sync] Pull error:", err);
    if (_isAuthRefreshError(err)) _markTokenRefreshRequired();
    const msg = _isAuthRefreshError(err)
      ? TOKEN_REFRESH_ERROR_MESSAGE
      : err?.message || "Gagal memuat data dari Google Spreadsheet.";
    _onSyncComplete?.("pull", false, msg);
    return null;
  } finally {
    _syncInProgress = false;
    _onSyncStateChange?.(false);
  }
}

// ── INTERNAL: Auth ────────────────────────────

function _initGoogleIdentityServices() {
  // Wait for GIS script to load
  if (window.google?.accounts?.oauth2) {
    _tokenClient = _createTokenClient(
      (response) => _handleTokenResponse(response),
      (err) => {
        console.error("[Sync] Auth error:", err);
      }
    );
    // GIS is ready — handle token refresh and discovery
    _onGisReady();
    return;
  }
  // Retry after a short delay if GIS hasn't loaded yet
  setTimeout(() => _initGoogleIdentityServices(), 500);
}

function _createTokenClient(callback, error_callback) {
  const config = {
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPES,
    callback,
    error_callback
  };
  if (_userEmail) config.login_hint = _userEmail;
  return google.accounts.oauth2.initTokenClient(config);
}

function _handleTokenResponse(response) {
  if (response.error) {
    console.error("[Sync] Token error:", response.error);
    _onSyncComplete?.("auth", false, "Gagal memverifikasi akun Google.");
    return;
  }
  _accessToken = response.access_token;
  _tokenExpiry = Date.now() + ((response.expires_in || 3600) - 300) * 1000;

  // Persist token so it survives hard refresh
  _persistToken();

  _onAuthChange?.(true);

  // Fetch user email in background
  _fetchUserEmail();

  // Start auto-sync if enabled
  if (_autoSyncEnabled) {
    setAutoSyncEnabled(true);
  }
  
  // Auto-discover existing spreadsheet for this account
  if (!_spreadsheetId) {
    console.log("[Sync] No spreadsheet ID found, searching for existing CatatKas spreadsheet...");
    _discoverExistingSpreadsheet();
  }
}

function _persistToken() {
  localStorage.setItem(SYNC_TOKEN_KEY, JSON.stringify({
    token: _accessToken,
    expiry: _tokenExpiry,
    email: _userEmail
  }));
}

async function _fetchUserEmail() {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${_accessToken}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.email) {
        _userEmail = data.email;
        _persistToken();
        _onAuthChange?.(true); // Re-trigger UI update with email
      }
    }
  } catch (e) {
    console.warn("[Sync] Failed to fetch user email:", e);
  }
}

// Auto-discover existing CatatKas spreadsheet using Drive API.
// Delegates to _ensureSpreadsheetDiscovered (shared lock) and auto-pulls if found.
async function _discoverExistingSpreadsheet() {
  try {
    const found = await _ensureSpreadsheetDiscovered();
    if (found) {
      console.log("[Discover] Auto-pulling data from discovered spreadsheet...");
      _autoPullFromDiscoveredSpreadsheet();
    } else {
      console.log("[Discover] No existing CatatKas spreadsheet found. Will create new one on first push.");
    }
  } catch (err) {
    console.warn("[Discover] Error discovering spreadsheet:", err);
  }
}

// Auto-pull data when spreadsheet is discovered on new device
async function _autoPullFromDiscoveredSpreadsheet() {
  try {
    if (!_spreadsheetId) {
      console.log("[Auto-Pull] No spreadsheet ID, skipping");
      return;
    }
    
    console.log("[Auto-Pull] Checking if spreadsheet has data...");
    
    // Read transactions to check if spreadsheet has data
    const result = await _sheetsRequest(
      `/${_spreadsheetId}/values/Transaksi!A2:A?majorDimension=ROWS`
    );
    
    const rows = result.values || [];
    const hasData = rows.some(row => row[0]); // Check if any row has an ID
    
    if (!hasData) {
      console.log("[Auto-Pull] Spreadsheet is empty, no need to pull");
      return;
    }
    
    console.log(`[Auto-Pull] Spreadsheet has ${rows.filter(r => r[0]).length} transactions. Pulling data...`);
    
    // Pull all data
    const transactions = await _readTransactions();
    const subCategories = await _readSubCategories();
    const paymentMethods = await _readPaymentMethods();
    _lastSyncedSubCategoriesSignature = _getSubCategoriesSignature(subCategories);
    _lastSyncedPaymentMethodsSignature = _getPaymentMethodsSignature(paymentMethods);
    
    // Trigger callback to merge data in app.js
    if (_onDataMerge && typeof _onDataMerge === "function") {
      console.log("[Auto-Pull] Triggering data merge callback...");
      _onDataMerge({ transactions, subCategories, paymentMethods });
    }

    // Update synced transaction IDs so subsequent pushes use differential sync
    // Must include both sheet IDs AND any local-only IDs kept by the merge callback.
    // Without local-only IDs, a deletion of an unsynced transaction would appear as
    // "no change" (6 sheet IDs vs 6 local IDs) instead of detecting the missing one.
    if (transactions && transactions.length > 0) {
      _lastSyncedTransactionIds = new Set(transactions.map(tx => tx.id));
      try {
        const localState = JSON.parse(localStorage.getItem("catatan_keuangan_pwa_v1") || "{}");
        if (localState.transactions && Array.isArray(localState.transactions)) {
          for (const tx of localState.transactions) {
            if (tx.id) _lastSyncedTransactionIds.add(tx.id);
          }
        }
      } catch { /* ignore */ }
      console.log(`[Auto-Pull] Tracked ${_lastSyncedTransactionIds.size} synced transaction IDs (sheet + local)`);
    }

    _lastSyncTime = new Date().toISOString();
    _saveSyncMeta();
    
    console.log("[Auto-Pull] Successfully pulled and merged data from spreadsheet");
    
    // Show success notification (non-silent for first-time pull)
    const txCount = transactions ? transactions.length : 0;
    _onSyncComplete?.("pull", true, `Data berhasil dimuat dari Spreadsheet. ${txCount} transaksi disinkronkan.`);
    
  } catch (err) {
    console.error("[Auto-Pull] Error pulling data:", err);
    // Don't show error to user - not critical
  }
}

// Get the spreadsheet's last modified time from Google Drive API
async function _getSheetModifiedTime() {
  try {
    await _ensureValidToken();
    const res = await fetch(
      `${DRIVE_API}/${_spreadsheetId}?fields=modifiedTime`,
      { headers: { Authorization: `Bearer ${_accessToken}` } }
    );
    if (!res.ok) return null;
    const meta = await res.json();
    return meta.modifiedTime || null;
  } catch {
    return null;
  }
}

async function _ensureValidToken() {
  if (Date.now() >= _tokenExpiry) {
    return _trySilentRefresh();
  }
}

function _trySilentRefresh() {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new Error("Google Identity Services not available"));
      return;
    }
    // Always create a dedicated token client for silent refresh.
    // Reusing _tokenClient would fire its original callback (_handleTokenResponse)
    // instead of resolving this Promise, causing the sync to hang.
    const refreshClient = _createTokenClient(
      (response) => {
        if (response.error) {
          // Don't clear token — might be temporary (network/service issue)
          // User stays "connected" and will retry on next sync
          reject(new Error("Token refresh failed: " + response.error));
        } else {
          _accessToken = response.access_token;
          _tokenExpiry = Date.now() + ((response.expires_in || 3600) - 300) * 1000;
          _persistToken();
          // Fetch email if not already known
          if (!_userEmail) _fetchUserEmail();
          resolve();
        }
      },
      (err) => {
        // Don't clear token — might be temporary
        reject(new Error("Token refresh failed: " + (err?.message || "unknown")));
      }
    );
    refreshClient.requestAccessToken({ prompt: "none" }); // silent, never show account/consent UI
  });
}

function _isAuthRefreshError(err) {
  return (err?.message || "").startsWith("Token refresh failed:");
}

function _markTokenRefreshRequired() {
  _accessToken = null;
  _tokenExpiry = 0;
  localStorage.removeItem(SYNC_TOKEN_KEY);
  _clearAutoSyncTimer();
  _onAuthChange?.(false);
}

// ── INTERNAL: Spreadsheet Management ──────────

function _saveSyncMeta() {
  localStorage.setItem(SYNC_META_KEY, JSON.stringify({
    spreadsheetId: _spreadsheetId,
    lastSyncTime: _lastSyncTime,
    lastPushTime: _lastPushTime,
    autoSyncEnabled: _autoSyncEnabled,
    lastSyncedTransactionIds: [..._lastSyncedTransactionIds],
    lastKnownSheetModified: _lastKnownSheetModified,
    lastSyncedSubCategoriesSignature: _lastSyncedSubCategoriesSignature,
    lastSyncedPaymentMethodsSignature: _lastSyncedPaymentMethodsSignature
  }));
}

function _getSubCategoriesSignature(subCategories) {
  const normalized = {};
  Object.keys(subCategories || {}).sort().forEach(category => {
    normalized[category] = [...(subCategories[category] || [])].sort();
  });
  return JSON.stringify(normalized);
}

function _getPaymentMethodsSignature(methods) {
  return JSON.stringify([...(methods || [])].sort());
}

async function _sheetsRequest(endpoint, options = {}) {
  await _ensureValidToken();
  const url = endpoint.startsWith("http") ? endpoint : `${SHEETS_API}${endpoint}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${_accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Sheets API ${resp.status}: ${body}`);
  }
  return resp.json();
}

async function _ensureSpreadsheet() {
  if (_spreadsheetId) {
    // Verify it still exists
    try {
      await _sheetsRequest(`/${_spreadsheetId}?fields=spreadsheetId`);
      return;
    } catch {
      // Spreadsheet deleted or inaccessible, create new one
      _spreadsheetId = null;
    }
  }

  // Create a new spreadsheet
  const result = await _sheetsRequest("", {
    method: "POST",
    body: JSON.stringify({
      properties: { title: SPREADSHEET_NAME },
      sheets: [
        { properties: { title: "Transaksi" } },
        { properties: { title: "Subkategori" } },
        { properties: { title: "Metode Pembayaran" } },
        { properties: { title: "Metadata" } }
      ]
    })
  });

  _spreadsheetId = result.spreadsheetId;
  _lastSyncedSubCategoriesSignature = null;
  _lastSyncedPaymentMethodsSignature = null;
  _saveSyncMeta();

  // Write headers
  await _sheetsRequest(`/${_spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: [
        {
          range: "Transaksi!A1:I1",
          values: [["ID", "Tanggal", "Jenis", "Kategori", "Subkategori", "Nominal", "Metode Pembayaran", "Catatan", "Diperbarui"]]
        },
        {
          range: "Subkategori!A1:B1",
          values: [["Kategori", "Subkategori"]]
        },
        {
          range: "Metode Pembayaran!A1:A1",
          values: [["Metode Pembayaran"]]
        },
        {
          range: "Metadata!A1:B1",
          values: [["Key", "Value"]]
        }
      ]
    })
  });
}

// ── INTERNAL: Sheet Formatting ────────────────
// Applies borders, header styling, and auto-fit column widths to all sheets.
async function _applySheetFormatting() {
  try {
  console.log("[Format] Applying sheet formatting (borders, headers, column widths)...");

  // 1. Get sheet tab metadata (sheetId/gid for each tab)
  const meta = await _sheetsRequest(
    `/${_spreadsheetId}?fields=sheets(properties(sheetId,title))`
  );
  const sheetMap = {};
  (meta.sheets || []).forEach(s => {
    sheetMap[s.properties.title] = s.properties.sheetId;
  });

  // 2. Get data extents for each sheet to determine row counts
  const ranges = ["Transaksi!A:I", "Subkategori!A:B", "Metode Pembayaran!A:A", "Metadata!A:B"];
  const dataResp = await _sheetsRequest(`/${_spreadsheetId}/values:batchGet?ranges=${ranges.map(encodeURIComponent).join("&ranges=")}`);
  const valueRanges = dataResp.valueRanges || [];

  // 3. Build all formatting requests
  const requests = [];
  const headerBgColor = { red: 0.24, green: 0.38, blue: 0.36 }; // soft deep teal
  const headerFgColor = { red: 0.98, green: 0.99, blue: 0.98 };
  const borderColor = { red: 0.80, green: 0.84, blue: 0.82 };
  const borderStyle = { style: "SOLID", width: 1, color: borderColor };
  const thickBorder = { style: "SOLID", width: 2, color: { red: 0.46, green: 0.58, blue: 0.55 } };
  const zebraBgColor = { red: 0.96, green: 0.98, blue: 0.97 };
  const categoryColors = {
    expense: { bg: { red: 0.99, green: 0.90, blue: 0.90 }, fg: { red: 0.55, green: 0.16, blue: 0.16 } },
    income: { bg: { red: 0.90, green: 0.97, blue: 0.92 }, fg: { red: 0.16, green: 0.42, blue: 0.24 } },
    transfer: { bg: { red: 0.94, green: 0.91, blue: 0.98 }, fg: { red: 0.37, green: 0.24, blue: 0.57 } }
  };
  const columnWidths = {
    Transaksi: [305, 105, 135, 125, 165, 100, 170, 230, 190],
    Subkategori: [145, 170],
    "Metode Pembayaran": [175],
    Metadata: [160, 260]
  };

  const sheetConfigs = [
    { name: "Transaksi", cols: 9 },
    { name: "Subkategori", cols: 2 },
    { name: "Metode Pembayaran", cols: 1 },
    { name: "Metadata", cols: 2 }
  ];

  // ── Clear existing conditional formatting rules to avoid duplicates on re-format ──
  const metaFull = await _sheetsRequest(
    `/${_spreadsheetId}?fields=sheets(properties(sheetId,title),conditionalFormats)`
  );
  const cfMap = {};
  (metaFull.sheets || []).forEach(s => {
    cfMap[s.properties.sheetId] = (s.conditionalFormats || []).length;
  });

  for (const cfg of sheetConfigs) {
    const sheetId = sheetMap[cfg.name];
    if (sheetId === undefined) continue;
    const ruleCount = cfMap[sheetId] || 0;
    // Delete from highest index to lowest to avoid index shift
    for (let idx = ruleCount - 1; idx >= 0; idx--) {
      requests.push({ deleteConditionalFormatRule: { sheetId, index: idx } });
    }
  }

  for (let i = 0; i < sheetConfigs.length; i++) {
    const cfg = sheetConfigs[i];
    const sheetId = sheetMap[cfg.name];
    if (sheetId === undefined) continue;

    const rowCount = (valueRanges[i]?.values?.length) || 1;
    const totalRows = Math.max(rowCount, 1);
    if (totalRows < 1) continue;

    // ── Header row: bold text, colored background, centered ──
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: cfg.cols },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true, fontSize: 11, foregroundColor: headerFgColor },
            backgroundColor: headerBgColor,
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            wrapStrategy: "WRAP",
            borders: {
              top: thickBorder, bottom: thickBorder,
              left: borderStyle,
              right: borderStyle
            }
          }
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy,borders)"
      }
    });

    // ── Header row height: slightly taller ──
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 32 },
        fields: "pixelSize"
      }
    });

    // ── Data cells: borders on all sides ──
    if (totalRows > 1) {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: totalRows, startColumnIndex: 0, endColumnIndex: cfg.cols },
          cell: {
            userEnteredFormat: {
              textFormat: { fontSize: 10 },
              verticalAlignment: "MIDDLE",
              wrapStrategy: "WRAP",
              borders: {
                top: borderStyle, bottom: borderStyle,
                left: borderStyle, right: borderStyle
              }
            }
          },
          fields: "userEnteredFormat(textFormat,verticalAlignment,wrapStrategy,borders)"
        }
      });

      // ── Alternate row shading for readability (single request) ──
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: totalRows, startColumnIndex: 0, endColumnIndex: cfg.cols }],
            booleanRule: {
              condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: "=ISODD(ROW())" }] },
              format: { backgroundColor: zebraBgColor }
            }
          },
          index: 0
        }
      });

      if (cfg.name === "Transaksi") {
        requests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: 1, endRowIndex: totalRows, startColumnIndex: 0, endColumnIndex: 1 },
            cell: {
              userEnteredFormat: {
                wrapStrategy: "CLIP"
              }
            },
            fields: "userEnteredFormat.wrapStrategy"
          }
        });

        [
          { value: "Pengeluaran", color: categoryColors.expense },
          { value: "Pemasukan", color: categoryColors.income },
          { value: "Pemindahan Saldo", color: categoryColors.transfer },
          { value: "Pindah Saldo", color: categoryColors.transfer }
        ].forEach(({ value, color }) => {
          requests.push({
            addConditionalFormatRule: {
              rule: {
                ranges: [{ sheetId, startRowIndex: 1, endRowIndex: totalRows, startColumnIndex: 2, endColumnIndex: 3 }],
                booleanRule: {
                  condition: { type: "TEXT_EQ", values: [{ userEnteredValue: value }] },
                  format: {
                    backgroundColor: color.bg,
                    textFormat: { foregroundColor: color.fg, bold: true }
                  }
                }
              },
              index: 0
            }
          });
        });
      }
    }

    // ── Auto-resize first, then set comfortable soft limits for long text columns ──
    requests.push({
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: cfg.cols }
      }
    });

    (columnWidths[cfg.name] || []).forEach((pixelSize, colIndex) => {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: colIndex, endIndex: colIndex + 1 },
          properties: { pixelSize },
          fields: "pixelSize"
        }
      });
    });

    if (cfg.name === "Transaksi") {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 4 },
          properties: { hiddenByUser: true },
          fields: "hiddenByUser"
        }
      });
    }

    requests.push({
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: totalRows }
      }
    });
  }

  // 4. Send all formatting in one batchUpdate
  if (requests.length > 0) {
    await _sheetsRequest(`/${_spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests })
    });
    console.log(`[Format] Applied ${requests.length} formatting requests`);
  }
  } catch (err) {
    console.warn("[Format] Sheet formatting failed (non-critical):", err?.message || err);
  }
}

// ── INTERNAL: Write Data ──────────────────────

async function _writeTransactions(transactions) {
  console.log(`[Write] Syncing ${transactions.length} transactions (differential mode)`);
  
  // First sync: do full rewrite
  if (_lastSyncedTransactionIds.size === 0 && transactions.length > 0) {
    console.log("[Write] First sync detected, doing full rewrite");
    await _fullWriteTransactions(transactions);
    _lastSyncedTransactionIds = new Set(transactions.map(tx => tx.id));
    return;
  }
  
  // Differential sync: detect changes
  const currentIds = new Set(transactions.map(tx => tx.id));
  const previousIds = _lastSyncedTransactionIds;
  
  // Find new/updated transactions
  const toUpdate = transactions.filter(tx => {
    const isNew = !previousIds.has(tx.id);
    const isUpdated = !isNew && tx.updatedAt && new Date(tx.updatedAt) > new Date(_lastSyncTime || 0);
    return isNew || isUpdated;
  });
  
  // Find deleted transactions (IDs that were tracked but no longer local)
  const trackedDeletes = [...previousIds].filter(id => !currentIds.has(id));
  
  // Safety: also detect stale rows on sheet that aren't in local state.
  // This catches cases where _lastSyncedTransactionIds is incomplete
  // (e.g. after auto-pull or cross-device sync) and a deletion was missed.
  let toDelete = trackedDeletes;
  if (trackedDeletes.length === 0 && currentIds.size > 0) {
    try {
      const sheetIds = await _readSheetTransactionIds();
      const staleIds = sheetIds.filter(id => !currentIds.has(id));
      if (staleIds.length > 0) {
        console.log(`[Write] Stale rows found on sheet (not in tracking): ${staleIds.length}`, staleIds);
        toDelete = staleIds;
      }
    } catch (e) {
      console.warn("[Write] Could not check for stale rows:", e);
    }
  }
  
  console.log(`[Write] Changes detected: ${toUpdate.length} updates, ${toDelete.length} deletes`);
  
  if (toDelete.length > 0) {
    console.log(`[Write] IDs to delete:`, toDelete);
  }
  
  // Apply changes
  if (toUpdate.length > 0) {
    await _batchUpdateTransactions(toUpdate);
  }
  
  if (toDelete.length > 0) {
    await _batchDeleteTransactions(toDelete);
  }
  
  // Update tracked IDs AFTER operations complete
  console.log(`[Write] Updating tracked IDs: ${_lastSyncedTransactionIds.size} -> ${currentIds.size}`);
  _lastSyncedTransactionIds = currentIds;
  
  console.log("[Write] Differential sync completed");
}

// Full rewrite (for first sync or fallback)
async function _fullWriteTransactions(transactions) {
  const rows = transactions.map(tx => [
    tx.id || "",
    tx.date || "",
    tx.type || "",
    tx.category || "",
    tx.subCategory || "",
    tx.amount != null ? String(tx.amount) : "",
    tx.paymentMethod || "",
    tx.note || "",
    tx.updatedAt || ""
  ]);

  console.log(`[Write] Full rewrite: ${rows.length} rows`);

  // Clear entire range first to ensure stale rows are removed
  await _sheetsRequest(`/${_spreadsheetId}/values:batchClear`, {
    method: "POST",
    body: JSON.stringify({ ranges: ["Transaksi!A2:I"] })
  });

  if (rows.length > 0) {
    await _sheetsRequest(`/${_spreadsheetId}/values/Transaksi!A2:I?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: rows })
    });
  }
}

// Batch update/insert transactions
async function _batchUpdateTransactions(transactions) {
  if (transactions.length === 0) return;
  
  console.log(`[Write] Batch updating ${transactions.length} transactions`);
  
  // Read current data to find row positions
  const existingData = await _sheetsRequest(
    `/${_spreadsheetId}/values/Transaksi!A2:A?majorDimension=ROWS`
  );
  const existingRows = existingData.values || [];
  const idToRowMap = new Map();
  existingRows.forEach((row, idx) => {
    if (row[0]) idToRowMap.set(row[0], idx + 2); // +2 because A2 is row 2
  });
  
  // Separate into updates (existing rows) and inserts (new rows)
  const rowUpdates = [];
  const newTransactions = [];
  
  for (const tx of transactions) {
    const row = [
      tx.id || "",
      tx.date || "",
      tx.type || "",
      tx.category || "",
      tx.subCategory || "",
      tx.amount != null ? String(tx.amount) : "",
      tx.paymentMethod || "",
      tx.note || "",
      tx.updatedAt || ""
    ];
    
    const existingRow = idToRowMap.get(tx.id);
    if (existingRow) {
      // Update existing row
      rowUpdates.push({
        range: `Transaksi!A${existingRow}:I${existingRow}`,
        values: [row]
      });
    } else {
      // New transaction, will be appended
      newTransactions.push(row);
    }
  }
  
  // Apply row updates using batchUpdate
  if (rowUpdates.length > 0) {
    await _sheetsRequest(`/${_spreadsheetId}/values:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        valueInputOption: "RAW",
        data: rowUpdates
      })
    });
    console.log(`[Write] Updated ${rowUpdates.length} existing rows`);
  }
  
  // Append new rows at the end
  if (newTransactions.length > 0) {
    const startRow = existingRows.length + 2;
    const endRow = startRow + newTransactions.length - 1;
    await _sheetsRequest(`/${_spreadsheetId}/values/Transaksi!A${startRow}:I${endRow}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: newTransactions })
    });
    console.log(`[Write] Appended ${newTransactions.length} new rows`);
  }
}

// Batch delete transactions by ID using deleteDimension (efficient — no full rewrite)
async function _batchDeleteTransactions(idsToDelete) {
  if (idsToDelete.length === 0) return;

  console.log(`[Write] Deleting ${idsToDelete.length} transactions:`, idsToDelete);

  // Fetch spreadsheet metadata to get the correct sheet tab ID (gid) for "Transaksi"
  const meta = await _sheetsRequest(
    `/${_spreadsheetId}?fields=sheets(properties(sheetId,title))`
  );
  const transaksiSheet = (meta.sheets || []).find(
    s => s.properties && s.properties.title === "Transaksi"
  );
  if (!transaksiSheet) {
    throw new Error("Sheet tab 'Transaksi' not found in spreadsheet");
  }
  const sheetTabId = transaksiSheet.properties.sheetId;

  // Read only column A (IDs) to find row positions — minimal data transfer
  const result = await _sheetsRequest(
    `/${_spreadsheetId}/values/Transaksi!A2:A?majorDimension=ROWS`
  );
  const rows = result.values || [];

  // Map each ID to its 0-based sheet row index (row 2 in sheet = index 1)
  const deleteSet = new Set(idsToDelete);
  const sheetIndicesToDelete = [];

  rows.forEach((row, i) => {
    if (row && row[0] && deleteSet.has(row[0])) {
      sheetIndicesToDelete.push(i + 1); // +1 because data starts at sheet row 2 (0-based index 1)
    }
  });

  if (sheetIndicesToDelete.length === 0) {
    console.log("[Write] No matching rows found in spreadsheet for deletion");
    return;
  }

  // Sort descending so deleting lower rows doesn't shift indices of rows above
  sheetIndicesToDelete.sort((a, b) => b - a);

  console.log(`[Write] Deleting ${sheetIndicesToDelete.length} rows at indices:`, sheetIndicesToDelete);

  // Build deleteDimension requests — one per row, all in a single batchUpdate
  const requests = sheetIndicesToDelete.map(index => ({
    deleteDimension: {
      range: {
        sheetId: sheetTabId,
        dimension: "ROWS",
        startIndex: index,
        endIndex: index + 1
      }
    }
  }));

  await _sheetsRequest(`/${_spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests })
  });

  console.log("[Write] deleteDimension batch completed — no full rewrite needed");
}

async function _writeSubCategories(subCategories) {
  const rows = [];
  for (const [category, subs] of Object.entries(subCategories)) {
    for (const sub of subs) {
      rows.push([category, sub]);
    }
  }

  // Clear range first to remove stale rows
  await _sheetsRequest(`/${_spreadsheetId}/values:batchClear`, {
    method: "POST",
    body: JSON.stringify({ ranges: ["Subkategori!A2:B"] })
  });

  if (rows.length > 0) {
    await _sheetsRequest(`/${_spreadsheetId}/values/Subkategori!A2:B?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: rows })
    });
  }
}

async function _writePaymentMethods(methods) {
  const rows = methods.map(m => [m]);

  // Clear range first to remove stale rows
  await _sheetsRequest(`/${_spreadsheetId}/values:batchClear`, {
    method: "POST",
    body: JSON.stringify({ ranges: ["Metode Pembayaran!A2:A"] })
  });

  if (rows.length > 0) {
    await _sheetsRequest(`/${_spreadsheetId}/values/Metode%20Pembayaran!A2:A?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: rows })
    });
  }
}

async function _writeMetadata(appState) {
  const rows = [
    ["lastSync", new Date().toISOString()],
    ["appVersion", typeof APP_VERSION !== "undefined" ? APP_VERSION : "unknown"],
    ["transactionCount", String((appState.transactions || []).length)]
  ];

  await _sheetsRequest(`/${_spreadsheetId}/values/Metadata!A2:B?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: rows })
  });
}

// ── INTERNAL: Read Data ───────────────────────

// Read only transaction IDs from the sheet (column A) for reconciliation
async function _readSheetTransactionIds() {
  const result = await _sheetsRequest(
    `/${_spreadsheetId}/values/Transaksi!A2:A?majorDimension=ROWS`
  );
  return (result.values || [])
    .filter(row => row && row[0])
    .map(row => row[0]);
}

async function _readTransactions() {
  const result = await _sheetsRequest(
    `/${_spreadsheetId}/values/Transaksi!A2:I?majorDimension=ROWS`
  );
  const rows = result.values || [];
  return rows.filter(r => r[0]).map(r => ({
    id: r[0] || crypto.randomUUID?.() || `tx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    date: r[1] || "",
    type: r[2] || "",
    category: r[3] || "",
    subCategory: r[4] || "",
    amount: r[5] ? Number(r[5]) : 0,
    paymentMethod: r[6] || "",
    note: r[7] || "",
    updatedAt: r[8] || new Date().toISOString(),
    createdAt: r[8] || new Date().toISOString()
  }));
}

async function _readSubCategories() {
  const result = await _sheetsRequest(
    `/${_spreadsheetId}/values/Subkategori!A2:B?majorDimension=ROWS`
  );
  const rows = result.values || [];
  const subCategories = {};
  for (const [cat, sub] of rows) {
    if (!cat || !sub) continue;
    if (!subCategories[cat]) subCategories[cat] = [];
    if (!subCategories[cat].includes(sub)) subCategories[cat].push(sub);
  }
  return subCategories;
}

async function _readPaymentMethods() {
  const result = await _sheetsRequest(
    `/${_spreadsheetId}/values/Metode Pembayaran!A2:A?majorDimension=ROWS`
  );
  const rows = result.values || [];
  return rows.filter(r => r[0]).map(r => r[0]);
}

// ── INTERNAL: Auto-sync ───────────────────────

function _clearAutoSyncTimer() {
  if (_autoSyncTimer) {
    clearTimeout(_autoSyncTimer);
    _autoSyncTimer = null;
  }
}

function _scheduleAutoSync() {
  _clearAutoSyncTimer();
  if (!_autoSyncEnabled || !isSignedIn()) return;

  const lastPushMs = Date.parse(_lastPushTime || "");
  const elapsed = Number.isFinite(lastPushMs) ? Date.now() - lastPushMs : AUTO_SYNC_INTERVAL_MS;
  const delay = Math.max(AUTO_SYNC_INTERVAL_MS - elapsed, 0);

  _autoSyncTimer = setTimeout(() => {
    _autoSyncTimer = null;
    _triggerAutoSync();
  }, delay);
}

function _scheduleAutoSyncRetry() {
  if (!_autoSyncEnabled || !isSignedIn() || _autoSyncTimer) return;
  _autoSyncTimer = setTimeout(() => {
    _autoSyncTimer = null;
    _triggerAutoSync();
  }, AUTO_SYNC_INTERVAL_MS);
}

function _triggerAutoSync() {
  if (!isSignedIn() || _syncInProgress) return;
  if (typeof _onAutoSyncNeeded === "function") _onAutoSyncNeeded();
}

let _onAutoSyncNeeded = null;

function setAutoSyncCallback(fn) {
  _onAutoSyncNeeded = fn;
  _scheduleAutoSync();
}
