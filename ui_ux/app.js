// ── Map styles (light + dark variants of CARTO Voyager / Dark Matter)
const MAP_STYLE_LIGHT = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
const MAP_STYLE_DARK  = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const map = new maplibregl.Map({
  container: 'map',
  style: MAP_STYLE_LIGHT,
  center: [174.85, -36.82],
  zoom: 11.5,
  attributionControl: false,
});

map.addControl(new maplibregl.NavigationControl(), 'bottom-left');
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'nautical', maxWidth: 120 }), 'top-right');


// ── Currents arrow image: bezier S-curve tail + filled head, white-on-alpha
// for SDF so icon-color can tint it per-feature by speed.
function makeArrowImage() {
  const size = 28;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';

  // Wavy tail — gentle S-curve gives a flowing-water feel rather than a rigid arrow.
  ctx.beginPath();
  ctx.moveTo(size / 2, size - 4);
  ctx.bezierCurveTo(
    size / 2 - 4, size * 0.62,
    size / 2 + 4, size * 0.38,
    size / 2, 9,
  );
  ctx.stroke();

  // Arrowhead
  ctx.beginPath();
  ctx.moveTo(size / 2, 2);
  ctx.lineTo(size / 2 - 5.5, 10);
  ctx.lineTo(size / 2 + 5.5, 10);
  ctx.closePath();
  ctx.fill();

  return ctx.getImageData(0, 0, size, size);
}

function ensureArrowImage() {
  if (!map.hasImage('current-arrow')) {
    map.addImage('current-arrow', makeArrowImage(), { sdf: true });
  }
}
map.on('load',  ensureArrowImage);
map.on('style.load', ensureArrowImage);   // re-add after theme switch


// ── Theme toggle
const themeToggle = document.getElementById('themeToggle');
const storedTheme = localStorage.getItem('theme');
if (storedTheme === 'dark') applyTheme('dark');

themeToggle.addEventListener('click', () => {
  const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('theme', next);
});

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  const newStyle = theme === 'dark' ? MAP_STYLE_DARK : MAP_STYLE_LIGHT;
  map.setStyle(newStyle);
  // After style change, re-draw all runs (map loses custom layers on setStyle).
  map.once('styledata', redrawAllRuns);
}


// ── Currents toggle
const currentsToggle = document.getElementById('currentsToggle');
let currentsOn = false;
let currentsAbort = null;
let currentsRefetchTimer = null;

currentsToggle.addEventListener('click', () => {
  currentsOn = !currentsOn;
  currentsToggle.classList.toggle('active', currentsOn);
  if (currentsOn) fetchCurrents();
  else hideCurrents();
});

map.on('moveend', () => {
  if (!currentsOn) return;
  clearTimeout(currentsRefetchTimer);
  currentsRefetchTimer = setTimeout(fetchCurrents, 250);
});

// Re-render currents after theme/style change (style.load wipes layers).
map.on('style.load', () => { if (currentsOn) fetchCurrents(); });

function currentsSampleTime() {
  // Use the most recent run's start time if available; otherwise "now".
  if (runs && runs.length > 0) {
    const t = runs[runs.length - 1].positions[0]?.time;
    if (t) return t;
  }
  const now = new Date();
  return toLocalDatetime(now) + ':00';
}

async function fetchCurrents() {
  if (currentsAbort) currentsAbort.abort();
  currentsAbort = new AbortController();

  const b = map.getBounds();
  const bbox = `${b.getSouth()},${b.getNorth()},${b.getWest()},${b.getEast()}`;
  const time = encodeURIComponent(currentsSampleTime());

  try {
    const res = await fetch(`/api/currents?bbox=${bbox}&time=${time}`, { signal: currentsAbort.signal });
    if (!res.ok) return;
    const data = await res.json();
    renderCurrents(data.arrows || []);
  } catch (err) {
    if (err.name !== 'AbortError') console.error('currents fetch failed:', err);
  }
}

function renderCurrents(arrows) {
  hideCurrents();
  if (arrows.length === 0) return;
  ensureArrowImage();
  baseArrows = arrows;

  // Source starts empty; the animation loop populates it on the first frame.
  map.addSource('currents', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: 'currents',
    type: 'symbol',
    source: 'currents',
    layout: {
      'icon-image': 'current-arrow',
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-size': ['interpolate', ['linear'], ['get', 'speed'],
        0, 0.45,
        0.5, 0.65,
        1.5, 1.0,
        3, 1.4,
      ],
    },
    paint: {
      // Speed-encoded gradient: pale cyan → blue → purple → red as currents speed up.
      'icon-color': ['interpolate', ['linear'], ['get', 'speed'],
        0,   '#7dd3fc',
        0.5, '#0a84ff',
        1.5, '#bf5af2',
        3,   '#ff453a',
      ],
      // Per-feature alpha — combines flow lifecycle with global breathing pulse.
      'icon-opacity': ['get', 'fade'],
    },
  });
  startCurrentsAnimation();
}

function hideCurrents() {
  if (map.getLayer('currents'))  map.removeLayer('currents');
  if (map.getSource('currents')) map.removeSource('currents');
}

// Currents animation: each arrow drifts ~60 m along its bearing over a 2 s
// cycle (fade-in → drift → fade-out → loop), and on top a slow global pulse
// modulates overall opacity so the whole field feels "alive". Throttled to
// ~30 fps to keep setData costs reasonable for 100-300 arrows.
let baseArrows = [];
let animT = 0;
let animRaf = null;
let animLastTick = 0;

function startCurrentsAnimation() {
  if (animRaf !== null) return;

  function tick(now) {
    if (!map.getLayer('currents')) {
      animRaf = null;
      return;
    }
    if (now - animLastTick >= 33) {
      animLastTick = now;
      animT += 0.033;

      const flowPhase = (animT * 0.75) % 1;           // ~1.3 s drift cycle
      const pulse     = 0.78 + 0.14 * Math.sin(animT * 1.6);  // ~4 s breathing
      const driftMetres = flowPhase * 70;

      let lifecycle;
      if (flowPhase < 0.15)       lifecycle = flowPhase / 0.15;
      else if (flowPhase > 0.85)  lifecycle = (1 - flowPhase) / 0.15;
      else                        lifecycle = 1;

      const features = baseArrows.map(a => {
        const cosB = Math.cos(a.bearing_deg * Math.PI / 180);
        const sinB = Math.sin(a.bearing_deg * Math.PI / 180);
        const cosLat = Math.cos(a.lat * Math.PI / 180);
        const dlat = (cosB * driftMetres) / 111120;
        const dlon = (sinB * driftMetres) / (111120 * cosLat);
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [a.lon + dlon, a.lat + dlat] },
          properties: {
            bearing: a.bearing_deg,
            speed:   a.speed_kt,
            fade:    pulse * lifecycle,
          },
        };
      });

      const src = map.getSource('currents');
      if (src) src.setData({ type: 'FeatureCollection', features });
    }
    animRaf = requestAnimationFrame(tick);
  }
  animRaf = requestAnimationFrame(tick);
}


// ── DOM references
const cardWrap     = document.getElementById('cardWrap');
const cardClose    = document.querySelector('.card-close');
const cardBackdrop = document.querySelector('.card-backdrop');
const objectSelect = document.getElementById('inpObject');
const inpStart     = document.getElementById('inpStart');
const inpEnd       = document.getElementById('inpEnd');
const fab          = document.getElementById('fab');

// Pattern dialog references
const patternCardWrap = document.getElementById('patternCardWrap');
const btnPatternYes = document.getElementById('btnPatternYes');
const btnPatternNo = document.getElementById('btnPatternNo');
const inpRadius = document.getElementById('inpRadius');

// Accuracy dialog references
const accuracyToggle = document.getElementById('accuracyToggle');
const accuracyCardWrap = document.getElementById('accuracyCardWrap');
const inpAccObject = document.getElementById('inpAccObject');
const inpAccStart = document.getElementById('inpAccStart');
const inpAccEnd = document.getElementById('inpAccEnd');
const btnTestAccuracy = document.getElementById('btnTestAccuracy');
const accuracyResults = document.getElementById('accuracyResults');
const accuracyFormError = document.getElementById('accuracyFormError');


// ── Default time
const now   = new Date();
const later = new Date(now.getTime() + 3 * 60 * 60 * 1000);
inpStart.value = toLocalDatetime(now);
inpEnd.value   = toLocalDatetime(later);
inpAccStart.value = toLocalDatetime(now);
inpAccEnd.value   = toLocalDatetime(later);

function toLocalDatetime(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


// ── Load search objects
async function loadObjects() {
  try {
    const res = await fetch('/api/objects');
    const list = await res.json();
    const optionsHtml = list
      .map(o => `<option value="${o.id}">${o.name}</option>`)
      .join('');
    objectSelect.innerHTML = optionsHtml;
    inpAccObject.innerHTML = optionsHtml;
  } catch {
    objectSelect.innerHTML = '<option>Failed to load</option>';
    inpAccObject.innerHTML = '<option>Failed to load</option>';
  }
}
loadObjects();


// ── Card open / close
function openCard() {
  cardWrap.classList.remove('hidden');
  fab.classList.add('hidden');
}

function closeCard() {
  cardWrap.classList.add('hidden');
  fab.classList.remove('hidden');
}

cardClose.addEventListener('click', closeCard);
cardBackdrop.addEventListener('click', closeCard);

// ── Pattern dialog
function openPatternDialog() {
  patternCardWrap.classList.remove('hidden');
}

function closePatternDialog() {
  patternCardWrap.classList.add('hidden');
}

// ── Accuracy dialog
function openAccuracyCard() {
  accuracyCardWrap.classList.remove('hidden');
  fab.classList.add('hidden');
  accuracyResults.classList.add('hidden');
  clearAccuracyError();
}

function closeAccuracyCard() {
  accuracyCardWrap.classList.add('hidden');
  fab.classList.remove('hidden');
}

accuracyToggle.addEventListener('click', openAccuracyCard);
accuracyCardWrap.querySelector('.card-close').addEventListener('click', closeAccuracyCard);
accuracyCardWrap.querySelector('.card-backdrop').addEventListener('click', closeAccuracyCard);


// ── FAB: click = open card, drag = pin drop; drag back to corner = cancel
const dragCoord = document.getElementById('dragCoord');
const fabAnchor = document.getElementById('fabAnchor');
const DRAG_THRESHOLD = 6;
const HOME_RADIUS   = 90;   // px — within this radius of home, magnetic snap kicks in

let dragging  = false;
let dragMoved = false;
let inSnap    = false;
let dragStartX = 0;
let dragStartY = 0;

function homeCenter() {
  // FAB is 52px, positioned bottom:24 right:24 → its center sits here:
  return {
    x: window.innerWidth  - 24 - 26,
    y: window.innerHeight - 24 - 26,
  };
}

function nearHome(x, y) {
  const h = homeCenter();
  return Math.hypot(x - h.x, y - h.y) < HOME_RADIUS;
}

fab.addEventListener('pointerdown', (e) => {
  dragging = true;
  dragMoved = false;
  inSnap = false;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  fab.setPointerCapture(e.pointerId);
});

fab.addEventListener('pointermove', (e) => {
  if (!dragging) return;

  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;

  if (!dragMoved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
    dragMoved = true;
    fab.classList.add('drag-following');
    fabAnchor.classList.add('visible');
  }
  if (!dragMoved) return;

  const snap = nearHome(e.clientX, e.clientY);

  if (snap && !inSnap) {
    // Enter snap zone: FAB fades, X anchor highlights
    inSnap = true;
    fab.classList.add('snap-home');
    fabAnchor.classList.add('highlight');
    fab.style.transform = '';
    dragCoord.classList.remove('visible');
  } else if (!snap && inSnap) {
    // Leaving snap zone: follow pointer again
    inSnap = false;
    fab.classList.remove('snap-home');
    fabAnchor.classList.remove('highlight');
    dragCoord.classList.add('visible');
  }

  if (!snap) {
    // Follow pointer via transform (offset from home)
    const h = homeCenter();
    fab.style.transform = `translate(${e.clientX - h.x}px, ${e.clientY - h.y}px)`;

    const lngLat = map.unproject([e.clientX, e.clientY]);
    dragCoord.style.left = e.clientX + 'px';
    dragCoord.style.top  = e.clientY + 'px';
    dragCoord.textContent = `${lngLat.lat.toFixed(5)}°, ${lngLat.lng.toFixed(5)}°`;
  }
});

fab.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  fab.releasePointerCapture(e.pointerId);

  const droppedOnMap = dragMoved && !inSnap;

  if (droppedOnMap) {
    const lngLat = map.unproject([e.clientX, e.clientY]);
    inpLat.value = lngLat.lat.toFixed(5);
    inpLon.value = lngLat.lng.toFixed(5);
  }

  // Reset FAB + anchor visuals
  fab.classList.remove('drag-following', 'snap-home');
  fabAnchor.classList.remove('visible', 'highlight');
  dragCoord.classList.remove('visible');
  fab.style.transform = '';

  // Open card on plain click or successful drop. Skip on cancel.
  if (!dragMoved || droppedOnMap) openCard();
});


// ── Calculate
const btnCalculate = document.getElementById('btnCalculate');
const inpLat       = document.getElementById('inpLat');
const inpLon       = document.getElementById('inpLon');
const inpWindSpeed = document.getElementById('inpWindSpeed');
const inpWindDir   = document.getElementById('inpWindDir');
const inpReverse   = document.getElementById('inpReverse');
const formError    = document.getElementById('formError');
const btnGetWind   = document.getElementById('btnGetWind');

// ── Get Wind from Open-Meteo
btnGetWind.addEventListener('click', async () => {
  const lat = parseFloat(inpLat.value);
  const lon = parseFloat(inpLon.value);
  const time = inpStart.value;

  if (!lat || !lon || !time) {
    showError('Please fill in Lat, Lon and Start time first');
    return;
  }

  btnGetWind.classList.add('loading');
  btnGetWind.textContent = 'Fetching…';

  try {
    const res = await fetch(`/api/wind?lat=${lat}&lon=${lon}&time=${encodeURIComponent(time + ':00')}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch wind');

    inpWindSpeed.value = data.wind_speed_kts;
    inpWindDir.value   = data.wind_direction_deg;
    clearError();
  } catch (err) {
    showError(`Wind fetch failed: ${err.message}`);
  } finally {
    btnGetWind.classList.remove('loading');
    btnGetWind.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/></svg> Get Wind`;
  }
});

const RUN_COLORS = ['#0a84ff', '#ff9f0a', '#bf5af2', '#30d158', '#ff453a', '#64d2ff', '#ffd60a', '#ff375f'];
const SAT_DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
let runs = [];
let runCounter = 0;

// ── Hover popup: show nearest point's coords on a drift line
const trackCoord = document.getElementById('trackCoord');

function nearestPosition(positions, lng, lat) {
  let best = positions[0];
  let bestDist = Infinity;
  for (const p of positions) {
    const dlon = p.lon - lng;
    const dlat = p.lat - lat;
    const d = dlon * dlon + dlat * dlat;
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

function showTrackPopup(e, positions, label) {
  const p = nearestPosition(positions, e.lngLat.lng, e.lngLat.lat);
  const screen = map.project([p.lon, p.lat]);
  trackCoord.innerHTML = `
    <div class="track-coord-coord">${p.lat.toFixed(5)}°, ${p.lon.toFixed(5)}°</div>
    <div class="track-coord-label">${label}</div>
  `;
  trackCoord.style.left = screen.x + 'px';
  trackCoord.style.top = screen.y + 'px';
  trackCoord.classList.add('visible');
  map.getCanvas().style.cursor = 'pointer';
}

function hideTrackPopup() {
  trackCoord.classList.remove('visible');
  map.getCanvas().style.cursor = '';
}

// ── Click on map → drop a small dot at that lat/lon with a glass popup
// showing coords + distance/bearing to the nearest run's datum. Marker
// stays anchored to geography across pan/zoom; persists until × or new click.
let clickMarker = null;

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const dPhi = (lat2 - lat1) * Math.PI / 180;
  const dLam = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))) / 1852;
}

function compassBearing(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const dLam = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function nearestDatumFrom(lat, lon) {
  if (!runs.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const r of runs) {
    const last = r.positions[r.positions.length - 1];
    const d = haversineNm(lat, lon, last.lat, last.lon);
    if (d < bestDist) {
      bestDist = d;
      best = {
        runId:   r.id,
        color:   r.color,
        distance: d,
        bearing: compassBearing(lat, lon, last.lat, last.lon),
      };
    }
  }
  return best;
}

map.on('click', (e) => {
  if (clickMarker) {
    clickMarker.remove();
    clickMarker = null;
  }

  const lat = e.lngLat.lat;
  const lon = e.lngLat.lng;
  const datum = nearestDatumFrom(lat, lon);
  const infoHtml = datum
    ? `<div class="click-marker-info"><span class="click-marker-runtag" style="background:${datum.color}"></span>${datum.distance.toFixed(2)} NM · ${datum.bearing.toFixed(0)}° from datum</div>`
    : '';

  const el = document.createElement('div');
  el.className = 'click-marker';
  el.innerHTML = `
    <div class="click-marker-popup">
      <button class="click-marker-close" aria-label="Close">×</button>
      <div class="click-marker-coord">${lat.toFixed(5)}°, ${lon.toFixed(5)}°</div>
      ${infoHtml}
    </div>
  `;
  el.querySelector('.click-marker-close').addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (clickMarker) {
      clickMarker.remove();
      clickMarker = null;
    }
  });

  clickMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
});

function showError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function clearError() {
  formError.classList.add('hidden');
}

function showAccuracyError(msg) {
  accuracyFormError.textContent = msg;
  accuracyFormError.classList.remove('hidden');
}

function clearAccuracyError() {
  accuracyFormError.classList.add('hidden');
}

document.querySelectorAll('.card-form input, .card-form select')
  .forEach(el => el.addEventListener('input', clearError));


btnCalculate.addEventListener('click', async () => {
  clearError();

  // Store form data for later use
  const formData = {
    lat: parseFloat(inpLat.value),
    lon: parseFloat(inpLon.value),
    startTime: inpReverse.checked ? (inpEnd.value + ':00') : (inpStart.value + ':00'),
    endTime: inpReverse.checked ? (inpStart.value + ':00') : (inpEnd.value + ':00'),
    windSpeed: parseFloat(inpWindSpeed.value),
    windDirection: parseFloat(inpWindDir.value),
    objectId: parseInt(objectSelect.value, 10),
    isReverse: inpReverse.checked,
  };

  // Close main card and open pattern dialog
  closeCard();
  openPatternDialog();

  // Handle pattern dialog responses
  btnPatternYes.onclick = async () => {
    closePatternDialog();
    await executeDriftCalculation(formData, true);
  };

  btnPatternNo.onclick = async () => {
    closePatternDialog();
    await executeDriftCalculation(formData, false);
  };
});

async function executeDriftCalculation(formData, withPatterns) {
  const btnCalculate = document.getElementById('btnCalculate');
  btnCalculate.disabled = true;
  btnCalculate.textContent = 'Calculating…';

  try {
    const res = await fetch('/api/drift', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: formData.lat,
        lon: formData.lon,
        start_time: formData.startTime,
        end_time: formData.endTime,
        wind_speed: formData.windSpeed,
        wind_direction: formData.windDirection,
        object_id: formData.objectId,
        is_reverse: formData.isReverse,
        multiple_tracks: withPatterns,
        radius_nm: parseFloat(inpRadius.value),
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    // Grab the per-run GPX/KML right away so later calcs don't overwrite them.
    const [gpxText, kmlText] = await Promise.all([
      fetch('/api/gpx').then(r => r.text()),
      fetch('/api/kml').then(r => r.text()),
    ]);

    addRun(data, {
      isReverse: formData.isReverse,
      startLat: formData.lat,
      startLon: formData.lon,
      gpxUrl: makeBlobUrl(gpxText, 'application/gpx+xml'),
      kmlUrl: makeBlobUrl(kmlText, 'application/vnd.google-earth.kml+xml'),
    });
  } catch (err) {
    showError(err.message);
    openCard();
  } finally {
    btnCalculate.disabled = false;
    btnCalculate.textContent = 'Calculate Datum';
  }
}


function makeBlobUrl(text, type) {
  return URL.createObjectURL(new Blob([text], { type }));
}


// ── Run management
function addRun(data, meta) {
  runCounter++;
  const run = {
    id: runCounter,
    color: RUN_COLORS[(runCounter - 1) % RUN_COLORS.length],
    positions: data.positions,
    satellites: data.satellites || [],
    summary: data.summary,
    ...meta,
  };
  runs.push(run);
  drawRun(run);
  renderPills();
  fitToRun(run);
}

function removeRun(id) {
  const run = runs.find(r => r.id === id);
  if (!run) return;

  const layerId = `run-${id}`;
  if (map.getLayer(layerId))  map.removeLayer(layerId);
  if (map.getSource(layerId)) map.removeSource(layerId);
  run.radiusLayers?.forEach(rid => {
    if (map.getLayer(rid)) map.removeLayer(rid);
  });
  const radiusSourceId = `run-${id}-radius`;
  if (map.getSource(radiusSourceId)) map.removeSource(radiusSourceId);
  run.satelliteLayers?.forEach(satId => {
    if (map.getLayer(satId))  map.removeLayer(satId);
    if (map.getSource(satId)) map.removeSource(satId);
  });
  run.markers?.forEach(m => m.remove());
  URL.revokeObjectURL(run.gpxUrl);
  URL.revokeObjectURL(run.kmlUrl);

  runs = runs.filter(r => r.id !== id);
  renderPills();

  if (runs.length === 0) openCard();
}

// 64-point ring around (centerLon, centerLat) at radiusNm. Returned as a
// closed coordinate ring suitable for a GeoJSON Polygon.
function circleRingCoords(centerLon, centerLat, radiusNm, n = 64) {
  const radiusDeg = radiusNm / 60;
  const cosLat = Math.cos(centerLat * Math.PI / 180);
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    ring.push([
      centerLon + (radiusDeg * Math.sin(a)) / cosLat,
      centerLat +  radiusDeg * Math.cos(a),
    ]);
  }
  return ring;
}

// Peter's operational heuristic from the original Excel: search radius
// expands with the predicted drift distance, but never below 6 NM.
function searchRadiusForDrift(driftNm) {
  return Math.max(6, driftNm / 8 + 6);
}

function drawRun(run) {
  const coords = run.positions.map(p => [p.lon, p.lat]);
  const layerId = `run-${run.id}`;
  const datumCoord = coords[coords.length - 1];

  // ── Search-radius ring around the datum (Peter's heuristic).
  run.searchRadiusNm = searchRadiusForDrift(run.summary.drift_distance_nm);
  const radiusId = `run-${run.id}-radius`;
  map.addSource(radiusId, {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [circleRingCoords(datumCoord[0], datumCoord[1], run.searchRadiusNm)],
      },
    },
  });
  map.addLayer({
    id: radiusId,
    type: 'fill',
    source: radiusId,
    paint: { 'fill-color': run.color, 'fill-opacity': 0.035 },
  });
  map.addLayer({
    id: `${radiusId}-line`,
    type: 'line',
    source: radiusId,
    paint: {
      'line-color': run.color,
      'line-width': 1.1,
      'line-dasharray': [4, 4],
      'line-opacity': 0.32,
    },
  });
  run.radiusLayers = [radiusId, `${radiusId}-line`];

  // Satellites first, so the main track sits visually on top.
  run.satelliteLayers = [];
  (run.satellites || []).forEach((satPositions, idx) => {
    if (!satPositions || satPositions.length < 2) return;
    const satCoords = satPositions.map(p => [p.lon, p.lat]);
    const satId = `run-${run.id}-sat-${idx}`;
    map.addSource(satId, {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: satCoords } },
    });
    map.addLayer({
      id: satId,
      type: 'line',
      source: satId,
      paint: {
        'line-color': run.color,
        'line-width': 1.5,
        'line-opacity': 0.35,
        'line-dasharray': run.isReverse ? [2, 2] : [1],
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
    map.on('mousemove', satId, e => showTrackPopup(e, satPositions, `Run ${run.id} · ${SAT_DIRECTIONS[idx]}`));
    map.on('mouseleave', satId, hideTrackPopup);
    run.satelliteLayers.push(satId);
  });

  // Start the line empty; animate it growing from start to datum.
  map.addSource(layerId, {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords.slice(0, 1) } },
  });

  map.addLayer({
    id: layerId,
    type: 'line',
    source: layerId,
    paint: {
      'line-color': run.color,
      'line-width': 3,
      'line-dasharray': run.isReverse ? [2, 2] : [1],
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });
  map.on('mousemove', layerId, e => showTrackPopup(e, run.positions, `Run ${run.id} · main`));
  map.on('mouseleave', layerId, hideTrackPopup);

  animateLineDraw(layerId, coords, 1500);

  run.markers = [
    makeStartMarker([run.startLon, run.startLat], run.color),
    makeEndMarker(coords[coords.length - 1],      run.color),
  ];
}

// Progressively reveal a line over `durationMs` by appending coordinates.
function animateLineDraw(layerId, fullCoords, durationMs) {
  const start = performance.now();
  function step(now) {
    if (!map.getSource(layerId)) return;   // user removed the run mid-animation
    const t = Math.min(1, (now - start) / durationMs);
    // Ease-out cubic — fast start, slow finish, more "settling" feel.
    const eased = 1 - Math.pow(1 - t, 3);
    const cut = Math.max(2, Math.ceil(eased * fullCoords.length));
    map.getSource(layerId).setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: fullCoords.slice(0, cut) },
    });
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function redrawAllRuns() {
  runs.forEach(run => {
    run.markers?.forEach(m => m.remove());
    drawRun(run);
  });
}

function fitToRun(run) {
  const coords = run.positions.map(p => [p.lon, p.lat]);
  const bounds = coords.reduce(
    (b, c) => b.extend(c),
    new maplibregl.LngLatBounds(coords[0], coords[0])
  );
  bounds.extend([run.startLon, run.startLat]);
  (run.satellites || []).forEach(sat => sat.forEach(p => bounds.extend([p.lon, p.lat])));
  // Search radius is intentionally excluded — at SAR scale it can dwarf the
  // actual drift, so we let the trajectory frame the view and let the radius
  // ring spill off-screen.
  map.fitBounds(bounds, { padding: 80, duration: 800 });
}


// ── Pill rendering
const pillContainer = document.getElementById('resultPills');

function renderPills() {
  pillContainer.innerHTML = '';
  runs.forEach(run => pillContainer.appendChild(buildPill(run)));
}

function buildPill(run) {
  const last = run.positions[run.positions.length - 1];
  const s = run.summary;

  const pill = document.createElement('div');
  pill.className = 'result-pill';
  pill.innerHTML = `
    <div class="pill-dot" style="background:${run.color}"></div>
    <div class="pill-coord">${last.lat.toFixed(5)}°, ${last.lon.toFixed(5)}°</div>
    <div class="pill-stats">
      <span>${s.drift_distance_nm} nm</span>
      <span>${s.drift_bearing_deg}°</span>
    </div>
    <div class="pill-actions">
      <a class="pill-btn" href="${run.gpxUrl}" download="drift-${run.id}.gpx">GPX</a>
      <a class="pill-btn" href="${run.kmlUrl}" download="drift-${run.id}.kml">KML</a>
      <button class="pill-btn remove" aria-label="Remove">×</button>
    </div>
  `;

  pill.addEventListener('click', (e) => {
    if (e.target.closest('.pill-btn')) return;
    fitToRun(run);
  });

  pill.querySelector('.remove').addEventListener('click', (e) => {
    e.stopPropagation();
    removeRun(run.id);
  });

  return pill;
}


// ── Markers
// Start: small hollow disc — "trajectory entry point". Subtle, doesn't compete.
function makeStartMarker(lngLat, color) {
  const el = document.createElement('div');
  el.style.cssText = `
    width: 12px; height: 12px;
    background: #fff;
    border: 2.5px solid ${color};
    border-radius: 50%;
    box-shadow: 0 2px 8px ${color}55;
  `;
  return new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
}

// End (datum): solid disc with a pulsing ring radiating outward. Echoes the
// "live beacon" feel of Find My / emergency locator pings, drawing the eye
// to where SAR managers should act.
function makeEndMarker(lngLat, color) {
  const el = document.createElement('div');
  el.className = 'datum-marker';
  el.style.setProperty('--datum-color', color);
  el.innerHTML = `
    <div class="datum-ring"></div>
    <div class="datum-ring datum-ring--delayed"></div>
    <div class="datum-disc"></div>
  `;
  return new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
}


// ── Testing Accuracy functionality
btnTestAccuracy.addEventListener('click', async () => {
  clearAccuracyError();
  btnTestAccuracy.disabled = true;
  btnTestAccuracy.textContent = 'Testing…';

  try {
    // Get form data
    const isReverse = document.getElementById('inpAccReverse').checked;
    const earlier = inpAccStart.value + ':00';
    const later = inpAccEnd.value + ':00';
    const startTime = isReverse ? later : earlier;
    const endTime = isReverse ? earlier : later;

    // Get GPX file
    const fileInput = document.getElementById('inpGpxFile');
    if (!fileInput.files || !fileInput.files[0]) {
      throw new Error('Please select a GPX file');
    }

    const gpxFile = fileInput.files[0];
    const referenceGpx = await gpxFile.text();

    // Call accuracy API
    const res = await fetch('/api/accuracy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: parseFloat(document.getElementById('inpAccLat').value),
        lon: parseFloat(document.getElementById('inpAccLon').value),
        start_time: startTime,
        end_time: endTime,
        wind_speed: parseFloat(document.getElementById('inpAccWindSpeed').value),
        wind_direction: parseFloat(document.getElementById('inpAccWindDir').value),
        object_id: parseInt(inpAccObject.value, 10),
        is_reverse: isReverse,
        reference_gpx: referenceGpx,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    // Display results
    document.getElementById('resultAccuracy').textContent = `${data.accuracy_pct}%`;
    document.getElementById('resultFinalError').textContent = `${data.final_error_nm} nm`;
    document.getElementById('resultMeanError').textContent = `${data.mean_error_m} m`;
    document.getElementById('resultMaxError').textContent = `${data.max_error_m} m`;
    document.getElementById('resultPairedPoints').textContent = data.paired_points;
    document.getElementById('resultTrackLength').textContent = `${data.ref_track_length_m} m`;

    accuracyResults.classList.remove('hidden');
  } catch (err) {
    showAccuracyError(err.message);
  } finally {
    btnTestAccuracy.disabled = false;
    btnTestAccuracy.textContent = 'Test Accuracy';
  }
});
