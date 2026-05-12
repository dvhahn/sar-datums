// ── Map style — Esri's World Ocean Basemap (bathymetric chart with depth
// contours and seafloor place names) plus the matching Reference layer
// (labels). Free for dev use, no API key. Renders as a true nautical
// chart, far more SAR-appropriate than a city basemap.
//
// Esri Ocean tiles only go to z13; clamp here so MapLibre overzooms the
// final level instead of fetching missing tiles and rendering a "no data"
// placeholder.
//
// We dropped the original light/dark theme toggle: Esri Ocean has no dark
// variant, and the only sensible fallback (Carto Dark Matter) made the two
// modes feel like different products. The toggle slot now controls
// seamark visibility instead — see seamarksToggle below.
const ESRI_OCEAN_MAX_Z = 13;
const MAP_STYLE = {
  version: 8,
  sources: {
    'esri-ocean-base': {
      type: 'raster',
      tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: ESRI_OCEAN_MAX_Z,
      attribution: 'Tiles © Esri — GEBCO, NOAA, NGS et al.',
    },
    'esri-ocean-reference': {
      type: 'raster',
      tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: ESRI_OCEAN_MAX_Z,
    },
  },
  layers: [
    { id: 'esri-ocean-base',      type: 'raster', source: 'esri-ocean-base' },
    { id: 'esri-ocean-reference', type: 'raster', source: 'esri-ocean-reference' },
  ],
};

const map = new maplibregl.Map({
  container: 'map',
  style: MAP_STYLE,
  center: [174.85, -36.82],
  zoom: 11.5,
  minZoom: 3,         // any further out and Esri returns text errors at world edges
  maxZoom: 17,        // overzoom past Esri's z13 cap (tiles get soft, but no missing-data placeholder)
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


// ── OpenSeaMap seamark overlay (lighthouses, buoys, channels, hazards).
// Sits on top of whichever base style is active so the chart-style icons
// stay visible across light/dark themes.
function ensureSeamarks() {
  if (map.getSource('seamarks')) return;
  map.addSource('seamarks', {
    type: 'raster',
    tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
    tileSize: 256,
    minzoom: 6,        // marks are visual clutter at world view; only show once you're zoomed in to coast level
    maxzoom: 18,
    attribution: '© OpenSeaMap contributors',
  });
  map.addLayer({
    id: 'seamarks',
    type: 'raster',
    source: 'seamarks',
    paint: { 'raster-opacity': 0.85 },
  });
}
map.on('load', ensureSeamarks);
map.on('style.load', ensureSeamarks);


// ── Seamarks toggle (replaces the original light/dark theme toggle — Esri
// Ocean has no dark variant, so we repurposed the slot for something
// SAR-actually-relevant: show/hide the OpenSeaMap overlay on demand).
const seamarksToggle = document.getElementById('seamarksToggle');
let seamarksOn = localStorage.getItem('seamarks') !== 'off';   // default ON
applySeamarkVisibility();
if (seamarksOn) seamarksToggle.classList.add('active');

seamarksToggle.addEventListener('click', () => {
  seamarksOn = !seamarksOn;
  seamarksToggle.classList.toggle('active', seamarksOn);
  localStorage.setItem('seamarks', seamarksOn ? 'on' : 'off');
  applySeamarkVisibility();
});

function applySeamarkVisibility() {
  if (!map.getLayer('seamarks')) return;   // layer may not have loaded yet
  map.setLayoutProperty('seamarks', 'visibility', seamarksOn ? 'visible' : 'none');
}
// Re-apply after the map (re-)loads style — keeps the user's choice across
// any future style swaps and the initial load race.
map.on('load',       applySeamarkVisibility);
map.on('style.load', applySeamarkVisibility);


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

// ── Object picker (hierarchical)
const btnSelectObject = document.getElementById('btnSelectObject');
const btnChangeObject = document.getElementById('btnChangeObject');
const objectPicker = document.getElementById('objectPicker');
const selectedObjectNameSpan = document.getElementById('selectedObjectName');
const selectedObjectIdInput = document.getElementById('selectedObjectId');
const objectSelectionDiv = document.getElementById('object-selection');

let fullTree = [];
let currentPath = [];
let currentNode = null;

// Fetch the full object hierarchy from the backend and reset picker state to root. On error, show a message in the picker.
async function loadPicker() {
  try {
    const res = await fetch('/api/object-hierarchy');
    if (!res.ok) throw new Error();
    fullTree = await res.json();
    currentPath = [];
    currentNode = null;
    renderCurrentLevel();
  } catch (err) {
    console.error('Failed to load object hierarchy', err);
    document.getElementById('pickerLevel').innerHTML = '<div class="error">Failed to load object types</div>';
  }
}

// Render the current level of the hierarchy as buttons. If currentNode is null, we're at the root and show top-level categories. Otherwise show currentNode's children. Also update the path display and back button visibility.
function renderCurrentLevel() {
  const levelDiv = document.getElementById('pickerLevel');
  const backBtn = document.getElementById('pickerBack');
  const pathSpan = document.getElementById('pickerPath');
  let items = [];
  if (currentNode === null) {
    items = fullTree;
    pathSpan.textContent = 'Select category';
  } else {
    items = currentNode.children || [];
    const names = currentPath.map(node => node.name).join(' → ');
    pathSpan.textContent = names;
  }
  levelDiv.innerHTML = '';
  items.forEach(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.name;
    btn.dataset.id = item.id;
    btn.addEventListener('click', () => {
      if (item.children && item.children.length > 0) {
        currentPath.push(item);
        currentNode = item;
        renderCurrentLevel();
      } else {
        selectedObjectIdInput.value = item.id;
        selectedObjectNameSpan.textContent = item.name;
        selectedObjectNameSpan.classList.remove('hidden');
        btnChangeObject.classList.remove('hidden');
        btnSelectObject.classList.add('hidden');
        objectPicker.classList.add('hidden');
        objectSelectionDiv.classList.remove('hidden');
      }
    });
    levelDiv.appendChild(btn);
  });
  if (currentPath.length === 0) {
    backBtn.classList.add('hidden');
  } else {
    backBtn.classList.remove('hidden');
  }
}

// Go back up one level in the hierarchy. If we're at the root, do nothing.
function goBack() {
  if (currentPath.length === 0) return;
  currentPath.pop();
  currentNode = currentPath.length === 0 ? null : currentPath[currentPath.length - 1];
  renderCurrentLevel();
}

document.getElementById('pickerBack').addEventListener('click', goBack);

// Open the object picker. If we haven't loaded the hierarchy yet, fetch it. Otherwise just reset to the root level.
btnSelectObject.addEventListener('click', () => {
  objectSelectionDiv.classList.add('hidden');
  objectPicker.classList.remove('hidden');
  if (fullTree.length === 0) loadPicker();
  else {
    currentPath = [];
    currentNode = null;
    renderCurrentLevel();
  }
});

// Change object: clear selection and go back to root of picker.
btnChangeObject.addEventListener('click', () => {
  selectedObjectIdInput.value = '';
  selectedObjectNameSpan.textContent = '';
  selectedObjectNameSpan.classList.add('hidden');
  btnChangeObject.classList.add('hidden');
  btnSelectObject.classList.remove('hidden');
  objectSelectionDiv.classList.remove('hidden');
  currentPath = [];
  currentNode = null;
  if (fullTree.length) renderCurrentLevel();
});


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
const chkDivergence     = document.getElementById('chkDivergence');

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

document.querySelectorAll('.card-form input, .card-form select')
  .forEach(el => el.addEventListener('input', clearError));


// Front-end form validation. Returns null if valid, otherwise a user-facing
// message naming the first missing field. Catching these here keeps the
// browser network log clean — without it, missing inputs would fire a POST
// that the backend rejects with 400, which the devtools console then shows
// in red regardless of how we handle the response.
function validateDriftForm() {
  if (!inpLat.value || !inpLon.value) return 'Enter a start position (lat / lon).';
  if (!inpStart.value)                 return 'Pick a start time.';
  if (!inpEnd.value)                   return 'Pick an end time.';
  if (inpStart.value === inpEnd.value) return 'Start and end times must differ.';
  if (!inpWindSpeed.value || inpWindDir.value === '') return 'Enter wind speed and direction.';
  if (!selectedObjectIdInput.value)    return 'Select an object type before calculating.';
  return null;
}

btnCalculate.addEventListener('click', async () => {
  clearError();

  const validationError = validateDriftForm();
  if (validationError) {
    showError(validationError);
    return;   // request never goes out, console stays clean
  }

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
        object_id:        parseInt(selectedObjectIdInput.value, 10),
        is_reverse:       isReverse,
        multiple_tracks:  inpMultipleTracks.checked,
        radius_nm:        parseFloat(inpRadius.value),
        wind_divergence:   chkDivergence.checked,
        divergence_angle: 30,
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
    posDivPositions: data.pos_div_positions || null,
    negDivPositions: data.neg_div_positions || null,
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
  removePatternForRun(run);
  if (run.posDivLayerId) {
    if (map.getLayer(run.posDivLayerId)) map.removeLayer(run.posDivLayerId);
    if (map.getSource(run.posDivLayerId)) map.removeSource(run.posDivLayerId);
  }
  if (run.negDivLayerId) {
    if (map.getLayer(run.negDivLayerId)) map.removeLayer(run.negDivLayerId);
    if (map.getSource(run.negDivLayerId)) map.removeSource(run.negDivLayerId);
  }
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

  // Draw positive divergence track (if exists)
  if (run.posDivPositions && run.posDivPositions.length) {
    const posCoords = run.posDivPositions.map(p => [p.lon, p.lat]);
    const posLayerId = `run-${run.id}-posdiv`;
    map.addSource(posLayerId, {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: posCoords } },
    });
    map.addLayer({
      id: posLayerId,
      type: 'line',
      source: posLayerId,
      paint: {
        'line-color': '#ff9f0a',   // orange
        'line-width': 2.5,
        'line-dasharray': [6, 4],
        'line-opacity': 0.7,
      },
    });
    // Show popup on positive divergence track hover, just like the main track.
    map.on('mousemove', posLayerId, e => showTrackPopup(e, run.posDivPositions, `Run ${run.id} · +div`));
    map.on('mouseleave', posLayerId, hideTrackPopup);
    // store layer id for cleanup later
    run.posDivLayerId = posLayerId;
  }

  // Draw negative divergence track (if exists)
  if (run.negDivPositions && run.negDivPositions.length) {
    const negCoords = run.negDivPositions.map(p => [p.lon, p.lat]);
    const negLayerId = `run-${run.id}-negdiv`;
    map.addSource(negLayerId, {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: negCoords } },
    });
    map.addLayer({
      id: negLayerId,
      type: 'line',
      source: negLayerId,
      paint: {
        'line-color': '#ff453a',   // red
        'line-width': 2.5,
        'line-dasharray': [6, 4],
        'line-opacity': 0.7,
      },
    });
    map.on('mousemove', negLayerId, e => showTrackPopup(e, run.negDivPositions, `Run ${run.id} · -div`));
    map.on('mouseleave', negLayerId, hideTrackPopup);
    run.negDivLayerId = negLayerId;
  }

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
      <button class="pill-btn pattern" aria-label="Search pattern">Pattern</button>
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

  pill.querySelector('.pattern').addEventListener('click', (e) => {
    e.stopPropagation();
    openPatternCard(run);
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


// ── Search-pattern dialog (opens from a result-pill's "Pattern" button)

const patternCardWrap   = document.getElementById('patternCardWrap');
const patType           = document.getElementById('patType');
const patLat            = document.getElementById('patLat');
const patLon            = document.getElementById('patLon');
const patDir            = document.getElementById('patDir');
const patWidth          = document.getElementById('patWidth');
const patLength         = document.getElementById('patLength');
const patRadius         = document.getElementById('patRadius');
const patSectorAngle    = document.getElementById('patSectorAngle');
const patSweep          = document.getElementById('patSweep');
const patError          = document.getElementById('patError');
const btnGeneratePattern = document.getElementById('btnGeneratePattern');

const patDirSection     = document.getElementById('patDirSection');
const patBoxSection     = document.getElementById('patBoxSection');
const patRadiusSection  = document.getElementById('patRadiusSection');
const patSectorSection  = document.getElementById('patSectorSection');

// Search-pattern lines render in a contrasting hue from the drift track so
// the two layers read as distinct concepts.
const PATTERN_COLOR = '#0066FF';

let activePatternRunId = null;  // which run the dialog is generating for

function openPatternCard(run) {
  activePatternRunId = run.id;
  const last = run.positions[run.positions.length - 1];
  patLat.value = last.lat.toFixed(6);
  patLon.value = last.lon.toFixed(6);

  // Pre-fill direction with the drift bearing (Peter's heuristic in VBA).
  const bearing = run.summary?.drift_bearing_deg;
  if (typeof bearing === 'number' && Number.isFinite(bearing)) {
    patDir.value = Math.round(bearing);
  }

  // Pre-fill radius using Peter's drift-scaled rule.
  const driftNm = run.summary?.drift_distance_nm ?? 0;
  patRadius.value = searchRadiusForDrift(driftNm).toFixed(1);

  patError.classList.add('hidden');
  patError.textContent = '';
  syncPatternFields();

  patternCardWrap.classList.remove('hidden');
}

function closePatternCard() {
  patternCardWrap.classList.add('hidden');
  activePatternRunId = null;
}

// Show/hide conditional sections based on the chosen pattern type. Mirrors
// the VBA Pattern.frm Radi() routine.
function syncPatternFields() {
  const t = patType.value;
  const hasDirection = t === 'creeping_line' || t === 'expanding_square' || t === 'sector';
  const hasBox       = t === 'creeping_line' || t === 'expanding_square' || t === 'circle';
  const hasRadius    = t === 'sector';
  const hasSector    = t === 'sector';

  patDirSection.classList.toggle('hidden',    !hasDirection);
  patBoxSection.classList.toggle('hidden',    !hasBox);
  patRadiusSection.classList.toggle('hidden', !hasRadius);
  patSectorSection.classList.toggle('hidden', !hasSector);
}

patType.addEventListener('change', syncPatternFields);

document.querySelectorAll('[data-close="pattern"]').forEach(el => {
  el.addEventListener('click', closePatternCard);
});

btnGeneratePattern.addEventListener('click', async () => {
  patError.classList.add('hidden');
  btnGeneratePattern.disabled = true;
  btnGeneratePattern.textContent = 'Generating…';

  try {
    const body = {
      type: patType.value,
      datum_lat: parseFloat(patLat.value),
      datum_lon: parseFloat(patLon.value),
      sweep_width_nm: parseFloat(patSweep.value),
    };
    if (patType.value !== 'circle') body.search_direction_deg = parseFloat(patDir.value);
    if (patType.value === 'creeping_line' || patType.value === 'expanding_square' || patType.value === 'circle') {
      body.search_width_nm = parseFloat(patWidth.value);
      body.track_length_nm = parseFloat(patLength.value);
    }
    if (patType.value === 'sector') {
      body.radius_nm = parseFloat(patRadius.value);
      body.sector_angle_deg = parseFloat(patSectorAngle.value);
    }

    const res = await fetch('/api/search-pattern', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    const run = runs.find(r => r.id === activePatternRunId);
    if (run) drawPatternForRun(run, data.lines);

    closePatternCard();
  } catch (err) {
    patError.textContent = err.message;
    patError.classList.remove('hidden');
  } finally {
    btnGeneratePattern.disabled = false;
    btnGeneratePattern.textContent = 'Generate Pattern';
  }
});

// Draws the pattern as a dashed line layer on top of the drift track. Stored
// against the run so removeRun() can clean it up.
function drawPatternForRun(run, lines) {
  removePatternForRun(run);

  const sourceId = `run-${run.id}-pattern`;
  const layerId  = sourceId;

  const features = lines
    .filter(line => line && line.length >= 2)
    .map(line => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: line.map(p => [p.lon, p.lat]),
      },
    }));

  if (features.length === 0) return;

  map.addSource(sourceId, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features },
  });
  map.addLayer({
    id: layerId,
    type: 'line',
    source: sourceId,
    paint: {
      'line-color': PATTERN_COLOR,
      'line-width': 2,
      'line-dasharray': [3, 2],
      'line-opacity': 0.85,
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });

  run.patternLayers = [layerId];
  run.patternSources = [sourceId];
}

function removePatternForRun(run) {
  run.patternLayers?.forEach(id => { if (map.getLayer(id))  map.removeLayer(id); });
  run.patternSources?.forEach(id => { if (map.getSource(id)) map.removeSource(id); });
  run.patternLayers = [];
  run.patternSources = [];
}


// Preload the CSV-driven object hierarchy so the picker has data when it opens.
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/object-hierarchy');
    if (res.ok) fullTree = await res.json();
  } catch (e) { console.error('Preload hierarchy failed', e); }
});
