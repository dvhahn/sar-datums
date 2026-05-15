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
// ScaleControl on bottom-right stacks above the (compact) attribution and
// avoids colliding with the top-bar toggles when the viewport narrows.
map.addControl(new maplibregl.ScaleControl({ unit: 'nautical', maxWidth: 120 }), 'bottom-right');


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

// Helper to send a drift request and return data
async function fetchDrift(startTime, endTime) {
  const res = await fetch('/api/drift', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat: parseFloat(inpLat.value),
      lon: parseFloat(inpLon.value),
      start_time: startTime,
      end_time: endTime,
      wind_speed: parseFloat(inpWindSpeed.value),
      wind_direction: parseFloat(inpWindDir.value),
      object_id: parseInt(selectedObjectIdInput.value, 10),
      is_reverse: inpReverse.checked,
      multiple_tracks: inpMultipleTracks.checked,
      radius_nm: parseFloat(inpRadius.value),
      wind_divergence: chkDivergence.checked,
      divergence_angle: 30,
    }),
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Request failed');
  return res.json();
}

const datetimeInputs = ['inpStart', 'inpEnd', 'inpEarliestLKP', 'inpLatestLKP'];
datetimeInputs.forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();
    });
  }
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


// ── Accuracy dialog
const accuracyToggle   = document.getElementById('accuracyToggle');
const accuracyCardWrap = document.getElementById('accuracyCardWrap');
const inpAccObject     = document.getElementById('inpAccObject');
const inpAccStart      = document.getElementById('inpAccStart');
const inpAccEnd        = document.getElementById('inpAccEnd');
const btnTestAccuracy  = document.getElementById('btnTestAccuracy');
const accuracyResults  = document.getElementById('accuracyResults');
const accuracyFormError = document.getElementById('accuracyFormError');

inpAccStart.value = toLocalDatetime(now);
inpAccEnd.value   = toLocalDatetime(later);

async function loadAccuracyObjects() {
  try {
    const res = await fetch('/api/objects');
    const list = await res.json();
    inpAccObject.innerHTML = list
      .map(o => `<option value="${o.id}">${o.name}</option>`)
      .join('');
  } catch {
    inpAccObject.innerHTML = '<option>Failed to load</option>';
  }
}
loadAccuracyObjects();

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

function showAccuracyError(msg) {
  accuracyFormError.textContent = msg;
  accuracyFormError.classList.remove('hidden');
}

function clearAccuracyError() {
  accuracyFormError.classList.add('hidden');
}

accuracyToggle.addEventListener('click', openAccuracyCard);
accuracyCardWrap.querySelector('.card-close').addEventListener('click', closeAccuracyCard);
accuracyCardWrap.querySelector('.card-backdrop').addEventListener('click', closeAccuracyCard);

btnTestAccuracy.addEventListener('click', async () => {
  clearAccuracyError();
  btnTestAccuracy.disabled = true;
  btnTestAccuracy.textContent = 'Testing…';

  try {
    const isReverse = document.getElementById('inpAccReverse').checked;
    const earlier = inpAccStart.value + ':00';
    const later   = inpAccEnd.value + ':00';
    const startTime = isReverse ? later : earlier;
    const endTime   = isReverse ? earlier : later;

    const fileInput = document.getElementById('inpGpxFile');
    if (!fileInput.files || !fileInput.files[0]) {
      throw new Error('Please select a GPX file');
    }

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    formData.append('lat',            document.getElementById('inpAccLat').value);
    formData.append('lon',            document.getElementById('inpAccLon').value);
    formData.append('start_time',     startTime);
    formData.append('end_time',       endTime);
    formData.append('wind_speed',     document.getElementById('inpAccWindSpeed').value);
    formData.append('wind_direction', document.getElementById('inpAccWindDir').value);
    formData.append('object_id',      inpAccObject.value);

    const res = await fetch('/api/accuracy', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    document.getElementById('resultAccuracy').textContent    = `${data.accuracy_pct}%`;
    document.getElementById('resultFinalError').textContent  = `${data.final_error_nm} nm`;
    document.getElementById('resultMeanError').textContent   = `${data.mean_error_m} m`;
    document.getElementById('resultMaxError').textContent    = `${data.max_error_m} m`;
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
const btnGetWind        = document.getElementById('btnGetWind');

inpMultipleTracks.addEventListener('change', () => {
  radiusSection.classList.toggle('hidden', !inpMultipleTracks.checked);
});

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
// Hue-family pairs for time-uncertainty runs: [earliest (saturated), latest (lighter)].
// Same-hue pairing makes the two tracks read as bounds of one uncertainty zone
// instead of unrelated runs; cycling the hue family separates multiple pairs.
const UNCERTAINTY_PALETTE = [
  ['#0a84ff', '#64d2ff'],  // blue family
  ['#bf5af2', '#da8fff'],  // purple family
  ['#30d158', '#7be88e'],  // green family
  ['#ff9500', '#ffc66e'],  // orange family
  ['#ff375f', '#ff8a99'],  // pink family
];
const SAT_DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
let runs = [];
let runCounter = 0;
let uncertaintyPairCount = 0;

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
    const isReverse = inpReverse.checked;
    const meta = {
        isReverse: isReverse,
        startLat: parseFloat(inpLat.value),
        startLon: parseFloat(inpLon.value),
    };


    if (chkTimeUncertain.checked) {
      const earliestLKP = document.getElementById('inpEarliestLKP').value;
      const latestLKP   = document.getElementById('inpLatestLKP').value;
      const arrival     = inpEnd.value;
      if (!earliestLKP || !latestLKP || !arrival) throw new Error('Please fill in all time fields');

      // Sequential — backend stores last GPX/KML in app.config (single slot),
      // so parallel runs race and both clients would read the second one.
      const labels = [
        { value: earliestLKP, role: 'earliest' },
        { value: latestLKP,   role: 'latest'   },
      ];
      const results = [];
      for (const { value, role } of labels) {
        let startTime = value + ':00';
        let endTime   = arrival + ':00';
        if (isReverse) {
          [startTime, endTime] = [endTime, startTime];
        }
        const data = await fetchDrift(startTime, endTime);
        const [gpxText, kmlText] = await Promise.all([
          fetch('/api/gpx').then(r => r.text()),
          fetch('/api/kml').then(r => r.text()),
        ]);
        results.push({ role, data, gpxText, kmlText, time: value });
      }

      // One GPX/KML with both tracks named so chart plotters distinguish them.
      const combinedGpx = combineGpxTexts(results[0].gpxText, results[1].gpxText);
      const combinedKml = combineKmlTexts(results[0].kmlText, results[1].kmlText);
      const gpxUrl = makeBlobUrl(combinedGpx, 'application/gpx+xml');
      const kmlUrl = makeBlobUrl(combinedKml, 'application/vnd.google-earth.kml+xml');

      addUncertaintyPair(results[0], results[1], { ...meta, gpxUrl, kmlUrl });
    } else {
      // Normal single-run mode
        const earlier = inpStart.value + ':00';
        const later = inpEnd.value + ':00';
        const startTime = isReverse ? later : earlier;
        const endTime = isReverse ? earlier : later;
        const data = await fetchDrift(startTime, endTime);
        const [gpxText, kmlText] = await Promise.all([
            fetch('/api/gpx').then(r => r.text()),
            fetch('/api/kml').then(r => r.text()),
        ]);
        const gpxUrl = makeBlobUrl(gpxText, 'application/gpx+xml');
        const kmlUrl = makeBlobUrl(kmlText, 'application/vnd.google-earth.kml+xml');
        addRun(data, { ...meta, gpxUrl, kmlUrl });
    }
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

// Pull <trk>…</trk> blocks from each GPX, rename them for clarity, and wrap
// the lot in a single <gpx> envelope so chart plotters see one file with two
// distinct routes (matches Peter's VBA "(first)"/"(second)" output).
function combineGpxTexts(earliestText, latestText) {
  const trkRegex = /<trk>[\s\S]*?<\/trk>/g;
  const labelTrk = (block, suffix) =>
    block.replace(/<name>([^<]*)<\/name>/, `<name>$1 (${suffix})</name>`);
  const earliestTrks = (earliestText.match(trkRegex) || []).map(t => labelTrk(t, 'earliest'));
  const latestTrks   = (latestText.match(trkRegex)   || []).map(t => labelTrk(t, 'latest'));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Drift Simulator" xmlns="http://www.topografix.com/GPX/1/1">',
    ...earliestTrks,
    ...latestTrks,
    '</gpx>',
  ].join('\n');
}

function combineKmlTexts(earliestText, latestText) {
  const styleRegex     = /<Style[\s\S]*?<\/Style>/g;
  const placemarkRegex = /<Placemark>[\s\S]*?<\/Placemark>/g;
  const labelPm = (block, suffix) =>
    block.replace(/<name>([^<]*)<\/name>/, `<name>$1 (${suffix})</name>`);
  const styles       = earliestText.match(styleRegex) || [];
  const earliestPms  = (earliestText.match(placemarkRegex) || []).map(p => labelPm(p, 'earliest'));
  const latestPms    = (latestText.match(placemarkRegex)   || []).map(p => labelPm(p, 'latest'));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">',
    '  <Document>',
    '    <name>SAR Drift Prediction (Time Uncertain)</name>',
    '    <description>Earliest and latest LKP drift tracks</description>',
    ...styles,
    ...earliestPms,
    ...latestPms,
    '  </Document>',
    '</kml>',
  ].join('\n');
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

// Earliest + Latest LKP collapsed into one pair. Two child runs share a parent
// id, render as a single pill, get one combined GPX/KML download, and are
// joined by a translucent shade polygon between their trajectories.
function addUncertaintyPair(earliestResult, latestResult, meta) {
  runCounter++;
  uncertaintyPairCount++;
  const pairId = runCounter;
  const [earliestColor, latestColor] =
    UNCERTAINTY_PALETTE[(uncertaintyPairCount - 1) % UNCERTAINTY_PALETTE.length];

  const makeChild = (result, color) => ({
    id: `${pairId}-${result.role}`,
    color,
    positions: result.data.positions,
    satellites: result.data.satellites || [],
    posDivPositions: result.data.pos_div_positions || null,
    negDivPositions: result.data.neg_div_positions || null,
    summary: result.data.summary,
    role: result.role,
    parentId: pairId,
    isReverse: meta.isReverse,
    startLat: meta.startLat,
    startLon: meta.startLon,
  });

  const earliest = makeChild(earliestResult, earliestColor);
  const latest   = makeChild(latestResult,   latestColor);

  // Shade first so the line layers paint over it.
  drawUncertaintyShade(pairId, earliest.positions, latest.positions, earliestColor);
  drawRun(earliest);
  drawRun(latest);

  const pair = {
    id: pairId,
    isUncertaintyPair: true,
    earliest,
    latest,
    earliestTime: earliestResult.time,
    latestTime: latestResult.time,
    gpxUrl: meta.gpxUrl,
    kmlUrl: meta.kmlUrl,
    startLat: meta.startLat,
    startLon: meta.startLon,
    shadeLayerId: `shade-${pairId}`,
  };
  runs.push(pair);
  renderPills();
  fitToRun(pair);
}

// Translucent fill bounded by earliest path forward + latest path reversed.
// Tracks can self-intersect (eddies, opposing tides) — MapLibre still renders
// it usefully, just with an even-odd ring fill near the crossing.
function drawUncertaintyShade(pairId, earliestPositions, latestPositions, color) {
  if (!earliestPositions?.length || !latestPositions?.length) return;
  const ring = [
    ...earliestPositions.map(p => [p.lon, p.lat]),
    ...latestPositions.slice().reverse().map(p => [p.lon, p.lat]),
  ];
  // Close the ring explicitly to keep MapLibre happy.
  ring.push(ring[0]);

  const sourceId = `shade-${pairId}`;
  map.addSource(sourceId, {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
    },
  });
  map.addLayer({
    id: sourceId,
    type: 'fill',
    source: sourceId,
    paint: {
      'fill-color': color,
      'fill-opacity': 0.12,
      'fill-antialias': true,
    },
  });
}

function removeRun(id) {
  const run = runs.find(r => r.id === id);
  if (!run) return;

  if (run.isUncertaintyPair) {
    removeChildLayers(run.earliest);
    removeChildLayers(run.latest);
    if (map.getLayer(run.shadeLayerId))  map.removeLayer(run.shadeLayerId);
    if (map.getSource(run.shadeLayerId)) map.removeSource(run.shadeLayerId);
    // Pattern (if any) is attached to the earliest child since the pill
    // pattern button opens the dialog targeting pair.earliest.
    removePatternForRun(run.earliest);
    URL.revokeObjectURL(run.gpxUrl);
    URL.revokeObjectURL(run.kmlUrl);
  } else {
    removeChildLayers(run);
    removePatternForRun(run);
    URL.revokeObjectURL(run.gpxUrl);
    URL.revokeObjectURL(run.kmlUrl);
  }

  runs = runs.filter(r => r.id !== id);
  renderPills();

  if (runs.length === 0) openCard();
}

// Tear down everything drawRun added for a single run object. Used directly
// for normal runs and twice (per child) for an uncertainty pair.
function removeChildLayers(run) {
  const layerId = `run-${run.id}`;
  if (map.getLayer(layerId))  map.removeLayer(layerId);
  if (map.getSource(layerId)) map.removeSource(layerId);
  run.radiusLayers?.forEach(rid => {
    if (map.getLayer(rid)) map.removeLayer(rid);
  });
  const radiusSourceId = `run-${run.id}-radius`;
  if (map.getSource(radiusSourceId)) map.removeSource(radiusSourceId);
  run.satelliteLayers?.forEach(satId => {
    if (map.getLayer(satId))  map.removeLayer(satId);
    if (map.getSource(satId)) map.removeSource(satId);
  });
  if (run.posDivLayerId) {
    if (map.getLayer(run.posDivLayerId)) map.removeLayer(run.posDivLayerId);
    if (map.getSource(run.posDivLayerId)) map.removeSource(run.posDivLayerId);
  }
  if (run.negDivLayerId) {
    if (map.getLayer(run.negDivLayerId)) map.removeLayer(run.negDivLayerId);
    if (map.getSource(run.negDivLayerId)) map.removeSource(run.negDivLayerId);
  }
  run.markers?.forEach(m => m.remove());
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
        'line-color': '#a0a0a0',   // gray
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
        'line-color': '#606060',   // darker gray
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
    if (run.isUncertaintyPair) {
      run.earliest.markers?.forEach(m => m.remove());
      run.latest.markers?.forEach(m => m.remove());
      drawUncertaintyShade(run.id, run.earliest.positions, run.latest.positions, run.earliest.color);
      drawRun(run.earliest);
      drawRun(run.latest);
    } else {
      run.markers?.forEach(m => m.remove());
      drawRun(run);
    }
  });
}

function fitToRun(run) {
  const positionsList = run.isUncertaintyPair
    ? [...run.earliest.positions, ...run.latest.positions]
    : run.positions;
  const coords = positionsList.map(p => [p.lon, p.lat]);
  const bounds = coords.reduce(
    (b, c) => b.extend(c),
    new maplibregl.LngLatBounds(coords[0], coords[0])
  );
  bounds.extend([run.startLon, run.startLat]);
  if (run.isUncertaintyPair) {
    (run.earliest.satellites || []).forEach(sat => sat.forEach(p => bounds.extend([p.lon, p.lat])));
    (run.latest.satellites   || []).forEach(sat => sat.forEach(p => bounds.extend([p.lon, p.lat])));
  } else {
    (run.satellites || []).forEach(sat => sat.forEach(p => bounds.extend([p.lon, p.lat])));
  }
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
  if (run.isUncertaintyPair) return buildUncertaintyPill(run);

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

// Stacked dual-row pill: header tag + two coord rows (earliest, latest) +
// one set of action buttons. Pattern button targets the earliest child since
// that's the "longer drift" end-point a search manager would centre on.
function buildUncertaintyPill(pair) {
  const eLast = pair.earliest.positions[pair.earliest.positions.length - 1];
  const lLast = pair.latest.positions[pair.latest.positions.length - 1];
  const eS = pair.earliest.summary;
  const lS = pair.latest.summary;
  const row = (color, last, summary, role) => `
    <div class="pill-uncertain-row">
      <div class="pill-dot" style="background:${color}"></div>
      <div class="pill-coord">${last.lat.toFixed(5)}°, ${last.lon.toFixed(5)}°</div>
      <div class="pill-stats">
        <span>${summary.drift_distance_nm} nm</span>
        <span>${summary.drift_bearing_deg}°</span>
      </div>
      <div class="pill-uncertain-role">${role}</div>
    </div>
  `;
  const pill = document.createElement('div');
  pill.className = 'result-pill result-pill--uncertain';
  pill.innerHTML = `
    <div class="pill-uncertain-header">
      <span class="pill-uncertain-tag">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
        Time uncertain
      </span>
    </div>
    <div class="pill-uncertain-rows">
      ${row(pair.earliest.color, eLast, eS, 'earliest')}
      ${row(pair.latest.color,   lLast, lS, 'latest')}
    </div>
    <div class="pill-actions">
      <button class="pill-btn pattern" aria-label="Search pattern">Pattern</button>
      <a class="pill-btn" href="${pair.gpxUrl}" download="drift-${pair.id}-uncertain.gpx">GPX</a>
      <a class="pill-btn" href="${pair.kmlUrl}" download="drift-${pair.id}-uncertain.kml">KML</a>
      <button class="pill-btn remove" aria-label="Remove">×</button>
    </div>
  `;

  pill.addEventListener('click', (e) => {
    if (e.target.closest('.pill-btn')) return;
    fitToRun(pair);
  });

  pill.querySelector('.remove').addEventListener('click', (e) => {
    e.stopPropagation();
    removeRun(pair.id);
  });

  pill.querySelector('.pattern').addEventListener('click', (e) => {
    e.stopPropagation();
    openPatternCard(pair.earliest);
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

let activePatternRun = null;  // which run the dialog is generating for

function openPatternCard(run) {
  activePatternRun = run;
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
  activePatternRun = null;
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

    if (activePatternRun) drawPatternForRun(activePatternRun, data.lines);

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

const normalStartWrapper = document.getElementById('normalStartWrapper');
const uncertainTimesDiv = document.getElementById('uncertainTimes');
const chkTimeUncertain = document.getElementById('chkTimeUncertain');
const inpEarliestLKP = document.getElementById('inpEarliestLKP');
const inpLatestLKP = document.getElementById('inpLatestLKP');

function setDefaultUncertainTimes() {
  const start = inpStart.value;
  if (start) {
    const startDate = new Date(start);
    if (!isNaN(startDate)) {
      const earliest = new Date(startDate.getTime() - 2 * 60 * 60 * 1000); // 2 hours earlier
      inpEarliestLKP.value = toLocalDatetime(earliest);
      inpLatestLKP.value = toLocalDatetime(startDate);
    }
  }
}

chkTimeUncertain.addEventListener('change', () => {
  const isUncertain = chkTimeUncertain.checked;
  normalStartWrapper.style.display = isUncertain ? 'none' : 'block';
  uncertainTimesDiv.classList.toggle('hidden', !isUncertain);
  if (isUncertain) setDefaultUncertainTimes();
});

inpStart.addEventListener('change', setDefaultUncertainTimes);

setDefaultUncertainTimes();
