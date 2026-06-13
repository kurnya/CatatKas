const STORAGE_KEY = "catatan_keuangan_pwa_v1";
const PREFERENCES_KEY = "catatan_keuangan_preferences_v1";
const APP_VERSION = "1.1.2";
const IS_DEV = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const GITHUB_RELEASE_URL = "https://github.com/kurnya/CatatKas/releases/latest";
const ANDROID_APK_DOWNLOAD_URL = `${GITHUB_RELEASE_URL}/download/catatkas-android.apk`;
const UPDATE_KEYS = {
  currentVersion: "catatkas_current_version",
  availableVersion: "catatkas_update_available_version",
  remindLaterUntil: "catatkas_update_remind_later_until",
  ignoredVersion: "catatkas_ignored_update_version",
  successPending: "catatkas_update_success_pending",
  cacheRefreshPending: "catatkas_cache_refresh_pending"
};

const LOCKED_TYPES = ["Pemasukan", "Pengeluaran", "Pemindahan Saldo"];

const defaults = {
  types: [...LOCKED_TYPES],
  categories: [...LOCKED_TYPES],
  subCategories: {
    Pemasukan: ["Gaji", "Bonus", "Pendapatan Usaha", "Hadiah", "Lainnya"],
    Pengeluaran: ["Makan & Minum", "Transportasi", "Belanja", "Tagihan", "Kesehatan", "Pendidikan", "Hiburan", "Kebutuhan Rumah", "Lainnya"],
    "Pemindahan Saldo": ["Antar Rekening", "Tarik Tunai", "Top Up E-Wallet", "Pindah Saldo", "Lainnya"]
  },
  paymentMethods: ["CASH", "BCA", "SEABANK", "DANA", "OVO", "GoPay", "ShopeePay", "Kartu Kredit"],
  transactions: []
};

const pageMap = {
  home: "homePage",
  add: "addPage",
  transactions: "transactionsPage",
  stats: "statsPage",
  master: "masterPage",
  settings: "settingsPage"
};

// PWA base path: auto-detect GitHub Pages vs local dev
const PWA_BASE = window.location.hostname.includes("github.io") ? "/CatatKas/" : "/";

const state = loadState();
const preferences = loadPreferences();
let deferredPrompt = null;
let installAutoHideTimer = null;
let activeModalResolve = null;
let lastFocusedElement = null;
let serviceWorkerRegistration = null;
let pendingServiceWorker = null;
let refreshingForUpdate = false;
let updateToastElement = null;
let updateModalShownThisSession = false;
let activeFilters = {
  category: "Semua",
  payment: "Semua"
};
let draftFilters = { ...activeFilters };
let activeDownloadPlatform = "android";

const elements = {
  pageTitle: document.querySelector("#pageTitle"),
  pages: document.querySelectorAll(".page"),
  navItems: document.querySelectorAll(".nav-item"),
  installButton: document.querySelector("#installButton"),
  themeMeta: document.querySelector("meta[name='theme-color']"),
  downloadPlatformButtons: document.querySelectorAll("[data-download-platform]"),
  downloadGuideTitle: document.querySelector("#downloadGuideTitle"),
  downloadGuideText: document.querySelector("#downloadGuideText"),
  downloadGuideAction: document.querySelector("#downloadGuideAction"),
  downloadAppVersion: document.querySelector("#downloadAppVersion"),
  installHelperText: document.querySelector("#installHelperText"),
  toastContainerTop: document.querySelector("#toastContainerTop"),
  appModalOverlay: document.querySelector("#appModalOverlay"),
  appModal: document.querySelector("#appModal"),
  appModalClose: document.querySelector("#appModalClose"),
  appModalIcon: document.querySelector("#appModalIcon"),
  appModalEyebrow: document.querySelector("#appModalEyebrow"),
  appModalTitle: document.querySelector("#appModalTitle"),
  appModalMessage: document.querySelector("#appModalMessage"),
  appModalContent: document.querySelector("#appModalContent"),
  appModalActions: document.querySelector(".modal-actions"),
  appModalCancel: document.querySelector("#appModalCancel"),
  appModalConfirm: document.querySelector("#appModalConfirm"),
  summaryMonth: document.querySelector("#summaryMonth"),
  historyMonth: document.querySelector("#historyMonth"),
  activeMonthLabel: document.querySelector("#activeMonthLabel"),
  incomeTotal: document.querySelector("#incomeTotal"),
  expenseTotal: document.querySelector("#expenseTotal"),
  balanceTotal: document.querySelector("#balanceTotal"),
  recentList: document.querySelector("#recentList"),
  transactionList: document.querySelector("#transactionList"),
  filterSummary: document.querySelector("#filterSummary"),
  filterOverlay: document.querySelector("#filterOverlay"),
  filterSheet: document.querySelector("#filterSheet"),
  openFilterButton: document.querySelector("#openFilterButton"),
  closeFilterButton: document.querySelector("#closeFilterButton"),
  resetFilterButton: document.querySelector("#resetFilterButton"),
  applyFilterButton: document.querySelector("#applyFilterButton"),
  filterCategoryChips: document.querySelector("#filterCategoryChips"),
  filterPaymentChips: document.querySelector("#filterPaymentChips"),
  form: document.querySelector("#transactionForm"),
  id: document.querySelector("#transactionId"),
  date: document.querySelector("#date"),
  type: document.querySelector("#type"),
  category: document.querySelector("#category"),
  subCategory: document.querySelector("#subCategory"),
  paymentMethod: document.querySelector("#paymentMethod"),
  amount: document.querySelector("#amount"),
  note: document.querySelector("#note"),
  submitButton: document.querySelector("#submitButton"),
  cancelEditButton: document.querySelector("#cancelEditButton"),
  addTransactionButton: document.querySelector("#addTransactionButton"),
  statsExpense: document.querySelector("#statsExpense"),
  topExpenseCategory: document.querySelector("#topExpenseCategory"),
  dailyAverage: document.querySelector("#dailyAverage"),
  statsBalance: document.querySelector("#statsBalance"),
  expenseChart: document.querySelector("#expenseChart"),
  categoryList: document.querySelector("#categoryList"),
  subCategoryList: document.querySelector("#subCategoryList"),
  paymentMethodList: document.querySelector("#paymentMethodList"),
  exportButton: document.querySelector("#exportButton"),
  importFile: document.querySelector("#importFile"),
  exportCsvButton: document.querySelector("#exportCsvButton"),
  resetMasterButton: document.querySelector("#resetMasterButton"),
  deleteTransactionsButton: document.querySelector("#deleteTransactionsButton"),
  preferenceCurrency: document.querySelector("#preferenceCurrency"),
  preferenceDateFormat: document.querySelector("#preferenceDateFormat"),
  preferenceTheme: document.querySelector("#preferenceTheme"),
  preferenceDefaultPayment: document.querySelector("#preferenceDefaultPayment"),
  appVersionLabel: document.querySelector("#appVersionLabel"),
  updateAppName: document.querySelector("#updateAppName"),
  updateStatusText: document.querySelector("#updateStatusText"),
  checkUpdateButton: document.querySelector("#checkUpdateButton"),
  updateNowButton: document.querySelector("#updateNowButton"),
  offlineStatusLabel: document.querySelector("#offlineStatusLabel"),
  offlineStatusText: document.querySelector("#offlineStatusText"),
  downloadAppSection: document.querySelector("#downloadAppSection"),
  updateCard: document.querySelector(".update-card")
};

init();


function logInstallDebugInfo() {
  const userAgent = navigator.userAgent;
  const platform = navigator.platform;
  const isAndroid = /Android/.test(userAgent);
  const isChrome = /Chrome|Chromium|CriOS/.test(userAgent);
  const isStandalone = isRunningStandalone();
  
  console.log("[PWA Debug] ===== PWA Installation Debug Info =====");
  console.log("[PWA Debug] App Version:", APP_VERSION);
  console.log("[PWA Debug] Platform:", platform);
  console.log("[PWA Debug] User Agent:", userAgent);
  console.log("[PWA Debug] Is Android:", isAndroid);
  console.log("[PWA Debug] Is Chrome:", isChrome);
  console.log("[PWA Debug] Is Standalone:", isStandalone);
  console.log("[PWA Debug] deferredPrompt ready:", deferredPrompt !== null);
  console.log("[PWA Debug] Install button hidden:", elements.installButton.hidden);
  console.log("[PWA Debug] =========================================");
}
function init() {
  const month = today().slice(0, 7);
  elements.summaryMonth.value = month;
  elements.historyMonth.value = month;
  elements.date.value = today();
  
  // Log initial debug info
  logInstallDebugInfo();
  
  applyThemePreference();
  bindEvents();
  showUpdateSuccessToastIfNeeded();
  renderAll();
  renderOfflineStatus();
  navigate("home");
  registerServiceWorker();

  // Listen for online/offline changes
  window.addEventListener("online", renderOfflineStatus);
  window.addEventListener("offline", renderOfflineStatus);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyThemePreference);
}

function bindEvents() {
  document.querySelectorAll("[data-nav]:not(.nav-item)").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.nav));
  });

  elements.navItems.forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.nav));
  });

  elements.addTransactionButton.addEventListener("click", () => {
    resetForm();
    navigate("add");
  });

  elements.form.addEventListener("submit", saveTransaction);
  elements.cancelEditButton.addEventListener("click", resetForm);
  elements.type.addEventListener("change", () => syncMainCategory(elements.type.value));
  elements.category.addEventListener("change", () => syncMainCategory(elements.category.value));
  elements.summaryMonth.addEventListener("change", () => {
    elements.historyMonth.value = elements.summaryMonth.value;
    renderAll();
  });
  elements.historyMonth.addEventListener("change", () => {
    elements.summaryMonth.value = elements.historyMonth.value;
    renderAll();
  });
  elements.openFilterButton.addEventListener("click", openFilterSheet);
  elements.closeFilterButton.addEventListener("click", closeFilterSheet);
  elements.filterOverlay.addEventListener("click", closeFilterSheet);
  elements.resetFilterButton.addEventListener("click", resetDraftFilters);
  elements.applyFilterButton.addEventListener("click", applyDraftFilters);
  document.addEventListener("keydown", handleGlobalKeydown);
  elements.exportButton.addEventListener("click", exportBackup);
  elements.exportCsvButton.addEventListener("click", exportCsv);
  elements.importFile.addEventListener("change", importBackup);
  elements.resetMasterButton.addEventListener("click", resetMasterData);
  elements.deleteTransactionsButton.addEventListener("click", deleteAllTransactions);
  elements.preferenceCurrency.addEventListener("change", savePreferencesFromForm);
  elements.preferenceDateFormat.addEventListener("change", savePreferencesFromForm);
  elements.preferenceTheme.addEventListener("change", savePreferencesFromForm);
  elements.preferenceDefaultPayment.addEventListener("change", savePreferencesFromForm);
  elements.amount.addEventListener("input", formatAmountInput);
  elements.checkUpdateButton.addEventListener("click", () => checkForAppUpdate(true));
  elements.updateNowButton.addEventListener("click", applyAppUpdate);

  document.querySelectorAll("[data-quick-date]").forEach((button) => {
    button.addEventListener("click", () => {
      elements.date.value = button.dataset.quickDate === "yesterday" ? addDays(today(), -1) : today();
    });
  });

  document.querySelectorAll("[data-quick-payment]").forEach((button) => {
    button.addEventListener("click", () => setSelectValue(elements.paymentMethod, state.paymentMethods, button.dataset.quickPayment));
  });

  document.querySelectorAll("[data-quick-category]").forEach((button) => {
    button.addEventListener("click", () => {
      const subCategory = button.dataset.quickCategory;
      const mainCategory = findSubCategoryType(subCategory) || elements.type.value;
      syncMainCategory(mainCategory);
      setSubCategoryValue(subCategory);
    });
  });

  document.querySelectorAll("[data-add-master]").forEach((button) => {
    button.addEventListener("click", () => addMasterItem(button.dataset.addMaster));
  });

  // Header help button opens app guidance.
  elements.installButton.addEventListener("click", () => {
    showHelpModal();
  });

  elements.downloadPlatformButtons.forEach((button) => {
    button.addEventListener("click", () => selectDownloadPlatform(button.dataset.downloadPlatform));
  });
  if (elements.downloadGuideAction) {
    elements.downloadGuideAction.addEventListener("click", () => handleAppDownload(activeDownloadPlatform));
  }
  elements.appModalOverlay.addEventListener("click", () => closeModal(false));
  elements.appModalClose.addEventListener("click", () => closeModal(false));
  elements.appModalCancel.addEventListener("click", () => closeModal(false));

  elements.installButton.hidden = false;

  if (isRunningStandalone()) {
    console.log("[PWA Debug] Running in standalone mode, install help stays available");
  } else {
    window.addEventListener("beforeinstallprompt", (event) => {
      console.log("[PWA Debug] beforeinstallprompt event fired");
      event.preventDefault();
      if (isRunningStandalone()) {
        updateSettingsInstallButton();
        return;
      }
      deferredPrompt = event;
      updateSettingsInstallButton();
      console.log("[PWA Debug] deferredPrompt saved");
    });

    // Deferred check: TWA may not report standalone immediately on page load
    window.addEventListener("load", () => {
      window.setTimeout(() => {
        if (isRunningStandalone()) {
          deferredPrompt = null;
          clearTimeout(installAutoHideTimer);
          updateSettingsInstallButton();
          console.log("[PWA Debug] Standalone detected after load");
        }
      }, 500);
    });
  }

  // Listen for display-mode changes (e.g., user installs/uninstalls)
  window.matchMedia("(display-mode: standalone)").addEventListener("change", (e) => {
    if (e.matches) {
      deferredPrompt = null;
      updateSettingsInstallButton();
    }
  });

  window.addEventListener("appinstalled", () => {
    console.log("[PWA Debug] appinstalled event fired - installation successful");
    deferredPrompt = null;
    elements.installButton.hidden = false;
    updateSettingsInstallButton();
    localStorage.setItem("catatkas_app_installed", "1");
    closeModal(false);
    showToast("Aplikasi berhasil diinstall", "success");
  });
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return structuredClone(defaults);

  try {
    const parsed = JSON.parse(raw);
    const migrated = { ...structuredClone(defaults), ...parsed };
    migrated.types = [...LOCKED_TYPES];
    migrated.categories = [...LOCKED_TYPES];
    migrated.subCategories = normalizeSubCategories(parsed.subCategories, migrated.types);
    migrated.transactions = (migrated.transactions || []).map((transaction) => {
      let type = migrateTransactionType(transaction, migrated.subCategories);
      return {
        ...transaction,
        type,
        category: type,
        createdAt: transaction.createdAt || transaction.updatedAt || new Date().toISOString(),
        updatedAt: transaction.updatedAt || transaction.createdAt || new Date().toISOString()
      };
    });
    return migrated;
  } catch {
    return structuredClone(defaults);
  }
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadPreferences() {
  const defaults = {
    currency: "IDR",
    dateFormat: "DD/MM/YYYY",
    theme: "system",
    defaultPayment: "CASH"
  };
  const raw = localStorage.getItem(PREFERENCES_KEY);
  if (!raw) return defaults;
  try {
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

function persistPreferences() {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
}

function navigate(page) {
  const pageId = pageMap[page] || pageMap.home;
  elements.pages.forEach((item) => item.classList.toggle("active", item.id === pageId));
  elements.navItems.forEach((item) => item.classList.toggle("active", item.dataset.nav === page));
  const activePage = document.querySelector(`#${pageId}`);
  elements.pageTitle.textContent = activePage.dataset.title;
  elements.addTransactionButton.classList.toggle("hidden", page !== "home");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderAll() {
  fillSelect(elements.type, LOCKED_TYPES);
  fillSelect(elements.category, LOCKED_TYPES);
  renderSubCategoryOptions(elements.type.value);
  fillSelect(elements.paymentMethod, state.paymentMethods);
  ensureActiveFiltersStillExist();
  renderFilterSummary();
  renderFilterChips();
  renderPreferences();
  elements.activeMonthLabel.textContent = formatMonth(elements.summaryMonth.value);
  renderHome();
  renderTransactions();
  renderStats();
  renderMasterData();
  persist();
}

function fillSelect(select, values) {
  const current = select.value;
  const uniqueValues = [...new Set(values.filter(Boolean))];
  select.innerHTML = uniqueValues.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
  if (uniqueValues.includes(current)) select.value = current;
  if (!uniqueValues.includes(current) && uniqueValues.length) select.value = uniqueValues[0];
}

function saveTransaction(event) {
  event.preventDefault();
  const rawAmount = elements.amount.value.replace(/\./g, "");
  const amount = Number(rawAmount);
  if (!rawAmount) {
    showToast("Nominal wajib diisi.", "warning");
    return;
  }
  if (amount <= 0) {
    showToast("Nominal harus lebih dari 0.", "warning");
    return;
  }
  if (!elements.date.value) {
    showToast("Tanggal transaksi wajib diisi.", "warning");
    return;
  }
  if (!elements.type.value || !elements.category.value) {
    showToast("Kategori belum dipilih.", "warning");
    return;
  }
  if (!elements.subCategory.value || !isValidSubCategory(elements.type.value, elements.subCategory.value)) {
    showToast("Subkategori belum dipilih.", "warning");
    return;
  }
  if (!elements.paymentMethod.value) {
    showToast("Metode pembayaran belum dipilih.", "warning");
    return;
  }

  const transaction = {
    id: elements.id.value || crypto.randomUUID(),
    date: elements.date.value,
    type: elements.type.value,
    amount,
    category: elements.type.value,
    subCategory: elements.subCategory.value,
    paymentMethod: elements.paymentMethod.value,
    note: elements.note.value.trim(),
    updatedAt: new Date().toISOString()
  };

  const index = state.transactions.findIndex((item) => item.id === transaction.id);
  if (index >= 0) {
    state.transactions[index] = { ...state.transactions[index], ...transaction };
    showToast("Transaksi berhasil diperbarui.", "success");
  } else {
    state.transactions.push({ ...transaction, createdAt: new Date().toISOString() });
    showToast("Transaksi berhasil disimpan.", "success");
  }

  persist();
  resetForm();
  renderAll();
  navigate("home");
}

function renderHome() {
  const month = elements.summaryMonth.value;
  const monthTransactions = getMonthTransactions();
  const totals = getTotals(monthTransactions);

  // Cumulative balance: all transactions up to end of selected month
  const allUpToMonth = state.transactions.filter((item) => item.date <= month + "-31");
  const cumulative = getTotals(allUpToMonth);
  const cumulativeBalance = cumulative.income - cumulative.expense;

  elements.incomeTotal.textContent = rupiah(totals.income);
  elements.expenseTotal.textContent = rupiah(totals.expense);
  elements.balanceTotal.textContent = rupiah(cumulativeBalance);
  renderTransactionCards(elements.recentList, getSortedTransactions(monthTransactions).slice(0, 5), false);
}

function renderTransactions() {
  const month = elements.historyMonth.value;
  const categoryFilter = activeFilters.category;
  const paymentFilter = activeFilters.payment;
  const transactions = getSortedTransactions(state.transactions)
    .filter((item) => item.date.startsWith(month))
    .filter((item) => categoryFilter === "Semua" || item.type === categoryFilter || item.category === categoryFilter)
    .filter((item) => paymentFilter === "Semua" || item.paymentMethod === paymentFilter);

  renderTransactionCards(elements.transactionList, transactions, true);
}

function renderFilterSummary() {
  elements.filterSummary.textContent = `${activeFilters.category === "Semua" ? "Semua Transaksi" : activeFilters.category} • ${activeFilters.payment === "Semua" ? "Semua Metode" : activeFilters.payment}`;
}

function renderFilterChips() {
  renderChipGroup(elements.filterCategoryChips, ["Semua", ...LOCKED_TYPES], draftFilters.category, "category");
  renderChipGroup(elements.filterPaymentChips, ["Semua", ...state.paymentMethods], draftFilters.payment, "payment");
}

function renderChipGroup(target, values, activeValue, key) {
  target.innerHTML = "";
  [...new Set(values.filter(Boolean))].forEach((value) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `filter-chip${value === activeValue ? " active" : ""}`;
    button.textContent = value;
    button.addEventListener("click", () => {
      draftFilters[key] = value;
      renderFilterChips();
    });
    target.appendChild(button);
  });
}

function openFilterSheet() {
  draftFilters = { ...activeFilters };
  renderFilterChips();
  elements.filterOverlay.hidden = false;
  elements.filterSheet.classList.add("open");
  elements.filterSheet.setAttribute("aria-hidden", "false");
  updateSheetBodyLock();
}

function closeFilterSheet() {
  elements.filterSheet.classList.remove("open");
  elements.filterSheet.setAttribute("aria-hidden", "true");
  elements.filterOverlay.hidden = true;
  updateSheetBodyLock();
}

function updateSheetBodyLock() {
  const filterOpen = elements.filterSheet.classList.contains("open");
  document.body.classList.toggle("sheet-open", filterOpen);
}

function showHelpModal() {
  const content = document.createElement("div");
  content.className = "help-guide-list";

  const downloadCard = createHelpGuideCard({
    title: "Download Aplikasi",
    text: "Buka halaman Settings, lalu masuk ke bagian Download Aplikasi untuk memilih Android, iOS, atau Desktop.",
    buttonText: "Buka Download",
    onClick: () => openSettingsSection(elements.downloadAppSection)
  });

  const updateCard = createHelpGuideCard({
    title: "Refresh Fitur Baru",
    text: "Buka Settings bagian Update Aplikasi, lalu tekan Cek Update untuk memuat fitur terbaru tanpa menghapus data lokal.",
    buttonText: "Buka Update",
    onClick: () => openSettingsSection(elements.updateCard)
  });

  content.append(downloadCard, updateCard);

  showConfirmModal({
    title: "Bantuan CatatKas",
    message: "Pilih panduan yang Anda butuhkan.",
    confirmText: "Mengerti",
    cancelText: "Tutup",
    type: "info",
    icon: "i",
    content
  });
}

function createHelpGuideCard({ title, text, buttonText, onClick }) {
  const card = document.createElement("div");
  card.className = "help-guide-card";

  const body = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = text;
  body.append(heading, copy);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary-button help-guide-action";
  button.textContent = buttonText;
  button.addEventListener("click", () => {
    closeModal(false);
    onClick();
  });

  card.append(body, button);
  return card;
}

function openSettingsSection(section) {
  navigate("settings");
  window.setTimeout(() => {
    if (section && typeof section.scrollIntoView === "function") {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, 220);
}

function handleGlobalKeydown(event) {
  if (event.key === "Escape") {
    if (!elements.appModalOverlay.hidden) {
      closeModal(false);
      return;
    }
    if (elements.filterSheet.classList.contains("open")) {
      closeFilterSheet();
    }
  }

  if (event.key === "Tab" && !elements.appModalOverlay.hidden) {
    trapModalFocus(event);
  }
}

function showToast(message, type = "info", duration = 3000) {
  const status = ["success", "warning", "danger", "error", "info"].includes(type) ? type : "info";
  const toast = document.createElement("div");
  toast.className = `toast ${status}`;
  toast.setAttribute("role", status === "danger" || status === "error" ? "alert" : "status");

  const messageEl = document.createElement("strong");
  messageEl.textContent = message;
  toast.appendChild(messageEl);

  elements.toastContainerTop.appendChild(toast);

  if (duration > 0) {
    window.setTimeout(() => {
      toast.style.animation = "toastOut 180ms ease forwards";
      window.setTimeout(() => toast.remove(), 180);
    }, duration);
  }
}

function showConfirmModal(options = {}) {
  const {
    title = "Konfirmasi",
    message = "Lanjutkan aksi ini?",
    confirmText = "Konfirmasi",
    cancelText = "Batal",
    type = "info",
    eyebrow = "CatatKas",
    icon,
    content = null
  } = options;

  return openModal({
    title,
    message,
    confirmText,
    cancelText,
    type,
    eyebrow,
    icon,
    content,
    onConfirm: () => true
  });
}

function showFormModal(options = {}) {
  const {
    title = "Isi Data",
    message = "",
    confirmText = "Simpan",
    cancelText = "Batal",
    type = "info",
    fields = [],
    validate
  } = options;

  const form = document.createElement("form");
  form.className = "modal-dynamic-content";
  form.noValidate = true;
  fields.forEach((field) => {
    const label = document.createElement("label");
    label.className = "modal-field";
    const labelText = document.createElement("span");
    labelText.textContent = field.label;
    const control = field.type === "select" ? document.createElement("select") : document.createElement("input");
    control.name = field.name;
    control.value = field.value || "";
    control.required = Boolean(field.required);
    if (field.placeholder) control.placeholder = field.placeholder;
    if (field.type && field.type !== "select") control.type = field.type;
    if (field.type === "select") {
      (field.options || []).forEach((option) => {
        const item = document.createElement("option");
        item.value = option;
        item.textContent = option;
        control.appendChild(item);
      });
      if (field.value) control.value = field.value;
    }
    label.append(labelText, control);
    form.appendChild(label);
  });

  return openModal({
    title,
    message,
    confirmText,
    cancelText,
    type,
    content: form,
    onConfirm: () => {
      const values = Object.fromEntries(new FormData(form).entries());
      if (typeof validate === "function") {
        const validationMessage = validate(values);
        if (validationMessage) {
          showToast(validationMessage, "warning");
          return null;
        }
      }
      return values;
    }
  });
}

function showInstallGuideModal(mode = "unsupported") {
  const iosMode = mode === "ios";
  const androidMode = mode === "android";
  const content = document.createElement("div");
  content.className = "modal-dynamic-content";

  if (iosMode) {
    const steps = document.createElement("ol");
    steps.className = "install-steps";
    [
      "Buka CatatKas menggunakan Safari.",
      "Tekan tombol Share / Bagikan.",
      "Pilih Add to Home Screen / Tambahkan ke Layar Utama.",
      "Tekan Add / Tambah."
    ].forEach((step) => {
      const item = document.createElement("li");
      item.textContent = step;
      steps.appendChild(item);
    });
    content.appendChild(steps);
  } else if (androidMode) {
    console.log("[PWA Debug] Showing Android install guide");
    const steps = document.createElement("ol");
    steps.className = "install-steps";
    [
      "Buka menu Chrome (tombol titik tiga di sudut kanan atas).",
      "Pilih \"Install app\" atau \"Tambahkan ke layar utama\".",
      "Ikuti instruksi yang muncul untuk menyelesaikan instalasi."
    ].forEach((step) => {
      const item = document.createElement("li");
      item.textContent = step;
      steps.appendChild(item);
    });
    content.appendChild(steps);
    
    const note = document.createElement("p");
    note.className = "helper-text";
    note.textContent = "Jika opsi tidak muncul, coba refresh halaman atau gunakan Chrome versi terbaru.";
    content.appendChild(note);

    const settingsNote = document.createElement("p");
    settingsNote.className = "helper-text";
    settingsNote.innerHTML = "<strong>Tips:</strong> Anda juga bisa buka <strong>Pengaturan</strong> > <strong>Mode Offline</strong> untuk melihat status koneksi aplikasi.";
    content.appendChild(settingsNote);
  } else {
    const message = document.createElement("p");
    message.textContent = "Browser ini belum mendukung install otomatis. Coba gunakan Chrome atau tambahkan aplikasi melalui menu browser.";
    content.appendChild(message);
  }

  return showConfirmModal({
    title: iosMode ? "Panduan Install iOS" : androidMode ? "Panduan Install Android" : "Install Belum Didukung",
    message: iosMode ? "Ikuti langkah berikut untuk menambahkan CatatKas ke layar utama." : androidMode ? "Ikuti langkah berikut menggunakan menu Chrome." : "CatatKas tetap bisa digunakan dari browser ini.",
    confirmText: "Mengerti",
    cancelText: "Tutup",
    type: "info",
    icon: "i",
    content
  });
}

function openModal(options) {
  closeModal(false, true);

  const type = ["danger", "warning", "info", "success"].includes(options.type) ? options.type : "info";
  lastFocusedElement = document.activeElement;
  elements.appModal.className = `app-modal ${type}`;
  elements.appModalIcon.textContent = options.icon || modalIcon(type);
  elements.appModalEyebrow.textContent = options.eyebrow || "CatatKas";
  elements.appModalTitle.textContent = options.title;
  elements.appModalMessage.textContent = options.message;
  elements.appModalCancel.textContent = options.cancelText;
  elements.appModalConfirm.textContent = options.confirmText;
  elements.appModalConfirm.className = `primary-button${type === "danger" ? " danger-action" : ""}${type === "warning" ? " warning-action" : ""}`;
  elements.appModalContent.innerHTML = "";
  if (options.content) elements.appModalContent.appendChild(options.content);
  elements.appModalCancel.hidden = options.cancelText === "";
  elements.appModalConfirm.hidden = options.confirmText === "";
  elements.appModalActions.hidden = options.cancelText === "" && options.confirmText === "";
  elements.appModalOverlay.hidden = false;
  elements.appModal.classList.add("open");
  elements.appModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("sheet-open");

  return new Promise((resolve) => {
    activeModalResolve = resolve;
    elements.appModalConfirm.onclick = () => {
      const result = options.onConfirm ? options.onConfirm() : true;
      if (result === null) return;
      closeModal(result);
    };
    window.setTimeout(() => getFocusableModalElements()[0]?.focus(), 0);
  });
}

function closeModal(result = false, silent = false) {
  if (elements.appModalOverlay.hidden) return;
  elements.appModal.classList.remove("open");
  elements.appModal.setAttribute("aria-hidden", "true");
  elements.appModalOverlay.hidden = true;
  document.body.classList.remove("sheet-open");
  elements.appModalConfirm.onclick = null;
  elements.appModalConfirm.hidden = false;
  elements.appModalActions.hidden = false;

  const resolver = activeModalResolve;
  activeModalResolve = null;
  if (resolver && !silent) resolver(result);
  if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
    lastFocusedElement.focus();
  }
}

function trapModalFocus(event) {
  const focusable = getFocusableModalElements();
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function getFocusableModalElements() {
  return [...elements.appModal.querySelectorAll("button:not([hidden]), input, select, textarea, [tabindex]:not([tabindex='-1'])")]
    .filter((item) => !item.disabled && item.offsetParent !== null);
}

function modalIcon(type) {
  if (type === "danger") return "!";
  if (type === "warning") return "!";
  if (type === "success") return "✓";
  return "i";
}

function resetDraftFilters() {
  draftFilters = {
    category: "Semua",
    payment: "Semua"
  };
  renderFilterChips();
}

function applyDraftFilters() {
  activeFilters = { ...draftFilters };
  renderFilterSummary();
  renderTransactions();
  closeFilterSheet();
}

function ensureActiveFiltersStillExist() {
  if (activeFilters.category !== "Semua" && !LOCKED_TYPES.includes(activeFilters.category)) {
    activeFilters.category = "Semua";
  }
  if (activeFilters.payment !== "Semua" && !state.paymentMethods.includes(activeFilters.payment)) {
    activeFilters.payment = "Semua";
  }
  draftFilters = { ...activeFilters };
}

function renderTransactionCards(target, transactions, showActions) {
  target.innerHTML = "";
  if (!transactions.length) {
    target.innerHTML = '<p class="empty-state">Belum ada transaksi.</p>';
    return;
  }

  transactions.forEach((transaction) => {
    const card = document.createElement("article");
    card.className = "transaction-card";

    const title = transaction.note || transaction.subCategory || transaction.category;
    card.innerHTML = `
      <div class="transaction-main">
        <strong class="transaction-title">${escapeHtml(title)}</strong>
        <div class="transaction-meta">
          <span>${formatDate(transaction.date)}</span>
          <span>${escapeHtml(transaction.type || transaction.category)}</span>
          <span>${escapeHtml(transaction.subCategory || "Lainnya")}</span>
          <span>${escapeHtml(transaction.paymentMethod)}</span>
        </div>
      </div>
      <div class="transaction-side">
        <strong class="transaction-amount ${amountClass(transaction.type)}">${signedAmount(transaction)}</strong>
        <div class="item-actions"></div>
      </div>
    `;

    if (showActions) {
      const actions = card.querySelector(".item-actions");
      actions.appendChild(actionButton("Edit", () => editTransaction(transaction.id)));
      actions.appendChild(actionButton("Hapus", () => deleteTransaction(transaction.id)));
    }

    target.appendChild(card);
  });
}

function renderStats() {
  const monthTransactions = getMonthTransactions();
  const totals = getTotals(monthTransactions);
  const expenseTransactions = monthTransactions.filter((item) => item.type === "Pengeluaran");
  const categoryTotals = groupTotals(expenseTransactions, "subCategory");
  const top = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0];

  // Average expenses over last 30 days from today
  const todayStr = today();
  const thirtyDaysAgo = addDays(todayStr, -30);
  const last30DaysExpense = state.transactions
    .filter((item) => item.type === "Pengeluaran" && item.date >= thirtyDaysAgo && item.date <= todayStr)
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  elements.statsExpense.textContent = rupiah(totals.expense);
  elements.statsBalance.textContent = rupiah(totals.income - totals.expense);
  elements.topExpenseCategory.textContent = top ? `${top[0]} - ${rupiah(top[1])}` : "-";
  elements.dailyAverage.textContent = rupiah(Math.round(last30DaysExpense / 30));
  renderChart(categoryTotals);
}

function renderChart(categoryTotals) {
  const entries = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).slice(0, 6);
  elements.expenseChart.innerHTML = "";
  if (!entries.length) {
    elements.expenseChart.innerHTML = '<p class="empty-state">Belum ada pengeluaran bulan ini.</p>';
    return;
  }

  const max = Math.max(...entries.map((entry) => entry[1]));
  entries.forEach(([name, total]) => {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <div class="bar-info">
        <strong>${escapeHtml(name)}</strong>
        <span>${rupiah(total)}</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width: ${(total / max) * 100}%"></div></div>
    `;
    elements.expenseChart.appendChild(row);
  });
}

function renderMasterData() {
  renderLockedCategoryList();
  renderSubCategoryMasterList();
  renderMasterList(elements.paymentMethodList, "paymentMethods");
}

function renderLockedCategoryList() {
  elements.categoryList.innerHTML = "";
  LOCKED_TYPES.forEach((name) => {
    const item = document.createElement("article");
    item.className = "master-item";
    item.innerHTML = `
      <span class="master-name">${escapeHtml(name)}</span>
      <span class="locked-badge">Terkunci</span>
    `;
    elements.categoryList.appendChild(item);
  });
}

function renderMasterList(target, key) {
  target.innerHTML = "";
  state[key].forEach((name, index) => {
    const item = document.createElement("article");
    item.className = "master-item";
    item.innerHTML = `
      <span class="master-name">${escapeHtml(name)}</span>
      <div class="item-actions"></div>
    `;
    const actions = item.querySelector(".item-actions");
    actions.appendChild(actionButton("Edit", () => editMasterItem(key, index)));
    actions.appendChild(actionButton("Hapus", () => deleteMasterItem(key, index)));
    target.appendChild(item);
  });
}

function renderSubCategoryMasterList() {
  elements.subCategoryList.innerHTML = "";
  LOCKED_TYPES.forEach((type) => {
    const group = document.createElement("section");
    group.className = "master-group";
    group.innerHTML = `<h3>Subkategori ${escapeHtml(type)}</h3><div class="master-list-inner"></div>`;
    const list = group.querySelector(".master-list-inner");
    getSubCategoriesForType(type).forEach((name, index) => {
      const item = document.createElement("article");
      item.className = "master-item";
      item.innerHTML = `
        <span class="master-name">${escapeHtml(name)}</span>
        <div class="item-actions"></div>
      `;
      const actions = item.querySelector(".item-actions");
      actions.appendChild(actionButton("Edit", () => editSubCategoryItem(type, index)));
      actions.appendChild(actionButton("Hapus", () => deleteSubCategoryItem(type, index)));
      list.appendChild(item);
    });
    elements.subCategoryList.appendChild(group);
  });
}

async function addMasterItem(key) {
  if (key === "subCategories") {
    addSubCategoryItem();
    return;
  }
  showToast("Kategori utama sudah ditentukan dan tidak bisa diubah.", "info");
  return;
  const result = await showFormModal({
    title: "Tambah Metode Pembayaran",
    message: "Masukkan nama metode pembayaran baru.",
    confirmText: "Tambah",
    type: "info",
    fields: [{ name: "name", label: "Nama item", required: true, placeholder: "Contoh: Mandiri" }],
    validate: ({ name }) => validateMasterName(key, name)
  });
  if (!result) return;
  state[key].push(result.name.trim());
  persist();
  renderAll();
  showToast("Master data berhasil ditambahkan.", "success");
}

async function editMasterItem(key, index) {
  if (key === "categories") {
    showToast("Kategori utama sudah ditentukan dan tidak bisa diubah.", "info");
    return;
  }
  const oldName = state[key][index];
  const result = await showFormModal({
    title: "Edit Metode Pembayaran",
    message: "Perbarui nama metode pembayaran.",
    confirmText: "Simpan",
    type: "info",
    fields: [{ name: "name", label: "Nama item", value: oldName, required: true }],
    validate: ({ name }) => validateMasterName(key, name, oldName)
  });
  if (!result) return;
  state[key][index] = result.name.trim();
  persist();
  renderAll();
  showToast("Master data berhasil diedit.", "success");
}

async function deleteMasterItem(key, index) {
  if (key === "categories") {
    showToast("Kategori utama sudah ditentukan dan tidak bisa diubah.", "info");
    return;
  }
  const name = state[key][index];
  const used = isMasterItemUsed(key, name);
  const confirmed = await showConfirmModal({
    title: "Hapus Metode Pembayaran?",
    message: used ? `"${name}" sedang dipakai transaksi lama. Transaksi tetap disimpan, tetapi pilihan ini akan dihapus dari master data.` : `"${name}" akan dihapus dari master data.`,
    confirmText: "Hapus",
    cancelText: "Batal",
    type: "danger"
  });
  if (!confirmed) return;
  state[key].splice(index, 1);
  persist();
  renderAll();
  showToast("Master data berhasil dihapus.", "success");
}

async function addSubCategoryItem() {
  const result = await showFormModal({
    title: "Tambah Subkategori",
    message: "Pilih kategori utama lalu masukkan nama subkategori.",
    confirmText: "Tambah",
    type: "info",
    fields: [
      { name: "type", label: "Kategori utama", type: "select", options: LOCKED_TYPES, value: LOCKED_TYPES[0], required: true },
      { name: "name", label: "Nama subkategori", required: true, placeholder: "Contoh: Internet" }
    ],
    validate: ({ type, name }) => validateSubCategoryName(type, name)
  });
  if (!result) return;
  state.subCategories[result.type].push(result.name.trim());
  persist();
  renderAll();
  showToast("Master data berhasil ditambahkan.", "success");
}

async function editSubCategoryItem(type, index) {
  const list = getSubCategoriesForType(type);
  const oldName = list[index];
  const result = await showFormModal({
    title: "Edit Subkategori",
    message: `Perbarui subkategori ${type}.`,
    confirmText: "Simpan",
    type: "info",
    fields: [{ name: "name", label: "Nama subkategori", value: oldName, required: true }],
    validate: ({ name }) => validateSubCategoryName(type, name, oldName)
  });
  if (!result) return;
  list[index] = result.name.trim();
  persist();
  renderAll();
  showToast("Master data berhasil diedit.", "success");
}

async function deleteSubCategoryItem(type, index) {
  const list = getSubCategoriesForType(type);
  const name = list[index];
  const used = isMasterItemUsed("subCategories", name, type);
  const confirmed = await showConfirmModal({
    title: "Hapus Subkategori?",
    message: used ? `"${name}" sedang dipakai transaksi lama. Transaksi tetap disimpan, tetapi subkategori ini akan dihapus dari master data.` : `"${name}" akan dihapus dari ${type}.`,
    confirmText: "Hapus",
    cancelText: "Batal",
    type: "danger"
  });
  if (!confirmed) return;
  list.splice(index, 1);
  persist();
  renderAll();
  showToast("Master data berhasil dihapus.", "success");
}

function editTransaction(id) {
  const transaction = state.transactions.find((item) => item.id === id);
  if (!transaction) return;

  elements.id.value = transaction.id;
  elements.date.value = transaction.date;
  syncMainCategory(normalizeMainCategory(transaction.type || transaction.category, LOCKED_TYPES));
  setSubCategoryValue(transaction.subCategory);
  setSelectValue(elements.paymentMethod, state.paymentMethods, transaction.paymentMethod);
  elements.amount.value = formatRupiahInput(String(transaction.amount));
  elements.note.value = transaction.note || "";
  elements.submitButton.textContent = "Update Transaksi";
  elements.cancelEditButton.hidden = false;
  navigate("add");
}

async function deleteTransaction(id) {
  const confirmed = await showConfirmModal({
    title: "Hapus Transaksi?",
    message: "Data transaksi ini akan dihapus permanen dari perangkat.",
    confirmText: "Hapus",
    cancelText: "Batal",
    type: "danger"
  });
  if (!confirmed) return;
  state.transactions = state.transactions.filter((item) => item.id !== id);
  persist();
  renderAll();
  showToast("Transaksi berhasil dihapus.", "success");
}

function resetForm() {
  elements.form.reset();
  elements.id.value = "";
  elements.date.value = today();
  elements.submitButton.textContent = "Simpan Transaksi";
  elements.cancelEditButton.hidden = true;
  fillSelect(elements.type, LOCKED_TYPES);
  fillSelect(elements.category, LOCKED_TYPES);
  syncMainCategory(elements.type.value || LOCKED_TYPES[0]);
  fillSelect(elements.paymentMethod, state.paymentMethods);
  if (state.paymentMethods.includes(preferences.defaultPayment)) {
    elements.paymentMethod.value = preferences.defaultPayment;
  }
}

async function resetMasterData() {
  const confirmed = await showConfirmModal({
    title: "Reset Master Data?",
    message: "Kategori, subkategori, dan metode pembayaran akan dikembalikan ke bawaan aplikasi.",
    confirmText: "Reset",
    cancelText: "Batal",
    type: "danger"
  });
  if (!confirmed) return;
  state.types = [...LOCKED_TYPES];
  state.categories = [...LOCKED_TYPES];
  state.subCategories = structuredClone(defaults.subCategories);
  state.paymentMethods = structuredClone(defaults.paymentMethods);
  persist();
  renderAll();
  showToast("Master data berhasil direset.", "success");
}

async function deleteAllTransactions() {
  const confirmed = await showConfirmModal({
    title: "Hapus Semua Transaksi?",
    message: "Semua transaksi akan dihapus permanen dari perangkat kecuali Anda memiliki file backup.",
    confirmText: "Hapus",
    cancelText: "Batal",
    type: "danger"
  });
  if (!confirmed) return;
  state.transactions = [];
  persist();
  renderAll();
  showToast("Semua transaksi berhasil dihapus.", "success");
}

function renderOfflineStatus() {
  if (!elements.offlineStatusLabel || !elements.offlineStatusText) return;
  const isOnline = navigator.onLine;
  elements.offlineStatusLabel.className = "offline-status-badge " + (isOnline ? "online" : "offline");
  elements.offlineStatusLabel.textContent = isOnline ? "● Online" : "● Offline";
  elements.offlineStatusText.textContent = isOnline
    ? "Terhubung ke internet. Update aplikasi tersedia."
    : "Tidak ada koneksi. CatatKas tetap bisa digunakan offline.";
}

function getResolvedTheme() {
  if (preferences.theme === "dark") return "dark";
  if (preferences.theme === "light") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemePreference() {
  const darkMode = getResolvedTheme() === "dark";
  document.body.classList.toggle("theme-dark", darkMode);
  document.body.classList.toggle("theme-light", !darkMode);
  if (elements.themeMeta) {
    elements.themeMeta.setAttribute("content", darkMode ? "#111318" : "#0f766e");
  }
}

function renderPreferences() {
  elements.appVersionLabel.textContent = APP_VERSION;
  if (elements.downloadAppVersion) elements.downloadAppVersion.textContent = `v${APP_VERSION}`;
  updateSettingsInstallButton();
  renderUpdateSettings();
  renderOfflineStatus();
  applyThemePreference();
  elements.preferenceCurrency.value = preferences.currency;
  elements.preferenceDateFormat.value = preferences.dateFormat;
  elements.preferenceTheme.value = preferences.theme;
  fillSelect(elements.preferenceDefaultPayment, state.paymentMethods);
  if (state.paymentMethods.includes(preferences.defaultPayment)) {
    elements.preferenceDefaultPayment.value = preferences.defaultPayment;
  } else if (state.paymentMethods.length) {
    preferences.defaultPayment = state.paymentMethods[0];
    elements.preferenceDefaultPayment.value = preferences.defaultPayment;
    persistPreferences();
  }
}

function savePreferencesFromForm() {
  preferences.currency = elements.preferenceCurrency.value;
  preferences.dateFormat = elements.preferenceDateFormat.value;
  preferences.theme = elements.preferenceTheme.value;
  preferences.defaultPayment = elements.preferenceDefaultPayment.value;
  persistPreferences();
  applyThemePreference();
  showToast("Preferensi berhasil disimpan.", "success", 2500);
}

function exportBackup() {
  downloadFile(`catatkas-${today()}.json`, JSON.stringify(state, null, 2), "application/json");
  showToast("Data berhasil diexport.", "success");
}

function exportCsv() {
  const header = ["Tanggal", "Jenis", "Nominal", "Kategori", "Subkategori", "Metode Pembayaran", "Catatan"];
  const rows = getSortedTransactions(state.transactions).map((item) => [
    item.date,
    item.type,
    item.amount,
    item.category,
    item.subCategory,
    item.paymentMethod,
    item.note || ""
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  downloadFile(`transaksi-${today()}.csv`, csv, "text/csv;charset=utf-8");
  showToast("Data berhasil diexport.", "success");
}

async function importBackup(event) {
  const file = event.target.files[0];
  if (!file) return;
  const confirmed = await showConfirmModal({
    title: "Import Data?",
    message: "Data dari file JSON akan dimuat ke CatatKas. Pastikan file backup valid.",
    confirmText: "Import",
    cancelText: "Batal",
    type: "info"
  });
  if (!confirmed) {
    event.target.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const backup = JSON.parse(reader.result);
      state.types = [...LOCKED_TYPES];
      state.categories = [...LOCKED_TYPES];
      state.subCategories = normalizeSubCategories(backup.subCategories, LOCKED_TYPES);
      state.paymentMethods = Array.isArray(backup.paymentMethods) ? backup.paymentMethods : defaults.paymentMethods;
      state.transactions = Array.isArray(backup.transactions) ? backup.transactions.map((item) => ({
        ...item,
        type: migrateTransactionType(item, state.subCategories),
        category: migrateTransactionType(item, state.subCategories)
      })) : [];
      persist();
      renderAll();
      showToast("Data berhasil diimport.", "success");
    } catch {
      showToast("File backup tidak valid.", "error");
    }
  };
  reader.onerror = () => {
    showToast("File backup gagal dibaca.", "error");
  };
  reader.readAsText(file);
  event.target.value = "";
}

async function installApp() {
  console.log("[PWA Debug] Install button clicked");
  clearTimeout(installAutoHideTimer);
  
  if (isRunningStandalone()) {
    console.log("[PWA Debug] Already in standalone mode");
    elements.installButton.hidden = false;
    localStorage.setItem("catatkas_app_installed", "1");
    updateSettingsInstallButton();
    return;
  }

  if (!deferredPrompt) {
    console.log("[PWA Debug] deferredPrompt is null - beforeinstallprompt never fired");
    console.log("[PWA Debug] Device:", navigator.userAgent);
    showInstallGuideModal(isIOSDevice() ? "ios" : "android");
    return;
  }

  console.log("[PWA Debug] deferredPrompt exists, showing install prompt");
  try {
    const result = await deferredPrompt.prompt();
    console.log("[PWA Debug] Prompt result:", result);
    
    const userChoice = await deferredPrompt.userChoice;
    console.log("[PWA Debug] User choice:", userChoice.outcome);
    
    if (userChoice.outcome === "accepted") {
      console.log("[PWA Debug] User accepted install");
    } else {
      // User dismissed — likely a TWA where install isn't possible
      console.log("[PWA Debug] User dismissed install");
      localStorage.setItem("catatkas_app_installed", "1");
      elements.installButton.hidden = false;
      updateSettingsInstallButton();
    }
    
    deferredPrompt = null;
  } catch (error) {
    console.error("[PWA Debug] Install prompt error:", error);
    // Prompt failed — likely a TWA context
    localStorage.setItem("catatkas_app_installed", "1");
    elements.installButton.hidden = false;
    updateSettingsInstallButton();
  }
}

function handleAppDownload(platform) {
  if (platform === "android") {
    window.location.href = ANDROID_APK_DOWNLOAD_URL;
    showToast("Download APK Android dimulai dari GitHub Release.", "success");
    return;
  }

  if (platform === "ios") {
    showInstallGuideModal("ios");
    return;
  }

  installApp();
}

function selectDownloadPlatform(platform) {
  if (!["android", "ios", "desktop"].includes(platform)) return;
  activeDownloadPlatform = platform;
  renderDownloadGuide();
}

function renderDownloadGuide() {
  const guides = {
    android: {
      title: "Android APK",
      text: "Download file APK dari GitHub Release, lalu buka file tersebut untuk instalasi di Android.",
      action: "Download APK"
    },
    ios: {
      title: "iOS",
      text: "Buka CatatKas melalui Safari, tekan tombol Share, lalu pilih Add to Home Screen.",
      action: ""
    },
    desktop: {
      title: "Desktop",
      text: "Install CatatKas sebagai aplikasi desktop agar bisa diakses langsung dari komputer Anda.",
      action: "Install"
    }
  };

  const guide = guides[activeDownloadPlatform] || guides.android;

  elements.downloadPlatformButtons.forEach((button) => {
    const active = button.dataset.downloadPlatform === activeDownloadPlatform;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });

  if (elements.downloadGuideTitle) elements.downloadGuideTitle.textContent = guide.title;
  if (elements.downloadGuideText) elements.downloadGuideText.textContent = guide.text;
  if (elements.downloadGuideAction) {
    elements.downloadGuideAction.hidden = !guide.action;
    elements.downloadGuideAction.textContent = guide.action || "";
  }
}

function isRunningStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || 
         window.matchMedia("(display-mode: fullscreen)").matches ||
         window.matchMedia("(display-mode: minimal-ui)").matches ||
         window.navigator.standalone === true || 
         document.referrer.startsWith("android-app://") ||
         new URLSearchParams(window.location.search).has("twa") ||
         localStorage.getItem("catatkas_app_installed") === "1" ||
         (window.outerHeight === 0 && window.outerWidth > 0);
}

function isIOSDevice() {
  const platform = window.navigator.platform || "";
  const userAgent = window.navigator.userAgent || "";
  const iOSPlatform = /iPad|iPhone|iPod/.test(platform);
  const iPadOS = platform === "MacIntel" && window.navigator.maxTouchPoints > 1;
  return iOSPlatform || iPadOS || /iPad|iPhone|iPod/.test(userAgent);
}

function updateSettingsInstallButton() {
  if (isRunningStandalone()) {
    if (elements.installHelperText) {
      elements.installHelperText.textContent = "CatatKas sudah terinstall. Anda tetap bisa melihat panduan platform lain di sini.";
    }
  } else if (deferredPrompt) {
    if (elements.installHelperText) {
      elements.installHelperText.textContent = "Desktop memakai installer bawaan browser. iOS memakai Share lalu Add to Home Screen.";
    }
  } else {
    if (elements.installHelperText) {
      elements.installHelperText.textContent = "Pilih platform untuk melihat panduan instalasi yang sesuai.";
    }
  }
  renderDownloadGuide();
}



function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    elements.checkUpdateButton.disabled = true;
    elements.updateNowButton.hidden = true;
    return;
  }

  navigator.serviceWorker.addEventListener("controllerchange", async () => {
    if (refreshingForUpdate) return;
    refreshingForUpdate = true;
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter((key) => key.startsWith("catatkas-cache-")).map((key) => caches.delete(key))
        );
      }
    } catch (_) { /* ignore cache clear errors */ }
    window.location.reload();
  });

  navigator.serviceWorker.register(PWA_BASE + "service-worker.js", { scope: PWA_BASE })
    .then((registration) => {
      serviceWorkerRegistration = registration;
      if (registration.waiting) {
        handleUpdateReady(registration.waiting, false);
      }

      registration.addEventListener("updatefound", () => {
        const newWorker = registration.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            handleUpdateReady(newWorker, false);
          }
        });
      });

      checkForAppUpdate(false);
    })
    .catch(() => {
      elements.checkUpdateButton.disabled = true;
    });
}

async function checkForAppUpdate(manual = false) {
  if (!("serviceWorker" in navigator)) {
    if (manual) showToast("Browser ini belum mendukung pengecekan update PWA.", "warning");
    return false;
  }

  if (!navigator.onLine) {
    if (manual) showToast("Tidak dapat mengecek update saat offline.", "warning");
    return false;
  }

  elements.checkUpdateButton.disabled = true;
  elements.checkUpdateButton.textContent = "Mengecek update...";
  renderUpdateSettings({ checking: true });

  const registration = serviceWorkerRegistration || await navigator.serviceWorker.getRegistration("./");
  if (!registration) {
    if (manual) showToast("Service worker belum aktif. Coba lagi setelah halaman dimuat ulang.", "warning");
    elements.checkUpdateButton.disabled = false;
    elements.checkUpdateButton.textContent = "Cek Update";
    renderUpdateSettings();
    return false;
  }

  serviceWorkerRegistration = registration;
  if (registration.waiting || pendingServiceWorker) {
    pendingServiceWorker = registration.waiting || pendingServiceWorker;
    const hasUpdate = await handleUpdateReady(pendingServiceWorker, manual);
    elements.checkUpdateButton.disabled = false;
    elements.checkUpdateButton.textContent = "Cek Update";
    if (manual && hasUpdate) applyAppUpdate();
    return hasUpdate;
  }

  try {
    await registration.update();
    await waitForUpdateCheck(registration);
  } catch {
    if (manual) showToast("Tidak bisa cek update saat ini. Periksa koneksi internet.", "warning");
    elements.checkUpdateButton.disabled = false;
    elements.checkUpdateButton.textContent = "Cek Update";
    renderUpdateSettings();
    return false;
  }

  if (registration.waiting || pendingServiceWorker) {
    pendingServiceWorker = registration.waiting || pendingServiceWorker;
    const hasUpdate = await handleUpdateReady(pendingServiceWorker, manual);
    elements.checkUpdateButton.disabled = false;
    elements.checkUpdateButton.textContent = "Cek Update";
    if (manual && hasUpdate) applyAppUpdate();
    return hasUpdate;
  }

  localStorage.removeItem(UPDATE_KEYS.availableVersion);
  pendingServiceWorker = null;
  if (manual) {
    await refreshAppShellFromNetwork();
    return false;
  }
  elements.checkUpdateButton.disabled = false;
  elements.checkUpdateButton.textContent = "Cek Update";
  renderUpdateSettings();
  return false;
}

function waitForUpdateCheck(registration) {
  return new Promise((resolve) => {
    const worker = registration.installing;
    if (!worker) {
      window.setTimeout(resolve, 400);
      return;
    }

    const done = () => {
      if (!["installed", "activated", "redundant"].includes(worker.state)) return;
      worker.removeEventListener("statechange", done);
      resolve();
    };
    worker.addEventListener("statechange", done);
    window.setTimeout(resolve, 2500);
  });
}

async function handleUpdateReady(worker, manual = false) {
  const updateVersion = await requestServiceWorkerVersion(worker);
  if (!isNewerVersion(updateVersion, APP_VERSION)) {
    pendingServiceWorker = null;
    localStorage.removeItem(UPDATE_KEYS.availableVersion);
    renderUpdateSettings();
    if (manual) showToast("CatatKas sudah menggunakan versi terbaru.", "success");
    return false;
  }

  pendingServiceWorker = worker;
  localStorage.setItem(UPDATE_KEYS.availableVersion, updateVersion);
  renderUpdateSettings();

  if (manual) {
    showToast("Update ditemukan. CatatKas sedang diperbarui...", "info");
  } else if (!IS_DEV && !updateModalShownThisSession && shouldShowUpdatePrompt(updateVersion)) {
    updateModalShownThisSession = true;
    showUpdateAvailableToast(updateVersion);
  }
  return true;
}

function requestServiceWorkerVersion(worker) {
  return new Promise((resolve) => {
    if (!worker) {
      resolve(localStorage.getItem(UPDATE_KEYS.availableVersion) || APP_VERSION);
      return;
    }

    const channel = new MessageChannel();
    const timer = window.setTimeout(() => {
      channel.port1.onmessage = null;
      resolve(localStorage.getItem(UPDATE_KEYS.availableVersion) || "baru");
    }, 800);

    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      resolve(event.data?.version || "baru");
    };

    worker.postMessage({ type: "CHECK_UPDATE" }, [channel.port2]);
  });
}

function applyAppUpdate() {
  if (!navigator.onLine) {
    showToast("Hubungkan internet untuk memperbarui CatatKas.", "warning");
    return;
  }

  const worker = pendingServiceWorker || serviceWorkerRegistration?.waiting;
  if (!worker) {
    showToast("Update belum siap diterapkan. Coba cek update lagi.", "warning");
    return;
  }

  showToast("Memperbarui CatatKas...", "info");
  localStorage.setItem(UPDATE_KEYS.successPending, "1");
  worker.postMessage({ type: "SKIP_WAITING" });
}

async function refreshAppShellFromNetwork() {
  if (!navigator.onLine) {
    showToast("Hubungkan internet untuk memperbarui file aplikasi.", "warning");
    return;
  }

  elements.checkUpdateButton.disabled = true;
  elements.checkUpdateButton.textContent = "Memperbarui...";
  elements.updateStatusText.textContent = "Mengambil file aplikasi terbaru...";

  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("catatkas-cache-"))
          .map((key) => caches.delete(key))
      );
    }

    localStorage.setItem(UPDATE_KEYS.cacheRefreshPending, "1");
    window.location.reload();
  } catch {
    elements.checkUpdateButton.disabled = false;
    elements.checkUpdateButton.textContent = "Cek Update";
    renderUpdateSettings();
    showToast("Gagal memperbarui cache aplikasi. Coba refresh halaman.", "warning");
  }
}

function remindUpdateLater(updateVersion) {
  const oneDay = 24 * 60 * 60 * 1000;
  localStorage.setItem(UPDATE_KEYS.remindLaterUntil, String(Date.now() + oneDay));
  localStorage.setItem(UPDATE_KEYS.availableVersion, updateVersion);
  showToast("CatatKas akan mengingatkan update lagi besok.", "info");
  renderUpdateSettings();
}

function ignoreUpdate(updateVersion) {
  localStorage.setItem(UPDATE_KEYS.ignoredVersion, updateVersion);
  localStorage.setItem(UPDATE_KEYS.availableVersion, updateVersion);
  showToast("Update ini diabaikan. Anda tetap bisa cek update dari Pengaturan.", "info");
  renderUpdateSettings();
}

function shouldShowUpdatePrompt(updateVersion) {
  if (!navigator.onLine) return false;
  if (!isNewerVersion(updateVersion, APP_VERSION)) return false;
  const remindLaterUntil = Number(localStorage.getItem(UPDATE_KEYS.remindLaterUntil) || 0);
  if (remindLaterUntil > Date.now()) return false;
  return localStorage.getItem(UPDATE_KEYS.ignoredVersion) !== updateVersion;
}

function renderUpdateSettings(options = {}) {
  const availableVersion = localStorage.getItem(UPDATE_KEYS.availableVersion);
  const hasUpdate = Boolean(pendingServiceWorker && availableVersion && isNewerVersion(availableVersion, APP_VERSION));
  elements.updateAppName.textContent = `CatatKas v${APP_VERSION}`;
  elements.appVersionLabel.textContent = APP_VERSION;

  if (options.checking) {
    elements.updateStatusText.textContent = "Mengecek update...";
    elements.updateNowButton.hidden = true;
    return;
  }

  elements.updateStatusText.textContent = hasUpdate
    ? `Versi baru tersedia: v${availableVersion}`
    : "Menggunakan versi terbaru";
  elements.updateNowButton.hidden = !hasUpdate;
}

function isNewerAppVersion(version) {
  return isNewerVersion(version, APP_VERSION);
}

function isNewerVersion(latestVersion, currentVersion) {
  if (!latestVersion || latestVersion === "baru") return false;
  if (!currentVersion || currentVersion === "baru") return latestVersion === "baru";
  if (latestVersion === currentVersion) return false;
  
  const current = parseVersion(currentVersion);
  const latest = parseVersion(latestVersion);
  if (!current || !latest) return latestVersion !== currentVersion;

  for (let i = 0; i < Math.max(current.length, latest.length); i++) {
    const currentPart = current[i] || 0;
    const latestPart = latest[i] || 0;
    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }
  return false;
}
function parseVersion(version) {
  const parts = String(version).split(".").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return null;
  return parts;
}

function showUpdateSuccessToastIfNeeded() {
  const successPending = localStorage.getItem(UPDATE_KEYS.successPending) === "1";
  const cacheRefreshPending = localStorage.getItem(UPDATE_KEYS.cacheRefreshPending) === "1";
  localStorage.setItem(UPDATE_KEYS.currentVersion, APP_VERSION);
  if (!successPending && !cacheRefreshPending) return;

  localStorage.removeItem(UPDATE_KEYS.successPending);
  localStorage.removeItem(UPDATE_KEYS.cacheRefreshPending);
  localStorage.removeItem(UPDATE_KEYS.availableVersion);
  localStorage.removeItem(UPDATE_KEYS.remindLaterUntil);
  localStorage.removeItem(UPDATE_KEYS.ignoredVersion);
  updateModalShownThisSession = false;
  window.setTimeout(() => {
    showToast(
      successPending ? "CatatKas berhasil diperbarui." : "File aplikasi berhasil dimuat ulang. Data lokal tetap aman.",
      "success"
    );
  }, 300);
}

function showUpdateAvailableToast(updateVersion) {
  if (updateToastElement?.isConnected) return;

  const toast = document.createElement("div");
  toast.className = "toast info update-toast";
  toast.setAttribute("role", "status");

  const body = document.createElement("div");
  body.className = "update-toast-body";

  const text = document.createElement("span");
  text.className = "update-toast-text";
  text.textContent = `Update tersedia${updateVersion ? ` (v${updateVersion})` : ""}`;

  const updateBtn = document.createElement("button");
  updateBtn.type = "button";
  updateBtn.className = "update-toast-btn";
  updateBtn.textContent = "Update";
  updateBtn.addEventListener("click", () => {
    toast.remove();
    updateToastElement = null;
    applyAppUpdate();
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "update-toast-close";
  closeBtn.setAttribute("aria-label", "Tutup");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => {
    toast.remove();
    updateToastElement = null;
  });

  body.append(text, updateBtn, closeBtn);
  toast.appendChild(body);
  elements.toastContainerTop.appendChild(toast);
  updateToastElement = toast;
}

function getMonthTransactions() {
  const month = elements.summaryMonth.value;
  return state.transactions.filter((item) => item.date.startsWith(month));
}

function getTotals(transactions) {
  return {
    income: transactions.filter((item) => item.type === "Pemasukan").reduce((sum, item) => sum + Number(item.amount || 0), 0),
    expense: transactions.filter((item) => item.type === "Pengeluaran").reduce((sum, item) => sum + Number(item.amount || 0), 0),
    transfer: transactions.filter((item) => item.type === "Pemindahan Saldo").reduce((sum, item) => sum + Number(item.amount || 0), 0)
  };
}

function groupTotals(transactions, key) {
  return transactions.reduce((result, item) => {
    const name = item[key] || "Lainnya";
    result[name] = (result[name] || 0) + Number(item.amount || 0);
    return result;
  }, {});
}

function getSortedTransactions(transactions) {
  return [...transactions].sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    if (byDate !== 0) return byDate;
    return (b.createdAt || "").localeCompare(a.createdAt || "");
  });
}

function getDaysElapsedInSelectedMonth() {
  const selected = elements.summaryMonth.value;
  const now = today();
  if (selected === now.slice(0, 7)) return Number(now.slice(8, 10));
  const [year, month] = selected.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}

function setSelectValue(select, list, value) {
  if (!list.includes(value)) {
    list.push(value);
    persist();
    renderAll();
  }
  select.value = value;
}

function syncMainCategory(type) {
  const mainCategory = normalizeMainCategory(type, LOCKED_TYPES);
  if (!state.subCategories[mainCategory]) state.subCategories[mainCategory] = ["Lainnya"];
  elements.type.value = mainCategory;
  elements.category.value = mainCategory;
  renderSubCategoryOptions(mainCategory, true);
}

function renderSubCategoryOptions(type, resetInvalid = false) {
  const mainCategory = normalizeMainCategory(type || elements.type.value, LOCKED_TYPES);
  const current = elements.subCategory.value;
  const list = getSubCategoriesForType(mainCategory);
  fillSelect(elements.subCategory, list);
  if (!list.includes(current) || resetInvalid) {
    elements.subCategory.value = list[0] || "";
  } else {
    elements.subCategory.value = current;
  }
}

function setSubCategoryValue(value) {
  const list = getSubCategoriesForType(elements.type.value);
  if (!list.includes(value)) {
    state.subCategories[elements.type.value].push(value);
    renderSubCategoryOptions(elements.type.value);
  }
  elements.subCategory.value = value;
}

function getSubCategoriesForType(type) {
  const mainCategory = normalizeMainCategory(type, LOCKED_TYPES);
  if (!state.subCategories[mainCategory]) state.subCategories[mainCategory] = ["Lainnya"];
  return state.subCategories[mainCategory];
}

function isValidSubCategory(type, subCategory) {
  return getSubCategoriesForType(type).includes(subCategory);
}

function validateMasterName(key, name, currentName = "") {
  const clean = String(name || "").trim();
  if (!clean) return "Nama item wajib diisi.";
  const list = key === "types" ? state.types : state[key];
  if (list.includes(clean) && clean !== currentName) return "Nama item sudah ada.";
  return "";
}

function validateSubCategoryName(type, name, currentName = "") {
  if (!LOCKED_TYPES.includes(type)) return "Kategori utama tidak valid.";
  const clean = String(name || "").trim();
  if (!clean) return "Nama item wajib diisi.";
  const list = getSubCategoriesForType(type);
  if (list.includes(clean) && clean !== currentName) return "Nama item sudah ada.";
  return "";
}

function isMasterItemUsed(key, name, type = "") {
  if (key === "types" || key === "categories") {
    return state.transactions.some((item) => item.type === name || item.category === name);
  }
  if (key === "subCategories") {
    return state.transactions.some((item) => item.subCategory === name && (!type || item.type === type || item.category === type));
  }
  if (key === "paymentMethods") {
    return state.transactions.some((item) => item.paymentMethod === name);
  }
  return false;
}

function normalizeTypes(types) {
  const fallback = structuredClone(defaults.types);
  const list = Array.isArray(types) ? types : fallback;
  const clean = [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
  return clean.length ? clean : fallback;
}

function normalizeMainCategory(value, types = LOCKED_TYPES) {
  const clean = String(value || "").trim();
  const allowedTypes = LOCKED_TYPES;
  if (allowedTypes.includes(clean)) return clean;
  return allowedTypes[0];
}

function migrateTransactionType(transaction, subCategories) {
  const type = String(transaction.type || transaction.category || "").trim();
  if (LOCKED_TYPES.includes(type)) return type;
  // Migrate Transfer or unknown types based on sub-category inference
  const sub = String(transaction.subCategory || "").trim();
  if (subCategories) {
    for (const [locked, list] of Object.entries(subCategories)) {
      if (list.includes(sub)) return locked;
    }
  }
  // Default fallback for Transfer-related items
  if (["Tarik Tunai", "Top Up E-Wallet"].includes(sub)) return "Pemindahan Saldo";
  if (["Antar Rekening", "Pindah Saldo"].includes(sub)) return "Pemindahan Saldo";
  return inferSubCategoryType(sub || type);
}

function normalizeSubCategories(input, types = LOCKED_TYPES) {
  const result = {};
  LOCKED_TYPES.forEach((type) => {
    const values = input && Array.isArray(input[type]) ? input[type] : defaults.subCategories[type] || ["Lainnya"];
    result[type] = uniqueClean(values);
  });
  // Migrate any orphan sub-categories from removed types (e.g. Transfer)
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [oldType, list] of Object.entries(input)) {
      if (LOCKED_TYPES.includes(oldType)) continue;
      if (Array.isArray(list)) {
        list.forEach((name) => {
          const clean = String(name || "").trim();
          if (!clean) return;
          const target = inferSubCategoryType(clean);
          if (!result[target].includes(clean)) result[target].push(clean);
        });
      }
    }
  }
  return result;
}

function inferSubCategoryType(name) {
  const value = String(name || "").trim();
  for (const [type, list] of Object.entries(defaults.subCategories)) {
    if (list.includes(value)) return type;
  }
  if (["Gaji", "Bonus", "Pendapatan Usaha", "Hadiah"].includes(value)) return "Pemasukan";
  if (["Pindah Akun", "Antar Rekening", "Tarik Tunai", "Top Up E-Wallet", "Pindah Saldo"].includes(value)) return "Pemindahan Saldo";
  return "Pengeluaran";
}

function findSubCategoryType(name) {
  const value = String(name || "").trim();
  return LOCKED_TYPES.find((type) => getSubCategoriesForType(type).includes(value));
}

function uniqueClean(values) {
  const clean = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
  return clean.length ? clean : ["Lainnya"];
}

function actionButton(label, callback) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "small-button";
  button.textContent = label;
  button.addEventListener("click", callback);
  return button;
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function signedAmount(transaction) {
  if (transaction.type === "Pemasukan") return `+${rupiah(transaction.amount)}`;
  if (transaction.type === "Pengeluaran") return `-${rupiah(transaction.amount)}`;
  return rupiah(transaction.amount);
}

function amountClass(type) {
  if (type === "Pengeluaran") return "amount-expense";
  if (type === "Pemindahan Saldo") return "amount-transfer";
  return "amount-income";
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(y, m - 1, d);
  next.setDate(next.getDate() + days);
  const ny = next.getFullYear();
  const nm = String(next.getMonth() + 1).padStart(2, "0");
  const nd = String(next.getDate()).padStart(2, "0");
  return `${ny}-${nm}-${nd}`;
}

function formatRupiahInput(value) {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  return new Intl.NumberFormat("id-ID").format(Number(digits));
}

function formatAmountInput(event) {
  const input = event.target;
  const cursorPos = input.selectionStart;
  const oldValue = input.value;
  const formatted = formatRupiahInput(oldValue);
  input.value = formatted;

  // Restore cursor position accounting for added/removed separators
  const diff = formatted.length - oldValue.length;
  const newPos = Math.max(0, cursorPos + diff);
  input.setSelectionRange(newPos, newPos);
}

function rupiah(value) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(value || 0);
}

function formatDate(value) {
  const d = new Date(`${value}T00:00:00`);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const fmt = preferences.dateFormat || "DD/MM/YYYY";
  if (fmt === "MM/DD/YYYY") return `${mm}/${dd}/${yyyy}`;
  if (fmt === "YYYY/MM/DD") return `${yyyy}/${mm}/${dd}`;
  return `${dd}/${mm}/${yyyy}`;
}

function formatMonth(value) {
  return new Intl.DateTimeFormat("id-ID", {
    month: "long",
    year: "numeric"
  }).format(new Date(`${value}-01T00:00:00`));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}



