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
    params: () => ({
      sort_by: "popularity.desc",
      "first_air_date.gte": iso(1),
      "first_air_date.lte": iso(180),
    }),
  },
};

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

async function toMeta(item, type) {
  const kind = type === "movie" ? "movie" : "tv";
  let imdb;
  try {
    imdb = (await tmdb(`/${kind}/${item.id}/external_ids`)).imdb_id;
  } catch {}
  if (!imdb) return null;
  const date = item.release_date || item.first_air_date || "";
  return {
    id: imdb,
    type,
    name: item.title || item.name,
    poster: item.poster_path ? `${IMG}/w500${item.poster_path}` : undefined,
    background: item.backdrop_path ? `${IMG}/w1280${item.backdrop_path}` : undefined,
    description: item.overview || undefined,
    releaseInfo: date ? date.slice(0, 4) : undefined,
    released: date ? new Date(date).toISOString() : undefined,
    imdbRating: item.vote_average ? item.vote_average.toFixed(1) : undefined,
  };
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

app.get("/manifest.json", (req, res) => {
  res.json({
    id: "community.nuvio.uscite.italia",
    version: "1.0.0",
    name: "Uscite Italia",
    description:
      "Film al cinema in Italia, prossime uscite e ultime serie TV (dati TMDB).",
    resources: ["catalog"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: Object.entries(CATALOGS).map(([id, c]) => ({
      type: c.type,
      id,
      name: c.name,
      // "search" obbligatorio = catalogo nascosto dalla home (il valore viene ignorato)
      extra: [
        { name: "search", isRequired: true },
        { name: "skip", isRequired: false },
      ],
    })),
  });
});

async function catalogHandler(req, res) {
  const cat = CATALOGS[req.params.id];
  if (!cat || cat.type !== req.params.type) return res.json({ metas: [] });

  const extra = new URLSearchParams(req.params.extra || "");
  const skip = parseInt(extra.get("skip") || "0", 10) || 0;
  const page = Math.floor(skip / PAGE_SIZE) + 1;

  try {
    const data = await tmdb(cat.path, { ...cat.params(), page });
    const metas = (
      await Promise.all(data.results.map((i) => toMeta(i, cat.type)))
    ).filter(Boolean);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({ metas });
  } catch (e) {
    console.error(e.message);
    res.json({ metas: [] });
  }
}

app.get("/catalog/:type/:id.json", catalogHandler);
app.get("/catalog/:type/:id/:extra.json", catalogHandler);

app.get("/", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.send(
    `<h2>Uscite Italia</h2><p>Aggiungi in Nuvio questo URL:</p><code>${base}/manifest.json</code>`
  );
});

if (!KEY) console.warn("ATTENZIONE: variabile TMDB_API_KEY mancante");
app.listen(PORT, () => console.log(`Addon attivo sulla porta ${PORT}`));
