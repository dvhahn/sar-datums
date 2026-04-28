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


// ── DOM references
const cardWrap     = document.getElementById('cardWrap');
const cardClose    = document.querySelector('.card-close');
const cardBackdrop = document.querySelector('.card-backdrop');
const objectSelect = document.getElementById('inpObject');
const inpStart     = document.getElementById('inpStart');
const inpEnd       = document.getElementById('inpEnd');
const fab          = document.getElementById('fab');


// ── Default time
const now   = new Date();
const later = new Date(now.getTime() + 3 * 60 * 60 * 1000);
inpStart.value = toLocalDatetime(now);
inpEnd.value   = toLocalDatetime(later);

function toLocalDatetime(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


// ── Load search objects
async function loadObjects() {
  try {
    const res = await fetch('/api/objects');
    const list = await res.json();
    objectSelect.innerHTML = list
      .map(o => `<option value="${o.id}">${o.name}</option>`)
      .join('');
  } catch {
    objectSelect.innerHTML = '<option>Failed to load</option>';
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
const inpReverse        = document.getElementById('inpReverse');
const inpMultipleTracks = document.getElementById('inpMultipleTracks');
const inpRadius         = document.getElementById('inpRadius');
const radiusSection     = document.getElementById('radiusSection');
const formError         = document.getElementById('formError');

inpMultipleTracks.addEventListener('change', () => {
  radiusSection.classList.toggle('hidden', !inpMultipleTracks.checked);
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

function showError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function clearError() {
  formError.classList.add('hidden');
}

document.querySelectorAll('.card-form input, .card-form select')
  .forEach(el => el.addEventListener('input', clearError));


btnCalculate.addEventListener('click', async () => {
  clearError();
  btnCalculate.disabled = true;
  btnCalculate.textContent = 'Calculating…';

  try {
    // Backend expects start_time > end_time when reverse is on.
    // Keep the form natural (earlier → later) and swap here.
    const isReverse = inpReverse.checked;
    const earlier = inpStart.value + ':00';
    const later   = inpEnd.value + ':00';
    const startTime = isReverse ? later   : earlier;
    const endTime   = isReverse ? earlier : later;

    const res = await fetch('/api/drift', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat:              parseFloat(inpLat.value),
        lon:              parseFloat(inpLon.value),
        start_time:       startTime,
        end_time:         endTime,
        wind_speed:       parseFloat(inpWindSpeed.value),
        wind_direction:   parseFloat(inpWindDir.value),
        object_id:        parseInt(objectSelect.value, 10),
        is_reverse:       isReverse,
        multiple_tracks:  inpMultipleTracks.checked,
        radius_nm:        parseFloat(inpRadius.value),
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
      isReverse: inpReverse.checked,
      startLat: parseFloat(inpLat.value),
      startLon: parseFloat(inpLon.value),
      gpxUrl: makeBlobUrl(gpxText, 'application/gpx+xml'),
      kmlUrl: makeBlobUrl(kmlText, 'application/vnd.google-earth.kml+xml'),
    });

    closeCard();
  } catch (err) {
    showError(err.message);
  } finally {
    btnCalculate.disabled = false;
    btnCalculate.textContent = 'Calculate Datum';
  }
});


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

function drawRun(run) {
  const coords = run.positions.map(p => [p.lon, p.lat]);
  const layerId = `run-${run.id}`;

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

  map.addSource(layerId, {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } },
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

  run.markers = [
    makeMarker([run.startLon, run.startLat], run.color, 'start'),
    makeMarker(coords[coords.length - 1],    run.color, 'end'),
  ];
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
function makeMarker(lngLat, color, kind) {
  const el = document.createElement('div');
  const size = kind === 'end' ? 14 : 12;
  el.style.cssText = `
    width: ${size}px; height: ${size}px;
    background: ${color};
    border: 2.5px solid #fff;
    border-radius: 50%;
    box-shadow: 0 2px 10px ${color}66;
  `;
  return new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
}
