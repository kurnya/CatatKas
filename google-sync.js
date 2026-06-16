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
let _autoSyncInterval = "off";
let _autoSyncTimer = null;
let _lastSyncTime = null;

// ── CALLBACKS (set by app.js) ─────────────────
let _onSyncStateChange = null;   // (isSyncing: bool) => void
let _onSyncComplete = null;      // (direction: 'push'|'pull', success: bool, msg: string) => void
let _onAuthChange = null;        // (isSignedIn: bool) => void

// ── PUBLIC API ────────────────────────────────

function initGoogleSync(callbacks) {
  _onSyncStateChange = callbacks.onSyncStateChange || null;
  _onSyncComplete = callbacks.onSyncComplete || null;
  _onAuthChange = callbacks.onAuthChange || null;

  // Restore saved state
  try {
    const meta = JSON.parse(localStorage.getItem(SYNC_META_KEY) || "{}");
    _spreadsheetId = meta.spreadsheetId || null;
    _lastSyncTime = meta.lastSyncTime || null;
    _autoSyncInterval = meta.autoSyncInterval || "off";

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
    // Try silent refresh in background if token expired
    if (Date.now() >= _tokenExpiry) {
      _trySilentRefresh().catch(() => {
        // Refresh failed but don't clear token — might be network issue
        // Will retry on next sync attempt
        console.warn("[Sync] Token refresh failed, will retry on next sync");
      });
    }
    if (_autoSyncInterval !== "off") setAutoSyncInterval(_autoSyncInterval);
  }

  _initGoogleIdentityServices();
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
  return _autoSyncInterval !== "off";
}

function getAutoSyncInterval() {
  return _autoSyncInterval;
}

const INTERVAL_MS = {
  "off": 0,
  "6h":  6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "3d":  3 * 24 * 60 * 60 * 1000,
  "7d":  7 * 24 * 60 * 60 * 1000
};

function setAutoSyncInterval(interval) {
  _autoSyncInterval = interval;
  _saveSyncMeta();
  if (_autoSyncTimer) {
    clearInterval(_autoSyncTimer);
    _autoSyncTimer = null;
  }
  const ms = INTERVAL_MS[interval] || 0;
  if (ms > 0 && isSignedIn()) {
    // Push immediately on enable, then every interval
    _triggerAutoSync();
    _autoSyncTimer = setInterval(() => _triggerAutoSync(), ms);
  }
}

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
  _autoSyncInterval = "off";
  localStorage.removeItem(SYNC_META_KEY);
  localStorage.removeItem(SYNC_TOKEN_KEY);
  setAutoSyncInterval("off");
  _onAuthChange?.(false);
}

async function pushToSheets(appState, silent = false) {
  if (!isSignedIn()) {
    if (!silent) _onSyncComplete?.("push", false, "Anda belum masuk ke akun Google.");
    return false;
  }
  if (_syncInProgress) return false;
  _syncInProgress = true;
  if (!silent) _onSyncStateChange?.(true);

  try {
    await _ensureSpreadsheet();
    await _writeTransactions(appState.transactions || []);
    await _writeSubCategories(appState.subCategories || {});
    await _writePaymentMethods(appState.paymentMethods || []);
    await _writeMetadata(appState);

    _lastSyncTime = new Date().toISOString();
    _saveSyncMeta();
    if (!silent) _onSyncComplete?.("push", true, "Data berhasil disimpan ke Google Spreadsheet.");
    return true;
  } catch (err) {
    console.error("[Sync] Push error:", err);
    if (!silent) {
      if (_isAuthRefreshError(err)) _markTokenRefreshRequired();
      const msg = _isAuthRefreshError(err)
        ? TOKEN_REFRESH_ERROR_MESSAGE
        : err?.message || "Gagal menyimpan data ke Google Spreadsheet.";
      _onSyncComplete?.("push", false, msg);
    }
    return false;
  } finally {
    _syncInProgress = false;
    if (!silent) _onSyncStateChange?.(false);
  }
}

async function pullFromSheets() {
  if (!isSignedIn()) {
    _onSyncComplete?.("pull", false, "Anda belum masuk ke akun Google.");
    return null;
  }
  if (_syncInProgress) return null;
  if (!_spreadsheetId) {
    _onSyncComplete?.("pull", false, "Belum ada Spreadsheet terhubung. Kirim data terlebih dahulu.");
    return null;
  }
  _syncInProgress = true;
  _onSyncStateChange?.(true);

  try {
    const transactions = await _readTransactions();
    const subCategories = await _readSubCategories();
    const paymentMethods = await _readPaymentMethods();

    _lastSyncTime = new Date().toISOString();
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
    // Auto-restore if we had a spreadsheet
    if (_spreadsheetId) {
      _onAuthChange?.(true);
    }
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
  if (_autoSyncInterval !== "off") {
    setAutoSyncInterval(_autoSyncInterval);
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
  _onAuthChange?.(false);
}

// ── INTERNAL: Spreadsheet Management ──────────

function _saveSyncMeta() {
  localStorage.setItem(SYNC_META_KEY, JSON.stringify({
    spreadsheetId: _spreadsheetId,
    lastSyncTime: _lastSyncTime,
    autoSyncInterval: _autoSyncInterval
  }));
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

// ── INTERNAL: Write Data ──────────────────────

async function _writeTransactions(transactions) {
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

  // Clear and rewrite the whole sheet (simple & reliable)
  await _sheetsRequest(`/${_spreadsheetId}/values/Transaksi!A2:I?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: rows.length ? rows : [[]] })
  });
}

async function _writeSubCategories(subCategories) {
  const rows = [];
  for (const [category, subs] of Object.entries(subCategories)) {
    for (const sub of subs) {
      rows.push([category, sub]);
    }
  }

  await _sheetsRequest(`/${_spreadsheetId}/values/Subkategori!A2:B?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: rows.length ? rows : [[]] })
  });
}

async function _writePaymentMethods(methods) {
  const rows = methods.map(m => [m]);

  await _sheetsRequest(`/${_spreadsheetId}/values/Metode%20Pembayaran!A2:A?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: rows.length ? rows : [[]] })
  });
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

function _triggerAutoSync() {
  if (!isSignedIn() || _syncInProgress) return;
  if (typeof _onAutoSyncNeeded === "function") _onAutoSyncNeeded();
}

let _onAutoSyncNeeded = null;

function setAutoSyncCallback(fn) {
  _onAutoSyncNeeded = fn;
}
