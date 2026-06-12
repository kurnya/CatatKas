const STORAGE_KEY = "catatan_keuangan_pwa_v1";

const defaults = {
  types: ["Pemasukan", "Pengeluaran", "Transfer"],
  categories: ["Pemasukan", "Pengeluaran", "Transfer"],
  subCategories: {
    Pemasukan: ["Gaji", "Bonus", "Pendapatan Usaha", "Hadiah", "Lainnya"],
    Pengeluaran: ["Makan & Minum", "Transportasi", "Belanja", "Tagihan", "Kesehatan", "Pendidikan", "Hiburan", "Kebutuhan Rumah", "Lainnya"],
    Transfer: ["Antar Rekening", "Tarik Tunai", "Top Up E-Wallet", "Pindah Saldo", "Lainnya"]
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

const state = loadState();
let deferredInstallPrompt = null;
let activeFilters = {
  category: "Semua",
  payment: "Semua"
};
let draftFilters = { ...activeFilters };

const elements = {
  pageTitle: document.querySelector("#pageTitle"),
  pages: document.querySelectorAll(".page"),
  navItems: document.querySelectorAll(".nav-item"),
  installButton: document.querySelector("#installButton"),
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
  statsIncome: document.querySelector("#statsIncome"),
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
  resetMasterButton: document.querySelector("#resetMasterButton")
};

init();

function init() {
  const month = today().slice(0, 7);
  elements.summaryMonth.value = month;
  elements.historyMonth.value = month;
  elements.date.value = today();
  bindEvents();
  renderAll();
  navigate("home");
  registerServiceWorker();
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
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeFilterSheet();
  });
  elements.exportButton.addEventListener("click", exportBackup);
  elements.exportCsvButton.addEventListener("click", exportCsv);
  elements.importFile.addEventListener("change", importBackup);
  elements.resetMasterButton.addEventListener("click", resetMasterData);

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

  elements.installButton.addEventListener("click", installApp);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    elements.installButton.hidden = false;
  });
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return structuredClone(defaults);

  try {
    const parsed = JSON.parse(raw);
    const migrated = { ...structuredClone(defaults), ...parsed };
    migrated.types = normalizeTypes(parsed.types);
    migrated.categories = structuredClone(migrated.types);
    migrated.subCategories = normalizeSubCategories(parsed.subCategories, migrated.types);
    migrated.transactions = (migrated.transactions || []).map((transaction) => ({
      ...transaction,
      type: normalizeTransactionType(transaction, migrated.types),
      category: normalizeTransactionType(transaction, migrated.types),
      createdAt: transaction.createdAt || transaction.updatedAt || new Date().toISOString(),
      updatedAt: transaction.updatedAt || transaction.createdAt || new Date().toISOString()
    }));
    return migrated;
  } catch {
    return structuredClone(defaults);
  }
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  fillSelect(elements.type, state.types);
  fillSelect(elements.category, state.types);
  renderSubCategoryOptions(elements.type.value);
  fillSelect(elements.paymentMethod, state.paymentMethods);
  ensureActiveFiltersStillExist();
  renderFilterSummary();
  renderFilterChips();
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
  const transaction = {
    id: elements.id.value || crypto.randomUUID(),
    date: elements.date.value,
    type: elements.type.value,
    amount: Number(elements.amount.value),
    category: elements.type.value,
    subCategory: elements.subCategory.value,
    paymentMethod: elements.paymentMethod.value,
    note: elements.note.value.trim(),
    updatedAt: new Date().toISOString()
  };

  if (!transaction.date || !transaction.type || !transaction.category || !isValidSubCategory(transaction.type, transaction.subCategory) || !transaction.paymentMethod || transaction.amount <= 0) {
    alert("Lengkapi transaksi dengan nominal lebih dari 0.");
    return;
  }

  const index = state.transactions.findIndex((item) => item.id === transaction.id);
  if (index >= 0) {
    state.transactions[index] = { ...state.transactions[index], ...transaction };
  } else {
    state.transactions.push({ ...transaction, createdAt: new Date().toISOString() });
  }

  persist();
  resetForm();
  renderAll();
  navigate("home");
}

function renderHome() {
  const monthTransactions = getMonthTransactions();
  const totals = getTotals(monthTransactions);
  elements.incomeTotal.textContent = rupiah(totals.income);
  elements.expenseTotal.textContent = rupiah(totals.expense);
  elements.balanceTotal.textContent = rupiah(totals.income - totals.expense);
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
  renderChipGroup(elements.filterCategoryChips, ["Semua", ...state.types], draftFilters.category, "category");
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
  document.body.classList.add("sheet-open");
}

function closeFilterSheet() {
  elements.filterSheet.classList.remove("open");
  elements.filterSheet.setAttribute("aria-hidden", "true");
  elements.filterOverlay.hidden = true;
  document.body.classList.remove("sheet-open");
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
  if (activeFilters.category !== "Semua" && !state.types.includes(activeFilters.category)) {
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
  const daysElapsed = Math.max(1, getDaysElapsedInSelectedMonth());

  elements.statsIncome.textContent = rupiah(totals.income);
  elements.statsExpense.textContent = rupiah(totals.expense);
  elements.statsBalance.textContent = rupiah(totals.income - totals.expense);
  elements.topExpenseCategory.textContent = top ? `${top[0]} - ${rupiah(top[1])}` : "-";
  elements.dailyAverage.textContent = rupiah(totals.expense / daysElapsed);
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
  renderMasterList(elements.categoryList, "categories");
  renderSubCategoryMasterList();
  renderMasterList(elements.paymentMethodList, "paymentMethods");
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
  state.types.forEach((type) => {
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

function addMasterItem(key) {
  if (key === "subCategories") {
    addSubCategoryItem();
    return;
  }
  if (key === "categories") {
    addMainCategory();
    return;
  }
  const name = prompt("Nama item baru:");
  if (!name || !name.trim()) return;
  const clean = name.trim();
  if (!state[key].includes(clean)) state[key].push(clean);
  persist();
  renderAll();
}

function editMasterItem(key, index) {
  if (key === "categories") return editMainCategory(index);
  const name = prompt("Ubah nama item:", state[key][index]);
  if (!name || !name.trim()) return;
  state[key][index] = name.trim();
  persist();
  renderAll();
}

function deleteMasterItem(key, index) {
  if (key === "categories") return deleteMainCategory(index);
  if (!confirm(`Hapus "${state[key][index]}"?`)) return;
  state[key].splice(index, 1);
  persist();
  renderAll();
}

function addSubCategoryItem() {
  const type = prompt(`Pilih kategori utama:\n${state.types.join(" / ")}`, state.types[0]);
  const cleanType = normalizeMainCategory(type, state.types);
  if (!state.types.includes(cleanType)) {
    alert("Kategori utama tidak valid.");
    return;
  }

  const name = prompt(`Nama subkategori untuk ${cleanType}:`);
  if (!name || !name.trim()) return;

  const list = getSubCategoriesForType(cleanType);
  const clean = name.trim();
  if (!list.includes(clean)) state.subCategories[cleanType].push(clean);
  persist();
  renderAll();
}

function editSubCategoryItem(type, index) {
  const list = getSubCategoriesForType(type);
  const name = prompt(`Ubah subkategori ${type}:`, list[index]);
  if (!name || !name.trim()) return;
  list[index] = name.trim();
  persist();
  renderAll();
}

function deleteSubCategoryItem(type, index) {
  const list = getSubCategoriesForType(type);
  if (!confirm(`Hapus "${list[index]}" dari ${type}?`)) return;
  list.splice(index, 1);
  persist();
  renderAll();
}

function addMainCategory() {
  const name = prompt("Nama kategori utama baru:");
  if (!name || !name.trim()) return;
  const clean = name.trim();
  if (state.types.includes(clean)) return;
  state.types.push(clean);
  state.categories = structuredClone(state.types);
  state.subCategories[clean] = ["Lainnya"];
  persist();
  renderAll();
}

function editMainCategory(index) {
  const oldName = state.types[index];
  const name = prompt("Ubah kategori utama:", oldName);
  if (!name || !name.trim()) return;
  const clean = name.trim();
  if (state.types.includes(clean) && clean !== oldName) return;
  state.types[index] = clean;
  state.categories = structuredClone(state.types);
  state.subCategories[clean] = state.subCategories[oldName] || ["Lainnya"];
  if (clean !== oldName) delete state.subCategories[oldName];
  state.transactions = state.transactions.map((item) => {
    if (item.type !== oldName && item.category !== oldName) return item;
    return { ...item, type: clean, category: clean };
  });
  persist();
  renderAll();
}

function deleteMainCategory(index) {
  const name = state.types[index];
  if (state.types.length <= 1) {
    alert("Minimal harus ada satu kategori utama.");
    return;
  }
  if (!confirm(`Hapus kategori utama "${name}"? Transaksi lama tetap disimpan.`)) return;
  state.types.splice(index, 1);
  state.categories = structuredClone(state.types);
  delete state.subCategories[name];
  persist();
  renderAll();
}

function editTransaction(id) {
  const transaction = state.transactions.find((item) => item.id === id);
  if (!transaction) return;

  elements.id.value = transaction.id;
  elements.date.value = transaction.date;
  syncMainCategory(normalizeMainCategory(transaction.type || transaction.category, state.types));
  setSubCategoryValue(transaction.subCategory);
  setSelectValue(elements.paymentMethod, state.paymentMethods, transaction.paymentMethod);
  elements.amount.value = transaction.amount;
  elements.note.value = transaction.note || "";
  elements.submitButton.textContent = "Update Transaksi";
  elements.cancelEditButton.hidden = false;
  navigate("add");
}

function deleteTransaction(id) {
  if (!confirm("Hapus transaksi ini?")) return;
  state.transactions = state.transactions.filter((item) => item.id !== id);
  persist();
  renderAll();
}

function resetForm() {
  elements.form.reset();
  elements.id.value = "";
  elements.date.value = today();
  elements.submitButton.textContent = "Simpan Transaksi";
  elements.cancelEditButton.hidden = true;
  fillSelect(elements.type, state.types);
  fillSelect(elements.category, state.types);
  syncMainCategory(elements.type.value || state.types[0]);
  fillSelect(elements.paymentMethod, state.paymentMethods);
}

function resetMasterData() {
  if (!confirm("Reset master data ke bawaan aplikasi?")) return;
  state.types = structuredClone(defaults.types);
  state.categories = structuredClone(defaults.categories);
  state.subCategories = structuredClone(defaults.subCategories);
  state.paymentMethods = structuredClone(defaults.paymentMethods);
  persist();
  renderAll();
}

function exportBackup() {
  downloadFile(`catatan-keuangan-${today()}.json`, JSON.stringify(state, null, 2), "application/json");
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
}

function importBackup(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const backup = JSON.parse(reader.result);
      state.types = normalizeTypes(backup.types);
      state.categories = structuredClone(state.types);
      state.subCategories = normalizeSubCategories(backup.subCategories, state.types);
      state.paymentMethods = Array.isArray(backup.paymentMethods) ? backup.paymentMethods : defaults.paymentMethods;
      state.transactions = Array.isArray(backup.transactions) ? backup.transactions.map((item) => ({
        ...item,
        type: normalizeTransactionType(item, state.types),
        category: normalizeTransactionType(item, state.types)
      })) : [];
      persist();
      renderAll();
      alert("Backup berhasil diimport.");
    } catch {
      alert("File backup tidak valid.");
    }
  };
  reader.readAsText(file);
  event.target.value = "";
}

async function installApp() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  elements.installButton.hidden = true;
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js");
  }
}

function getMonthTransactions() {
  const month = elements.summaryMonth.value;
  return state.transactions.filter((item) => item.date.startsWith(month));
}

function getTotals(transactions) {
  return {
    income: transactions.filter((item) => item.type === "Pemasukan").reduce((sum, item) => sum + Number(item.amount || 0), 0),
    expense: transactions.filter((item) => item.type === "Pengeluaran").reduce((sum, item) => sum + Number(item.amount || 0), 0),
    transfer: transactions.filter((item) => item.type === "Transfer").reduce((sum, item) => sum + Number(item.amount || 0), 0)
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
  const mainCategory = normalizeMainCategory(type, state.types);
  if (!state.types.includes(mainCategory)) state.types.push(mainCategory);
  state.categories = structuredClone(state.types);
  if (!state.subCategories[mainCategory]) state.subCategories[mainCategory] = ["Lainnya"];
  elements.type.value = mainCategory;
  elements.category.value = mainCategory;
  renderSubCategoryOptions(mainCategory, true);
}

function renderSubCategoryOptions(type, resetInvalid = false) {
  const mainCategory = normalizeMainCategory(type || elements.type.value, state.types);
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
  const mainCategory = normalizeMainCategory(type, state.types);
  if (!state.subCategories[mainCategory]) state.subCategories[mainCategory] = ["Lainnya"];
  return state.subCategories[mainCategory];
}

function isValidSubCategory(type, subCategory) {
  return getSubCategoriesForType(type).includes(subCategory);
}

function normalizeTypes(types) {
  const fallback = structuredClone(defaults.types);
  const list = Array.isArray(types) ? types : fallback;
  const clean = [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
  return clean.length ? clean : fallback;
}

function normalizeMainCategory(value, types = defaults.types) {
  const clean = String(value || "").trim();
  const allowedTypes = Array.isArray(types) && types.length ? types : defaults.types;
  if (allowedTypes.includes(clean)) return clean;
  if (defaults.types.includes(clean)) return clean;
  return allowedTypes[0] || defaults.types[0];
}

function normalizeTransactionType(transaction, types = defaults.types) {
  if (types.includes(transaction.type)) return transaction.type;
  if (types.includes(transaction.category)) return transaction.category;
  const inferred = inferSubCategoryType(transaction.subCategory || transaction.category);
  return normalizeMainCategory(inferred, types);
}

function normalizeSubCategories(input, types = defaults.types) {
  if (input && !Array.isArray(input) && typeof input === "object") {
    const result = {};
    normalizeTypes(types).forEach((type) => {
      const values = Array.isArray(input[type]) ? input[type] : defaults.subCategories[type] || ["Lainnya"];
      result[type] = uniqueClean(values);
    });
    return result;
  }

  const result = structuredClone(defaults.subCategories);
  normalizeTypes(types).forEach((type) => {
    if (!result[type]) result[type] = ["Lainnya"];
  });
  if (Array.isArray(input)) {
    input.forEach((name) => {
      const clean = String(name || "").trim();
      if (!clean) return;
      const type = inferSubCategoryType(clean);
      if (!result[type].includes(clean)) result[type].push(clean);
    });
  }
  return result;
}

function inferSubCategoryType(name) {
  const value = String(name || "").trim();
  for (const [type, list] of Object.entries(defaults.subCategories)) {
    if (list.includes(value)) return type;
  }
  if (["Gaji", "Bonus", "Pendapatan Usaha", "Hadiah"].includes(value)) return "Pemasukan";
  if (["Pindah Akun", "Antar Rekening", "Tarik Tunai", "Top Up E-Wallet", "Pindah Saldo"].includes(value)) return "Transfer";
  return "Pengeluaran";
}

function findSubCategoryType(name) {
  const value = String(name || "").trim();
  return state.types.find((type) => getSubCategoriesForType(type).includes(value));
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
  const prefix = transaction.type === "Pengeluaran" ? "-" : transaction.type === "Pemasukan" ? "+" : "";
  return `${prefix}${rupiah(transaction.amount)}`;
}

function amountClass(type) {
  if (type === "Pengeluaran") return "amount-expense";
  if (type === "Transfer") return "amount-transfer";
  return "amount-income";
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + days);
  return next.toISOString().slice(0, 10);
}

function rupiah(value) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(value || 0);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(new Date(`${value}T00:00:00`));
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
