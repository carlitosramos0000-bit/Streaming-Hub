const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3200);
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_COOKIE = "streaming_hub_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const CACHE_TTL_MS = {
  bootstrap: 60_000,
  catalog: 180_000,
  details: 300_000
};
const PLAYER_API_ENDPOINTS = ["player_api.php", "panel_api.php"];
const PROVIDER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

const sessions = new Map();

const TYPE_CONFIG = {
  live: {
    categoryAction: "get_live_categories",
    itemAction: "get_live_streams",
    idField: "stream_id",
    imageFields: ["stream_icon", "cover"],
    posterFields: ["stream_icon", "cover"]
  },
  vod: {
    categoryAction: "get_vod_categories",
    itemAction: "get_vod_streams",
    detailAction: "get_vod_info",
    detailParam: "vod_id",
    idField: "stream_id",
    imageFields: ["stream_icon", "cover", "movie_image"],
    posterFields: ["stream_icon", "cover", "cover_big", "movie_image"]
  },
  series: {
    categoryAction: "get_series_categories",
    itemAction: "get_series",
    detailAction: "get_series_info",
    detailParam: "series_id",
    idField: "series_id",
    imageFields: ["cover", "cover_big"],
    posterFields: ["cover", "cover_big"]
  }
};

function readFile(filePath) {
  return fs.promises.readFile(filePath);
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildProviderHeaders(targetUrl, extraHeaders = {}) {
  const originUrl = new URL(targetUrl);
  return {
    "user-agent": PROVIDER_USER_AGENT,
    "accept-language": "pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    origin: originUrl.origin,
    referer: `${originUrl.origin}/`,
    ...extraHeaders
  };
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function sendError(res, statusCode, message, details) {
  sendJson(res, statusCode, {
    error: message,
    details: details || null
  });
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  return cookieHeader.split(";").reduce((acc, chunk) => {
    const [rawName, ...rawValue] = chunk.trim().split("=");
    if (!rawName) {
      return acc;
    }

    acc[rawName] = decodeURIComponent(rawValue.join("="));
    return acc;
  }, {});
}

async function parseBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new Error("Body demasiado grande.");
    }

    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("JSON invalido.");
  }
}

function createSession(data) {
  const id = crypto.randomUUID();
  const now = Date.now();

  sessions.set(id, {
    id,
    createdAt: now,
    lastSeenAt: now,
    cache: new Map(),
    proxyTokens: new Map(),
    ...data
  });

  return sessions.get(id);
}

function destroySession(id) {
  sessions.delete(id);
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }

  session.lastSeenAt = Date.now();
  return session;
}

function sessionCookie(sessionId) {
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

function cleanupSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastSeenAt > SESSION_TTL_MS) {
      sessions.delete(sessionId);
      continue;
    }

    for (const [token, proxyTarget] of session.proxyTokens.entries()) {
      if (proxyTarget.expiresAt <= now) {
        session.proxyTokens.delete(token);
      }
    }
  }
}

setInterval(cleanupSessions, 10 * 60 * 1000).unref();

function toUnixDisplay(value) {
  if (!value) {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return new Date(numeric * 1000).toISOString();
}

function pickFirst(raw, fields) {
  for (const field of fields) {
    const value = raw[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function normalizeCategory(raw) {
  return {
    id: String(raw.category_id ?? raw.id ?? "uncategorized"),
    name: raw.category_name || raw.name || "Sem categoria",
    parentId: raw.parent_id ? String(raw.parent_id) : null
  };
}

function normalizeItem(type, raw) {
  const config = TYPE_CONFIG[type];
  const id = Number(raw[config.idField] ?? raw.id);

  return {
    id,
    type,
    title: raw.name || raw.title || `Item ${id}`,
    categoryId: String(raw.category_id ?? "uncategorized"),
    plot: raw.plot || raw.description || raw.overview || "",
    image: pickFirst(raw, config.imageFields),
    poster: pickFirst(raw, config.posterFields),
    backdrop: Array.isArray(raw.backdrop_path) && raw.backdrop_path.length ? raw.backdrop_path[0] : "",
    rating: Number(raw.rating_5based || raw.rating || 0) || null,
    year: raw.year || raw.releaseDate || raw.releasedate || "",
    added: raw.added || raw.releaseDate || raw.releasedate || "",
    containerExtension: raw.container_extension || raw.stream_type || "",
    duration: raw.duration || raw.run_time || raw.runtime || "",
    directSource: raw.direct_source || "",
    raw
  };
}

function normalizeBootstrap(summary, categoryCounts, host) {
  const userInfo = summary.user_info || {};
  const serverInfo = summary.server_info || {};

  return {
    account: {
      username: userInfo.username || "",
      status: userInfo.status || "Unknown",
      activeConnections: Number(userInfo.active_cons || 0),
      maxConnections: Number(userInfo.max_connections || 0),
      isTrial: String(userInfo.is_trial || "0") === "1",
      createdAt: toUnixDisplay(userInfo.created_at),
      expiresAt: toUnixDisplay(userInfo.exp_date),
      allowedFormats: Array.isArray(userInfo.allowed_output_formats) ? userInfo.allowed_output_formats : [],
      serverTimeZone: serverInfo.timezone || "",
      serverUrl: serverInfo.url || "",
      host
    },
    dashboard: {
      categories: categoryCounts,
      totalSections: Object.values(categoryCounts).reduce((sum, value) => sum + value, 0)
    }
  };
}

function isAuthenticatedSummary(summary) {
  return String(summary?.user_info?.auth || "0") === "1";
}

function normalizeHostCandidates(input) {
  const sanitized = String(input || "").trim().replace(/\/+$/, "");
  if (!sanitized) {
    throw new Error("Indica o host do provider.");
  }

  const rawCandidates = /^https?:\/\//i.test(sanitized)
    ? [sanitized]
    : [`http://${sanitized}`, `https://${sanitized}`];

  const candidates = [];
  for (const rawCandidate of rawCandidates) {
    try {
      const url = new URL(rawCandidate);
      const pathname = normalizeProviderBasePath(url.pathname);
      const basePaths = uniqueValues([
        pathname,
        pathname !== "/" ? "/" : ""
      ]);

      for (const basePath of basePaths) {
        const candidateUrl = new URL(url.origin);
        candidateUrl.pathname = basePath;
        candidateUrl.search = "";
        candidateUrl.hash = "";
        candidates.push(candidateUrl.toString().replace(/\/+$/, ""));
      }
    } catch (error) {
      candidates.push(rawCandidate);
    }
  }

  return uniqueValues(candidates);
}

function normalizeProviderBasePath(pathname) {
  const cleanPath = String(pathname || "/").replace(/\/+/g, "/");
  const segments = cleanPath.split("/").filter(Boolean);
  if (!segments.length) {
    return "/";
  }

  const lastSegment = segments[segments.length - 1].toLowerCase();
  const knownFiles = new Set([
    "get.php",
    "xmltv.php",
    "player_api.php",
    "panel_api.php",
    "portal.php"
  ]);

  if (knownFiles.has(lastSegment)) {
    segments.pop();
  }

  if (!segments.length) {
    return "/";
  }

  return `/${segments.join("/")}/`;
}

function buildProviderUrl(host, pathname, params = {}) {
  const url = new URL(pathname, ensureTrailingSlash(host));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs || 15_000),
    headers: buildProviderHeaders(url, {
      accept: options.accept || "*/*",
      ...(options.headers || {})
    })
  });

  const text = await response.text();
  return {
    ok: response.ok,
    url: response.url,
    headers: response.headers,
    status: response.status,
    text
  };
}

async function fetchJson(url) {
  const response = await fetchText(url, {
    accept: "application/json, text/plain, */*"
  });

  let payload;
  try {
    payload = JSON.parse(response.text);
  } catch (error) {
    if (!response.ok) {
      throw new Error(buildProviderHttpError(response.status, response.url, response.text));
    }

    throw new Error("O provider devolveu uma resposta invalida.");
  }

  if (!response.ok && !isLikelyXtreamPayload(payload)) {
    throw new Error(buildProviderHttpError(response.status, response.url, response.text));
  }

  return payload;
}

function isLikelyXtreamPayload(payload) {
  if (Array.isArray(payload)) {
    return true;
  }

  if (!payload || typeof payload !== "object") {
    return false;
  }

  return Boolean(
    payload.user_info ||
      payload.server_info ||
      payload.movie_data ||
      payload.info ||
      payload.episodes ||
      payload.seasons
  );
}

function buildProviderHttpError(status, finalUrl, bodyText) {
  const compactBody = String(bodyText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);

  const hints = [];
  if (status === 401 || status === 403) {
    hints.push("confirma username/password");
  }
  if (status === 404 || status === 512) {
    hints.push("experimenta colar apenas o host base, por exemplo http://servidor:porta");
  }

  const details = compactBody ? ` Resposta: ${compactBody}` : "";
  const hintText = hints.length ? ` Dica: ${hints.join(" | ")}.` : "";
  return `Pedido ao provider falhou com estado ${status} em ${finalUrl}.${hintText}${details}`;
}

async function loginAgainstProvider(hostInput, username, password) {
  const candidates = normalizeHostCandidates(hostInput);
  let lastError = null;

  for (const candidate of candidates) {
    for (const apiEndpoint of PLAYER_API_ENDPOINTS) {
      try {
        const loginUrl = buildProviderUrl(candidate, apiEndpoint, {
          username,
          password
        });

        const summary = await fetchJson(loginUrl);
        if (isAuthenticatedSummary(summary)) {
          return {
            host: candidate,
            apiEndpoint,
            summary
          };
        }

        lastError = new Error("Credenciais recusadas pelo provider.");
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("Nao foi possivel contactar o provider.");
}

async function cached(session, key, ttlMs, loader) {
  const current = session.cache.get(key);
  const now = Date.now();

  if (current && current.expiresAt > now) {
    return current.value;
  }

  const value = await loader();
  session.cache.set(key, {
    value,
    expiresAt: now + ttlMs
  });

  return value;
}

async function providerAction(session, action, extraParams = {}) {
  const url = buildProviderUrl(session.host, session.apiEndpoint || "player_api.php", {
    username: session.username,
    password: session.password,
    action,
    ...extraParams
  });

  return fetchJson(url);
}

async function getBootstrap(session) {
  return cached(session, "bootstrap", CACHE_TTL_MS.bootstrap, async () => {
    const [liveCategories, vodCategories, seriesCategories] = await Promise.all([
      providerAction(session, TYPE_CONFIG.live.categoryAction),
      providerAction(session, TYPE_CONFIG.vod.categoryAction),
      providerAction(session, TYPE_CONFIG.series.categoryAction)
    ]);

    return normalizeBootstrap(
      session.summary,
      {
        live: Array.isArray(liveCategories) ? liveCategories.length : 0,
        vod: Array.isArray(vodCategories) ? vodCategories.length : 0,
        series: Array.isArray(seriesCategories) ? seriesCategories.length : 0
      },
      session.host
    );
  });
}

async function getCatalog(session, type) {
  if (!TYPE_CONFIG[type]) {
    throw new Error("Tipo de catalogo invalido.");
  }

  return cached(session, `catalog:${type}`, CACHE_TTL_MS.catalog, async () => {
    const config = TYPE_CONFIG[type];
    const [categories, items] = await Promise.all([
      providerAction(session, config.categoryAction),
      providerAction(session, config.itemAction)
    ]);

    const normalizedCategories = Array.isArray(categories)
      ? categories.map(normalizeCategory)
      : [];
    const normalizedItems = Array.isArray(items)
      ? items.map((item) => normalizeItem(type, item)).filter((item) => Number.isFinite(item.id))
      : [];

    return {
      type,
      categories: normalizedCategories,
      items: normalizedItems
    };
  });
}

async function getVodDetails(session, id) {
  return cached(session, `vod:${id}`, CACHE_TTL_MS.details, async () => {
    const payload = await providerAction(session, TYPE_CONFIG.vod.detailAction, {
      [TYPE_CONFIG.vod.detailParam]: id
    });

    const info = payload.info || {};
    const movie = payload.movie_data || {};

    return {
      id: Number(id),
      title: info.name || movie.name || `Filme ${id}`,
      plot: info.plot || "",
      genre: info.genre || "",
      rating: Number(info.rating || info.rating_5based || 0) || null,
      duration: info.duration || info.runtime || "",
      director: info.director || "",
      cast: info.cast || "",
      releaseDate: info.releasedate || info.release_date || "",
      year: info.year || "",
      country: info.country || "",
      cover: info.cover_big || info.movie_image || info.cover || movie.stream_icon || "",
      backdrop: Array.isArray(info.backdrop_path) && info.backdrop_path.length ? info.backdrop_path[0] : "",
      streamId: Number(movie.stream_id || id),
      containerExtension: movie.container_extension || info.container_extension || "mp4",
      raw: payload
    };
  });
}

function findSeasonMeta(meta, seasonNumber) {
  return meta.find((season) => {
    const candidate = Number(
      season.season_number ??
        season.season ??
        season.season_num ??
        season.id ??
        seasonNumber
    );
    return candidate === seasonNumber;
  });
}

async function getSeriesDetails(session, id) {
  return cached(session, `series:${id}`, CACHE_TTL_MS.details, async () => {
    const payload = await providerAction(session, TYPE_CONFIG.series.detailAction, {
      [TYPE_CONFIG.series.detailParam]: id
    });

    const info = payload.info || {};
    const seasonMeta = Array.isArray(payload.seasons) ? payload.seasons : [];
    const episodesBySeason = payload.episodes || {};

    const seasonNumbers = new Set();
    for (const key of Object.keys(episodesBySeason)) {
      const numeric = Number(key);
      if (Number.isFinite(numeric)) {
        seasonNumbers.add(numeric);
      }
    }

    for (const season of seasonMeta) {
      const numeric = Number(season.season_number ?? season.season ?? season.season_num);
      if (Number.isFinite(numeric)) {
        seasonNumbers.add(numeric);
      }
    }

    const seasons = Array.from(seasonNumbers)
      .sort((left, right) => left - right)
      .map((seasonNumber) => {
        const meta = findSeasonMeta(seasonMeta, seasonNumber) || {};
        const rawEpisodes = episodesBySeason[String(seasonNumber)] || episodesBySeason[seasonNumber] || [];

        const episodes = rawEpisodes
          .map((episode) => {
            const episodeId = Number(episode.id || episode.episode_id);
            if (!Number.isFinite(episodeId)) {
              return null;
            }

            return {
              id: episodeId,
              title:
                episode.title ||
                episode.name ||
                `Episodio ${episode.episode_num || episode.episode_number || episodeId}`,
              plot: episode.info?.plot || episode.plot || "",
              duration: episode.info?.duration || episode.duration || "",
              releaseDate: episode.info?.releasedate || episode.info?.release_date || "",
              rating: Number(episode.info?.rating || episode.rating || 0) || null,
              episodeNumber: Number(episode.episode_num || episode.episode_number || 0) || 0,
              seasonNumber,
              containerExtension: episode.container_extension || "mp4",
              cover:
                episode.info?.movie_image ||
                episode.info?.cover_big ||
                episode.info?.cover ||
                meta.cover_big ||
                meta.cover ||
                info.cover ||
                ""
            };
          })
          .filter(Boolean)
          .sort((left, right) => left.episodeNumber - right.episodeNumber);

        return {
          seasonNumber,
          title: meta.name || `Temporada ${seasonNumber}`,
          airDate: meta.air_date || meta.airdate || "",
          cover: meta.cover_big || meta.cover || info.cover || "",
          episodeCount: episodes.length,
          episodes
        };
      });

    return {
      id: Number(id),
      title: info.name || `Serie ${id}`,
      plot: info.plot || info.overview || "",
      genre: info.genre || "",
      rating: Number(info.rating || info.rating_5based || 0) || null,
      releaseDate: info.releasedate || info.release_date || "",
      cast: info.cast || "",
      director: info.director || "",
      cover: info.cover_big || info.cover || "",
      backdrop: Array.isArray(info.backdrop_path) && info.backdrop_path.length ? info.backdrop_path[0] : "",
      seasons
    };
  });
}

function registerProxyTarget(session, targetUrl) {
  const token = crypto.randomUUID();
  session.proxyTokens.set(token, {
    targetUrl,
    expiresAt: Date.now() + 10 * 60 * 1000
  });
  return token;
}

function buildProxyUrl(token) {
  return `/api/proxy/${token}`;
}

async function streamRemote(req, res, targetUrl, options = {}) {
  const response = await fetch(targetUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs || 20_000),
    headers: buildProviderHeaders(targetUrl, {
      accept: options.accept || "*/*",
      range: req.headers.range || "",
      ...(options.headers || {})
    })
  });

  if (!response.ok) {
    sendError(res, response.status, "O stream remoto nao pode ser reproduzido.");
    return;
  }

  const finalUrl = response.url;
  const contentType = response.headers.get("content-type") || "";
  const shouldRewriteHls =
    options.rewriteHls ||
    contentType.includes("mpegurl") ||
    /\.m3u8($|\?)/i.test(finalUrl);

  if (shouldRewriteHls) {
    const manifest = await response.text();
    const baseUrl = new URL(finalUrl);
    const rewritten = manifest
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          return line;
        }

        const absolute = new URL(trimmed, baseUrl).toString();
        const token = registerProxyTarget(options.session, absolute);
        return buildProxyUrl(token);
      })
      .join("\n");

    sendText(res, 200, rewritten, "application/vnd.apple.mpegurl; charset=utf-8");
    return;
  }

  const headers = {};
  const passthroughHeaders = [
    "accept-ranges",
    "cache-control",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified"
  ];

  for (const header of passthroughHeaders) {
    const value = response.headers.get(header);
    if (value) {
      headers[header] = value;
    }
  }

  res.writeHead(response.status, headers);
  if (response.body) {
    for await (const chunk of response.body) {
      res.write(chunk);
    }
  }
  res.end();
}

function getMediaUrl(session, type, id, extension, directSource) {
  if (directSource) {
    try {
      return new URL(directSource, ensureTrailingSlash(session.host)).toString();
    } catch (error) {
      return directSource;
    }
  }

  const safeExtension = String(extension || "mp4").replace(/[^a-z0-9]/gi, "") || "mp4";

  if (type === "live") {
    return buildProviderUrl(session.host, `live/${session.username}/${session.password}/${id}.${safeExtension}`).toString();
  }

  if (type === "movie") {
    return buildProviderUrl(session.host, `movie/${session.username}/${session.password}/${id}.${safeExtension}`).toString();
  }

  if (type === "series") {
    return buildProviderUrl(session.host, `series/${session.username}/${session.password}/${id}.${safeExtension}`).toString();
  }

  throw new Error("Tipo de media invalido.");
}

async function proxyAsset(req, res, session, requestedUrl) {
  if (!requestedUrl) {
    sendError(res, 400, "Falta o URL do asset.");
    return;
  }

  const targetUrl = new URL(requestedUrl, ensureTrailingSlash(session.host)).toString();
  const response = await fetch(targetUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(12_000),
    headers: buildProviderHeaders(targetUrl, {
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    })
  });

  if (!response.ok) {
    sendError(res, response.status, "Nao foi possivel carregar a imagem.");
    return;
  }

  const headers = {};
  const contentType = response.headers.get("content-type");
  const contentLength = response.headers.get("content-length");
  const cacheControl = response.headers.get("cache-control");

  if (contentType) {
    headers["content-type"] = contentType;
  }
  if (contentLength) {
    headers["content-length"] = contentLength;
  }
  if (cacheControl) {
    headers["cache-control"] = cacheControl;
  }

  res.writeHead(response.status, headers);
  if (response.body) {
    for await (const chunk of response.body) {
      res.write(chunk);
    }
  }
  res.end();
}

async function serveStatic(req, res, requestUrl) {
  let relativePath = decodeURIComponent(requestUrl.pathname);
  if (relativePath === "/") {
    relativePath = "/index.html";
  }

  const normalized = path
    .normalize(relativePath)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
  let targetPath = path.join(PUBLIC_DIR, normalized);

  try {
    const stat = await fs.promises.stat(targetPath);
    if (stat.isDirectory()) {
      targetPath = path.join(targetPath, "index.html");
    }
  } catch (error) {
    targetPath = path.join(PUBLIC_DIR, "index.html");
  }

  try {
    const buffer = await readFile(targetPath);
    const ext = path.extname(targetPath).toLowerCase();
    sendText(res, 200, buffer, MIME_TYPES[ext] || "application/octet-stream");
  } catch (error) {
    sendError(res, 404, "Ficheiro nao encontrado.");
  }
}

async function route(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "POST" && requestUrl.pathname === "/api/login") {
      const body = await parseBody(req);
      const host = String(body.host || "").trim();
      const username = String(body.username || "").trim();
      const password = String(body.password || "").trim();

      if (!host || !username || !password) {
        sendError(res, 400, "Preenche host, username e password.");
        return;
      }

      const login = await loginAgainstProvider(host, username, password);
      const session = createSession({
        host: login.host,
        apiEndpoint: login.apiEndpoint,
        username,
        password,
        summary: login.summary
      });

      const bootstrap = await getBootstrap(session);
      sendJson(
        res,
        200,
        {
          ok: true,
          bootstrap
        },
        {
          "set-cookie": sessionCookie(session.id)
        }
      );
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/logout") {
      const session = getSession(req);
      if (session) {
        destroySession(session.id);
      }

      sendJson(
        res,
        200,
        { ok: true },
        {
          "set-cookie": clearSessionCookie()
        }
      );
      return;
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      const session = getSession(req);
      if (!session) {
        sendError(res, 401, "Sessao expirada. Faz login novamente.");
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/bootstrap") {
        const bootstrap = await getBootstrap(session);
        sendJson(res, 200, bootstrap);
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/catalog") {
        const type = String(requestUrl.searchParams.get("type") || "");
        const catalog = await getCatalog(session, type);
        sendJson(res, 200, catalog);
        return;
      }

      if (req.method === "GET" && requestUrl.pathname.startsWith("/api/vod/")) {
        const id = requestUrl.pathname.split("/").pop();
        const details = await getVodDetails(session, id);
        sendJson(res, 200, details);
        return;
      }

      if (req.method === "GET" && requestUrl.pathname.startsWith("/api/series/")) {
        const id = requestUrl.pathname.split("/").pop();
        const details = await getSeriesDetails(session, id);
        sendJson(res, 200, details);
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/asset") {
        await proxyAsset(req, res, session, requestUrl.searchParams.get("url"));
        return;
      }

      if (req.method === "GET" && requestUrl.pathname.startsWith("/api/stream/live/")) {
        const id = requestUrl.pathname.split("/").pop();
        const playlistUrl = getMediaUrl(session, "live", id, "m3u8");
        await streamRemote(req, res, playlistUrl, {
          session,
          rewriteHls: true
        });
        return;
      }

      if (req.method === "GET" && requestUrl.pathname.startsWith("/api/stream/movie/")) {
        const id = requestUrl.pathname.split("/").pop();
        const extension = requestUrl.searchParams.get("ext") || "mp4";
        const directSource = requestUrl.searchParams.get("direct") || "";
        const mode = requestUrl.searchParams.get("mode");
        const targetUrl = getMediaUrl(session, "movie", id, extension, directSource);

        await streamRemote(req, res, targetUrl, {
          session,
          rewriteHls: mode === "hls" || /\.m3u8($|\?)/i.test(targetUrl)
        });
        return;
      }

      if (req.method === "GET" && requestUrl.pathname.startsWith("/api/stream/series/")) {
        const id = requestUrl.pathname.split("/").pop();
        const extension = requestUrl.searchParams.get("ext") || "mp4";
        const directSource = requestUrl.searchParams.get("direct") || "";
        const mode = requestUrl.searchParams.get("mode");
        const targetUrl = getMediaUrl(session, "series", id, extension, directSource);

        await streamRemote(req, res, targetUrl, {
          session,
          rewriteHls: mode === "hls" || /\.m3u8($|\?)/i.test(targetUrl)
        });
        return;
      }

      if (req.method === "GET" && requestUrl.pathname.startsWith("/api/proxy/")) {
        const token = requestUrl.pathname.split("/").pop();
        const target = session.proxyTokens.get(token);
        if (!target || target.expiresAt <= Date.now()) {
          sendError(res, 404, "Proxy expirado.");
          return;
        }

        await streamRemote(req, res, target.targetUrl, {
          session
        });
        return;
      }

      sendError(res, 404, "Endpoint API desconhecido.");
      return;
    }

    await serveStatic(req, res, requestUrl);
  } catch (error) {
    sendError(res, 500, error.message || "Erro interno.");
  }
}

const server = http.createServer((req, res) => {
  route(req, res);
});

server.listen(PORT, () => {
  console.log(`Streaming Hub disponivel em http://localhost:${PORT}`);
});
