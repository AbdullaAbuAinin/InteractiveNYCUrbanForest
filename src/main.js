import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// --- Web Mercator helpers (EPSG:3857, same projection as OSM tiles) ---------
const R = 6378137;
const WORLD = 2 * Math.PI * R;
const HALF = WORLD / 2;
const merc = (lon, lat) => [
  (R * lon * Math.PI) / 180,
  R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
];
// Scene origin near the NYC centre, so coordinates stay small (float precision)
const [OX, OY] = merc(-73.94, 40.7128);
// Mercator (x east, y north) <-> scene (x east, y up, z south)
const toScene = (mx, my) => [mx - OX, -(my - OY)];
const toMerc = (sx, sz) => [sx + OX, -sz + OY];

// --- Renderer / scene / camera ----------------------------------------------
const el = document.getElementById("map");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(el.clientWidth, el.clientHeight);
el.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xaad3df); // OSM water blue

const camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 5, 500000);
camera.position.set(0, 45000, 35000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.screenSpacePanning = false;            // pan across the ground, not up/down
controls.maxPolarAngle = Math.PI / 2 - 0.05;    // never go below the map
controls.minDistance = 100;
controls.maxDistance = 150000;

// --- Tiles ------------------------------------------------------------------
const TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const TILE_PX = 256;
const BASE_Z = 12;     // always-loaded low-res layer, so there are never holes
const MAX_Z = 19;      // OSM's deepest level
const MAX_TILES = 80;  // per detail update; keeps tilted views from requesting hundreds
const BBOX = { west: -74.30, east: -73.65, south: 40.45, north: 40.95 }; // NYC + margin

const tileSize = (z) => WORLD / 2 ** z;
const mercToTile = (mx, my, z) => [
  Math.floor((mx + HALF) / tileSize(z)),
  Math.floor((HALF - my) / tileSize(z)),
];

const loader = new THREE.TextureLoader();
loader.setCrossOrigin("anonymous");
const planeCache = new Map(); // one shared PlaneGeometry per zoom level
const plane = (z) => {
  if (!planeCache.has(z)) planeCache.set(z, new THREE.PlaneGeometry(tileSize(z), tileSize(z)));
  return planeCache.get(z);
};

// Tiles are all flat at y=0, so draw order (not depth) decides what's on top:
// base layer first, detail layer over it.
function makeTile(z, x, y, renderOrder, parent, onReady) {
  const size = tileSize(z);
  const cx = x * size - HALF + size / 2;
  const cy = HALF - y * size - size / 2;
  const [sx, sz] = toScene(cx, cy);

  const mat = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(plane(z), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(sx, 0, sz);
  mesh.renderOrder = renderOrder;

  // Only add to the scene once the image arrives, so no white squares while loading
  loader.load(TILE_URL(z, x, y), (tex) => {
    if (mesh.userData.disposed) { tex.dispose(); return; }
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    mat.map = tex;
    mat.needsUpdate = true;
    parent.add(mesh);
    onReady?.();
  });
  return mesh;
}

function disposeTile(mesh) {
  mesh.userData.disposed = true;
  mesh.parent?.remove(mesh);
  mesh.material.map?.dispose();
  mesh.material.dispose();
}

// Base layer: whole NYC at z12, loaded once
const baseLayer = new THREE.Group();
scene.add(baseLayer);
{
  const [x0, y0] = mercToTile(...merc(BBOX.west, BBOX.north), BASE_Z);
  const [x1, y1] = mercToTile(...merc(BBOX.east, BBOX.south), BASE_Z);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) makeTile(BASE_Z, x, y, 0, baseLayer);
}

// Detail layer: recomputed whenever the camera moves
const detailLayer = new THREE.Group();
scene.add(detailLayer);
const detailTiles = new Map(); // "z/x/y" -> mesh

const raycaster = new THREE.Raycaster();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();

// Ground point under a screen position (NDC). Rays above the horizon are
// clamped to a horizontal distance so tilted views stay bounded.
function groundPoint(ndcX, ndcY, maxReach) {
  raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
  const target = controls.target;
  if (raycaster.ray.intersectPlane(ground, hit) && hit.distanceTo(target) < maxReach) return hit.clone();
  const d = raycaster.ray.direction;
  const flat = new THREE.Vector3(d.x, 0, d.z).normalize().multiplyScalar(maxReach);
  return target.clone().add(flat);
}

// Zoom level whose pixels match the screen's pixels at the orbit target
function idealZoom() {
  const dist = camera.position.distanceTo(controls.target);
  const metersPerScreenPx =
    (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) /
    (el.clientHeight * renderer.getPixelRatio());
  return Math.round(Math.log2(WORLD / (TILE_PX * metersPerScreenPx)));
}

function updateDetail() {
  let z = Math.min(MAX_Z, idealZoom());
  if (z <= BASE_Z) { // base layer is already sharp enough
    for (const m of detailTiles.values()) disposeTile(m);
    detailTiles.clear();
    return;
  }

  // Visible ground footprint: screen corners projected onto the map
  const reach = camera.position.distanceTo(controls.target) * 3;
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].map(([x, y]) => groundPoint(x, y, reach));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    const [mx, my] = toMerc(p.x, p.z);
    minX = Math.min(minX, mx); maxX = Math.max(maxX, mx);
    minY = Math.min(minY, my); maxY = Math.max(maxY, my);
  }
  // Stay inside NYC (keeps OSM tile requests modest)
  const [bw, bs] = merc(BBOX.west, BBOX.south);
  const [be, bn] = merc(BBOX.east, BBOX.north);
  minX = Math.max(minX, bw); maxX = Math.min(maxX, be);
  minY = Math.max(minY, bs); maxY = Math.min(maxY, bn);
  if (minX >= maxX || minY >= maxY) return;

  // Drop a level until the footprint fits the tile budget
  let x0, y0, x1, y1;
  for (; z > BASE_Z; z--) {
    [x0, y0] = mercToTile(minX, maxY, z);
    [x1, y1] = mercToTile(maxX, minY, z);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES) break;
  }

  const wanted = new Set();
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) wanted.add(`${z}/${x}/${y}`);

  for (const key of wanted) {
    if (detailTiles.has(key)) continue;
    const [tz, tx, ty] = key.split("/").map(Number);
    detailTiles.set(key, makeTile(tz, tx, ty, 1, detailLayer));
  }
  for (const [key, mesh] of detailTiles) {
    if (!wanted.has(key)) { disposeTile(mesh); detailTiles.delete(key); }
  }
}

// Debounce: wait until the camera settles before requesting tiles
let pending = 0;
controls.addEventListener("change", () => {
  clearTimeout(pending);
  pending = setTimeout(updateDetail, 150);
});

// --- Loop / resize ----------------------------------------------------------
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

window.addEventListener("resize", () => {
  camera.aspect = el.clientWidth / el.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(el.clientWidth, el.clientHeight);
  updateDetail();
});

// Later: put tree points on the map with
//   const [x, z] = toScene(...merc(lon, lat)); point.position.set(x, 1, z);
//   (give them renderOrder >= 2 so they draw over the tiles)
