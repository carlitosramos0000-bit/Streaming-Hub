const STORAGE_KEYS = {
  rememberedCredentials: "streaming-hub:credentials",
  favorites: "streaming-hub:favorites",
  progress: "streaming-hub:progress",
  uiMode: "streaming-hub:ui-mode"
};

const PLAYER_SLOT_COUNT = 4;
const PLAYER_LAYOUT_OPTIONS = new Set([1, 2, 4]);
const UI_MODES = new Set(["app", "browser"]);

function createEmptyPlayerSlot(index) {
  return {
    index,
    playback: null,
    resumeAt: 0,
    lastProgressWriteAt: 0
  };
}

function createPlayerSlots() {
  return Array.from({ length: PLAYER_SLOT_COUNT }, (_, index) => createEmptyPlayerSlot(index));
}

const state = {
  bootstrap: null,
  view: "dashboard",
  activeCategory: "all",
  search: "",
  sort: "featured",
  accountKey: null,
  library: {
    live: null,
    vod: null,
    series: null
  },
  selectedItem: null,
  selectedSeriesSeason: null,
  seriesExplorer: null,
  currentPlayback: null,
  activePlayerSlot: 0,
  playerLayout: 1,
  playerSlots: createPlayerSlots(),
  uiMode: "app",
  favorites: [],
  progress: []
};

const hlsInstances = new Map();
let queuedFocusSelector = null;

const refs = {
  loginScreen: document.querySelector("#loginScreen"),
  appScreen: document.querySelector("#appScreen"),
  loginForm: document.querySelector("#loginForm"),
  hostInput: document.querySelector("#hostInput"),
  usernameInput: document.querySelector("#usernameInput"),
  passwordInput: document.querySelector("#passwordInput"),
  rememberInput: document.querySelector("#rememberInput"),
  loginButton: document.querySelector("#loginButton"),
  logoutButton: document.querySelector("#logoutButton"),
  navStack: document.querySelector("#navStack"),
  viewEyebrow: document.querySelector("#viewEyebrow"),
  viewTitle: document.querySelector("#viewTitle"),
  toolbar: document.querySelector(".toolbar"),
  appearanceSwitch: document.querySelector("#appearanceSwitch"),
  searchInput: document.querySelector("#searchInput"),
  sortSelect: document.querySelector("#sortSelect"),
  heroArea: document.querySelector("#heroArea"),
  filterBar: document.querySelector("#filterBar"),
  contentArea: document.querySelector("#contentArea"),
  playerPane: document.querySelector("#playerPane"),
  playerTitle: document.querySelector("#playerTitle"),
  playerToolbar: document.querySelector("#playerToolbar"),
  playerStage: document.querySelector("#playerStage"),
  playerMeta: document.querySelector("#playerMeta"),
  playerDetails: document.querySelector("#playerDetails"),
  prevButton: document.querySelector("#prevButton"),
  nextButton: document.querySelector("#nextButton"),
  popoutButton: document.querySelector("#popoutButton"),
  fullscreenButton: document.querySelector("#fullscreenButton"),
  toastRoot: document.querySelector("#toastRoot")
};

function getPlayerSlot(index = state.activePlayerSlot) {
  return state.playerSlots[index] || state.playerSlots[0] || null;
}

function getPlayerVideo(index = state.activePlayerSlot) {
  return refs.playerStage.querySelector(`[data-player-video="${index}"]`);
}

function getPlayerShell(index = state.activePlayerSlot) {
  return refs.playerStage.querySelector(`[data-player-slot="${index}"]`);
}

function getPlayerEmpty(index = state.activePlayerSlot) {
  return refs.playerStage.querySelector(`[data-slot-empty="${index}"]`);
}

function resetPlayerState() {
  state.currentPlayback = null;
  state.activePlayerSlot = 0;
  state.playerLayout = 1;
  state.playerSlots = createPlayerSlots();
}

function isVisibleElement(element) {
  return Boolean(element && !element.disabled && element.getClientRects().length);
}

function getTvFocusables() {
  return Array.from(document.querySelectorAll(".tv-focusable")).filter(isVisibleElement);
}

function focusElement(element) {
  if (!isVisibleElement(element)) {
    return;
  }

  element.focus({ preventScroll: true });
  element.scrollIntoView({
    block: "nearest",
    inline: "center",
    behavior: "smooth"
  });
}

function queueFocus(selector) {
  queuedFocusSelector = selector;
}

function flushQueuedFocus() {
  if (!queuedFocusSelector) {
    return;
  }

  const element = document.querySelector(queuedFocusSelector);
  queuedFocusSelector = null;
  if (element) {
    focusElement(element);
  }
}

function isEditableElement(element) {
  if (!element) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  if (element.tagName === "TEXTAREA" || element.tagName === "SELECT") {
    return true;
  }

  if (element.tagName !== "INPUT") {
    return false;
  }

  const nonTextTypes = new Set(["button", "checkbox", "radio", "range", "submit"]);
  return !nonTextTypes.has(String(element.type || "text").toLowerCase());
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };

    return entities[character];
  });
}

function trimText(value, maxLength = 170) {
  const cleanValue = String(value || "").trim();
  if (!cleanValue) {
    return "";
  }

  if (cleanValue.length <= maxLength) {
    return cleanValue;
  }

  return `${cleanValue.slice(0, maxLength - 3).trim()}...`;
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function saveUiMode(mode) {
  localStorage.setItem(STORAGE_KEYS.uiMode, mode);
}

function loadUiMode() {
  const raw = localStorage.getItem(STORAGE_KEYS.uiMode);
  return UI_MODES.has(raw) ? raw : "app";
}

function applyUiMode(mode, persist = true) {
  state.uiMode = UI_MODES.has(mode) ? mode : "app";
  document.body.classList.toggle("ui-mode-app", state.uiMode === "app");
  document.body.classList.toggle("ui-mode-browser", state.uiMode === "browser");

  if (persist) {
    saveUiMode(state.uiMode);
  }
}

function getAccountScopedStore(key) {
  return loadJson(key, {});
}

function saveAccountScopedStore(key, entries) {
  saveJson(key, entries);
}

function showToast(message, type = "info") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  refs.toastRoot.appendChild(element);
  window.setTimeout(() => element.remove(), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new Error(payload?.error || "Pedido falhou.");
  }

  return payload;
}

function buildAccountKey(account) {
  return `${account.host}::${account.username}`;
}

function setRememberedCredentials(credentials) {
  if (!credentials) {
    localStorage.removeItem(STORAGE_KEYS.rememberedCredentials);
    return;
  }

  saveJson(STORAGE_KEYS.rememberedCredentials, credentials);
}

function loadRememberedCredentials() {
  return loadJson(STORAGE_KEYS.rememberedCredentials, null);
}

function loadScopedCollections() {
  if (!state.accountKey) {
    state.favorites = [];
    state.progress = [];
    return;
  }

  const favoritesStore = getAccountScopedStore(STORAGE_KEYS.favorites);
  const progressStore = getAccountScopedStore(STORAGE_KEYS.progress);

  state.favorites = favoritesStore[state.accountKey] || [];
  state.progress = progressStore[state.accountKey] || [];
}

function persistScopedCollections() {
  if (!state.accountKey) {
    return;
  }

  const favoritesStore = getAccountScopedStore(STORAGE_KEYS.favorites);
  favoritesStore[state.accountKey] = state.favorites;
  saveAccountScopedStore(STORAGE_KEYS.favorites, favoritesStore);

  const progressStore = getAccountScopedStore(STORAGE_KEYS.progress);
  progressStore[state.accountKey] = state.progress;
  saveAccountScopedStore(STORAGE_KEYS.progress, progressStore);
}

function formatDate(value) {
  if (!value) {
    return "Sem data";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Sem data";
  }

  return new Intl.DateTimeFormat("pt-PT", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date);
}

function formatBadge(value, fallback = "Sem info") {
  return value ? escapeHtml(value) : fallback;
}

function formatRating(value) {
  const numeric = Number(value || 0);
  return numeric ? `${numeric.toFixed(1)}/5` : "";
}

function countedValue(value) {
  return new Intl.NumberFormat("pt-PT").format(Number(value || 0));
}

function parseAddedTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1000000000000 ? value : value * 1000;
  }

  const raw = String(value).trim();
  if (!raw) {
    return 0;
  }

  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      return numeric > 1000000000000 ? numeric : numeric * 1000;
    }
  }

  const parsed = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T"));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getAddedTimestamp(item) {
  return (
    parseAddedTimestamp(item?.added) ||
    parseAddedTimestamp(item?.releaseDate) ||
    parseAddedTimestamp(item?.year)
  );
}

function getSortOptionLabel(option) {
  const labels = {
    featured: "Em destaque",
    az: "A-Z",
    recent: state.view === "vod" ? "Ultimo adicionado" : "Mais recentes",
    rating: "Rating"
  };

  return labels[option] || option;
}

function getViewMeta() {
  const map = {
    dashboard: {
      eyebrow: "Inicio",
      title: "Visao geral"
    },
    live: {
      eyebrow: "Live TV",
      title: "Canais em direto"
    },
    vod: {
      eyebrow: "Filmes",
      title: "Biblioteca VOD"
    },
    series: {
      eyebrow: "Series",
      title: "Temporadas e episodios"
    },
    favorites: {
      eyebrow: "Favoritos",
      title: "A tua colecao guardada"
    }
  };

  return map[state.view] || map.dashboard;
}

function proxiedImage(url) {
  if (!url) {
    return "";
  }

  return `/api/asset?url=${encodeURIComponent(url)}`;
}

function accountedCount(type) {
  return state.bootstrap?.dashboard?.categories?.[type] ?? 0;
}

function getCollection(type) {
  return state.library[type] || {
    categories: [],
    items: []
  };
}

function findProgress(type, id) {
  return state.progress.find((item) => item.type === type && Number(item.id) === Number(id)) || null;
}

function isFavorite(type, id) {
  return state.favorites.some((item) => item.type === type && Number(item.id) === Number(id));
}

function getItemByTypeAndId(type, id) {
  const collection = state.library[type];
  if (collection) {
    return collection.items.find((item) => Number(item.id) === Number(id)) || null;
  }

  return state.favorites.find((item) => item.type === type && Number(item.id) === Number(id)) || null;
}

function sortItems(items) {
  const cloned = [...items];

  switch (state.sort) {
    case "az":
      return cloned.sort((left, right) => left.title.localeCompare(right.title, "pt"));
    case "recent":
      return cloned.sort((left, right) => getAddedTimestamp(right) - getAddedTimestamp(left));
    case "rating":
      return cloned.sort((left, right) => (right.rating || 0) - (left.rating || 0));
    default:
      return cloned.sort((left, right) => {
        const leftScore = (left.rating || 0) * 2 + Number(Boolean(left.poster || left.image));
        const rightScore = (right.rating || 0) * 2 + Number(Boolean(right.poster || right.image));
        return rightScore - leftScore;
      });
  }
}

function getVisibleCollection() {
  if (state.view === "favorites") {
    const items = state.favorites.filter((item) => state.activeCategory === "all" || item.type === state.activeCategory);
    const query = state.search.toLowerCase().trim();
    return {
      categories: [],
      items: sortItems(items.filter((item) => !query || item.title.toLowerCase().includes(query)))
    };
  }

  const collection = state.library[state.view];
  if (!collection) {
    return {
      categories: [],
      items: []
    };
  }

  const query = state.search.toLowerCase().trim();
  const filtered = collection.items.filter((item) => {
    const matchesCategory = state.activeCategory === "all" || item.categoryId === state.activeCategory;
    const haystack = `${item.title} ${item.plot}`.toLowerCase();
    const matchesQuery = !query || haystack.includes(query);
    return matchesCategory && matchesQuery;
  });

  return {
    categories: collection.categories,
    items: sortItems(filtered)
  };
}

function countEpisodes(details) {
  return (details?.seasons || []).reduce((sum, season) => sum + (season.episodes?.length || 0), 0);
}

function getActiveSeason() {
  const seasons = state.seriesExplorer?.details?.seasons || [];
  return seasons.find((season) => season.seasonNumber === state.selectedSeriesSeason) || seasons[0] || null;
}

function createBackgroundStyle(imageUrl) {
  if (!imageUrl) {
    return "";
  }

  return `background-image: linear-gradient(180deg, rgba(5,12,19,0.08), rgba(5,12,19,0.95)), url('${imageUrl}')`;
}

function renderHero() {
  if (!state.bootstrap) {
    refs.heroArea.innerHTML = "";
    return;
  }

  if (state.view === "dashboard") {
    refs.heroArea.innerHTML = `
      <article class="hero-card">
        <div class="hero-shell">
          <div class="hero-copy">
            <span class="eyebrow">Visao geral</span>
            <h3>Todo o teu conteudo num so lugar</h3>
            <p>
              Um arranque simples para entrares logo no que existe: canais,
              filmes, series, favoritos e o que deixaste a meio.
            </p>
            <div class="hero-pills">
              <span class="info-pill">Live TV ${countedValue(accountedCount("live"))}</span>
              <span class="info-pill">Filmes ${countedValue(accountedCount("vod"))}</span>
              <span class="info-pill">Series ${countedValue(accountedCount("series"))}</span>
              <span class="info-pill">Favoritos ${countedValue(state.favorites.length)}</span>
            </div>
            <div class="hero-actions">
              <button class="hero-action primary tv-focusable" data-nav-jump="live">Abrir canais</button>
              <button class="hero-action secondary tv-focusable" data-nav-jump="vod">Abrir filmes</button>
              <button class="hero-action secondary tv-focusable" data-nav-jump="series">Abrir series</button>
            </div>
          </div>
        </div>
      </article>
    `;
    return;
  }

  if (state.view === "series" && state.seriesExplorer) {
    const details = state.seriesExplorer.details;
    const image = proxiedImage(details.backdrop || details.cover || state.seriesExplorer.item.poster || state.seriesExplorer.item.image);
    refs.heroArea.innerHTML = `
      <article class="hero-card" style="${createBackgroundStyle(image)}">
        <div class="hero-shell">
          <div class="hero-copy">
            <span class="eyebrow">Serie selecionada</span>
            <h3>${escapeHtml(details.title)}</h3>
            <p>${escapeHtml(trimText(details.plot || "Explora temporadas e episodios no painel central."))}</p>
            <div class="hero-pills">
              <span class="info-pill">${countedValue(details.seasons.length)} temporadas</span>
              <span class="info-pill">${countedValue(countEpisodes(details))} episodios</span>
              ${details.genre ? `<span class="info-pill">${escapeHtml(details.genre)}</span>` : ""}
              ${formatRating(details.rating) ? `<span class="info-pill">${formatRating(details.rating)}</span>` : ""}
            </div>
            <div class="hero-actions">
              <button class="hero-action secondary tv-focusable" data-back-series="1">Voltar ao catalogo</button>
            </div>
          </div>
        </div>
      </article>
    `;
    return;
  }

  const collection = getVisibleCollection();
  const lead = state.selectedItem?.item || collection.items[0];
  if (!lead) {
    refs.heroArea.innerHTML = "";
    return;
  }

  const image = proxiedImage(lead.backdrop || lead.poster || lead.image);
  const actionLabel = lead.type === "series" ? "Abrir serie" : "Ver agora";
  if (state.view === "live") {
    refs.heroArea.innerHTML = `
      <article class="hero-card hero-card-live">
        <div class="hero-shell hero-shell-live">
          <div class="hero-logo-stage">
            ${
              image
                ? `<img class="hero-channel-logo" src="${image}" alt="${escapeHtml(lead.title)}" />`
                : `<span class="hero-channel-fallback">${escapeHtml(String(lead.title || "").slice(0, 2).toUpperCase())}</span>`
            }
          </div>
          <div class="hero-copy">
            <span class="eyebrow">Em direto</span>
            <h3>${escapeHtml(lead.title)}</h3>
            <p>${escapeHtml(trimText(lead.plot || "Seleciona este canal para abrir no player e nos detalhes."))}</p>
            <div class="hero-pills">
              <span class="info-pill">Live TV</span>
              ${formatRating(lead.rating) ? `<span class="info-pill">${formatRating(lead.rating)}</span>` : ""}
            </div>
            <div class="hero-actions">
              <button class="hero-action primary tv-focusable" data-open-type="${escapeHtml(lead.type)}" data-open-id="${lead.id}">
                ${actionLabel}
              </button>
              <button
                class="hero-action secondary tv-focusable"
                data-favorite-type="${escapeHtml(lead.type)}"
                data-favorite-id="${lead.id}"
              >
                ${isFavorite(lead.type, lead.id) ? "Guardado" : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      </article>
    `;
    return;
  }

  refs.heroArea.innerHTML = `
    <article class="hero-card" style="${createBackgroundStyle(image)}">
      <div class="hero-shell">
        <div class="hero-copy">
          <span class="eyebrow">${state.view === "live" ? "Em direto" : "Em destaque"}</span>
          <h3>${escapeHtml(lead.title)}</h3>
          <p>${escapeHtml(trimText(lead.plot || "Seleciona este titulo para abrir no player e nos detalhes."))}</p>
          <div class="hero-pills">
            <span class="info-pill">${state.view === "live" ? "Live TV" : state.view === "vod" ? "Filme" : "Serie"}</span>
            ${lead.year ? `<span class="info-pill">${escapeHtml(lead.year)}</span>` : ""}
            ${formatRating(lead.rating) ? `<span class="info-pill">${formatRating(lead.rating)}</span>` : ""}
          </div>
          <div class="hero-actions">
            <button class="hero-action primary tv-focusable" data-open-type="${escapeHtml(lead.type)}" data-open-id="${lead.id}">
              ${actionLabel}
            </button>
            <button
              class="hero-action secondary tv-focusable"
              data-favorite-type="${escapeHtml(lead.type)}"
              data-favorite-id="${lead.id}"
            >
              ${isFavorite(lead.type, lead.id) ? "Guardado" : "Guardar"}
            </button>
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderFilters() {
  if (state.view === "dashboard") {
    refs.filterBar.innerHTML = `
      <button class="chip-button tv-focusable active" data-nav-jump="live">Live TV</button>
      <button class="chip-button tv-focusable" data-nav-jump="vod">Filmes</button>
      <button class="chip-button tv-focusable" data-nav-jump="series">Series</button>
      <button class="chip-button tv-focusable" data-nav-jump="favorites">Favoritos</button>
    `;
    return;
  }

  if (state.view === "series" && state.seriesExplorer) {
    const seasons = state.seriesExplorer.details.seasons || [];
    refs.filterBar.innerHTML = [
      `<button class="chip-button back-chip tv-focusable" data-back-series="1">Voltar ao catalogo</button>`,
      ...seasons.map(
        (season) => `
          <button
            class="chip-button tv-focusable ${season.seasonNumber === state.selectedSeriesSeason ? "active" : ""}"
            data-season="${season.seasonNumber}"
          >
            T${season.seasonNumber}
          </button>
        `
      )
    ].join("");
    return;
  }

  if (state.view === "favorites") {
    refs.filterBar.innerHTML = `
      <button class="chip-button tv-focusable ${state.activeCategory === "all" ? "active" : ""}" data-category="all">Todos</button>
      <button class="chip-button tv-focusable ${state.activeCategory === "live" ? "active" : ""}" data-category="live">Live TV</button>
      <button class="chip-button tv-focusable ${state.activeCategory === "vod" ? "active" : ""}" data-category="vod">Filmes</button>
      <button class="chip-button tv-focusable ${state.activeCategory === "series" ? "active" : ""}" data-category="series">Series</button>
    `;
    return;
  }

  const collection = getCollection(state.view);
  refs.filterBar.innerHTML = [
    `<button class="chip-button tv-focusable ${state.activeCategory === "all" ? "active" : ""}" data-category="all">Tudo</button>`,
    ...collection.categories.map(
      (category) => `
        <button
          class="chip-button tv-focusable ${state.activeCategory === category.id ? "active" : ""}"
          data-category="${escapeHtml(category.id)}"
        >
          ${escapeHtml(category.name)}
        </button>
      `
    )
  ].join("");
}

function renderQuickCard(label, count, description, targetView) {
  return `
    <article class="quick-card">
      <span class="mini-label">${escapeHtml(label)}</span>
      <strong>${countedValue(count)}</strong>
      <p>${escapeHtml(description)}</p>
      <button class="hero-action secondary tv-focusable" data-nav-jump="${escapeHtml(targetView)}">Explorar</button>
    </article>
  `;
}

function renderContinueCard(item) {
  const image = proxiedImage(item.poster);
  const percent = item.duration ? Math.min(100, Math.round((item.position / item.duration) * 100)) : 0;
  const typeLabel = item.type === "episode" ? "Episodio" : item.type === "vod" ? "Filme" : "Live";

  return `
    <article
      class="continue-card tv-focusable"
      data-open-type="${escapeHtml(item.type)}"
      data-open-id="${item.id}"
      tabindex="0"
      role="button"
    >
      <div class="art" style="${createBackgroundStyle(image)}"></div>
      <div class="card-content">
        <div class="continue-head">
          <span class="eyebrow">Continuar a ver</span>
          <button
            class="continue-remove tv-focusable"
            type="button"
            data-clear-progress-type="${escapeHtml(item.type)}"
            data-clear-progress-id="${item.id}"
            aria-label="Remover de continuar a ver"
            title="Remover"
          >
            Remover
          </button>
        </div>
        <h4>${escapeHtml(item.title)}</h4>
        <div class="meta-inline">
          <span>${typeLabel}</span>
          <span>${Math.max(1, Math.round(item.position / 60))} min vistos</span>
        </div>
        <div class="progress-bar"><span style="width:${percent}%"></span></div>
      </div>
    </article>
  `;
}

function renderCard(item) {
  const image = proxiedImage(item.poster || item.image || item.backdrop);
  const description = trimText(item.plot || "", 100);
  const rating = formatRating(item.rating);
  const typeLabel = item.type === "series" ? "Serie" : item.type === "vod" ? "Filme" : "Canal";
  const progressEntry = findProgress(item.type, item.id);
  const isLive = item.type === "live";
  const visualMarkup = isLive
    ? `
      <div class="art live-art"></div>
      <div class="channel-logo-wrap">
        ${
          image
            ? `<img class="channel-logo" src="${image}" alt="${escapeHtml(item.title)}" loading="lazy" />`
            : `<span class="channel-fallback">${escapeHtml(String(item.title || "").slice(0, 2).toUpperCase())}</span>`
        }
      </div>
    `
    : `<div class="art" style="${createBackgroundStyle(image)}"></div>`;

  return `
    <article
      class="media-card ${isLive ? "live-card" : ""} tv-focusable"
      data-open-type="${escapeHtml(item.type)}"
      data-open-id="${item.id}"
      tabindex="0"
      role="button"
    >
      ${visualMarkup}
      <div class="card-content">
        <div class="badge-row">
          <span class="badge">${typeLabel}</span>
          ${rating ? `<span class="badge">${rating}</span>` : ""}
          ${progressEntry ? `<span class="badge">Retomar</span>` : ""}
        </div>
        <h4>${escapeHtml(item.title)}</h4>
        <div class="meta-inline">
          <span>${formatBadge(item.year, "Sem ano")}</span>
          <span>${formatBadge(item.duration, "Sem duracao")}</span>
        </div>
        ${description ? `<p class="card-copy">${escapeHtml(description)}</p>` : ""}
        <div class="card-actions">
          <span class="card-open-hint">${item.type === "series" ? "Enter para abrir episodios" : "Enter para reproduzir"}</span>
          <button
            class="mini-action secondary"
            data-favorite-type="${escapeHtml(item.type)}"
            data-favorite-id="${item.id}"
          >
            ${isFavorite(item.type, item.id) ? "Guardado" : "Guardar"}
          </button>
        </div>
      </div>
    </article>
  `;
}

function renderDashboardSections() {
  const overviewMarkup = `
    <section class="section-panel">
      <div class="section-title">
        <h3>Resumo</h3>
        <span class="muted">Visao geral rapida da biblioteca</span>
      </div>
      <div class="quick-grid">
        ${renderQuickCard("Canais", accountedCount("live"), "Areas de Live TV prontas para abrir.", "live")}
        ${renderQuickCard("Filmes", accountedCount("vod"), "Categorias de VOD disponiveis.", "vod")}
        ${renderQuickCard("Series", accountedCount("series"), "Biblioteca de series por explorar.", "series")}
        ${renderQuickCard("Favoritos", state.favorites.length, "Titulos guardados para acesso rapido.", "favorites")}
      </div>
    </section>
  `;

  const progressMarkup = state.progress.length
    ? `
      <section class="section-panel">
        <div class="section-title">
          <h3>Continuar a ver</h3>
          <span class="muted">${state.progress.length} titulos</span>
        </div>
        <div class="rail-grid">${state.progress.slice(0, 6).map(renderContinueCard).join("")}</div>
      </section>
    `
    : `
      <section class="empty-state section-panel">
        O teu progresso aparece aqui assim que comecares a ver filmes ou episodios.
      </section>
    `;

  const favoritesMarkup = state.favorites.length
    ? `
      <section class="section-panel">
        <div class="section-title">
          <h3>Favoritos</h3>
          <span class="muted">${state.favorites.length} itens</span>
        </div>
        <div class="catalog-grid">${state.favorites.slice(0, 6).map(renderCard).join("")}</div>
      </section>
    `
    : `
      <section class="empty-state section-panel">
        Guarda canais, filmes ou series para criares uma zona de acesso rapido.
      </section>
    `;

  refs.contentArea.innerHTML = `
    ${overviewMarkup}
    ${progressMarkup}
    ${favoritesMarkup}
  `;
}

function renderSeriesExplorer() {
  const details = state.seriesExplorer.details;
  const activeSeason = getActiveSeason();
  const seasonEpisodes = activeSeason?.episodes || [];
  const query = state.search.toLowerCase().trim();
  const visibleEpisodes = seasonEpisodes.filter((episode) => {
    const haystack = `${episode.title} ${episode.plot}`.toLowerCase();
    return !query || haystack.includes(query);
  });
  const image = proxiedImage(details.cover || details.backdrop || state.seriesExplorer.item.poster || state.seriesExplorer.item.image);

  refs.contentArea.innerHTML = `
    <section class="series-layout">
      <article class="series-overview">
        <div class="series-topline">
          <div class="series-poster" style="${createBackgroundStyle(image)}"></div>
          <div class="series-copy">
            <span class="eyebrow">Explorador de serie</span>
            <h3>${escapeHtml(details.title)}</h3>
            <p>${escapeHtml(details.plot || "Sem sinopse disponivel.")}</p>
            <div class="series-info-grid">
              <span class="info-pill">${countedValue(details.seasons.length)} temporadas</span>
              <span class="info-pill">${countedValue(countEpisodes(details))} episodios</span>
              ${details.genre ? `<span class="info-pill">${escapeHtml(details.genre)}</span>` : ""}
              ${formatRating(details.rating) ? `<span class="info-pill">${formatRating(details.rating)}</span>` : ""}
            </div>
          </div>
        </div>
      </article>
      <section class="episode-panel">
        <div class="section-title">
          <h3>${escapeHtml(activeSeason?.title || "Temporada")}</h3>
          <span class="muted">${visibleEpisodes.length} episodios</span>
        </div>
        ${
          visibleEpisodes.length
            ? `<div class="episode-list">${visibleEpisodes.map(renderEpisodeRow).join("")}</div>`
            : `<div class="empty-state">Nao existem episodios visiveis para esta pesquisa nesta temporada.</div>`
        }
      </section>
    </section>
  `;
}

function renderEpisodeRow(episode) {
  const isActive = state.currentPlayback?.type === "episode" && Number(state.currentPlayback.id) === Number(episode.id);
  const metaLine = [episode.duration || "Sem duracao", episode.releaseDate || "Sem data"].join(" | ");
  const seriesId = state.seriesExplorer?.item?.id || "";
  const seriesTitle = state.seriesExplorer?.details?.title || state.seriesExplorer?.item?.title || "";

  return `
    <button
      class="episode-row tv-focusable ${isActive ? "active" : ""}"
      data-play-episode="1"
      data-episode-id="${episode.id}"
      data-episode-ext="${escapeHtml(episode.containerExtension || "mp4")}"
      data-season-number="${episode.seasonNumber}"
      data-episode-number="${episode.episodeNumber || 0}"
      data-episode-title="${escapeHtml(episode.title)}"
      data-episode-cover="${escapeHtml(episode.cover || "")}"
      data-episode-duration="${escapeHtml(episode.duration || "")}"
      data-episode-plot="${escapeHtml(episode.plot || "")}"
      data-series-id="${seriesId}"
      data-series-title="${escapeHtml(seriesTitle)}"
    >
      <span class="episode-index">E${episode.episodeNumber || "?"}</span>
      <span class="episode-copy">
        <strong>${escapeHtml(episode.title)}</strong>
        <span>${escapeHtml(metaLine)}</span>
        <p>${escapeHtml(trimText(episode.plot || "Sem descricao para este episodio.", 150))}</p>
      </span>
      <span class="episode-cta">${isActive ? "A tocar" : "Reproduzir"}</span>
    </button>
  `;
}

function renderCollectionView() {
  if (state.view === "series" && state.seriesExplorer) {
    renderSeriesExplorer();
    return;
  }

  const collection = getVisibleCollection();
  const label =
    state.view === "favorites"
      ? `${collection.items.length} favoritos`
      : `${collection.items.length} resultados`;

  refs.contentArea.innerHTML = collection.items.length
    ? `
      <section class="section-panel">
        <div class="section-title">
          <h3>${state.view === "favorites" ? "Colecao guardada" : "Catalogo"}</h3>
          <span class="muted">${label}</span>
        </div>
        <div class="catalog-grid">${collection.items.map(renderCard).join("")}</div>
      </section>
    `
    : `
      <section class="empty-state section-panel">
        Nenhum resultado encontrado para este filtro. Experimenta outra categoria ou limpa a pesquisa.
      </section>
    `;
}

function renderPlayerMeta(item, type) {
  const parts = [];
  if (state.playerLayout > 1) {
    parts.push(`Ecra ${state.activePlayerSlot + 1}`);
  }
  if (type === "live") {
    parts.push("Live TV");
  }
  if (type === "vod") {
    parts.push("Filme");
  }
  if (type === "series") {
    parts.push("Serie");
  }
  if (type === "episode") {
    parts.push(`T${item.seasonNumber || "?"} E${item.episodeNumber || "?"}`);
  }
  if (item.duration) {
    parts.push(item.duration);
  }
  if (item.year) {
    parts.push(item.year);
  }
  if (item.rating) {
    parts.push(formatRating(item.rating));
  }

  refs.playerMeta.innerHTML = parts.map((piece) => `<span class="badge">${escapeHtml(piece)}</span>`).join("");
}

function syncActivePlayerContext() {
  const slot = getPlayerSlot();
  state.currentPlayback = slot?.playback || null;

  if (state.currentPlayback?.selection && state.currentPlayback.type !== "episode") {
    state.selectedItem = state.currentPlayback.selection;
  }

  if (state.currentPlayback) {
    refs.playerTitle.textContent = state.currentPlayback.title;
    renderPlayerMeta(state.currentPlayback.meta, state.currentPlayback.type);
    return;
  }

  if (state.view === "series" && state.seriesExplorer) {
    refs.playerTitle.textContent = state.seriesExplorer.details.title;
    refs.playerMeta.innerHTML = `
      <span class="badge">Serie</span>
      <span class="badge">${state.seriesExplorer.details.seasons.length} temporadas</span>
    `;
    return;
  }

  state.selectedItem = null;
  refs.playerTitle.textContent = "Seleciona um canal ou titulo";
  refs.playerMeta.innerHTML = "";
}

function getPlaybackCollectionItems(type) {
  if (state.view === type) {
    return getVisibleCollection().items;
  }

  if (state.view === "favorites") {
    return getVisibleCollection().items.filter((item) => item.type === type);
  }

  return sortItems(getCollection(type).items);
}

function getEpisodeSequence() {
  if (!state.seriesExplorer?.details) {
    return [];
  }

  return (state.seriesExplorer.details.seasons || [])
    .flatMap((season) =>
      (season.episodes || []).map((episode) => ({
        ...episode,
        seasonNumber: episode.seasonNumber || season.seasonNumber || 0,
        episodeNumber: episode.episodeNumber || 0,
        seriesId: episode.seriesId || state.seriesExplorer.item.id,
        seriesTitle: episode.seriesTitle || state.seriesExplorer.details.title
      }))
    )
    .sort((left, right) => {
      if (left.seasonNumber !== right.seasonNumber) {
        return left.seasonNumber - right.seasonNumber;
      }

      if (left.episodeNumber !== right.episodeNumber) {
        return left.episodeNumber - right.episodeNumber;
      }

      return left.title.localeCompare(right.title, "pt");
    });
}

function getPlaybackSequence(playback = state.currentPlayback) {
  if (!playback) {
    return {
      items: [],
      index: -1
    };
  }

  if (playback.type === "episode") {
    const items = playback.sequence || getEpisodeSequence();
    return {
      items,
      index: items.findIndex((item) => Number(item.id) === Number(playback.id))
    };
  }

  if (playback.type === "live" || playback.type === "vod") {
    const items = getPlaybackCollectionItems(playback.type);
    return {
      items,
      index: items.findIndex((item) => Number(item.id) === Number(playback.id))
    };
  }

  return {
    items: [],
    index: -1
  };
}

function findAdjacentPlayback(step) {
  const direction = step < 0 ? -1 : 1;
  const sequence = getPlaybackSequence();
  if (sequence.index < 0) {
    return null;
  }

  return sequence.items[sequence.index + direction] || null;
}

function canMovePlayback(step) {
  return Boolean(findAdjacentPlayback(step));
}

function setActivePlayerSlot(index) {
  const clampedIndex = Math.max(0, Math.min(Number(index) || 0, state.playerLayout - 1));
  state.activePlayerSlot = clampedIndex;
  syncActivePlayerContext();
}

function setPlayerLayout(layout) {
  const nextLayout = Number(layout);
  if (!PLAYER_LAYOUT_OPTIONS.has(nextLayout)) {
    return;
  }

  state.playerLayout = nextLayout;
  if (state.activePlayerSlot >= nextLayout) {
    state.activePlayerSlot = 0;
  }

  syncActivePlayerContext();
}

function hasEpisodePlaybackOutside(slotIndex = -1) {
  return state.playerSlots.some((slot, index) => index !== slotIndex && slot.playback?.type === "episode");
}

function buildPlaybackSource(playback) {
  if (!playback) {
    return null;
  }

  if (playback.type === "live") {
    return {
      mode: "hls",
      url: `/api/stream/live/${playback.id}`
    };
  }

  if (playback.type === "vod") {
    const extension = playback.meta.containerExtension || "mp4";
    return {
      mode: extension.toLowerCase() === "m3u8" ? "hls" : "file",
      url: `/api/stream/movie/${playback.id}?ext=${encodeURIComponent(extension)}${
        extension.toLowerCase() === "m3u8" ? "&mode=hls" : ""
      }`
    };
  }

  if (playback.type === "episode") {
    const extension = playback.meta.containerExtension || "mp4";
    return {
      mode: extension.toLowerCase() === "m3u8" ? "hls" : "file",
      url: `/api/stream/series/${playback.id}?ext=${encodeURIComponent(extension)}${
        extension.toLowerCase() === "m3u8" ? "&mode=hls" : ""
      }`
    };
  }

  return null;
}

function buildPlaybackSubtitle(playback) {
  if (!playback) {
    return "";
  }

  if (playback.type === "live") {
    return "Live TV";
  }

  if (playback.type === "vod") {
    return playback.meta.year ? `Filme • ${playback.meta.year}` : "Filme";
  }

  if (playback.type === "episode") {
    const parts = [
      playback.meta.seriesTitle || "Serie",
      `T${playback.meta.seasonNumber || "?"}`,
      `E${playback.meta.episodeNumber || "?"}`
    ];
    return parts.join(" • ");
  }

  return "";
}

function openActivePlaybackInWindow() {
  const slot = getPlayerSlot();
  if (!slot?.playback) {
    showToast("Escolhe primeiro um canal, filme ou episodio.");
    return;
  }

  const source = buildPlaybackSource(slot.playback);
  if (!source) {
    showToast("Nao foi possivel destacar este conteudo.", "error");
    return;
  }

  const params = new URLSearchParams({
    title: slot.playback.title || "",
    subtitle: buildPlaybackSubtitle(slot.playback),
    mode: source.mode,
    url: source.url,
    poster: slot.playback.meta.cover || slot.playback.meta.poster || "",
    creator: "Carlos Ramos"
  });

  const popup = window.open(
    `/player-window.html?${params.toString()}`,
    `streaming-hub-window-${Date.now()}-${slot.index}`,
    "popup=yes,width=1280,height=720,resizable=yes"
  );

  if (!popup) {
    showToast("O browser bloqueou a janela. Permite popups para usar varios monitores.", "error");
    return;
  }

  popup.focus();
  resetPlayerMedia(slot.index);
  slot.playback = null;
  slot.resumeAt = 0;
  slot.lastProgressWriteAt = 0;
  syncActivePlayerContext();
  renderView();
  showToast("Janela aberta. Move-a para o monitor desejado e ativa o fullscreen nessa janela.");
}

function shouldWarnCodec(extension) {
  const blocked = ["mkv", "avi", "ts", "flv"];
  return blocked.includes(String(extension || "").toLowerCase());
}

function renderPlayerDetails() {
  const selection = state.selectedItem;
  const current = state.currentPlayback;
  const multiViewCard = state.playerLayout > 1
    ? `
      <section class="details-card">
        <h4>Multi-ecra ativo</h4>
        <p>
          O som e os controlos ficam no ecra ${state.activePlayerSlot + 1}. Seleciona outro ecra no mosaico para abrir mais um stream sem fechar o atual.
        </p>
      </section>
    `
    : "";

  if (state.view === "series" && state.seriesExplorer) {
    const details = state.seriesExplorer.details;
    const activeSeason = getActiveSeason();
    const nowPlaying = current?.type === "episode";
    refs.playerDetails.innerHTML = `
      ${multiViewCard}
      <section class="details-card">
        <h4>${escapeHtml(details.title)}</h4>
        <p>${escapeHtml(trimText(details.plot || "Escolhe um episodio no painel central para comecar a ver.", 210))}</p>
      </section>
      <section class="details-card">
        <h4>Estado atual</h4>
        <p class="player-guidance">
          ${
            nowPlaying
              ? `A reproduzir ${escapeHtml(current.title)}. Continua a navegar pelas temporadas e episodios no centro.`
              : `Temporada selecionada: ${escapeHtml(activeSeason?.title || "Sem temporada")}. Escolhe um episodio no centro.`
          }
        </p>
      </section>
      <section class="details-card">
        <h4>Informacao</h4>
        <p>
          ${escapeHtml(details.genre || "Genero nao indicado")}
          ${details.cast ? ` | ${escapeHtml(details.cast)}` : ""}
          ${details.director ? ` | ${escapeHtml(details.director)}` : ""}
        </p>
      </section>
    `;
    return;
  }

  if (!selection) {
    refs.playerDetails.innerHTML = `
      ${multiViewCard}
      <section class="details-card">
        <h4>Pronto para reproduzir</h4>
        <p>
          Escolhe um canal, um filme ou uma serie. O player fica sempre aqui para continuares a navegar sem perder o foco.
        </p>
      </section>
    `;
    return;
  }

  const detail = selection.details || selection.item || {};
  const warning = shouldWarnCodec(detail.containerExtension)
    ? `
      <section class="details-card warning">
        <h4>Compatibilidade</h4>
        <p>
          Este stream usa a extensao <strong>${escapeHtml(detail.containerExtension)}</strong>.
          Se o video nao abrir, o problema pode estar no codec ou container do provider.
        </p>
      </section>
    `
    : "";

  refs.playerDetails.innerHTML = `
    ${multiViewCard}
    <section class="details-card">
      <h4>${escapeHtml(detail.title || selection.item?.title || "Detalhes")}</h4>
      <p>${escapeHtml(trimText(detail.plot || selection.item?.plot || "Sem descricao disponivel.", 220))}</p>
    </section>
    <section class="details-card">
      <h4>Informacao</h4>
      <p>
        ${escapeHtml(detail.genre || "Genero nao indicado")}
        ${detail.cast ? ` | ${escapeHtml(detail.cast)}` : ""}
        ${detail.director ? ` | ${escapeHtml(detail.director)}` : ""}
      </p>
    </section>
    ${warning}
  `;
}

function syncPlayerSurface() {
  syncActivePlayerContext();

  refs.playerStage.className = `player-stage layout-${state.playerLayout}`;

  for (let index = 0; index < PLAYER_SLOT_COUNT; index += 1) {
    const shell = getPlayerShell(index);
    const video = getPlayerVideo(index);
    const empty = getPlayerEmpty(index);
    const status = refs.playerStage.querySelector(`[data-slot-state="${index}"]`);
    const slot = getPlayerSlot(index);
    const isVisible = index < state.playerLayout;
    const isActive = index === state.activePlayerSlot;
    const hasPlayback = Boolean(slot?.playback);

    shell.classList.toggle("hidden", !isVisible);
    shell.classList.toggle("active", isVisible && isActive);
    shell.classList.toggle("filled", hasPlayback);
    shell.setAttribute("aria-pressed", String(isActive));
    status.textContent = hasPlayback ? slot.playback.title : "Vazio";
    video.controls = isActive;
    video.muted = !isActive;
    empty.classList.toggle("hidden", hasPlayback);
  }

  refs.prevButton.disabled = !canMovePlayback(-1);
  refs.nextButton.disabled = !canMovePlayback(1);
  refs.popoutButton.disabled = !state.currentPlayback;
  refs.fullscreenButton.disabled = !state.currentPlayback;

  for (const button of refs.playerToolbar.querySelectorAll("[data-player-layout]")) {
    button.classList.toggle("active", Number(button.dataset.playerLayout) === state.playerLayout);
  }
}

function closeSeriesExplorer() {
  const lastSeriesId = state.seriesExplorer?.item?.id || null;
  state.seriesExplorer = null;
  state.selectedSeriesSeason = null;
  state.search = "";
  refs.searchInput.value = "";

  if (!state.currentPlayback || state.currentPlayback.type !== "episode") {
    state.selectedItem = null;
  }

  if (lastSeriesId) {
    queueFocus(`[data-open-type="series"][data-open-id="${lastSeriesId}"]`);
  }
}

function getDefaultFocusElement() {
  return (
    document.querySelector(".hero-area .tv-focusable") ||
    document.querySelector(".filter-bar .tv-focusable") ||
    document.querySelector(".content-area .tv-focusable") ||
    document.querySelector(".nav-button.active") ||
    getTvFocusables()[0] ||
    null
  );
}

function directionalScore(currentRect, nextRect, direction) {
  const currentCenterX = currentRect.left + currentRect.width / 2;
  const currentCenterY = currentRect.top + currentRect.height / 2;
  const nextCenterX = nextRect.left + nextRect.width / 2;
  const nextCenterY = nextRect.top + nextRect.height / 2;
  const deltaX = nextCenterX - currentCenterX;
  const deltaY = nextCenterY - currentCenterY;
  const horizontal = direction === "left" || direction === "right";
  const primary = horizontal ? deltaX : deltaY;
  const cross = horizontal ? deltaY : deltaX;
  const threshold = horizontal
    ? Math.max(currentRect.height, nextRect.height) * 2.2
    : Math.max(currentRect.width, nextRect.width) * 1.8;

  if (Math.abs(cross) > threshold) {
    return Number.POSITIVE_INFINITY;
  }

  if (direction === "right" && primary <= 8) {
    return Number.POSITIVE_INFINITY;
  }
  if (direction === "left" && primary >= -8) {
    return Number.POSITIVE_INFINITY;
  }
  if (direction === "down" && primary <= 8) {
    return Number.POSITIVE_INFINITY;
  }
  if (direction === "up" && primary >= -8) {
    return Number.POSITIVE_INFINITY;
  }

  const primaryDistance = Math.abs(primary);
  const crossDistance = Math.abs(cross);
  return primaryDistance * primaryDistance + crossDistance * crossDistance * 1.7;
}

function moveTvFocus(direction) {
  const focusables = getTvFocusables();
  if (!focusables.length) {
    return;
  }

  const current = document.activeElement;
  if (!focusables.includes(current)) {
    focusElement(getDefaultFocusElement() || focusables[0]);
    return;
  }

  const currentRect = current.getBoundingClientRect();
  let bestElement = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of focusables) {
    if (candidate === current) {
      continue;
    }

    const score = directionalScore(currentRect, candidate.getBoundingClientRect(), direction);
    if (score < bestScore) {
      bestScore = score;
      bestElement = candidate;
    }
  }

  if (bestElement) {
    focusElement(bestElement);
  }
}

function handleKeyboardShortcut(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }

  const active = document.activeElement;
  if (isEditableElement(active)) {
    if (event.key === "Escape") {
      active.blur();
    }
    return;
  }

  const directionMap = {
    ArrowRight: "right",
    ArrowLeft: "left",
    ArrowDown: "down",
    ArrowUp: "up"
  };

  if (directionMap[event.key]) {
    if (!active?.classList?.contains("tv-focusable")) {
      return;
    }

    event.preventDefault();
    moveTvFocus(directionMap[event.key]);
    return;
  }

  if ((event.key === "Enter" || event.key === " ") && active?.classList.contains("tv-focusable")) {
    event.preventDefault();
    active.click();
    return;
  }

  if (event.key === "Escape" && state.view === "series" && state.seriesExplorer) {
    event.preventDefault();
    closeSeriesExplorer();
    renderView();
  }
}

function renderView() {
  refs.loginScreen.classList.toggle("hidden", Boolean(state.bootstrap));
  refs.appScreen.classList.toggle("hidden", !state.bootstrap);
  applyUiMode(state.uiMode, false);

  if (!state.bootstrap) {
    return;
  }

  const meta = getViewMeta();
  const isDashboard = state.view === "dashboard";
  const isSeriesExplorer = state.view === "series" && state.seriesExplorer;
  const sortLocked = isDashboard || isSeriesExplorer;
  refs.viewEyebrow.textContent = meta.eyebrow;
  refs.viewTitle.textContent = meta.title;
  refs.toolbar.classList.toggle("hidden", isDashboard);
  refs.searchInput.disabled = isDashboard;
  refs.searchInput.placeholder =
    isSeriesExplorer ? "Pesquisar episodios" : "Pesquisar por nome";
  refs.sortSelect.disabled = sortLocked;
  refs.sortSelect.value = state.sort;

  for (const button of refs.toolbar.querySelectorAll("[data-sort-option]")) {
    button.textContent = getSortOptionLabel(button.dataset.sortOption);
    const isActive = button.dataset.sortOption === state.sort;
    button.classList.toggle("active", isActive);
    button.disabled = sortLocked;
    button.setAttribute("aria-pressed", String(isActive));
  }

  for (const option of refs.sortSelect.options) {
    option.textContent = getSortOptionLabel(option.value);
  }

  for (const button of refs.appearanceSwitch.querySelectorAll("[data-ui-mode]")) {
    const isActive = button.dataset.uiMode === state.uiMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }

  for (const button of refs.navStack.querySelectorAll("[data-nav]")) {
    button.classList.toggle("active", button.dataset.nav === state.view);
  }

  renderHero();
  renderFilters();
  if (state.view === "dashboard") {
    renderDashboardSections();
  } else {
    renderCollectionView();
  }
  syncPlayerSurface();
  renderPlayerDetails();
  flushQueuedFocus();
}

async function login(credentials) {
  refs.loginButton.disabled = true;
  refs.loginButton.textContent = "A ligar...";

  try {
    const response = await api("/api/login", {
      method: "POST",
      body: JSON.stringify(credentials)
    });

    state.bootstrap = response.bootstrap;
    state.accountKey = buildAccountKey(response.bootstrap.account);
    loadScopedCollections();
    state.library = {
      live: null,
      vod: null,
      series: null
    };
    state.view = "dashboard";
    state.activeCategory = "all";
    state.search = "";
    state.selectedItem = null;
    state.selectedSeriesSeason = null;
    state.seriesExplorer = null;
    resetPlayerState();
    refs.searchInput.value = "";

    if (refs.rememberInput.checked) {
      setRememberedCredentials(credentials);
    } else {
      setRememberedCredentials(null);
    }

    queueFocus(".hero-area .tv-focusable");
    renderView();
    showToast("Ligacao efetuada com sucesso.");
  } finally {
    refs.loginButton.disabled = false;
    refs.loginButton.textContent = "Entrar no catalogo";
  }
}

async function tryBootstrap() {
  try {
    const bootstrap = await api("/api/bootstrap");
    state.bootstrap = bootstrap;
    state.accountKey = buildAccountKey(bootstrap.account);
    loadScopedCollections();
    queueFocus(".nav-button.active");
    renderView();
  } catch (error) {
    state.bootstrap = null;
  }
}

async function ensureCatalog(type) {
  if (state.library[type]) {
    return state.library[type];
  }

  refs.contentArea.innerHTML = `
    <section class="empty-state">
      A carregar catalogo...
    </section>
  `;

  const catalog = await api(`/api/catalog?type=${encodeURIComponent(type)}`);
  state.library[type] = catalog;
  return catalog;
}

function upsertFavorite(item) {
  queueFocus(`[data-open-type="${item.type}"][data-open-id="${item.id}"]`);
  const existingIndex = state.favorites.findIndex(
    (favorite) => favorite.type === item.type && Number(favorite.id) === Number(item.id)
  );

  if (existingIndex >= 0) {
    state.favorites.splice(existingIndex, 1);
    showToast("Removido dos favoritos.");
  } else {
    state.favorites.unshift({
      id: item.id,
      type: item.type,
      title: item.title,
      poster: item.poster || item.image || "",
      backdrop: item.backdrop || "",
      plot: item.plot || "",
      year: item.year || "",
      duration: item.duration || "",
      rating: item.rating || null
    });
    state.favorites = state.favorites.slice(0, 80);
    showToast("Adicionado aos favoritos.");
  }

  persistScopedCollections();
  renderView();
}

function destroyPlayerInstance(slotIndex = state.activePlayerSlot) {
  const hls = hlsInstances.get(slotIndex);
  if (!hls) {
    return;
  }

  hls.destroy();
  hlsInstances.delete(slotIndex);
}

function destroyAllPlayerInstances() {
  for (let index = 0; index < PLAYER_SLOT_COUNT; index += 1) {
    destroyPlayerInstance(index);
  }
}

function resetPlayerMedia(slotIndex = state.activePlayerSlot) {
  const video = getPlayerVideo(slotIndex);
  if (!video) {
    return;
  }

  destroyPlayerInstance(slotIndex);
  video.pause();
  video.removeAttribute("src");
  video.removeAttribute("type");
  video.load();
}

function attachPlayback(slotIndex, source) {
  const video = getPlayerVideo(slotIndex);
  if (!video) {
    return;
  }

  resetPlayerMedia(slotIndex);

  const canUseNative = video.canPlayType("application/vnd.apple.mpegurl");

  if (source.mode === "hls" && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true
    });
    hlsInstances.set(slotIndex, hls);
    hls.loadSource(source.url);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (data?.fatal) {
        showToast("Nao foi possivel reproduzir este stream.", "error");
      }
    });
    return;
  }

  video.src = source.url;
  if (source.mode === "hls" && canUseNative) {
    video.type = "application/vnd.apple.mpegurl";
  }
  video.play().catch(() => {});
}

function registerPlaybackContext(context, slotIndex = state.activePlayerSlot) {
  const slot = getPlayerSlot(slotIndex);
  if (!slot) {
    return;
  }

  slot.playback = context;
  slot.resumeAt = 0;
  slot.lastProgressWriteAt = 0;
  setActivePlayerSlot(slotIndex);
}

function upsertProgress(entry) {
  if (!state.accountKey || !entry.duration || entry.duration < 120) {
    return;
  }

  const existingIndex = state.progress.findIndex(
    (item) => item.type === entry.type && Number(item.id) === Number(entry.id)
  );

  if (existingIndex >= 0) {
    state.progress.splice(existingIndex, 1);
  }

  state.progress.unshift(entry);
  state.progress = state.progress.slice(0, 40);
  persistScopedCollections();
}

function clearProgressEntry(type, id) {
  const next = state.progress.filter((item) => !(item.type === type && Number(item.id) === Number(id)));
  if (next.length === state.progress.length) {
    return;
  }

  state.progress = next;
  persistScopedCollections();
  if (state.bootstrap) {
    renderView();
  }
}

function buildEpisodeFromData(source) {
  return {
    id: Number(source.episodeId || source.id),
    title: source.episodeTitle || source.title || "",
    containerExtension: source.episodeExt || source.containerExtension || "mp4",
    seasonNumber: Number(source.seasonNumber || 0) || 0,
    episodeNumber: Number(source.episodeNumber || 0) || 0,
    cover: source.episodeCover || source.cover || "",
    plot: source.episodePlot || source.plot || "",
    duration: source.episodeDuration || source.duration || "",
    seriesId: Number(source.seriesId || 0) || null,
    seriesTitle: source.seriesTitle || ""
  };
}

function playEpisodeEntry(episode, options = {}) {
  const slotIndex = options.slotIndex ?? state.activePlayerSlot;
  const episodeSequence = getEpisodeSequence();

  if (!state.seriesExplorer) {
    state.selectedItem = {
      kind: "episode",
      item: episode,
      details: episode
    };
  }

  if (episode.seasonNumber) {
    state.selectedSeriesSeason = episode.seasonNumber;
  }

  registerPlaybackContext({
    id: episode.id,
    type: "episode",
    title: episode.title,
    meta: episode,
    selection: state.selectedItem,
    sequence: episodeSequence
  }, slotIndex);

  attachPlayback(slotIndex, {
    mode: String(episode.containerExtension || "mp4").toLowerCase() === "m3u8" ? "hls" : "file",
    url: `/api/stream/series/${episode.id}?ext=${encodeURIComponent(episode.containerExtension || "mp4")}${
      String(episode.containerExtension || "mp4").toLowerCase() === "m3u8" ? "&mode=hls" : ""
    }`
  });

  getPlayerSlot(slotIndex).resumeAt = options.resumeAt ?? findProgress("episode", episode.id)?.position ?? 0;
  queueFocus(`[data-play-episode][data-episode-id="${episode.id}"]`);
  renderView();
}

async function openItem(type, id, options = {}) {
  const slotIndex = options.slotIndex ?? state.activePlayerSlot;

  if (type === "live") {
    await ensureCatalog("live");
    const item = getItemByTypeAndId("live", id);
    if (!item) {
      return;
    }

    if (!hasEpisodePlaybackOutside(slotIndex)) {
      state.seriesExplorer = null;
      state.selectedSeriesSeason = null;
    }
    state.selectedItem = {
      kind: "live",
      item,
      details: item
    };

    registerPlaybackContext({
      id: item.id,
      type: "live",
      title: item.title,
      meta: item,
      selection: state.selectedItem
    }, slotIndex);

    attachPlayback(slotIndex, {
      mode: "hls",
      url: `/api/stream/live/${item.id}`
    });

    queueFocus(`[data-open-type="live"][data-open-id="${item.id}"]`);
    renderView();
    return;
  }

  if (type === "vod") {
    await ensureCatalog("vod");
    const item = getItemByTypeAndId("vod", id);
    if (!item) {
      return;
    }

    const details = await api(`/api/vod/${item.id}`);
    const savedProgress = findProgress("vod", item.id);

    if (!hasEpisodePlaybackOutside(slotIndex)) {
      state.seriesExplorer = null;
      state.selectedSeriesSeason = null;
    }
    state.selectedItem = {
      kind: "vod",
      item,
      details
    };

    registerPlaybackContext({
      id: item.id,
      type: "vod",
      title: details.title || item.title,
      meta: {
        ...item,
        ...details
      },
      selection: state.selectedItem
    }, slotIndex);

    const extension = details.containerExtension || item.containerExtension || "mp4";
    attachPlayback(slotIndex, {
      mode: extension.toLowerCase() === "m3u8" ? "hls" : "file",
      url: `/api/stream/movie/${item.id}?ext=${encodeURIComponent(extension)}${
        extension.toLowerCase() === "m3u8" ? "&mode=hls" : ""
      }`
    });

    getPlayerSlot(slotIndex).resumeAt = savedProgress?.position || options.resumeAt || 0;
    queueFocus(`[data-open-type="vod"][data-open-id="${item.id}"]`);
    renderView();
    return;
  }

  if (type === "series") {
    await ensureCatalog("series");
    const item = getItemByTypeAndId("series", id);
    if (!item) {
      return;
    }

    const details = await api(`/api/series/${item.id}`);
    const preferredSeason = options.autoplayEpisode?.seasonNumber || details.seasons[0]?.seasonNumber || null;

    state.seriesExplorer = {
      item,
      details
    };
    state.selectedItem = {
      kind: "series",
      item,
      details
    };
    state.selectedSeriesSeason = preferredSeason;
    queueFocus(options.autoplayEpisode ? `[data-play-episode][data-episode-id="${options.autoplayEpisode.id}"]` : ".content-area .episode-row");
    renderView();

    if (options.autoplayEpisode) {
      playEpisodeEntry({
        id: options.autoplayEpisode.id,
        title: options.autoplayEpisode.title,
        containerExtension: options.autoplayEpisode.containerExtension || "mp4",
        seasonNumber: options.autoplayEpisode.seasonNumber || preferredSeason || 0,
        episodeNumber: options.autoplayEpisode.episodeNumber || 0,
        cover: options.autoplayEpisode.poster || options.autoplayEpisode.cover || "",
        plot: options.autoplayEpisode.plot || "",
        duration: options.autoplayEpisode.duration || "",
        seriesId: item.id,
        seriesTitle: details.title
      }, {
        slotIndex,
        resumeAt: options.autoplayEpisode.position || 0
      });
    }
  }
}

async function openProgressEntry(entry, options = {}) {
  const slotIndex = options.slotIndex ?? state.activePlayerSlot;
  if (!entry) {
    return;
  }

  if (entry.type === "vod") {
    await openItem("vod", entry.id, { resumeAt: entry.position || 0, slotIndex });
    return;
  }

  if (entry.type === "episode" && entry.seriesId) {
    await openItem("series", entry.seriesId, {
      autoplayEpisode: entry,
      slotIndex
    });
    return;
  }

  if (entry.type === "episode") {
    playEpisodeEntry({
      id: entry.id,
      title: entry.title,
      containerExtension: entry.containerExtension || "mp4",
      seasonNumber: entry.seasonNumber || 0,
      episodeNumber: entry.episodeNumber || 0,
      cover: entry.poster || "",
      plot: entry.plot || "",
      duration: entry.duration || ""
    }, {
      slotIndex,
      resumeAt: entry.position || 0
    });
  }
}

function handleProgressTracking(slotIndex) {
  const slot = getPlayerSlot(slotIndex);
  const media = getPlayerVideo(slotIndex);
  if (!slot?.playback || !media || !Number.isFinite(media.duration) || media.duration <= 0) {
    return;
  }

  if (slot.playback.type === "live") {
    return;
  }

  const now = Date.now();
  const remaining = media.duration - media.currentTime;
  if (now - slot.lastProgressWriteAt < 10_000 && remaining > 8) {
    return;
  }

  slot.lastProgressWriteAt = now;

  upsertProgress({
    id: slot.playback.id,
    type: slot.playback.type,
    title: slot.playback.title,
    poster: slot.playback.meta.cover || slot.playback.meta.poster || "",
    plot: slot.playback.meta.plot || "",
    duration: media.duration,
    position: media.currentTime,
    updatedAt: Date.now(),
    containerExtension: slot.playback.meta.containerExtension || "mp4",
    seasonNumber: slot.playback.meta.seasonNumber || null,
    episodeNumber: slot.playback.meta.episodeNumber || null,
    seriesId: slot.playback.meta.seriesId || null,
    seriesTitle: slot.playback.meta.seriesTitle || ""
  });
}

async function moveCurrentPlayback(step) {
  const target = findAdjacentPlayback(step);
  if (!state.currentPlayback || !target) {
    showToast(step > 0 ? "Nao existe seguinte nesta lista." : "Nao existe anterior nesta lista.");
    return;
  }

  const slotIndex = state.activePlayerSlot;

  if (state.currentPlayback.type === "episode") {
    playEpisodeEntry(target, {
      slotIndex,
      resumeAt: findProgress("episode", target.id)?.position || 0
    });
    return;
  }

  await openItem(target.type || state.currentPlayback.type, target.id, { slotIndex });
}

async function switchView(view) {
  state.view = view;
  state.activeCategory = "all";
  state.search = "";
  refs.searchInput.value = "";
  const hasEpisodePlayback = state.playerSlots.some((slot) => slot.playback?.type === "episode");

  if (view !== "series" && !hasEpisodePlayback) {
    state.seriesExplorer = null;
    state.selectedSeriesSeason = null;
  }

  if (view === "live" || view === "vod" || view === "series") {
    await ensureCatalog(view);
  }

  queueFocus(".hero-area .tv-focusable");
  renderView();
}

async function handleLoginSubmit(event) {
  event.preventDefault();

  const credentials = {
    host: refs.hostInput.value.trim(),
    username: refs.usernameInput.value.trim(),
    password: refs.passwordInput.value.trim()
  };

  try {
    await login(credentials);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function handleLogout() {
  destroyAllPlayerInstances();
  for (let index = 0; index < PLAYER_SLOT_COUNT; index += 1) {
    resetPlayerMedia(index);
  }

  await api("/api/logout", {
    method: "POST",
    body: JSON.stringify({})
  }).catch(() => {});

  state.bootstrap = null;
  state.accountKey = null;
  state.library = {
    live: null,
    vod: null,
    series: null
  };
  state.favorites = [];
  state.progress = [];
  state.selectedItem = null;
  state.selectedSeriesSeason = null;
  state.seriesExplorer = null;
  resetPlayerState();
  queueFocus("#loginButton");
  renderView();
}

async function handleSharedClick(event) {
  const clearProgressButton = event.target.closest("[data-clear-progress-type]");
  if (clearProgressButton) {
    clearProgressEntry(clearProgressButton.dataset.clearProgressType, Number(clearProgressButton.dataset.clearProgressId));
    showToast("Removido de Continuar a ver.");
    return true;
  }

  const jumpButton = event.target.closest("[data-nav-jump]");
  if (jumpButton) {
    await switchView(jumpButton.dataset.navJump);
    return true;
  }

  const sortButton = event.target.closest("[data-sort-option]");
  if (sortButton && !sortButton.disabled) {
    state.sort = sortButton.dataset.sortOption;
    refs.sortSelect.value = state.sort;
    queueFocus(`[data-sort-option="${sortButton.dataset.sortOption}"]`);
    renderView();
    return true;
  }

  const uiModeButton = event.target.closest("[data-ui-mode]");
  if (uiModeButton) {
    applyUiMode(uiModeButton.dataset.uiMode);
    queueFocus(`[data-ui-mode="${uiModeButton.dataset.uiMode}"]`);
    renderView();
    return true;
  }

  const playerLayoutButton = event.target.closest("[data-player-layout]");
  if (playerLayoutButton) {
    setPlayerLayout(playerLayoutButton.dataset.playerLayout);
    queueFocus(`[data-player-layout="${playerLayoutButton.dataset.playerLayout}"]`);
    renderView();
    return true;
  }

  const playerStepButton = event.target.closest("[data-player-step]");
  if (playerStepButton) {
    await moveCurrentPlayback(Number(playerStepButton.dataset.playerStep));
    return true;
  }

  const playerPopoutButton = event.target.closest("[data-player-popout]");
  if (playerPopoutButton) {
    openActivePlaybackInWindow();
    return true;
  }

  const playerSlotButton = event.target.closest("[data-player-slot]");
  if (playerSlotButton) {
    const slotIndex = Number(playerSlotButton.dataset.playerSlot);
    if (slotIndex !== state.activePlayerSlot) {
      setActivePlayerSlot(slotIndex);
      queueFocus(`[data-player-slot="${playerSlotButton.dataset.playerSlot}"]`);
      renderView();
      return true;
    }
  }

  const backSeriesButton = event.target.closest("[data-back-series]");
  if (backSeriesButton) {
    closeSeriesExplorer();
    renderView();
    return true;
  }

  const seasonButton = event.target.closest("[data-season]");
  if (seasonButton) {
    state.selectedSeriesSeason = Number(seasonButton.dataset.season);
    queueFocus(`[data-season="${seasonButton.dataset.season}"]`);
    renderView();
    return true;
  }

  const favoriteButton = event.target.closest("[data-favorite-type]");
  if (favoriteButton) {
    const item = getItemByTypeAndId(favoriteButton.dataset.favoriteType, favoriteButton.dataset.favoriteId);
    if (item) {
      upsertFavorite(item);
    }
    return true;
  }

  const episodeButton = event.target.closest("[data-play-episode]");
  if (episodeButton) {
    const episode = buildEpisodeFromData({
      episodeId: episodeButton.dataset.episodeId,
      episodeTitle: episodeButton.dataset.episodeTitle,
      episodeExt: episodeButton.dataset.episodeExt,
      seasonNumber: episodeButton.dataset.seasonNumber,
      episodeNumber: episodeButton.dataset.episodeNumber,
      episodeCover: episodeButton.dataset.episodeCover,
      episodeDuration: episodeButton.dataset.episodeDuration,
      episodePlot: episodeButton.dataset.episodePlot,
      seriesId: episodeButton.dataset.seriesId,
      seriesTitle: episodeButton.dataset.seriesTitle
    });
    playEpisodeEntry(episode);
    return true;
  }

  const openElement = event.target.closest("[data-open-type]");
  if (openElement) {
    const type = openElement.dataset.openType;
    const id = Number(openElement.dataset.openId);
    const slotIndex = state.activePlayerSlot;

    if (type === "episode") {
      await openProgressEntry(findProgress("episode", id), { slotIndex });
      return true;
    }

    if (type === "vod") {
      const progressEntry = findProgress("vod", id);
      if (progressEntry) {
        await openProgressEntry(progressEntry, { slotIndex });
        return true;
      }
    }

    await openItem(type, id, { slotIndex });
    return true;
  }

  return false;
}

function bindEvents() {
  document.addEventListener("keydown", handleKeyboardShortcut);
  document.addEventListener("focusin", (event) => {
    if (event.target?.classList?.contains("tv-focusable")) {
      event.target.scrollIntoView({
        block: "nearest",
        inline: "center",
        behavior: "smooth"
      });
    }
  });

  refs.loginForm.addEventListener("submit", handleLoginSubmit);
  refs.logoutButton.addEventListener("click", handleLogout);

  refs.navStack.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-nav]");
    if (!button) {
      return;
    }

    try {
      await switchView(button.dataset.nav);
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  refs.toolbar.addEventListener("click", async (event) => {
    try {
      await handleSharedClick(event);
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  refs.appearanceSwitch.addEventListener("click", async (event) => {
    try {
      await handleSharedClick(event);
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  refs.filterBar.addEventListener("click", async (event) => {
    const categoryButton = event.target.closest("[data-category]");
    if (categoryButton) {
      state.activeCategory = categoryButton.dataset.category;
      queueFocus(`[data-category="${categoryButton.dataset.category}"]`);
      renderView();
      return;
    }

    try {
      await handleSharedClick(event);
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  refs.heroArea.addEventListener("click", async (event) => {
    try {
      await handleSharedClick(event);
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  refs.contentArea.addEventListener("click", async (event) => {
    try {
      await handleSharedClick(event);
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  refs.playerPane.addEventListener("click", async (event) => {
    try {
      await handleSharedClick(event);
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  refs.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    renderView();
  });

  refs.sortSelect.addEventListener("change", (event) => {
    state.sort = event.target.value;
    renderView();
  });

  for (let index = 0; index < PLAYER_SLOT_COUNT; index += 1) {
    const video = getPlayerVideo(index);
    if (!video) {
      continue;
    }

    video.addEventListener("timeupdate", () => handleProgressTracking(index));
    video.addEventListener("loadedmetadata", () => {
      const slot = getPlayerSlot(index);
      if (
        slot?.resumeAt > 0 &&
        Number.isFinite(video.duration) &&
        video.duration > slot.resumeAt + 10
      ) {
        video.currentTime = slot.resumeAt;
        slot.resumeAt = 0;
      }
    });

    video.addEventListener("ended", async () => {
      const slot = getPlayerSlot(index);
      if (!slot?.playback || slot.playback.type === "live") {
        return;
      }

      clearProgressEntry(slot.playback.type, slot.playback.id);

      if (index === state.activePlayerSlot && slot.playback.type === "episode" && canMovePlayback(1)) {
        await moveCurrentPlayback(1);
      }
    });
  }

  refs.fullscreenButton.addEventListener("click", async () => {
    const fullscreenTarget = state.playerLayout > 1 ? refs.playerStage : getPlayerVideo();
    if (!fullscreenTarget) {
      return;
    }

    if (!document.fullscreenElement) {
      await fullscreenTarget.requestFullscreen().catch(() => {});
      return;
    }

    await document.exitFullscreen().catch(() => {});
  });
}

function hydrateRememberedCredentials() {
  const remembered = loadRememberedCredentials();
  if (!remembered) {
    return;
  }

  refs.hostInput.value = remembered.host || "";
  refs.usernameInput.value = remembered.username || "";
  refs.passwordInput.value = remembered.password || "";
  refs.rememberInput.checked = true;
}

function hydrateUiMode() {
  applyUiMode(loadUiMode(), false);
}

async function init() {
  bindEvents();
  hydrateUiMode();
  hydrateRememberedCredentials();
  await tryBootstrap();
}

init();
