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


// ── FAB: click = open card, drag = pin drop then open card with coords
const dragCoord = document.getElementById('dragCoord');
const DRAG_THRESHOLD = 6;

let dragging = false;
let dragMoved = false;
let dragStartX = 0;
let dragStartY = 0;

fab.addEventListener('pointerdown', (e) => {
  dragging = true;
  dragMoved = false;
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
    fab.classList.add('dragging');
    dragCoord.classList.add('visible');
  }

  if (dragMoved) {
    fab.style.left   = (e.clientX - 26) + 'px';
    fab.style.top    = (e.clientY - 26) + 'px';
    fab.style.right  = 'auto';
    fab.style.bottom = 'auto';

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

  if (dragMoved) {
    const lngLat = map.unproject([e.clientX, e.clientY]);
    inpLat.value = lngLat.lat.toFixed(5);
    inpLon.value = lngLat.lng.toFixed(5);
  }

  // Reset FAB visuals back to bottom-right
  fab.classList.remove('dragging');
  dragCoord.classList.remove('visible');
  fab.style.left   = '';
  fab.style.top    = '';
  fab.style.right  = '';
  fab.style.bottom = '';

  openCard();
});


// ── Calculate
const btnCalculate = document.getElementById('btnCalculate');
const inpLat       = document.getElementById('inpLat');
const inpLon       = document.getElementById('inpLon');
const inpWindSpeed = document.getElementById('inpWindSpeed');
const inpWindDir   = document.getElementById('inpWindDir');
const inpReverse   = document.getElementById('inpReverse');
const formError    = document.getElementById('formError');

const RUN_COLORS = ['#0a84ff', '#ff9f0a', '#bf5af2', '#30d158', '#ff453a', '#64d2ff', '#ffd60a', '#ff375f'];
let runs = [];
let runCounter = 0;

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
        lat:            parseFloat(inpLat.value),
        lon:            parseFloat(inpLon.value),
        start_time:     startTime,
        end_time:       endTime,
        wind_speed:     parseFloat(inpWindSpeed.value),
        wind_direction: parseFloat(inpWindDir.value),
        object_id:      parseInt(objectSelect.value, 10),
        is_reverse:     isReverse,
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
