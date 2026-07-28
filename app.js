// ---------- Setup ----------
const CFG = window.ZIOLO_CONFIG || {};
const configOk = CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes("YOUR-PROJECT");
if (!configOk) document.getElementById("configWarning").classList.remove("hidden");

const supabase = configOk
  ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY)
  : null;

// ---------- State ----------
let strains = [];          // rows from `strains` table
let ratingsByStrain = {};  // strain_id -> rating row
let activeFilter = "all";
let searchTerm = "";

const catalogEl = document.getElementById("catalog");
const countLine = document.getElementById("countLine");
const overlay = document.getElementById("overlay");
const detailPanel = document.getElementById("detailPanel");
const toastEl = document.getElementById("toast");

// ---------- Data loading ----------
async function loadData() {
  if (!supabase) {
    catalogEl.innerHTML = `<div class="loading-line">Skonfiguruj Supabase w config.js, aby zobaczyć katalog.</div>`;
    return;
  }
  catalogEl.innerHTML = `<div class="loading-line">Ładowanie katalogu…</div>`;

  const [{ data: strainRows, error: strainErr }, { data: ratingRows, error: ratingErr }] =
    await Promise.all([
      supabase.from("strains").select("*").order("name", { ascending: true }),
      supabase.from("ratings").select("*"),
    ]);

  if (strainErr) {
    catalogEl.innerHTML = `<div class="loading-line">Błąd ładowania katalogu: ${strainErr.message}</div>`;
    return;
  }

  strains = strainRows || [];
  ratingsByStrain = {};
  (ratingRows || []).forEach((r) => (ratingsByStrain[r.strain_id] = r));

  render();
}

// ---------- Rendering ----------
function matchesFilter(strain, rating) {
  const genetics = (strain.genetics || "").toLowerCase();
  switch (activeFilter) {
    case "all":
      return true;
    case "tested":
      return !!rating?.tested;
    case "untested":
      return !rating?.tested;
    case "top":
    case "mid":
    case "reggie":
      return rating?.tier === activeFilter;
    case "indica":
      return genetics.includes("indica");
    case "sativa":
      return genetics.includes("sativa");
    case "hybryda":
      return genetics.includes("hybryda");
    default:
      return true;
  }
}

function matchesSearch(strain) {
  if (!searchTerm) return true;
  const hay = `${strain.name || ""} ${strain.manufacturer || ""}`.toLowerCase();
  return hay.includes(searchTerm.toLowerCase());
}

function render() {
  const filtered = strains.filter(
    (s) => matchesFilter(s, ratingsByStrain[s.id]) && matchesSearch(s)
  );

  countLine.textContent = `${filtered.length} / ${strains.length} odmian w katalogu`;

  if (!filtered.length) {
    catalogEl.innerHTML = `<div class="empty-state">Brak odmian pasujących do filtra.<br>Spróbuj zmienić wyszukiwanie albo dodaj własną odmianę.</div>`;
    return;
  }

  catalogEl.innerHTML = filtered
    .map((s, i) => cardTemplate(s, ratingsByStrain[s.id], i))
    .join("");

  // wire up card interactions
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

function cardTemplate(s, rating, i) {
  const tested = !!rating?.tested;
  const tier = rating?.tier;
  const idx = String(i + 1).padStart(3, "0");
  return `
    <article class="card" id="card-${s.id}">
      <div class="card-open" role="button" tabindex="0">
        <div class="card-top">
          <span class="card-index mono">No. ${idx}</span>
          ${tier ? `<span class="stamp ${tier}">${tierLabel(tier)}</span>` : ""}
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
  const next = { tested: !existing?.tested };
  await upsertRating(strain.id, next);
  render();
}

// ---------- Detail panel ----------
let currentDraft = null; // working copy of the rating being edited
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

function detailTemplate(s, draft) {
  const stars = (field, label, help) => `
    <div class="field-row">
      <label>${label}${help ? ` — ${help}` : ""}</label>
      <div class="stars" data-field="${field}">
        ${[1, 2, 3, 4, 5]
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
        currentDraft[field] = currentDraft[field] === val ? null : val; // click again to clear
        group.querySelectorAll("button").forEach((b) => {
          b.classList.toggle("filled", currentDraft[field] >= Number(b.dataset.value));
        });
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
  const existing = ratingsByStrain[strainId];
  const payload = { strain_id: strainId, ...existing, ...patch };
  delete payload.id;
  delete payload.created_at;
  delete payload.updated_at;

  const { data, error } = await supabase
    .from("ratings")
    .upsert(payload, { onConflict: "strain_id" })
    .select()
    .single();

  if (error) {
    showToast("Błąd zapisu: " + error.message);
    return;
  }
  ratingsByStrain[strainId] = data;
}

// ---------- Add custom strain ----------
document.getElementById("addStrainBtn").addEventListener("click", openAddStrainForm);

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
    };
    const { data, error } = await supabase.from("strains").insert(row).select().single();
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

// ---------- Filter bar & search wiring ----------
document.getElementById("filterBar").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  render();
});

let searchDebounce = null;
document.getElementById("searchInput").addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchTerm = e.target.value;
    render();
  }, 150);
});

// ---------- Go ----------
loadData();
