const express = require("express");

const app = express();
const PORT = process.env.PORT || 7000;
const KEY = process.env.TMDB_API_KEY;
const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
const PAGE_SIZE = 20;
const TTL = 6 * 60 * 60 * 1000; // cache 6 ore

const iso = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 864e5).toISOString().slice(0, 10);

const WATCH_IT = {
  watch_region: "IT",
  with_watch_monetization_types: "flatrate|free|ads|rent|buy",
};

// pages: se presente, il catalogo carica N pagine TMDB in una volta (niente paginazione)
// exclude: scarta titoli arabi e cinesi; noEnglish: scarta trame vuote o in inglese
const CATALOGS = {
  "it-cinema": {
    type: "movie",
    name: "Al cinema in Italia",
    path: "/movie/now_playing",
    params: () => ({ region: "IT" }),
  },
  "it-film-prossimi": {
    type: "movie",
    name: "Prossime uscite film (Italia)",
    path: "/movie/upcoming",
    params: () => ({ region: "IT" }),
  },
  "it-serie-ultime": {
    type: "series",
    name: "Ultime serie TV uscite in Italia",
    path: "/discover/tv",
    pages: 3,
    exclude: true,
    noEnglish: true,
    params: () => ({
      ...WATCH_IT,
      sort_by: "first_air_date.desc",
      "first_air_date.gte": iso(-120),
      "first_air_date.lte": iso(0),
    }),
  },
  "it-serie-prossime": {
    type: "series",
    name: "Prossime serie TV",
    path: "/discover/tv",
    pages: 3,
    exclude: true,
    params: () => ({
      sort_by: "popularity.desc",
      "first_air_date.gte": iso(1),
      "first_air_date.lte": iso(180),
    }),
  },
};

// ---- filtri ----
const BLOCK_LANG = new Set(["ar", "zh", "cn"]);
const BLOCK_COUNTRIES = new Set([
  "CN", "HK", "TW", "MO", // cinese
  "SA", "AE", "EG", "KW", "QA", "BH", "OM", "JO", "LB", "SY", "IQ", "YE",
  "PS", "LY", "DZ", "MA", "TN", "SD", "MR", "SO", "DJ", "KM", // arabo
]);
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F]/;

const blocked = (i) =>
  BLOCK_LANG.has(i.original_language) ||
  (i.origin_country || []).some((c) => BLOCK_COUNTRIES.has(c)) ||
  ARABIC_SCRIPT.test(i.name || "");

const EN_WORDS = new Set(
  "the and of to is with her his for on that as who are an from after when their into this they".split(" ")
);
const IT_WORDS = new Set(
  "il lo la i gli le di del della dei che e un una per con da è nel nella sono si non ma".split(" ")
);
function looksEnglish(text) {
  const words = text.toLowerCase().match(/[a-zàèéìòù']+/g) || [];
  let en = 0, it = 0;
  for (const w of words) {
    if (EN_WORDS.has(w)) en++;
    if (IT_WORDS.has(w)) it++;
  }
  return en > it;
}

// ---- TMDB ----
const cache = new Map();
async function tmdb(path, params = {}) {
  const url = new URL(API + path);
  const headers = { accept: "application/json" };
  if (KEY && KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${KEY}`;
  else url.searchParams.set("api_key", KEY);
  url.searchParams.set("language", "it-IT");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const ck = url.toString();
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`TMDB ${r.status} su ${path}`);
  const v = await r.json();
  cache.set(ck, { t: Date.now(), v });
  return v;
}

function buildMeta(item, type, id) {
  const date = item.release_date || item.first_air_date || "";
  return {
    id,
    type,
    name: item.title || item.name,
    poster: item.poster_path ? `${IMG}/w500${item.poster_path}` : undefined,
    background: item.backdrop_path ? `${IMG}/w1280${item.backdrop_path}` : undefined,
    description: item.overview || undefined,
    releaseInfo: date ? date.slice(0, 4) : undefined,
    released: date ? new Date(date).toISOString() : undefined,
    imdbRating: item.vote_average ? item.vote_average.toFixed(1) : undefined,
    genres: item.genres ? item.genres.map((g) => g.name) : undefined,
  };
}

// Se manca l'ID IMDb (tipico delle uscite future) usa "tmdb:ID" invece di scartare il titolo
async function toMeta(item, type) {
  const kind = type === "movie" ? "movie" : "tv";
  let imdb;
  try {
    imdb = (await tmdb(`/${kind}/${item.id}/external_ids`)).imdb_id;
  } catch {}
  return buildMeta(item, type, imdb || `tmdb:${item.id}`);
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

app.get("/manifest.json", (req, res) => {
  res.json({
    id: "community.nuvio.uscite.italia",
    version: "1.1.0",
    name: "Uscite Italia",
    description:
      "Film al cinema in Italia, prossime uscite e ultime serie TV (dati TMDB).",
    resources: [
      "catalog",
      { name: "meta", types: ["movie", "series"], idPrefixes: ["tmdb:"] },
    ],
    types: ["movie", "series"],
    catalogs: Object.entries(CATALOGS).map(([id, c]) => ({
      type: c.type,
      id,
      name: c.name,
      extra: [{ name: "skip", isRequired: false }],
    })),
  });
});

async function catalogHandler(req, res) {
  const cat = CATALOGS[req.params.id];
  if (!cat || cat.type !== req.params.type) return res.json({ metas: [] });

  const extra = new URLSearchParams(req.params.extra || "");
  const skip = parseInt(extra.get("skip") || "0", 10) || 0;

  try {
    let results;
    if (cat.pages) {
      if (skip > 0) return res.json({ metas: [] });
      const pages = await Promise.all(
        Array.from({ length: cat.pages }, (_, k) =>
          tmdb(cat.path, { ...cat.params(), page: k + 1 })
        )
      );
      const seen = new Set();
      results = pages
        .flatMap((p) => p.results)
        .filter((i) => !seen.has(i.id) && seen.add(i.id));
    } else {
      const page = Math.floor(skip / PAGE_SIZE) + 1;
      results = (await tmdb(cat.path, { ...cat.params(), page })).results;
    }

    if (cat.exclude) results = results.filter((i) => !blocked(i));
    if (cat.noEnglish)
      results = results.filter((i) => i.overview && !looksEnglish(i.overview));
    if (cat.pages) results = results.slice(0, 40);

    const metas = await Promise.all(results.map((i) => toMeta(i, cat.type)));
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({ metas });
  } catch (e) {
    console.error(e.message);
    res.json({ metas: [] });
  }
}

app.get("/catalog/:type/:id.json", catalogHandler);
app.get("/catalog/:type/:id/:extra.json", catalogHandler);

// Meta per i titoli senza ID IMDb (uscite future)
app.get("/meta/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  if (!id.startsWith("tmdb:")) return res.json({ meta: null });
  try {
    const kind = type === "movie" ? "movie" : "tv";
    const d = await tmdb(`/${kind}/${id.slice(5)}`);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({ meta: buildMeta(d, type, id) });
  } catch (e) {
    console.error(e.message);
    res.json({ meta: null });
  }
});

app.get("/", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.send(
    `<h2>Uscite Italia</h2><p>Aggiungi in Nuvio questo URL:</p><code>${base}/manifest.json</code>`
  );
});

if (!KEY) console.warn("ATTENZIONE: variabile TMDB_API_KEY mancante");
app.listen(PORT, () => console.log(`Addon attivo sulla porta ${PORT}`));
