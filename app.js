// ---------- Element refs (grabbed first so the safety net below can use them) ----------
const configWarningEl = document.getElementById("configWarning");
const authScreenEl = document.getElementById("authScreen");
const appRootEl = document.getElementById("appRoot");

// ---------- Global safety net ----------
// If ANYTHING throws or a promise rejects unhandled anywhere in this app,
// show it on screen instead of leaving a blank black page with no clue why.
function showFatalError(detail) {
  const msg = detail && detail.message ? detail.message : String(detail);
  console.error("Fatal error:", detail);
  configWarningEl.textContent =
    "⚠ Coś poszło nie tak: " + msg + " — otwórz konsolę przeglądarki (F12) po więcej szczegółów.";
  configWarningEl.classList.remove("hidden");
}
window.addEventListener("error", (e) => showFatalError(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => showFatalError(e.reason));

// Safety timeout: if neither screen becomes visible within a few seconds
// (e.g. a network call to Supabase just hangs), say so instead of staying blank.
setTimeout(() => {
  const authVisible = !authScreenEl.classList.contains("hidden");
  const appVisible = !appRootEl.classList.contains("hidden");
  if (!authVisible && !appVisible) {
    showFatalError({
      message:
        "Aplikacja nie odpowiedziała w oczekiwanym czasie (sprawdź adres URL i klucz w config.js, i połączenie internetowe).",
    });
  }
}, 6000);

// ---------- Setup ----------
const CFG = window.ZIOLO_CONFIG || {};
const configOk = !!(CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes("YOUR-PROJECT"));

let db = null;

function fatalConfigError(msg) {
  configWarningEl.textContent = "⚠ " + msg;
  configWarningEl.classList.remove("hidden");
  authScreenEl.classList.add("hidden");
  appRootEl.classList.add("hidden");
}

if (!configOk) {
  fatalConfigError("Uzupełnij dane Supabase w pliku config.js, żeby aplikacja mogła działać.");
} else if (!window.supabase || typeof window.supabase.createClient !== "function") {
  // The supabase-js library didn't load / didn't attach to window as expected.
  fatalConfigError(
    "Biblioteka Supabase nie wczytała się poprawnie (sprawdź połączenie internetowe albo konsolę przeglądarki — Cmd+Opt+J / F12)."
  );
} else {
  try {
    db = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  } catch (e) {
    console.error("Supabase init failed:", e);
    fatalConfigError("Nie udało się połączyć z Supabase: " + e.message);
  }
}

// ---------- Auth state ----------
let currentUser = null; // { id, email }

if (db) {
  db.auth.onAuthStateChange((_event, session) => {
    handleAuthChange(session);
  });
  db.auth.getSession().then(({ data }) => handleAuthChange(data.session));
}

function handleAuthChange(session) {
  if (session && session.user) {
    currentUser = session.user;
    authScreenEl.classList.add("hidden");
    appRootEl.classList.remove("hidden");
    document.getElementById("userEmailLabel").textContent = currentUser.email || "";
    loadData();
  } else {
    currentUser = null;
    appRootEl.classList.add("hidden");
    authScreenEl.classList.remove("hidden");
  }
}

function showAuthMessage(kind, msg) {
  const errEl = document.getElementById("authError");
  const noticeEl = document.getElementById("authNotice");
  errEl.classList.add("hidden");
  noticeEl.classList.add("hidden");
  if (kind === "error") {
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
  } else {
    noticeEl.textContent = msg;
    noticeEl.classList.remove("hidden");
  }
}

document.getElementById("loginBtn")?.addEventListener("click", async () => {
  if (!db) return;
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  if (!email || !password) { showAuthMessage("error", "Podaj email i hasło."); return; }
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) showAuthMessage("error", error.message);
});

document.getElementById("signupBtn")?.addEventListener("click", async () => {
  if (!db) return;
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  if (!email || !password) { showAuthMessage("error", "Podaj email i hasło."); return; }
  if (password.length < 6) { showAuthMessage("error", "Hasło musi mieć min. 6 znaków."); return; }
  const { data, error } = await db.auth.signUp({ email, password });
  if (error) { showAuthMessage("error", error.message); return; }
  if (data.session) {
    // email confirmation disabled in Supabase settings -> signed in immediately
    return;
  }
  showAuthMessage("notice", "Konto utworzone. Sprawdź maila, żeby potwierdzić adres, a potem się zaloguj.");
});

document.getElementById("logoutBtn")?.addEventListener("click", async () => {
  if (!db) return;
  await db.auth.signOut();
});

// ---------- App state ----------
let strains = [];          // rows from `strains` table
let ratingsByStrain = {};  // strain_id -> this user's rating row
let activeFilter = "all";
let searchTerm = "";
let sortBy = "name";       // name | thc | cbd | result
let sortDir = "asc";       // asc | desc
let filters = {
  thcMin: null, thcMax: null,
  cbdMin: null, cbdMax: null,
  harvestOrigin: "",
  packagingOrigin: "",
  genetics: "",
  terpenes: [],            // OR match
  minResult: null,
};

const catalogEl = document.getElementById("catalog");
const countLine = document.getElementById("countLine");
const overlay = document.getElementById("overlay");
const detailPanel = document.getElementById("detailPanel");
const toastEl = document.getElementById("toast");

// ---------- Result score ----------
// Weighted composite of the star ratings, mapped to a 1.0-5.0 scale.
// Weights derived from your priority quiz: Group 1 "Jakość produktu"
// (Power > Look > Taste > Smell) at ~40% overall, Group 2 "Efekty"
// (Experience > Body high > Head high > Creativity) at ~60% overall.
// Tune any of these any time — pure client-side math, no DB changes needed.
const RESULT_WEIGHTS = {
  rating_experience: 24,
  rating_body_high: 18,
  rating_power: 16,
  rating_look: 12,
  rating_head_high: 12,
  rating_creativity: 6,
  rating_taste: 8,
  rating_smell: 4,
};
const RESULT_MAX = { rating_taste: 5, rating_smell: 5, rating_look: 5, rating_power: 5, rating_experience: 5, rating_body_high: 3, rating_head_high: 3, rating_creativity: 3 };
// A maxed-out allergic reaction (3/3) subtracts up to this many points from
// the final Result (you asked for a strong/noticeable penalty).
const ALLERGIC_PENALTY = 2.0;

function computeResult(rating) {
  if (!rating) return null;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const field in RESULT_WEIGHTS) {
    const v = rating[field];
    if (v == null) continue;
    const max = RESULT_MAX[field];
    const normalized = (v - 1) / (max - 1); // 0..1
    weightedSum += normalized * RESULT_WEIGHTS[field];
    weightTotal += RESULT_WEIGHTS[field];
  }
  if (weightTotal === 0) return null; // nothing rated yet
  let result = 1 + (weightedSum / weightTotal) * 4; // 1..5
  if (ALLERGIC_PENALTY > 0 && rating.rating_allergic != null) {
    const allergicNorm = (rating.rating_allergic - 1) / 2; // 0..1
    result -= allergicNorm * ALLERGIC_PENALTY;
  }
  result = Math.max(1, Math.min(5, result));
  return Math.round(result * 10) / 10; // 1 decimal place
}

// ---------- Data loading ----------
async function loadData() {
  catalogEl.innerHTML = `<div class="loading-line">Ładowanie katalogu…</div>`;

  try {
    const [strainRes, ratingRes] = await Promise.all([
      db.from("strains").select("*").order("name", { ascending: true }),
      db.from("ratings").select("*"),
    ]);

    if (strainRes.error) throw strainRes.error;
    if (ratingRes.error) throw ratingRes.error;

    strains = strainRes.data || [];
    ratingsByStrain = {};
    (ratingRes.data || []).forEach((r) => (ratingsByStrain[r.strain_id] = r));

    render();
  } catch (err) {
    console.error("loadData failed:", err);
    catalogEl.innerHTML = `
      <div class="empty-state">
        Błąd ładowania katalogu.<br>
        <span class="mono">${escapeHtml(err.message || String(err))}</span><br><br>
        Sprawdź: czy uruchomiłeś supabase/schema.sql, czy dane w config.js są poprawne,
        i konsolę przeglądarki (F12) po więcej szczegółów.
      </div>`;
  }
}

// ---------- Rendering ----------
function matchesFilter(strain, rating) {
  switch (activeFilter) {
    case "tested":
      if (!rating?.tested) return false;
      break;
    case "untested":
      if (rating?.tested) return false;
      break;
    case "top":
    case "mid":
    case "reggie":
      if (rating?.tier !== activeFilter) return false;
      break;
  }

  if (filters.thcMin != null && !(strain.thc_percent >= filters.thcMin)) return false;
  if (filters.thcMax != null && !(strain.thc_percent <= filters.thcMax)) return false;
  if (filters.cbdMin != null && !(strain.cbd_percent >= filters.cbdMin)) return false;
  if (filters.cbdMax != null && !(strain.cbd_percent <= filters.cbdMax)) return false;
  if (filters.harvestOrigin && strain.country_growth !== filters.harvestOrigin) return false;
  if (filters.packagingOrigin && strain.country_packaging !== filters.packagingOrigin) return false;
  if (filters.genetics && strain.genetics !== filters.genetics) return false;
  if (filters.terpenes.length) {
    const strainTerpenes = strain.dominant_terpenes || [];
    if (!filters.terpenes.some((t) => strainTerpenes.includes(t))) return false;
  }
  if (filters.minResult != null) {
    const result = computeResult(rating);
    if (result == null || result < filters.minResult) return false;
  }

  return true;
}

function matchesSearch(strain) {
  if (!searchTerm) return true;
  const hay = `${strain.name || ""} ${strain.manufacturer || ""}`.toLowerCase();
  return hay.includes(searchTerm.toLowerCase());
}

function render() {
  let filtered = strains.filter(
    (s) => matchesFilter(s, ratingsByStrain[s.id]) && matchesSearch(s)
  );

  filtered = sortStrains(filtered);

  countLine.textContent = `${filtered.length} / ${strains.length} odmian w katalogu`;

  if (!filtered.length) {
    catalogEl.innerHTML = `<div class="empty-state">Brak odmian pasujących do filtra.<br>Spróbuj zmienić wyszukiwanie albo dodaj własną odmianę.</div>`;
    return;
  }

  catalogEl.innerHTML = filtered
    .map((s, i) => cardTemplate(s, ratingsByStrain[s.id], i))
    .join("");

  filtered.forEach((s) => {
    const card = document.getElementById(`card-${s.id}`);
    if (!card) return;
    card.querySelector(".card-open")?.addEventListener("click", () => openDetail(s));
    card.querySelector(".tested-toggle")?.addEventListener("click", (e) => {
      e.stopPropagation();
      quickToggleTested(s);
    });
  });
}

function sortStrains(list) {
  const dir = sortDir === "asc" ? 1 : -1;
  const withKey = list.map((s) => {
    let key;
    if (sortBy === "thc") key = s.thc_percent;
    else if (sortBy === "cbd") key = s.cbd_percent;
    else if (sortBy === "result") key = computeResult(ratingsByStrain[s.id]);
    else key = (s.name || "").toLowerCase();
    return { s, key };
  });
  withKey.sort((a, b) => {
    // nulls always sort last regardless of direction
    if (a.key == null && b.key == null) return 0;
    if (a.key == null) return 1;
    if (b.key == null) return -1;
    if (a.key < b.key) return -1 * dir;
    if (a.key > b.key) return 1 * dir;
    return 0;
  });
  return withKey.map((x) => x.s);
}

function cardTemplate(s, rating, i) {
  const tested = !!rating?.tested;
  const tier = rating?.tier;
  const result = computeResult(rating);
  const idx = String(i + 1).padStart(3, "0");
  return `
    <article class="card" id="card-${s.id}">
      <div class="card-open" role="button" tabindex="0">
        <div class="card-top">
          <span class="card-index mono">No. ${idx}</span>
          <span class="card-top-right">
            ${result != null ? `<span class="result-badge">${result.toFixed(1)}</span>` : ""}
            ${tier ? `<span class="stamp ${tier}">${tierLabel(tier)}</span>` : ""}
          </span>
        </div>
        <h3 class="card-name">${escapeHtml(s.name || "Bez nazwy")}</h3>
        <p class="card-manufacturer">${escapeHtml(s.manufacturer || "Nieznany producent")}</p>
        <div class="stat-row">
          ${s.thc_percent != null ? `<span><span class="stat-label">THC</span>${s.thc_percent}%</span>` : ""}
          ${s.cbd_percent != null ? `<span><span class="stat-label">CBD</span>${s.cbd_percent}%</span>` : ""}
        </div>
        <div class="tag-row">
          ${s.genetics ? `<span class="tag genetics">${escapeHtml(s.genetics)}</span>` : ""}
          ${s.availability ? `<span class="tag">${escapeHtml(s.availability)}</span>` : ""}
          ${rating?.rating_allergic > 1 ? `<span class="tag allergy">⚠ Reakcja alergiczna</span>` : ""}
        </div>
      </div>
      <div class="card-footer">
        <button class="tested-toggle ${tested ? "tested" : ""}">
          <span class="dot"></span> ${tested ? "Przetestowane" : "Oznacz jako przetestowane"}
        </button>
      </div>
    </article>
  `;
}

function tierLabel(t) {
  return { reggie: "Reggie", mid: "Mid", top: "Top" }[t] || t;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- Quick actions ----------
async function quickToggleTested(strain) {
  const existing = ratingsByStrain[strain.id];
  await upsertRating(strain.id, { tested: !existing?.tested });
  render();
}

// ---------- Detail panel ----------
let currentDraft = null;
let currentStrain = null;

function openDetail(strain) {
  currentStrain = strain;
  const existing = ratingsByStrain[strain.id] || {};
  currentDraft = { ...existing };

  detailPanel.innerHTML = detailTemplate(strain, currentDraft);
  overlay.classList.remove("hidden");
  wireDetailPanel();
}

function closeDetail() {
  overlay.classList.add("hidden");
  currentStrain = null;
  currentDraft = null;
}

overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeDetail();
});

function infoRow(label, value) {
  if (value == null || value === "") return "";
  return `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`;
}

function formatResultPreview(result) {
  return result != null
    ? `${result.toFixed(1)} <span class="unit">/ 5.0</span>`
    : `<span class="unit">Wynik pojawi się po ocenieniu kategorii poniżej</span>`;
}

function detailTemplate(s, draft) {
  const stars = (field, label, max = 5, extraClass = "") => `
    <div class="field-row">
      <label>${label}</label>
      <div class="stars ${extraClass}" data-field="${field}" data-max="${max}">
        ${Array.from({ length: max }, (_, i) => i + 1)
          .map(
            (n) =>
              `<button type="button" data-value="${n}" class="${draft[field] >= n ? "filled" : ""}">★</button>`
          )
          .join("")}
      </div>
    </div>
  `;

  return `
    <button class="panel-close" id="closeDetailBtn">← Wróć do katalogu</button>
    <div class="panel-header">
      <p class="card-manufacturer">${escapeHtml(s.manufacturer || "Nieznany producent")}</p>
      <h2>${escapeHtml(s.name || "Bez nazwy")}</h2>
    </div>

    <dl class="info-grid">
      ${infoRow("THC", s.thc_percent != null ? s.thc_percent + "%" : null)}
      ${infoRow("CBD", s.cbd_percent != null ? s.cbd_percent + "%" : null)}
      ${infoRow("Genetyka", s.genetics)}
      ${infoRow("Dostępność", s.availability)}
      ${infoRow("Opakowanie", s.packaging)}
      ${infoRow("Kraj uprawy", s.country_growth)}
      ${infoRow("Kraj pakowania", s.country_packaging)}
      ${infoRow("Rodzice", s.parents)}
      ${infoRow("Aromaty", (s.aroma_tags || []).join(", "))}
      ${infoRow("Terpeny", (s.dominant_terpenes || []).join(", "))}
      ${infoRow("Możliwe działanie", s.possible_effect)}
    </dl>

    ${s.description ? `<p class="description">${escapeHtml(s.description)}</p>` : ""}
    ${s.source_url ? `<p class="description"><a href="${s.source_url}" target="_blank" rel="noopener">Zobacz na budcare.pl →</a></p>` : ""}

    <div class="section-label">Twój dziennik</div>

    <div class="result-preview" id="resultPreview">
      ${formatResultPreview(computeResult(draft))}
    </div>

    <div class="tested-row">
      <span>Przetestowane</span>
      <div class="switch ${draft.tested ? "on" : ""}" id="testedSwitch"><span class="knob"></span></div>
    </div>

    <div class="two-col">
      <div class="field-row">
        <label>Cena</label>
        <input type="number" step="0.01" id="priceInput" placeholder="np. 45.00" value="${draft.price ?? ""}">
      </div>
      <div class="field-row">
        <label>Apteka / sprzedawca</label>
        <input type="text" id="vendorInput" placeholder="nazwa apteki" value="${draft.vendor ? escapeHtml(draft.vendor) : ""}">
      </div>
    </div>

    <div class="field-row">
      <label>Ogólna ocena</label>
      <div class="tier-row" id="tierRow">
        ${["reggie", "mid", "top"]
          .map(
            (t) =>
              `<button type="button" class="tier-btn ${t} ${draft.tier === t ? "selected" : ""}" data-tier="${t}">${tierLabel(t)}</button>`
          )
          .join("")}
      </div>
    </div>

    ${stars("rating_taste", "Smak")}
    ${stars("rating_smell", "Zapach")}
    ${stars("rating_look", "Wygląd")}
    ${stars("rating_power", "Moc")}
    ${stars("rating_experience", "Doznania")}
    ${stars("rating_body_high", "Body high", 3)}
    ${stars("rating_head_high", "Head high", 3)}
    ${stars("rating_creativity", "Kreatywność", 3)}
    ${stars("rating_allergic", "Reakcja alergiczna (1 = brak, 3 = silna)", 3, "alert")}

    <div class="field-row">
      <label>Notatki</label>
      <textarea class="notes-area" id="notesInput" placeholder="Własne uwagi…">${draft.notes ? escapeHtml(draft.notes) : ""}</textarea>
    </div>

    <div class="save-bar">
      <button class="btn-save" id="saveBtn">Zapisz</button>
    </div>
  `;
}

function wireDetailPanel() {
  document.getElementById("closeDetailBtn").addEventListener("click", closeDetail);

  const sw = document.getElementById("testedSwitch");
  sw.addEventListener("click", () => {
    currentDraft.tested = !currentDraft.tested;
    sw.classList.toggle("on", currentDraft.tested);
  });

  document.querySelectorAll(".tier-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentDraft.tier = btn.dataset.tier;
      document.querySelectorAll(".tier-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
    });
  });

  document.querySelectorAll(".stars").forEach((group) => {
    const field = group.dataset.field;
    group.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = Number(btn.dataset.value);
        currentDraft[field] = currentDraft[field] === val ? null : val;
        group.querySelectorAll("button").forEach((b) => {
          b.classList.toggle("filled", currentDraft[field] >= Number(b.dataset.value));
        });
        const preview = document.getElementById("resultPreview");
        if (preview) preview.innerHTML = formatResultPreview(computeResult(currentDraft));
      });
    });
  });

  document.getElementById("saveBtn").addEventListener("click", saveDetail);
}

async function saveDetail() {
  currentDraft.price = numOrNull(document.getElementById("priceInput").value);
  currentDraft.vendor = textOrNull(document.getElementById("vendorInput").value);
  currentDraft.notes = textOrNull(document.getElementById("notesInput").value);

  await upsertRating(currentStrain.id, currentDraft);
  showToast("Zapisano ✓");
  closeDetail();
  render();
}

function numOrNull(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}
function textOrNull(v) {
  return v && v.trim() ? v.trim() : null;
}

// ---------- Supabase writes ----------
async function upsertRating(strainId, patch) {
  if (!currentUser) { showToast("Musisz być zalogowany."); return; }

  const existing = ratingsByStrain[strainId];
  const payload = { ...existing, ...patch, strain_id: strainId, user_id: currentUser.id };
  delete payload.id;
  delete payload.created_at;
  delete payload.updated_at;

  const { data, error } = await db
    .from("ratings")
    .upsert(payload, { onConflict: "strain_id,user_id" })
    .select()
    .single();

  if (error) {
    console.error("upsertRating failed:", error);
    showToast("Błąd zapisu: " + error.message);
    return;
  }
  ratingsByStrain[strainId] = data;
}

// ---------- Add custom strain ----------
document.getElementById("addStrainBtn")?.addEventListener("click", openAddStrainForm);

function openAddStrainForm() {
  detailPanel.innerHTML = `
    <button class="panel-close" id="closeDetailBtn">← Wróć do katalogu</button>
    <div class="panel-header">
      <h2>Dodaj własną odmianę</h2>
      <p class="card-manufacturer">Np. coś czego nie ma jeszcze w bazie budcare.pl</p>
    </div>
    <div class="field-row">
      <label>Nazwa *</label>
      <input type="text" id="newName" placeholder="np. Purple Haze">
    </div>
    <div class="two-col">
      <div class="field-row">
        <label>Producent</label>
        <input type="text" id="newManufacturer">
      </div>
      <div class="field-row">
        <label>Genetyka</label>
        <input type="text" id="newGenetics" placeholder="Indica / Sativa / Hybryda">
      </div>
    </div>
    <div class="two-col">
      <div class="field-row">
        <label>THC %</label>
        <input type="number" step="0.1" id="newThc">
      </div>
      <div class="field-row">
        <label>CBD %</label>
        <input type="number" step="0.1" id="newCbd">
      </div>
    </div>
    <div class="save-bar">
      <button class="btn-save" id="saveNewBtn">Dodaj do katalogu</button>
    </div>
  `;
  overlay.classList.remove("hidden");
  document.getElementById("closeDetailBtn").addEventListener("click", closeDetail);
  document.getElementById("saveNewBtn").addEventListener("click", async () => {
    const name = document.getElementById("newName").value.trim();
    if (!name) { showToast("Podaj nazwę odmiany"); return; }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now();
    const row = {
      slug,
      name,
      manufacturer: textOrNull(document.getElementById("newManufacturer").value),
      genetics: textOrNull(document.getElementById("newGenetics").value),
      thc_percent: numOrNull(document.getElementById("newThc").value),
      cbd_percent: numOrNull(document.getElementById("newCbd").value),
      added_by: currentUser?.id ?? null,
    };
    const { data, error } = await db.from("strains").insert(row).select().single();
    if (error) { showToast("Błąd: " + error.message); return; }
    strains.push(data);
    showToast("Dodano ✓");
    closeDetail();
    render();
  });
}

// ---------- Toast ----------
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

// ---------- Advanced filter panel ----------
const filterOverlayEl = document.getElementById("filterOverlay");
const filterPanelEl = document.getElementById("filterPanel");

function getDistinct(field) {
  const vals = strains.map((s) => s[field]).filter((v) => v != null && v !== "");
  return [...new Set(vals)].sort((a, b) => String(a).localeCompare(String(b), "pl"));
}

function getDistinctTerpenes() {
  const all = strains.flatMap((s) => s.dominant_terpenes || []);
  return [...new Set(all)].sort((a, b) => String(a).localeCompare(String(b), "pl"));
}

document.getElementById("openFiltersBtn")?.addEventListener("click", openFiltersPanel);

function openFiltersPanel() {
  const harvestOptions = getDistinct("country_growth");
  const packagingOptions = getDistinct("country_packaging");
  const geneticsOptions = getDistinct("genetics");
  const terpeneOptions = getDistinctTerpenes();

  filterPanelEl.innerHTML = `
    <button class="panel-close" id="closeFiltersBtn">← Wróć do katalogu</button>
    <div class="panel-header">
      <h2>Filtry</h2>
    </div>

    <div class="filter-section">
      <label class="section-label" style="margin-top:0">THC %</label>
      <div class="range-row">
        <input type="number" step="0.1" id="thcMinInput" placeholder="min" value="${filters.thcMin ?? ""}">
        <span>—</span>
        <input type="number" step="0.1" id="thcMaxInput" placeholder="max" value="${filters.thcMax ?? ""}">
      </div>
    </div>

    <div class="filter-section">
      <label class="section-label">CBD %</label>
      <div class="range-row">
        <input type="number" step="0.1" id="cbdMinInput" placeholder="min" value="${filters.cbdMin ?? ""}">
        <span>—</span>
        <input type="number" step="0.1" id="cbdMaxInput" placeholder="max" value="${filters.cbdMax ?? ""}">
      </div>
    </div>

    <div class="filter-section">
      <label class="section-label">Kraj uprawy</label>
      <select class="select-field" id="harvestSelect">
        <option value="">Wszystkie</option>
        ${harvestOptions.map((v) => `<option value="${escapeHtml(v)}" ${filters.harvestOrigin === v ? "selected" : ""}>${escapeHtml(v)}</option>`).join("")}
      </select>
    </div>

    <div class="filter-section">
      <label class="section-label">Kraj pakowania</label>
      <select class="select-field" id="packagingSelect">
        <option value="">Wszystkie</option>
        ${packagingOptions.map((v) => `<option value="${escapeHtml(v)}" ${filters.packagingOrigin === v ? "selected" : ""}>${escapeHtml(v)}</option>`).join("")}
      </select>
    </div>

    <div class="filter-section">
      <label class="section-label">Genetyka</label>
      <select class="select-field" id="geneticsSelect">
        <option value="">Wszystkie</option>
        ${geneticsOptions.map((v) => `<option value="${escapeHtml(v)}" ${filters.genetics === v ? "selected" : ""}>${escapeHtml(v)}</option>`).join("")}
      </select>
    </div>

    <div class="filter-section">
      <label class="section-label">Terpeny (dowolny z zaznaczonych)</label>
      <div class="checkbox-list" id="terpeneList">
        ${terpeneOptions
          .map(
            (t) => `
          <label class="checkbox-chip ${filters.terpenes.includes(t) ? "checked" : ""}">
            <input type="checkbox" value="${escapeHtml(t)}" ${filters.terpenes.includes(t) ? "checked" : ""}>
            ${escapeHtml(t)}
          </label>`
          )
          .join("") || `<span class="mono" style="color:var(--ink-faint); font-size:.75rem;">Brak danych o terpenach w katalogu</span>`}
      </div>
    </div>

    <div class="filter-section">
      <label class="section-label">Minimalny wynik ogólny</label>
      <select class="select-field" id="minResultSelect">
        <option value="">Dowolny</option>
        ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${filters.minResult === n ? "selected" : ""}>≥ ${n}.0</option>`).join("")}
      </select>
    </div>

    <div class="filter-actions">
      <button class="btn-ghost" id="clearFiltersBtn">Wyczyść filtry</button>
      <button class="btn-save" id="applyFiltersBtn">Zastosuj</button>
    </div>
  `;

  filterOverlayEl.classList.remove("hidden");

  document.getElementById("closeFiltersBtn").addEventListener("click", closeFilters);

  document.querySelectorAll("#terpeneList .checkbox-chip").forEach((label) => {
    label.addEventListener("click", (e) => {
      // let the native checkbox toggle happen, then sync the visual state
      setTimeout(() => {
        const input = label.querySelector("input");
        label.classList.toggle("checked", input.checked);
      }, 0);
    });
  });

  document.getElementById("applyFiltersBtn").addEventListener("click", () => {
    filters.thcMin = numOrNull(document.getElementById("thcMinInput").value);
    filters.thcMax = numOrNull(document.getElementById("thcMaxInput").value);
    filters.cbdMin = numOrNull(document.getElementById("cbdMinInput").value);
    filters.cbdMax = numOrNull(document.getElementById("cbdMaxInput").value);
    filters.harvestOrigin = document.getElementById("harvestSelect").value;
    filters.packagingOrigin = document.getElementById("packagingSelect").value;
    filters.genetics = document.getElementById("geneticsSelect").value;
    filters.minResult = numOrNull(document.getElementById("minResultSelect").value);
    filters.terpenes = Array.from(
      document.querySelectorAll("#terpeneList input:checked")
    ).map((i) => i.value);

    closeFilters();
    render();
    showToast("Filtry zastosowane ✓");
  });

  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    filters = { thcMin: null, thcMax: null, cbdMin: null, cbdMax: null, harvestOrigin: "", packagingOrigin: "", genetics: "", terpenes: [], minResult: null };
    closeFilters();
    render();
    showToast("Filtry wyczyszczone");
  });
}

function closeFilters() {
  filterOverlayEl.classList.add("hidden");
}

filterOverlayEl?.addEventListener("click", (e) => {
  if (e.target === filterOverlayEl) closeFilters();
});

// ---------- Filter bar, search & sort wiring ----------
document.getElementById("filterBar")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip:not(.chip-outline)");
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  document.querySelectorAll(".chip:not(.chip-outline)").forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  render();
});

const searchInputEl = document.getElementById("searchInput");
const clearSearchBtn = document.getElementById("clearSearchBtn");

let searchDebounce = null;
searchInputEl?.addEventListener("input", (e) => {
  clearSearchBtn.classList.toggle("hidden", !e.target.value);
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchTerm = e.target.value;
    render();
  }, 150);
});

clearSearchBtn?.addEventListener("click", () => {
  searchInputEl.value = "";
  searchTerm = "";
  clearSearchBtn.classList.add("hidden");
  searchInputEl.focus();
  render();
});

document.getElementById("sortBySelect")?.addEventListener("change", (e) => {
  sortBy = e.target.value;
  render();
});

document.getElementById("sortDirBtn")?.addEventListener("click", () => {
  sortDir = sortDir === "asc" ? "desc" : "asc";
  const btn = document.getElementById("sortDirBtn");
  btn.textContent = sortDir === "asc" ? "↑ Rosnąco" : "↓ Malejąco";
  render();
});

// ---------- "Add to Home Screen" prompt (iOS) ----------
const installOverlay = document.getElementById("installOverlay");
const installBtn = document.getElementById("installBtn");

function isIosSafari() {
  const ua = window.navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isStandalone =
    window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  return isIos && !isStandalone;
}

if (isIosSafari()) {
  installBtn?.classList.remove("hidden");
}

installBtn?.addEventListener("click", () => installOverlay.classList.remove("hidden"));
document.getElementById("closeInstallBtn")?.addEventListener("click", () =>
  installOverlay.classList.add("hidden")
);
installOverlay?.addEventListener("click", (e) => {
  if (e.target === installOverlay) installOverlay.classList.add("hidden");
});
