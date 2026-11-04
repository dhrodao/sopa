/* =========================================================================
 * Gasolina · medias móviles y predicción
 * App vanilla JS — sin frameworks ni dependencias.
 * Fuente: https://api.preciosgasolina.es
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

// Paleta (debe coincidir con styles.css)
const COLORS = {
  price: "#38bdf8",
  sma: "#a78bfa",
  forecast: "#fbbf24",
  grid: "#273049",
  text: "#8b97b4",
  axis: "#3a4668",
};

// Elementos del DOM
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
  map: document.getElementById("map"),
  addressForm: document.getElementById("addressForm"),
  addressInput: document.getElementById("addressInput"),
  addressSearch: document.getElementById("addressSearch"),
};

let currentModel = null; // último modelo calculado, para redibujar en resize

// Estado de las gasolineras cercanas
const geo = {
  coords: null, // {lat, lng}
  stations: [], // resultado de /nearby
  selectedId: null,
  selectedName: null,
};

// Estado del mapa (Leaflet)
const mapState = {
  map: null,
  userMarker: null,
  radiusCircle: null,
  markers: new Map(), // id de estación -> marcador Leaflet
};

/* ------------------------------------------------------------------ *
 * Obtención de datos
 * ------------------------------------------------------------------ */

// Normaliza la serie nacional (/v1/history → data.points[] {date, average})
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

// Normaliza el histórico de una estación
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

// Busca gasolineras cerca de unas coordenadas
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

/* ------------------------------------------------------------------ *
 * Cálculos: media móvil y predicción
 * ------------------------------------------------------------------ */

// Media móvil simple. Devuelve array alineado con la serie (null hasta
// completar la ventana).
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

// Regresión lineal por mínimos cuadrados sobre (x=índice, y=precio).
// Devuelve {slope, intercept, r2}.
function linearRegression(values) {
  const n = values.length;
  const xs = values.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (values[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;

  // Coeficiente de determinación R²
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * xs[i] + intercept;
    ssTot += (values[i] - meanY) ** 2;
    ssRes += (values[i] - pred) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

// Construye la proyección futura a partir de la regresión. Para dar algo
// más de estabilidad se ajusta la recta sobre una ventana reciente.
function buildForecast(series, forecastDays) {
  const values = series.map((p) => p.value);
  // Ventana de ajuste: usa como mucho los últimos 21 puntos, mínimo 5.
  const fitWindow = Math.min(values.length, Math.max(5, Math.min(21, values.length)));
  const fitValues = values.slice(values.length - fitWindow);
  const { slope, intercept, r2 } = linearRegression(fitValues);

  const lastDate = new Date(series[series.length - 1].date + "T00:00:00");
  const baseIndex = fitWindow - 1; // índice del último punto dentro de la ventana

  const points = [];
  for (let k = 1; k <= forecastDays; k++) {
    const d = new Date(lastDate);
    d.setDate(d.getDate() + k);
    const x = baseIndex + k;
    points.push({
      date: d.toISOString().slice(0, 10),
      value: slope * x + intercept,
    });
  }
  return { points, slope, r2 };
}

/* ------------------------------------------------------------------ *
 * Métricas
 * ------------------------------------------------------------------ */
function fmtPrice(v) {
  return v.toLocaleString("es-ES", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
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

  const confidence =
    forecast.r2 >= 0.75 ? "alta" : forecast.r2 >= 0.4 ? "media" : "baja";

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
    </div>
  `;
}

/* ------------------------------------------------------------------ *
 * Render del gráfico (Canvas 2D)
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

  // Serie combinada (histórico + predicción) para el eje X
  const allDates = [...series.map((p) => p.date), ...forecast.points.map((p) => p.date)];
  const nTotal = allDates.length;

  // Rango Y considerando precio, SMA y predicción
  const yValues = [
    ...series.map((p) => p.value),
    ...sma.filter((v) => v !== null),
    ...forecast.points.map((p) => p.value),
  ];
  let yMin = Math.min(...yValues);
  let yMax = Math.max(...yValues);
  const yPadRange = (yMax - yMin) * 0.12 || 0.05;
  yMin -= yPadRange;
  yMax += yPadRange;

  const xAt = (i) => pad.left + (nTotal <= 1 ? 0 : (i / (nTotal - 1)) * plotW);
  const yAt = (v) => pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // --- Rejilla + etiquetas Y ---
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

  // --- Etiquetas X (fechas) ---
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

  // Línea divisoria histórico / predicción
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

  // Helper para trazar una polilínea
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

  // --- Precio real (con relleno degradado) ---
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

  // --- Media móvil ---
  const smaPts = [];
  sma.forEach((v, i) => {
    if (v !== null) smaPts.push([xAt(i), yAt(v)]);
  });
  stroke(smaPts, COLORS.sma, 2, false);

  // --- Predicción (continúa desde el último punto real) ---
  const forecastPts = [
    [xAt(splitIndex), yAt(series[splitIndex].value)],
    ...forecast.points.map((p, i) => [xAt(splitIndex + 1 + i), yAt(p.value)]),
  ];
  stroke(forecastPts, COLORS.forecast, 2.4, true);

  // Punto final del precio real
  const lastReal = pricePts[pricePts.length - 1];
  ctx.fillStyle = COLORS.price;
  ctx.beginPath();
  ctx.arc(lastReal[0], lastReal[1], 4, 0, Math.PI * 2);
  ctx.fill();

  // Punto final de la predicción
  const lastFc = forecastPts[forecastPts.length - 1];
  ctx.fillStyle = COLORS.forecast;
  ctx.beginPath();
  ctx.arc(lastFc[0], lastFc[1], 4, 0, Math.PI * 2);
  ctx.fill();
}

/* ------------------------------------------------------------------ *
 * Estados de UI
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
 * Mapa (Leaflet + OpenStreetMap)
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
  }).setView([40.4168, -3.7038], 13); // vista por defecto (Madrid) hasta geolocalizar

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(mapState.map);

  // Clic en el mapa → reubica el punto de búsqueda y recarga gasolineras.
  mapState.map.on("click", (e) => {
    setLocation(e.latlng.lat, e.latlng.lng);
  });
}

// Coloca/actualiza el marcador de la ubicación del usuario y el círculo de radio
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

    // Mientras se arrastra, el círculo de radio sigue al marcador (sin pedir datos).
    mapState.userMarker.on("drag", (e) => {
      if (mapState.radiusCircle) mapState.radiusCircle.setLatLng(e.latlng);
    });
    // Al soltar, se fija la nueva ubicación y se recargan las gasolineras.
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
    iconSize: null, // el tamaño lo da el contenido
  });
}

// Pinta los marcadores de las gasolineras y ajusta el encuadre
function updateStationMarkers() {
  if (!mapState.map) return;

  // Limpia los marcadores anteriores
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

// Reconstruye solo los iconos para reflejar la selección sin recargar todo
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
 * Gasolineras cercanas: geolocalización, búsqueda y lista
 * ------------------------------------------------------------------ */
function setStationsHint(msg, isError = false) {
  el.stationsHint.textContent = msg;
  el.stationsHint.className = "stations-hint" + (isError ? " error" : "");
}

function renderStationList() {
  el.stationList.innerHTML = "";
  geo.stations.forEach((s) => {
    const li = document.createElement("li");
    li.className = "station" + (s.id === geo.selectedId ? " is-selected" : "");
    li.tabIndex = 0;
    li.setAttribute("role", "button");

    const cheapest = s === geo.stations[0];
    li.innerHTML = `
      <div class="station__info">
        <div class="station__name">${escapeHtml(s.name)}</div>
        <div class="station__meta">
          <span>${escapeHtml(s.brand?.name || "")}</span>
          <span>· ${s.distance_km != null ? s.distance_km.toFixed(2) + " km" : ""}</span>
          ${s.is_24h ? '<span class="badge">24h</span>' : ""}
          ${cheapest ? '<span class="badge">más barata</span>' : ""}
        </div>
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
      updateStationMarkers(); // limpia marcadores
      return;
    }
    // Mantén la selección si sigue en la lista; si no, selecciona la primera.
    if (!stations.some((s) => s.id === geo.selectedId)) {
      geo.selectedId = stations[0].id;
      geo.selectedName = stations[0].name;
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

// Fija unas coordenadas como centro de búsqueda (desde geolocalización o dirección)
function setLocation(lat, lng) {
  geo.coords = { lat, lng };
  initMap();
  updateUserLocation(lat, lng, Number(el.radius.value));
  loadNearby();
}

// Geocodifica una dirección libre con Nominatim (OpenStreetMap)
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
 * Orquestación
 * ------------------------------------------------------------------ */
function syncSourceUI() {
  const isStation = el.source.value === "station";
  el.stationsPanel.hidden = !isStation;
}

async function update() {
  const source = el.source.value;
  const fuel = el.fuel.value;
  const days = Number(el.days.value);
  const smaWindow = Number(el.sma.value);
  const forecastDays = Number(el.forecast.value);

  // Modo gasolinera sin selección todavía: no hay nada que graficar.
  if (source === "station" && !geo.selectedId) {
    currentModel = null;
    el.metrics.innerHTML = "";
    el.chartTitle.textContent = "Evolución del precio";
    setStatus("Selecciona una gasolinera cercana para ver su tendencia.");
    return;
  }

  el.reload.disabled = true;
  setStatus("Cargando datos…");
  el.metrics.innerHTML = "";

  try {
    const series =
      source === "station"
        ? await fetchStationHistory(geo.selectedId, fuel, days)
        : await fetchSpainHistory(fuel, days);

    const values = series.map((p) => p.value);
    const sma = simpleMovingAverage(values, smaWindow);
    const forecast = buildForecast(series, forecastDays);

    currentModel = { series, sma, forecast };

    const where = source === "station" ? geo.selectedName : "España";
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

// Redibuja al cambiar el tamaño (sin volver a pedir datos)
let resizeTimer = null;
window.addEventListener("resize", () => {
  if (!currentModel) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => drawChart(currentModel), 120);
});

/* ------------------------------------------------------------------ *
 * Eventos
 * ------------------------------------------------------------------ */
el.source.addEventListener("change", () => {
  syncSourceUI();
  if (el.source.value === "station") {
    // Muestra el mapa aunque todavía no haya ubicación, para poder hacer clic.
    initMap();
    if (mapState.map) {
      // Leaflet necesita recalcular el tamaño si el contenedor estuvo oculto.
      setTimeout(() => mapState.map.invalidateSize(), 0);
    }
    if (!geo.coords) {
      setStationsHint(
        "Usa tu ubicación, escribe una dirección o haz clic en el mapa para elegir un punto."
      );
    }
  }
  update();
});

el.reload.addEventListener("click", update);

// El carburante afecta tanto a la serie como a la lista de gasolineras.
el.fuel.addEventListener("change", () => {
  if (el.source.value === "station" && geo.coords) {
    loadNearby();
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

// Carga inicial
syncSourceUI();
update();
