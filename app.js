/* =========================================================================
 * Gasolina · moving averages and forecasting
 * Vanilla JS app — no frameworks, no dependencies.
 * Data source: https://api.preciosgasolina.es
 * ========================================================================= */

"use strict";

const API_BASE = "https://api.preciosgasolina.es/v1";
const GEOCODER_URL = "https://nominatim.openstreetmap.org/search";

const FUEL_LABELS = {
  gasoline_95: "Gasolina 95",
  gasoline_98: "Gasolina 98",
  diesel: "Diésel",
  diesel_premium: "Diésel premium",
  lpg: "GLP",
  cng: "GNC",
};

// Palette (must match styles.css)
const COLORS = {
  price: "#38bdf8",
  sma: "#a78bfa",
  forecast: "#fbbf24",
  grid: "#273049",
  text: "#8b97b4",
  axis: "#3a4668",
};

// DOM elements
const el = {
  source: document.getElementById("source"),
  fuel: document.getElementById("fuel"),
  days: document.getElementById("days"),
  sma: document.getElementById("sma"),
  forecast: document.getElementById("forecast"),
  reload: document.getElementById("reload"),
  metrics: document.getElementById("metrics"),
  chart: document.getElementById("chart"),
  status: document.getElementById("status"),
  chartTitle: document.getElementById("chartTitle"),
  stationsPanel: document.getElementById("stationsPanel"),
  radius: document.getElementById("radius"),
  geolocate: document.getElementById("geolocate"),
  stationsHint: document.getElementById("stationsHint"),
  stationList: document.getElementById("stationList"),
  stationsTitle: document.getElementById("stationsTitle"),
  locControls: document.getElementById("locControls"),
  map: document.getElementById("map"),
  addressForm: document.getElementById("addressForm"),
  addressInput: document.getElementById("addressInput"),
  addressSearch: document.getElementById("addressSearch"),
  vehicleForm: document.getElementById("vehicleForm"),
  vehicleTank: document.getElementById("vehicleTank"),
  vehicleConsumption: document.getElementById("vehicleConsumption"),
  vehicleHint: document.getElementById("vehicleHint"),
};

let currentModel = null; // last computed model, used to redraw on resize

// Nearby stations state
const geo = {
  coords: null, // {lat, lng}
  stations: [], // result of /nearby
  selectedId: null,
  selectedName: null,
};

// Vehicle profile (persisted in localStorage): tank capacity in litres and
// fuel consumption in L/100km. Used to show €/fill and net savings.
const VEHICLE_KEY = "sopa.vehicle";
const vehicle = { tankL: null, consumption: null };

// Favorite stations (persisted). Stored as a map id -> {id, name, brand} so we
// can list them and fetch their current price even when out of the radius.
const FAV_KEY = "sopa.favorites";
let favorites = new Map();

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        favorites = new Map(arr.filter((f) => f && f.id != null).map((f) => [f.id, f]));
      }
    }
  } catch (err) {
    console.warn("No se pudieron leer los favoritos:", err);
  }
}

function saveFavorites() {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favorites.values()]));
  } catch (err) {
    console.warn("No se pudieron guardar los favoritos:", err);
  }
}

function isFavorite(id) {
  return favorites.has(id);
}

// Adds or removes a station from favorites. `meta` carries {id, name, brand}.
function toggleFavorite(meta) {
  if (favorites.has(meta.id)) {
    favorites.delete(meta.id);
  } else {
    favorites.set(meta.id, { id: meta.id, name: meta.name, brand: meta.brand || null });
  }
  saveFavorites();
}

// Map state (Leaflet)
const mapState = {
  map: null,
  userMarker: null,
  radiusCircle: null,
  markers: new Map(), // station id -> Leaflet marker
};

/* ------------------------------------------------------------------ *
 * Data fetching
 * ------------------------------------------------------------------ */

// Normalizes the national series (/v1/history → data.points[] {date, average})
async function fetchSpainHistory(fuel, days) {
  const url = `${API_BASE}/history?level=spain&fuel=${encodeURIComponent(fuel)}&days=${days}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`La API respondió ${res.status}`);
  const json = await res.json();
  const points = json?.data?.points;
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error("No hay datos para esta selección.");
  }
  return normalizeSeries(points.map((p) => ({ date: p.date, value: Number(p.average) })));
}

// Normalizes a single station's history
// (/v1/stations/{id}/history → data.series[].points[] {date, price})
async function fetchStationHistory(id, fuel, days) {
  const url = `${API_BASE}/stations/${encodeURIComponent(id)}/history?days=${days}&fuel=${encodeURIComponent(fuel)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`La API respondió ${res.status}`);
  const json = await res.json();
  const series = json?.data?.series;
  const match = Array.isArray(series)
    ? series.find((s) => s.fuel === fuel) || series[0]
    : null;
  const points = match?.points;
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error("Esta gasolinera no tiene histórico para este carburante.");
  }
  return normalizeSeries(points.map((p) => ({ date: p.date, value: Number(p.price) })));
}

function normalizeSeries(rows) {
  return rows
    .filter((p) => Number.isFinite(p.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Finds stations near a coordinate
async function fetchNearby(lat, lng, fuel, radiusKm) {
  const url =
    `${API_BASE}/stations/nearby?lat=${lat}&lng=${lng}` +
    `&fuel=${encodeURIComponent(fuel)}&radius_km=${radiusKm}&sort=price&limit=20`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`La API respondió ${res.status}`);
  const json = await res.json();
  const stations = json?.data?.stations;
  if (!Array.isArray(stations)) throw new Error("Respuesta inesperada de la API.");
  return stations;
}

// Fetches a single station by id (/v1/stations/{id}). Returns the raw station
// object, whose `fuels[]` holds the current price per fuel. Used for favorites.
async function fetchStation(id) {
  const res = await fetch(`${API_BASE}/stations/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`La API respondió ${res.status}`);
  const json = await res.json();
  const station = json?.data ?? json;
  if (!station || station.id == null) throw new Error("Estación no encontrada.");
  return station;
}

// Extracts the current price for a given fuel from a station's `fuels[]`.
function priceForFuel(station, fuel) {
  const list = Array.isArray(station?.fuels) ? station.fuels : [];
  const match = list.find((f) => f.fuel === fuel);
  return match && Number.isFinite(Number(match.price)) ? Number(match.price) : null;
}

/* ------------------------------------------------------------------ *
 * Calculations: moving average and forecasting
 * ------------------------------------------------------------------ */

// Simple moving average. Returns an array aligned with the series (null until
// the window is filled).
function simpleMovingAverage(values, window) {
  const out = new Array(values.length).fill(null);
  if (window < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

// Least-squares linear regression over (x=index, y=price).
// Supports optional weights (WLS): w[i] weights each observation. If omitted,
// it reduces to ordinary least squares (OLS). Returns {slope, intercept, r2}.
function linearRegression(values, weights) {
  const n = values.length;
  const xs = values.map((_, i) => i);
  const w = weights || xs.map(() => 1);
  const sumW = w.reduce((a, b) => a + b, 0);

  const meanX = xs.reduce((acc, x, i) => acc + w[i] * x, 0) / sumW;
  const meanY = values.reduce((acc, y, i) => acc + w[i] * y, 0) / sumW;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += w[i] * (xs[i] - meanX) * (values[i] - meanY);
    den += w[i] * (xs[i] - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;

  // Coefficient of determination R² (weighted)
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * xs[i] + intercept;
    ssTot += w[i] * (values[i] - meanY) ** 2;
    ssRes += w[i] * (values[i] - pred) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

// Exponentially decaying weights toward the past: the most recent point has
// weight 1, and the weight halves every `halfLife` steps (lambda derived from it).
function recencyWeights(n, halfLife = 10) {
  const lambda = Math.log(2) / Math.max(1, halfLife);
  const w = [];
  for (let i = 0; i < n; i++) {
    const age = n - 1 - i; // 0 for the most recent point
    w.push(Math.exp(-lambda * age));
  }
  return w;
}

// Recency-weighted linear regression forecast over a window.
// Returns an array of `horizon` future values (numbers only).
function linearForecast(values, horizon, fitWindow) {
  const win = Math.min(values.length, fitWindow);
  const fit = values.slice(values.length - win);
  const w = recencyWeights(fit.length);
  const { slope, intercept } = linearRegression(fit, w);
  const baseIndex = fit.length - 1;
  const out = [];
  for (let k = 1; k <= horizon; k++) out.push(slope * (baseIndex + k) + intercept);
  return out;
}

// Holt's double exponential smoothing. Keeps a level (l) and a trend (b)
// that update giving more weight to recent data. Extrapolates l + k*b.
// Returns an array of `horizon` future values.
function holtForecast(values, horizon, alpha = 0.5, beta = 0.3) {
  if (values.length < 2) {
    const last = values[values.length - 1] ?? 0;
    return new Array(horizon).fill(last);
  }
  let level = values[0];
  let trend = values[1] - values[0];
  for (let i = 1; i < values.length; i++) {
    const prevLevel = level;
    level = alpha * values[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  const out = [];
  for (let k = 1; k <= horizon; k++) out.push(level + k * trend);
  return out;
}

// Naive (persistence) forecast: tomorrow equals today. For stepwise, mostly
// flat series (a single station) this is often the hardest baseline to beat.
function naiveForecast(values, horizon) {
  const last = values[values.length - 1] ?? 0;
  return new Array(horizon).fill(last);
}

// Aligns two {date, value} series on their common dates and returns parallel
// value arrays [a[], b[]] in chronological order.
function alignByDate(seriesA, seriesB) {
  const mapB = new Map(seriesB.map((p) => [p.date, p.value]));
  const a = [];
  const b = [];
  for (const p of seriesA) {
    if (mapB.has(p.date)) {
      a.push(p.value);
      b.push(mapB.get(p.date));
    }
  }
  return [a, b];
}

// Anchored forecast for a single station: the station tends to track the
// national market with a roughly constant offset. We forecast the national
// trend (smooth, lots of data) and add the recent station−national spread.
// `refSeries` is the national {date, value} series aligned by date.
// Returns an array of `horizon` future values, or null if not enough overlap.
function anchoredForecast(stationSeries, refSeries, horizon) {
  if (!Array.isArray(refSeries) || refSeries.length < 8) return null;
  const [stn, nat] = alignByDate(stationSeries, refSeries);
  if (stn.length < 8) return null; // too little overlap to be reliable

  // Recent spread (station − national); use the median for robustness.
  const k = Math.min(stn.length, 10);
  const spreads = [];
  for (let i = stn.length - k; i < stn.length; i++) spreads.push(stn[i] - nat[i]);
  const sorted = [...spreads].sort((a, b) => a - b);
  const spread = sorted[Math.floor(sorted.length / 2)];

  // Forecast the national trend with Holt and re-apply the spread.
  const natFuture = holtForecast(nat, horizon);
  return natFuture.map((v) => v + spread);
}

// RMSE between two aligned arrays.
function rmse(actual, predicted) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < actual.length; i++) {
    if (Number.isFinite(actual[i]) && Number.isFinite(predicted[i])) {
      sum += (actual[i] - predicted[i]) ** 2;
      n++;
    }
  }
  return n === 0 ? Infinity : Math.sqrt(sum / n);
}

// Rolling-origin backtesting: for the last `testSize` points,
// train only on prior data, predict one step and compare. Returns the
// out-of-sample RMSE of a given model (fn: (trainValues) => one-step prediction).
function backtestOneStep(values, forecastFn, testSize) {
  const minTrain = 5;
  const start = Math.max(minTrain, values.length - testSize);
  const actual = [];
  const pred = [];
  for (let i = start; i < values.length; i++) {
    const train = values.slice(0, i);
    const next = forecastFn(train); // prediction for the value at i
    if (Number.isFinite(next)) {
      actual.push(values[i]);
      pred.push(next);
    }
  }
  return { rmse: rmse(actual, pred), count: actual.length };
}

// Builds the future projection by picking the best model via backtesting
// and also returns a confidence band that widens with the horizon.
// `reference` is an optional national {date, value} series used to anchor a
// single station's forecast to the (smoother) national trend.
function buildForecast(series, forecastDays, reference) {
  const values = series.map((p) => p.value);
  const n = values.length;
  // Fit window for regression: at most the last 21 points.
  const fitWindow = Math.max(5, Math.min(21, n));

  // Candidate models as one-step predictors (for backtesting).
  const candidates = {
    naive: (train) => naiveForecast(train, 1)[0],
    linear: (train) => linearForecast(train, 1, fitWindow)[0],
    holt: (train) => holtForecast(train, 1)[0],
  };

  // If a national reference is available, add the anchored model. Its one-step
  // predictor rebuilds the spread using only the station history up to the
  // training cutoff, aligned by date against the reference.
  const hasRef = Array.isArray(reference) && reference.length >= 8;
  if (hasRef) {
    candidates.anchored = (train) => {
      const trainSeries = series.slice(0, train.length);
      const f = anchoredForecast(trainSeries, reference, 1);
      return f ? f[0] : NaN;
    };
  }

  // Validation set size: ~30% of the series, clamped to [5, 14].
  const testSize = Math.max(5, Math.min(14, Math.round(n * 0.3)));

  let best = null;
  const scores = {};
  for (const [name, fn] of Object.entries(candidates)) {
    const { rmse: err, count } = backtestOneStep(values, fn, testSize);
    scores[name] = err;
    if (count >= 3 && (best === null || err < best.err)) {
      best = { name, err };
    }
  }
  // If backtesting was inconclusive (very short series), fall back to naive.
  if (!best) best = { name: "naive", err: Infinity };

  // Generate the future prediction with the winning model.
  let future;
  if (best.name === "holt") {
    future = holtForecast(values, forecastDays);
  } else if (best.name === "naive") {
    future = naiveForecast(values, forecastDays);
  } else if (best.name === "anchored") {
    future = anchoredForecast(series, reference, forecastDays) || naiveForecast(values, forecastDays);
  } else {
    future = linearForecast(values, forecastDays, fitWindow);
  }

  // Base error for the band: out-of-sample RMSE (if finite) or the
  // standard deviation of recent values as a fallback.
  let sigma = best.err;
  if (!Number.isFinite(sigma)) {
    const recent = values.slice(-fitWindow);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    sigma = Math.sqrt(
      recent.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, recent.length - 1)
    );
  }

  const lastDate = new Date(series[n - 1].date + "T00:00:00");
  const points = future.map((value, i) => {
    const d = new Date(lastDate);
    d.setDate(d.getDate() + (i + 1));
    // The ~95% interval grows with √horizon (accumulated uncertainty).
    const margin = 1.96 * sigma * Math.sqrt(i + 1);
    return {
      date: d.toISOString().slice(0, 10),
      value,
      lower: value - margin,
      upper: value + margin,
    };
  });

  const slope = points.length ? points[0].value - values[n - 1] : 0;
  return { points, model: best.name, rmse: best.err, scores, slope };
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */
function fmtPrice(v) {
  return v.toLocaleString("es-ES", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

// Formats a monetary amount in euros (2 decimals), e.g. 1234.5 → "1.234,50 €".
function fmtEuro(v) {
  return v.toLocaleString("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function renderMetrics(series, sma, forecast) {
  const last = series[series.length - 1];
  const first = series[0];
  const diff = last.value - first.value;
  const pct = (diff / first.value) * 100;
  const lastSma = [...sma].reverse().find((v) => v !== null);
  const predEnd = forecast.points[forecast.points.length - 1];
  const predDiff = predEnd.value - last.value;
  const predPct = (predDiff / last.value) * 100;

  const trendClass = diff > 0 ? "up" : diff < 0 ? "down" : "";
  const predClass = predDiff > 0 ? "up" : predDiff < 0 ? "down" : "";
  const arrow = (x) => (x > 0 ? "▲" : x < 0 ? "▼" : "▬");

  // Reliability derived from the out-of-sample error relative to the current price.
  const relErr = Number.isFinite(forecast.rmse) ? forecast.rmse / last.value : Infinity;
  const confidence = relErr <= 0.004 ? "alta" : relErr <= 0.01 ? "media" : "baja";
  const MODEL_LABELS = {
    naive: "persistencia",
    linear: "lineal",
    holt: "Holt",
    anchored: "anclado al nacional",
  };
  const modelLabel = MODEL_LABELS[forecast.model] || forecast.model;
  const rmseLabel = Number.isFinite(forecast.rmse) ? fmtPrice(forecast.rmse) + " €/L" : "—";

  el.metrics.innerHTML = `
    <div class="metric">
      <div class="metric__label">Precio actual</div>
      <div class="metric__value">${fmtPrice(last.value)} <small>€/L</small></div>
      <div class="metric__sub">${last.date}</div>
    </div>
    <div class="metric">
      <div class="metric__label">Variación del periodo</div>
      <div class="metric__value ${trendClass}">${arrow(diff)} ${fmtPrice(Math.abs(diff))}</div>
      <div class="metric__sub ${trendClass}">${pct >= 0 ? "+" : ""}${pct.toFixed(2)} %</div>
    </div>
    <div class="metric">
      <div class="metric__label">Media móvil</div>
      <div class="metric__value">${lastSma != null ? fmtPrice(lastSma) : "—"} <small>€/L</small></div>
      <div class="metric__sub">ventana ${el.sma.value} días</div>
    </div>
    <div class="metric">
      <div class="metric__label">Predicción (${forecast.points.length} d)</div>
      <div class="metric__value ${predClass}">${fmtPrice(predEnd.value)} <small>€/L</small></div>
      <div class="metric__sub ${predClass}">${arrow(predDiff)} ${predPct >= 0 ? "+" : ""}${predPct.toFixed(2)} % · fiabilidad ${confidence}</div>
      <div class="metric__sub">modelo ${modelLabel} · error ±${rmseLabel}</div>
    </div>
  `;
}

/* ------------------------------------------------------------------ *
 * Chart rendering (Canvas 2D)
 * ------------------------------------------------------------------ */
function drawChart(model) {
  const { series, sma, forecast } = model;
  const canvas = el.chart;
  const ctx = canvas.getContext("2d");

  // HiDPI
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = { top: 20, right: 18, bottom: 42, left: 58 };
  const plotW = cssW - pad.left - pad.right;
  const plotH = cssH - pad.top - pad.bottom;

  // Combined series (history + forecast) for the X axis
  const allDates = [...series.map((p) => p.date), ...forecast.points.map((p) => p.date)];
  const nTotal = allDates.length;

  // Y range considering price, SMA, forecast and confidence band
  const yValues = [
    ...series.map((p) => p.value),
    ...sma.filter((v) => v !== null),
    ...forecast.points.map((p) => p.value),
    ...forecast.points.map((p) => p.lower),
    ...forecast.points.map((p) => p.upper),
  ].filter((v) => Number.isFinite(v));
  let yMin = Math.min(...yValues);
  let yMax = Math.max(...yValues);
  const yPadRange = (yMax - yMin) * 0.12 || 0.05;
  yMin -= yPadRange;
  yMax += yPadRange;

  const xAt = (i) => pad.left + (nTotal <= 1 ? 0 : (i / (nTotal - 1)) * plotW);
  const yAt = (v) => pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // --- Grid + Y labels ---
  ctx.font = "12px 'Segoe UI', system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const yTicks = 5;
  for (let t = 0; t <= yTicks; t++) {
    const v = yMin + ((yMax - yMin) * t) / yTicks;
    const y = yAt(v);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(cssW - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "right";
    ctx.fillText(v.toFixed(3), pad.left - 10, y);
  }

  // --- X labels (dates) ---
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const maxLabels = Math.min(7, nTotal);
  const step = Math.max(1, Math.floor((nTotal - 1) / (maxLabels - 1 || 1)));
  for (let i = 0; i < nTotal; i += step) {
    const d = allDates[i];
    const label = d.slice(5); // MM-DD
    ctx.fillStyle = COLORS.text;
    ctx.fillText(label, xAt(i), cssH - pad.bottom + 10);
  }

  // Divider line between history and forecast
  const splitIndex = series.length - 1;
  if (forecast.points.length > 0) {
    const x = xAt(splitIndex);
    ctx.strokeStyle = "rgba(251, 191, 36, 0.35)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Helper to draw a polyline
  function stroke(pointsXY, color, width, dashed) {
    if (pointsXY.length === 0) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.setLineDash(dashed ? [6, 5] : []);
    ctx.beginPath();
    pointsXY.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // --- Actual price (with gradient fill) ---
  const pricePts = series.map((p, i) => [xAt(i), yAt(p.value)]);

  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
  grad.addColorStop(0, "rgba(56, 189, 248, 0.28)");
  grad.addColorStop(1, "rgba(56, 189, 248, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  pricePts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.lineTo(pricePts[pricePts.length - 1][0], pad.top + plotH);
  ctx.lineTo(pricePts[0][0], pad.top + plotH);
  ctx.closePath();
  ctx.fill();

  stroke(pricePts, COLORS.price, 2.4, false);

  // --- Moving average ---
  const smaPts = [];
  sma.forEach((v, i) => {
    if (v !== null) smaPts.push([xAt(i), yAt(v)]);
  });
  stroke(smaPts, COLORS.sma, 2, false);

  // --- Confidence band (~95%) around the forecast ---
  if (forecast.points.length > 0 && forecast.points.every((p) => Number.isFinite(p.lower))) {
    const anchorX = xAt(splitIndex);
    const anchorY = yAt(series[splitIndex].value); // zero margin at the origin
    const fx = (i) => xAt(splitIndex + 1 + i);

    ctx.fillStyle = "rgba(251, 191, 36, 0.14)";
    ctx.beginPath();
    // Top edge: anchor → upper bounds (left to right).
    ctx.moveTo(anchorX, anchorY);
    forecast.points.forEach((p, i) => ctx.lineTo(fx(i), yAt(p.upper)));
    // Bottom edge: lower bounds (right to left) → back to the anchor.
    for (let i = forecast.points.length - 1; i >= 0; i--) {
      ctx.lineTo(fx(i), yAt(forecast.points[i].lower));
    }
    ctx.closePath();
    ctx.fill();
  }

  // --- Forecast (continues from the last real point) ---
  const forecastPts = [
    [xAt(splitIndex), yAt(series[splitIndex].value)],
    ...forecast.points.map((p, i) => [xAt(splitIndex + 1 + i), yAt(p.value)]),
  ];
  stroke(forecastPts, COLORS.forecast, 2.4, true);

  // Endpoint of the actual price
  const lastReal = pricePts[pricePts.length - 1];
  ctx.fillStyle = COLORS.price;
  ctx.beginPath();
  ctx.arc(lastReal[0], lastReal[1], 4, 0, Math.PI * 2);
  ctx.fill();

  // Endpoint of the forecast
  const lastFc = forecastPts[forecastPts.length - 1];
  ctx.fillStyle = COLORS.forecast;
  ctx.beginPath();
  ctx.arc(lastFc[0], lastFc[1], 4, 0, Math.PI * 2);
  ctx.fill();
}

/* ------------------------------------------------------------------ *
 * UI states
 * ------------------------------------------------------------------ */
function setStatus(msg, isError = false) {
  if (!msg) {
    el.status.className = "status";
    el.status.textContent = "";
    return;
  }
  el.status.textContent = msg;
  el.status.className = "status show" + (isError ? " error" : "");
}

/* ------------------------------------------------------------------ *
 * Map (Leaflet + OpenStreetMap)
 * ------------------------------------------------------------------ */
function mapAvailable() {
  return typeof L !== "undefined";
}

function initMap() {
  if (!mapAvailable() || mapState.map) return;
  el.map.hidden = false;
  mapState.map = L.map(el.map, {
    zoomControl: true,
    attributionControl: true,
  }).setView([40.4168, -3.7038], 13); // default view (Madrid) until geolocated

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(mapState.map);

  // Click on the map → relocate the search point and reload stations.
  mapState.map.on("click", (e) => {
    setLocation(e.latlng.lat, e.latlng.lng);
  });
}

// Places/updates the user location marker and the radius circle
function updateUserLocation(lat, lng, radiusKm) {
  if (!mapState.map) return;
  const latlng = [lat, lng];

  if (!mapState.userMarker) {
    const icon = L.divIcon({ className: "", html: '<div class="user-pin"></div>', iconSize: [16, 16] });
    mapState.userMarker = L.marker(latlng, {
      icon,
      draggable: true,
      zIndexOffset: 1000,
      title: "Arrástrame para mover el punto de búsqueda",
    }).addTo(mapState.map);

    // While dragging, the radius circle follows the marker (no data requests).
    mapState.userMarker.on("drag", (e) => {
      if (mapState.radiusCircle) mapState.radiusCircle.setLatLng(e.latlng);
    });
    // On drop, the new location is set and stations are reloaded.
    mapState.userMarker.on("dragend", (e) => {
      const p = e.target.getLatLng();
      setLocation(p.lat, p.lng);
    });
  } else {
    mapState.userMarker.setLatLng(latlng);
  }

  if (!mapState.radiusCircle) {
    mapState.radiusCircle = L.circle(latlng, {
      radius: radiusKm * 1000,
      color: "#38bdf8",
      weight: 1,
      fillColor: "#38bdf8",
      fillOpacity: 0.06,
    }).addTo(mapState.map);
  } else {
    mapState.radiusCircle.setLatLng(latlng);
    mapState.radiusCircle.setRadius(radiusKm * 1000);
  }

  mapState.map.setView(latlng, mapState.map.getZoom() < 12 ? 13 : mapState.map.getZoom());
}

function priceIcon(station, isCheapest, isSelected) {
  const cls =
    "price-pin" +
    (isSelected ? " price-pin--selected" : isCheapest ? " price-pin--cheapest" : "");
  const price = station.price != null ? fmtPrice(Number(station.price)) : "—";
  return L.divIcon({
    className: "",
    html: `<div class="${cls}">${price}</div>`,
    iconSize: null, // size comes from the content
  });
}

// Draws the station markers and fits the viewport
function updateStationMarkers() {
  if (!mapState.map) return;

  // Clear previous markers
  mapState.markers.forEach((m) => mapState.map.removeLayer(m));
  mapState.markers.clear();

  const bounds = [];
  geo.stations.forEach((s, idx) => {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return;
    const isCheapest = idx === 0;
    const isSelected = s.id === geo.selectedId;
    const marker = L.marker([s.lat, s.lng], {
      icon: priceIcon(s, isCheapest, isSelected),
      zIndexOffset: isSelected ? 500 : 0,
    });

    marker.bindPopup(
      `<b>${escapeHtml(s.name)}</b><br>` +
        `${escapeHtml(s.brand?.name || "")}<br>` +
        `<span class="popup-price">${s.price != null ? fmtPrice(Number(s.price)) + " €/L" : "—"}</span>` +
        `${s.distance_km != null ? " · " + s.distance_km.toFixed(2) + " km" : ""}`
    );

    marker.on("click", () => selectStation(s));
    marker.addTo(mapState.map);
    mapState.markers.set(s.id, marker);
    bounds.push([s.lat, s.lng]);
  });

  if (geo.coords) bounds.push([geo.coords.lat, geo.coords.lng]);
  if (bounds.length > 1) {
    mapState.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }
}

// Rebuilds only the icons to reflect the selection without reloading everything
function refreshMarkerStyles() {
  if (!mapState.map) return;
  geo.stations.forEach((s, idx) => {
    const marker = mapState.markers.get(s.id);
    if (!marker) return;
    marker.setIcon(priceIcon(s, idx === 0, s.id === geo.selectedId));
    marker.setZIndexOffset(s.id === geo.selectedId ? 500 : 0);
  });
}

function focusStationOnMap(id) {
  const marker = mapState.markers.get(id);
  if (marker && mapState.map) {
    mapState.map.panTo(marker.getLatLng());
    marker.openPopup();
  }
}

/* ------------------------------------------------------------------ *
 * Nearby stations: geolocation, search and list
 * ------------------------------------------------------------------ */
function setStationsHint(msg, isError = false) {
  el.stationsHint.textContent = msg;
  el.stationsHint.className = "stations-hint" + (isError ? " error" : "");
}

/* ------------------------------------------------------------------ *
 * Vehicle profile and savings
 * ------------------------------------------------------------------ */

// Loads the vehicle profile from localStorage into state and the inputs.
function loadVehicle() {
  try {
    const raw = localStorage.getItem(VEHICLE_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (Number.isFinite(v.tankL)) vehicle.tankL = v.tankL;
      if (Number.isFinite(v.consumption)) vehicle.consumption = v.consumption;
    }
  } catch (err) {
    console.warn("No se pudo leer el vehículo guardado:", err);
  }
  if (vehicle.tankL != null) el.vehicleTank.value = vehicle.tankL;
  if (vehicle.consumption != null) el.vehicleConsumption.value = vehicle.consumption;
}

// Reads the inputs into state and persists them. Empty/invalid → null.
function saveVehicle() {
  const tank = parseFloat(el.vehicleTank.value);
  const cons = parseFloat(el.vehicleConsumption.value);
  vehicle.tankL = Number.isFinite(tank) && tank > 0 ? tank : null;
  vehicle.consumption = Number.isFinite(cons) && cons > 0 ? cons : null;
  try {
    localStorage.setItem(VEHICLE_KEY, JSON.stringify(vehicle));
  } catch (err) {
    console.warn("No se pudo guardar el vehículo:", err);
  }
}

// True when at least the tank capacity is known (enough for €/fill).
function hasTank() {
  return Number.isFinite(vehicle.tankL) && vehicle.tankL > 0;
}

// Average price across the current station list (the market reference).
function averageStationPrice() {
  const prices = geo.stations
    .map((s) => Number(s.price))
    .filter((p) => Number.isFinite(p));
  if (prices.length === 0) return null;
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

// True when we can rank by net savings (needs tank + consumption + distances).
function canRankByNet() {
  return hasTank() && Number.isFinite(vehicle.consumption);
}

// Orders geo.stations: by net savings (desc) when the vehicle is known,
// otherwise by price (asc). Stable and in place.
function sortStations() {
  const avg = averageStationPrice();
  if (canRankByNet() && avg != null) {
    geo.stations.sort((a, b) => {
      const sa = computeSavings(a, avg);
      const sb = computeSavings(b, avg);
      const na = sa ? sa.net : -Infinity;
      const nb = sb ? sb.net : -Infinity;
      return nb - na;
    });
  } else {
    geo.stations.sort((a, b) => {
      const pa = Number.isFinite(Number(a.price)) ? Number(a.price) : Infinity;
      const pb = Number.isFinite(Number(b.price)) ? Number(b.price) : Infinity;
      return pa - pb;
    });
  }
}

// Savings figures for one station vs. the list average, for the user's vehicle.
//   fillCost   = price · tank
//   detourCost = round-trip litres · price           (fuel burned to get there)
//   gross      = (avgPrice − price) · tank            (vs. average)
//   net        = gross − detourCost
// Returns null if there is no tank capacity or no average to compare against.
function computeSavings(station, avgPrice) {
  if (!hasTank() || avgPrice == null) return null;
  const price = Number(station.price);
  if (!Number.isFinite(price)) return null;

  const tank = vehicle.tankL;
  const fillCost = price * tank;
  const gross = (avgPrice - price) * tank;

  let detourCost = 0;
  if (Number.isFinite(vehicle.consumption) && Number.isFinite(station.distance_km)) {
    const roundTripKm = 2 * station.distance_km;
    const litres = (roundTripKm * vehicle.consumption) / 100;
    detourCost = litres * price;
  }
  return { fillCost, gross, net: gross - detourCost, detourCost };
}

function renderStationList() {
  el.stationList.innerHTML = "";
  const avgPrice = averageStationPrice();
  const rankedByNet = canRankByNet() && avgPrice != null;
  // Lowest-price station (for the "más barata" badge, independent of order).
  let cheapestId = null;
  let cheapestPrice = Infinity;
  geo.stations.forEach((s) => {
    const p = Number(s.price);
    if (Number.isFinite(p) && p < cheapestPrice) {
      cheapestPrice = p;
      cheapestId = s.id;
    }
  });

  geo.stations.forEach((s, idx) => {
    const li = document.createElement("li");
    li.className = "station" + (s.id === geo.selectedId ? " is-selected" : "");
    li.tabIndex = 0;
    li.setAttribute("role", "button");

    const isCheapest = s.id === cheapestId;
    const isBest = rankedByNet && idx === 0; // top of the net-savings ranking

    // Per-vehicle savings block (only when a tank capacity is known).
    const sav = computeSavings(s, avgPrice);
    let savingsHtml = "";
    if (sav) {
      const netClass = sav.net > 0 ? "down" : sav.net < 0 ? "up" : "";
      const sign = sav.net > 0 ? "+" : "";
      const detourNote =
        sav.detourCost > 0
          ? ` <span class="station__detour">(desvío −${fmtEuro(sav.detourCost)})</span>`
          : "";
      savingsHtml = `
        <div class="station__savings">
          <span class="station__fill">${fmtEuro(sav.fillCost)} / lleno</span>
          <span class="station__net ${netClass}">${sign}${fmtEuro(sav.net)} vs. media${detourNote}</span>
        </div>`;
    }

    li.innerHTML = `
      <div class="station__info">
        <div class="station__name">
          <button type="button" class="fav-star${isFavorite(s.id) ? " is-fav" : ""}"
            aria-label="${isFavorite(s.id) ? "Quitar de favoritos" : "Añadir a favoritos"}"
            aria-pressed="${isFavorite(s.id)}" title="Favorito">
            <svg class="fav-star__icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2.6l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.97l-5.8 3.05 1.1-6.46-4.69-4.58 6.49-.94L12 2.6z"/>
            </svg>
          </button>
          <span class="station__name-text">${escapeHtml(s.name)}</span>
        </div>
        <div class="station__meta">
          <span>${escapeHtml(s.brand?.name || "")}</span>
          <span>· ${s.distance_km != null ? s.distance_km.toFixed(2) + " km" : ""}</span>
          ${s.is_24h ? '<span class="badge">24h</span>' : ""}
          ${isBest ? '<span class="badge badge--best">mejor opción</span>' : ""}
          ${isCheapest ? '<span class="badge">más barata</span>' : ""}
        </div>
        ${savingsHtml}
      </div>
      <div class="station__price">
        <b>${s.price != null ? fmtPrice(Number(s.price)) : "—"}</b>
        <span>€/L</span>
      </div>
    `;

    const choose = () => selectStation(s);
    li.addEventListener("click", choose);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose();
      }
    });

    // Favorite toggle: must not trigger the row selection.
    const star = li.querySelector(".fav-star");
    if (star) {
      star.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavorite({ id: s.id, name: s.name, brand: s.brand });
        renderStationList();
        renderFavorites();
      });
    }

    el.stationList.appendChild(li);
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function selectStation(station) {
  geo.selectedId = station.id;
  geo.selectedName = station.name;
  renderStationList();
  refreshMarkerStyles();
  focusStationOnMap(station.id);
  await update();
}

async function loadNearby() {
  if (!geo.coords) return;
  const fuel = el.fuel.value;
  const radiusKm = Number(el.radius.value);
  el.geolocate.disabled = true;
  setStationsHint("Buscando gasolineras cercanas…");
  try {
    const stations = await fetchNearby(geo.coords.lat, geo.coords.lng, fuel, radiusKm);
    geo.stations = stations;
    if (stations.length === 0) {
      geo.selectedId = null;
      setStationsHint("No hay gasolineras con ese carburante en el radio indicado.", true);
      el.stationList.innerHTML = "";
      updateStationMarkers(); // clear markers
      return;
    }
    // Order by net savings (if the vehicle is known) or by price otherwise.
    sortStations();
    // Keep the selection if it's still in the list; otherwise select the first.
    if (!stations.some((s) => s.id === geo.selectedId)) {
      geo.selectedId = geo.stations[0].id;
      geo.selectedName = geo.stations[0].name;
    }
    setStationsHint(`${stations.length} gasolineras encontradas. Pulsa una para ver su tendencia, o haz clic en el mapa para mover el punto.`);
    renderStationList();
    updateStationMarkers();
    await update();
  } catch (err) {
    console.error(err);
    setStationsHint(`No se pudo buscar. ${err.message}`, true);
  } finally {
    el.geolocate.disabled = false;
  }
}

function requestGeolocation() {
  if (!("geolocation" in navigator)) {
    setStationsHint("Tu navegador no admite geolocalización.", true);
    return;
  }
  setStationsHint("Obteniendo tu ubicación…");
  el.geolocate.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      el.geolocate.disabled = false;
      setLocation(pos.coords.latitude, pos.coords.longitude);
    },
    (err) => {
      el.geolocate.disabled = false;
      const msg =
        err.code === err.PERMISSION_DENIED
          ? "Permiso de ubicación denegado."
          : "No se pudo obtener tu ubicación.";
      setStationsHint(msg, true);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
}

// Sets a coordinate as the search center (from geolocation or address)
function setLocation(lat, lng) {
  geo.coords = { lat, lng };
  initMap();
  updateUserLocation(lat, lng, Number(el.radius.value));
  loadNearby();
}

// Geocodes a free-form address with Nominatim (OpenStreetMap)
async function geocodeAddress(query) {
  const q = query.trim();
  if (!q) return;

  el.addressSearch.disabled = true;
  setStationsHint(`Buscando “${q}”…`);
  try {
    const url =
      `${GEOCODER_URL}?q=${encodeURIComponent(q)}` +
      `&format=json&limit=1&addressdetails=0&countrycodes=es`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`El geocodificador respondió ${res.status}`);
    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) {
      setStationsHint("No se encontró esa dirección. Prueba a añadir la ciudad.", true);
      return;
    }
    const { lat, lon } = results[0];
    setLocation(Number(lat), Number(lon));
  } catch (err) {
    console.error(err);
    setStationsHint(`No se pudo buscar la dirección. ${err.message}`, true);
  } finally {
    el.addressSearch.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Favorites list (as a data source)
 * ------------------------------------------------------------------ */

// Loads favorite stations by id, fills geo.stations with their current price
// for the selected fuel, then renders the shared list. Used by "favoritos".
async function loadFavoritesList() {
  const fuel = el.fuel.value;
  if (favorites.size === 0) {
    geo.stations = [];
    geo.selectedId = null;
    el.stationList.innerHTML = "";
    setStationsHint("No tienes favoritos todavía. Marca gasolineras con ★ en “Gasolinera cercana”.");
    return;
  }
  setStationsHint("Cargando precios de tus favoritos…");
  const metas = [...favorites.values()];
  const results = await Promise.all(
    metas.map(async (m) => {
      try {
        const st = await fetchStation(m.id);
        return {
          id: st.id,
          name: st.name || m.name,
          brand: st.brand || m.brand,
          lat: Number(st.lat),
          lng: Number(st.lng),
          is_24h: !!st.is_24h,
          distance_km: null,
          price: priceForFuel(st, fuel),
        };
      } catch (err) {
        console.warn("No se pudo cargar el favorito", m.id, err);
        return { id: m.id, name: m.name, brand: m.brand, price: null, distance_km: null };
      }
    })
  );
  // Cheapest first (nulls last).
  results.sort((a, b) => {
    const pa = Number.isFinite(Number(a.price)) ? Number(a.price) : Infinity;
    const pb = Number.isFinite(Number(b.price)) ? Number(b.price) : Infinity;
    return pa - pb;
  });
  geo.stations = results;
  if (!results.some((s) => s.id === geo.selectedId)) {
    geo.selectedId = results[0].id;
    geo.selectedName = results[0].name;
  }
  const withPrice = results.filter((s) => s.price != null).length;
  setStationsHint(`${results.length} favoritos · ${withPrice} con precio de ${FUEL_LABELS[fuel]}. Pulsa uno para ver su tendencia.`);
  renderStationList();
}

// Re-renders favorites if that mode is active (after toggling a star elsewhere).
function renderFavorites() {
  if (el.source.value === "favorites") loadFavoritesList();
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */
function syncSourceUI() {
  const source = el.source.value;
  const isStation = source === "station";
  const isFavorites = source === "favorites";
  // The stations panel is shared by "cercana" and "favoritos".
  el.stationsPanel.hidden = !(isStation || isFavorites);

  // Location-based controls only make sense for the "cercana" mode.
  el.locControls.hidden = !isStation;
  el.addressForm.hidden = !isStation;
  if (el.map) el.map.hidden = !isStation || !mapState.map;

  // Vehicle savings are relative to the nearby list average, so hide in favs.
  el.vehicleForm.hidden = !isStation;

  el.stationsTitle.textContent = isFavorites ? "Favoritos" : "Gasolineras cercanas";
}

async function update() {
  const source = el.source.value;
  const fuel = el.fuel.value;
  const days = Number(el.days.value);
  const smaWindow = Number(el.sma.value);
  const forecastDays = Number(el.forecast.value);

  // Per-station modes ("cercana" and "favoritos") share the same plotting path.
  const isPerStation = source === "station" || source === "favorites";

  // Per-station mode with no selection yet: nothing to plot.
  if (isPerStation && !geo.selectedId) {
    currentModel = null;
    el.metrics.innerHTML = "";
    el.chartTitle.textContent = "Evolución del precio";
    setStatus(
      source === "favorites"
        ? "Selecciona un favorito para ver su tendencia."
        : "Selecciona una gasolinera cercana para ver su tendencia."
    );
    return;
  }

  el.reload.disabled = true;
  setStatus("Cargando datos…");
  el.metrics.innerHTML = "";

  try {
    const series =
      isPerStation
        ? await fetchStationHistory(geo.selectedId, fuel, days)
        : await fetchSpainHistory(fuel, days);

    // For a single station, fetch the national series too so the forecast can
    // anchor to the (smoother) national trend. Failure here is non-fatal.
    let reference = null;
    if (isPerStation) {
      try {
        reference = await fetchSpainHistory(fuel, days);
      } catch (refErr) {
        console.warn("No se pudo obtener la referencia nacional:", refErr);
      }
    }

    const values = series.map((p) => p.value);
    const sma = simpleMovingAverage(values, smaWindow);
    const forecast = buildForecast(series, forecastDays, reference);

    currentModel = { series, sma, forecast };

    const where = isPerStation ? geo.selectedName : "España";
    el.chartTitle.textContent = `${FUEL_LABELS[fuel]} · ${where} · últimos ${series.length} días`;
    renderMetrics(series, sma, forecast);
    setStatus(null);
    drawChart(currentModel);
  } catch (err) {
    console.error(err);
    currentModel = null;
    setStatus(`No se pudieron cargar los datos. ${err.message}`, true);
  } finally {
    el.reload.disabled = false;
  }
}

// Redraws on resize (without re-fetching data)
let resizeTimer = null;
window.addEventListener("resize", () => {
  if (!currentModel) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => drawChart(currentModel), 120);
});

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */
el.source.addEventListener("change", () => {
  syncSourceUI();
  if (el.source.value === "station") {
    // Show the map even without a location yet, so it can be clicked.
    initMap();
    if (mapState.map) {
      // Leaflet needs to recompute its size if the container was hidden.
      setTimeout(() => mapState.map.invalidateSize(), 0);
    }
    if (!geo.coords) {
      setStationsHint(
        "Usa tu ubicación, escribe una dirección o haz clic en el mapa para elegir un punto."
      );
    }
  } else if (el.source.value === "favorites") {
    loadFavoritesList();
  }
  update();
});

el.reload.addEventListener("click", update);

// Fuel affects both the series and the station list.
el.fuel.addEventListener("change", () => {
  if (el.source.value === "station" && geo.coords) {
    loadNearby();
  } else if (el.source.value === "favorites") {
    loadFavoritesList();
  } else {
    update();
  }
});

[el.days, el.sma, el.forecast].forEach((c) =>
  c.addEventListener("change", update)
);

el.geolocate.addEventListener("click", requestGeolocation);
el.addressForm.addEventListener("submit", (e) => {
  e.preventDefault();
  geocodeAddress(el.addressInput.value);
});
el.radius.addEventListener("change", () => {
  if (geo.coords) {
    updateUserLocation(geo.coords.lat, geo.coords.lng, Number(el.radius.value));
    loadNearby();
  }
});

// Vehicle profile: persist on every edit and recompute the savings in the list.
function updateVehicleHint() {
  if (hasTank()) {
    const consNote = Number.isFinite(vehicle.consumption)
      ? ` · consumo ${vehicle.consumption} L/100 km (incluye el combustible del desvío)`
      : " · añade el consumo para descontar el combustible del desvío";
    el.vehicleHint.textContent = `Depósito ${vehicle.tankL} L${consNote}.`;
  } else {
    el.vehicleHint.textContent =
      "Introduce tu depósito y consumo para ver euros por lleno y ahorro neto frente a la media.";
  }
}

[el.vehicleTank, el.vehicleConsumption].forEach((input) =>
  input.addEventListener("input", () => {
    saveVehicle();
    updateVehicleHint();
    if (el.source.value === "station" && geo.stations.length) {
      sortStations();
      renderStationList();
      updateStationMarkers();
    }
  })
);
// Avoid submitting (reloading) the page if the user presses Enter.
el.vehicleForm.addEventListener("submit", (e) => e.preventDefault());

// Initial load
loadVehicle();
loadFavorites();
updateVehicleHint();
syncSourceUI();
update();
